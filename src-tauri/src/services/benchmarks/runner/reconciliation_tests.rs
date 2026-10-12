use super::*;
use std::{collections::VecDeque, sync::Mutex};

type HostResult<T> = std::result::Result<T, String>;

const KEY: &str = "benchmark:invented-receipt-attempt:1";
const SESSION: &str = "invented-receipt-session";
const NO_RUNTIME: &str = "dispatch_uncertain: no live runtime can confirm cancellation";

struct ReceiptSnapshot {
    page: HostResult<OwnedEventPage>,
    status: HostResult<Option<ExecutionDispatch>>,
    delay: Duration,
}

struct ReceiptHost {
    cancellation: HostResult<()>,
    snapshots: Mutex<VecDeque<ReceiptSnapshot>>,
    status: Mutex<Option<HostResult<Option<ExecutionDispatch>>>>,
    cancellations: Mutex<Vec<String>>,
    cursors: Mutex<Vec<i64>>,
}

impl ReceiptHost {
    fn new(snapshots: Vec<ReceiptSnapshot>) -> Self {
        Self {
            cancellation: Err(NO_RUNTIME.into()),
            snapshots: Mutex::new(snapshots.into()),
            status: Mutex::new(None),
            cancellations: Mutex::new(Vec::new()),
            cursors: Mutex::new(Vec::new()),
        }
    }

    fn assert_single_cancellation(&self) {
        assert_eq!(*self.cancellations.lock().unwrap(), [KEY]);
    }
}

impl OwnedTurnReceiptSource for ReceiptHost {
    fn cancel_owned_turn<'a>(&'a self, key: &'a str) -> BoxFuture<'a, HostResult<()>> {
        Box::pin(async move {
            self.cancellations.lock().unwrap().push(key.into());
            self.cancellation.clone()
        })
    }

    fn read_owned_events<'a>(
        &'a self,
        session: &'a str,
        after: i64,
        limit: u32,
    ) -> BoxFuture<'a, HostResult<OwnedEventPage>> {
        Box::pin(async move {
            assert_eq!(session, SESSION);
            assert_eq!(limit, 200);
            self.cursors.lock().unwrap().push(after);
            let snapshot = self.snapshots.lock().unwrap().pop_front().unwrap();
            *self.status.lock().unwrap() = Some(snapshot.status);
            tokio::time::sleep(snapshot.delay).await;
            snapshot.page
        })
    }

    fn execution_status<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, HostResult<Option<ExecutionDispatch>>> {
        Box::pin(async move {
            assert_eq!(key, KEY);
            self.status.lock().unwrap().take().unwrap()
        })
    }
}

fn dispatch(phase: &str, cursor: i64, error_kind: Option<&str>) -> ExecutionDispatch {
    ExecutionDispatch {
        request_key: KEY.into(),
        session_id: SESSION.into(),
        run_id: "invented-native-run".into(),
        user_message_id: "invented-user-message".into(),
        phase: phase.into(),
        event_cursor: cursor,
        result: None,
        error: error_kind.map(|kind| json!({"kind": kind, "message": "Invented terminal result"})),
    }
}

fn snapshot(
    events: Vec<OwnedEvent>,
    cursor: i64,
    has_more: bool,
    status: ExecutionDispatch,
) -> ReceiptSnapshot {
    ReceiptSnapshot {
        page: Ok(OwnedEventPage {
            events,
            cursor,
            has_more,
        }),
        status: Ok(Some(status)),
        delay: Duration::ZERO,
    }
}

fn usage_event(cursor: i64) -> OwnedEvent {
    OwnedEvent {
        event_id: cursor,
        payload: json!({"update": {
            "sessionUpdate": "benchmark_turn_result",
            "_meta": {"benchmarkRawResult": {
                "stopReason": "cancelled",
                "usage": {"inputTokens": 12, "outputTokens": 7, "totalTokens": 19}
            }}
        }}),
    }
}

fn attempt() -> Attempt {
    let mut attempt = super::super::analysis::tests::dataset().attempts[0].clone();
    attempt.id = "invented-receipt-attempt".into();
    attempt.session_id = Some(SESSION.into());
    attempt.outcome = None;
    attempt.reason = None;
    attempt.event_cursor = 0;
    attempt.usage = TokenUsage::default();
    attempt
}

async fn observe(
    host: &ReceiptHost,
    attempt: &mut Attempt,
    capture: &mut TurnCapture,
    operator_cancel: bool,
    grace: Duration,
) -> Result<Value> {
    let (_sender, mut cancel) = watch::channel(operator_cancel);
    let started = if operator_cancel {
        Instant::now()
    } else {
        Instant::now() - Duration::from_secs(2)
    };
    tokio::time::timeout(
        Duration::from_secs(3),
        wait_for_owned_turn(
            host,
            attempt,
            capture,
            &mut cancel,
            OwnedTurnWait {
                key: KEY,
                session_id: SESSION,
                started,
                timeout: Duration::from_secs(1),
                budget: None,
                repository: true,
                cancellation_grace: grace,
                terminal_drain_grace: Duration::from_secs(1),
            },
        ),
    )
    .await
    .expect("receipt reconciliation must remain bounded")
}

#[tokio::test]
async fn owned_turn_reconciliation_retains_delayed_timeout_receipt_and_usage() {
    // Either timeout clock can win; a native cancelled receipt after the
    // runner's budget expired must preserve the same budget classification.
    for kind in ["budget_timeout", "cancelled"] {
        let host = ReceiptHost::new(vec![
            snapshot(vec![], 0, false, dispatch("running", 0, None)),
            snapshot(
                vec![usage_event(1)],
                1,
                false,
                dispatch("terminal", 1, Some(kind)),
            ),
        ]);
        let mut attempt = attempt();
        let mut capture = TurnCapture::new(1024);
        let terminal = observe(
            &host,
            &mut attempt,
            &mut capture,
            false,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(attempt.outcome.as_deref(), Some("budget_timeout"));
        assert_eq!(attempt.usage.input, Some(12));
        assert_eq!(attempt.usage.output, Some(7));
        assert_eq!(attempt.event_cursor, 1);
        assert_eq!(terminal["terminalDispatch"]["error"]["kind"], kind);
        let evidence = capture.evidence.close(terminal);
        assert_eq!(evidence.as_array().unwrap().len(), 2);
        assert_eq!(*host.cursors.lock().unwrap(), [0, 0]);
        host.assert_single_cancellation();
    }
}

#[tokio::test]
async fn owned_turn_reconciliation_checks_operator_terminal_before_expired_grace() {
    let mut receipt = snapshot(
        vec![usage_event(1)],
        1,
        false,
        dispatch("terminal", 1, Some("cancelled")),
    );
    receipt.delay = Duration::from_millis(20);
    let host = ReceiptHost::new(vec![receipt]);
    let mut attempt = attempt();
    observe(
        &host,
        &mut attempt,
        &mut TurnCapture::new(1024),
        true,
        Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(attempt.outcome.as_deref(), Some("cancelled"));
    assert_eq!(attempt.usage.output, Some(7));
    host.assert_single_cancellation();
}

#[tokio::test]
async fn owned_turn_reconciliation_without_confirmation_stays_uncertain() {
    let host = ReceiptHost::new(vec![snapshot(
        vec![],
        0,
        false,
        dispatch("running", 0, None),
    )]);
    let mut attempt = attempt();
    let error = observe(
        &host,
        &mut attempt,
        &mut TurnCapture::new(1024),
        false,
        Duration::ZERO,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "dispatch_uncertain");
    assert!(error.message.starts_with("Cancellation was not confirmed"));
    assert_eq!(attempt.outcome, None);
    assert_eq!(attempt.usage.output, None);
    host.assert_single_cancellation();
}

#[tokio::test]
async fn owned_turn_reconciliation_drains_terminal_cursor_after_grace() {
    let terminal = dispatch("terminal", 3, Some("budget_timeout"));
    let host = ReceiptHost::new(vec![
        snapshot(
            vec![OwnedEvent {
                event_id: 1,
                payload: json!({"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "Invented answer"}}}),
            }],
            1,
            true,
            terminal.clone(),
        ),
        // Even a page with no further available events must not settle
        // before reaching the cursor named by the terminal receipt.
        snapshot(vec![], 2, false, terminal.clone()),
        snapshot(vec![usage_event(3)], 3, false, terminal),
    ]);
    let mut attempt = attempt();
    let mut capture = TurnCapture::new(1024);
    observe(&host, &mut attempt, &mut capture, false, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(attempt.outcome.as_deref(), Some("budget_timeout"));
    assert_eq!(attempt.event_cursor, 3);
    assert_eq!(attempt.usage.output, Some(7));
    assert_eq!(capture.output, "Invented answer");
    assert_eq!(*host.cursors.lock().unwrap(), [0, 1, 2]);
    host.assert_single_cancellation();
}

#[tokio::test]
async fn owned_turn_reconciliation_bounds_an_unreachable_terminal_cursor() {
    // Every subsequent page remains empty and behind the committed cursor.
    // There are enough snapshots to outlast the outer test timeout if the
    // production drain deadline is removed or reset on every poll.
    let host = ReceiptHost::new(
        (0..20)
            .map(|_| snapshot(vec![], 0, false, dispatch("terminal", 1, Some("cancelled"))))
            .collect(),
    );
    let mut attempt = attempt();
    let error = observe(
        &host,
        &mut attempt,
        &mut TurnCapture::new(1024),
        true,
        Duration::ZERO,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "dispatch_uncertain");
    assert!(error.message.contains("drain deadline"));
    assert_eq!(attempt.outcome, None);
    assert_eq!(attempt.event_cursor, 0);
    assert!(host.cursors.lock().unwrap().len() > 1);
    host.assert_single_cancellation();
}

#[tokio::test]
async fn owned_turn_reconciliation_preserves_cancellation_errors() {
    for (message, code, reason) in [
        (
            "storage_unavailable: write failed",
            "storage_unavailable",
            "write failed",
        ),
        (
            "validation: unknown dispatch",
            "validation",
            "unknown dispatch",
        ),
        (
            "dispatch_uncertain: different failure",
            "dispatch_uncertain",
            "different failure",
        ),
        (
            "database is locked",
            "infrastructure_failure",
            "database is locked",
        ),
    ] {
        let mut host = ReceiptHost::new(vec![]);
        host.cancellation = Err(message.into());
        let error = observe(
            &host,
            &mut attempt(),
            &mut TurnCapture::new(1024),
            false,
            Duration::ZERO,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.message, reason);
        assert!(host.cursors.lock().unwrap().is_empty());
        host.assert_single_cancellation();
    }
}

#[tokio::test]
async fn owned_turn_reconciliation_preserves_receipt_storage_errors() {
    for failure_in_events in [true, false] {
        let mut receipt = snapshot(vec![], 0, false, dispatch("running", 0, None));
        if failure_in_events {
            receipt.page = Err("storage_unavailable: event read failed".into());
        } else {
            receipt.status = Err("storage_unavailable: dispatch read failed".into());
        }
        let host = ReceiptHost::new(vec![receipt]);
        let error = observe(
            &host,
            &mut attempt(),
            &mut TurnCapture::new(1024),
            false,
            Duration::ZERO,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "storage_unavailable");
        assert_eq!(
            error.message,
            if failure_in_events {
                "event read failed"
            } else {
                "dispatch read failed"
            }
        );
        host.assert_single_cancellation();
    }
}
