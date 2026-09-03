use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::catalog::{Catalog, scan_file, scan_music};
use crate::model::StoredCommand;
use crate::{
    Action, ActionRequest, ActionResult, AppSnapshot, Artwork, ChatMessage, ChatSender, CoreError,
    HistoryEntry, PlaybackStatus, Playlist, RecognitionStatus, RepeatMode, Role, StoredState,
    TrackRecognition,
};

const PROTOCOL_VERSION: u16 = 1;
const MAX_COMMAND_CACHE: usize = 256;
const MAX_HISTORY: usize = 500;
const MAX_CHAT_MESSAGES: usize = 20;
const MAX_CHAT_MESSAGE_CHARS: usize = 300;
const MAX_CHAT_MESSAGE_BYTES: usize = 320;

#[derive(Debug)]
pub struct ZuradioCore {
    catalog: Catalog,
    state: StoredState,
}

impl ZuradioCore {
    /// Opens or creates a persistent Zuradio database.
    ///
    /// # Errors
    ///
    /// Returns an error when the database directory, schema, or stored state cannot be read.
    pub fn open(database_path: &Path) -> Result<Self, CoreError> {
        let catalog = Catalog::open(database_path)?;
        Self::from_catalog(catalog)
    }

    /// Creates an isolated in-memory authority, primarily for tests and embedding.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` initialization fails.
    pub fn in_memory() -> Result<Self, CoreError> {
        Self::from_catalog(Catalog::in_memory()?)
    }

    fn from_catalog(catalog: Catalog) -> Result<Self, CoreError> {
        let state = catalog.load_state()?;
        Ok(Self { catalog, state })
    }

    /// Returns the canonical catalog and player state.
    ///
    /// # Errors
    ///
    /// Returns an error when catalog rows cannot be read.
    pub fn snapshot(&self) -> Result<AppSnapshot, CoreError> {
        Ok(AppSnapshot {
            protocol: PROTOCOL_VERSION,
            revision: self.state.revision,
            tracks: self.catalog.tracks()?,
            playlists: self.state.playlists.clone(),
            favorites: self.state.favorites.clone(),
            history: self.state.history.clone(),
            chat_messages: self.state.chat_messages.clone(),
            player: self.state.player.clone(),
        })
    }

    /// Replaces catalog availability information with a recursive scan of `roots`.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid roots, unreadable media, or storage failures.
    pub fn scan(&mut self, roots: &[PathBuf]) -> Result<AppSnapshot, CoreError> {
        let tracks = scan_music(roots)?;
        self.catalog.replace_scan(&tracks)?;
        self.bump_revision();
        self.persist()?;
        self.snapshot()
    }

    /// Adds or refreshes one file without rescanning the rest of the collection.
    ///
    /// # Errors
    ///
    /// Returns an error when the file is outside `root`, unsupported, unreadable,
    /// or cannot be persisted.
    pub fn catalog_file(&mut self, path: &Path, root: &Path) -> Result<AppSnapshot, CoreError> {
        let track = scan_file(path, root)?;
        self.catalog.upsert_scan(&track)?;
        self.bump_revision();
        self.persist()?;
        self.snapshot()
    }

    /// Returns files whose acoustic recognition can be attempted, optionally
    /// including earlier unavailable and failed attempts.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog cannot be read.
    pub fn recognition_candidates(
        &self,
        retry_failures: bool,
    ) -> Result<Vec<(String, PathBuf)>, CoreError> {
        self.catalog.recognition_candidates(retry_failures)
    }

    /// Stores a bounded recognition result without replacing user-visible metadata.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid result, unknown track, or storage failure.
    pub fn set_track_recognition(
        &mut self,
        track_id: &str,
        recognition: &TrackRecognition,
    ) -> Result<AppSnapshot, CoreError> {
        validate_recognition(recognition)?;
        self.catalog.update_recognition(track_id, recognition)?;
        self.bump_revision();
        self.persist()?;
        self.snapshot()
    }

    /// Resolves an available track to its canonical local path.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog cannot be read or the track is unavailable.
    pub fn track_path(&self, track_id: &str) -> Result<PathBuf, CoreError> {
        self.catalog
            .track_path(track_id)?
            .ok_or_else(|| CoreError::NotFound("track is unavailable".into()))
    }

    /// Reads bounded embedded artwork for a catalog track.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog or tagged media file cannot be read.
    pub fn track_artwork(&self, track_id: &str) -> Result<Option<Artwork>, CoreError> {
        self.catalog.artwork(track_id)
    }

    /// Validates and applies one typed action to the authoritative state.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed, stale, unauthorized, or unpersistable actions.
    pub fn execute(&mut self, request: ActionRequest) -> Result<ActionResult, CoreError> {
        validate_request(&request)?;
        if let Some(cached) = self
            .state
            .commands
            .iter()
            .find(|entry| entry.command_id == request.command_id)
        {
            return Ok(cached.result.clone());
        }
        if request.actor.role == Role::Listener {
            return Err(CoreError::Forbidden);
        }
        if let Some(expected) = request.expected_revision
            && expected != self.state.revision
            && !has_local_player_priority(&request)
        {
            return Err(CoreError::Conflict);
        }

        self.apply(request.action, request.actor.role)?;
        self.bump_revision();
        let result = ActionResult {
            command_id: request.command_id.clone(),
            revision: self.state.revision,
            applied: true,
        };
        self.state.commands.push(StoredCommand {
            command_id: request.command_id,
            result: result.clone(),
        });
        if self.state.commands.len() > MAX_COMMAND_CACHE {
            let excess = self.state.commands.len() - MAX_COMMAND_CACHE;
            self.state.commands.drain(0..excess);
        }
        self.persist()?;
        Ok(result)
    }

    fn apply(&mut self, action: Action, role: Role) -> Result<(), CoreError> {
        if role == Role::Controller
            && matches!(
                action,
                Action::ReportPlayback { .. }
                    | Action::EditTrackMetadata { .. }
                    | Action::ChatDelete { .. }
                    | Action::ChatClear
            )
        {
            return Err(CoreError::Forbidden);
        }
        match action {
            Action::Play => self.play(),
            Action::Pause => self.state.player.status = PlaybackStatus::Paused,
            Action::Stop => self.stop(),
            Action::PlayTrack { track_id } => self.play_track(&track_id)?,
            Action::Seek {
                position_ms,
                track_id,
            } => self.seek(position_ms, track_id.as_deref())?,
            Action::Next => self.next(false),
            Action::Previous => self.previous(),
            Action::SetVolume { volume } => self.set_volume(volume)?,
            Action::SetMuted { muted } => self.state.player.muted = muted,
            Action::SetShuffle { enabled } => self.set_shuffle(enabled),
            Action::SetRepeat { mode } => self.state.player.repeat = mode,
            Action::QueueAdd { track_id } => self.queue_add_checked(track_id)?,
            Action::QueueRemove { index } => self.queue_remove(index)?,
            Action::QueueMove { from, to } => self.queue_move(from, to)?,
            Action::QueueClear => self.queue_clear(),
            Action::PlaylistCreate { name } => self.playlist_create(&name)?,
            Action::PlaylistRename { playlist_id, name } => {
                self.playlist_rename(&playlist_id, &name)?;
            }
            Action::PlaylistDelete { playlist_id } => self.playlist_delete(&playlist_id)?,
            Action::PlaylistAdd {
                playlist_id,
                track_id,
            } => self.playlist_add(&playlist_id, track_id)?,
            Action::PlaylistRemove { playlist_id, index } => {
                self.playlist_remove(&playlist_id, index)?;
            }
            Action::PlaylistMove {
                playlist_id,
                from,
                to,
            } => self.playlist_move(&playlist_id, from, to)?,
            Action::FavoriteSet { track_id, favorite } => self.favorite_set(&track_id, favorite)?,
            Action::ChatPost { text } => self.chat_post(&text, role)?,
            Action::ChatDelete { message_id } => self.chat_delete(&message_id)?,
            Action::ChatClear => self.state.chat_messages.clear(),
            Action::EditTrackMetadata {
                track_id,
                title,
                artist,
                album,
                album_artist,
                track_number,
                disc_number,
                year,
            } => {
                self.ensure_track(&track_id)?;
                let fields = [&title, &artist, &album, &album_artist];
                if fields.iter().any(|value| {
                    value.trim().is_empty()
                        || value.chars().count() > 160
                        || value.chars().any(char::is_control)
                }) || track_number.is_some_and(|value| value == 0 || value > 9_999)
                    || disc_number.is_some_and(|value| value == 0 || value > 999)
                    || year.is_some_and(|value| !(1000..=9999).contains(&value))
                {
                    return Err(CoreError::InvalidInput("invalid track metadata".into()));
                }
                self.catalog.update_track_metadata(
                    &track_id,
                    title.trim(),
                    artist.trim(),
                    album.trim(),
                    album_artist.trim(),
                    track_number,
                    disc_number,
                    year,
                )?;
            }
            Action::ReportPlayback {
                status,
                position_ms,
                error,
            } => self.report_playback(status, position_ms, error),
        }
        Ok(())
    }

    fn stop(&mut self) {
        self.state.player.status = PlaybackStatus::Stopped;
        self.state.player.position_ms = 0;
    }

    fn set_volume(&mut self, volume: u8) -> Result<(), CoreError> {
        if volume > 100 {
            return Err(CoreError::InvalidInput(
                "volume must be from 0 to 100".into(),
            ));
        }
        self.state.player.volume = volume;
        Ok(())
    }

    fn queue_add_checked(&mut self, track_id: String) -> Result<(), CoreError> {
        self.ensure_track(&track_id)?;
        self.queue_add(track_id);
        Ok(())
    }

    fn queue_move(&mut self, from: usize, to: usize) -> Result<(), CoreError> {
        move_item(&mut self.state.player.queue, from, to)?;
        if self.state.player.shuffle {
            self.state.player.queue_before_shuffle = Some(self.state.player.queue.clone());
        }
        Ok(())
    }

    fn queue_clear(&mut self) {
        self.state.player.queue.clear();
        self.state.player.queue_before_shuffle = self.state.player.shuffle.then(Vec::new);
        self.state.player.queue_cursor = None;
        self.state.player.current_track_id = None;
        self.state.player.status = PlaybackStatus::Stopped;
        self.state.player.position_ms = 0;
    }

    fn chat_post(&mut self, text: &str, role: Role) -> Result<(), CoreError> {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let text = normalized.trim();
        if text.is_empty()
            || text.chars().count() > MAX_CHAT_MESSAGE_CHARS
            || text.len() > MAX_CHAT_MESSAGE_BYTES
            || text
                .chars()
                .any(|character| character.is_control() && character != '\n' && character != '\t')
        {
            return Err(CoreError::InvalidInput(
                "chat messages must contain 1 to 300 characters and at most 320 UTF-8 bytes".into(),
            ));
        }
        let sender = match role {
            Role::Local => ChatSender::Local,
            Role::Controller => ChatSender::Remote,
            Role::Listener => return Err(CoreError::Forbidden),
        };
        self.state.chat_messages.push(ChatMessage {
            id: Uuid::new_v4().to_string(),
            sender,
            text: text.to_owned(),
            sent_at_ms: now_ms(),
        });
        if self.state.chat_messages.len() > MAX_CHAT_MESSAGES {
            let excess = self.state.chat_messages.len() - MAX_CHAT_MESSAGES;
            self.state.chat_messages.drain(0..excess);
        }
        Ok(())
    }

    fn chat_delete(&mut self, message_id: &str) -> Result<(), CoreError> {
        if Uuid::parse_str(message_id).is_err() {
            return Err(CoreError::InvalidInput("invalid chat message ID".into()));
        }
        let before = self.state.chat_messages.len();
        self.state
            .chat_messages
            .retain(|message| message.id != message_id);
        if self.state.chat_messages.len() == before {
            return Err(CoreError::NotFound("chat message not found".into()));
        }
        Ok(())
    }

    fn playlist_rename(&mut self, id: &str, name: &str) -> Result<(), CoreError> {
        let playlist = self.playlist_mut(id)?;
        playlist.name = validated_name(name)?;
        playlist.updated_at_ms = now_ms();
        Ok(())
    }

    fn playlist_delete(&mut self, id: &str) -> Result<(), CoreError> {
        let before = self.state.playlists.len();
        self.state.playlists.retain(|playlist| playlist.id != id);
        if self.state.playlists.len() == before {
            return Err(CoreError::NotFound("playlist not found".into()));
        }
        Ok(())
    }

    fn playlist_add(&mut self, id: &str, track_id: String) -> Result<(), CoreError> {
        self.ensure_track(&track_id)?;
        let playlist = self.playlist_mut(id)?;
        playlist.track_ids.push(track_id);
        playlist.updated_at_ms = now_ms();
        Ok(())
    }

    fn playlist_remove(&mut self, id: &str, index: usize) -> Result<(), CoreError> {
        let playlist = self.playlist_mut(id)?;
        if index >= playlist.track_ids.len() {
            return Err(CoreError::InvalidInput(
                "playlist index is out of range".into(),
            ));
        }
        playlist.track_ids.remove(index);
        playlist.updated_at_ms = now_ms();
        Ok(())
    }

    fn playlist_move(&mut self, id: &str, from: usize, to: usize) -> Result<(), CoreError> {
        let playlist = self.playlist_mut(id)?;
        move_item(&mut playlist.track_ids, from, to)?;
        playlist.updated_at_ms = now_ms();
        Ok(())
    }

    fn favorite_set(&mut self, track_id: &str, favorite: bool) -> Result<(), CoreError> {
        self.ensure_track(track_id)?;
        self.state.favorites.retain(|existing| existing != track_id);
        if favorite {
            self.state.favorites.push(track_id.to_owned());
        }
        Ok(())
    }

    fn report_playback(&mut self, status: PlaybackStatus, position_ms: u64, error: Option<String>) {
        self.state.player.status = status;
        self.state.player.position_ms = position_ms;
        self.state.player.last_error = error;
        if self.state.player.status == PlaybackStatus::Stopped
            && self.state.player.current_track_id.is_some()
        {
            self.next(true);
        }
    }

    fn play(&mut self) {
        if self.state.player.current_track_id.is_none() && !self.state.player.queue.is_empty() {
            self.state.player.queue_cursor = Some(0);
            self.state.player.current_track_id = self.state.player.queue.first().cloned();
            self.record_history();
        }
        if self.state.player.current_track_id.is_some() {
            self.state.player.status = PlaybackStatus::Playing;
            self.state.player.last_error = None;
        }
    }

    fn play_track(&mut self, track_id: &str) -> Result<(), CoreError> {
        self.ensure_track(track_id)?;
        let cursor = self
            .state
            .player
            .queue
            .iter()
            .position(|existing| existing == track_id)
            .unwrap_or_else(|| {
                self.queue_add(track_id.to_owned());
                self.state.player.queue.len() - 1
            });
        self.state.player.queue_cursor = Some(cursor);
        self.state.player.current_track_id = Some(track_id.to_owned());
        self.state.player.position_ms = 0;
        self.state.player.status = PlaybackStatus::Playing;
        self.state.player.last_error = None;
        self.record_history();
        Ok(())
    }

    fn seek(&mut self, position_ms: u64, expected_track_id: Option<&str>) -> Result<(), CoreError> {
        let Some(track_id) = self.state.player.current_track_id.as_deref() else {
            return Err(CoreError::InvalidInput("no track is selected".into()));
        };
        if expected_track_id.is_some_and(|expected| expected != track_id) {
            return Err(CoreError::Conflict);
        }
        let track = self
            .catalog
            .track(track_id)?
            .ok_or_else(|| CoreError::NotFound("track not found".into()))?;
        self.state.player.position_ms = if track.duration_ms == 0 {
            position_ms
        } else {
            position_ms.min(track.duration_ms)
        };
        Ok(())
    }

    fn next(&mut self, natural_end: bool) {
        if self.state.player.queue.is_empty() {
            self.state.player.status = PlaybackStatus::Stopped;
            return;
        }
        if natural_end && self.state.player.repeat == RepeatMode::One {
            self.state.player.position_ms = 0;
            self.state.player.status = PlaybackStatus::Playing;
            self.record_history();
            return;
        }
        let current = self.state.player.queue_cursor.unwrap_or(0);
        let next = current.saturating_add(1);
        if next < self.state.player.queue.len() {
            self.select_queue_index(next);
        } else if self.state.player.repeat == RepeatMode::All {
            self.select_queue_index(0);
        } else {
            self.state.player.status = PlaybackStatus::Stopped;
            self.state.player.position_ms = 0;
        }
    }

    fn previous(&mut self) {
        if self.state.player.position_ms > 5_000 {
            self.state.player.position_ms = 0;
            return;
        }
        let current = self.state.player.queue_cursor.unwrap_or(0);
        if current > 0 {
            self.select_queue_index(current - 1);
        } else {
            self.state.player.position_ms = 0;
        }
    }

    fn select_queue_index(&mut self, index: usize) {
        self.state.player.queue_cursor = Some(index);
        self.state.player.current_track_id = self.state.player.queue.get(index).cloned();
        self.state.player.position_ms = 0;
        self.state.player.status = PlaybackStatus::Playing;
        self.state.player.last_error = None;
        self.record_history();
    }

    fn queue_remove(&mut self, index: usize) -> Result<(), CoreError> {
        if index >= self.state.player.queue.len() {
            return Err(CoreError::InvalidInput(
                "queue index is out of range".into(),
            ));
        }
        let removed = self.state.player.queue[index].clone();
        let occurrence = self.state.player.queue[..index]
            .iter()
            .filter(|track_id| *track_id == &removed)
            .count();
        self.state.player.queue.remove(index);
        if self.state.player.shuffle
            && let Some(original) = self.state.player.queue_before_shuffle.as_mut()
        {
            remove_occurrence(original, &removed, occurrence);
        }
        match self.state.player.queue_cursor {
            Some(cursor) if cursor == index => {
                if self.state.player.queue.is_empty() {
                    self.state.player.queue_cursor = None;
                    self.state.player.current_track_id = None;
                    self.state.player.status = PlaybackStatus::Stopped;
                } else {
                    self.select_queue_index(index.min(self.state.player.queue.len() - 1));
                }
            }
            Some(cursor) if cursor > index => self.state.player.queue_cursor = Some(cursor - 1),
            _ => {}
        }
        Ok(())
    }

    fn set_shuffle(&mut self, enabled: bool) {
        if self.state.player.shuffle == enabled {
            return;
        }
        let current = self.state.player.current_track_id.clone();
        if enabled {
            self.state.player.queue_before_shuffle = Some(self.state.player.queue.clone());
            let salt = self.state.revision.to_le_bytes();
            self.state.player.queue.sort_by_key(|track_id| {
                let mut input = salt.to_vec();
                input.extend_from_slice(track_id.as_bytes());
                blake3::hash(&input).as_bytes().to_owned()
            });
        } else if let Some(original) = self.state.player.queue_before_shuffle.take() {
            self.state.player.queue = original;
        }
        self.state.player.queue_cursor = current
            .as_ref()
            .and_then(|id| self.state.player.queue.iter().position(|entry| entry == id));
        self.state.player.shuffle = enabled;
    }

    fn queue_add(&mut self, track_id: String) {
        if self.state.player.shuffle {
            self.state
                .player
                .queue_before_shuffle
                .get_or_insert_with(|| self.state.player.queue.clone())
                .push(track_id.clone());
        }
        self.state.player.queue.push(track_id);
    }

    fn playlist_create(&mut self, name: &str) -> Result<(), CoreError> {
        let name = validated_name(name)?;
        if self
            .state
            .playlists
            .iter()
            .any(|playlist| playlist.name.eq_ignore_ascii_case(&name))
        {
            return Err(CoreError::InvalidInput(
                "a playlist with that name already exists".into(),
            ));
        }
        let timestamp = now_ms();
        self.state.playlists.push(Playlist {
            id: Uuid::new_v4().to_string(),
            name,
            track_ids: Vec::new(),
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        });
        Ok(())
    }

    fn playlist_mut(&mut self, id: &str) -> Result<&mut Playlist, CoreError> {
        self.state
            .playlists
            .iter_mut()
            .find(|playlist| playlist.id == id)
            .ok_or_else(|| CoreError::NotFound("playlist not found".into()))
    }

    fn ensure_track(&self, id: &str) -> Result<(), CoreError> {
        match self.catalog.track(id)? {
            Some(track) if track.available => Ok(()),
            Some(_) => Err(CoreError::NotFound("track is currently unavailable".into())),
            None => Err(CoreError::NotFound("track not found".into())),
        }
    }

    fn record_history(&mut self) {
        if let Some(track_id) = self.state.player.current_track_id.clone() {
            self.state.history.insert(
                0,
                HistoryEntry {
                    track_id,
                    played_at_ms: now_ms(),
                },
            );
            self.state.history.truncate(MAX_HISTORY);
        }
    }

    fn bump_revision(&mut self) {
        self.state.revision = self.state.revision.saturating_add(1);
    }

    fn persist(&mut self) -> Result<(), CoreError> {
        self.catalog.save_state(&self.state)
    }
}

fn has_local_player_priority(request: &ActionRequest) -> bool {
    if request.actor.role != Role::Local {
        return false;
    }
    matches!(
        &request.action,
        Action::Play
            | Action::Pause
            | Action::Stop
            | Action::PlayTrack { .. }
            | Action::Seek {
                track_id: Some(_),
                ..
            }
            | Action::Next
            | Action::Previous
            | Action::SetVolume { .. }
            | Action::SetMuted { .. }
            | Action::SetShuffle { .. }
            | Action::SetRepeat { .. }
    )
}

fn validate_recognition(recognition: &TrackRecognition) -> Result<(), CoreError> {
    fn validate_optional(value: Option<&str>, maximum: usize) -> bool {
        value.is_none_or(|candidate| {
            let trimmed = candidate.trim();
            !trimmed.is_empty()
                && trimmed.len() <= maximum
                && !trimmed.chars().any(char::is_control)
        })
    }

    if !validate_optional(recognition.provider.as_deref(), 64)
        || !validate_optional(recognition.label.as_deref(), 400)
        || !validate_optional(recognition.title.as_deref(), 180)
        || !validate_optional(recognition.artist.as_deref(), 180)
        || !validate_optional(recognition.album.as_deref(), 220)
        || !validate_optional(recognition.genre.as_deref(), 120)
        || !validate_optional(recognition.external_id.as_deref(), 160)
    {
        return Err(CoreError::InvalidInput(
            "recognition result is invalid".into(),
        ));
    }
    if recognition.status == RecognitionStatus::Recognized
        && (recognition.provider.is_none() || recognition.label.is_none())
    {
        return Err(CoreError::InvalidInput(
            "recognized tracks require a provider and label".into(),
        ));
    }
    if recognition.status != RecognitionStatus::Recognized
        && (recognition.label.is_some()
            || recognition.title.is_some()
            || recognition.artist.is_some()
            || recognition.album.is_some()
            || recognition.genre.is_some())
    {
        return Err(CoreError::InvalidInput(
            "only recognized tracks can have recognition metadata".into(),
        ));
    }
    Ok(())
}

fn validate_request(request: &ActionRequest) -> Result<(), CoreError> {
    if request.protocol != PROTOCOL_VERSION {
        return Err(CoreError::InvalidInput(
            "unsupported protocol version".into(),
        ));
    }
    if request.command_id.is_empty() || request.command_id.len() > 128 {
        return Err(CoreError::InvalidInput("invalid command ID".into()));
    }
    if request
        .actor
        .peer_id
        .as_ref()
        .is_some_and(|peer| peer.len() > 128)
    {
        return Err(CoreError::InvalidInput("invalid peer ID".into()));
    }
    Ok(())
}

fn validated_name(name: &str) -> Result<String, CoreError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 80 {
        return Err(CoreError::InvalidInput(
            "playlist name must contain 1 to 80 characters".into(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn move_item<T>(items: &mut Vec<T>, from: usize, to: usize) -> Result<(), CoreError> {
    if from >= items.len() || to >= items.len() {
        return Err(CoreError::InvalidInput("move index is out of range".into()));
    }
    if from != to {
        let item = items.remove(from);
        items.insert(to, item);
    }
    Ok(())
}

fn remove_occurrence(items: &mut Vec<String>, value: &str, occurrence: usize) {
    if let Some(index) = items
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.as_str() == value)
        .nth(occurrence)
        .map(|(index, _)| index)
    {
        items.remove(index);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::{Actor, ChatSender};

    fn request(revision: u64, action: Action) -> ActionRequest {
        ActionRequest {
            protocol: 1,
            command_id: Uuid::new_v4().to_string(),
            expected_revision: Some(revision),
            actor: Actor::local(),
            action,
        }
    }

    #[test]
    fn creates_and_renames_playlist() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let revision = core.snapshot()?.revision;
        core.execute(request(
            revision,
            Action::PlaylistCreate {
                name: "Sunday".into(),
            },
        ))?;
        let snapshot = core.snapshot()?;
        assert_eq!(snapshot.playlists[0].name, "Sunday");
        let id = snapshot.playlists[0].id.clone();
        core.execute(request(
            snapshot.revision,
            Action::PlaylistRename {
                playlist_id: id,
                name: "Late Sunday".into(),
            },
        ))?;
        assert_eq!(core.snapshot()?.playlists[0].name, "Late Sunday");
        Ok(())
    }

    #[test]
    fn rejects_stale_revision_and_listener_mutation() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let initial = core.snapshot()?.revision;
        core.execute(request(
            initial,
            Action::PlaylistCreate { name: "One".into() },
        ))?;
        assert!(matches!(
            core.execute(request(
                initial,
                Action::PlaylistCreate { name: "Two".into() },
            )),
            Err(CoreError::Conflict)
        ));
        let mut listener = request(core.snapshot()?.revision, Action::Pause);
        listener.actor.role = Role::Listener;
        assert!(matches!(core.execute(listener), Err(CoreError::Forbidden)));
        Ok(())
    }

    #[test]
    fn local_player_command_wins_a_concurrent_controller_revision() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let initial = core.snapshot()?.revision;
        let mut controller = request(initial, Action::SetVolume { volume: 12 });
        controller.actor = Actor {
            role: Role::Controller,
            peer_id: Some("browser-controller".into()),
        };
        core.execute(controller)?;

        core.execute(request(initial, Action::SetVolume { volume: 42 }))?;
        let local = core.snapshot()?;
        assert_eq!(local.player.volume, 42);

        let mut stale_controller = request(
            local.revision.saturating_sub(1),
            Action::SetVolume { volume: 7 },
        );
        stale_controller.actor = Actor {
            role: Role::Controller,
            peer_id: Some("browser-controller".into()),
        };
        assert!(matches!(
            core.execute(stale_controller),
            Err(CoreError::Conflict)
        ));
        assert_eq!(core.snapshot()?.player.volume, 42);
        Ok(())
    }

    #[test]
    fn local_seek_never_rebases_onto_a_remotely_selected_track()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let album = directory.path().join("Artist/Album");
        fs::create_dir_all(&album)?;
        fs::write(album.join("01 - First.mp3"), b"first fixture")?;
        fs::write(album.join("02 - Second.mp3"), b"second fixture")?;
        let mut core = ZuradioCore::in_memory()?;
        let scanned = core.scan(&[directory.path().to_path_buf()])?;
        let first = scanned
            .tracks
            .first()
            .ok_or("first track missing")?
            .id
            .clone();
        let second = scanned
            .tracks
            .get(1)
            .ok_or("second track missing")?
            .id
            .clone();
        core.execute(request(
            scanned.revision,
            Action::PlayTrack {
                track_id: first.clone(),
            },
        ))?;
        let before_remote = core.snapshot()?.revision;

        let mut controller = request(
            before_remote,
            Action::PlayTrack {
                track_id: second.clone(),
            },
        );
        controller.actor = Actor {
            role: Role::Controller,
            peer_id: Some("browser-controller".into()),
        };
        core.execute(controller)?;

        assert!(matches!(
            core.execute(request(
                before_remote,
                Action::Seek {
                    position_ms: 12_000,
                    track_id: Some(first),
                },
            )),
            Err(CoreError::Conflict)
        ));
        let current = core.snapshot()?;
        assert_eq!(current.player.current_track_id, Some(second));
        assert_eq!(current.player.position_ms, 0);
        Ok(())
    }

    #[test]
    fn deduplicates_command_ids() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let revision = core.snapshot()?.revision;
        let command = request(
            revision,
            Action::PlaylistCreate {
                name: "Once".into(),
            },
        );
        let first = core.execute(command.clone())?;
        let second = core.execute(command)?;
        assert_eq!(first, second);
        assert_eq!(core.snapshot()?.playlists.len(), 1);
        Ok(())
    }

    #[test]
    fn chat_persists_sender_identity_and_is_bounded() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let database = directory.path().join("catalog.sqlite3");
        {
            let mut core = ZuradioCore::open(&database)?;
            core.execute(request(
                core.snapshot()?.revision,
                Action::ChatPost {
                    text: "  Message from this computer  ".into(),
                },
            ))?;
            let mut remote = request(
                core.snapshot()?.revision,
                Action::ChatPost {
                    text: "Message from the browser".into(),
                },
            );
            remote.actor = Actor {
                role: Role::Controller,
                peer_id: Some("browser-controller".into()),
            };
            core.execute(remote)?;
            for index in 0..MAX_CHAT_MESSAGES {
                core.execute(request(
                    core.snapshot()?.revision,
                    Action::ChatPost {
                        text: format!("bounded message {index}"),
                    },
                ))?;
            }
            let snapshot = core.snapshot()?;
            assert_eq!(snapshot.chat_messages.len(), MAX_CHAT_MESSAGES);
            assert_eq!(snapshot.chat_messages[0].text, "bounded message 0");
        }

        let reopened = ZuradioCore::open(&database)?.snapshot()?;
        assert_eq!(reopened.chat_messages.len(), MAX_CHAT_MESSAGES);
        assert_eq!(
            reopened.chat_messages.last().map(|entry| entry.sender),
            Some(ChatSender::Local)
        );
        Ok(())
    }

    #[test]
    fn chat_enforces_content_and_clear_authorization() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let revision = core.snapshot()?.revision;
        assert!(matches!(
            core.execute(request(
                revision,
                Action::ChatPost {
                    text: "\u{0000}".into(),
                },
            )),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            core.execute(request(
                revision,
                Action::ChatPost {
                    text: "x".repeat(MAX_CHAT_MESSAGE_CHARS + 1),
                },
            )),
            Err(CoreError::InvalidInput(_))
        ));

        core.execute(request(
            revision,
            Action::ChatPost {
                text: "keep me".into(),
            },
        ))?;
        let message_id = core.snapshot()?.chat_messages[0].id.clone();
        let mut remote_delete = request(
            core.snapshot()?.revision,
            Action::ChatDelete {
                message_id: message_id.clone(),
            },
        );
        remote_delete.actor = Actor {
            role: Role::Controller,
            peer_id: Some("browser-controller".into()),
        };
        assert!(matches!(
            core.execute(remote_delete),
            Err(CoreError::Forbidden)
        ));
        let mut remote_clear = request(core.snapshot()?.revision, Action::ChatClear);
        remote_clear.actor = Actor {
            role: Role::Controller,
            peer_id: Some("browser-controller".into()),
        };
        assert!(matches!(
            core.execute(remote_clear),
            Err(CoreError::Forbidden)
        ));
        assert_eq!(core.snapshot()?.chat_messages.len(), 1);

        core.execute(request(
            core.snapshot()?.revision,
            Action::ChatDelete { message_id },
        ))?;
        assert!(core.snapshot()?.chat_messages.is_empty());
        core.execute(request(
            core.snapshot()?.revision,
            Action::ChatPost {
                text: "clear me".into(),
            },
        ))?;
        core.execute(request(core.snapshot()?.revision, Action::ChatClear))?;
        assert!(core.snapshot()?.chat_messages.is_empty());
        Ok(())
    }

    #[test]
    fn restores_queue_order_after_shuffle_and_keeps_new_tracks() -> Result<(), CoreError> {
        let mut core = ZuradioCore::in_memory()?;
        let original = vec!["third".into(), "first".into(), "second".into()];
        core.state.player.queue = original.clone();

        core.set_shuffle(true);
        assert_eq!(
            core.state.player.queue_before_shuffle,
            Some(original.clone())
        );
        core.queue_add("fourth".into());
        core.set_shuffle(false);

        let mut expected = original;
        expected.push("fourth".into());
        assert_eq!(core.state.player.queue, expected);
        assert_eq!(core.state.player.queue_before_shuffle, None);
        Ok(())
    }

    #[test]
    fn metadata_edits_survive_rescans() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let album = directory.path().join("Source Artist/Source Album (2022)");
        fs::create_dir_all(&album)?;
        fs::write(album.join("01 - Source Title.mp3"), b"fixture")?;
        let mut core = ZuradioCore::in_memory()?;
        let scanned = core.scan(&[directory.path().to_path_buf()])?;
        let track = scanned.tracks.first().ok_or("track missing")?;
        core.execute(request(
            scanned.revision,
            Action::EditTrackMetadata {
                track_id: track.id.clone(),
                title: "Edited Title".into(),
                artist: "Edited Artist".into(),
                album: "Edited Album".into(),
                album_artist: "Edited Album Artist".into(),
                track_number: Some(9),
                disc_number: Some(2),
                year: Some(2030),
            },
        ))?;
        let rescanned = core.scan(&[directory.path().to_path_buf()])?;
        let edited = rescanned.tracks.first().ok_or("track missing")?;
        assert_eq!(edited.title, "Edited Title");
        assert_eq!(edited.artist, "Edited Artist");
        assert_eq!(edited.album, "Edited Album");
        assert_eq!(edited.year, Some(2030));
        Ok(())
    }

    #[test]
    fn recognition_stays_parallel_to_metadata_and_resets_when_bytes_change()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let track_path = directory.path().join("Artist/Album/01 - Folder Title.mp3");
        fs::create_dir_all(track_path.parent().ok_or("album path missing")?)?;
        fs::write(&track_path, b"first audio fixture")?;
        let mut core = ZuradioCore::in_memory()?;
        let scanned = core.scan(&[directory.path().to_path_buf()])?;
        let track_id = scanned.tracks.first().ok_or("track missing")?.id.clone();

        let recognized = core.set_track_recognition(
            &track_id,
            &TrackRecognition {
                status: RecognitionStatus::Recognized,
                provider: Some("shazam_songrec".into()),
                label: Some("Recognized Artist — Recognized Title".into()),
                title: Some("Recognized Title".into()),
                artist: Some("Recognized Artist".into()),
                album: Some("Recognized Album".into()),
                genre: Some("Electronic".into()),
                external_id: Some("shazam-track-1".into()),
                updated_at_ms: Some(1),
            },
        )?;
        let track = recognized
            .tracks
            .first()
            .ok_or("recognized track missing")?;
        assert_eq!(track.title, "Folder Title");
        assert_eq!(
            track.recognition.label.as_deref(),
            Some("Recognized Artist — Recognized Title")
        );
        assert_eq!(track.recognition.genre.as_deref(), Some("Electronic"));
        assert!(core.recognition_candidates(false)?.is_empty());

        fs::write(&track_path, b"second and different audio fixture bytes")?;
        let rescanned = core.scan(&[directory.path().to_path_buf()])?;
        let track = rescanned.tracks.first().ok_or("rescanned track missing")?;
        assert_eq!(track.recognition, TrackRecognition::default());
        assert_eq!(core.recognition_candidates(false)?.len(), 1);
        Ok(())
    }

    #[test]
    fn catalogues_one_new_file_without_hiding_existing_tracks()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let first = directory.path().join("Artist/Album/01 - First.mp3");
        let second = directory.path().join("Artist/Album/02 - Second.mp3");
        fs::create_dir_all(first.parent().ok_or("missing parent")?)?;
        fs::write(&first, b"first fixture")?;
        let mut core = ZuradioCore::in_memory()?;
        core.scan(&[directory.path().to_path_buf()])?;

        fs::write(&second, b"second fixture")?;
        let snapshot = core.catalog_file(&second, directory.path())?;

        assert_eq!(snapshot.tracks.len(), 2);
        assert!(snapshot.tracks.iter().any(|track| track.title == "First"));
        assert!(snapshot.tracks.iter().any(|track| track.title == "Second"));
        Ok(())
    }

    #[test]
    fn snapshots_hide_unavailable_tracks_without_erasing_playlist_references()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let first = directory.path().join("Artist/Album/01 - First.mp3");
        let second = directory.path().join("Artist/Album/02 - Second.mp3");
        fs::create_dir_all(first.parent().ok_or("missing parent")?)?;
        fs::write(&first, b"first fixture")?;
        fs::write(&second, b"second fixture")?;
        let mut core = ZuradioCore::in_memory()?;
        let scanned = core.scan(&[directory.path().to_path_buf()])?;
        let second_id = scanned
            .tracks
            .iter()
            .find(|track| track.title == "Second")
            .ok_or("second track missing")?
            .id
            .clone();
        core.execute(request(
            scanned.revision,
            Action::PlaylistCreate {
                name: "Preserved".into(),
            },
        ))?;
        let with_playlist = core.snapshot()?;
        let playlist_id = with_playlist.playlists[0].id.clone();
        core.execute(request(
            with_playlist.revision,
            Action::PlaylistAdd {
                playlist_id,
                track_id: second_id.clone(),
            },
        ))?;

        fs::remove_file(&second)?;
        let rescanned = core.scan(&[directory.path().to_path_buf()])?;

        assert_eq!(rescanned.tracks.len(), 1);
        assert_eq!(rescanned.tracks[0].title, "First");
        assert_eq!(rescanned.playlists[0].track_ids, vec![second_id]);
        Ok(())
    }
}
