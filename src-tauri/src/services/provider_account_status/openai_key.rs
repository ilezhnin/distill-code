//! A Codex account connected with an OpenAI API key has no plan window to
//! read. Its status is whether OpenAI accepts the key, asked with a model
//! list that spends nothing, and, while the owner keeps an organization
//! admin key for the account, what the organization spent this month
//! (the Costs API). OpenAI offers no API for the prepaid credit balance.

use std::time::Duration;

use chrono::Datelike;
use serde_json::Value;
use tauri::AppHandle;

use super::{now_ms, types::*};
use crate::services::provider_accounts::{self, ProviderAccount};

const API_BASE: &str = "https://api.openai.com/v1";
const MAX_BYTES: usize = 1024 * 1024;
/// A month is at most 31 daily buckets, one page; more pages are a surprise.
const MAX_PAGES: usize = 4;

pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    let now = now_ms();
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now);
    status.subscription = Some("API".into());
    if !provider_accounts::account_has_credentials(app, account)? {
        status.state = AccountState::NeedsAuth;
        return Ok(status);
    }
    let key = provider_accounts::api_key(app, account)?;
    // An unreadable admin key costs the spend line, not the key check.
    let admin_key = provider_accounts::admin_key(app, account);
    let saved = admin_key.as_ref().ok().and_then(Option::as_deref);
    let mut status = read(status, API_BASE, &key, saved, now).await?;
    if let Err(error) = admin_key {
        status.spend = Some(ApiSpend {
            amount: None,
            currency: None,
            since: month_start(now),
            error: Some(error),
        });
    }
    Ok(status)
}

async fn read(
    mut status: ProviderAccountStatus,
    base: &str,
    key: &str,
    admin_key: Option<&str>,
    now: i64,
) -> Result<ProviderAccountStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the OpenAI key check")?;
    // Never keep provider error bodies: they may echo credential material.
    match send(&client, &format!("{base}/models"), key).await {
        // A key restricted from listing models is still a key OpenAI knows.
        Ok(response) if matches!(response.status().as_u16(), 200 | 403) => {
            status.state = AccountState::Ready;
            status.key_verified = true;
        }
        Ok(response) if response.status().as_u16() == 401 => {
            status.state = AccountState::NeedsAuth;
            status.error = Some("OpenAI rejected the saved API key; enter a new one".into());
        }
        Ok(response) => {
            status.state = AccountState::Error;
            status.stale = true;
            status.error = Some(format!(
                "OpenAI could not check the API key (code {}); try refreshing",
                response.status().as_u16()
            ));
        }
        Err(error) => {
            status.state = AccountState::Error;
            status.stale = true;
            status.error = Some(error);
        }
    }
    // A rejected key is re-entered first; its card shows nothing else.
    if let Some(admin_key) = admin_key.filter(|_| status.state != AccountState::NeedsAuth) {
        status.spend = Some(month_spend(&client, base, admin_key, now).await);
    }
    Ok(status)
}

async fn send(client: &reqwest::Client, url: &str, key: &str) -> Result<reqwest::Response, String> {
    client
        .get(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "Could not reach OpenAI; try refreshing".into())
}

async fn month_spend(client: &reqwest::Client, base: &str, admin_key: &str, now: i64) -> ApiSpend {
    let since = month_start(now);
    let mut spend = ApiSpend {
        amount: None,
        currency: None,
        since,
        error: None,
    };
    match read_costs(client, base, admin_key, since).await {
        Ok((amount, currency)) => {
            spend.amount = Some(amount);
            // OpenAI bills in dollars; a month with no spend lists no amounts.
            spend.currency = Some(currency.unwrap_or_else(|| "USD".into()));
        }
        Err(error) => spend.error = Some(error),
    }
    spend
}

async fn read_costs(
    client: &reqwest::Client,
    base: &str,
    admin_key: &str,
    since: i64,
) -> Result<(f64, Option<String>), String> {
    let mut total = 0.0;
    let mut currency = None;
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = url::Url::parse(&format!("{base}/organization/costs"))
            .map_err(|_| "Invalid OpenAI costs address")?;
        url.query_pairs_mut()
            .append_pair("start_time", &(since / 1000).to_string())
            .append_pair("bucket_width", "1d")
            .append_pair("limit", "31");
        if let Some(cursor) = &page {
            url.query_pairs_mut().append_pair("page", cursor);
        }
        let mut response = send(client, url.as_str(), admin_key).await?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => {
                return Err(
                    "OpenAI refused the admin key; spend needs an organization Admin key".into(),
                )
            }
            429 => return Err("OpenAI paused spend reads; they resume shortly".into()),
            code => {
                return Err(format!(
                    "OpenAI could not return spend (code {code}); try refreshing"
                ))
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read OpenAI spend")?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err("OpenAI spend response exceeded the size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "OpenAI returned an invalid spend response")?;
        page = add_costs(&body, &mut total, &mut currency)?;
        if page.is_none() {
            return Ok((total, currency));
        }
    }
    Err("OpenAI returned more spend pages than expected".into())
}

/// Adds one costs page to the running total; the cursor of the next page, if any.
fn add_costs(
    body: &Value,
    total: &mut f64,
    currency: &mut Option<String>,
) -> Result<Option<String>, String> {
    let buckets = body["data"]
        .as_array()
        .ok_or("OpenAI returned no spend data")?;
    for result in buckets
        .iter()
        .filter_map(|bucket| bucket["results"].as_array())
        .flatten()
    {
        let amount = &result["amount"];
        let Some(value) = amount["value"]
            .as_f64()
            .or_else(|| amount["value"].as_str()?.trim().parse().ok())
            .filter(|value: &f64| value.is_finite())
        else {
            continue;
        };
        if let Some(unit) = amount["currency"].as_str() {
            let unit = unit.trim().to_ascii_uppercase();
            match currency {
                Some(known) if *known != unit => {
                    return Err("OpenAI reported spend in more than one currency".into())
                }
                Some(_) => {}
                None => *currency = Some(unit),
            }
        }
        *total += value;
    }
    if body["has_more"] != true {
        return Ok(None);
    }
    body["next_page"]
        .as_str()
        .filter(|cursor| !cursor.is_empty())
        .map(|cursor| Some(cursor.to_owned()))
        .ok_or_else(|| "OpenAI returned an incomplete spend list".into())
}

/// The start of `now`'s calendar month in UTC, as OpenAI's billing counts it.
fn month_start(now: i64) -> i64 {
    chrono::DateTime::from_timestamp_millis(now)
        .and_then(|time| time.date_naive().with_day(1))
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .map(|start| start.and_utc().timestamp_millis())
        .unwrap_or(now)
}

#[cfg(test)]
mod tests;
