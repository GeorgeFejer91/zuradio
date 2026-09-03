//! Framework-independent Zuradio catalog and player authority.

mod catalog;
mod error;
mod model;
mod service;

pub use catalog::Artwork;
pub use error::{CoreError, ErrorCode};
pub use model::{
    Action, ActionRequest, ActionResult, Actor, AppSnapshot, ChatMessage, ChatSender, HistoryEntry,
    PlaybackStatus, PlayerState, Playlist, RecognitionStatus, RepeatMode, Role, StoredState, Track,
    TrackRecognition,
};
pub use service::ZuradioCore;
