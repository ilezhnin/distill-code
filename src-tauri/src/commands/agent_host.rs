use tauri::Manager;

use crate::services::agent_host::AgentHost;

/// The renderer's ACP endpoint. Starting the host is lazy so the first call
/// pays for opening the session database and binding the socket.
#[tauri::command]
pub async fn get_agent_host_url(app_handle: tauri::AppHandle) -> Result<String, String> {
    let host = app_handle.state::<AgentHost>();
    let inner = host.get_or_start(&app_handle).await?;
    Ok(inner.ws_url().to_string())
}
