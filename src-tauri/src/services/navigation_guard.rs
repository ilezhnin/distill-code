//! Keeps the app's windows from being taken to a local file.
//!
//! The asset protocol serves files from the user's home folder so the app can
//! show images and previews. Served as a page, an HTML file from there runs
//! its script with that origin: it can read every other file the protocol
//! serves and send it anywhere the content policy lets a page connect. One
//! link that takes the window there — in a diagram's label, in rendered
//! Markdown, wherever a sanitizer lets an `<a>` through — is enough.
//!
//! The app itself never navigates a window: it is one page, and what it shows
//! from disk it shows as an image, a frame or text. So a navigation to a file
//! is never the app's own, and is refused. This is the narrow rule on
//! purpose. A navigation to anywhere else is left as it was: refusing every
//! address but the app's own would need the app's address to be known here
//! for every platform and build, and getting that wrong shows an empty
//! window.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Whether a window may be taken to `url`.
pub(crate) fn navigation_allowed(url: &tauri::Url) -> bool {
    let local_file = matches!(url.scheme(), "file" | "asset")
        || url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("asset.localhost"));
    !local_file
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = navigation_allowed(url);
            if !allowed {
                // The address may name a private file: its scheme is enough.
                log::warn!(
                    "[navigation] refused to take window '{}' to a local file ({}:)",
                    webview.label(),
                    url.scheme()
                );
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    fn allowed(url: &str) -> bool {
        navigation_allowed(&url.parse().expect("a URL"))
    }

    #[test]
    fn a_window_is_not_taken_to_a_local_file() {
        for local in [
            "http://asset.localhost/C%3A%5CUsers%5Cinvented%5CDownloads%5Cpage.html",
            "https://asset.localhost/C%3A%5CUsers%5Cinvented%5Cpage.html",
            "http://ASSET.localhost/page.html",
            "asset://localhost/home/invented/page.html",
            "file:///C:/Users/invented/page.html",
        ] {
            assert!(!allowed(local), "{local}");
        }
    }

    #[test]
    fn the_apps_own_pages_and_everything_else_stay_as_they_were() {
        for other in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "tauri://localhost/",
            "http://localhost:1520/",
            "about:blank",
            "https://example.invalid/docs",
        ] {
            assert!(allowed(other), "{other}");
        }
    }
}
