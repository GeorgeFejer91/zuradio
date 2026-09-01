//! Framework-independent Zuradio catalog and player authority.

mod catalog;
mod error;
mod model;
mod service;

pub use catalog::Artwork;
pub use error::{CoreError, ErrorCode};
pub use model::{
    Action, ActionRequest, ActionResult, Actor, AppSnapshot, HistoryEntry, PlaybackStatus,
    PlayerState, Playlist, RepeatMode, Role, StoredState, Track,
};
pub use service::ZuradioCore;
