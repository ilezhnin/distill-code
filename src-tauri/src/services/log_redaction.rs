//! Shared log-line redaction.
//!
//! `redact_log_line` masks what looks like a credential in one line of text:
//! the values of a fixed list of secret-ish keys (`authorization`, `api_key`,
//! `token`, …), a token after a bare `Bearer`, the secret parameters of a URL
//! query (`?code=`, `&sig=`) and provider keys that stand alone (`sk-…`). It
//! is applied to every string field of a diagnostic event before the event is
//! recorded (see `services::diagnostic_log`), and to what a bridge writes on
//! stderr and a provider CLI prints while it is set up or signed in, before
//! either reaches the app log: the log lives in the Flock root, which the
//! agents of every provider can read.
//!
//! NOTE: this is a *shape-based* redactor — it scrubs `key=value` / `key: "value"`
//! pairs and the few value shapes listed above, not free-form prose. It cannot
//! tell whether arbitrary text contains user/LLM content.

const REDACTED: &str = "[redacted]";

pub(crate) fn redact_log_line(line: &str) -> String {
    let keyed = [
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
        "cookie",
        "token",
    ]
    .into_iter()
    .fold(line.to_string(), redact_sensitive_key);
    redact_bare_credentials(redact_bearer_tokens(redact_url_parameters(keyed)))
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

    while let Some(relative_key_start) = lower[search_start..].find(key) {
        let key_start = search_start + relative_key_start;
        let key_end = key_start + key.len();

        if !is_key_end(lower.as_bytes(), key_end) {
            search_start = key_end;
            continue;
        }

        let mut delimiter_index = key_end;
        if let Some(quote) = quote_at(lower.as_bytes(), delimiter_index) {
            delimiter_index = quote.after;
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
        let quote = quote_at(lower.as_bytes(), value_start);
        if let Some(quote) = &quote {
            value_start = quote.after;
        }

        let value_end = find_value_end(lower.as_bytes(), value_start, quote.as_ref(), key);
        if value_end <= value_start {
            search_start = value_start;
            continue;
        }

        redacted.replace_range(value_start..value_end, REDACTED);
        lower.replace_range(value_start..value_end, REDACTED);
        search_start = value_start + REDACTED.len();
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

/// A quote that opens or closes a key or a value.
struct Quote {
    byte: u8,
    /// The backslashes in front of it. JSON carried inside a JSON string
    /// writes its quotes as `\"` (and as `\\\"` one level further in), so the
    /// delimiter is the quote together with its backslashes.
    escapes: usize,
    /// Where the text behind the quote starts.
    after: usize,
}

fn quote_at(bytes: &[u8], index: usize) -> Option<Quote> {
    let mut quote_index = index;
    while bytes.get(quote_index) == Some(&b'\\') {
        quote_index += 1;
    }
    match bytes.get(quote_index).copied() {
        Some(byte @ (b'"' | b'\'')) => Some(Quote {
            byte,
            escapes: quote_index - index,
            after: quote_index + 1,
        }),
        _ => None,
    }
}

fn find_value_end(bytes: &[u8], value_start: usize, quote: Option<&Quote>, key: &str) -> usize {
    if let Some(quote) = quote {
        // The value ends at the quote escaped as its opening one was. A quote
        // behind more backslashes is a quote inside the value: stopping there
        // would log the rest of the secret.
        let mut index = value_start;
        while let Some(relative) = bytes[index..].iter().position(|byte| *byte == quote.byte) {
            let quote_index = index + relative;
            let escapes = bytes[value_start..quote_index]
                .iter()
                .rev()
                .take_while(|byte| **byte == b'\\')
                .count();
            if escapes <= quote.escapes {
                return quote_index - escapes;
            }
            index = quote_index + 1;
        }
        return bytes.len();
    }

    if key == "cookie" {
        // A cookie header is one secret after another, `;` between them: the
        // rest of the line goes.
        return bytes[value_start..]
            .iter()
            .position(|byte| matches!(*byte, b'\r' | b'\n'))
            .map_or(bytes.len(), |relative| value_start + relative);
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

/// Query parameters that carry a credential under exactly this name: an OAuth
/// authorization or device code, the signature of a signed link.
const SECRET_URL_PARAMETERS: &[&str] = &["code", "device_code", "sig"];
/// Query parameters that carry one under any name that is, or ends in, one of
/// these words: `key`, `subscription-key`, `X-Amz-Signature`.
const SECRET_URL_PARAMETER_ENDINGS: &[&str] = &["key", "signature"];

/// Mask the secret parameters of a URL query or a form body. Only a
/// parameter that follows `?` or `&` counts: `code` and `key` are ordinary
/// words everywhere else (`exit code=1`), and a line without a secret has to
/// reach the log as it was written.
fn redact_url_parameters(line: String) -> String {
    if !line.contains('=') {
        return line;
    }
    let bytes = line.as_bytes();
    let mut redacted = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let Some(name_start) = url_parameter_start(&line, index) else {
            index += 1;
            continue;
        };
        let mut name_end = name_start;
        while bytes
            .get(name_end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-' | b'.'))
        {
            name_end += 1;
        }
        if bytes.get(name_end) != Some(&b'=')
            || !is_secret_url_parameter(&line[name_start..name_end])
        {
            index = name_start;
            continue;
        }
        let value_start = name_end + 1;
        let mut value_end = value_start;
        while bytes
            .get(value_end)
            .is_some_and(|byte| !ends_url_value(*byte))
        {
            value_end += 1;
        }
        if value_end > value_start && !is_flag_value(&line[value_start..value_end]) {
            redacted.push_str(&line[copied..value_start]);
            redacted.push_str(REDACTED);
            copied = value_end;
        }
        index = value_end;
    }
    if copied == 0 {
        return line;
    }
    redacted.push_str(&line[copied..]);
    redacted
}

/// Where a parameter name starts when `index` is at what introduces one: `?`,
/// `&`, or `&` as HTML (`&amp;`) and as some JSON encoders (`\u0026`) write it.
fn url_parameter_start(line: &str, index: usize) -> Option<usize> {
    let rest = &line.as_bytes()[index..];
    if rest.starts_with(b"&amp;") {
        Some(index + "&amp;".len())
    } else if rest.starts_with(b"\\u0026") {
        Some(index + "\\u0026".len())
    } else if matches!(rest.first(), Some(b'?' | b'&')) {
        Some(index + 1)
    } else {
        None
    }
}

/// Words that, in front of `key`, name a lookup key rather than a
/// credential: npm's `cache-key`, an `Idempotency-Key`, a `public_key`.
const LOOKUP_KEY_WORDS: &[&str] = &["cache", "idempotency", "public"];

fn is_secret_url_parameter(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_URL_PARAMETERS.contains(&name.as_str())
        || SECRET_URL_PARAMETER_ENDINGS.iter().any(|ending| {
            name.strip_suffix(ending).is_some_and(|head| {
                head.is_empty()
                    || head
                        .strip_suffix(['_', '-', '.'])
                        .is_some_and(|words| !names_a_lookup_key(ending, words))
            })
        })
}

/// Whether `<words>-<ending>` names a key that finds something instead of
/// opening it (`cache-key`, `x-cache-key`).
fn names_a_lookup_key(ending: &str, words: &str) -> bool {
    let last_word = words.rsplit(['_', '-', '.']).next().unwrap_or(words);
    ending == "key" && LOOKUP_KEY_WORDS.contains(&last_word)
}

/// A flag a URL passes under a secret parameter's name: Claude's sign-in URL
/// asks `?code=true` to have the code shown on the page. No credential is
/// spelled `true` or `false`.
fn is_flag_value(value: &str) -> bool {
    value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false")
}

fn ends_url_value(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(
            byte,
            b'&' | b'#'
                | b'"'
                | b'\''
                | b'<'
                | b'>'
                | b'\\'
                | b'`'
                | b')'
                | b']'
                | b'}'
                | b','
                | b';'
                | b'|'
        )
}

/// The shortest run after `Bearer` that is taken for a token. Prose puts
/// ordinary words there (`Bearer authentication`), and none of them is this
/// long; no provider issues a token this short.
const BEARER_TOKEN_MIN_CHARS: usize = 16;

/// Mask the token after a `Bearer` that is not the value of an
/// `authorization` key (those are masked whole above): a header logged on its
/// own, or inside a list.
fn redact_bearer_tokens(line: String) -> String {
    const WORD: &[u8] = b"bearer";
    let bytes = line.as_bytes();
    let mut redacted = String::new();
    let mut copied = 0;
    let mut index = 0;
    while let Some(relative) = bytes[index..]
        .windows(WORD.len())
        .position(|window| window.eq_ignore_ascii_case(WORD))
    {
        let word_start = index + relative;
        let word_end = word_start + WORD.len();
        index = word_end;
        if word_start > 0 && bytes[word_start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let token_start = skip_ascii_whitespace(bytes, word_end);
        if token_start == word_end {
            continue;
        }
        let mut token_end = token_start;
        while bytes.get(token_end).is_some_and(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(*byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
        }) {
            token_end += 1;
        }
        if token_end - token_start < BEARER_TOKEN_MIN_CHARS {
            continue;
        }
        redacted.push_str(&line[copied..token_start]);
        redacted.push_str(REDACTED);
        copied = token_end;
        index = token_end;
    }
    if copied == 0 {
        return line;
    }
    redacted.push_str(&line[copied..]);
    redacted
}

/// How the keys of the providers Flock runs start when they stand in a line
/// with no key in front of them: OpenAI, Anthropic and Moonshot (`sk-`), xAI,
/// and the GitHub tokens Copilot signs in with.
const BARE_CREDENTIAL_PREFIXES: &[&str] = &[
    "sk-",
    "xai-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
];
/// How much has to follow a prefix for it to be a key and not a word that
/// merely starts the same way.
const BARE_CREDENTIAL_MIN_CHARS: usize = 20;

/// Whether what follows a prefix is shaped like the keys of the families
/// above. Each of them is a random base62 or hex string of 32 characters or
/// more, so it holds a digit or a capital letter: a random body of 32 lacks
/// both with odds below 1e-13. A run of lowercase words joined by `-` (a
/// package such as `xai-grok-cli-extensions-helper`) holds neither.
fn is_shaped_like_a_key(body: &[u8]) -> bool {
    body.len() >= BARE_CREDENTIAL_MIN_CHARS
        && body
            .iter()
            .any(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
}

/// Whether the run `start..end` is one segment of a file path or a URL path:
/// right behind a `/` or `\`, or right in front of one. A folder may be
/// named `sk-learn-experiments-2026`; a key does not stand there. Two
/// slashes open a URL's authority, where `https://<token>@host` carries a
/// credential, so they do not count. Nor does a backslash behind the run
/// that escapes a character in JSON carried inside a string (`\"`, `\n`).
fn is_path_segment(bytes: &[u8], start: usize, end: usize) -> bool {
    let opens_authority = start >= 2 && &bytes[start - 2..start] == b"//";
    let behind_a_separator = match start.checked_sub(1).map(|index| bytes[index]) {
        Some(b'/') => !opens_authority,
        Some(b'\\') => true,
        _ => false,
    };
    let in_front_of_a_separator = match bytes.get(end) {
        Some(b'/') => true,
        Some(b'\\') => !matches!(
            bytes.get(end + 1),
            Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' | b'u')
        ),
        _ => false,
    };
    behind_a_separator || in_front_of_a_separator
}

/// Mask a provider key that stands alone. The prefix stays: it says whose key
/// was printed, and nothing else about it.
fn redact_bare_credentials(line: String) -> String {
    let bytes = line.as_bytes();
    let is_key_byte = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-');
    let mut redacted = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        // `task-sk-…` is a word that happens to contain a prefix, not a key.
        let starts_a_word = index == 0 || !is_key_byte(bytes[index - 1]);
        let prefix = BARE_CREDENTIAL_PREFIXES
            .iter()
            .filter(|_| starts_a_word)
            .find(|prefix| bytes[index..].starts_with(prefix.as_bytes()));
        let Some(prefix) = prefix else {
            index += 1;
            continue;
        };
        let secret_start = index + prefix.len();
        let mut secret_end = secret_start;
        while bytes.get(secret_end).is_some_and(|byte| is_key_byte(*byte)) {
            secret_end += 1;
        }
        if is_shaped_like_a_key(&bytes[secret_start..secret_end])
            && !is_path_segment(bytes, index, secret_end)
        {
            redacted.push_str(&line[copied..secret_start]);
            redacted.push_str(REDACTED);
            copied = secret_end;
        }
        index = secret_end;
    }
    if copied == 0 {
        return line;
    }
    redacted.push_str(&line[copied..]);
    redacted
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

    /// JSON logged inside a JSON string writes its quotes with a backslash,
    /// once per level it is nested: the key is followed by `\"`, not `"`.
    #[test]
    fn redacts_json_carried_inside_a_json_string() {
        assert_eq!(
            redact_log_line(
                r#"{"body":"{\"access_token\":\"at-invented-1\",\"expires_in\":3600}"}"#
            ),
            r#"{"body":"{\"access_token\":\"[redacted]\",\"expires_in\":3600}"}"#
        );
        assert_eq!(
            redact_log_line(r#"payload={\\\"refresh_token\\\" : \\\"rt-invented-2\\\"} done"#),
            r#"payload={\\\"refresh_token\\\" : \\\"[redacted]\\\"} done"#
        );
        // A quote escaped inside the value does not end it.
        assert_eq!(
            redact_log_line(r#"{"password":"in\"vented","user":"example"}"#),
            r#"{"password":"[redacted]","user":"example"}"#
        );
    }

    #[test]
    fn redacts_a_bearer_token_that_follows_no_authorization_key() {
        assert_eq!(
            redact_log_line("sending header Bearer inv3nted.t0ken-value_0123456789 to the proxy"),
            "sending header Bearer [redacted] to the proxy"
        );
        assert_eq!(
            redact_log_line(r#"headers: ["bearer AbCdEfGhIjKlMnOpQrStUv=="]"#),
            r#"headers: ["bearer [redacted]"]"#
        );
        // Prose about the scheme is not a token.
        for line in [
            "401: Bearer authentication is required",
            "expected a Bearer token, got none",
            "Bearer <token> is missing",
            "the forbearer abcdefghijklmnopqrstuvwxyz stays",
        ] {
            assert_eq!(redact_log_line(line), line);
        }
    }

    #[test]
    fn redacts_the_secret_parameters_of_a_url() {
        assert_eq!(
            redact_log_line(
                "GET http://localhost:1455/auth/callback?code=invented-code-1&state=st-2 200"
            ),
            "GET http://localhost:1455/auth/callback?code=[redacted]&state=st-2 200"
        );
        assert_eq!(
            redact_log_line(
                "open https://example.test/v1/models?key=AIzaInvented3&alt=json#top then wait"
            ),
            "open https://example.test/v1/models?key=[redacted]&alt=json#top then wait"
        );
        assert_eq!(
            redact_log_line(
                "https://example.test/blob?sv=2024&sig=inv%2Bented4&X-Amz-Signature=5f5f&subscription-key=k6"
            ),
            "https://example.test/blob?sv=2024&sig=[redacted]&X-Amz-Signature=[redacted]&subscription-key=[redacted]"
        );
        assert_eq!(
            redact_log_line("body: client_id=app&device_code=dc-invented-7&grant_type=x"),
            "body: client_id=app&device_code=[redacted]&grant_type=x"
        );
        assert_eq!(
            redact_log_line(r#"<a href="https://example.test/cb?a=1&amp;code=c8">link</a>"#),
            r#"<a href="https://example.test/cb?a=1&amp;code=[redacted]">link</a>"#
        );
        assert_eq!(
            redact_log_line(r#"{"url":"https://example.test/cb?a=1\u0026code=c9\u0026b=2"}"#),
            r#"{"url":"https://example.test/cb?a=1\u0026code=[redacted]\u0026b=2"}"#
        );
        // `token` in a query was already covered by the key list.
        assert_eq!(
            redact_log_line("ws://127.0.0.1:9000/socket?token=invented10&v=2"),
            "ws://127.0.0.1:9000/socket?token=[redacted]&v=2"
        );
    }

    #[test]
    fn redacts_cookie_headers_whole() {
        assert_eq!(
            redact_log_line("Cookie: session=inv11; csrf=inv12"),
            "Cookie: [redacted]"
        );
        assert_eq!(
            redact_log_line(r#"{"set-cookie":"sid=inv13; Path=/; HttpOnly","status":200}"#),
            r#"{"set-cookie":"[redacted]","status":200}"#
        );
        assert_eq!(redact_log_line("cookies=3 sent"), "cookies=3 sent");
    }

    #[test]
    fn redacts_provider_keys_that_stand_alone() {
        assert_eq!(
            redact_log_line("using sk-ant-api03-InventedInventedInvented-0000 for the request"),
            "using sk-[redacted] for the request"
        );
        assert_eq!(
            redact_log_line(r#"argv: ["--key","xai-InventedInventedInvented0000"]"#),
            r#"argv: ["--key","xai-[redacted]"]"#
        );
        assert_eq!(
            redact_log_line("remote: https://gho_InventedInventedInvented0000@example.test/repo"),
            "remote: https://gho_[redacted]@example.test/repo"
        );
        // A word that only starts like a key, and a key-like tail of a word.
        for line in [
            "sk-learn is not installed",
            "task-sk-abcdefghijklmnopqrstuvwxyz0123 queued",
        ] {
            assert_eq!(redact_log_line(line), line);
        }
    }

    /// Lines a bridge or a setup command printed that the redactor masked
    /// though they carry no secret (bug hunt of 2026-11-25): a folder whose
    /// name starts like a key, a package named with lowercase words, the
    /// `code=true` flag of Claude's sign-in URL and an npm cache key.
    #[test]
    fn leaves_key_like_folder_names_and_url_flags_unchanged() {
        for line in [
            r"[claude] Reading C:\Users\op\projects\sk-learn-experiments-2026-notebook\run.py",
            r"[codex] cwd=E:\work\ghs_tools-for-unity-builds-2026\Assets",
            "GET https://registry.npmjs.org/xai-sdk-tools-for-grok-2026-build/-/x.tgz 200",
            "python sk-learn-experiments-2026-notebook/run.py",
            "npm warn deprecated xai-grok-cli-extensions-helper: use xai-grok-cli",
            "[setup] Open https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code",
            "https://example.test/cb?code=FALSE&state=st-1",
            "[npm] GET https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz?cache-key=abc123",
            "POST https://example.test/v1/orders?idempotency_key=ord-77&public-key=pk1",
        ] {
            assert_eq!(redact_log_line(line), line, "{line}");
        }
    }

    /// Keys still masked under the shape rules: next to a slash that starts a
    /// URL's authority or a quote escaped in JSON, a key of lowercase hex, and
    /// a key that ends a sentence.
    #[test]
    fn redacts_keys_that_only_sit_next_to_a_slash() {
        assert_eq!(
            redact_log_line("remote: https://ghp_InventedInventedInvented0000@example.test/repo"),
            "remote: https://ghp_[redacted]@example.test/repo"
        );
        assert_eq!(
            redact_log_line(r#"{"body":"{\"auth\":\"sk-proj-InventedInventedInvented0000\"}"}"#),
            r#"{"body":"{\"auth\":\"sk-[redacted]\"}"}"#
        );
        assert_eq!(
            redact_log_line(r#"{"stderr":"using xai-InventedInventedInvented0000\nretrying"}"#),
            r#"{"stderr":"using xai-[redacted]\nretrying"}"#
        );
        assert_eq!(
            redact_log_line("key sk-0123456789abcdef0123456789abcdef."),
            "key sk-[redacted]."
        );
        assert_eq!(
            redact_log_line("https://example.test/cb?code=AbCdEf0123456789&state=st-1"),
            "https://example.test/cb?code=[redacted]&state=st-1"
        );
    }

    /// What a bridge and a provider CLI ordinarily print carries no secret
    /// and reaches the log as it was written.
    #[test]
    fn leaves_lines_without_a_secret_unchanged() {
        for line in [
            "",
            "[2026-11-24T10:00:00Z] INFO session ready in 412 ms",
            r"spawned C:\Users\example\AppData\Local\tool\bin\agent.cmd --stdio",
            "process exited with exit code=1, signal=none",
            "status code: 404 for GET https://example.test/v1/models?limit=20&after=abc",
            r#"{"jsonrpc":"2.0","id":7,"method":"session/update","params":{"sessionId":"s1"}}"#,
            "Open https://example.test/device and enter the code shown in the terminal",
            "authorize at https://example.test/oauth/authorize?response_type=code&client_id=app&code_challenge=abc&code_challenge_method=S256&state=xyz",
            "hotkey=ctrl+c monkey=banana zipcode=00000 country_code=US",
            "npm warn deprecated example@1.0.0: use example-next",
            "Привет, мир: строка без секретов",
        ] {
            assert_eq!(redact_log_line(line), line, "{line}");
        }
    }
}
