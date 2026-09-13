//! Shared log-line redaction.
//!
//! `redact_log_line` masks the values of a fixed allowlist of secret-ish keys
//! (`authorization`, `api_key`, `token`, …) wherever they appear in a line. It
//! is applied to every string field of a diagnostic event before the event is
//! recorded (see `services::diagnostic_log`).
//!
//! NOTE: this is a *key-based* redactor — it scrubs `key=value` / `key: "value"`
//! pairs, not free-form prose. It cannot tell whether arbitrary text contains
//! user/LLM content.

pub(crate) fn redact_log_line(line: &str) -> String {
    [
        "authorization",
        "refresh_token",
        "access_token",
        "private_key",
        "secret_key",
        "api_key",
        "api-key",
        "apikey",
        "password",
        "secret",
        "token",
    ]
    .into_iter()
    .fold(line.to_string(), redact_sensitive_key)
}

fn redact_sensitive_key(line: String, key: &str) -> String {
    let mut redacted = line;
    // Lowercased once, then kept in step with `redacted` by applying every
    // replacement to both. `to_ascii_lowercase` preserves byte length and
    // `"[redacted]"` is already lowercase, so the two stay byte-aligned — which
    // is what lets the indices found in `lower` be used on `redacted`. Rebuilding
    // this copy inside the loop made the pass O(matches x len) per key, so a
    // large field with many matches cost quadratic copying.
    let mut lower = redacted.to_ascii_lowercase();
    let mut search_start = 0;

    loop {
        let Some(relative_key_start) = lower[search_start..].find(key) else {
            break;
        };
        let key_start = search_start + relative_key_start;
        let key_end = key_start + key.len();

        if !is_key_end(lower.as_bytes(), key_end) {
            search_start = key_end;
            continue;
        }

        let mut delimiter_index = key_end;
        if matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b'"' | b'\'')
        ) {
            delimiter_index += 1;
        }
        delimiter_index = skip_ascii_whitespace(lower.as_bytes(), delimiter_index);

        if !matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b':' | b'=')
        ) {
            search_start = delimiter_index;
            continue;
        }

        let mut value_start = skip_ascii_whitespace(lower.as_bytes(), delimiter_index + 1);
        let quote = match lower.as_bytes().get(value_start).copied() {
            Some(b'"') => {
                value_start += 1;
                Some(b'"')
            }
            Some(b'\'') => {
                value_start += 1;
                Some(b'\'')
            }
            _ => None,
        };

        let value_end = find_value_end(lower.as_bytes(), value_start, quote, key);
        if value_end <= value_start {
            search_start = value_start;
            continue;
        }

        redacted.replace_range(value_start..value_end, "[redacted]");
        lower.replace_range(value_start..value_end, "[redacted]");
        search_start = value_start + "[redacted]".len();
    }

    redacted
}

/// Whether a secret-ish key ends at `key_end`. Only the trailing edge is a
/// boundary: the key may be the tail of a longer identifier, because that is
/// how secrets are actually spelled — `ANTHROPIC_API_KEY=`, `GITHUB_TOKEN=`,
/// `x-api-key:`, `client_secret=`, `accessToken:`. Requiring a leading
/// boundary too let every one of those through unredacted. A trailing key
/// character still disqualifies the match (`tokens=`, `token_count=`).
fn is_key_end(bytes: &[u8], key_end: usize) -> bool {
    !bytes
        .get(key_end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
}

fn skip_ascii_whitespace(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        index += 1;
    }
    index
}

fn find_value_end(bytes: &[u8], value_start: usize, quote: Option<u8>, key: &str) -> usize {
    if let Some(quote) = quote {
        return bytes[value_start..]
            .iter()
            .position(|byte| *byte == quote)
            .map(|relative| value_start + relative)
            .unwrap_or(bytes.len());
    }

    let allow_spaces = key == "authorization";
    let mut value_end = value_start;
    while let Some(byte) = bytes.get(value_end) {
        if matches!(*byte, b',' | b';' | b'&') || (!allow_spaces && byte.is_ascii_whitespace()) {
            break;
        }
        value_end += 1;
    }
    value_end
}

#[cfg(test)]
mod tests {
    use super::redact_log_line;

    #[test]
    fn redacts_common_secret_key_value_pairs() {
        let redacted =
            redact_log_line("token=abc123 api_key: xyz password = hunter2 secret='keep' ok=value");

        assert_eq!(
            redacted,
            "token=[redacted] api_key: [redacted] password = [redacted] secret='[redacted]' ok=value"
        );
    }

    #[test]
    fn redacts_json_style_secret_values() {
        let redacted =
            redact_log_line(r#"{"authorization":"Bearer abc.def","SECRET_KEY":"local-secret"}"#);

        assert_eq!(
            redacted,
            r#"{"authorization":"[redacted]","SECRET_KEY":"[redacted]"}"#
        );
    }

    #[test]
    fn redacts_keys_that_end_a_longer_identifier() {
        let redacted = redact_log_line(
            "ANTHROPIC_API_KEY=sk-ant-1 GITHUB_TOKEN=ghp_2 x-api-key: k3 client_secret=s4",
        );

        assert_eq!(
            redacted,
            "ANTHROPIC_API_KEY=[redacted] GITHUB_TOKEN=[redacted] x-api-key: [redacted] client_secret=[redacted]"
        );
        assert_eq!(
            redact_log_line(r#"{"accessToken":"a1","refreshToken":"r2"}"#),
            r#"{"accessToken":"[redacted]","refreshToken":"[redacted]"}"#
        );
    }

    #[test]
    fn leaves_keys_that_only_start_with_a_secret_word_alone() {
        assert_eq!(
            redact_log_line("tokens=12 token_count=3 passwords_set=true"),
            "tokens=12 token_count=3 passwords_set=true"
        );
    }

    #[test]
    fn redacts_unquoted_authorization_header_value_with_spaces() {
        let redacted = redact_log_line("Authorization: Bearer abc.def, status=401");

        assert_eq!(redacted, "Authorization: [redacted], status=401");
    }
}
