//! A WebView2 renderer that dies (out of memory, a crash) leaves the window on
//! Edge's "This page is having a problem" page until someone presses its
//! button. The agent host keeps running meanwhile, but everything that needs
//! the renderer stalls: permission requests are cancelled, queued prompts and
//! monitor wakes wait. Reload the page as soon as WebView2 reports the renderer
//! gone; the host keeps every session, so the reloaded UI picks them up.

use tauri::WebviewWindow;

#[cfg(windows)]
pub(crate) fn reload_when_renderer_dies(window: &WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
        if let Err(error) = watch_renderer(webview.controller(), label) {
            log::warn!("[renderer] cannot watch the WebView2 renderer: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("[renderer] cannot reach the WebView2 controller: {error}");
    }
}

#[cfg(not(windows))]
pub(crate) fn reload_when_renderer_dies(_window: &WebviewWindow) {}

#[cfg(windows)]
fn watch_renderer(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    label: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let (Some(webview), Some(args)) = (sender, args) else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: both are live COM objects WebView2 handed to this callback.
        unsafe { args.ProcessFailedKind(&mut kind)? };
        // Only a renderer that is gone. An unresponsive one may just be busy
        // replaying a long chat, and reloading it would start that again.
        if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
            log::warn!("[renderer] WebView2 process failure {} in {label}", kind.0);
            return Ok(());
        }
        log::error!("[renderer] the WebView2 renderer of {label} exited; reloading");
        // SAFETY: as above.
        unsafe { webview.Reload() }
    }));
    let mut token = 0i64;
    // SAFETY: `controller` is the live controller Tauri passes to
    // `with_webview`, called on the thread that owns it.
    unsafe {
        let webview = controller
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        webview
            .add_ProcessFailed(&handler, &mut token)
            .map_err(|error| error.to_string())
    }
}
