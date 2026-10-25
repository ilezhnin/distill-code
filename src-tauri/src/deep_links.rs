use percent_encoding::percent_decode_str;
#[cfg(feature = "flockctl")]
use serde::Serialize;
#[cfg(feature = "flockctl")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[cfg(feature = "flockctl")]
const SESSION_DEEP_LINK_ERROR_EVENT: &str = "flock:session-deep-link-error";

#[cfg(feature = "flockctl")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeepLinkErrorPayload {
    session_id: String,
    message: String,
}

pub(crate) fn install<R: Runtime>(app: &tauri::App<R>) {
    // Handles links delivered while the app is already running. Startup
    // session links are drained by FlockctlBridge after the renderer command
    // registry has mounted.
    let deep_link_app = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        handle_urls(deep_link_app.clone(), event.urls());
    });
}

fn handle_urls<R: Runtime>(app: AppHandle<R>, urls: Vec<Url>) {
    let mut opened_session = false;
    for url in urls {
        log::info!("Received deep link: {url}");
        if !opened_session {
            if let Some(session_id) = parse_session_deep_link(&url) {
                opened_session = open_session(app.clone(), session_id);
            }
        }
    }
    focus_main_window(&app, opened_session);
}

/// Brings the main window in front of whatever the operator was looking at;
/// with `reveal`, shows it first. A minimized window is restored either way,
/// since focus alone leaves it in the taskbar.
pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>, reveal: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if reveal {
            let _ = window.show();
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

enum SessionDeepLinkRoute {
    Host,
    Path,
}

/// Schemes a session link may use, the one this build registers and creates
/// first. `distill` is the scheme of the links earlier builds wrote into
/// transcripts, notes and memory entries; those are not rewritten, so the
/// installer keeps registering both schemes and the parser accepts both.
/// Mirrors `SESSION_LINK_PROTOCOLS` in
/// `src/features/sessions/lib/sessionDeepLink.ts`.
const SESSION_DEEP_LINK_SCHEMES: [&str; 2] = ["flock", "distill"];

const SESSION_HOST_ROUTE: &str = "://session/";
const SESSION_PATH_ROUTE: &str = ":///session/";

/// The route is read off the raw text right after the scheme (so each scheme
/// is matched on its own length), not off the parsed URL: `Url` normalizes
/// `flock:/session/x` and `flock:session/x` into shapes the parsed view
/// cannot tell apart from a well-formed link.
fn raw_session_deep_link_route(url: &Url) -> Option<SessionDeepLinkRoute> {
    let scheme = url.scheme();
    if !SESSION_DEEP_LINK_SCHEMES.contains(&scheme) {
        return None;
    }

    let after_scheme = url.as_str().strip_prefix(scheme)?;
    if after_scheme.starts_with(SESSION_HOST_ROUTE) {
        return Some(SessionDeepLinkRoute::Host);
    }
    if after_scheme.starts_with(SESSION_PATH_ROUTE) {
        return Some(SessionDeepLinkRoute::Path);
    }
    None
}

fn parse_session_deep_link(url: &Url) -> Option<String> {
    let route = raw_session_deep_link_route(url)?;

    let mut segments = url.path_segments()?.collect::<Vec<_>>();
    let encoded_session_id = match (route, url.host_str()) {
        (SessionDeepLinkRoute::Host, Some("session")) if segments.len() == 1 => segments.pop(),
        (SessionDeepLinkRoute::Path, None | Some(""))
            if segments.len() == 2 && segments[0] == "session" =>
        {
            Some(segments[1])
        }
        _ => None,
    }?;

    percent_decode_str(encoded_session_id)
        .decode_utf8()
        .ok()
        .map(|session_id| session_id.into_owned())
        .filter(|session_id| !session_id.is_empty())
}

/// Opens a chat in the renderer through the `sessions open` app command, the
/// route a session link takes; the completion toast's click takes it too.
/// Returns whether an open was dispatched; a dispatch that fails is reported
/// to the renderer as a session-link error.
#[cfg(feature = "flockctl")]
pub(crate) fn open_session<R: Runtime>(app: AppHandle<R>, session_id: String) -> bool {
    tauri::async_runtime::spawn(async move {
        let requested_session_id = session_id.clone();
        let result = tauri_plugin_flockctl::dispatch_app_command(
            app.clone(),
            "sessions".to_string(),
            serde_json::json!({
                "action": "open",
                "session_id": session_id,
            }),
            None,
        )
        .await;
        match result {
            Ok(_) => {}
            Err(error) => {
                log::warn!("Failed to open session from deep link: {error}");
                let payload = session_deep_link_error_payload(&requested_session_id, &error);
                emit_session_deep_link_error(&app, payload);
            }
        }
    });
    true
}

#[cfg(feature = "flockctl")]
fn session_deep_link_error_payload(
    session_id: &str,
    error: &tauri_plugin_flockctl::AppCommandDispatchError,
) -> SessionDeepLinkErrorPayload {
    let message = match error {
        tauri_plugin_flockctl::AppCommandDispatchError::Command { message, .. }
            if !message.trim().is_empty() =>
        {
            message.clone()
        }
        _ => format!("Could not open session \"{session_id}\"."),
    };
    SessionDeepLinkErrorPayload {
        session_id: session_id.to_string(),
        message,
    }
}

#[cfg(feature = "flockctl")]
fn emit_session_deep_link_error<R: Runtime>(
    app: &AppHandle<R>,
    payload: SessionDeepLinkErrorPayload,
) {
    if let Err(error) = app.emit_to("main", SESSION_DEEP_LINK_ERROR_EVENT, payload) {
        log::warn!("Failed to emit session deep link error event: {error}");
    }
}

#[cfg(not(feature = "flockctl"))]
pub(crate) fn open_session<R: Runtime>(_app: AppHandle<R>, _session_id: String) -> bool {
    log::warn!("Ignoring session deep link because the flockctl feature is disabled");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<String> {
        Url::parse(raw)
            .ok()
            .and_then(|url| parse_session_deep_link(&url))
    }

    /// Compatibility pin: the registered scheme first, then the scheme of
    /// the links earlier builds wrote. A rename sweep that rewrites the
    /// legacy scheme collapses the two and fails here.
    /// The installer registers exactly the schemes the parsers accept, in
    /// the same order, so a link an earlier build wrote still reaches the app.
    #[test]
    fn the_installer_registers_every_accepted_scheme() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let registered: Vec<&str> = config["plugins"]["deep-link"]["desktop"]["schemes"]
            .as_array()
            .expect("deep-link schemes")
            .iter()
            .map(|scheme| scheme.as_str().expect("scheme"))
            .collect();
        assert_eq!(registered, SESSION_DEEP_LINK_SCHEMES);
    }

    #[test]
    fn accepted_schemes_are_flock_then_the_legacy_distill() {
        assert_eq!(SESSION_DEEP_LINK_SCHEMES[0], "flock");
        assert_ne!(SESSION_DEEP_LINK_SCHEMES[1], SESSION_DEEP_LINK_SCHEMES[0]);
        assert!(!SESSION_DEEP_LINK_SCHEMES[1].contains("flock"));
    }

    #[test]
    fn host_and_path_routes_parse_under_every_accepted_scheme() {
        for scheme in SESSION_DEEP_LINK_SCHEMES {
            assert_eq!(
                parse(&format!("{scheme}://session/session-1")).as_deref(),
                Some("session-1"),
                "{scheme}: host route"
            );
            assert_eq!(
                parse(&format!("{scheme}:///session/session-1")).as_deref(),
                Some("session-1"),
                "{scheme}: path route"
            );
            assert_eq!(
                parse(&format!(
                    "{scheme}://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93"
                ))
                .as_deref(),
                Some("id/with spaces?#%\u{2713}"),
                "{scheme}: an encoded id stays one path segment"
            );
        }
    }

    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        assert_eq!(
            parse("FLOCK://session/session-1").as_deref(),
            Some("session-1")
        );
        assert_eq!(
            parse("Distill://session/session-1").as_deref(),
            Some("session-1")
        );
    }

    /// The rejection matrix the renderer pins in
    /// `message.session-links.test.tsx`, under every accepted scheme.
    #[test]
    fn malformed_and_non_session_links_are_rejected_under_every_accepted_scheme() {
        for scheme in SESSION_DEEP_LINK_SCHEMES {
            for suffix in [
                "://connect-return",
                ":/session/session-1",
                ":session/session-1",
                "://session/",
                ":///session/",
                "://session/a/b",
                "://session/a//b",
                "://session/%FF",
                "://SESSION/session-1",
            ] {
                let raw = format!("{scheme}{suffix}");
                assert_eq!(parse(&raw), None, "{raw} must be rejected");
            }
        }
    }

    #[test]
    fn other_schemes_are_rejected() {
        for raw in [
            "berd://session/session-1",
            "https://session/session-1",
            "flocks://session/session-1",
            "flock-dev://session/session-1",
        ] {
            assert_eq!(parse(raw), None, "{raw} must be rejected");
        }
    }

    /// Mirrors `SESSION_DEEP_LINK_ERROR_EVENT` in
    /// `src/app/lib/sessionDeepLinkErrors.ts`.
    #[cfg(feature = "flockctl")]
    #[test]
    fn the_error_event_name_matches_the_renderer_listener() {
        assert_eq!(
            SESSION_DEEP_LINK_ERROR_EVENT,
            "flock:session-deep-link-error"
        );
    }
}
