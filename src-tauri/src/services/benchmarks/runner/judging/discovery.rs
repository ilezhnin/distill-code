//! Finding a panel for a rendering: offers, why a seat could not be filled, and
//! the panel a run settles on.
use super::*;

/// A full preparation window is not a refusal from the sandbox. It must
/// never start the shared resource cooldown or discard its admission history.
pub(in super::super) fn prepare_judge(
    scope: &str,
    job: &str,
) -> Result<admission_window::Preparing> {
    admission_window::begin(scope, job).ok_or_else(|| {
        BenchmarkError::new(
            JUDGE_ADMISSION_WAIT,
            "The resource queue is waiting for admission",
        )
    })
}

/// The current judging failure, including a manual pass outside a running
/// plan. Saving it must not leave an older pause/cancel reason on the answer.
pub(in crate::services::benchmarks) fn judge_error_reason(error: &BenchmarkError) -> String {
    let storage_failed = error
        .details
        .as_ref()
        .is_some_and(|details| details["diagnosticPersistenceFailed"] == true);
    if error.code == JUDGE_QUOTA_WAIT {
        if storage_failed {
            format!("{JUDGE_QUOTA_REASON}: {}", error.message)
        } else {
            JUDGE_QUOTA_REASON.into()
        }
    } else if error.code == ACCOUNT_BUSY {
        if storage_failed {
            format!("{JUDGES_BUSY}: {}", error.message)
        } else {
            JUDGES_BUSY.into()
        }
    } else if unstarted_refusal(error) || error.code == JUDGE_ADMISSION_WAIT {
        format!("{JUDGE_DISCOVERY_WAIT}: {}", error.message)
    } else {
        format!("Judging failed: {}", error.message)
    }
}

/// A partial listing is not evidence of too few eligible judges.
pub(in super::super) struct JudgeOffers {
    pub(in super::super) rows: Vec<(
        Option<crate::services::provider_account_status::Headroom>,
        InventoryModel,
    )>,
    /// Offered models on accounts whose subscription quota is temporarily
    /// spent. Eligibility is still checked against the calibrated pool.
    pub(in super::super) quota: Vec<(i64, InventoryModel)>,
    pub(in super::super) deferred: Option<BenchmarkError>,
    pub(in super::super) diagnostics: Vec<JudgeDiscoveryIssue>,
}

/// Whether `error` is the sandbox's own refusal of a model whose offline
/// policy check is absent or stale, which the app can renew by itself.
pub(in crate::services::benchmarks) fn stale_policy_check(error: &BenchmarkError) -> bool {
    JudgeDiscoveryCause::from_error(error) == Some(JudgeDiscoveryCause::TextPolicyProofRequired)
}

/// Discovery diagnostics carry no provider output into a saved attempt. The
/// order chooses the most actionable local cause when several accounts fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(in super::super) enum JudgeDiscoveryCause {
    TextPolicyProofRequired,
    CapabilityUnavailable,
    InventoryUnavailable,
}

impl JudgeDiscoveryCause {
    pub(in super::super) fn from_error(error: &BenchmarkError) -> Option<Self> {
        if unstarted_refusal(error) {
            return None;
        }
        if error.code != "capability_missing" {
            return Some(Self::InventoryUnavailable);
        }
        // The local helper's fixed refusal may arrive inside the host's own
        // capability wrapper. Never recognize a phrase inside arbitrary output.
        const PROOF: &str = "Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe";
        let mut message = error.message.trim();
        for _ in 0..2 {
            if let Some(inner) = message.strip_prefix("capability_missing:") {
                message = inner.trim();
            }
        }
        Some(if message == PROOF {
            Self::TextPolicyProofRequired
        } else {
            Self::CapabilityUnavailable
        })
    }

    pub(in super::super) fn label(self) -> &'static str {
        match self {
            Self::TextPolicyProofRequired => "local text policy verification required",
            Self::CapabilityUnavailable => "benchmark runtime unavailable",
            Self::InventoryUnavailable => "model inventory unavailable",
        }
    }
}

pub(in super::super) struct JudgeDiscoveryIssue {
    pub(in super::super) provider: NativeProvider,
    // Used only to filter the pool's allowed accounts; never serialized.
    pub(in super::super) account: Option<String>,
    pub(in super::super) model: Option<String>,
    pub(in super::super) cause: JudgeDiscoveryCause,
}

impl JudgeDiscoveryIssue {
    pub(in super::super) fn from_error(
        provider: &str,
        account: Option<&str>,
        error: &BenchmarkError,
    ) -> Option<Self> {
        Some(Self {
            provider: NativeProvider::for_harness(provider)?,
            account: account.map(str::to_owned),
            model: None,
            cause: JudgeDiscoveryCause::from_error(error)?,
        })
    }

    pub(in super::super) fn from_model(model: &InventoryModel) -> Option<Self> {
        if model.available || model.configuration.execution_profile != "native_text" {
            return None;
        }
        let error =
            host_error(model.reason.clone().unwrap_or_else(|| {
                "capability_missing: Native text runtime is unavailable".into()
            }));
        let mut issue = Self::from_error(
            &model.configuration.provider_id,
            model.configuration.account_id.as_deref(),
            &error,
        )?;
        issue.model = Some(model.configuration.model_id.clone());
        Some(issue)
    }
}

fn judge_provider_label(provider: NativeProvider) -> &'static str {
    match provider {
        NativeProvider::Claude => "Claude",
        NativeProvider::Codex => "Codex",
        NativeProvider::Grok => "Grok",
        NativeProvider::Kimi => "Kimi",
        NativeProvider::Zai => "Z.ai",
    }
}

/// No wire contract or extra evidence: only a short panel's existing reason
/// receives these bounded, fixed diagnostics. Selection still uses the seats.
pub(in super::super) struct DiscoveredJudgePanel {
    pub(in super::super) seats: Vec<Configuration>,
    pub(in super::super) diagnostics: Vec<(NativeProvider, JudgeDiscoveryCause)>,
    /// The pool's providers whose judges sit out only for a stale sandbox
    /// check, whether or not the panel is short.
    pub(in super::super) stale: Vec<NativeProvider>,
    /// Why a saved panel cannot go on: nobody can take its missing seat now.
    pub(in super::super) unavailable: Option<BenchmarkError>,
}

impl DiscoveredJudgePanel {
    pub(in super::super) fn fixed(seats: Vec<Configuration>) -> Self {
        Self {
            seats,
            diagnostics: Vec::new(),
            stale: Vec::new(),
            unavailable: None,
        }
    }

    pub(in super::super) fn discovered(
        seats: Vec<Configuration>,
        issues: Vec<JudgeDiscoveryIssue>,
        pool: &[crate::services::benchmarks::judge_pool::Entry],
    ) -> Self {
        let diagnostics: Vec<(NativeProvider, JudgeDiscoveryCause)> = NativeProvider::ALL
            .iter()
            .filter_map(|&provider| {
                issues
                    .iter()
                    .filter(|issue| {
                        let account = issue.account.as_deref();
                        issue.provider == provider
                            && match &issue.model {
                                Some(model) => {
                                    pool_names(pool, provider.harness_id(), account, model)
                                }
                                None => pool.iter().any(|entry| {
                                    entry.provider_id == provider.harness_id()
                                        && entry.sits_on(account)
                                }),
                            }
                    })
                    .map(|issue| issue.cause)
                    .min()
                    .map(|cause| (provider, cause))
            })
            .collect();
        let stale = diagnostics
            .iter()
            .filter(|(_, cause)| *cause == JudgeDiscoveryCause::TextPolicyProofRequired)
            .map(|(provider, _)| *provider)
            .collect();
        Self {
            // Only a short panel's reason carries the diagnostics.
            diagnostics: if seats.len() >= MIN_JUDGES {
                Vec::new()
            } else {
                diagnostics
            },
            seats,
            stale,
            unavailable: None,
        }
    }

    /// Starts the renewal of every stale sandbox check without waiting for
    /// it, for a panel that has its judges. Each update of the app makes the
    /// checks stale, and only a short panel renewed them: while two other
    /// labs filled every panel, the third sat out until the operator opened
    /// one of its run dialogs, and a saved panel that lost a judge had
    /// nobody to take the seat (11-17: both Claude accounts, for hours).
    pub(in super::super) fn renew_stale_in_background(
        &self,
        renew: impl Fn(NativeProvider) -> crate::services::benchmark_policy_check::Automatic,
    ) {
        for provider in &self.stale {
            renew(*provider);
        }
    }

    /// For a short panel, renews the sandbox check of each provider that only
    /// misses a stale one, and returns the wait to record while those checks
    /// run. `None` when there is none to renew, or each such renewal failed
    /// recently: the panel's issue then asks the operator.
    pub(in super::super) fn renew_stale_proofs(
        &self,
        renew: impl Fn(NativeProvider) -> crate::services::benchmark_policy_check::Automatic,
    ) -> Option<String> {
        if self.seats.len() >= MIN_JUDGES {
            return None;
        }
        let renewing = self
            .diagnostics
            .iter()
            .filter(|(_, cause)| *cause == JudgeDiscoveryCause::TextPolicyProofRequired)
            .filter(|(provider, _)| {
                renew(*provider) == crate::services::benchmark_policy_check::Automatic::Running
            })
            .map(|(provider, _)| judge_provider_label(*provider))
            .collect::<Vec<_>>();
        (!renewing.is_empty()).then(|| format!("{JUDGE_POLICY_RENEWAL}: {}", renewing.join(", ")))
    }

    /// What a saved panel nobody can complete does: `None` when the panel
    /// has its judges, the wait to record while a stale sandbox check is
    /// renewed, or the error once there is no renewal to wait for. A judge
    /// whose check went stale can take the seat as soon as it is renewed.
    pub(in super::super) fn saved_panel_wait(
        &mut self,
        renew: impl Fn(NativeProvider) -> crate::services::benchmark_policy_check::Automatic,
    ) -> Option<Result<String>> {
        let unavailable = self.unavailable.take()?;
        Some(self.renew_stale_proofs(renew).ok_or(unavailable))
    }

    pub(in super::super) fn issue(&self, rejected: bool) -> Option<String> {
        let mut issue = panel_issue(&self.seats)?;
        if rejected {
            issue.push_str(". A judge rejected this request; recovery needs another calibrated judge from the pool");
        }
        if !self.diagnostics.is_empty() {
            let causes = self
                .diagnostics
                .iter()
                .map(|(provider, cause)| {
                    format!("{}: {}", judge_provider_label(*provider), cause.label())
                })
                .collect::<Vec<_>>();
            issue.push_str(&format!(". Judge availability: {}.", causes.join("; ")));
        }
        Some(issue)
    }
}

pub(in super::super) fn quota_seats(
    pool: &[crate::services::benchmarks::judge_pool::Entry],
    rows: Vec<(i64, InventoryModel)>,
    rejected: &[judge_recovery::Rejection],
) -> Vec<(i64, Configuration)> {
    rows.into_iter()
        .flat_map(|(until, row)| {
            crate::services::benchmarks::judge_pool::seat_rows(pool, vec![(None, row)])
                .into_iter()
                .filter(|(_, judge)| !judge_recovery::excluded(judge, rejected))
                .map(move |(_, judge)| (until, judge))
        })
        .collect()
}

/// A quota only defers a panel if the same eligibility rules could seat enough
/// judges after it resets. A full usable panel never waits for optional seats.
pub(in super::super) fn resolve_quota_panel(
    panel: Vec<Configuration>,
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    mut quota: Vec<(i64, Configuration)>,
    deferred: Option<BenchmarkError>,
) -> Result<Vec<Configuration>> {
    if panel.len() < MIN_JUDGES && !quota.is_empty() {
        quota.sort_by_key(|(until, _)| *until);
        let mut potential: Vec<_> = panel.iter().cloned().map(|judge| (None, judge)).collect();
        for (until, judge) in quota {
            potential.push((None, judge));
            if ordinary_judges(candidates, draft, potential.clone()).len() >= MIN_JUDGES {
                return Err(judge_quota_wait(Some(until)));
            }
        }
    }
    resolve_judge_panel(panel, deferred)
}

pub(in super::super) fn resolve_judge_panel(
    panel: Vec<Configuration>,
    deferred: Option<BenchmarkError>,
) -> Result<Vec<Configuration>> {
    if panel.len() < MIN_JUDGES {
        if let Some(error) = deferred {
            return Err(error);
        }
    }
    Ok(panel)
}

/// What stops a judge panel between its calls: the run's cancel signal and,
/// for a panel inside a run, the run leaving the running state.
#[derive(Clone)]
pub struct JudgeStop {
    pub(in super::super) cancel: watch::Receiver<bool>,
    pub(in super::super) run_id: Option<String>,
    pub(in super::super) qualification_id: Option<String>,
}

impl JudgeStop {
    pub fn run(run_id: &str, cancel: watch::Receiver<bool>) -> Self {
        Self {
            cancel,
            run_id: Some(run_id.to_string()),
            qualification_id: None,
        }
    }
    /// An operator's own request outside any running plan.
    pub fn manual() -> Self {
        Self {
            cancel: watch::channel(false).1,
            run_id: None,
            qualification_id: None,
        }
    }
    pub(in super::super) fn qualification(id: &str) -> Self {
        Self {
            qualification_id: Some(id.into()),
            ..Self::manual()
        }
    }
    pub(in super::super) async fn turn_cancelled(&self, store: &Store) -> Result<bool> {
        Ok(self.cancelled()
            || match &self.qualification_id {
                Some(id) => store.qualification_stopped(id).await?,
                None => false,
            })
    }
    pub(in super::super) fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
    /// A panel inside a run finishes a batch its own stop cut short.
    pub(in super::super) fn continues_batches(&self) -> bool {
        self.run_id.is_some()
    }
    pub async fn halted(&self, store: &Store) -> Result<bool> {
        if self.turn_cancelled(store).await? {
            return Ok(true);
        }
        Ok(match &self.run_id {
            Some(id) => store.run_state(id).await? != "running",
            None => false,
        })
    }
}

impl NativeBackend {
    /// The panel for one rendering: the judge pool's calibrated entries on
    /// the enabled accounts that offer them, one per lab (see
    /// [`ordinary_judges`] and [`crate::services::benchmarks::judge_pool`]). A frozen panel names
    /// its own seats.
    pub(in super::super) async fn judge_panel(
        &self,
        store: &Store,
        attempt: &Attempt,
        draft: &BenchmarkDraft,
        rejected: &[judge_recovery::Rejection],
        frozen: bool,
        open: Option<&OpenBatch>,
    ) -> Result<DiscoveredJudgePanel> {
        let contributing =
            crate::services::benchmarks::workflow::judge_candidates(store, attempt).await?;
        let candidates: Vec<_> = contributing.iter().collect();
        if frozen {
            if let Some(panel) =
                crate::services::benchmarks::judge_panel::frozen(draft, &candidates)?
            {
                return Ok(DiscoveredJudgePanel::fixed(panel));
            }
        }
        let textual = text_judged(draft);
        let pool = crate::services::benchmarks::judge_pool::seatable(&store.root, textual).await?;
        let offered = self
            .offered_judges(
                &attempt.run_id,
                &format!("attempt {}", attempt.id),
                // The pool holds only entries that may judge this rubric, a
                // visual one's those that see images.
                &pool,
                Some((store, attempt)),
            )
            .await?;
        let deferred = offered.deferred;
        let diagnostics = offered.diagnostics;
        let quota = quota_seats(&pool, offered.quota, rejected);
        let offered = crate::services::benchmarks::judge_pool::seat_rows(&pool, offered.rows);
        let seats: Vec<String> = offered
            .iter()
            .map(|(headroom, judge)| {
                let left = headroom.map_or("unknown".to_owned(), |h| {
                    format!(
                        "{:.0} % left, read {} s ago",
                        h.share,
                        (now() - h.read_at).max(0) / 1000
                    )
                });
                format!(
                    "{}@{} ({left})",
                    judge.model_id,
                    judge.account_id.as_deref().unwrap_or_default()
                )
            })
            .collect();
        // Frozen panels returned above keep their exact seats. A judge sits
        // whatever else its account is doing: its turn is a session of its
        // own, and the work beside it changes neither its answer nor its
        // pace (owner, 11-14). Judges used to wait for their accounts to
        // fall idle, and a day of chats on those accounts paused the run.
        let offered = offered
            .into_iter()
            .filter(|(_, judge)| !judge_recovery::excluded(judge, rejected))
            .map(|(headroom, judge)| (headroom.map(|h| h.share), judge))
            .collect();
        let panel = if let Some(open) = open {
            match ordinary_judging::available_panel(
                open,
                &candidates,
                draft,
                offered,
                quota,
                deferred,
            ) {
                Ok(panel) => panel,
                // Nobody can take the missing seat now. The caller renews a
                // stale sandbox check and waits for it before it gives up.
                Err(error) if error.code == ordinary_judging::PANEL_UNAVAILABLE => {
                    let mut short =
                        DiscoveredJudgePanel::discovered(Vec::new(), diagnostics, &pool);
                    short.unavailable = Some(error);
                    return Ok(short);
                }
                Err(error) => return Err(error),
            }
        } else {
            let panel = ordinary_judges(&candidates, draft, offered);
            resolve_quota_panel(panel, &candidates, draft, quota, deferred)?
        };
        log::info!(
            "[benchmarks] judge panel for attempt {}: {} of offered {}",
            attempt.id,
            panel
                .iter()
                .map(|judge| format!(
                    "{}@{}",
                    judge.model_id,
                    judge.account_id.as_deref().unwrap_or_default()
                ))
                .collect::<Vec<_>>()
                .join(", "),
            seats.join(", ")
        );
        let mut panel = panel;
        // Older tasks may have reserved two seats for their calibration panel.
        // Rotate identities without enlarging that run's admitted call budget.
        if open.is_none() {
            panel.truncate(crate::services::benchmarks::judge_execution_count(draft));
        }
        Ok(DiscoveredJudgePanel::discovered(panel, diagnostics, &pool))
    }

    /// Every enabled account's available native text models of the providers
    /// `pool` has an entry of, with their account's usage headroom. An account
    /// whose usage is spent, or ran out in `run`, cannot be asked now, but its
    /// rows still distinguish a temporary missing seat from an impossible
    /// panel. Judges never draw on credits.
    pub(in super::super) async fn offered_judges(
        &self,
        run: &str,
        subject: &str,
        pool: &[crate::services::benchmarks::judge_pool::Entry],
        diagnostic_target: Option<(&Store, &Attempt)>,
    ) -> Result<JudgeOffers> {
        let admit = |provider: &str| pool.iter().any(|entry| entry.provider_id == provider);
        let snapshot =
            crate::services::provider_accounts::snapshot(&self.app).map_err(host_error)?;
        let mut accounts = Vec::new();
        for account in judge_accounts(&snapshot.accounts, admit, |provider| {
            crate::services::provider_accounts::cli_login_account_id(provider)
                .and_then(|id| crate::services::provider_accounts::account(&self.app, &id).ok())
        }) {
            // A signed-out account seats nobody and is asked for nothing.
            if crate::services::provider_account_status::signed_in(&self.app, &account).await {
                accounts.push(account);
            }
        }
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let mut offered = Vec::new();
        let mut quota = Vec::new();
        let mut deferred = None;
        let mut diagnostics = Vec::new();
        for account in &accounts {
            let limited_until = if let Some(until) = exhausted_until(run, &account.id) {
                Some(until)
            } else if crate::services::provider_account_status::usage_spent(
                &self.app,
                &account.id,
                false,
            )
            .await
            {
                Some(
                    crate::services::provider_account_status::spent_until(
                        &self.app,
                        &account.id,
                        None,
                    )
                    .await
                    .unwrap_or(now() + QUOTA_RETRY_MS),
                )
            } else {
                None
            };
            if let Some(until) = limited_until {
                log::info!(
                    "[benchmarks] judge panel for {subject} cannot ask account {} before quota recheck {until}",
                    account.id,
                );
            }
            let listed = self
                .judge_listing(
                    &host,
                    run,
                    &format!("judge panel for {subject}"),
                    &account.provider_id,
                    &account.id,
                    diagnostic_target,
                )
                .await;
            let models = match listed {
                Ok(listed) => {
                    match self
                        .inventory_rows(&account.provider_id, &account.id, &listed)
                        .await
                    {
                        Ok(models) => Ok(models),
                        Err(error) => Err(preserve_judge_discovery_refusal(
                            diagnostic_target,
                            &account.provider_id,
                            &account.id,
                            "judge_inventory_rows",
                            error,
                            None,
                        )
                        .await?),
                    }
                }
                Err(error) => Err(error),
            };
            let models = match models {
                Ok(models) => models,
                Err(error) => {
                    if error
                        .details
                        .as_ref()
                        .is_some_and(|d| d["diagnosticPersistenceFailed"] == true)
                    {
                        return Err(error);
                    }
                    if unstarted_refusal(&error) {
                        deferred = Some(error.clone());
                    }
                    diagnostics.extend(JudgeDiscoveryIssue::from_error(
                        &account.provider_id,
                        Some(&account.id),
                        &error,
                    ));
                    log::info!(
                        "[benchmarks] judge panel for {subject} skips account {}: its model list failed: {}",
                        account.id,
                        error.message
                    );
                    continue;
                }
            };
            for model in models {
                // Journalled for the rows a panel can seat. The listing's other
                // rows were journalled too, on every pass of every answer that
                // waited for judges: twelve rows a pass buried the cause the
                // answer was waiting for (11-14).
                if !model.available
                    && model.configuration.execution_profile == "native_text"
                    && pool_names(
                        pool,
                        &account.provider_id,
                        Some(&account.id),
                        &model.configuration.model_id,
                    )
                {
                    let error = host_error(model.reason.clone().unwrap_or_else(|| {
                        "capability_missing: Native text runtime is unavailable".into()
                    }));
                    preserve_judge_discovery_refusal(
                        diagnostic_target,
                        &account.provider_id,
                        &account.id,
                        "judge_inventory_readiness",
                        error,
                        Some(&model.configuration),
                    )
                    .await?;
                }
                diagnostics.extend(JudgeDiscoveryIssue::from_model(&model));
                if model.available && model.configuration.execution_profile == "native_text" {
                    if let Some(until) = limited_until {
                        quota.push((until, model));
                        continue;
                    }
                    let headroom = crate::services::provider_account_status::usage_headroom(
                        &self.app,
                        &account.id,
                        Some(model.configuration.model_id.as_str()),
                    )
                    .await;
                    let flown = account_pace::last_flight(&format!(
                        "{}\u{1f}{}",
                        account.provider_id, account.id
                    ));
                    offered.push((trusted_headroom(headroom, flown, now()), model));
                }
            }
        }
        Ok(JudgeOffers {
            rows: offered,
            quota,
            deferred,
            diagnostics,
        })
    }
}

pub(in crate::services::benchmarks) fn qualification_carrier(
    record: &crate::services::benchmarks::qualification::Record,
    version: &BenchmarkVersion,
    index: usize,
) -> Attempt {
    let configuration = Configuration {
        id: "qualification-control".into(),
        provider_id: "qualification".into(),
        account_id: None,
        model_id: "qualification-control".into(),
        effort: None,
        fast_mode: None,
        billing_mode: "unknown".into(),
        execution_profile: "native_text".into(),
        inventory_revision: None,
        model_name: None,
    };
    let mut carrier =
        crate::services::benchmarks::pending_attempt(&record.id, &version.id, &configuration, 0);
    carrier.output = Some(record.request.controls[index].output.clone());
    carrier.outcome = Some("pending_review".into());
    carrier.phase = "terminal".into();
    carrier
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn a_failing_turn_never_takes_a_stop_back() {
        let (dir, s, _backend) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        s.store.set_run_state(&run.id, "cancelling").await.unwrap();
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelling");
        s.store.set_run_state(&run.id, "cancelled").await.unwrap();
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelled");
        dir.close().await;
    }

    /// A run resumed inside its window keeps what it measured: a case short
    /// of its repetitions keeps the scored ones and runs only the rest, a
    /// cancelled repetition measured again, as the cell is the run's across
    /// a pause. A case complete when the run stopped, passed or failed,
    /// stands, and the board counts the cell finished across the pause as
    /// complete.
    #[tokio::test]
    async fn a_resumed_run_keeps_scored_repetitions_and_runs_only_the_rest() {
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        let second = second_case(&s).await;
        req.version_ids.push(second.clone());
        req.repetitions = 3;
        req.max_executions = 6;
        let run = s.start_run(req).await.unwrap();
        // The first case failed all three repetitions; the second was
        // measured once and its second repetition was cut off.
        for attempt in &run.attempts {
            if attempt.version_id == first {
                s.store
                    .save_attempt(&settle(attempt, "fail"))
                    .await
                    .unwrap();
            } else if attempt.repetition == 0 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            } else if attempt.repetition == 1 {
                s.store
                    .save_attempt(&settle(attempt, "cancelled"))
                    .await
                    .unwrap();
            }
        }
        s.control(&run.id, "pause").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "paused");
        s.control(&run.id, "resume").await.unwrap();
        let resumed = s.store.run(&run.id).await.unwrap();
        // The failed cell is a result, not a gap: nothing of it is planned again.
        assert!(cell_of(&resumed, &first)
            .iter()
            .all(|a| a.outcome.as_deref() == Some("fail")));
        // The scored repetition stands; the cancelled one is superseded and
        // queued anew beside the one never started.
        let unfinished = cell_of(&resumed, &second);
        assert_eq!(unfinished.len(), 4);
        assert_eq!(
            unfinished
                .iter()
                .find(|a| a.repetition == 0)
                .and_then(|a| a.outcome.as_deref()),
            Some("pass")
        );
        assert_eq!(
            unfinished
                .iter()
                .filter(|a| a.outcome.as_deref() == Some("superseded"))
                .count(),
            1
        );
        let mut queued: Vec<u32> = unfinished
            .iter()
            .filter(|a| a.phase == "pending")
            .map(|a| a.repetition)
            .collect();
        queued.sort_unstable();
        assert_eq!(queued, vec![1, 2]);
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        // Only the two owed repetitions were paid for.
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            cell_of(&done, &second)
                .iter()
                .filter(|a| crate::services::benchmarks::analysis::score(a).is_some())
                .count(),
            3
        );
        // The board and ledger read the cell finished across the pause as
        // complete, both cases measured whole.
        let data = s.query_data().await.unwrap();
        let report =
            crate::services::benchmarks::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].scored, 2);
        assert_eq!(report.rows[0].complete, 2);
        dir.close().await;
    }

    /// Stop then Finish is the same run: the repetitions scored before the
    /// stop count, the cancelled one runs again, and the cell completed
    /// across the stop is complete on the board and survives the bake.
    #[tokio::test]
    async fn stop_then_finish_completes_a_cell_from_its_scored_repetitions() {
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        req.repetitions = 3;
        req.max_executions = 3;
        let run = s.start_run(req).await.unwrap();
        for attempt in &run.attempts {
            if attempt.repetition < 2 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            }
        }
        s.control(&run.id, "cancel").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelled");
        let finished = s.extend_run(&run.id, &[], &[]).await.unwrap();
        assert_eq!(finished.id, run.id);
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        let scored = |run: &BenchmarkRun| {
            cell_of(run, &first)
                .iter()
                .filter(|a| crate::services::benchmarks::analysis::score(a).is_some())
                .count()
        };
        assert_eq!(scored(&done), 3);
        let data = s.query_data().await.unwrap();
        let report =
            crate::services::benchmarks::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows[0].complete, 1);
        sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
            .bind(now() - crate::services::benchmarks::analysis::RUN_WINDOW_MS - 60_000)
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        s.tick().await.unwrap();
        let baked = s.store.run(&run.id).await.unwrap();
        assert!(baked.baked_at.is_some());
        assert_eq!(scored(&baked), 3);
        let data = s.query_data().await.unwrap();
        let report =
            crate::services::benchmarks::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows[0].complete, 1);
        dir.close().await;
    }

    #[tokio::test]
    async fn sealing_and_restarting_preserve_superseded_evidence() {
        let (dir, s, _) = setup().await;
        let mut req = request(&s).await;
        req.repetitions = 3;
        req.max_executions = 3;
        let run = s.start_run(req).await.unwrap();
        // A paid repetition the owner's stop cut off is measured again on
        // resume; its evidence stays.
        let mut original = settle(&run.attempts[0], "cancelled");
        original.output = Some("Paid original answer".into());
        original.usage.cost = Some(0.25);
        s.store.save_attempt(&original).await.unwrap();
        s.store.set_run_state(&run.id, "paused").await.unwrap();
        s.control(&run.id, "resume").await.unwrap();
        let archived = s.store.attempt(&original.id).await.unwrap();
        assert_eq!(archived.outcome.as_deref(), Some("superseded"));
        assert_eq!(archived.output, original.output);
        assert_eq!(archived.usage.cost, original.usage.cost);
        let resumed = s.store.run(&run.id).await.unwrap();
        let mut partial = settle(
            resumed
                .attempts
                .iter()
                .find(|a| a.phase == "pending")
                .unwrap(),
            "fail",
        );
        partial.output = Some("Second paid answer".into());
        partial.usage.cost = Some(0.5);
        s.store.save_attempt(&partial).await.unwrap();
        s.bake(&s.store.run(&run.id).await.unwrap(), now())
            .await
            .unwrap();
        let archived = s.store.attempt(&partial.id).await.unwrap();
        assert_eq!(archived.outcome.as_deref(), Some("superseded"));
        assert_eq!(archived.output, partial.output);
        assert_eq!(archived.usage.cost, partial.usage.cost);
        dir.close().await;
    }

    /// A stop never costs a cell measured whole: once the stopped run's
    /// window closes and it is baked, its 3/3 cells stand and only the
    /// unfinished one is dropped.
    #[tokio::test]
    async fn complete_cells_survive_a_cancel_and_the_bake() {
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        let second = second_case(&s).await;
        req.version_ids.push(second.clone());
        req.repetitions = 3;
        req.max_executions = 6;
        let run = s.start_run(req).await.unwrap();
        for attempt in &run.attempts {
            if attempt.version_id == first || attempt.repetition == 0 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            }
        }
        s.control(&run.id, "cancel").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelled");
        sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
            .bind(now() - crate::services::benchmarks::analysis::RUN_WINDOW_MS - 60_000)
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        s.tick().await.unwrap();
        let baked = s.store.run(&run.id).await.unwrap();
        assert!(baked.baked_at.is_some());
        assert!(cell_of(&baked, &first)
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert!(cell_of(&baked, &second)
            .iter()
            .all(|a| a.outcome.as_deref() == Some("superseded")));
        let data = s.query_data().await.unwrap();
        let report =
            crate::services::benchmarks::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows[0].complete, 1);
        assert_eq!(report.rows[0].planned, 2);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        dir.close().await;
    }

    /// An app restart while the owner stops a run finishes the stop: the
    /// run is cancelled once nothing of it flies, never left for attention.
    #[tokio::test]
    async fn a_restart_during_a_stop_finishes_the_cancel() {
        let (dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        let mut a = run.attempts[0].clone();
        a.phase = "dispatching".into();
        s.store.save_attempt(&a).await.unwrap();
        s.store.set_run_state(&run.id, "cancelling").await.unwrap();
        s.store.recover().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelling");
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let stopped = s.store.run(&run.id).await.unwrap();
        assert_eq!(stopped.state, "cancelled");
        assert!(stopped.attempts[1..]
            .iter()
            .all(|a| a.outcome.as_deref() == Some("cancelled")));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        dir.close().await;
    }

    #[tokio::test]
    async fn pause_and_cancel_never_send_queued_work() {
        let (dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        s.control(&run.id, "pause").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "paused");
        s.control(&run.id, "cancel").await.unwrap();
        s.tick().await.unwrap();
        let run = s.store.run(&run.id).await.unwrap();
        assert_eq!(run.state, "cancelled");
        assert!(run
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("cancelled")));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        dir.close().await;
    }

    #[tokio::test]
    async fn resume_renews_a_stale_sandbox_check_and_adopts_the_updated_runtime() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        s.store.set_run_state(&run.id, "paused").await.unwrap();
        // An update of the app: a new runtime whose check is stale.
        *backend.inventory_revision.lock().unwrap() = Some("fake-v2".into());
        backend.stale_policy_check.store(true, Ordering::SeqCst);
        let resumed = s.control(&run.id, "resume").await.unwrap();
        assert_eq!(resumed.state, "running");
        assert_eq!(backend.policy_renewals.load(Ordering::SeqCst), 1);
        assert_eq!(
            resumed.request.configurations[0]
                .inventory_revision
                .as_deref(),
            Some("fake-v2")
        );
        dir.close().await;
    }

    #[tokio::test]
    async fn resume_keeps_a_stale_sandbox_check_refusal_when_renewing_fails() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        s.store.set_run_state(&run.id, "paused").await.unwrap();
        *backend.inventory_revision.lock().unwrap() = Some("fake-v2".into());
        backend.stale_policy_check.store(true, Ordering::SeqCst);
        backend.failing_policy_renewal.store(true, Ordering::SeqCst);
        let error = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(error.code, "capability_missing");
        assert!(
            error.message.contains("Linux text policy proof"),
            "{}",
            error.message
        );
        assert!(
            error.message.ends_with(
                "the sandbox check could not be renewed: Sandbox check failed: invented probe failure"
            ),
            "{}",
            error.message
        );
        assert_eq!(backend.policy_renewals.load(Ordering::SeqCst), 1);
        let unchanged = s.store.run(&run.id).await.unwrap();
        assert_eq!(unchanged.state, "paused");
        assert_eq!(
            unchanged.request.configurations[0]
                .inventory_revision
                .as_deref(),
            Some("fake-v1")
        );
        dir.close().await;
    }

    #[tokio::test]
    async fn saved_judge_repairs_only_append_to_open_runs_and_make_no_provider_calls() {
        let (dir, s, backend) = setup().await;
        let draft = critical_text();
        let version = publish(&s, draft.clone()).await;
        let mut req = creative_request(&s).await;
        req.version_ids = vec![version.id];
        let run = s.start_run(req).await.unwrap();
        let mut attempt = s.store.attempt(&run.attempts[0].id).await.unwrap();
        attempt.phase = "terminal".into();
        attempt.outcome = Some("pending_review".into());
        attempt.output =
            Some("Remove only the acknowledged revision. Wait for every participant.".into());
        attempt.evidence_hash = Some("sealed".into());
        let mut original = settled_batch()[1].clone();
        original.evaluator_revision = draft.evaluator.revision.clone();
        original.provenance = "judge_failure".into();
        original.verdict = "abstained".into();
        original.score = None;
        original.reason = "Critical checks unresolved; judge abstained. Trace".into();
        let mut checks = critical_reply()["checks"].clone();
        checks["retention"]["verdict"] = json!("fail");
        checks["barrier"]["verdict"] = json!("unknown");
        checks["barrier"]["evidence"] = json!([]);
        original.details = Some(
            json!({"judgeBatchId":"batch","sessionId":"session","requestKey":"key",
            "usageComplete":true,"criteria":{"quality":0.9},"criticalCheckPolicy":judge_checks::POLICY,
            "criticalCheckStatus":"unknown","criticalChecks":checks}),
        );
        attempt.evaluations = vec![original];
        s.store.save_attempt(&attempt).await.unwrap();
        for state in ["completed", "cancelled"] {
            s.store.set_run_state(&run.id, state).await.unwrap();
            s.repair_saved_judge_assessments().await.unwrap();
            assert_eq!(
                s.store
                    .attempt(&attempt.id)
                    .await
                    .unwrap()
                    .evaluations
                    .len(),
                1,
                "{state}"
            );
        }
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        // A new fixture state, rather than a product transition out of cancel.
        sqlx::query("UPDATE run_plans SET state='needs_attention',baked_at=1 WHERE id=?")
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        s.repair_saved_judge_assessments().await.unwrap();
        assert_eq!(
            s.store
                .attempt(&attempt.id)
                .await
                .unwrap()
                .evaluations
                .len(),
            1
        );
        sqlx::query("UPDATE run_plans SET baked_at=NULL WHERE id=?")
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        s.repair_saved_judge_assessments().await.unwrap();
        s.repair_saved_judge_assessments().await.unwrap();
        let repaired = s.store.attempt(&attempt.id).await.unwrap();
        assert_eq!(repaired.evaluations.len(), 2);
        assert_eq!(repaired.output, attempt.output);
        assert_eq!(repaired.evidence_hash, attempt.evidence_hash);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
        dir.close().await;
    }

    #[tokio::test]
    async fn a_restart_while_cancelling_settles_the_rendering() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.phase = "collecting".into();
        s.store.save_attempt(&a).await.unwrap();
        s.store.set_run_state(&run.id, "cancelled").await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        let settled = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        dir.close().await;
    }
}
