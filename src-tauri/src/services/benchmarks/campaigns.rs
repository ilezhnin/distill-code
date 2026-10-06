//! Opt-in campaigns expand discovered candidates into ordinary frozen run plans.
use super::{store::now, types::*, BenchmarkService};

// Admission and user edits share one short gate; discovery runs outside it.
static ADMISSION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn unchanged(service: &BenchmarkService, expected: &serde_json::Value) -> Result<bool> {
    let id = expected["id"].as_str().unwrap_or_default();
    let current = service
        .store
        .schedules()
        .await?
        .into_iter()
        .find(|s| s.id == id);
    Ok(current.map(serde_json::to_value).transpose()?.as_ref() == Some(expected))
}

pub async fn save_user_edit(service: &BenchmarkService, schedule: &mut Schedule) -> Result<()> {
    let _guard = ADMISSION_GATE.lock().await;
    if let Some(saved) = service
        .store
        .schedules()
        .await?
        .into_iter()
        .find(|s| s.id == schedule.id)
    {
        schedule.generated_run_ids = saved.generated_run_ids;
    }
    service.store.save_schedule(schedule).await
}

async fn update_if_current(
    service: &BenchmarkService,
    expected: &serde_json::Value,
    schedule: &Schedule,
) -> Result<()> {
    let _guard = ADMISSION_GATE.lock().await;
    if unchanged(service, expected).await? {
        service.store.save_schedule(schedule).await?;
        service.changed().await;
    }
    Ok(())
}

async fn admit(
    service: &BenchmarkService,
    expected: &serde_json::Value,
    schedule: &mut Schedule,
    request: RunRequest,
) -> Result<bool> {
    let _guard = ADMISSION_GATE.lock().await;
    if !unchanged(service, expected).await? {
        return Ok(false);
    }
    match service.start_run(request).await {
        Ok(run) => {
            schedule.generated_run_ids.push(run.id);
            schedule.next_due_at = now() + i64::from(schedule.interval_minutes) * 60000;
            schedule.paused_reason = None;
            schedule.missed = false;
        }
        Err(error) => {
            schedule.enabled = false;
            schedule.paused_reason = Some(error.message);
        }
    }
    service.store.save_schedule(schedule).await?;
    Ok(true)
}

pub fn validate(schedule: &Schedule) -> Result<()> {
    if !(1..=1000).contains(&schedule.max_runs)
        || !(1..=10000).contains(&schedule.max_total_executions)
    {
        return Err(BenchmarkError::new(
            "validation",
            "Campaign requires bounded run and total execution limits",
        ));
    }
    if let Some(rule) = &schedule.discovery {
        if rule.provider_id.is_empty()
            || rule.account_id.as_ref().is_some_and(|id| id.is_empty())
            || !(1..=32).contains(&rule.max_candidates)
            || rule.model_ids.len() > 64
            || schedule.request.configurations.iter().any(|config| {
                config.provider_id != rule.provider_id || config.account_id != rule.account_id
            })
        {
            return Err(BenchmarkError::new("validation", "Discovery must stay within the selected provider/account and at most 32 candidates"));
        }
    }
    Ok(())
}

fn refresh_candidates(schedule: &Schedule, inventory: &[InventoryModel]) -> Vec<Configuration> {
    let Some(rule) = &schedule.discovery else {
        return schedule.request.configurations.clone();
    };
    let mut configurations = Vec::new();
    for saved in &schedule.request.configurations {
        let Some(model) = inventory
            .iter()
            .find(|model| model.available && model.configuration.model_id == saved.model_id)
        else {
            continue;
        };
        // A saved effort the model no longer lists, or none on a model that
        // lists levels (it would run at the CLI's "default" and count
        // nowhere), leaves the candidates.
        if saved
            .effort
            .as_ref()
            .is_some_and(|effort| !model.efforts.contains(effort))
            || super::effort::left_to_the_cli(saved, model)
            || saved.fast_mode == Some(true) && !model.supports_fast_mode
        {
            continue;
        }
        // Re-pinned to today's runtime under today's name: a model id its
        // vendor moved to another model is a new runtime and a new name.
        let mut current = saved.clone();
        current.inventory_revision = model.configuration.inventory_revision.clone();
        current.model_name = model.configuration.model_name.clone();
        configurations.push(current);
    }
    if rule.include_new_models {
        for model in inventory.iter().filter(|model| model.available) {
            // Without a named list every available model may join; a list limits
            // discovery to the models it names.
            let admitted =
                rule.model_ids.is_empty() || rule.model_ids.contains(&model.configuration.model_id);
            if !admitted
                || configurations
                    .iter()
                    .any(|config| config.model_id == model.configuration.model_id)
                || schedule
                    .request
                    .configurations
                    .iter()
                    .any(|config| config.model_id == model.configuration.model_id)
            {
                continue;
            }
            // A new model starts at its highest listed level, as the run
            // dialog starts it; one that lists only levels nobody chooses
            // stays out. A model without an effort control runs unset.
            let mut discovered = model.configuration.clone();
            if !model.efforts.is_empty() {
                let Some(level) = super::effort::preselected(&model.efforts) else {
                    continue;
                };
                discovered.effort = Some(level.to_owned());
            }
            configurations.push(discovered);
        }
    }
    configurations
}

fn choose_candidates(
    mut candidates: Vec<Configuration>,
    prior: &[BenchmarkRun],
    maximum: usize,
) -> Vec<Configuration> {
    // Rotate toward uncovered candidates; a stable inventory prefix must not starve new models.
    candidates.sort_by_key(|candidate| {
        let key = super::routing::candidate_key(candidate);
        prior
            .iter()
            .filter(|run| {
                run.request
                    .configurations
                    .iter()
                    .any(|c| super::routing::candidate_key(c) == key)
            })
            .count()
    });
    candidates.truncate(maximum);
    candidates
}

pub async fn tick(service: &BenchmarkService) -> Result<()> {
    for mut schedule in service.store.schedules().await? {
        if !schedule.enabled || schedule.next_due_at > now() {
            continue;
        }
        let expected = serde_json::to_value(&schedule)?;
        let prefix = format!("schedule:{}:", schedule.id);
        let prior: Vec<_> = service
            .store
            .all_runs()
            .await?
            .into_iter()
            .filter(|run| run.request.request_key.starts_with(&prefix))
            .collect();
        schedule.generated_run_ids = prior.iter().map(|run| run.id.clone()).collect();
        let consumed: u32 = prior.iter().map(|run| run.request.max_executions).sum();
        if prior.len() >= schedule.max_runs as usize || consumed >= schedule.max_total_executions {
            schedule.enabled = false;
            schedule.paused_reason = Some("Campaign lifetime budget reached".into());
            update_if_current(service, &expected, &schedule).await?;
            continue;
        }
        if prior
            .iter()
            .any(|run| !matches!(run.state.as_str(), "completed" | "cancelled"))
        {
            schedule.next_due_at = now() + i64::from(schedule.interval_minutes) * 60000;
            schedule.paused_reason =
                Some("Previous campaign run still requires completion or attention".into());
            update_if_current(service, &expected, &schedule).await?;
            continue;
        }
        let mut busy = false;
        for configuration in &schedule.request.configurations {
            if !service
                .backend
                .activity(configuration)
                .await?
                .active_sessions
                .is_empty()
            {
                busy = true;
                break;
            }
        }
        if busy {
            schedule.next_due_at = now() + i64::from(schedule.interval_minutes) * 60000;
            schedule.paused_reason =
                Some("Deferred while interactive work uses the selected scope".into());
            update_if_current(service, &expected, &schedule).await?;
            continue;
        }
        let mut request = schedule.request.clone();
        let candidates = match &schedule.discovery {
            Some(rule) => match service
                .backend
                .inventory(&rule.provider_id, rule.account_id.as_deref(), true)
                .await
            {
                Ok(inventory) => {
                    service
                        .store
                        .record_inventory(&rule.provider_id, rule.account_id.as_deref(), &inventory)
                        .await?;
                    refresh_candidates(&schedule, &inventory)
                }
                Err(error) => {
                    schedule.enabled = false;
                    schedule.paused_reason = Some(error.message);
                    update_if_current(service, &expected, &schedule).await?;
                    continue;
                }
            },
            None => request.configurations.clone(),
        };
        // New unsupported candidates remain untested; only covered configurations
        // that owe at least one case they did not author enter a plan, so only
        // they take one of discovery's candidate slots.
        let mut manifests = Vec::new();
        for id in &request.version_ids {
            manifests.push(service.store.version(id).await?.manifest);
        }
        let eligible: Vec<Configuration> = candidates
            .into_iter()
            .filter(|configuration| {
                manifests.iter().all(|manifest| {
                    service
                        .backend
                        .unsupported(configuration, manifest)
                        .is_none()
                }) && manifests
                    .iter()
                    .any(|manifest| !super::routing::authored_by_candidate(manifest, configuration))
            })
            .collect();
        request.configurations = match &schedule.discovery {
            Some(rule) => choose_candidates(eligible, &prior, rule.max_candidates as usize),
            None => eligible,
        };
        request.request_key = format!("{prefix}{}", schedule.next_due_at);
        request.max_executions = request
            .max_executions
            .min(schedule.max_total_executions.saturating_sub(consumed));
        let preview = service.preview_run(&request).await?;
        if !preview.valid {
            schedule.enabled = false;
            schedule.paused_reason = Some(preview.issues.join("; "));
            update_if_current(service, &expected, &schedule).await?;
            continue;
        }
        request.max_executions = preview.execution_count;
        admit(service, &expected, &mut schedule, request).await?;
        service.changed().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_preserves_native_controls_and_never_inherits_a_score() {
        let (data, _) = super::super::analysis::tests::dataset();
        let mut schedule: Schedule = serde_json::from_value(serde_json::json!({"id":"campaign","name":"Pilot","enabled":false,"intervalMinutes":60,"nextDueAt":0,"request":data.runs[0].request,"missed":false,"discovery":{"providerId":"claude","accountId":"private-account","includeNewModels":true,"modelIds":[],"maxCandidates":2},"maxRuns":2,"maxTotalExecutions":20,"generatedRunIds":[],"pausedReason":null})).unwrap();
        let existing = schedule.request.configurations[0].clone();
        let mut new = existing.clone();
        new.id = "new".into();
        new.model_id = "new-model".into();
        new.effort = None;
        let inventory = vec![
            InventoryModel {
                configuration: existing.clone(),
                name: "Original".into(),
                efforts: vec!["medium".into()],
                supports_fast_mode: false,
                available: true,
                reason: None,
            },
            InventoryModel {
                configuration: new.clone(),
                name: "New".into(),
                efforts: vec![],
                supports_fast_mode: false,
                available: true,
                reason: None,
            },
        ];
        let discovered = refresh_candidates(&schedule, &inventory);
        assert_eq!(discovered.len(), 2);
        assert_eq!(discovered[0].effort, Some("medium".into()));
        assert_eq!(discovered[1], new);
        // A saved model whose id now names another model is re-pinned to the
        // new runtime under its new name.
        let mut moved = inventory.clone();
        moved[0].configuration.inventory_revision = Some("moved-runtime".into());
        moved[0].configuration.model_name = Some("Moved Model".into());
        let repinned = refresh_candidates(&schedule, &moved);
        assert_eq!(
            repinned[0].inventory_revision.as_deref(),
            Some("moved-runtime")
        );
        assert_eq!(repinned[0].model_name.as_deref(), Some("Moved Model"));
        assert_eq!(repinned[0].effort, Some("medium".into()));
        schedule.discovery.as_mut().unwrap().include_new_models = false;
        assert_eq!(refresh_candidates(&schedule, &inventory), vec![existing]);
        schedule.max_runs = 0;
        assert!(validate(&schedule).is_err());
        let mut newest = new.clone();
        newest.model_id = "third-new-model".into();
        let prior = data.runs;
        let selected = choose_candidates(
            vec![
                schedule.request.configurations[0].clone(),
                new.clone(),
                newest.clone(),
            ],
            &prior,
            2,
        );
        assert_eq!(selected, vec![new, newest]);
    }

    #[test]
    fn discovery_adds_available_models_or_only_the_named_ones() {
        let (data, _) = super::super::analysis::tests::dataset();
        let mut schedule: Schedule = serde_json::from_value(serde_json::json!({"id":"campaign","name":"Pilot","enabled":false,"intervalMinutes":60,"nextDueAt":0,"request":data.runs[0].request,"missed":false,"discovery":{"providerId":"claude","accountId":"private-account","includeNewModels":true,"modelIds":[],"maxCandidates":8},"maxRuns":2,"maxTotalExecutions":20,"generatedRunIds":[],"pausedReason":null})).unwrap();
        let saved = schedule.request.configurations[0].clone();
        let row = |id: &str, name: Option<&str>| {
            let mut configuration = saved.clone();
            configuration.id = id.into();
            configuration.model_id = id.into();
            configuration.effort = None;
            configuration.model_name = name.map(str::to_owned);
            InventoryModel {
                configuration,
                name: name.unwrap_or(id).into(),
                efforts: vec!["medium".into()],
                supports_fast_mode: false,
                available: true,
                reason: None,
            }
        };
        let inventory = vec![
            row(&saved.model_id, None),
            row("claude-fable-5-1[1m]", Some("Fable 5.1")),
            row("haiku", None),
            row("claude-fable-5[1m]", Some("Fable 5")),
            row("mystery", Some("Fable 6")),
        ];
        let models = |schedule: &Schedule| {
            refresh_candidates(schedule, &inventory)
                .into_iter()
                .map(|c| c.model_id)
                .collect::<Vec<_>>()
        };
        let discovered = models(&schedule);
        assert_eq!(discovered[0], saved.model_id);
        for model in [
            "claude-fable-5-1[1m]",
            "haiku",
            "claude-fable-5[1m]",
            "mystery",
        ] {
            assert!(
                discovered.iter().any(|id| id == model),
                "{model} missing from {discovered:?}"
            );
        }
        // A named list limits discovery to the models it names.
        schedule.discovery.as_mut().unwrap().model_ids = vec!["claude-fable-5[1m]".into()];
        assert_eq!(
            models(&schedule),
            [saved.model_id.as_str(), "claude-fable-5[1m]"]
        );
        // A model the saved plan already holds, at a level it lists, stays first.
        schedule.discovery.as_mut().unwrap().model_ids.clear();
        schedule.request.configurations[0] = inventory[1].configuration.clone();
        schedule.request.configurations[0].effort = Some("medium".into());
        let discovered = models(&schedule);
        assert_eq!(discovered[0], "claude-fable-5-1[1m]");
        assert!(discovered.iter().any(|id| id == &saved.model_id));
        assert!(discovered.iter().any(|id| id == "haiku"));
    }

    #[test]
    fn discovery_never_leaves_an_effort_to_the_cli() {
        let (data, _) = super::super::analysis::tests::dataset();
        let mut schedule: Schedule = serde_json::from_value(serde_json::json!({"id":"campaign","name":"Pilot","enabled":false,"intervalMinutes":60,"nextDueAt":0,"request":data.runs[0].request,"missed":false,"discovery":{"providerId":"claude","accountId":"private-account","includeNewModels":true,"modelIds":[],"maxCandidates":8},"maxRuns":2,"maxTotalExecutions":20,"generatedRunIds":[],"pausedReason":null})).unwrap();
        let saved = schedule.request.configurations[0].clone();
        let row = |id: &str, efforts: &[&str]| {
            let mut configuration = saved.clone();
            configuration.id = id.into();
            configuration.model_id = id.into();
            configuration.effort = None;
            InventoryModel {
                configuration,
                name: id.into(),
                efforts: efforts.iter().map(|&effort| effort.into()).collect(),
                supports_fast_mode: false,
                available: true,
                reason: None,
            }
        };
        let inventory = vec![
            row(&saved.model_id, &["low", "medium"]),
            row("opus", &["low", "max", "high", "ultra"]),
            row("gpt", &["minimal", "xhigh", "medium"]),
            row("custom", &["ultra", "turbo"]),
            row("delegating", &["ultra"]),
            row("haiku", &[]),
        ];
        let efforts = |schedule: &Schedule| {
            refresh_candidates(schedule, &inventory)
                .into_iter()
                .map(|c| (c.model_id, c.effort))
                .collect::<Vec<_>>()
        };
        // A new model starts at its highest listed level, never "ultra"; one
        // that lists only "ultra" stays out; a model without an effort
        // control runs unset.
        let level = |effort: &str| Some(effort.to_owned());
        assert_eq!(
            efforts(&schedule),
            [
                (saved.model_id.clone(), level("medium")),
                ("opus".into(), level("max")),
                ("gpt".into(), level("xhigh")),
                ("custom".into(), level("turbo")),
                ("haiku".into(), None),
            ]
        );
        // A saved configuration that leaves the effort unset on a model that
        // lists levels is no candidate.
        schedule.request.configurations[0].effort = None;
        assert_eq!(
            efforts(&schedule),
            [
                ("opus".into(), level("max")),
                ("gpt".into(), level("xhigh")),
                ("custom".into(), level("turbo")),
                ("haiku".into(), None),
            ]
        );
    }

    #[tokio::test]
    async fn a_campaign_plans_a_discovered_model_at_its_highest_level() {
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let backend = Arc::new(super::super::runner::FakeBackend::default());
        *backend.effort_levels.lock().unwrap() = vec!["low".into(), "high".into()];
        let service = BenchmarkService {
            store: super::super::store::Store::open(directory.path())
                .await
                .unwrap(),
            backend,
            wake: tokio::sync::Notify::new(),
            active: Default::default(),
            app: None,
        };
        let draft = super::super::runner::seed_definitions().remove(0);
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let inventory = service
            .backend
            .inventory("fake", Some("isolated"), false)
            .await
            .unwrap();
        let mut saved = inventory[0].configuration.clone();
        saved.effort = Some("low".into());
        let request = RunRequest {
            request_key: "template".into(),
            version_ids: vec![version.id],
            configurations: vec![saved],
            repetitions: 1,
            timeout_seconds: 10,
            max_executions: 2,
            preview: false,
            top_up: false,
        };
        let schedule:Schedule=serde_json::from_value(serde_json::json!({"id":"pilot","name":"Pilot","enabled":true,"intervalMinutes":60,"nextDueAt":0,"request":request,"missed":false,"discovery":{"providerId":"fake","accountId":"isolated","includeNewModels":true,"modelIds":[],"maxCandidates":2},"maxRuns":1,"maxTotalExecutions":2})).unwrap();
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        let saved = service.store.schedules().await.unwrap().remove(0);
        assert_eq!(saved.paused_reason, None);
        let runs = service.store.all_runs().await.unwrap();
        assert_eq!(runs.len(), 1);
        let mut planned: Vec<_> = runs[0]
            .request
            .configurations
            .iter()
            .map(|c| (c.model_id.as_str(), c.effort.as_deref()))
            .collect();
        planned.sort_unstable();
        assert_eq!(
            planned,
            [("fake-fail", Some("high")), ("fake-pass", Some("low"))]
        );
    }

    #[tokio::test]
    async fn discovery_never_plans_a_candidate_on_cases_it_wrote() {
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let service = BenchmarkService {
            store: super::super::store::Store::open(directory.path())
                .await
                .unwrap(),
            backend: Arc::new(super::super::runner::FakeBackend::default()),
            wake: tokio::sync::Notify::new(),
            active: Default::default(),
            app: None,
        };
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.environment["authoredBy"] = serde_json::json!(["fake-fail"]);
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let inventory = service
            .backend
            .inventory("fake", Some("isolated"), false)
            .await
            .unwrap();
        let request = RunRequest {
            request_key: "template".into(),
            version_ids: vec![version.id],
            configurations: vec![inventory[0].configuration.clone()],
            repetitions: 1,
            timeout_seconds: 10,
            max_executions: 2,
            preview: false,
            top_up: false,
        };
        let schedule:Schedule=serde_json::from_value(serde_json::json!({"id":"pilot","name":"Pilot","enabled":true,"intervalMinutes":60,"nextDueAt":0,"request":request,"missed":false,"discovery":{"providerId":"fake","accountId":"isolated","includeNewModels":true,"modelIds":[],"maxCandidates":2},"maxRuns":1,"maxTotalExecutions":2})).unwrap();
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        let runs = service.store.all_runs().await.unwrap();
        assert_eq!(
            runs.len(),
            1,
            "{:?}",
            service.store.schedules().await.unwrap()[0].paused_reason
        );
        let models: Vec<_> = runs[0]
            .request
            .configurations
            .iter()
            .map(|c| c.model_id.as_str())
            .collect();
        assert_eq!(models, ["fake-pass"]);
        assert_eq!(runs[0].attempts.len(), 1);
    }

    #[tokio::test]
    async fn a_candidate_that_owes_nothing_never_takes_a_discovery_slot() {
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let service = BenchmarkService {
            store: super::super::store::Store::open(directory.path())
                .await
                .unwrap(),
            backend: Arc::new(super::super::runner::FakeBackend::default()),
            wake: tokio::sync::Notify::new(),
            active: Default::default(),
            app: None,
        };
        // The saved candidate, first in inventory order, wrote the only case.
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.environment["authoredBy"] = serde_json::json!(["fake-pass"]);
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let inventory = service
            .backend
            .inventory("fake", Some("isolated"), false)
            .await
            .unwrap();
        let request = RunRequest {
            request_key: "template".into(),
            version_ids: vec![version.id],
            configurations: vec![inventory[0].configuration.clone()],
            repetitions: 1,
            timeout_seconds: 10,
            max_executions: 2,
            preview: false,
            top_up: false,
        };
        let schedule:Schedule=serde_json::from_value(serde_json::json!({"id":"pilot","name":"Pilot","enabled":true,"intervalMinutes":60,"nextDueAt":0,"request":request,"missed":false,"discovery":{"providerId":"fake","accountId":"isolated","includeNewModels":true,"modelIds":[],"maxCandidates":1},"maxRuns":2,"maxTotalExecutions":4})).unwrap();
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        let saved = service.store.schedules().await.unwrap().remove(0);
        assert!(saved.enabled, "{:?}", saved.paused_reason);
        assert_eq!(saved.paused_reason, None);
        let runs = service.store.all_runs().await.unwrap();
        assert_eq!(runs.len(), 1);
        let models: Vec<_> = runs[0]
            .request
            .configurations
            .iter()
            .map(|c| c.model_id.as_str())
            .collect();
        assert_eq!(models, ["fake-fail"]);
    }

    #[tokio::test]
    async fn disabled_campaign_is_quiet_and_discovery_respects_lifetime_budget() {
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let service = BenchmarkService {
            store: super::super::store::Store::open(directory.path())
                .await
                .unwrap(),
            backend: Arc::new(super::super::runner::FakeBackend::default()),
            wake: tokio::sync::Notify::new(),
            active: Default::default(),
            app: None,
        };
        let definition = service
            .store
            .save_draft(
                None,
                None,
                super::super::runner::seed_definitions().remove(0),
            )
            .await
            .unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let inventory = service
            .backend
            .inventory("fake", Some("isolated"), false)
            .await
            .unwrap();
        let request = RunRequest {
            request_key: "template".into(),
            version_ids: vec![version.id],
            configurations: vec![inventory[0].configuration.clone()],
            repetitions: 1,
            timeout_seconds: 10,
            max_executions: 2,
            preview: false,
            top_up: false,
        };
        let mut schedule:Schedule=serde_json::from_value(serde_json::json!({"id":"pilot","name":"Pilot","enabled":false,"intervalMinutes":60,"nextDueAt":0,"request":request,"missed":false,"discovery":{"providerId":"fake","accountId":"isolated","includeNewModels":true,"modelIds":[],"maxCandidates":2},"maxRuns":1,"maxTotalExecutions":2})).unwrap();
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        assert!(service.store.all_runs().await.unwrap().is_empty());
        // Disabling while discovery is in flight invalidates its admission snapshot.
        let mut in_flight = schedule.clone();
        in_flight.enabled = true;
        service.store.save_schedule(&in_flight).await.unwrap();
        let expected = serde_json::to_value(&in_flight).unwrap();
        save_user_edit(&service, &mut schedule).await.unwrap();
        let stale_request = in_flight.request.clone();
        assert!(!admit(&service, &expected, &mut in_flight, stale_request)
            .await
            .unwrap());
        assert!(!service.store.schedules().await.unwrap()[0].enabled);
        assert!(service.store.all_runs().await.unwrap().is_empty());
        schedule.enabled = true;
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        let runs = service.store.all_runs().await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].request.configurations.len(), 2);
        assert_eq!(runs[0].attempts.len(), 2);
        service
            .store
            .set_run_state(&runs[0].id, "completed")
            .await
            .unwrap();
        // A renderer cannot erase the server-derived lifetime budget by clearing this display field.
        schedule.next_due_at = 0;
        schedule.generated_run_ids.clear();
        service.store.save_schedule(&schedule).await.unwrap();
        tick(&service).await.unwrap();
        assert_eq!(service.store.all_runs().await.unwrap().len(), 1);
        let saved = service.store.schedules().await.unwrap().remove(0);
        assert!(!saved.enabled);
        assert!(saved.paused_reason.unwrap().contains("budget"));
    }
}
