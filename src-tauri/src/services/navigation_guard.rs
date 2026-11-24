//! Keeps the app's windows on the app's own page.
//!
//! The app is one page and never navigates a window: what it shows from disk
//! it shows as an image, a frame or text, and a web link opens in the
//! operator's browser. So a navigation is never the app's own. It comes from
//! content: one link that takes the window somewhere, in a diagram's label,
//! in rendered Markdown, wherever a sanitizer lets an `<a>` through, is
//! enough.
//!
//! Two destinations show why. A web page then fills the window where the
//! operator expects the app. A local HTML file is worse: the asset protocol
//! serves files from the user's home folder so the app can show images and
//! previews, and served as a page such a file runs its script with that
//! origin and no content policy. It can read every other file the protocol
//! serves and send it anywhere.
//!
//! The rule is the address of the app's page and nothing else. Naming the
//! addresses to refuse instead cannot be finished: the webview hands every
//! address that starts with `http://asset.` to the asset protocol, whatever
//! the rest of the host says, and the protocol reads only the path, so
//! `asset.localhost.` and `asset.example` serve the file `asset.localhost`
//! does.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::utils::config::{BuildConfig, FrontendDist};
use tauri::{Manager, Runtime, Url};

/// Where Tauri serves a window's page from, by the rule Tauri itself applies
/// (`AppManager::get_app_url`), so the two cannot disagree about which page
/// is the app: `devUrl` in a development build, a `frontendDist` that is an
/// address in a release build, the bundled page otherwise. A webview without
/// custom schemes (WebView2, Android) reaches the bundled page as
/// `tauri.localhost`, under the scheme the window was given.
fn app_page(build: &BuildConfig, development: bool, https: bool) -> Url {
    let configured = if development {
        build.dev_url.as_ref()
    } else {
        match &build.frontend_dist {
            Some(FrontendDist::Url(url)) => Some(url),
            _ => None,
        }
    };
    if let Some(url) = configured {
        return url.clone();
    }
    let bundled = if cfg!(any(windows, target_os = "android")) {
        if https {
            "https://tauri.localhost"
        } else {
            "http://tauri.localhost"
        }
    } else {
        "tauri://localhost"
    };
    Url::parse(bundled).expect("the bundled page address is a valid URL")
}

/// Whether a window may be taken to `url`: only to a page served from where
/// the app's own page is, scheme, host and port alike.
pub(crate) fn navigation_allowed(url: &Url, app_page: &Url) -> bool {
    url.scheme() == app_page.scheme()
        && url.host_str() == app_page.host_str()
        && url.port_or_known_default() == app_page.port_or_known_default()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let config = webview.config();
            let https = config
                .app
                .windows
                .iter()
                .find(|window| window.label == webview.label())
                .is_some_and(|window| window.use_https_scheme);
            let allowed = navigation_allowed(url, &app_page(&config.build, tauri::is_dev(), https));
            if !allowed {
                // The address may name a private file: its scheme is enough.
                log::warn!(
                    "[navigation] refused to take window '{}' away from the app ({}:)",
                    webview.label(),
                    url.scheme()
                );
            }
            allowed
        })
        .build()
}

/// Refuses the addresses the hook above is never asked about.
///
/// Tauri parses an address before it asks a plugin, and an address its parser
/// rejects is let through without asking. WebView2 follows some of those: a
/// host label that begins `xn--` and is not valid punycode, a host with a
/// space in it. `http://asset.xn--a/<path>` is then served by the asset
/// protocol like every other `http://asset.` address. An address that cannot
/// be read is not the app's page, so it is refused here.
///
/// Call it once the window exists. WebView2 calls its handlers in the order
/// they were added, and Tauri's, added with the webview, clears the refusal of
/// an address it could not parse: this one has to come after it.
#[cfg(windows)]
pub(crate) fn refuse_unreadable_addresses(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
        if let Err(error) = watch_navigations(webview.controller(), label) {
            log::error!("[navigation] cannot watch the WebView2 navigations: {error}");
        }
    });
    if let Err(error) = result {
        log::error!("[navigation] cannot reach the WebView2 controller: {error}");
    }
}

#[cfg(not(windows))]
pub(crate) fn refuse_unreadable_addresses(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn watch_navigations(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    label: String,
) -> Result<(), String> {
    use webview2_com::NavigationStartingEventHandler;

    let handler = NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut address = Default::default();
        // SAFETY: `args` is the live COM object WebView2 handed to this
        // callback; `take_pwstr` frees the string it filled in.
        let address = unsafe {
            args.Uri(&mut address)?;
            webview2_com::take_pwstr(address)
        };
        // The same parser Tauri asks, so exactly what it lets through unasked.
        if address.parse::<Url>().is_err() {
            log::warn!(
                "[navigation] refused to take window '{label}' to an address that cannot be read"
            );
            // SAFETY: as above.
            unsafe { args.SetCancel(true)? };
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: `controller` is the live controller Tauri passes to
    // `with_webview`, called on the thread that owns it.
    unsafe {
        let webview = controller
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        webview
            .add_NavigationStarting(&handler, &mut token)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{app_page, navigation_allowed};
    use tauri::utils::config::BuildConfig;
    use tauri::Url;

    fn url(text: &str) -> Url {
        text.parse().expect("a URL")
    }

    fn build(json: serde_json::Value) -> BuildConfig {
        serde_json::from_value(json).expect("a build section")
    }

    /// The bundled page of this platform, as a release build serves it.
    fn bundled() -> Url {
        app_page(&BuildConfig::default(), false, false)
    }

    #[test]
    fn a_window_stays_on_the_apps_own_page() {
        let app = bundled();
        assert!(navigation_allowed(&app, &app));
        assert!(navigation_allowed(
            &app.join("index.html?reload=1#chat").expect("a page"),
            &app
        ));
    }

    #[test]
    fn a_window_is_not_taken_to_a_local_file() {
        for local in [
            "http://asset.localhost/C%3A%5CUsers%5Cinvented%5CDownloads%5Cpage.html",
            "https://asset.localhost/C%3A%5CUsers%5Cinvented%5Cpage.html",
            "http://ASSET.localhost/page.html",
            "asset://localhost/home/invented/page.html",
            "file:///C:/Users/invented/page.html",
            // The webview gives every `http://asset.` address to the asset
            // protocol, and the protocol reads only the path.
            "http://asset.localhost./C%3A%5CUsers%5Cinvented%5Cpage.html",
            "http://asset.example/C%3A%5CUsers%5Cinvented%5Cpage.html",
            "http://asset.x/C:/Users/invented/page.html",
        ] {
            assert!(!navigation_allowed(&url(local), &bundled()), "{local}");
        }
    }

    #[test]
    fn a_window_is_not_taken_anywhere_else_either() {
        for other in [
            "https://example.invalid/docs",
            "http://example.invalid/",
            "about:blank",
            "data:text/html,<p>page</p>",
            // The app's host under another port, with a trailing dot, behind
            // a user name, or as a longer name.
            "http://tauri.localhost:8080/",
            "http://tauri.localhost./",
            "http://tauri.localhost@example.invalid/",
            "http://tauri.localhost.example.invalid/",
            "http://ipc.localhost/",
        ] {
            assert!(!navigation_allowed(&url(other), &bundled()), "{other}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_bundled_page_has_the_scheme_the_window_was_given() {
        let plain = app_page(&BuildConfig::default(), false, false);
        let secure = app_page(&BuildConfig::default(), false, true);
        assert_eq!(plain.as_str(), "http://tauri.localhost/");
        assert_eq!(secure.as_str(), "https://tauri.localhost/");
        assert!(!navigation_allowed(&secure, &plain));
        assert!(!navigation_allowed(&plain, &secure));
    }

    /// A development build is served by its dev server and a release build
    /// never is, although the configuration names the server in both.
    #[test]
    fn the_dev_server_is_the_app_only_in_a_development_build() {
        let section = build(serde_json::json!({ "devUrl": "http://localhost:1520" }));
        let served = url("http://localhost:1520/src/main.tsx");

        let development = app_page(&section, true, false);
        assert_eq!(development.as_str(), "http://localhost:1520/");
        assert!(navigation_allowed(&served, &development));
        assert!(!navigation_allowed(
            &url("http://localhost:1521/"),
            &development
        ));
        assert!(!navigation_allowed(
            &url("http://127.0.0.1:1520/"),
            &development
        ));

        let release = app_page(&section, false, false);
        assert_eq!(release, bundled());
        assert!(!navigation_allowed(&served, &release));
    }
}
