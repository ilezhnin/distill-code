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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn frozen_seats_keep_the_candidates_own_model_and_skip_the_cases_authors() {
        let offered = || {
            [
                "default",
                "opus[1m]",
                "claude-fable-5-1[1m]",
                "sonnet",
                "haiku",
            ]
            .map(judge_row)
            .to_vec()
        };
        let ids =
            |panel: &[Configuration]| panel.iter().map(|c| c.model_id.clone()).collect::<Vec<_>>();
        let mut draft = creative();
        draft.environment["authoredBy"] = json!([]);
        // A frozen panel's seats are checked by `frozen_seats` alone: one
        // seat per model, the candidate's own model among them. `opus` is
        // another name for Opus at 1M, so it is that seat; `default` moves
        // with Claude Code's own setting (Opus until 10-31, Fable 5.1 since),
        // so it is no seat, and a candidate on it has no frozen panel.
        let seated = ["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"];
        let frozen = frozen_seats(&[&judge_row("sonnet")], &draft, offered());
        assert_eq!(ids(&frozen), seated);
        let frozen = frozen_seats(&[&judge_row("opus")], &draft, offered());
        assert_eq!(ids(&frozen), seated);
        assert!(frozen_seats(&[&judge_row("default")], &draft, offered()).is_empty());
        // An author of the case never judges it, nor through its alias.
        draft.environment["authoredBy"] = json!([judge_row("sonnet")]);
        let panel = frozen_seats(&[&judge_row("haiku")], &draft, offered());
        assert_eq!(ids(&panel), ["opus[1m]", "claude-fable-5-1[1m]", "haiku"]);
        draft.environment["authoredBy"] = json!([judge_row("opus[1m]")]);
        let panel = frozen_seats(&[&judge_row("haiku")], &draft, offered());
        assert_eq!(ids(&panel), ["claude-fable-5-1[1m]", "sonnet", "haiku"]);
        // A candidate alias with an unknown target admits no judge.
        let mut moving = judge_row("current");
        moving.provider_id = "other-provider".into();
        assert!(frozen_seats(&[&moving], &draft, offered()).is_empty());
        let rows = offered().into_iter().map(|judge| (None, judge)).collect();
        assert!(ordinary_judges(&[&moving], &draft, rows).is_empty());
        // Generic examples without an exact author seat their candidate's
        // model too; the evaluation is marked `ownModel`.
        let seeded = creative();
        for candidate in ["opus[1m]", "sonnet", "haiku", "claude-fable-5-1[1m]"] {
            let panel = frozen_seats(&[&judge_row(candidate)], &seeded, offered());
            assert!(own_model(&[&judge_row(candidate)], &panel));
        }
    }

    #[test]
    fn a_context_window_variant_of_a_model_is_that_model() {
        // 10-18: the old Opus candidate column (`opus`, effort default) was
        // judged by `opus[1m]` high, Opus judging its own output.
        for (model, identity) in [
            ("opus[1m]", "opus"),
            ("OPUS[1M]", "opus"),
            ("opus", "opus"),
            ("fable", "claude-fable-5-2"),
            ("claude-fable-5-2[1m]", "claude-fable-5-2"),
            ("claude-fable-5-1", "claude-fable-5-1"),
            ("claude-fable-5-1[1m]", "claude-fable-5-1"),
            ("sonnet", "sonnet"),
            ("[1m]", "[1m]"),
        ] {
            assert_eq!(
                model_identity("claude-acp", model).as_deref(),
                Some(identity),
                "{model}"
            );
        }
        assert_eq!(model_identity("claude-acp", "current"), None);
        // `default` moves with Claude Code's own setting (Fable 5.1 since
        // 11-01), so it names no one model.
        assert_eq!(model_identity("claude-acp", "default"), None);
        // Only Claude Code's ids carry a context window suffix.
        assert_eq!(
            model_identity("codex-acp", "invented[1m]").as_deref(),
            Some("invented[1m]")
        );
        let ids =
            |panel: &[Configuration]| panel.iter().map(|c| c.model_id.clone()).collect::<Vec<_>>();
        let offered = || ["opus[1m]", "sonnet", "haiku"].map(judge_row).to_vec();
        let mut draft = creative();
        draft.environment["authoredBy"] = json!([]);
        let opus = judge_row("opus");
        // A frozen panel seats the candidate's own model, and marks it by
        // the same identity.
        let frozen = frozen_seats(&[&opus], &draft, offered());
        assert_eq!(ids(&frozen), ["opus[1m]", "sonnet", "haiku"]);
        assert!(own_model(&[&opus], &frozen));
        assert!(!own_model(&[&opus], &frozen[1..]));
        // So may an ordinary panel, which one lab's models fill to three.
        let rows = offered().into_iter().map(|judge| (None, judge)).collect();
        let panel = ordinary_judges(&[&opus], &draft, rows);
        assert_eq!(ids(&panel), ["opus[1m]", "sonnet", "haiku"]);
        assert!(own_model(&[&opus], &panel));
        assert!(!own_model(&[&opus], &panel[1..]));
        // One seat for one model offered twice, whoever the candidate is:
        // the lane's, since `opus` is declared as its alias (10-31).
        let both = ["opus", "opus[1m]", "sonnet"].map(judge_row).to_vec();
        assert_eq!(
            ids(&frozen_seats(
                &[&judge_row("opus[1m]")],
                &draft,
                both.clone()
            )),
            ["opus[1m]", "sonnet"]
        );
        assert_eq!(
            ids(&frozen_seats(&[&judge_row("haiku")], &draft, both)),
            ["opus[1m]", "sonnet"]
        );
        // An author is matched by the same identity, and its model at another
        // effort is marked.
        draft.environment["authoredBy"] =
            json!([{"providerId": "claude-acp", "modelId": "opus[1m]", "effort": "high"}]);
        let mut author = judge_row("opus");
        author.effort = Some("high".into());
        assert!(crate::services::benchmarks::routing::authored_by_candidate(
            &draft, &author
        ));
        assert_eq!(
            ids(&frozen_seats(&[&judge_row("haiku")], &draft, offered())),
            ["opus[1m]", "sonnet", "haiku"]
        );
        assert!(author_model_judges(&draft, &[judge_row("opus")]));
    }

    #[test]
    fn a_panel_with_an_authors_model_at_another_effort_is_marked() {
        let mut opus = judge_row("opus[1m]");
        opus.effort = Some("high".into());
        let mut draft = creative();
        draft.environment["authoredBy"] = json!([
            {"providerId": "claude-acp", "modelId": "opus[1m]", "effort": "xhigh"},
            "legacy-author-name",
        ]);
        assert!(author_model_judges(&draft, std::slice::from_ref(&opus)));
        assert!(!author_model_judges(&draft, &[judge_row("sonnet")]));
        // Another provider's model of the same name is not the author's.
        let mut elsewhere = opus.clone();
        elsewhere.provider_id = "codex-acp".into();
        assert!(!author_model_judges(&draft, &[elsewhere]));
        draft.environment["authoredBy"] = json!(["legacy-author-name"]);
        assert!(!author_model_judges(&draft, &[opus]));
    }

    #[test]
    fn a_pool_judge_sits_on_the_cli_sign_in_candidates_run_on() {
        use crate::services::provider_accounts::{AuthMethod, ProviderAccount};
        let account = |id: &str, provider: &str, enabled: bool| ProviderAccount {
            id: id.into(),
            provider_id: provider.into(),
            label: id.into(),
            auth_method: AuthMethod::OAuth,
            enabled,
            auto_switch: false,
            created_at: 0,
            updated_at: 0,
        };
        let stored = vec![
            account("invented-claude", "claude-acp", true),
            account("invented-claude-off", "claude-acp", false),
            account("invented-codex", "codex-acp", true),
            account("invented-zai", "zai-acp", true),
        ];
        // The pool names Claude, Codex and Grok: Grok's only account is the
        // CLI sign-in no store lists; Kimi's is never asked for.
        let pool = crate::services::benchmarks::judge_pool::entries(&json!({"judgePool": [
            {"providerId": "claude-acp", "modelId": "opus[1m]", "effort": "high"},
            {"providerId": "codex-acp", "modelId": "invented-sol", "effort": "high"},
            {"providerId": "grok-acp", "modelId": "invented-grok", "effort": "high"},
        ]}));
        let admit = |provider: &str| pool.iter().any(|entry| entry.provider_id == provider);
        let asked = std::cell::RefCell::new(Vec::new());
        let accounts = judge_accounts(&stored, admit, |provider| {
            asked.borrow_mut().push(provider.to_owned());
            crate::services::provider_accounts::cli_login_account_id(provider)
                .map(|id| account(&id, provider, true))
        });
        let ids: Vec<_> = accounts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            ["invented-claude", "invented-codex", "cli-login-grok-acp"]
        );
        assert!(!asked.borrow().iter().any(|provider| provider == "kimi-acp"));
        // A CLI sign-in already stored is not listed twice.
        let mut with_identity = stored.clone();
        with_identity.push(account("cli-login-grok-acp", "grok-acp", true));
        assert_eq!(
            judge_accounts(&with_identity, admit, |provider| {
                crate::services::provider_accounts::cli_login_account_id(provider)
                    .map(|id| account(&id, provider, true))
            })
            .len(),
            3
        );
        // The Grok entry seats on that sign-in at its effort, beside Opus,
        // for a candidate of a third vendor.
        let row = |provider: &str, model: &str, account_id: &str| InventoryModel {
            configuration: Configuration {
                id: format!("{provider}:{account_id}:{model}"),
                provider_id: provider.into(),
                account_id: Some(account_id.into()),
                model_id: model.into(),
                effort: None,
                fast_mode: Some(false),
                billing_mode: "subscription".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some("runtime".into()),
                model_name: None,
            },
            name: model.into(),
            efforts: vec!["high".into()],
            supports_fast_mode: false,
            available: true,
            reason: None,
        };
        let seats = crate::services::benchmarks::judge_pool::seat_rows(
            &pool,
            vec![
                (None, row("claude-acp", "opus[1m]", "invented-claude")),
                (None, row("grok-acp", "invented-grok", "cli-login-grok-acp")),
            ],
        );
        let mut text = creative();
        text.environment["authoredBy"] = json!([]);
        text.environment["judgeInput"] = json!("text");
        let mut luna = judge_row("invented-luna");
        luna.provider_id = "codex-acp".into();
        let panel = ordinary_judges(
            &[&luna],
            &text,
            seats.into_iter().map(|(_, judge)| (None, judge)).collect(),
        );
        assert_eq!(
            panel
                .iter()
                .map(|judge| (judge.model_id.as_str(), judge.account_id.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("opus[1m]", Some("invented-claude")),
                ("invented-grok", Some("cli-login-grok-acp"))
            ]
        );
        assert!(panel
            .iter()
            .all(|judge| judge.effort.as_deref() == Some("high")));
    }

    #[test]
    fn ordinary_seats_prefer_each_lab_then_fill_with_distinct_calibrated_models() {
        // Owner, 10-18: every ordinary panel seats one calibrated judge per
        // lab, the candidate's own lab and model included, marked.
        let row = |provider: &str, model: &str| {
            let mut judge = judge_row(model);
            judge.provider_id = provider.into();
            judge.id = format!("{provider}:account:{model}");
            judge
        };
        let offered = || {
            vec![
                (Some(90.0), row("claude-acp", "opus[1m]")),
                (Some(80.0), row("claude-acp", "sonnet")),
                (Some(70.0), row("codex-acp", "invented-sol")),
                (Some(60.0), row("grok-acp", "invented-grok")),
            ]
        };
        let ids =
            |panel: &[Configuration]| panel.iter().map(|c| c.model_id.clone()).collect::<Vec<_>>();
        let mut text = creative();
        text.environment["authoredBy"] = json!([]);
        text.environment["judgeInput"] = json!("text");
        let seat = |candidate: Configuration, draft: &BenchmarkDraft| {
            ordinary_judges(&[&candidate], draft, offered())
        };
        let labs = ["opus[1m]", "invented-sol", "invented-grok"];
        let haiku = row("claude-acp", "haiku");
        let panel = seat(haiku.clone(), &text);
        assert_eq!(ids(&panel), labs);
        assert!(same_vendor(&[&haiku], &panel));
        assert!(!own_model(&[&haiku], &panel));
        let opus = row("claude-acp", "opus");
        let panel = seat(opus.clone(), &text);
        assert_eq!(ids(&panel), labs);
        assert!(own_model(&[&opus], &panel));
        for candidate in [
            row("codex-acp", "invented-sol"),
            row("grok-acp", "invented-grok-fast"),
        ] {
            assert_eq!(ids(&seat(candidate.clone(), &text)), labs);
        }
        // A workflow's candidates change nothing either.
        let both = [
            row("codex-acp", "invented-luna"),
            row("grok-acp", "invented-grok"),
        ];
        let panel = ordinary_judges(&[&both[0], &both[1]], &text, offered());
        assert_eq!(ids(&panel), labs);
        assert!(own_model(&[&both[0], &both[1]], &panel));
        // An author never judges; its lab without another calibrated judge
        // leaves the panel to the other labs, and with one it sits instead.
        text.environment["authoredBy"] = json!([row("codex-acp", "invented-sol")]);
        assert_eq!(
            ids(&seat(haiku.clone(), &text)),
            ["opus[1m]", "invented-grok", "sonnet"]
        );
        text.environment["authoredBy"] = json!([row("claude-acp", "opus[1m]")]);
        assert_eq!(
            ids(&seat(haiku.clone(), &text)),
            ["sonnet", "invented-sol", "invented-grok"]
        );
        // A candidate of no known vendor admits no judge.
        text.environment["authoredBy"] = json!([]);
        assert!(seat(row("invented-provider", "model"), &text).is_empty());
        // Two labs offered: the third seat uses another calibrated model.
        let two_labs = || offered().into_iter().take(3).collect::<Vec<_>>();
        assert_eq!(
            ids(&ordinary_judges(&[&haiku], &text, two_labs())),
            ["opus[1m]", "invented-sol", "sonnet"]
        );
        // One lab offered (a visual rubric while only Claude passed a visual
        // calibration): its models fill the panel to two, marked.
        let mut visual = creative();
        visual.environment["authoredBy"] = json!([]);
        let claude_only = || offered().into_iter().take(2).collect::<Vec<_>>();
        let luna = row("codex-acp", "invented-luna");
        let panel = ordinary_judges(&[&luna], &visual, claude_only());
        assert_eq!(ids(&panel), ["opus[1m]", "sonnet"]);
        assert!(!same_vendor(&[&luna], &panel));
        let panel = ordinary_judges(&[&haiku], &visual, claude_only());
        assert_eq!(ids(&panel), ["opus[1m]", "sonnet"]);
        assert!(same_vendor(&[&haiku], &panel));
        // Every lab passed visual: the same three labs.
        assert_eq!(ids(&ordinary_judges(&[&haiku], &visual, offered())), labs);
    }

    #[test]
    fn a_judge_seat_goes_to_the_account_with_the_most_headroom() {
        let on = |account: &str| {
            let mut judge = judge_row("opus[1m]");
            judge.id = format!("claude-acp:{account}:opus[1m]");
            judge.account_id = Some(account.into());
            judge
        };
        let ordered = by_headroom(vec![
            (Some(20.0), on("first-listed")),
            (None, on("unknown")),
            (Some(80.0), on("spare")),
            (Some(0.0), on("spent")),
        ]);
        let accounts: Vec<_> = ordered
            .iter()
            .map(|c| c.account_id.clone().unwrap())
            .collect();
        assert_eq!(accounts, ["spare", "first-listed", "spent", "unknown"]);
        let mut draft = creative();
        draft.environment["authoredBy"] = json!([]);
        let panel = frozen_seats(&[&judge_row("haiku")], &draft, ordered);
        assert_eq!(panel.len(), 1);
        assert_eq!(panel[0].account_id.as_deref(), Some("spare"));
        // The ordinary panel orders its rows so, and seats the roomier
        // account's concrete row, not its alias of it.
        let mut alias = on("roomier");
        alias.model_id = "opus".into();
        let mut candidate = judge_row("invented-luna");
        candidate.provider_id = "codex-acp".into();
        let panel = ordinary_judges(
            &[&candidate],
            &draft,
            vec![
                (Some(50.0), on("spare")),
                (Some(90.0), alias),
                (Some(90.0), on("roomier")),
            ],
        );
        assert_eq!(panel.len(), 1);
        assert_eq!(panel[0].account_id.as_deref(), Some("roomier"));
        assert_eq!(panel[0].model_id, "opus[1m]");
    }

    #[test]
    fn judge_provider_allowed_only_for_claude() {
        assert!(judge_provider_allowed("claude-acp"));
        for provider in ["codex-acp", "grok-acp", "kimi-acp", "unknown"] {
            assert!(!judge_provider_allowed(provider), "{provider}");
        }
    }

    #[tokio::test]
    async fn a_rendering_of_its_own_brief_goes_to_the_panel() {
        // Seats themselves are `frozen_seats`' rule: no author; a candidate's own model sits, marked.
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let mut authored = creative();
        authored.name.push_str(" written by the candidate");
        authored.environment["authoredBy"] = json!([req.configurations[0]]);
        let written = publish(&s, authored).await;
        req.request_key = "own-creative".into();
        req.version_ids = vec![written.id.clone()];
        req.repetitions = 1;
        req.max_executions = 4;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        let rendering = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert!(rendering.output.is_some());
        assert_ne!(rendering.outcome.as_deref(), Some("excluded"));
        dir.close().await;
    }
}
