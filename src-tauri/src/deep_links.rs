use percent_encoding::percent_decode_str;
#[cfg(feature = "berdctl")]
use serde::Serialize;
#[cfg(feature = "berdctl")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[cfg(feature = "berdctl")]
const SESSION_DEEP_LINK_ERROR_EVENT: &str = "berd:session-deep-link-error";

#[cfg(feature = "berdctl")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeepLinkErrorPayload {
    session_id: String,
    message: String,
}

pub(crate) fn install<R: Runtime>(app: &tauri::App<R>) {
    // Handles links delivered while the app is already running. Startup
    // session links are drained by BerdctlBridge after the renderer command
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

fn focus_main_window<R: Runtime>(app: &AppHandle<R>, reveal: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if reveal {
            let _ = window.show();
        }
        let _ = window.set_focus();
    }
}

enum SessionDeepLinkRoute {
    Host,
    Path,
}

const SESSION_HOST_ROUTE_PREFIX: &str = "berd://session/";
const SESSION_PATH_ROUTE_PREFIX: &str = "berd:///session/";

fn raw_session_deep_link_route(url: &Url) -> Option<SessionDeepLinkRoute> {
    if url.scheme() != "berd" {
        return None;
    }

    let raw = url.as_str();
    if raw.starts_with(SESSION_HOST_ROUTE_PREFIX) {
        return Some(SessionDeepLinkRoute::Host);
    }
    if raw.starts_with(SESSION_PATH_ROUTE_PREFIX) {
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

#[cfg(feature = "berdctl")]
fn open_session<R: Runtime>(app: AppHandle<R>, session_id: String) -> bool {
    tauri::async_runtime::spawn(async move {
        let requested_session_id = session_id.clone();
        let result = tauri_plugin_berdctl::dispatch_app_command(
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

#[cfg(feature = "berdctl")]
fn session_deep_link_error_payload(
    session_id: &str,
    error: &tauri_plugin_berdctl::AppCommandDispatchError,
) -> SessionDeepLinkErrorPayload {
    let message = match error {
        tauri_plugin_berdctl::AppCommandDispatchError::Command { message, .. }
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

#[cfg(feature = "berdctl")]
fn emit_session_deep_link_error<R: Runtime>(
    app: &AppHandle<R>,
    payload: SessionDeepLinkErrorPayload,
) {
    if let Err(error) = app.emit_to("main", SESSION_DEEP_LINK_ERROR_EVENT, payload) {
        log::warn!("Failed to emit session deep link error event: {error}");
    }
}

#[cfg(not(feature = "berdctl"))]
fn open_session<R: Runtime>(_app: AppHandle<R>, _session_id: String) -> bool {
    log::warn!("Ignoring session deep link because the berdctl feature is disabled");
    false
}
