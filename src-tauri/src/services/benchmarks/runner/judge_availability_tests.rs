//! Invented ordinary panels: use idle accounts without silently shrinking
//! an eligible three-judge panel while an account is temporarily occupied.
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

fn idle(judge: &Configuration) -> bool {
    judge.account_id.as_deref() != Some("interactive-busy")
}

#[test]
fn busy_third_lab_defers_the_panel_instead_of_silently_using_two_judges() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let busy = judge("claude-acp", "invented-judge-a", "interactive-busy");
    let first = judge("codex-acp", "invented-judge-b", "idle-first");
    let second = judge("grok-acp", "invented-judge-c", "idle-second");
    let offered = vec![
        (Some(99.0), busy.clone()),
        (Some(80.0), first.clone()),
        (Some(60.0), second.clone()),
    ];
    assert!(ordinary_judges(&[&candidate], &brief(), offered.clone()).contains(&busy));
    let error =
        ordinary_available_judges(&[&candidate], &brief(), offered.clone(), idle).unwrap_err();
    assert_eq!(error.code, ACCOUNT_BUSY);
    assert_eq!(error.message, JUDGES_BUSY);
    assert_eq!(
        ordinary_available_judges(&[&candidate], &brief(), offered, |_| true).unwrap(),
        vec![busy, first, second]
    );
}

#[test]
fn busy_roomiest_account_does_not_hide_an_idle_account_of_the_same_model() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let busy = judge("claude-acp", "invented-judge", "interactive-busy");
    let alternate = judge("claude-acp", "invented-judge", "idle-alternate");
    let other = judge("codex-acp", "invented-other", "idle-other");
    let third = judge("grok-acp", "invented-third", "idle-third");
    let offered = vec![
        (Some(99.0), busy.clone()),
        (Some(70.0), alternate.clone()),
        (Some(50.0), other.clone()),
        (Some(40.0), third.clone()),
    ];
    assert!(ordinary_judges(&[&candidate], &brief(), offered.clone()).contains(&busy));
    assert_eq!(
        ordinary_available_judges(&[&candidate], &brief(), offered, idle).unwrap(),
        vec![alternate, other, third]
    );
}

#[test]
fn insufficient_idle_panel_uses_the_existing_account_wait_not_resource_refusal() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let ready = judge("claude-acp", "invented-first", "idle-first");
    let busy = judge("codex-acp", "invented-second", "interactive-busy");
    for available in [true, false] {
        let error = ordinary_available_judges(
            &[&candidate],
            &brief(),
            vec![(Some(80.0), ready.clone()), (Some(70.0), busy.clone())],
            |judge| available && idle(judge),
        )
        .unwrap_err();
        assert_eq!(error.code, ACCOUNT_BUSY);
        assert!(!unstarted_refusal(&error));
        let mut attempt = super::super::pending_attempt("invented-run", "v", &candidate, 0);
        attempt.reason = Some(judge_error_reason(&error));
        assert_eq!(attempt.reason.as_deref(), Some(JUDGES_BUSY));
        assert!(judging_deferred(&attempt));
    }
}

#[test]
fn busy_authors_duplicates_and_unknown_candidates_do_not_invent_a_wait() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let ready = judge("claude-acp", "invented-first", "idle-first");
    let duplicate = judge("claude-acp", "invented-first", "interactive-busy");
    assert_eq!(
        ordinary_available_judges(
            &[&candidate],
            &brief(),
            vec![(Some(80.0), ready.clone()), (Some(99.0), duplicate)],
            idle,
        )
        .unwrap(),
        vec![ready.clone()]
    );
    let author = judge("codex-acp", "invented-author", "interactive-busy");
    let mut authored = brief();
    authored.environment["authoredBy"] = json!([author]);
    assert_eq!(
        ordinary_available_judges(
            &[&candidate],
            &authored,
            vec![(Some(80.0), ready.clone()), (Some(99.0), author.clone())],
            idle,
        )
        .unwrap(),
        vec![ready.clone()]
    );
    let unknown = judge("invented-provider", "invented-candidate", "candidate");
    assert!(ordinary_available_judges(
        &[&unknown],
        &brief(),
        vec![(Some(80.0), ready), (Some(99.0), author)],
        idle,
    )
    .unwrap()
    .is_empty());
}

#[test]
fn idle_selection_keeps_headroom_order_and_same_lab_fallback() {
    let candidate = judge("claude-acp", "invented-first", "candidate");
    let first = judge("claude-acp", "invented-first", "idle-first");
    let second = judge("claude-acp", "invented-second", "idle-second");
    let offered = vec![(Some(60.0), first), (Some(80.0), second)];
    assert_eq!(
        ordinary_available_judges(&[&candidate], &brief(), offered.clone(), idle).unwrap(),
        ordinary_judges(&[&candidate], &brief(), offered)
    );
}

#[test]
fn unavailable_quota_seat_keeps_other_discovery_deferrals_optional() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let first = judge("claude-acp", "invented-first", "idle-first");
    let second = judge("codex-acp", "invented-second", "idle-second");
    let busy = judge("grok-acp", "invented-busy", "interactive-busy");
    let panel = ordinary_available_judges(
        &[&candidate],
        &brief(),
        vec![
            (Some(80.0), first.clone()),
            (Some(60.0), second.clone()),
        ],
        idle,
    )
    .unwrap();
    assert_eq!(
        resolve_quota_panel(
            panel,
            &[&candidate],
            &brief(),
            vec![(now() + QUOTA_RETRY_MS, busy)],
            Some(BenchmarkError::new("resource_busy", "Invented listing")),
        )
        .unwrap(),
        vec![first, second]
    );
}
