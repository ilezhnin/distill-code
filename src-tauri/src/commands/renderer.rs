//! Frontend-facing renderer log command: lets the web UI forward lifecycle
//! signals it can observe (e.g. an unexpected page reload) into `berd.log`.

/// Append a renderer lifecycle event from the frontend to the app log.
#[tauri::command]
pub fn log_renderer_event(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[renderer] {message}"),
        "warn" => log::warn!("[renderer] {message}"),
        _ => log::info!("[renderer] {message}"),
    }
}
