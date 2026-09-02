use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub duration_ms: u64,
    pub format: String,
    pub available: bool,
    pub has_artwork: bool,
    #[serde(default)]
    pub recognition: TrackRecognition,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecognitionStatus {
    #[default]
    Pending,
    Recognized,
    NoMatch,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRecognition {
    pub status: RecognitionStatus,
    pub provider: Option<String>,
    pub label: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub external_id: Option<String>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
    Stopped,
    Paused,
    Playing,
    Buffering,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepeatMode {
    Off,
    All,
    One,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub status: PlaybackStatus,
    pub current_track_id: Option<String>,
    pub position_ms: u64,
    pub volume: u8,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    pub queue: Vec<String>,
    #[serde(default)]
    pub queue_before_shuffle: Option<Vec<String>>,
    pub queue_cursor: Option<usize>,
    pub last_error: Option<String>,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            status: PlaybackStatus::Stopped,
            current_track_id: None,
            position_ms: 0,
            volume: 75,
            muted: false,
            shuffle: false,
            repeat: RepeatMode::Off,
            queue: Vec::new(),
            queue_before_shuffle: None,
            queue_cursor: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub track_id: String,
    pub played_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCommand {
    pub command_id: String,
    pub result: ActionResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub revision: u64,
    pub player: PlayerState,
    pub playlists: Vec<Playlist>,
    pub favorites: Vec<String>,
    pub history: Vec<HistoryEntry>,
    pub commands: Vec<StoredCommand>,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            revision: 1,
            player: PlayerState::default(),
            playlists: Vec::new(),
            favorites: Vec::new(),
            history: Vec::new(),
            commands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Local,
    Controller,
    Listener,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub role: Role,
    pub peer_id: Option<String>,
}

impl Actor {
    #[must_use]
    pub fn local() -> Self {
        Self {
            role: Role::Local,
            peer_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Play,
    Pause,
    Stop,
    PlayTrack {
        track_id: String,
    },
    Seek {
        position_ms: u64,
        #[serde(default)]
        track_id: Option<String>,
    },
    Next,
    Previous,
    SetVolume {
        volume: u8,
    },
    SetMuted {
        muted: bool,
    },
    SetShuffle {
        enabled: bool,
    },
    SetRepeat {
        mode: RepeatMode,
    },
    QueueAdd {
        track_id: String,
    },
    QueueRemove {
        index: usize,
    },
    QueueMove {
        from: usize,
        to: usize,
    },
    QueueClear,
    PlaylistCreate {
        name: String,
    },
    PlaylistRename {
        playlist_id: String,
        name: String,
    },
    PlaylistDelete {
        playlist_id: String,
    },
    PlaylistAdd {
        playlist_id: String,
        track_id: String,
    },
    PlaylistRemove {
        playlist_id: String,
        index: usize,
    },
    PlaylistMove {
        playlist_id: String,
        from: usize,
        to: usize,
    },
    FavoriteSet {
        track_id: String,
        favorite: bool,
    },
    EditTrackMetadata {
        track_id: String,
        title: String,
        artist: String,
        album: String,
        album_artist: String,
        track_number: Option<u32>,
        disc_number: Option<u32>,
        year: Option<u32>,
    },
    ReportPlayback {
        status: PlaybackStatus,
        position_ms: u64,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub protocol: u16,
    pub command_id: String,
    pub expected_revision: Option<u64>,
    pub actor: Actor,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub command_id: String,
    pub revision: u64,
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub protocol: u16,
    pub revision: u64,
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
    pub favorites: Vec<String>,
    pub history: Vec<HistoryEntry>,
    pub player: PlayerState,
}
