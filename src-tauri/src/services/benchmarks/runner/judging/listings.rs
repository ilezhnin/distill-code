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
