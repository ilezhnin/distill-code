//! Who may sit on a panel: labs, accounts, headroom, frozen seats.
use super::*;

/// Whether an entry of `pool` names `model` of `provider` on `account`: the
/// rows a panel can seat. An account's listing also carries rows no entry
/// names (a lane's alias, a release nobody calibrated), and what the runtime
/// says of those says nothing about a panel.
pub(in super::super) fn pool_names(
    pool: &[crate::services::benchmarks::judge_pool::Entry],
    provider: &str,
    account: Option<&str>,
    model: &str,
) -> bool {
    pool.iter().any(|entry| {
        entry.provider_id == provider
            && entry.sits_on(account)
            && concrete_model(&entry.provider_id, &entry.model_id).is_some_and(|eligible| {
                concrete_model(&entry.provider_id, model).as_deref() == Some(eligible.as_str())
            })
    })
}

/// The accounts a judge may sit on: every enabled stored account of a
/// provider `admit` takes, and the CLI sign-in Grok and Kimi keep for
/// themselves (`cli-login-<provider>`), which no store lists but candidates
/// already run on through the inventory.
pub(crate) fn judge_accounts(
    stored: &[crate::services::provider_accounts::ProviderAccount],
    admit: impl Fn(&str) -> bool,
    cli_login: impl Fn(&str) -> Option<crate::services::provider_accounts::ProviderAccount>,
) -> Vec<crate::services::provider_accounts::ProviderAccount> {
    let mut accounts: Vec<_> = stored
        .iter()
        .filter(|account| account.enabled && admit(&account.provider_id))
        .cloned()
        .collect();
    for native in NativeProvider::ALL {
        let provider = native.harness_id();
        let Some(identity) = admit(provider).then(|| cli_login(provider)).flatten() else {
            continue;
        };
        if !accounts.iter().any(|account| account.id == identity.id) {
            accounts.push(identity);
        }
    }
    accounts
}

/// The offered judges with the most usage headroom first (percent left on
/// their account, unknown last), so a seat goes to the eligible account that
/// can spare it most rather than always to the first account listed.
pub(crate) fn by_headroom(mut offered: Vec<(Option<f64>, Configuration)>) -> Vec<Configuration> {
    offered.sort_by(|(a, _), (b, _)| {
        b.unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a.unwrap_or(f64::NEG_INFINITY))
    });
    offered
        .into_iter()
        .map(|(_, configuration)| configuration)
        .collect()
}

/// The ordinary panel for a rendering from the judge pool's offered rows,
/// each with its account's headroom: one calibrated judge per lab (vendor),
/// the roomiest first, up to three (owner, 10-18, after BuseyBench's fixed
/// three-lab ensemble). A judge of a candidate's own lab or model may sit:
/// the other labs dilute its score, and [`same_vendor`] and [`own_model`]
/// mark the panel. An exact author of the case never sits (see
/// [`frozen_seats`]); an author's lab with no other calibrated judge leaves
/// the panel to the other labs. With fewer than three labs offered, distinct
/// calibrated models of the seated labs fill it to three when available.
/// A rubric with only two eligible models can still use both. A candidate of no
/// known vendor admits no judge.
pub(crate) fn ordinary_judges(
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    offered: Vec<(Option<f64>, Configuration)>,
) -> Vec<Configuration> {
    if candidate_vendors(candidates).is_none() {
        return Vec::new();
    }
    let admitted: Vec<(Configuration, &'static str)> = seatable(draft, by_headroom(offered), &[])
        .into_iter()
        .filter_map(|(judge, _)| {
            let vendor = crate::services::benchmarks::judge_pool::vendor(&judge.provider_id)?;
            Some((judge, vendor))
        })
        .collect();
    let mut labs = std::collections::BTreeSet::new();
    let mut panel: Vec<Configuration> = Vec::new();
    for (judge, vendor) in &admitted {
        if panel.len() < MAX_JUDGES && labs.insert(*vendor) {
            panel.push(judge.clone());
        }
    }
    for (judge, _) in &admitted {
        if panel.len() < MAX_JUDGES && !panel.iter().any(|seated| seated.id == judge.id) {
            panel.push(judge.clone());
        }
    }
    panel
}

/// The vendors of the candidates, or none when one is unknown.
pub(in super::super) fn candidate_vendors(
    candidates: &[&Configuration],
) -> Option<std::collections::BTreeSet<&'static str>> {
    candidates
        .iter()
        .map(|candidate| crate::services::benchmarks::judge_pool::vendor(&candidate.provider_id))
        .collect()
}

/// Whether a judge is the concrete model of one of the case's exact authors
/// at another effort. The exact author never judges (the 10-14 rule), but
/// the same model at another effort may, and its panel is marked.
pub(crate) fn author_model_judges(draft: &BenchmarkDraft, panel: &[Configuration]) -> bool {
    let authors = crate::services::benchmarks::routing::exact_authors(draft);
    panel.iter().any(|judge| {
        authors.iter().any(|author| {
            let at_its_effort = BenchmarkAuthor {
                provider_id: author.provider_id.clone(),
                model_id: author.model_id.clone(),
                effort: judge.effort.clone(),
            };
            crate::services::benchmarks::routing::is_author(&at_its_effort, judge)
        })
    })
}

/// Whether a panel seats a candidate's own model on the same provider
/// (aliases and context window variants resolved), which an ordinary panel
/// may: the board can leave such scores out.
pub(crate) fn own_model(candidates: &[&Configuration], panel: &[Configuration]) -> bool {
    panel.iter().any(|judge| {
        let model = model_identity(&judge.provider_id, &judge.model_id);
        candidates.iter().any(|candidate| {
            candidate.provider_id == judge.provider_id
                && model.is_some()
                && model_identity(&candidate.provider_id, &candidate.model_id) == model
        })
    })
}

/// Whether an ordinary panel seats a judge of a candidate's vendor (lab),
/// which a three-lab panel does for every candidate of those labs.
pub(crate) fn same_vendor(candidates: &[&Configuration], panel: &[Configuration]) -> bool {
    candidate_vendors(candidates).is_some_and(|vendors| {
        panel.iter().any(|judge| {
            crate::services::benchmarks::judge_pool::vendor(&judge.provider_id)
                .is_some_and(|vendor| vendors.contains(vendor))
        })
    })
}

/// The seats of a frozen panel that judge the candidates' rendering, the
/// check of its seats: never an exact author of the case (the 10-14 rule),
/// one seat per model of a provider. A candidate's own model keeps its seat,
/// since a frozen panel never changes its seats: the other seats dilute its
/// score and the evaluation is marked (see [`own_model`]), as on an ordinary
/// panel (owner, 10-18). An unresolved candidate alias admits no judge.
pub(crate) fn frozen_seats(
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    seats: Vec<Configuration>,
) -> Vec<Configuration> {
    if candidates
        .iter()
        .any(|c| model_identity(&c.provider_id, &c.model_id).is_none())
    {
        return Vec::new();
    }
    seatable(draft, seats, &[])
        .into_iter()
        .map(|(judge, _)| judge)
        .collect()
}

/// The offered judges, in order, with their models: none of the `excluded`
/// models, no author of the case, one row per model of a provider.
pub(in super::super) fn seatable(
    draft: &BenchmarkDraft,
    mut offered: Vec<Configuration>,
    excluded: &[String],
) -> Vec<(Configuration, String)> {
    // Concrete rows first, so an alias never takes its own target's seat.
    offered.sort_by_key(|c| {
        concrete_model(&c.provider_id, &c.model_id).as_deref() != Some(&c.model_id.to_lowercase())
    });
    let mut panel: Vec<(Configuration, String)> = Vec::new();
    for configuration in offered {
        let (Some(concrete), Some(model)) = (
            concrete_model(&configuration.provider_id, &configuration.model_id),
            model_identity(&configuration.provider_id, &configuration.model_id),
        ) else {
            continue;
        };
        let mut resolved = configuration.clone();
        resolved.model_id = concrete;
        if excluded.contains(&model)
            || crate::services::benchmarks::routing::authored_by_candidate(draft, &configuration)
            || crate::services::benchmarks::routing::authored_by_candidate(draft, &resolved)
            || panel.iter().any(|(judge, seated)| {
                judge.provider_id == configuration.provider_id && seated == &model
            })
        {
            continue;
        }
        panel.push((configuration, model));
    }
    panel
}

/// Whether a provider's models may judge renderings (see
/// [`NativeProvider::judges_images`]).
pub(in crate::services::benchmarks) fn judge_provider_allowed(provider_id: &str) -> bool {
    NativeProvider::for_harness(provider_id).is_some_and(NativeProvider::judges_images)
}
