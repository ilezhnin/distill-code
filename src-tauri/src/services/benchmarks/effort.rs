//! Measurements whose reasoning effort nobody can name.
//!
//! "default" is not an effort level. A request that leaves the effort to the
//! CLI runs at whatever level the CLI picks that day, and the bridge
//! acknowledges only the word "default", so the measurement cannot say which
//! effort it measured. Such attempts stay in the store and in the views that
//! audit a run (run detail, attempt lists, the raw run listing); no analysis
//! counts them. A model without an effort control is another case: its
//! request and its acknowledgment both leave the effort unset, and its
//! measurement is fully specified.
use super::analysis::configuration_key;
use super::types::*;
use std::collections::BTreeSet;

/// The word a bridge acknowledges when a request left the effort to its CLI.
pub const CLI_DEFAULT_EFFORT: &str = "default";

/// Whether `effort` is the CLI's "default" rather than a level.
pub fn names_cli_default(effort: Option<&str>) -> bool {
    effort == Some(CLI_DEFAULT_EFFORT)
}

/// The order a run starts a model's effort at, highest first, as the run
/// dialog orders it. "ultra" hands work to subagents and is never chosen.
const PRESELECTION_ORDER: [&str; 6] = ["max", "xhigh", "high", "medium", "low", "minimal"];

/// Whether `requested` leaves the effort to the CLI on `model`, a model that
/// lists levels: the bridge then acknowledges "default", and the attempts
/// count nowhere. A model without an effort control runs unset.
pub fn left_to_the_cli(requested: &Configuration, model: &InventoryModel) -> bool {
    requested.effort.is_none() && !model.efforts.is_empty()
}

/// The level a model is pinned at when nobody chose one: its highest listed
/// level, else the first it lists other than "ultra", else none.
pub fn preselected(efforts: &[String]) -> Option<&str> {
    let levels = || {
        efforts
            .iter()
            .map(String::as_str)
            .filter(|effort| !names_cli_default(Some(effort)))
    };
    PRESELECTION_ORDER
        .into_iter()
        .find(|level| levels().any(|effort| effort == *level))
        .or_else(|| levels().find(|effort| *effort != "ultra"))
}

/// Requests, by run and requested configuration, that the bridge acknowledged
/// at the CLI's "default" effort.
#[derive(Debug, Default)]
pub struct DefaultedRequests(BTreeSet<(String, String)>);

impl DefaultedRequests {
    /// The requests among `attempts` with an attempt acknowledged at "default".
    pub fn of<'a>(attempts: impl IntoIterator<Item = &'a Attempt>) -> Self {
        let mut requests = Self::default();
        for attempt in attempts {
            if attempt
                .observed
                .as_ref()
                .is_some_and(|observed| names_cli_default(observed.effort.as_deref()))
            {
                requests.add(&attempt.run_id, &attempt.configuration);
            }
        }
        requests
    }

    /// Records that `run_id`'s request `requested` was acknowledged at "default".
    pub fn add(&mut self, run_id: &str, requested: &Configuration) {
        self.0
            .insert((run_id.to_owned(), configuration_key(requested)));
    }

    fn contains(&self, run_id: &str, requested: &Configuration) -> bool {
        self.0
            .contains(&(run_id.to_owned(), configuration_key(requested)))
    }
}

/// Whether a request names no effort level: it asked for "default", or it
/// left the effort unset and its run's attempts were acknowledged at "default".
fn request_unknown(run_id: &str, requested: &Configuration, defaulted: &DefaultedRequests) -> bool {
    match requested.effort.as_deref() {
        Some(effort) => names_cli_default(Some(effort)),
        None => defaulted.contains(run_id, requested),
    }
}

/// Whether nobody can tell which reasoning effort `attempt` measured: its
/// configuration asked for the CLI's "default", or the bridge acknowledged
/// "default" (`attempt.observed`). An attempt without an acknowledgment, not
/// yet started or refused before a session existed, is judged by its
/// configuration; where that left the effort unset, it lands where its run's
/// acknowledged attempts of the same request landed, as the ledger files it.
/// A model without an effort control (requested and acknowledged effort both
/// unset) is fully specified.
pub fn effort_unknown(attempt: &Attempt, defaulted: &DefaultedRequests) -> bool {
    if names_cli_default(attempt.configuration.effort.as_deref()) {
        return true;
    }
    match &attempt.observed {
        Some(observed) => names_cli_default(observed.effort.as_deref()),
        None => request_unknown(&attempt.run_id, &attempt.configuration, defaulted),
    }
}

/// Analysis data without the attempts whose effort is unknown, and without
/// the requests that measured nothing else. A configuration whose attempts are
/// all excluded therefore leaves every board; runs, cases and the judges'
/// evaluations of the remaining attempts are kept. Nothing is deleted from the
/// store.
pub fn with_known_effort(mut data: QueryData) -> QueryData {
    let defaulted = DefaultedRequests::of(&data.attempts);
    data.attempts
        .retain(|attempt| !effort_unknown(attempt, &defaulted));
    for run in &mut data.runs {
        run.attempts
            .retain(|attempt| !effort_unknown(attempt, &defaulted));
        let id = run.id.clone();
        run.request
            .configurations
            .retain(|requested| !request_unknown(&id, requested, &defaulted));
    }
    data
}

#[cfg(test)]
mod tests {
    use super::super::analysis::{self, tests::dataset};
    use super::super::export;
    use super::*;

    fn configuration(model: &str, effort: Option<&str>) -> Configuration {
        Configuration {
            id: format!("claude-acp:account:{model}:{}", effort.unwrap_or("")),
            provider_id: "claude-acp".into(),
            account_id: Some("account".into()),
            model_id: model.into(),
            effort: effort.map(Into::into),
            fast_mode: Some(false),
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("runtime".into()),
            model_name: None,
        }
    }

    /// One attempt of `requested` in `run`: acknowledged at the effort in
    /// `observed` (and passed), or, for `None`, never acknowledged.
    fn attempt(run: &str, requested: &Configuration, observed: Option<Option<&str>>) -> Attempt {
        let data = dataset();
        let mut attempt = data.attempts[0].clone();
        attempt.id = format!("{run}-{}", requested.model_id);
        attempt.run_id = run.into();
        attempt.configuration = requested.clone();
        match observed {
            Some(effort) => {
                let mut acknowledged = requested.clone();
                acknowledged.effort = effort.map(Into::into);
                attempt.observed = Some(acknowledged);
            }
            None => {
                attempt.observed = None;
                attempt.phase = "pending".into();
                attempt.outcome = None;
                attempt.session_id = None;
                attempt.started_at = None;
                attempt.finished_at = None;
            }
        }
        attempt
    }

    /// A completed run of `requested` over every case of `data`, where
    /// `acknowledged[i]` is what case `i`'s attempt was acknowledged at.
    fn add_run(
        data: &mut QueryData,
        id: &str,
        created_at: i64,
        requested: &Configuration,
        acknowledged: &[Option<Option<&str>>],
    ) {
        let mut request = data.runs[0].request.clone();
        request.request_key = id.into();
        request.configurations = vec![requested.clone()];
        data.runs.push(BenchmarkRun {
            id: id.into(),
            state: "completed".into(),
            revision: 1,
            created_at,
            updated_at: created_at + 1,
            baked_at: None,
            request,
            attempts: Vec::new(),
        });
        let versions: Vec<String> = data.versions.iter().map(|v| v.id.clone()).collect();
        for (version, observed) in versions.iter().zip(acknowledged) {
            let mut attempt = attempt(id, requested, *observed);
            attempt.id = format!("{id}-{version}");
            attempt.version_id = version.clone();
            data.attempts.push(attempt);
        }
    }

    #[test]
    fn a_model_starts_at_its_highest_level_and_never_at_ultra() {
        let preselect = |efforts: &[&str]| {
            let efforts: Vec<String> = efforts.iter().map(|&e| e.into()).collect();
            preselected(&efforts).map(str::to_owned)
        };
        assert_eq!(preselect(&["low", "high", "max"]).as_deref(), Some("max"));
        assert_eq!(
            preselect(&["ultra", "xhigh", "high"]).as_deref(),
            Some("xhigh")
        );
        assert_eq!(preselect(&["minimal", "medium"]).as_deref(), Some("medium"));
        assert_eq!(
            preselect(&["default", "ultra", "turbo"]).as_deref(),
            Some("turbo")
        );
        assert_eq!(preselect(&["ultra"]), None);
        assert_eq!(preselect(&["default"]), None);
        assert_eq!(preselect(&[]), None);
    }

    #[test]
    fn only_a_model_that_lists_levels_refuses_an_unset_effort() {
        let model = |efforts: &[&str]| InventoryModel {
            configuration: configuration("sonnet", None),
            name: "Sonnet".into(),
            efforts: efforts.iter().map(|&e| e.into()).collect(),
            supports_fast_mode: false,
            available: true,
            reason: None,
        };
        assert!(left_to_the_cli(
            &configuration("sonnet", None),
            &model(&["high"])
        ));
        assert!(!left_to_the_cli(
            &configuration("sonnet", Some("high")),
            &model(&["high"])
        ));
        assert!(!left_to_the_cli(&configuration("haiku", None), &model(&[])));
    }

    #[test]
    fn only_the_cli_default_makes_an_effort_unknown() {
        let none = DefaultedRequests::default();
        let unknown = |requested: Option<&str>, observed: Option<Option<&str>>| {
            effort_unknown(
                &attempt("run", &configuration("sonnet", requested), observed),
                &none,
            )
        };
        // Asked for the CLI's default, acknowledged or not yet started.
        assert!(unknown(Some("default"), Some(Some("default"))));
        assert!(unknown(Some("default"), None));
        // Left unset and acknowledged at the CLI's default.
        assert!(unknown(None, Some(Some("default"))));
        // An explicit level, acknowledged or not yet started.
        assert!(!unknown(Some("max"), Some(Some("max"))));
        assert!(!unknown(Some("max"), None));
        // A model without an effort control: unset and acknowledged unset.
        assert!(!unknown(None, Some(None)));
        assert!(!unknown(None, None));
        // An unacknowledged attempt of a request its run acknowledged at the
        // CLI's default lands there too; the same request elsewhere does not.
        let opus = configuration("opus", None);
        let defaulted = DefaultedRequests::of([&attempt("pilot", &opus, Some(Some("default")))]);
        assert!(effort_unknown(&attempt("pilot", &opus, None), &defaulted));
        assert!(!effort_unknown(&attempt("other", &opus, None), &defaulted));
        assert!(!effort_unknown(
            &attempt("pilot", &configuration("haiku", None), None),
            &defaulted
        ));
    }

    /// The dataset's explicit row, a Sonnet run that asked for the CLI's
    /// default, an Opus pilot that left the effort unset (one case
    /// acknowledged at the default, one refused before a session existed,
    /// the rest never started) and a Haiku run without an effort control.
    fn ledger() -> (QueryData, Configuration, Configuration, Configuration) {
        let mut data = dataset();
        let sonnet = configuration("sonnet", Some("default"));
        let opus = configuration("opus", None);
        let haiku = configuration("haiku", None);
        add_run(
            &mut data,
            "cli-default",
            10,
            &sonnet,
            &[Some(Some("default")); 6],
        );
        add_run(
            &mut data,
            "pilot",
            11,
            &opus,
            &[Some(Some("default")), None, None, None, None, None],
        );
        let refused = data
            .attempts
            .iter_mut()
            .find(|a| a.id == "pilot-v1")
            .unwrap();
        refused.phase = "terminal".into();
        refused.outcome = Some("selection_changed".into());
        add_run(&mut data, "haiku", 12, &haiku, &[Some(None); 6]);
        // A judge that ran at the CLI's default is no candidate: its vote on a
        // remaining attempt stands.
        let judged = data
            .attempts
            .iter_mut()
            .find(|a| a.id == "haiku-v0")
            .unwrap();
        judged.evaluations.push(
            serde_json::from_value(serde_json::json!({"id":"vote","evaluatorRevision":"1",
                "verdict":"pass","score":1.0,"reason":"ok","createdAt":3,"provenance":"judge",
                "artifacts":[],"judge":configuration("sonnet", Some("default"))}))
            .unwrap(),
        );
        (data, sonnet, opus, haiku)
    }

    #[test]
    fn analysis_leaves_out_every_attempt_of_an_unknown_effort_and_keeps_the_rest() {
        let (data, sonnet, opus, haiku) = ledger();
        let total = data.attempts.len();
        let data = with_known_effort(data);
        // The twelve Sonnet and Opus attempts leave the analysis data.
        assert_eq!(data.attempts.len(), total - 12);
        assert!(data
            .attempts
            .iter()
            .all(|a| !["sonnet", "opus"].contains(&a.configuration.model_id.as_str())));
        // Runs stay; only the requests that measured nothing else leave them.
        assert_eq!(data.runs.len(), 5);
        let requests = |id: &str| {
            data.runs
                .iter()
                .find(|run| run.id == id)
                .unwrap()
                .request
                .configurations
                .len()
        };
        assert_eq!(requests("cli-default"), 0);
        assert_eq!(requests("pilot"), 0);
        assert_eq!(requests("haiku"), 1);
        assert_eq!(requests("after"), 1);
        let judged = data.attempts.iter().find(|a| a.id == "haiku-v0").unwrap();
        assert_eq!(judged.evaluations.len(), 1);

        // Boards: the two configurations whose attempts all left disappear.
        let report = analysis::leaderboard(&data, &ResultQuery::default());
        let mut models: Vec<&str> = report
            .rows
            .iter()
            .map(|row| row.configuration.model_id.as_str())
            .collect();
        models.sort_unstable();
        assert_eq!(models, ["haiku", "model"]);
        assert!(!report
            .cohort
            .unwrap()
            .run_ids
            .iter()
            .any(|id| id == "cli-default" || id == "pilot"));
        // History.
        assert!(analysis::history(&data, &sonnet).is_empty());
        assert!(analysis::history(&data, &opus).is_empty());
        assert!(!analysis::history(&data, &haiku).is_empty());
        // Exports: the outcome archive and the current-pool ledger.
        let rows = export::rows(&data, false, "salt").unwrap();
        assert!(!rows
            .iter()
            .any(|row| row["runId"] == "cli-default" || row["runId"] == "pilot"));
        assert!(rows.iter().any(|row| row["runId"] == "haiku"));
        let ledger = export::ledger_rows(&data, false, "salt").unwrap();
        let mut candidates: Vec<&str> = ledger[0]["matrix"]
            .as_array()
            .unwrap()
            .iter()
            .map(|cell| cell["configuration"]["modelId"].as_str().unwrap())
            .collect();
        candidates.sort_unstable();
        assert_eq!(candidates, ["haiku", "model"]);
    }
}
