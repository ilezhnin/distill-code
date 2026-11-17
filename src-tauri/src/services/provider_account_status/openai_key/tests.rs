use super::*;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn at(year: i32, month: u32, day: u32, hour: u32) -> i64 {
    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .and_then(|day| day.and_hms_opt(hour, 0, 0))
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

fn blank() -> ProviderAccountStatus {
    let mut status = ProviderAccountStatus::empty("fixture", "codex-acp", 0);
    status.subscription = Some("API".into());
    status
}

/// Answers one connection per reply, in order, and returns what each asked.
async fn serve(
    replies: Vec<(&'static str, String)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            requests.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
        }
        requests
    });
    (base, task)
}

fn costs(values: &[f64]) -> String {
    json!({"object":"page","has_more":false,"next_page":null,"data":[
        {"object":"bucket","start_time":1,"end_time":2,"results":values.iter().map(|value| json!({
            "object":"organization.costs.result",
            "amount":{"value":value,"currency":"usd"},
            "line_item":null,"project_id":null
        })).collect::<Vec<_>>()},
        {"object":"bucket","start_time":2,"end_time":3,"results":[]}
    ]})
    .to_string()
}

#[test]
fn spend_counts_from_the_start_of_the_utc_month() {
    assert_eq!(month_start(at(2026, 11, 17, 21)), at(2026, 11, 1, 0));
    assert_eq!(month_start(at(2026, 12, 1, 0)), at(2026, 12, 1, 0));
}

#[tokio::test]
async fn an_accepted_key_reads_the_months_spend_with_the_admin_key_only() {
    let (base, requests) = serve(vec![
        ("200 OK", json!({"object":"list","data":[]}).to_string()),
        ("200 OK", costs(&[0.5, 1.25])),
    ])
    .await;
    let now = at(2026, 11, 17, 21);
    let status = read(blank(), &base, "project-key", Some("admin-key"), now)
        .await
        .unwrap();
    assert_eq!(status.state, AccountState::Ready);
    assert!(status.key_verified);
    assert_eq!(status.error, None);
    assert_eq!(
        status.spend,
        Some(ApiSpend {
            amount: Some(1.75),
            currency: Some("USD".into()),
            since: at(2026, 11, 1, 0),
            error: None,
        })
    );
    let requests = requests.await.unwrap();
    assert!(requests[0].starts_with("get /v1/models http/1.1"));
    assert!(requests[0].contains("authorization: bearer project-key\r\n"));
    assert!(requests[1].starts_with(&format!(
        "get /v1/organization/costs?start_time={}&bucket_width=1d&limit=31 http/1.1",
        at(2026, 11, 1, 0) / 1000
    )));
    assert!(requests[1].contains("authorization: bearer admin-key\r\n"));
    assert!(!requests[1].contains("project-key"));
    let shown = serde_json::to_string(&status).unwrap();
    assert!(!shown.contains("project-key") && !shown.contains("admin-key"));
}

#[tokio::test]
async fn a_rejected_key_needs_a_new_one_and_asks_nothing_more() {
    let (base, requests) = serve(vec![("401 Unauthorized", "{}".into())]).await;
    let status = read(
        blank(),
        &base,
        "revoked-key",
        Some("admin-key"),
        at(2026, 11, 17, 21),
    )
    .await
    .unwrap();
    assert_eq!(status.state, AccountState::NeedsAuth);
    assert!(!status.key_verified);
    assert!(status.error.unwrap().contains("rejected the saved API key"));
    assert_eq!(status.spend, None);
    assert_eq!(requests.await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_refused_admin_key_leaves_the_account_usable() {
    let (base, _) = serve(vec![
        ("200 OK", json!({"object":"list","data":[]}).to_string()),
        ("403 Forbidden", "{}".into()),
    ])
    .await;
    let status = read(
        blank(),
        &base,
        "project-key",
        Some("project-key"),
        at(2026, 11, 17, 21),
    )
    .await
    .unwrap();
    assert_eq!(status.state, AccountState::Ready);
    assert!(status.key_verified);
    assert_eq!(status.error, None);
    let spend = status.spend.unwrap();
    assert_eq!(spend.amount, None);
    assert!(spend.error.unwrap().contains("Admin key"));
}

#[tokio::test]
async fn an_unreachable_check_is_an_error_not_a_sign_out() {
    let (base, _) = serve(vec![("500 Internal Server Error", "{}".into())]).await;
    let status = read(blank(), &base, "project-key", None, at(2026, 11, 17, 21))
        .await
        .unwrap();
    assert_eq!(status.state, AccountState::Error);
    assert!(status.stale);
    assert!(!status.key_verified);
}

#[test]
fn costs_pages_follow_their_cursor_and_keep_one_currency() {
    let (mut total, mut currency) = (0.0, None);
    let more = json!({"data":[],"has_more":true,"next_page":"page-2"});
    assert_eq!(
        add_costs(&more, &mut total, &mut currency),
        Ok(Some("page-2".into()))
    );
    let cut = json!({"data":[],"has_more":true,"next_page":null});
    assert!(add_costs(&cut, &mut total, &mut currency).is_err());
    let mixed = json!({"data":[{"results":[
        {"amount":{"value":1.0,"currency":"usd"}},
        {"amount":{"value":"2.5","currency":"eur"}}
    ]}],"has_more":false});
    assert!(add_costs(&mixed, &mut total, &mut currency).is_err());
    let (mut total, mut currency) = (0.0, None);
    let empty = json!({"data":[],"has_more":false});
    assert_eq!(add_costs(&empty, &mut total, &mut currency), Ok(None));
    assert_eq!((total, currency), (0.0, None));
}
