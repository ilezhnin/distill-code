//! The OS notification for a chat that finished while the window was not in
//! front, and what a click on it does.
//!
//! On Windows the toast is raised with `tauri-winrt-notification` directly
//! rather than through the notification plugin. The plugin's desktop `show`
//! drops the toast's activation handle, so a click could never reach the
//! app, and its `register_listener` command exists only on mobile, so the
//! renderer's `onAction` cannot subscribe to clicks either. Owning the toast
//! here gives the click a handler: it opens the chat the toast is about the
//! way a `flock://session/<id>` link does, then brings the window forward.

use tauri::{AppHandle, Runtime};

use crate::deep_links;

/// The title every completion toast carries.
const TOAST_TITLE: &str = "Levocat Flock";

#[tauri::command]
pub async fn show_completion_notification(
    app: AppHandle,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    show_toast(app, ToastClick::for_session(&session_id), body, sound)
}

/// A toast about the app's own housekeeping (a long database rewrite, its
/// end): the one place a wait the host imposes gets named while the window
/// shows nothing of it. A click only brings the window forward.
pub(crate) fn show_maintenance_notification(app: AppHandle, body: String) {
    if let Err(error) = show_toast(app, ToastClick::FocusWindow, body, None) {
        log::warn!("maintenance toast was not shown: {error}");
    }
}

/// What a click on a completion toast does.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ToastClick {
    /// Open the chat the toast is about, then bring the window forward.
    OpenSession(String),
    /// Bring the window forward only: the toast named no chat.
    FocusWindow,
}

impl ToastClick {
    fn for_session(session_id: &str) -> Self {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            Self::FocusWindow
        } else {
            Self::OpenSession(session_id.to_owned())
        }
    }

    /// Runs on the thread Windows delivers the activation on; every call
    /// below hands its work to the event loop or the async runtime.
    fn run<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Self::OpenSession(session_id) = self {
            log::info!("Completion toast clicked; opening session {session_id}");
            deep_links::open_session(app.clone(), session_id.clone());
        }
        deep_links::focus_main_window(app, true);
    }
}

#[cfg(windows)]
fn show_toast(
    app: AppHandle,
    click: ToastClick,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_winrt_notification::{Duration, Sound, Toast};

    let exe = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "the executable has no parent directory".to_owned())?;
    let app_id = toast_app_id(&app.config().identifier, exe_dir);
    // Windows toasts play only the system notification sounds; a bundled
    // sound file is not one of them, so that choice leaves the toast silent,
    // as it did through the plugin.
    let sound = sound.as_deref().and_then(|name| Sound::from_str(name).ok());
    Toast::new(&app_id)
        .title(TOAST_TITLE)
        .text1(&body)
        .duration(Duration::Short)
        .sound(sound)
        .on_activated(move |_arguments| {
            click.run(&app);
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

/// The AppUserModelID the toast is raised under.
///
/// Windows shows a toast only under an id it has a shortcut for. The
/// installed app's identifier is registered by its Start menu shortcut; a
/// binary run from cargo's target directory has no shortcut and borrows
/// PowerShell's id instead, the rule the notification plugin applies, so a
/// dev build keeps showing toasts. The click handler lives on the toast
/// object in this process, not on the id.
#[cfg(windows)]
fn toast_app_id(identifier: &str, exe_dir: &std::path::Path) -> String {
    use std::ffi::OsStr;
    use tauri_winrt_notification::Toast;

    let profile = exe_dir.file_name().and_then(OsStr::to_str);
    let in_cargo_target = matches!(profile, Some("debug" | "release"))
        && exe_dir.parent().and_then(std::path::Path::file_name) == Some(OsStr::new("target"));
    if in_cargo_target {
        Toast::POWERSHELL_APP_ID.to_owned()
    } else {
        identifier.to_owned()
    }
}

/// Off Windows the plugin raises the toast; its desktop toast has no click
/// handler, so a click does whatever the OS does on its own.
#[cfg(not(windows))]
fn show_toast(
    app: AppHandle,
    _click: ToastClick,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(TOAST_TITLE).body(body);
    if let Some(sound) = sound {
        builder = builder.sound(sound);
    }
    builder.show().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_opens_the_chat_the_toast_names() {
        assert_eq!(
            ToastClick::for_session("session-1"),
            ToastClick::OpenSession("session-1".to_owned())
        );
        assert_eq!(
            ToastClick::for_session("  session-1\n"),
            ToastClick::OpenSession("session-1".to_owned())
        );
    }

    #[test]
    fn a_click_on_a_toast_naming_no_chat_only_brings_the_window_forward() {
        for session_id in ["", "   "] {
            assert_eq!(
                ToastClick::for_session(session_id),
                ToastClick::FocusWindow,
                "{session_id:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_installed_build_raises_the_toast_under_its_own_identifier() {
        use std::path::Path;

        for exe_dir in [
            r"C:\Program Files\Levocat Flock",
            r"C:\Users\someone\AppData\Local\Programs\Levocat Flock",
            r"E:\tools\release",
            r"E:\target\nightly\debug",
        ] {
            assert_eq!(
                toast_app_id("com.levocat.flock", Path::new(exe_dir)),
                "com.levocat.flock",
                "{exe_dir}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_cargo_build_borrows_the_powershell_identifier() {
        use std::path::Path;
        use tauri_winrt_notification::Toast;

        for exe_dir in [
            r"E:\repo\src-tauri\target\debug",
            r"E:\repo\src-tauri\target\release",
        ] {
            assert_eq!(
                toast_app_id("com.levocat.flock.dev", Path::new(exe_dir)),
                Toast::POWERSHELL_APP_ID,
                "{exe_dir}"
            );
        }
    }
}
