//! Invented ordinary panels: a judge sits whatever else its account is doing,
//! so a panel is chosen from what the accounts offer and nothing else.
use super::*;

fn judge(provider: &str, model: &str, account: &str) -> Configuration {
    Configuration {
        id: format!("invented-{provider}-{model}-{account}"),
        provider_id: provider.into(),
        account_id: Some(account.into()),
        model_id: model.into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("invented-runtime".into()),
        model_name: None,
    }
}

fn brief() -> BenchmarkDraft {
    let mut draft = seed_definitions()
        .into_iter()
        .find(|draft| draft.work_class_id == "creative")
        .unwrap();
    draft.name = "Invented available panel".into();
    draft.split = "train".into();
    draft
}

#[test]
fn a_panel_seats_its_judges_whatever_their_accounts_are_doing() {
    // The roomiest account is the one the operator's chats run on. Nothing
    // about a panel asks what else an account does, so its judge sits first.
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let working = judge("claude-acp", "invented-judge-a", "account-with-open-chats");
    let first = judge("codex-acp", "invented-judge-b", "first");
    let second = judge("grok-acp", "invented-judge-c", "second");
    let offered = vec![
        (Some(99.0), working.clone()),
        (Some(80.0), first.clone()),
        (Some(60.0), second.clone()),
    ];
    assert_eq!(
        ordinary_judges(&[&candidate], &brief(), offered),
        vec![working, first, second]
    );
}

#[test]
fn authors_duplicates_and_unknown_candidates_seat_nobody_extra() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let ready = judge("claude-acp", "invented-first", "first");
    let duplicate = judge("claude-acp", "invented-first", "second");
    // One model sits once, on its roomiest account.
    assert_eq!(
        ordinary_judges(
            &[&candidate],
            &brief(),
            vec![(Some(80.0), ready.clone()), (Some(99.0), duplicate.clone())],
        ),
        vec![duplicate]
    );
    let author = judge("codex-acp", "invented-author", "author");
    let mut authored = brief();
    authored.environment["authoredBy"] = json!([author]);
    assert_eq!(
        ordinary_judges(
            &[&candidate],
            &authored,
            vec![(Some(80.0), ready.clone()), (Some(99.0), author.clone())],
        ),
        vec![ready.clone()]
    );
    let unknown = judge("invented-provider", "invented-candidate", "candidate");
    assert!(ordinary_judges(
        &[&unknown],
        &brief(),
        vec![(Some(80.0), ready), (Some(99.0), author)],
    )
    .is_empty());
}

#[test]
fn unavailable_quota_seat_keeps_other_discovery_deferrals_optional() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let first = judge("claude-acp", "invented-first", "first");
    let second = judge("codex-acp", "invented-second", "second");
    let limited = judge("grok-acp", "invented-limited", "limited");
    let panel = ordinary_judges(
        &[&candidate],
        &brief(),
        vec![(Some(80.0), first.clone()), (Some(60.0), second.clone())],
    );
    assert_eq!(
        resolve_quota_panel(
            panel,
            &[&candidate],
            &brief(),
            vec![(now() + QUOTA_RETRY_MS, limited)],
            Some(BenchmarkError::new("resource_busy", "Invented listing")),
        )
        .unwrap(),
        vec![first, second]
    );
}
