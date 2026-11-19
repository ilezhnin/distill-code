//! Model listings per provider account, kept for a run's judges.
use super::*;

/// The model inventories a run's attempts are checked against. Listing a
/// bridge's models opens a session on the bridge the user's own chats use,
/// which for Grok runs their session hooks and for Kimi files a session in
/// their history, so it happens once per run, provider and account, and
/// again only once the executable serving them changes.
#[derive(Default)]
pub(in super::super) struct RunInventories {
    pub(in super::super) runs:
        std::sync::Mutex<std::collections::HashMap<(String, String, String), Value>>,
    /// The newest listing of each provider and account, whichever run or
    /// inventory probe made it, when, and when a refresh of it was last
    /// refused: what judges sit on (see [`judge_inventory`]).
    pub(in super::super) latest:
        std::sync::Mutex<std::collections::HashMap<(String, String), KeptListing>>,
}

/// An account's newest listing, as [`RunInventories::latest`] hands it out.
#[derive(Clone, Debug)]
pub(in super::super) struct KeptListing {
    pub(in super::super) listed_at: Instant,
    pub(in super::super) inventory: Value,
    pub(in super::super) refused_at: Option<Instant>,
}

/// A kept listing as a judge weighs it: its age, and how long ago a refresh
/// of it was refused.
#[derive(Clone, Debug)]
pub(in super::super) struct ListingAge {
    pub(in super::super) age: Duration,
    pub(in super::super) refused_ago: Option<Duration>,
    pub(in super::super) inventory: Value,
}

impl KeptListing {
    fn aged(self) -> ListingAge {
        ListingAge {
            age: self.listed_at.elapsed(),
            refused_ago: self.refused_at.map(|at| at.elapsed()),
            inventory: self.inventory,
        }
    }
}

impl RunInventories {
    /// How many inventories are kept before those of other runs are dropped.
    pub(in super::super) const LIMIT: usize = 32;

    /// The inventory kept for `run` on `provider` and `account`, if the
    /// executable `serving` them now is the one that listed it.
    pub(in super::super) fn current(
        &self,
        run: &str,
        provider: &str,
        account: &str,
        serving: &Value,
    ) -> Option<Value> {
        let kept = self
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        kept.get(&(run.to_owned(), provider.to_owned(), account.to_owned()))
            .filter(|inventory| listed_by(inventory, serving))
            .cloned()
    }

    pub(in super::super) fn keep(
        &self,
        run: &str,
        provider: &str,
        account: &str,
        inventory: Value,
    ) {
        self.observe(provider, account, inventory.clone());
        let mut kept = self
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if kept.len() >= Self::LIMIT {
            kept.retain(|(kept_run, _, _), _| kept_run == run);
        }
        kept.insert(
            (run.to_owned(), provider.to_owned(), account.to_owned()),
            inventory,
        );
    }

    /// Records a listing of `provider` on `account` made now, for any run.
    pub(in super::super) fn observe(&self, provider: &str, account: &str, inventory: Value) {
        self.latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                (provider.to_owned(), account.to_owned()),
                KeptListing {
                    listed_at: Instant::now(),
                    inventory,
                    refused_at: None,
                },
            );
    }

    /// The newest listing of `provider` on `account`, if the executable
    /// `serving` them now is the one that listed it.
    pub(in super::super) fn latest(
        &self,
        provider: &str,
        account: &str,
        serving: &Value,
    ) -> Option<KeptListing> {
        self.latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(provider.to_owned(), account.to_owned()))
            .filter(|kept| listed_by(&kept.inventory, serving))
            .cloned()
    }

    /// Notes that a refresh of the newest listing was refused just now.
    pub(in super::super) fn refused(&self, provider: &str, account: &str) {
        if let Some(kept) = self
            .latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(&(provider.to_owned(), account.to_owned()))
        {
            kept.refused_at = Some(Instant::now());
        }
    }
}

/// Whether the executable `serving` an account now listed `inventory`;
/// nothing serving is never a match.
fn listed_by(inventory: &Value, serving: &Value) -> bool {
    !serving.is_null() && inventory.get("executable") == Some(serving)
}

/// A judge sits on its account's newest listing without listing again while
/// the listing is this young.
const JUDGE_LISTING_FRESH: Duration = Duration::from_secs(3600);

/// The oldest listing a judge falls back to when a refresh is refused.
const JUDGE_LISTING_MAX_AGE: Duration = Duration::from_secs(12 * 3600);

/// How long a refused refresh is not tried again; the listing stands.
const JUDGE_REFRESH_RETRY: Duration = Duration::from_secs(600);

/// The inventory a judge's account is seated from, and, when it fell back,
/// the age of that listing and why the refresh failed. A live listing
/// spawns a provider process the sandbox admits as a light job, which it
/// refuses under wave load, so a judge sits on the account's newest listing
/// (the candidates' own, an inventory probe's or an earlier judge's, by the
/// executable serving it now): without listing while it is fresh or a
/// refresh was refused moments ago, and when a refresh (`list`) is refused,
/// while it is younger than [`JUDGE_LISTING_MAX_AGE`]. Only an account with
/// no such listing depends on a live one.
pub(in super::super) async fn judge_inventory(
    kept: Option<ListingAge>,
    list: impl std::future::Future<Output = Result<Value>>,
) -> Result<(Value, Option<(Duration, BenchmarkError)>)> {
    let usable = kept.filter(|kept| kept.age < JUDGE_LISTING_MAX_AGE);
    if let Some(kept) = &usable {
        let refused_lately = kept
            .refused_ago
            .is_some_and(|ago| ago < JUDGE_REFRESH_RETRY);
        if kept.age < JUDGE_LISTING_FRESH || refused_lately {
            return Ok((kept.inventory.clone(), None));
        }
    }
    match list.await {
        Ok(inventory) => Ok((inventory, None)),
        Err(error) => match usable {
            Some(kept) => Ok((kept.inventory, Some((kept.age, error)))),
            None => Err(error),
        },
    }
}

/// Inventory discovery may legitimately proceed after a refused optional
/// refresh/account. Persist that original refusal before reducing it to a
/// panel-availability label or returning a usable cached listing.
pub(in super::super) async fn preserve_judge_discovery_refusal(
    target: Option<(&Store, &Attempt)>,
    provider: &str,
    account: &str,
    stage: &str,
    error: BenchmarkError,
    judge: Option<&Configuration>,
) -> Result<BenchmarkError> {
    let Some((store, attempt)) = target else {
        return Ok(error);
    };
    let error = diagnostics::record(
        store,
        attempt,
        stage,
        error,
        judge,
        json!({"providerId":provider,"accountId":account,"dispatched":false}),
    )
    .await;
    if error
        .details
        .as_ref()
        .is_some_and(|d| d["diagnosticPersistenceFailed"] == true)
    {
        // Before dispatch, a failed diagnostic write must remain visible even
        // when the optional provider would otherwise be silently skipped.
        return Err(error);
    }
    Ok(error)
}

pub(in super::super) async fn preserve_judge_listing(
    target: Option<(&Store, &Attempt)>,
    provider: &str,
    account: &str,
    result: Result<(Value, Option<(Duration, BenchmarkError)>)>,
) -> Result<(Value, Option<(Duration, BenchmarkError)>)> {
    match result {
        Ok((listed, Some((age, error)))) => {
            let error = preserve_judge_discovery_refusal(
                target,
                provider,
                account,
                "judge_inventory_refresh",
                error,
                None,
            )
            .await?;
            Ok((listed, Some((age, error))))
        }
        Err(error) => Err(preserve_judge_discovery_refusal(
            target,
            provider,
            account,
            "judge_inventory_listing",
            error,
            None,
        )
        .await?),
        result => result,
    }
}

impl NativeBackend {
    /// `result`, the host inventory of `provider` on `account`, as the rows a
    /// configuration is chosen from: each pinned to its runtime identity, and
    /// unavailable, with the reason, where the profile may not run.
    pub(in super::super) async fn inventory_rows(
        &self,
        provider: &str,
        account: &str,
        result: &Value,
    ) -> Result<Vec<InventoryModel>> {
        let record =
            crate::services::provider_accounts::account(&self.app, account).map_err(host_error)?;
        let billing = crate::services::provider_accounts::billing_mode(&record);
        // A provider with no verified profile is listed but never pinned
        // or admitted.
        let native = NativeProvider::for_harness(provider);
        let (identity, unavailable) = match native {
            Some(native) => match text_execution::readiness(native, account).await {
                Ok(status) => (Some(text_execution::revision(native, &status)), None),
                Err(error) => (None, Some(host_error(error).message)),
            },
            None => (
                None,
                Some("Linux text execution restrictions have not been verified".into()),
            ),
        };
        let excluded = native.map_or(&[][..], NativeProvider::excluded_efforts);
        let mut rows: Vec<InventoryModel> = result["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let id = row
                    .get("modelId")
                    .or_else(|| row.get("id"))
                    .and_then(Value::as_str)?;
                let efforts = offered_efforts(row, excluded);
                let name = row["name"].as_str().unwrap_or(id);
                let reason = unavailable
                    .clone()
                    .or_else(|| row["unavailable"].as_str().map(str::to_owned));
                Some(InventoryModel {
                    configuration: Configuration {
                        id: format!("{provider}:{account}:{id}"),
                        provider_id: provider.into(),
                        account_id: Some(account.into()),
                        model_id: id.into(),
                        effort: None,
                        fast_mode: None,
                        billing_mode: billing.into(),
                        execution_profile: "native_text".into(),
                        inventory_revision: identity
                            .as_ref()
                            .map(|identity| text_inventory_revision(identity, result, id)),
                        model_name: (name != id).then(|| name.to_string()),
                    },
                    name: name.into(),
                    efforts,
                    supports_fast_mode: row["supportsFast"].as_bool().unwrap_or(false),
                    available: reason.is_none(),
                    reason,
                })
            })
            .collect();
        if let Some(provider) = native {
            let readiness = repository_execution::readiness(provider, account).await;
            let (revision, reason) = match readiness {
                Ok(status) => (
                    Some(repository_execution::revision(provider, &status)),
                    None,
                ),
                Err(error) => (None, Some(host_error(error).message)),
            };
            let repository_rows = rows
                .iter()
                .cloned()
                .map(|mut row| {
                    row.configuration.id.push_str(":repository");
                    row.configuration.execution_profile = "protected_repository".into();
                    row.configuration.inventory_revision = revision.as_ref().map(|runtime| {
                        repository_inventory_revision(runtime, result, &row.configuration.model_id)
                    });
                    row.reason = reason.clone().or(row.reason);
                    row.available = row.reason.is_none();
                    row
                })
                .collect::<Vec<_>>();
            rows.extend(repository_rows);
        }
        Ok(rows)
    }

    /// The inventory `run`'s attempts on `provider` and `account` are checked
    /// against: listed once for the run, and again only once another
    /// executable serves them (see [`RunInventories`]).
    pub(in super::super) async fn run_inventory(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        run: &str,
        provider: &str,
        account: &str,
    ) -> Result<Value> {
        let serving = host.benchmark_serving_executable(provider, account).await;
        if let Some(inventory) = self.inventories.current(run, provider, account, &serving) {
            return Ok(inventory);
        }
        self.list_inventory(host, run, provider, account).await
    }

    /// A judge account's model listing: its newest kept one, a live one only
    /// when none is usable (see [`judge_inventory`]); a live listing spawns a
    /// provider process the sandbox may refuse under load, and that refusal
    /// must not drop a judge listed lately.
    pub(in super::super) async fn judge_listing(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        run: &str,
        subject: &str,
        provider: &str,
        account: &str,
        diagnostic_target: Option<(&Store, &Attempt)>,
    ) -> Result<Value> {
        let serving = host.benchmark_serving_executable(provider, account).await;
        let kept = self
            .inventories
            .latest(provider, account, &serving)
            .map(KeptListing::aged);
        let result = judge_inventory(kept, self.list_inventory(host, run, provider, account)).await;
        // Keep the original cache retry policy, including when journal storage
        // itself is temporarily unavailable.
        if result.as_ref().is_ok_and(|(_, refused)| refused.is_some()) {
            self.inventories.refused(provider, account);
        }
        let (listed, refused) =
            preserve_judge_listing(diagnostic_target, provider, account, result).await?;
        if let Some((age, error)) = refused {
            log::info!(
                "[benchmarks] {subject} seats account {account} from its listing of {} s ago: listing it again failed: {}",
                age.as_secs(),
                error.message
            );
        }
        Ok(listed)
    }

    /// Lists `provider`'s models on `account` now and keeps them for `run`.
    async fn list_inventory(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        run: &str,
        provider: &str,
        account: &str,
    ) -> Result<Value> {
        let inventory = host
            .benchmark_inventory(provider, account, true)
            .await
            .map_err(host_error)?;
        self.inventories
            .keep(run, provider, account, inventory.clone());
        Ok(inventory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use crate::services::benchmarks::runner::*;
    use std::sync::atomic::Ordering;

    /// A test added to a run inside its window joins that run: the sitting
    /// grows and goes on, no second run starts beside it, and what the run
    /// had measured stands.
    #[tokio::test]
    async fn a_run_inside_its_window_grows_by_the_tests_added_to_it() {
        let (dir, s, backend) = setup().await;
        let req = request(&s).await;
        let first = req.version_ids[0].clone();
        let run = s.start_run(req).await.unwrap();
        for attempt in &run.attempts {
            s.store
                .save_attempt(&settle(attempt, "pass"))
                .await
                .unwrap();
        }
        s.store.set_run_state(&run.id, "completed").await.unwrap();
        // Complete on every test it planned, the run has nothing to resume.
        let refused = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(refused.code, "validation");
        let second = second_case(&s).await;
        let grown = s
            .extend_run(&run.id, std::slice::from_ref(&second), &[])
            .await
            .unwrap();
        assert_eq!(grown.state, "running");
        assert_eq!(
            grown.request.version_ids,
            vec![first.clone(), second.clone()]
        );
        assert_eq!(grown.attempts.len(), 4);
        assert!(grown
            .attempts
            .iter()
            .filter(|a| a.version_id == second)
            .all(|a| a.phase == "pending"));
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert!(done
            .attempts
            .iter()
            .filter(|a| a.version_id == first)
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert_eq!(
            done.attempts
                .iter()
                .filter(|a| a.version_id == second
                    && crate::services::benchmarks::analysis::score(a).is_some())
                .count(),
            2
        );
        // The same test again adds nothing and the run is complete.
        let again = s.extend_run(&run.id, &[second], &[]).await.unwrap_err();
        assert_eq!(again.message, "Every case of this run is complete");
        assert_eq!(s.store.run(&run.id).await.unwrap().attempts.len(), 4);
        dir.close().await;
    }

    /// Once a run's window closed it is final: nothing resumes it, and the
    /// runner bakes it, keeping the cells measured whole and dropping the
    /// rest, so a case half measured never reads as measured at all.
    #[tokio::test]
    async fn a_run_past_its_window_is_baked() {
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        let second = second_case(&s).await;
        req.version_ids.push(second.clone());
        req.repetitions = 3;
        req.max_executions = 6;
        let run = s.start_run(req).await.unwrap();
        // The first case is complete; the second holds one of three.
        for attempt in &run.attempts {
            if attempt.version_id == first || attempt.repetition == 0 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            }
        }
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
            .bind(now() - crate::services::benchmarks::analysis::RUN_WINDOW_MS - 60_000)
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        let refused = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(refused.code, "validation");
        assert!(
            refused.message.contains("window closed"),
            "{}",
            refused.message
        );
        let grown = s.extend_run(&run.id, &[], &[]).await.unwrap_err();
        assert!(grown.message.contains("window closed"), "{}", grown.message);
        s.tick().await.unwrap();
        let baked = s.store.run(&run.id).await.unwrap();
        assert!(baked.baked_at.is_some());
        assert_eq!(baked.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        for attempt in &baked.attempts {
            let expected = if attempt.version_id == first {
                "pass"
            } else {
                "superseded"
            };
            assert_eq!(attempt.outcome.as_deref(), Some(expected), "{}", attempt.id);
            assert_eq!(attempt.phase, "terminal");
        }
        // The ledger holds the complete case alone.
        let data = s.query_data().await.unwrap();
        let report =
            crate::services::benchmarks::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].scored, 1);
        assert_eq!(report.rows[0].complete, 1);
        assert_eq!(report.rows[0].planned, 2);
        // Baked once: the next tick leaves it alone.
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().baked_at, baked.baked_at);
        dir.close().await;
    }

    #[test]
    fn a_provider_usage_limit_before_any_answer_waits_for_quota() {
        let limit = json!({"code":-32000,"data":{"accountId":"cli-login-kimi-acp",
            "dispatchStarted":true,"promptNotAccepted":false},
            "message":"Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."});
        let empty = TokenUsage::default();
        assert!(refused_for_quota(&limit, "", &empty));
        // An answer already under way was measured; it settles as it ended.
        assert!(!refused_for_quota(&limit, "partial", &empty));
        let answered = TokenUsage {
            output: Some(12),
            ..Default::default()
        };
        assert!(!refused_for_quota(&limit, "", &answered));
        // A model the plan leaves out is no quota.
        let refused = json!({"code":-32000,"message":"Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed."});
        assert!(!refused_for_quota(&refused, "", &empty));
    }

    /// Run 607f8612: Kimi answered every attempt on a model its plan leaves
    /// out with a 401 that names the model. That is the configuration being
    /// unsupported, not a broken bridge; a sign-in failure names no model.
    #[test]
    fn a_provider_refusing_the_model_makes_the_configuration_unsupported() {
        let pro_highspeed = json!({"code": -32000,
            "message": "Authentication required: 403 Your current subscription does not have access to k3.1-pro-highspeed. Upgrade to higher-tier Kimi Code plans."});
        assert_eq!(
            terminal_outcome(&pro_highspeed, "kimi-code/k3.1-pro-highspeed"),
            "unsupported"
        );
        assert_eq!(
            terminal_outcome(&pro_highspeed, "kimi-code/k3.1-pro"),
            "infrastructure_failure"
        );
        let refused = json!({"code": -32000,
            "data": {"accountId": "cli-login-kimi-acp", "dispatchStarted": true, "promptNotAccepted": false},
            "message": "Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: https://www.kimi.com/code?from=server_highspeed_error#pricing"});
        assert_eq!(
            terminal_outcome(&refused, "kimi-code/kimi-for-coding-highspeed"),
            "unsupported"
        );
        // The same refusal does not name the plan's own model.
        assert_eq!(
            terminal_outcome(&refused, "kimi-code/kimi-for-coding"),
            "infrastructure_failure"
        );
        // A sign-in that failed names no model.
        let signed_out = json!({"code": -32000, "message": "Authentication required"});
        assert_eq!(
            terminal_outcome(&signed_out, "kimi-code/kimi-for-coding"),
            "infrastructure_failure"
        );
        // Nor does one that mentions the model without refusing it.
        for message in [
            "Authentication required: 401 sign in again to keep using kimi-for-coding-highspeed",
            "Authentication required: your subscription for kimi-for-coding-highspeed renews today; log in again",
        ] {
            assert_eq!(
                terminal_outcome(
                    &json!({"code": -32000, "message": message}),
                    "kimi-code/kimi-for-coding-highspeed"
                ),
                "infrastructure_failure",
                "{message}"
            );
        }
        // The refusal reads the same in another case, and by the full id.
        let shouting = json!({"code": -32000,
            "message": "401 YOUR CURRENT SUBSCRIPTION DOES NOT HAVE ACCESS TO KIMI-CODE/KIMI-FOR-CODING-HIGHSPEED"});
        assert_eq!(
            terminal_outcome(&shouting, "kimi-code/kimi-for-coding-highspeed"),
            "unsupported"
        );
        // Another error that names the model is not a refusal of it.
        let crashed = json!({"code": -32603,
            "message": "Internal error: kimi-for-coding-highspeed stream reset"});
        assert_eq!(
            terminal_outcome(&crashed, "kimi-code/kimi-for-coding-highspeed"),
            "infrastructure_failure"
        );
        // Typed outcomes are read as before.
        assert_eq!(
            terminal_outcome(&json!({"kind": "budget_timeout"}), "m"),
            "budget_timeout"
        );
        assert!(names("no access to grok-4.", "grok-4"));
        assert!(!names("no access to grok-4.7", "grok-4"));
        assert!(!names("no access to grok-4-fast", "grok-4"));
        assert!(!names("no access to xgrok-4", "grok-4"));
    }

    /// Listing a bridge's models opens a session on the bridge the user's
    /// chats use; a run does it once per provider and account, again only
    /// when another executable serves them.
    #[test]
    fn a_run_lists_each_bridge_once_until_another_executable_serves_it() {
        let kept = RunInventories::default();
        let on = |len: u64| json!({"path":"bridge.js","len":len,"modified":1});
        let inventory = json!({"executable": on(1), "models": [{"modelId":"m"}]});
        assert_eq!(kept.current("run", "p", "a", &on(1)), None);
        kept.keep("run", "p", "a", inventory.clone());
        assert_eq!(
            kept.current("run", "p", "a", &on(1)),
            Some(inventory.clone())
        );
        // Another executable, account or run is listed again; nothing serving
        // is never a match.
        assert_eq!(kept.current("run", "p", "a", &on(2)), None);
        assert_eq!(kept.current("run", "p", "b", &on(1)), None);
        assert_eq!(kept.current("next", "p", "a", &on(1)), None);
        assert_eq!(kept.current("run", "p", "a", &Value::Null), None);
        // Bounded: past the limit, other runs' inventories go.
        for n in 0..RunInventories::LIMIT {
            kept.keep(&format!("old-{n}"), "p", "a", inventory.clone());
        }
        kept.keep("run", "p", "b", inventory.clone());
        assert_eq!(kept.current("old-0", "p", "a", &on(1)), None);
        assert!(kept.current("run", "p", "b", &on(1)).is_some());
        // Whichever run listed an account last, judges see that listing, by
        // the executable that serves it now.
        let newest = json!({"executable": on(1), "models": [{"modelId":"newer"}]});
        kept.keep("another-run", "p", "a", newest.clone());
        let latest = kept.latest("p", "a", &on(1)).unwrap();
        assert_eq!(latest.inventory, newest);
        assert!(latest.listed_at.elapsed() < Duration::from_secs(60));
        assert!(latest.refused_at.is_none());
        assert!(kept.latest("p", "a", &on(2)).is_none());
        assert!(kept.latest("p", "a", &Value::Null).is_none());
        assert!(kept.latest("p", "c", &on(1)).is_none());
        kept.refused("p", "a");
        assert!(kept.latest("p", "a", &on(1)).unwrap().refused_at.is_some());
        // An inventory probe counts as a listing too, and clears the refusal.
        kept.observe("p", "a", inventory.clone());
        let probed = kept.latest("p", "a", &on(1)).unwrap();
        assert_eq!(probed.inventory, inventory);
        assert!(probed.refused_at.is_none());
    }

    /// 10-18: under wave load the sandbox refused the live listing of the
    /// Sol and Grok judge accounts as light jobs, leaving one judge, and the
    /// rescore's rubric cells could not form a panel.
    #[tokio::test]
    async fn a_refused_live_listing_still_seats_the_judge_from_its_newest_listing() {
        let listing = json!({"executable": {"path": "bridge.js"}, "models": [{"modelId": "m"}]});
        // Ages, not instants: a Windows Instant counts from boot.
        let kept = |listed: u64, refused: Option<u64>| ListingAge {
            age: Duration::from_secs(listed),
            refused_ago: refused.map(Duration::from_secs),
            inventory: listing.clone(),
        };
        let refusal = || {
            BenchmarkError::new(
                "capability_missing",
                "measured CPU load is above the light-job admission line",
            )
        };
        let never = async { panic!("a fresh listing is not listed again") };
        // Fresh: no live listing at all.
        let (seated, refused) = judge_inventory(Some(kept(60, None)), never).await.unwrap();
        assert_eq!(seated, listing);
        assert!(refused.is_none());
        // Older: a refresh is tried; refused, the listing still seats.
        let (seated, refused) =
            judge_inventory(Some(kept(2 * 3600, None)), async { Err(refusal()) })
                .await
                .unwrap();
        assert_eq!(seated, listing);
        let (age, error) = refused.unwrap();
        assert!(age >= Duration::from_secs(2 * 3600));
        assert!(error.message.contains("light-job admission line"));
        // A refresh refused moments ago is not tried again.
        let never = async { panic!("a refused refresh is not retried at once") };
        let (seated, _) = judge_inventory(Some(kept(2 * 3600, Some(30))), never)
            .await
            .unwrap();
        assert_eq!(seated, listing);
        // A refresh that answers wins.
        let newer = json!({"executable": {"path": "bridge.js"}, "models": [{"modelId": "n"}]});
        let answered = newer.clone();
        let (seated, refused) =
            judge_inventory(
                Some(kept(2 * 3600, Some(3600))),
                async move { Ok(answered) },
            )
            .await
            .unwrap();
        assert_eq!(seated, newer);
        assert!(refused.is_none());
        // Too old, or never listed: only a live listing seats.
        assert!(
            judge_inventory(Some(kept(13 * 3600, None)), async { Err(refusal()) })
                .await
                .is_err()
        );
        assert!(judge_inventory(None, async { Err(refusal()) })
            .await
            .is_err());
        let answered = newer.clone();
        assert_eq!(
            judge_inventory(None, async move { Ok(answered) })
                .await
                .unwrap()
                .0,
            newer
        );
    }

    #[tokio::test]
    async fn a_release_freezes_the_pool_until_the_next() {
        let (dir, s, _) = setup().await;
        let mut seeds = crate::services::benchmarks::seeds::definitions();
        for draft in &mut seeds {
            draft.split = "train".into();
        }
        let first = publish(&s, seeds.remove(0)).await;
        let second = publish(&s, seeds.remove(0)).await;
        let mut frozen = vec![first.id.clone(), second.id.clone()];
        frozen.sort();
        // Before any release the pool is every live test.
        assert_eq!(board_pool(&s).await, frozen);
        // Distinct milliseconds for the dated reads below.
        tokio::time::sleep(Duration::from_millis(5)).await;
        let v1 = s.create_release(None).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(v1.name, "v1");
        let refused = s.create_release(None).await.unwrap_err();
        assert!(
            refused.message.contains("not changed since v1"),
            "{}",
            refused.message
        );
        // A new test and a new version wait for the next release.
        let third = publish(&s, seeds.remove(0)).await;
        let mut draft = s
            .store
            .definition(&first.definition_id)
            .await
            .unwrap()
            .draft;
        draft.prompt.push_str(" Answer briefly.");
        let saved = s
            .store
            .save_draft(Some(first.definition_id.as_str()), Some(1), draft)
            .await
            .unwrap();
        let revised = s
            .store
            .publish(&first.definition_id, saved.draft_revision)
            .await
            .unwrap();
        assert_eq!(board_pool(&s).await, frozen);
        assert!(s.create_release(Some("v1".into())).await.is_err());
        tokio::time::sleep(Duration::from_millis(5)).await;
        let v2 = s.create_release(None).await.unwrap();
        assert_eq!(v2.name, "v2");
        let mut released = vec![revised.id, second.id, third.id];
        released.sort();
        assert_eq!(board_pool(&s).await, released);
        // A point dated before the first release reads the live tests of its day.
        let data = s.query_data().await.unwrap();
        let early = ResultQuery {
            as_of: Some(v1.created_at - 1),
            ..Default::default()
        };
        assert_eq!(
            crate::services::benchmarks::analysis::pool(&data, &early).len(),
            2
        );
        let between = ResultQuery {
            as_of: Some(v2.created_at - 1),
            ..Default::default()
        };
        let mut then: Vec<String> = crate::services::benchmarks::analysis::pool(&data, &between)
            .into_iter()
            .map(|version| version.id.clone())
            .collect();
        then.sort();
        assert_eq!(then, frozen);
        dir.close().await;
    }

    #[tokio::test]
    async fn stale_runtime_pins_are_plan_issues_and_quota_briefs_never_publish() {
        let (dir, s, _) = setup().await;
        let mut req = request(&s).await;
        assert!(s.preview_run(&req).await.unwrap().valid);
        req.configurations[0].inventory_revision = Some("runtime-before-an-update".into());
        let preview = s.preview_run(&req).await.unwrap();
        assert!(!preview.valid);
        assert!(preview.issues.iter().any(|i| i.contains("Runtime changed")));
        assert!(s.start_run(req).await.is_err());
        // Quota and capacity batches are retired: such a case never publishes.
        let mut quota = creative();
        quota.measurement_profile = "controlled_quota".into();
        let draft = s.store.save_draft(None, None, quota).await.unwrap();
        let refused = s.store.publish(&draft.id, 1).await.unwrap_err();
        assert!(
            refused.message.contains("only task metrics"),
            "{}",
            refused.message
        );
        dir.close().await;
    }

    #[tokio::test]
    async fn evaluating_again_without_a_panel_keeps_the_settled_score() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.evaluations.extend(settled_batch());
        a.outcome = Some("judged".into());
        s.store.save_attempt(&a).await.unwrap();
        let before = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(
            crate::services::benchmarks::analysis::score(&before),
            Some(0.7)
        );
        // The fake panel starts no batch, so nothing may be written.
        let refused = s.rescore(&a.id).await.unwrap_err();
        assert_eq!(refused.code, "validation");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
        let after = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(after.evaluations.len(), before.evaluations.len());
        assert_eq!(
            crate::services::benchmarks::analysis::score(&after),
            Some(0.7)
        );
        dir.close().await;
    }
}
