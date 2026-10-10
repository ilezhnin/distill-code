use super::*;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const NOW: i64 = 1_800_000_000_000;

fn quota() -> Value {
    json!({"code":200,"success":true,"data":{"level":"lite","limits":[
        {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":4000,
         "currentValue":1000,"remaining":3000,"percentage":25,"nextResetTime":null},
        {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":20000,
         "currentValue":2500,"remaining":17500,"percentage":12,"nextResetTime":NOW+86400000}
    ]}})
}

#[test]
fn credit_windows_keep_precise_usage_balances_and_reported_resets() {
    let status = map_usage("fixture", &quota(), NOW).unwrap();
    assert_eq!(status.state, AccountState::Ready);
    assert_eq!(status.subscription.as_deref(), Some("GLM Coding Plan Lite"));
    assert_eq!(status.limits[0].used_percent, Some(25.0));
    assert_eq!(status.limits[0].window_minutes, Some(300));
    assert_eq!(status.limits[0].resets_at, None);
    assert_eq!(status.limits[1].used_percent, Some(12.5));
    assert_eq!(status.limits[1].window_minutes, Some(10080));
    assert_eq!(status.limits[1].resets_at, Some(NOW + 86400000));
    let credits = status.credits.unwrap();
    assert_eq!(credits[0].balance.as_deref(), Some("3000"));
    assert_eq!(credits[0].total.as_deref(), Some("4000"));
    assert_eq!(credits[1].balance.as_deref(), Some("17500"));
    assert!(credits.iter().all(|credit| credit.currency.is_none()));
}

#[test]
fn unused_and_exhausted_windows_are_distinct_from_missing_data() {
    let mut body = quota();
    for limit in body["data"]["limits"].as_array_mut().unwrap() {
        limit["currentValue"] = json!(0);
        limit["remaining"] = limit["usage"].clone();
        limit["percentage"] = json!(0);
    }
    let zero = map_usage("fixture", &body, NOW).unwrap();
    assert_eq!(zero.limits.len(), 2);
    assert!(zero
        .limits
        .iter()
        .all(|limit| limit.used_percent == Some(0.0)));
    body["data"]["limits"][0]["currentValue"] = json!(4000);
    body["data"]["limits"][0]["remaining"] = json!(0);
    let exhausted = map_usage("fixture", &body, NOW).unwrap();
    assert_eq!(exhausted.state, AccountState::Limited);
    assert_eq!(exhausted.limits[0].used_percent, Some(100.0));
    for key in ["currentValue", "remaining", "percentage"] {
        body["data"]["limits"][0][key] = Value::Null;
    }
    assert!(map_usage("fixture", &body, NOW).is_err());
    assert!(map_usage("fixture", &json!({"data":{}}), NOW).is_err());
    assert!(map_usage("fixture", &json!({"data":{"limits":[]}}), NOW).is_err());
}

#[test]
fn legacy_token_percentages_work_and_tool_exhaustion_does_not_block_models() {
    let body = json!({"data":{"limits":[
        {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":42,
         "nextResetTime":NOW+8*3600000},
        {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":100,
         "usage":100,"currentValue":100,"remaining":0},
        {"type":"FUTURE_LIMIT","percentage":100}
    ]}});
    let status = map_usage("fixture", &body, NOW).unwrap();
    assert_eq!(status.state, AccountState::Ready);
    assert_eq!(status.limits.len(), 1);
    assert_eq!(status.limits[0].used_percent, Some(42.0));
    assert_eq!(status.limits[0].resets_at, None);
    assert_eq!(status.credits.unwrap()[0].balance.as_deref(), Some("0"));
}

async fn serve(
    status: &str,
    headers: &str,
    body: String,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/quota", listener.local_addr().unwrap());
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
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
        let _ = socket.write_all(reply.as_bytes()).await;
        String::from_utf8(request).unwrap()
    });
    (url, task)
}

#[tokio::test]
async fn http_probe_uses_only_the_selected_key_and_maps_quota() {
    let (url, request) = serve(
        "200 OK",
        "Content-Type: application/json\r\n",
        quota().to_string(),
    )
    .await;
    let status = request_usage("fixture", "fixture-key", &url).await.unwrap();
    assert_eq!(status.limits.len(), 2);
    let request = request.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /quota http/1.1"));
    assert!(request.contains("authorization: bearer fixture-key\r\n"));
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("fixture-key"));
}

#[tokio::test]
async fn envelope_auth_errors_and_http_cooldowns_are_not_zero_usage() {
    for (http, headers, body) in [
        (
            "200 OK",
            "",
            json!({"code":401,"success":false,"msg":"fixture-secret"}).to_string(),
        ),
        ("401 Unauthorized", "", "fixture-secret".into()),
        (
            "429 Too Many Requests",
            "Retry-After: 123\r\n",
            "fixture-secret".into(),
        ),
    ] {
        let (url, request) = serve(http, headers, body).await;
        let status = request_usage("fixture", "fixture-key", &url).await.unwrap();
        request.await.unwrap();
        assert_eq!(status.state, AccountState::Error);
        assert!(status.limits.is_empty());
        assert!(!status.error.as_ref().unwrap().contains("fixture-secret"));
        if http.starts_with("429") {
            assert_eq!(status.usage_retry_at, Some(status.last_attempt_at + 123000));
        } else {
            assert!(status.error.unwrap().contains("401"));
            assert!(status.usage_retry_at.is_none());
        }
    }
}

#[tokio::test]
async fn probe_rejects_redirects_and_oversized_responses() {
    let (url, request) = serve(
        "302 Found",
        "Location: http://127.0.0.1:1/private\r\n",
        String::new(),
    )
    .await;
    let status = request_usage("fixture", "fixture-key", &url).await.unwrap();
    request.await.unwrap();
    assert!(status.error.unwrap().contains("302"));
    let (url, request) = serve("200 OK", "", "x".repeat(MAX_BYTES + 1)).await;
    assert!(request_usage("fixture", "fixture-key", &url)
        .await
        .unwrap_err()
        .contains("size limit"));
    request.await.unwrap();
}

#[tokio::test]
#[ignore = "Requires an explicitly supplied DISTILL_ZAI_API_KEY; reads quota without model usage"]
async fn live_zai_quota() {
    let key =
        std::env::var("DISTILL_ZAI_API_KEY").expect("Provide the key through the environment");
    let status = request_usage("live-check", &key, QUOTA_URL).await.unwrap();
    assert!(matches!(
        status.state,
        AccountState::Ready | AccountState::Limited
    ));
    assert!(!status.limits.is_empty());
    println!("{}", serde_json::to_string(&status).unwrap());
}
