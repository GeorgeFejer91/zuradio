use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tauri::webview::WebviewWindowBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;
use zuradio_daemon::client::Client;
use zuradio_daemon::server::{self, ServeOptions};

const COMPANION_URL: &str = "https://georgefejer91.github.io/zuradio/";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shutdown = CancellationToken::new();
    let exit_shutdown = shutdown.clone();
    let trusted_port = Arc::new(AtomicU16::new(0));

    tauri::Builder::default()
        .manage(shutdown.clone())
        .setup(move |app| {
            let navigation_port = trusted_port.clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Zuradio")
                    .inner_size(1180.0, 760.0)
                    .min_inner_size(820.0, 560.0)
                    .on_navigation(move |url| is_allowed_navigation(url, &navigation_port))
                    .build()?;
            enable_desktop_media_bridge(&window)?;

            let data_dir = zuradio_daemon::default_data_dir();
            let web_root = resolve_web_root(app)?;
            let music_roots = app
                .path()
                .audio_dir()
                .map_or_else(|_| Vec::new(), |path| vec![path]);
            let startup_shutdown = shutdown.clone();

            tauri::async_runtime::spawn(async move {
                if let Some(host_url) = discover_running_host(data_dir.clone()).await {
                    show_host(&window, &host_url);
                    return;
                }

                let (ready_tx, ready_rx) = oneshot::channel();
                let server_shutdown = startup_shutdown.clone();
                let options = ServeOptions {
                    data_dir,
                    music_roots,
                    port: 0,
                    web_root,
                    open_browser: false,
                    companion_url: COMPANION_URL.to_owned(),
                    remote_password_file: zuradio_daemon::default_remote_password_file(),
                };

                tauri::async_runtime::spawn(async move {
                    let result = server::serve_with_shutdown(options, Some(ready_tx), async move {
                        server_shutdown.cancelled().await;
                    })
                    .await;
                    if let Err(error) = result {
                        tracing::error!(error = %error, "embedded Zuradio authority stopped");
                    }
                });

                match tokio::time::timeout(Duration::from_secs(12), ready_rx).await {
                    Ok(Ok(runtime)) => show_host(&window, &runtime.host_url),
                    Ok(Err(_)) | Err(_) => show_startup_failure(&window),
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.state::<CancellationToken>().cancel();
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("failed to build Zuradio desktop application: {error}");
            std::process::exit(1);
        })
        .run(move |_app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                exit_shutdown.cancel();
            }
        });
}

#[cfg(target_os = "linux")]
fn enable_desktop_media_bridge(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};

        if let Some(settings) = webview.inner().settings() {
            settings.set_enable_webaudio(true);
            settings.set_enable_webrtc(true);
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn enable_desktop_media_bridge(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

async fn discover_running_host(data_dir: PathBuf) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = Client::from_data_dir(&data_dir).ok()?;
        client.snapshot().ok()?;
        Some(client.host_url().to_owned())
    })
    .await
    .ok()
    .flatten()
}

fn show_host(window: &WebviewWindow, host_url: &str) {
    let result = validated_host_url(host_url).and_then(|url| {
        window
            .navigate(url)
            .map_err(|error| io::Error::other(error.to_string()))
    });
    if result.is_err() {
        show_startup_failure(window);
    }
}

fn show_startup_failure(window: &WebviewWindow) {
    let _ = window.set_title("Zuradio — startup failed");
    let _ = window.show();
    let _ = window.set_focus();
}

fn validated_host_url(input: &str) -> io::Result<Url> {
    let url = Url::parse(input).map_err(|_| io::Error::other("invalid host URL"))?;
    let host_is_loopback = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|address| address == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let fragment_is_bootstrap = url
        .fragment()
        .is_some_and(|fragment| fragment.starts_with("bootstrap=") && fragment.len() > 32);
    if url.scheme() != "http"
        || !host_is_loopback
        || url.port().is_none()
        || url.path() != "/host/"
        || url.query().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !fragment_is_bootstrap
    {
        return Err(io::Error::other(
            "host URL is outside the Zuradio loopback boundary",
        ));
    }
    Ok(url)
}

fn is_allowed_navigation(url: &Url, trusted_port: &AtomicU16) -> bool {
    if matches!(url.scheme(), "tauri" | "asset") || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    if validated_host_url(url.as_str()).is_ok() {
        trusted_port.store(url.port().unwrap_or_default(), Ordering::Release);
        return true;
    }
    let port = trusted_port.load(Ordering::Acquire);
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && port != 0
        && url.port() == Some(port)
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn resolve_web_root<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<PathBuf> {
    let packaged = app.path().resource_dir()?.join("web");
    if packaged.join("host/index.html").is_file() {
        return Ok(packaged);
    }
    let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/dist");
    Ok(development)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_protected_ipv4_loopback_host_urls() {
        assert!(
            validated_host_url(
                "http://127.0.0.1:49152/host/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789"
            )
            .is_ok()
        );
        for rejected in [
            "https://127.0.0.1:49152/host/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789",
            "http://localhost:49152/host/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789",
            "http://127.0.0.1:49152/companion/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789",
            "http://127.0.0.1:49152/host/",
            "http://127.0.0.2:49152/host/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789",
        ] {
            assert!(validated_host_url(rejected).is_err(), "accepted {rejected}");
        }
    }

    #[test]
    fn pins_follow_up_navigation_to_the_bootstrapped_port() -> Result<(), url::ParseError> {
        let trusted_port = AtomicU16::new(0);
        let bootstrap = Url::parse(
            "http://127.0.0.1:49152/host/#bootstrap=abcdefghijklmnopqrstuvwxyz0123456789",
        )?;
        assert!(is_allowed_navigation(&bootstrap, &trusted_port));
        assert!(is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49152/host/")?,
            &trusted_port
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49153/host/")?,
            &trusted_port
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49152/host/#unexpected")?,
            &trusted_port
        ));
        Ok(())
    }
}
