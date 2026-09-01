use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use tracing_subscriber::EnvFilter;
use zuradio_core::{Action, RepeatMode};
use zuradio_daemon::{client, default_data_dir, default_remote_password_file, server};

#[derive(Debug, Parser)]
#[command(
    name = "zuradio",
    version,
    about = "Local-first music player and companion bridge"
)]
struct Cli {
    #[arg(long, global = true, env = "ZURADIO_DATA_DIR", default_value_os_t = default_data_dir())]
    data_dir: PathBuf,
    #[arg(long, global = true, help = "Emit machine-readable JSON")]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the local Rust authority and web player.
    Serve {
        #[arg(long = "music", value_name = "FOLDER")]
        music_roots: Vec<PathBuf>,
        #[arg(long, default_value_t = 0)]
        port: u16,
        #[arg(long, default_value = "web/dist")]
        web_root: PathBuf,
        #[arg(long)]
        no_open: bool,
        #[arg(long, default_value = "https://georgefejer91.github.io/zuradio/")]
        companion_url: String,
        #[arg(long, env = "ZURADIO_REMOTE_PASSWORD_FILE")]
        remote_password_file: Option<PathBuf>,
    },
    /// Scan one or more local folders into the catalog.
    Scan {
        #[arg(value_name = "FOLDER")]
        roots: Vec<PathBuf>,
    },
    /// Print the canonical app snapshot.
    Status,
    /// Open the running Zuradio player in the default browser.
    Open,
    /// List or search catalog tracks.
    Tracks {
        #[arg(long)]
        query: Option<String>,
    },
    Play {
        track_id: Option<String>,
    },
    Pause,
    Stop,
    Next,
    Previous,
    Seek {
        position_ms: u64,
    },
    Volume {
        value: u8,
    },
    Mute {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
    Shuffle {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
    Repeat {
        mode: RepeatArg,
    },
    #[command(subcommand)]
    Queue(QueueCommand),
    #[command(subcommand)]
    Playlist(PlaylistCommand),
    Favorite {
        track_id: String,
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum RepeatArg {
    Off,
    All,
    One,
}

impl From<RepeatArg> for RepeatMode {
    fn from(value: RepeatArg) -> Self {
        match value {
            RepeatArg::Off => Self::Off,
            RepeatArg::All => Self::All,
            RepeatArg::One => Self::One,
        }
    }
}

#[derive(Debug, Subcommand)]
enum QueueCommand {
    Add { track_id: String },
    Remove { index: usize },
    Move { from: usize, to: usize },
    Clear,
}

#[derive(Debug, Subcommand)]
enum PlaylistCommand {
    List,
    Create {
        name: String,
    },
    Rename {
        playlist_id: String,
        name: String,
    },
    Delete {
        playlist_id: String,
    },
    Add {
        playlist_id: String,
        track_id: String,
    },
    Remove {
        playlist_id: String,
        index: usize,
    },
    Move {
        playlist_id: String,
        from: usize,
        to: usize,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            music_roots,
            port,
            web_root,
            no_open,
            companion_url,
            remote_password_file,
        } => {
            server::serve(server::ServeOptions {
                data_dir: cli.data_dir,
                music_roots,
                port,
                web_root,
                open_browser: !no_open,
                companion_url,
                remote_password_file: remote_password_file.or_else(default_remote_password_file),
            })
            .await?;
        }
        command => run_client(&cli.data_dir, cli.json, command)?,
    }
    Ok(())
}

fn run_client(data_dir: &std::path::Path, json: bool, command: Command) -> anyhow::Result<()> {
    let client = client::Client::from_data_dir(data_dir)?;
    match command {
        Command::Open => server::open_browser(client.host_url())?,
        Command::Status => print_value(&client.snapshot()?, json),
        Command::Tracks { query } => {
            let snapshot = client.snapshot()?;
            let query = query.unwrap_or_default().to_lowercase();
            let tracks: Vec<_> = snapshot
                .tracks
                .into_iter()
                .filter(|track| {
                    query.is_empty()
                        || track.title.to_lowercase().contains(&query)
                        || track.artist.to_lowercase().contains(&query)
                        || track.album.to_lowercase().contains(&query)
                })
                .collect();
            print_value(&tracks, json);
        }
        Command::Scan { roots } => print_value(&client.scan(&roots)?, json),
        Command::Playlist(PlaylistCommand::List) => {
            print_value(&client.snapshot()?.playlists, json);
        }
        other => {
            let action = action_from_command(other)?;
            print_value(&client.action(action)?, json);
        }
    }
    Ok(())
}

fn action_from_command(command: Command) -> anyhow::Result<Action> {
    Ok(match command {
        Command::Play {
            track_id: Some(track_id),
        } => Action::PlayTrack { track_id },
        Command::Play { track_id: None } => Action::Play,
        Command::Pause => Action::Pause,
        Command::Stop => Action::Stop,
        Command::Next => Action::Next,
        Command::Previous => Action::Previous,
        Command::Seek { position_ms } => Action::Seek { position_ms },
        Command::Volume { value } => Action::SetVolume { volume: value },
        Command::Mute { enabled } => Action::SetMuted { muted: enabled },
        Command::Shuffle { enabled } => Action::SetShuffle { enabled },
        Command::Repeat { mode } => Action::SetRepeat { mode: mode.into() },
        Command::Queue(QueueCommand::Add { track_id }) => Action::QueueAdd { track_id },
        Command::Queue(QueueCommand::Remove { index }) => Action::QueueRemove { index },
        Command::Queue(QueueCommand::Move { from, to }) => Action::QueueMove { from, to },
        Command::Queue(QueueCommand::Clear) => Action::QueueClear,
        Command::Playlist(PlaylistCommand::Create { name }) => Action::PlaylistCreate { name },
        Command::Playlist(PlaylistCommand::Rename { playlist_id, name }) => {
            Action::PlaylistRename { playlist_id, name }
        }
        Command::Playlist(PlaylistCommand::Delete { playlist_id }) => {
            Action::PlaylistDelete { playlist_id }
        }
        Command::Playlist(PlaylistCommand::Add {
            playlist_id,
            track_id,
        }) => Action::PlaylistAdd {
            playlist_id,
            track_id,
        },
        Command::Playlist(PlaylistCommand::Remove { playlist_id, index }) => {
            Action::PlaylistRemove { playlist_id, index }
        }
        Command::Playlist(PlaylistCommand::Move {
            playlist_id,
            from,
            to,
        }) => Action::PlaylistMove {
            playlist_id,
            from,
            to,
        },
        Command::Favorite { track_id, enabled } => Action::FavoriteSet {
            track_id,
            favorite: enabled,
        },
        Command::Open
        | Command::Serve { .. }
        | Command::Scan { .. }
        | Command::Status
        | Command::Tracks { .. }
        | Command::Playlist(PlaylistCommand::List) => {
            anyhow::bail!("that command is not an action")
        }
    })
}

fn print_value<T: Serialize>(value: &T, _json: bool) {
    if let Ok(rendered) = serde_json::to_string_pretty(value) {
        println!("{rendered}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_explicit_boolean_action_values() -> Result<(), clap::Error> {
        let muted = Cli::try_parse_from(["zuradio", "mute", "true"])?;
        assert!(matches!(muted.command, Command::Mute { enabled: true }));

        let unmuted = Cli::try_parse_from(["zuradio", "mute", "false"])?;
        assert!(matches!(unmuted.command, Command::Mute { enabled: false }));

        let unshuffled = Cli::try_parse_from(["zuradio", "shuffle", "false"])?;
        assert!(matches!(
            unshuffled.command,
            Command::Shuffle { enabled: false }
        ));

        let favorite = Cli::try_parse_from(["zuradio", "favorite", "track-id", "true"])?;
        assert!(matches!(
            favorite.command,
            Command::Favorite { enabled: true, .. }
        ));
        Ok(())
    }
}
