use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub fn show_completion_notification(
    app: AppHandle,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    // The session id is part of the command's contract with the frontend but
    // has no use here: the notification plugin carries no click payload.
    let _ = session_id;
    let mut builder = app.notification().builder().title("Distill").body(body);
    if let Some(sound) = sound {
        builder = builder.sound(sound);
    }
    builder.show().map_err(|error| error.to_string())
}
