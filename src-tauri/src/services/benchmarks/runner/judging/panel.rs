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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn manifest_failure_never_admits_work() {
        let (dir, s, backend) = setup().await;
        let req = request(&s).await;
        tokio::fs::write(dir.path().join("runs"), "blocked directory")
            .await
            .unwrap();
        assert!(s.start_run(req).await.is_err());
        assert!(s.store.all_runs().await.unwrap().is_empty());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        dir.close().await;
    }

    #[tokio::test]
    async fn a_panel_stops_paying_once_its_batch_cannot_settle() {
        use JudgeAnswer::{Busy, NoVote, Vote};
        let judges: Vec<(usize, Configuration)> = ["opus[1m]", "haiku", "claude-opus-4-8"]
            .into_iter()
            .map(judge_row)
            .enumerate()
            .collect();
        let run = |answers: Vec<JudgeAnswer>, halt_after: Option<usize>, votes: usize| {
            let judges = judges.clone();
            async move {
                let mut panel = ScriptedPanel {
                    answers,
                    asked: Vec::new(),
                    halt_after,
                };
                // Every judge asked before a stop cast a valid vote.
                let end = ask_panel(&judges[votes..], 3, votes, &mut panel)
                    .await
                    .unwrap();
                (end, panel.asked)
            }
        };
        // The first abstention ends the batch: nobody else is asked.
        assert_eq!(
            run(vec![NoVote, Vote, Vote], None, 0).await,
            ((PanelEnd::Incomplete, 0), vec![0])
        );
        assert_eq!(
            run(vec![Vote, NoVote, Vote], None, 0).await,
            ((PanelEnd::Incomplete, 1), vec![0, 1])
        );
        assert_eq!(
            run(vec![Vote, Vote, Vote], None, 0).await,
            ((PanelEnd::Asked, 3), vec![0, 1, 2])
        );
        // A stop leaves the rest for the run; a resumed batch asks only them.
        assert_eq!(
            run(vec![Vote, Vote, Vote], Some(1), 0).await,
            ((PanelEnd::Stopped, 1), vec![0])
        );
        assert_eq!(
            run(vec![Vote, Vote, Vote], None, 1).await,
            ((PanelEnd::Asked, 3), vec![1, 2])
        );
        // A judge whose account turned busy ends the pass without an answer.
        assert_eq!(
            run(vec![Vote, Busy, Vote], None, 0).await,
            ((PanelEnd::Busy, 1), vec![0, 1])
        );
    }

    #[test]
    fn resumed_judging_uses_the_best_batch_and_a_new_key_without_repaying_valid_seats() {
        let panel: Vec<_> = ["opus[1m]", "haiku", "claude-opus-4-8"]
            .into_iter()
            .map(judge_row)
            .collect();
        let marker = |id: &str| {
            json!({"id":id,"evaluatorRevision":"1","verdict":"rendered",
            "score":null,"reason":"","createdAt":1,"provenance":"render",
            "artifacts":[{"kind":"text","path":"invented.txt","hash":"invented","label":"Response"}],
            "details":{"judgeBatchId":id,"expectedJudges":3,"protocol":{"panel":panel}}})
        };
        let answer = |id: &str, batch: &str, seat: usize, valid: bool| {
            json!({"id":id,"evaluatorRevision":"1",
            "verdict":if valid {"judged"} else {"abstained"},"score":if valid {Some(0.8)} else {None},
            "reason":"","createdAt":2,"provenance":if valid {"judge"} else {"judge_failure"},
            "artifacts":[],"judge":panel[seat],"details":{"judgeBatchId":batch,"usageComplete":true}})
        };
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":panel[0],"repetition":0,"phase":"terminal","outcome":"pending_review",
            "usage":TokenUsage::default(),"eventCursor":0,"evaluations":[marker("older"),
                answer("good-0","older",0,true),answer("good-1","older",1,true),answer("bad-2","older",2,false),
                marker("newer"),answer("bad-0","newer",0,false)]})).unwrap();
        let before = attempt.evaluations.clone();
        let open = open_batch(&attempt.evaluations).unwrap();
        assert_eq!(open.id, "older");
        assert_eq!(
            seat_samples(&open.panel, 1, &open.asked),
            vec![(2, panel[2].clone())]
        );
        assert_eq!(judge_call_index(&attempt, "older", 2, &panel[2]), 5);
        insert_judge_evaluation(
            &mut attempt,
            "older",
            serde_json::from_value(answer("retry", "older", 2, true)).unwrap(),
        );
        assert_eq!(attempt.evaluations[4].id, "retry");
        assert_eq!(attempt.evaluations[5].id, "newer");
        assert_eq!(
            crate::services::benchmarks::analysis::score(&attempt),
            Some(0.8)
        );
        attempt.evaluations.retain(|e| e.id != "retry");
        assert_eq!(
            serde_json::to_value(&attempt.evaluations).unwrap(),
            serde_json::to_value(before).unwrap()
        );
        attempt.evaluations[1].details.as_mut().unwrap()["inFlight"] = json!(true);
        assert_ne!(open_batch(&attempt.evaluations).unwrap().id, "older");
    }

    #[test]
    fn resume_never_mixes_votes_from_different_scoring_protocols() {
        let panel = vec![judge_row("sonnet"), judge_row("haiku")];
        let marker = |id: &str, prompt: &str| -> Evaluation {
            serde_json::from_value(json!({"id":id,"evaluatorRevision":"1","verdict":"rendered",
                "reason":"","createdAt":1,"provenance":"render",
                "artifacts":[{"kind":"text","path":"invented.txt","hash":"sealed","label":"Response"}],
                "details":{"judgeBatchId":id,"expectedJudges":2,
                    "protocol":{"panel":panel,"prompt":prompt,"renderer":"text"}}}))
            .unwrap()
        };
        let vote: Evaluation = serde_json::from_value(json!({"id":"vote","evaluatorRevision":"1",
            "verdict":"judged","score":0.8,"reason":"","createdAt":2,"provenance":"judge",
            "judge":panel[0],"details":{"judgeBatchId":"old","usageComplete":true}}))
        .unwrap();
        let mut evaluations = vec![marker("old", "old rules"), vote];
        let before = serde_json::to_value(&evaluations).unwrap();
        assert!(compatible_open_batch(&evaluations, "current rules", "text").is_none());
        assert_eq!(serde_json::to_value(&evaluations).unwrap(), before);
        evaluations.push(marker("current", "current rules"));
        // The old batch has more votes but those votes used different rules.
        let open = compatible_open_batch(&evaluations, "current rules", "text").unwrap();
        assert_eq!(open.id, "current");
        assert!(open.asked.is_empty());
        assert_eq!(seat_samples(&open.panel, 1, &open.asked).len(), 2);
        assert!(compatible_open_batch(&evaluations, "current rules", "other renderer").is_none());
        let old = compatible_open_batch(&evaluations, "old rules", "text").unwrap();
        assert_eq!(old.asked, vec![panel[0].clone()]);
    }

    #[tokio::test]
    async fn saved_judge_evidence_refuses_changed_or_oversized_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rendering.txt");
        let bytes = b"invented evidence";
        tokio::fs::write(&path, bytes).await.unwrap();
        let open = OpenBatch {
            id: "invented-batch".into(),
            panel: Vec::new(),
            asked: Vec::new(),
            expected: 0,
            rendering: path.to_string_lossy().into_owned(),
            rendering_hash: fixtures::hash(bytes),
        };
        assert_eq!(saved_rendering(&open, true, 64).await.unwrap(), bytes);
        assert!(saved_rendering(&open, true, 4).await.is_err());
        tokio::fs::write(&path, b"changed evidence").await.unwrap();
        assert!(saved_rendering(&open, true, 64).await.is_err());
        assert!(saved_rendering(&open, false, 64).await.is_err());
    }
}
