//! Which configuration a measurement belongs to: keys, the selection a provider acknowledged, and the row it counts on.
use super::*;

pub(crate) fn configuration_key(configuration: &Configuration) -> String {
    // IDs are UI labels, not evidence of equivalent execution conditions.
    serde_json::to_string(&(
        &configuration.provider_id,
        &configuration.account_id,
        &configuration.model_id,
        &configuration.effort,
        configuration.fast_mode,
        &configuration.billing_mode,
        &configuration.execution_profile,
        &configuration.inventory_revision,
    ))
    .unwrap_or_default()
}

/// The runner marks a single attempt that made auxiliary model calls with an
/// `_auxiliary` profile. That is attempt evidence, not a separate candidate.
pub(super) fn ledger_profile(profile: &str) -> &str {
    profile.strip_suffix("_auxiliary").unwrap_or(profile)
}

pub(in crate::services::benchmarks) fn has_auxiliary_usage(attempt: &Attempt) -> bool {
    attempt.usage.schema.contains("auxiliary")
        || execution_configuration(attempt)
            .execution_profile
            .ends_with("_auxiliary")
}

/// Runtime probes, omitted defaults and auxiliary-call markers do not create
/// new leaderboard candidates. A model id its vendor moves to another model
/// (`NativeProvider::moving_aliases`) is a candidate per display name, so
/// Kimi's `kimi-for-coding` as K2.7 Code and as K2.8 Preview are two rows;
/// every other key is unchanged by that.
/// A board row's identity: what is measured, not where it ran. The account is
/// a quota pool; a run that goes on on another account of the provider when
/// one runs out stays one row, and every attempt keeps its own account.
pub(in crate::services::benchmarks) fn leaderboard_key(configuration: &Configuration) -> String {
    let identity = (
        &configuration.provider_id,
        &configuration.model_id,
        configuration
            .effort
            .as_deref()
            .filter(|effort| !effort.is_empty())
            .unwrap_or("default"),
        configuration.fast_mode.unwrap_or(false),
        &configuration.billing_mode,
        ledger_profile(&configuration.execution_profile),
    );
    if on_moving_alias(configuration) {
        serde_json::to_string(&(identity, &configuration.model_name))
    } else {
        serde_json::to_string(&identity)
    }
    .unwrap_or_default()
}

/// A model row's identity: provider, model, effort and fast mode, the settings
/// a selection chooses. Account, billing, execution profile and runtime never
/// split it.
pub(super) fn model_key(configuration: &Configuration) -> String {
    let mut identity = vec![
        serde_json::json!(configuration.provider_id),
        serde_json::json!(configuration.model_id),
        serde_json::json!(configuration
            .effort
            .as_deref()
            .filter(|effort| !effort.is_empty())
            .unwrap_or("default")),
        serde_json::json!(configuration.fast_mode.unwrap_or(false)),
    ];
    if on_moving_alias(configuration) {
        identity.push(serde_json::json!(configuration.model_name));
    }
    serde_json::to_string(&identity).unwrap_or_default()
}

/// Whether a configuration is on a model id its vendor moves between models.
pub(super) fn on_moving_alias(configuration: &Configuration) -> bool {
    crate::services::agent_host::execution::NativeProvider::for_harness(&configuration.provider_id)
        .is_some_and(|provider| {
            provider
                .moving_aliases()
                .contains(&configuration.model_id.as_str())
        })
}

/// Whether an acknowledged selection is the one asked for: the same model,
/// and the requested effort and fast mode wherever the request set them.
pub(crate) fn matches_selection(requested: &Configuration, observed: &Configuration) -> bool {
    requested.model_id == observed.model_id
        && requested
            .effort
            .as_ref()
            .is_none_or(|e| Some(e) == observed.effort.as_ref())
        && fast_mode_acknowledged(requested.fast_mode, observed.fast_mode)
}

/// Whether an acknowledged fast mode is the one asked for, where the request
/// set one. A session that acknowledges none runs a model without fast mode,
/// so it is off: it matches a request for off, never one for on (10-18:
/// Claude sessions acknowledge none for every model but Opus, so frozen
/// Sonnet judge seats pinned to off abstained every time).
pub(crate) fn fast_mode_acknowledged(requested: Option<bool>, observed: Option<bool>) -> bool {
    crate::services::agent_host::execution::fast_mode_acknowledged(requested, observed)
}

/// The refusal every unacknowledged selection starts with; what follows the
/// colon says which part, and what the provider said or did instead.
pub(crate) const SELECTION_REFUSED: &str =
    "Provider did not acknowledge the exact model, effort and fast mode";

/// Why a session is not the selection asked for, in words the operator can
/// act on. The bridge's own refusal comes first where it gave one
/// (`substitutions`, as the host records them: role, requested, applied,
/// reason — "codex-acp would not run gpt-6-luna: Invalid params"); otherwise
/// the field that came back different. A bare "did not acknowledge" left the
/// operator guessing whether the model was gone, renamed or merely refused.
pub(crate) fn selection_refusal(
    requested: &Configuration,
    observed: &Configuration,
    substitutions: &[serde_json::Value],
) -> String {
    let text = |value: &serde_json::Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let mut details: Vec<String> = substitutions
        .iter()
        .map(|substitution| {
            let role = text(&substitution["role"]).unwrap_or_else(|| "selection".into());
            let asked = text(&substitution["requested"]).unwrap_or_else(|| "?".into());
            let mut detail = format!("the {role} {asked} was refused");
            if let Some(reason) = text(&substitution["reason"]) {
                detail.push_str(&format!(" ({reason})"));
            }
            match text(&substitution["applied"]) {
                Some(applied) => detail.push_str(&format!("; {applied} would have run instead")),
                None => detail.push_str("; nothing would have run in its place"),
            }
            detail
        })
        .collect();
    if details.is_empty() {
        let none = || "none".to_string();
        if requested.model_id != observed.model_id {
            let acknowledged = Some(observed.model_id.clone())
                .filter(|model| !model.is_empty())
                .unwrap_or_else(none);
            details.push(format!(
                "asked for model {}, the provider acknowledged {acknowledged}",
                requested.model_id
            ));
        }
        if let Some(effort) = &requested.effort {
            if Some(effort) != observed.effort.as_ref() {
                details.push(format!(
                    "asked for effort {effort}, acknowledged {}",
                    observed.effort.clone().unwrap_or_else(none)
                ));
            }
        }
        if !fast_mode_acknowledged(requested.fast_mode, observed.fast_mode) {
            let state = |fast: Option<bool>| match fast {
                Some(true) => "on".to_string(),
                Some(false) => "off".to_string(),
                None => none(),
            };
            details.push(format!(
                "asked for fast mode {}, acknowledged {}",
                state(requested.fast_mode),
                state(observed.fast_mode)
            ));
        }
    }
    if details.is_empty() {
        return SELECTION_REFUSED.to_string();
    }
    format!("{SELECTION_REFUSED}: {}", details.join("; "))
}

/// The acknowledged configuration on the profile its run planned. A provider
/// acknowledges a model, an effort and a mode; the profile is the run's, by
/// case. Until 11-16 a workflow root whose step made auxiliary calls was
/// marked `native_text_auxiliary` whatever its profile, so a repository
/// case's repetitions with such calls read as text ones, apart from the rest
/// of their cell, and the case never completed. Read, never rewritten: an
/// auxiliary marker of another profile keeps the planned one.
pub(super) fn on_planned_profile<'a>(
    requested: &Configuration,
    observed: &'a Configuration,
) -> Cow<'a, Configuration> {
    if !observed.execution_profile.ends_with("_auxiliary")
        || ledger_profile(&observed.execution_profile)
            == ledger_profile(&requested.execution_profile)
    {
        return Cow::Borrowed(observed);
    }
    let mut planned = observed.clone();
    planned
        .execution_profile
        .clone_from(&requested.execution_profile);
    Cow::Owned(planned)
}

/// What ran. A refused selection (another model, effort or fast mode) stays
/// with the candidate that was asked for; where that request left effort or
/// fast mode to the provider, the requested model's acknowledged value fills it.
pub(crate) fn execution_configuration(attempt: &Attempt) -> Cow<'_, Configuration> {
    let requested = &attempt.configuration;
    let Some(observed) = attempt
        .observed
        .as_ref()
        .filter(|observed| observed.model_id == requested.model_id)
    else {
        return Cow::Borrowed(requested);
    };
    if attempt.outcome.as_deref() != Some("selection_changed")
        || matches_selection(requested, observed)
    {
        return on_planned_profile(requested, observed);
    }
    let mut asked = requested.clone();
    if asked.effort.is_none() {
        asked.effort = observed.effort.clone();
    }
    if asked.fast_mode.is_none() {
        asked.fast_mode = observed.fast_mode;
    }
    Cow::Owned(asked)
}

/// Each run's newest attempt that acknowledged its requested model, by run and
/// requested configuration, for requests that left effort or fast mode to the
/// provider.
pub(super) type Acknowledgments<'a> = BTreeMap<(&'a str, String), &'a Attempt>;

pub(super) fn run_acknowledgments(attempts: &[Attempt]) -> Acknowledgments<'_> {
    let mut acknowledged: Acknowledgments<'_> = BTreeMap::new();
    for attempt in attempts.iter().filter(|a| {
        (a.configuration.effort.is_none() || a.configuration.fast_mode.is_none())
            && a.observed
                .as_ref()
                .is_some_and(|observed| observed.model_id == a.configuration.model_id)
    }) {
        let newest = acknowledged
            .entry((
                attempt.run_id.as_str(),
                configuration_key(&attempt.configuration),
            ))
            .or_insert(attempt);
        if (attempt.started_at, &attempt.id) > (newest.started_at, &newest.id) {
            *newest = attempt;
        }
    }
    acknowledged
}

/// What ran, as the ledger counts it. An attempt with no acknowledgment of
/// its requested model (refused before a session existed, or still waiting)
/// fills the effort and fast mode its request left to the provider from what
/// the same request acknowledged in its run, so it stays on that row.
pub(super) fn ledger_configuration<'a>(
    attempt: &'a Attempt,
    acknowledged: &Acknowledgments<'_>,
) -> Cow<'a, Configuration> {
    let configuration = execution_configuration(attempt);
    let requested = &attempt.configuration;
    if (requested.effort.is_some() && requested.fast_mode.is_some())
        || attempt
            .observed
            .as_ref()
            .is_some_and(|observed| observed.model_id == requested.model_id)
    {
        return configuration;
    }
    let Some(sibling) = acknowledged.get(&(attempt.run_id.as_str(), configuration_key(requested)))
    else {
        return configuration;
    };
    let seen = execution_configuration(sibling);
    let mut filled = configuration.into_owned();
    if filled.effort.is_none() {
        filled.effort = seen.effort.clone();
    }
    if filled.fast_mode.is_none() {
        filled.fast_mode = seen.fast_mode;
    }
    Cow::Owned(filled)
}
