//! Asking a panel seat by seat, and the batch of votes it keeps open.
use super::*;

/// How a panel's pass over its judges ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in super::super) enum PanelEnd {
    /// Every judge was asked.
    Asked,
    /// The run stopped before the next judge.
    Stopped,
    /// An answer left the batch unable to reach its panel size.
    Incomplete,
    /// A judge's account turned busy; the batch waits for it.
    Busy,
}

/// One judge's answer to its batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in super::super) enum JudgeAnswer {
    /// A valid vote.
    Vote,
    /// An abstention; the batch lost this seat.
    NoVote,
    /// The judge's account is busy; nothing was recorded or paid.
    Busy,
}

/// One batch's judges as the panel loop sees them.
pub(in super::super) trait PanelJudges: Send {
    fn halted(&mut self) -> BoxFuture<'_, Result<bool>>;
    /// Asks the judge at `index` of the panel.
    fn ask<'s>(
        &'s mut self,
        index: usize,
        judge: &'s Configuration,
    ) -> BoxFuture<'s, Result<JudgeAnswer>>;
}

/// Asks `judges` (panel index, judge) in order. It stops before a judge when
/// the run halts or a judge's account turns busy, and as soon as the batch
/// can no longer reach `expected` valid votes, so no call is paid that could
/// never count.
pub(in super::super) async fn ask_panel(
    judges: &[(usize, Configuration)],
    expected: usize,
    mut votes: usize,
    panel: &mut impl PanelJudges,
) -> Result<(PanelEnd, usize)> {
    for (position, (index, judge)) in judges.iter().enumerate() {
        if votes + (judges.len() - position) < expected {
            return Ok((PanelEnd::Incomplete, votes));
        }
        if panel.halted().await? {
            return Ok((PanelEnd::Stopped, votes));
        }
        match panel.ask(*index, judge).await? {
            JudgeAnswer::Vote => votes += 1,
            JudgeAnswer::NoVote => {}
            JudgeAnswer::Busy => return Ok((PanelEnd::Busy, votes)),
        }
    }
    let end = if votes >= expected {
        PanelEnd::Asked
    } else {
        PanelEnd::Incomplete
    };
    Ok((end, votes))
}

/// The attempt's reason after a panel pass: none once the batch settled, else
/// why it stopped short. A stop or a busy judge defers to the run, which
/// finishes the batch with the judges it has not asked yet.
pub(in super::super) fn panel_reason(
    end: PanelEnd,
    votes: usize,
    expected: usize,
    cancelled: bool,
) -> Option<&'static str> {
    if votes >= expected {
        return None;
    }
    Some(if end == PanelEnd::Stopped || cancelled {
        JUDGING_STOPPED
    } else if end == PanelEnd::Busy {
        JUDGES_BUSY
    } else {
        PANEL_INCOMPLETE
    })
}

/// Keep the actionable refusal on the run card, rather than replacing it
/// with a generic incomplete-panel message. Only this batch's failed seats
/// supply the cause; successful rubric notes are never an operational error.
pub(in super::super) fn incomplete_panel_reason(attempt: &Attempt, batch: &str) -> String {
    attempt
        .evaluations
        .iter()
        .rev()
        .find(|evaluation| {
            evaluation.provenance == "judge_failure"
                && evaluation.score.is_none()
                && evaluation
                    .details
                    .as_ref()
                    .is_some_and(|d| d["judgeBatchId"] == batch)
        })
        .map_or_else(
            || PANEL_INCOMPLETE.into(),
            |evaluation| format!("Judging failed: {}", evaluation.reason),
        )
}

/// A session that could not select the requested settings has sent no
/// scoring prompt. Retry that exact seat at most twice, preserving each
/// setup receipt so its owner id is never reused. Paid or uncertain turns,
/// invalid score sheets and frozen-runtime refusals do not qualify.
pub(in super::super) fn retry_unpaid_judge_selection(
    attempt: &Attempt,
    evaluation: &Evaluation,
) -> bool {
    fn unpaid(evaluation: &Evaluation) -> bool {
        evaluation.provenance == "judge_failure"
            && evaluation.score.is_none()
            && evaluation.judge.is_some()
            && evaluation.details.as_ref().is_some_and(|details| {
                details["selectionNotAcknowledged"] == true
                    && details["dispatched"] == false
                    && details["usageComplete"] == true
                    && details["inFlight"] == false
                    && details["sessionId"].as_str().is_some()
                    && details["judgeBatchId"].as_str().is_some()
                    && details.get("requestKey").is_none_or(Value::is_null)
            })
    }
    unpaid(evaluation)
        && attempt
            .evaluations
            .iter()
            .filter(|previous| {
                unpaid(previous)
                    && previous.judge == evaluation.judge
                    && previous.details.as_ref().unwrap()["judgeBatchId"]
                        == evaluation.details.as_ref().unwrap()["judgeBatchId"]
            })
            .count()
            < 2
}

/// An incomplete batch keeps its valid votes on explicit resume. Prefer the
/// batch with most valid seats, newest on a tie, without mixing batches.
#[derive(Debug)]
pub(in super::super) struct OpenBatch {
    pub(in super::super) id: String,
    pub(in super::super) panel: Vec<Configuration>,
    pub(in super::super) asked: Vec<Configuration>,
    pub(in super::super) expected: usize,
    pub(in super::super) rendering: String,
    pub(in super::super) rendering_hash: String,
}

pub(in super::super) fn open_batch_matching(
    evaluations: &[Evaluation],
    accepts: impl Fn(&Evaluation) -> bool,
) -> Option<OpenBatch> {
    let mut best = None;
    for (start, marker) in evaluations
        .iter()
        .enumerate()
        .filter(|(_, e)| e.provenance == "render")
    {
        if !accepts(marker) {
            continue;
        }
        let end = evaluations[start + 1..]
            .iter()
            .position(|e| e.provenance == "render")
            .map_or(evaluations.len(), |next| start + 1 + next);
        let Some(open) = incomplete_batch(marker, &evaluations[start + 1..end]) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|previous: &OpenBatch| open.asked.len() >= previous.asked.len())
        {
            best = Some(open);
        }
    }
    best
}

#[cfg(test)]
pub(in super::super) fn open_batch(evaluations: &[Evaluation]) -> Option<OpenBatch> {
    open_batch_matching(evaluations, |_| true)
}

/// A saved vote can only finish a panel using the same scoring instructions.
/// A changed protocol starts a separate batch on the retained answer; it must
/// never attach new instructions to the old protocol hash or reuse old votes.
#[cfg(test)]
pub(in super::super) fn compatible_open_batch(
    evaluations: &[Evaluation],
    prompt: &str,
    renderer: &str,
) -> Option<OpenBatch> {
    recoverable_open_batch(evaluations, prompt, renderer, &[])
}

pub(in super::super) fn recoverable_open_batch(
    evaluations: &[Evaluation],
    prompt: &str,
    renderer: &str,
    rejected: &[judge_recovery::Rejection],
) -> Option<OpenBatch> {
    open_batch_matching(evaluations, |marker| {
        judge_recovery::accepts_marker(marker, rejected)
            && marker.details.as_ref().is_some_and(|details| {
                details.pointer("/protocol/prompt").and_then(Value::as_str) == Some(prompt)
                    && details
                        .pointer("/protocol/renderer")
                        .and_then(Value::as_str)
                        == Some(renderer)
            })
    })
}

fn incomplete_batch(marker: &Evaluation, evaluations: &[Evaluation]) -> Option<OpenBatch> {
    let details = marker.details.as_ref()?;
    let panel: Vec<Configuration> =
        serde_json::from_value(details.pointer("/protocol/panel")?.clone()).ok()?;
    let expected = usize::try_from(details["expectedJudges"].as_u64()?).ok()?;
    let batch = details["judgeBatchId"].as_str()?;
    let answers = judge_corrections::effective_answers(evaluations);
    // Each seat answers `samplesPerJudge` times (see `judge_samples`).
    let samples = details
        .pointer("/protocol/samplesPerJudge")
        .and_then(Value::as_u64)
        .unwrap_or(1) as usize;
    if panel.is_empty()
        || panel.len() * samples != expected
        || answers.iter().any(|answer| {
            answer
                .details
                .as_ref()
                .is_some_and(|d| d["inFlight"] == true)
        })
    {
        return None;
    }
    let mut asked = Vec::new();
    for answer in answers.into_iter().filter(|answer| valid_vote(answer)) {
        let judge = answer.judge.as_ref()?;
        if !panel.contains(judge)
            || answer.evaluator_revision != marker.evaluator_revision
            || answer
                .details
                .as_ref()
                .is_none_or(|d| d["judgeBatchId"] != batch || d["usageComplete"] != true)
            || asked.iter().filter(|seen| *seen == judge).count() >= samples
        {
            return None;
        }
        asked.push(judge.clone());
    }
    if asked.len() >= expected {
        return None;
    }
    Some(OpenBatch {
        id: batch.to_owned(),
        asked,
        panel,
        expected,
        rendering: marker.artifacts.first()?.path.clone(),
        rendering_hash: marker.artifacts.first()?.hash.clone(),
    })
}

/// A resumed older batch records new evidence before the following marker,
/// preserving both its attribution and every original evaluation.
pub(in super::super) fn insert_judge_evaluation(
    attempt: &mut Attempt,
    batch: &str,
    evaluation: Evaluation,
) -> usize {
    let position = attempt
        .evaluations
        .iter()
        .position(|e| {
            e.provenance == "render"
                && e.details
                    .as_ref()
                    .is_some_and(|d| d["judgeBatchId"] == batch)
        })
        .and_then(|start| {
            attempt.evaluations[start + 1..]
                .iter()
                .position(|e| e.provenance == "render")
                .map(|next| start + 1 + next)
        })
        .unwrap_or(attempt.evaluations.len());
    attempt.evaluations.insert(position, evaluation);
    position
}

/// A rejected paid turn gets a new idempotency key on explicit resume.
/// An unpaid admission refusal leaves the key unchanged.
pub(in super::super) fn judge_call_index(
    attempt: &Attempt,
    batch: &str,
    index: usize,
    judge: &Configuration,
) -> usize {
    let expected = attempt
        .evaluations
        .iter()
        .find(|e| {
            e.provenance == "render"
                && e.details
                    .as_ref()
                    .is_some_and(|d| d["judgeBatchId"] == batch)
        })
        .and_then(|e| e.details.as_ref()?.get("expectedJudges")?.as_u64())
        .unwrap_or(1) as usize;
    let rejected = attempt
        .evaluations
        .iter()
        .filter(|e| {
            e.provenance == "judge_failure"
                && e.judge.as_ref() == Some(judge)
                && e.details
                    .as_ref()
                    .is_some_and(|d| d["judgeBatchId"] == batch)
        })
        .count();
    index + rejected * expected
}

/// The asks a batch owes: each seat of `panel` `samples` times, at index
/// seat × samples + sample, less those `asked` already answered.
pub(in super::super) fn seat_samples(
    panel: &[Configuration],
    samples: usize,
    asked: &[Configuration],
) -> Vec<(usize, Configuration)> {
    panel
        .iter()
        .enumerate()
        .flat_map(|(seat, judge)| {
            let answered = asked.iter().filter(|seen| *seen == judge).count();
            (answered.min(samples)..samples)
                .map(move |sample| (seat * samples + sample, judge.clone()))
        })
        .collect()
}

pub(in super::super) async fn saved_rendering(
    open: &OpenBatch,
    textual: bool,
    max_text_bytes: u64,
) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    // Recorded by absolute path; the hash below proves a relocated copy.
    let path = crate::services::flock_root::relocated(std::path::Path::new(&open.rendering));
    let mut file = tokio::fs::File::open(&path).await?;
    let metadata = file.metadata().await?;
    let cap = if textual {
        max_text_bytes
    } else {
        2 * 1024 * 1024
    };
    if !metadata.is_file() || metadata.len() > cap {
        return Err(BenchmarkError::new(
            "evidence_mismatch",
            "Saved judge evidence exceeds its artifact limit",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > cap
        || fixtures::hash(&bytes) != open.rendering_hash
        || (!textual && !bytes.starts_with(b"\x89PNG\r\n\x1a\n"))
    {
        return Err(BenchmarkError::new(
            "evidence_mismatch",
            "Saved judge evidence differs from its sealed artifact",
        ));
    }
    Ok(bytes)
}

/// The native panel: each judge's evaluation is saved on the attempt as it lands.
pub(in super::super) enum JudgeEvidence<'a> {
    Attempt,
    /// Artifact judging in a normal run; calibration pins do not select seats.
    OrdinaryAttempt,
    Qualification {
        record: &'a mut crate::services::benchmarks::qualification::Record,
        index: usize,
    },
    /// A judge pool calibration: one named judge, evidence kept in memory
    /// and on disk under `directory`, never in an attempt or a record.
    Calibration {
        judge: Box<Configuration>,
        directory: std::path::PathBuf,
    },
}

impl JudgeEvidence<'_> {
    pub(in super::super) fn directory(
        &self,
        store: &Store,
        attempt: &Attempt,
    ) -> std::path::PathBuf {
        match self {
            Self::Attempt | Self::OrdinaryAttempt => store
                .root
                .join("runs")
                .join(&attempt.run_id)
                .join(&attempt.id),
            Self::Qualification { record, index } => store
                .root
                .join("qualifications")
                .join(&record.id)
                .join(format!("control-{index}")),
            Self::Calibration { directory, .. } => directory.clone(),
        }
    }
    pub(in super::super) async fn save(&mut self, store: &Store, attempt: &Attempt) -> Result<()> {
        match self {
            Self::Attempt | Self::OrdinaryAttempt => store.save_attempt(attempt).await,
            Self::Qualification { record, index } => {
                record.controls[*index].judge_evaluations = attempt.evaluations.clone();
                store.save_qualification_progress(record).await
            }
            Self::Calibration { .. } => Ok(()),
        }
    }
}

pub(in super::super) struct NativePanel<'a, 'r> {
    pub(in super::super) backend: &'a NativeBackend,
    pub(in super::super) store: &'a Store,
    pub(in super::super) attempt: &'a mut Attempt,
    pub(in super::super) version: &'a BenchmarkVersion,
    pub(in super::super) batch: &'a str,
    pub(in super::super) prompt: &'a str,
    pub(in super::super) image: Option<&'a OwnedTurnImage>,
    pub(in super::super) response: Option<&'a str>,
    pub(in super::super) criteria: &'a [RubricCriterion],
    pub(in super::super) stop: &'a JudgeStop,
    pub(in super::super) evidence: &'a mut JudgeEvidence<'r>,
}

impl PanelJudges for NativePanel<'_, '_> {
    fn halted(&mut self) -> BoxFuture<'_, Result<bool>> {
        Box::pin(self.stop.halted(self.store))
    }
    fn ask<'s>(
        &'s mut self,
        index: usize,
        judge: &'s Configuration,
    ) -> BoxFuture<'s, Result<JudgeAnswer>> {
        Box::pin(async move {
            if self.stop.halted(self.store).await? {
                return Ok(JudgeAnswer::Busy);
            }
            let scope = self.store.root.display().to_string();
            let job = format!("judge:{}", self.attempt.id);
            let _preparing = prepare_judge(&scope, &job)?;
            let result = self
                .backend
                .ask_judge(
                    self.store,
                    self.attempt,
                    self.version,
                    judge,
                    self.batch,
                    index,
                    self.prompt,
                    self.image,
                    self.response,
                    self.criteria,
                    self.stop,
                    self.evidence,
                )
                .await;
            admission_window::finished(&scope, &job);
            let evaluation = match result {
                Ok(evaluation) => evaluation,
                // A local refusal parks the shared queue immediately. The
                // batch retains its votes and only its unpaid seats resume.
                Err(error) if error.code == "resource_busy" => {
                    admission_window::refused(&scope, &job);
                    return Err(error);
                }
                Err(error)
                    if error
                        .details
                        .as_ref()
                        .is_some_and(|details| details["diagnosticPersistenceFailed"] == true) =>
                {
                    return Err(error)
                }
                // This seat has not created a paid placeholder or dispatched
                // a turn. Keep the batch's existing votes for its reset.
                Err(error) if error.code == JUDGE_QUOTA_WAIT => return Err(error),
                Err(error) if matches!(error.code.as_str(), ACCOUNT_BUSY | SIGN_IN_WAIT) => {
                    return Ok(JudgeAnswer::Busy);
                }
                Err(error) => judge_abstention(self.version, judge, self.batch, error.message),
            };
            let vote = if valid_vote(&evaluation) {
                JudgeAnswer::Vote
            } else {
                JudgeAnswer::NoVote
            };
            match self
                .attempt
                .evaluations
                .iter_mut()
                .find(|e| e.id == evaluation.id)
            {
                Some(slot) => *slot = evaluation,
                None => {
                    insert_judge_evaluation(self.attempt, self.batch, evaluation);
                }
            }
            self.evidence.save(self.store, self.attempt).await?;
            Ok(vote)
        })
    }
}
