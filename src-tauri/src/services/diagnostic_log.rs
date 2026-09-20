use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::services::log_redaction::redact_log_line;

const MAX_EVENT_NAME_BYTES: usize = 64;
const MAX_FIELD_COUNT: usize = 32;
const MAX_FIELD_KEY_BYTES: usize = 64;
const MAX_FIELD_STRING_BYTES: usize = 4096;
const TRUNCATION_MARKER: &str = "...[truncated]";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticCategory {
    Startup,
    AgentHost,
    Renderer,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum DiagnosticFieldValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
}

impl From<&str> for DiagnosticFieldValue {
    fn from(value: &str) -> Self {
        Self::String(value.to_string())
    }
}

impl From<String> for DiagnosticFieldValue {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<u16> for DiagnosticFieldValue {
    fn from(value: u16) -> Self {
        Self::Number(value.into())
    }
}

impl From<u32> for DiagnosticFieldValue {
    fn from(value: u32) -> Self {
        Self::Number(value.into())
    }
}

impl From<u64> for DiagnosticFieldValue {
    fn from(value: u64) -> Self {
        Self::Number(value.into())
    }
}

impl From<i64> for DiagnosticFieldValue {
    fn from(value: i64) -> Self {
        Self::Number(value.into())
    }
}

impl From<bool> for DiagnosticFieldValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticEventInput {
    pub level: DiagnosticLevel,
    pub category: DiagnosticCategory,
    pub event: String,
    pub elapsed_ms: Option<u64>,
    pub fields: Option<BTreeMap<String, DiagnosticFieldValue>>,
}

#[derive(Debug)]
struct DiagnosticLogRecord {
    category: DiagnosticCategory,
    event: String,
    elapsed_ms: Option<u64>,
    app_version: &'static str,
    platform: &'static str,
    fields: BTreeMap<String, DiagnosticFieldValue>,
}

pub(crate) fn write_event(input: DiagnosticEventInput) -> Result<(), String> {
    let level = input.level;
    let record = build_record(input)?;
    write_record(level, &record)
}

pub(crate) fn record_event(
    level: DiagnosticLevel,
    category: DiagnosticCategory,
    event: &str,
    elapsed_ms: Option<u64>,
    fields: BTreeMap<String, DiagnosticFieldValue>,
) {
    let input = DiagnosticEventInput {
        level,
        category,
        event: event.to_string(),
        elapsed_ms,
        fields: Some(fields),
    };
    if let Err(error) = write_event(input) {
        log::debug!("[diagnostic] write skipped: {error}");
    }
}

pub(crate) fn record_panic(message: String, backtrace: String) {
    let input = DiagnosticEventInput {
        level: DiagnosticLevel::Error,
        category: DiagnosticCategory::Startup,
        event: "rust_panic".to_string(),
        elapsed_ms: None,
        fields: Some(BTreeMap::from([
            ("message".to_string(), DiagnosticFieldValue::String(message)),
            (
                "backtrace".to_string(),
                DiagnosticFieldValue::String(backtrace),
            ),
        ])),
    };

    if let Err(error) = write_event(input) {
        log::debug!("[diagnostic] panic write skipped: {error}");
    }
}

fn build_record(input: DiagnosticEventInput) -> Result<DiagnosticLogRecord, String> {
    validate_event_name(&input.event)?;
    let fields = sanitize_fields(input.fields.unwrap_or_default())?;

    Ok(DiagnosticLogRecord {
        category: input.category,
        event: input.event,
        elapsed_ms: input.elapsed_ms,
        app_version: env!("DISTILL_BUILD_VERSION"),
        platform: std::env::consts::OS,
        fields,
    })
}

fn sanitize_fields(
    fields: BTreeMap<String, DiagnosticFieldValue>,
) -> Result<BTreeMap<String, DiagnosticFieldValue>, String> {
    if fields.len() > MAX_FIELD_COUNT {
        return Err(format!(
            "Diagnostic event has too many fields (max {MAX_FIELD_COUNT})"
        ));
    }

    let mut sanitized = BTreeMap::new();
    for (key, value) in fields {
        validate_field_key(&key)?;
        sanitized.insert(key.clone(), sanitize_field_value(&key, value)?);
    }
    Ok(sanitized)
}

fn sanitize_field_value(
    key: &str,
    value: DiagnosticFieldValue,
) -> Result<DiagnosticFieldValue, String> {
    match value {
        DiagnosticFieldValue::Null
        | DiagnosticFieldValue::Bool(_)
        | DiagnosticFieldValue::Number(_) => Ok(value),
        DiagnosticFieldValue::String(value) => {
            if is_sensitive_field_key(key) {
                return Ok(DiagnosticFieldValue::String("[redacted]".to_string()));
            }
            // Truncate first. Redaction costs O(keys x matches x len), and the
            // renderer can hand us a multi-megabyte field (a stringified
            // transcript, a stack trace) that is going to be cut to 4 KB anyway —
            // redacting it whole was megabytes of scanning for a result nobody
            // sees. The second truncate bounds the output again, because
            // "[redacted]" can be longer than the value it replaces.
            Ok(DiagnosticFieldValue::String(truncate_string(
                &redact_log_line(&truncate_string(&value)),
            )))
        }
    }
}

fn validate_event_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_EVENT_NAME_BYTES {
        return Err(format!(
            "Diagnostic event names must be 1-{MAX_EVENT_NAME_BYTES} bytes"
        ));
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err("Diagnostic event name must not be empty".to_string());
    };
    if !first.is_ascii_lowercase() {
        return Err("Diagnostic event name must start with a lowercase ASCII letter".to_string());
    }
    if !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_') {
        return Err(
            "Diagnostic event names may only contain lowercase ASCII letters, digits, and underscores"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_field_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_FIELD_KEY_BYTES {
        return Err(format!(
            "Diagnostic field keys must be 1-{MAX_FIELD_KEY_BYTES} bytes"
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            "Diagnostic field keys may only contain ASCII letters, digits, and underscores"
                .to_string(),
        );
    }
    Ok(())
}

fn is_sensitive_field_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "authorization",
        "refresh_token",
        "access_token",
        "secret_key",
        "api_key",
        "apikey",
        "password",
        "secret",
        "token",
    ]
    .into_iter()
    .any(|needle| lower.contains(needle))
}

fn truncate_string(value: &str) -> String {
    if value.len() <= MAX_FIELD_STRING_BYTES {
        return value.to_string();
    }

    let max_prefix_bytes = MAX_FIELD_STRING_BYTES.saturating_sub(TRUNCATION_MARKER.len());
    let mut end = max_prefix_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], TRUNCATION_MARKER)
}

fn write_record(level: DiagnosticLevel, record: &DiagnosticLogRecord) -> Result<(), String> {
    let line = format_record(record);
    match level {
        DiagnosticLevel::Info => log::info!("[diagnostic] {line}"),
        DiagnosticLevel::Warn => log::warn!("[diagnostic] {line}"),
        DiagnosticLevel::Error => log::error!("[diagnostic] {line}"),
    }
    Ok(())
}

fn format_record(record: &DiagnosticLogRecord) -> String {
    let mut parts = vec![
        format!(
            "category={}",
            format_value(&DiagnosticFieldValue::String(
                category_name(record.category).to_string()
            ))
        ),
        format!(
            "event={}",
            format_value(&DiagnosticFieldValue::String(record.event.clone()))
        ),
        format!(
            "app_version={}",
            format_value(&DiagnosticFieldValue::String(
                record.app_version.to_string()
            ))
        ),
        format!(
            "platform={}",
            format_value(&DiagnosticFieldValue::String(record.platform.to_string()))
        ),
    ];

    if let Some(elapsed_ms) = record.elapsed_ms {
        parts.push(format!("elapsed_ms={elapsed_ms}"));
    }

    parts.extend(
        record
            .fields
            .iter()
            .map(|(key, value)| format!("{key}={}", format_value(value))),
    );

    parts.join(" ")
}

fn category_name(category: DiagnosticCategory) -> &'static str {
    match category {
        DiagnosticCategory::Startup => "startup",
        DiagnosticCategory::AgentHost => "agentHost",
        DiagnosticCategory::Renderer => "renderer",
    }
}

fn format_value(value: &DiagnosticFieldValue) -> String {
    match value {
        DiagnosticFieldValue::Null => "null".to_string(),
        DiagnosticFieldValue::Bool(value) => value.to_string(),
        DiagnosticFieldValue::Number(value) => value.to_string(),
        DiagnosticFieldValue::String(value) if is_bare_value(value) => value.to_string(),
        DiagnosticFieldValue::String(value) => quote_value(value),
    }
}

fn is_bare_value(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':' | b'@')
        })
}

fn quote_value(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if character.is_control() => {
                quoted.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitized_string(value: &str) -> String {
        match sanitize_field_value("message", DiagnosticFieldValue::String(value.to_string()))
            .expect("sanitize")
        {
            DiagnosticFieldValue::String(value) => value,
            other => panic!("expected a string, got {other:?}"),
        }
    }

    #[test]
    fn a_huge_field_is_cut_down_before_it_is_scanned_for_secrets() {
        // Redaction is O(keys x matches x len). Before the field was truncated
        // first, a renderer-supplied transcript like this one meant tens of GB of
        // copying inside a *sync* command — seconds of frozen UI — for a result
        // that was then cut to 4 KB anyway.
        let mut huge = String::new();
        while huge.len() < 2 * 1024 * 1024 {
            huge.push_str("token=abcdefgh secret: 0123456789 ok=value ");
        }

        let started = std::time::Instant::now();
        let sanitized = sanitized_string(&huge);

        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "sanitizing one field took {:?}",
            started.elapsed()
        );
        assert!(sanitized.len() <= MAX_FIELD_STRING_BYTES);
        assert!(sanitized.ends_with(TRUNCATION_MARKER));
        assert!(!sanitized.contains("abcdefgh"), "{sanitized}");
        assert!(!sanitized.contains("0123456789"), "{sanitized}");
    }

    #[test]
    fn a_secret_straddling_the_truncation_boundary_is_still_redacted() {
        // Truncating before redacting must not leave the visible half of a secret
        // behind.
        let prefix = "x".repeat(MAX_FIELD_STRING_BYTES - 30);
        let sanitized = sanitized_string(&format!("{prefix} token=sk-do-not-log-this-value"));

        assert!(!sanitized.contains("sk-do-not-log"), "{sanitized}");
        assert!(sanitized.contains("[redacted]"), "{sanitized}");
    }

    #[test]
    fn every_occurrence_is_redacted_whatever_its_case() {
        // Guards the single lowercase copy staying in step with the redacted one.
        let sanitized = sanitized_string(
            "TOKEN=aaa then token=bbb then Api_Key: ccc then AUTHORIZATION: Bearer ddd, end=1",
        );

        for leaked in ["aaa", "bbb", "ccc", "ddd"] {
            assert!(!sanitized.contains(leaked), "leaked {leaked}: {sanitized}");
        }
        assert_eq!(sanitized.matches("[redacted]").count(), 4, "{sanitized}");
        assert!(sanitized.ends_with("end=1"), "{sanitized}");
    }

    #[test]
    fn validates_and_sanitizes_diagnostic_event_fields() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "message".to_string(),
            DiagnosticFieldValue::String("Authorization: Bearer abc123".to_string()),
        );
        fields.insert(
            "apiKey".to_string(),
            DiagnosticFieldValue::String("secret".to_string()),
        );
        fields.insert("lineCount".to_string(), 3_u64.into());

        let record = build_record(DiagnosticEventInput {
            level: DiagnosticLevel::Error,
            category: DiagnosticCategory::Renderer,
            event: "window_error".to_string(),
            elapsed_ms: Some(42),
            fields: Some(fields),
        })
        .unwrap();

        assert_eq!(record.event, "window_error");
        assert_eq!(record.elapsed_ms, Some(42));
        assert_eq!(
            record.fields.get("apiKey"),
            Some(&DiagnosticFieldValue::String("[redacted]".to_string()))
        );
        assert_eq!(
            record.fields.get("message"),
            Some(&DiagnosticFieldValue::String(
                "Authorization: [redacted]".to_string()
            ))
        );
        assert_eq!(
            record.fields.get("lineCount"),
            Some(&DiagnosticFieldValue::Number(3_u64.into()))
        );
    }
}
