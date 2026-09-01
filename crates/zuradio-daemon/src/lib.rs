use std::path::PathBuf;

pub mod client;
pub mod server;

/// Returns the shared Zuradio data directory used by the CLI and desktop shell.
#[must_use]
pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Some(local_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_data).join("Zuradio");
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/Zuradio");
    }

    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data_home).join("zuradio");
    }
    std::env::var_os("HOME").map_or_else(
        || PathBuf::from(".zuradio"),
        |home| PathBuf::from(home).join(".local/share/zuradio"),
    )
}
