use tauri::Manager;

use crate::services::agent_host::AgentHost;

/// The renderer's ACP endpoint. Starting the host is lazy so the first call
/// pays for opening the session database and binding the socket.
#[tauri::command]
pub async fn get_agent_host_url(app_handle: tauri::AppHandle) -> Result<String, String> {
    let host = app_handle.state::<AgentHost>();
    // The renderer shows this as "couldn't start"; without the log line the
    // reason — a database that will not migrate, a port that will not bind —
    // exists nowhere but in that window.
    let inner = host
        .get_or_start(&app_handle)
        .await
        .inspect_err(|error| log::error!("[agent-host] failed to start: {error}"))?;
    Ok(inner.ws_url().to_string())
}

/// How many ordinary chats a close would cut, so the close can ask first.
#[tauri::command]
pub async fn active_agent_host_chats(app_handle: tauri::AppHandle) -> usize {
    app_handle.state::<AgentHost>().active_chat_count().await
}

/// `stop_chats`: the operator confirmed closing over active chats; they are
/// stopped first instead of refusing the close.
#[tauri::command]
pub async fn prepare_agent_host_shutdown(
    app_handle: tauri::AppHandle,
    prepared: bool,
    stop_chats: Option<bool>,
) -> Result<(), String> {
    let host = app_handle.state::<AgentHost>();
    let stop_chats = prepared && stop_chats == Some(true);
    if stop_chats {
        host.stop_chats_for_close().await;
    } else if prepared && host.chats_active().await {
        // Refused for an active chat before anything is paused: parking the
        // benchmark runs first left 12 of 13 runs paused behind a refused
        // close (10-18).
        return Err(crate::services::agent_host::router::CHATS_ACTIVE.into());
    }
    app_handle
        .state::<crate::services::benchmarks::BenchmarkState>()
        .park()
        .await
        .map_err(|error| error.message)?;
    host.prepare_shutdown(prepared, stop_chats).await
}
