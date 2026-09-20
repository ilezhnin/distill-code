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
