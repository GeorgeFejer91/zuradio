use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::read_from_path;
use lofty::tag::Accessor;
use rusqlite::{Connection, OptionalExtension, params};
use walkdir::WalkDir;

use crate::{CoreError, StoredState, Track};

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "mp4", "ogg", "opus", "wav", "webm",
];
const MAX_ARTWORK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artwork {
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScannedTrack {
    pub(crate) track: Track,
    pub(crate) canonical_path: PathBuf,
    pub(crate) file_size: u64,
    pub(crate) modified_ms: i64,
}

#[derive(Debug)]
pub(crate) struct Catalog {
    connection: Connection,
}

impl Catalog {
    pub(crate) fn open(path: &Path) -> Result<Self, CoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub(crate) fn in_memory() -> Result<Self, CoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, CoreError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT NOT NULL,
                album_artist TEXT NOT NULL,
                track_number INTEGER,
                disc_number INTEGER,
                year INTEGER,
                duration_ms INTEGER NOT NULL,
                format TEXT NOT NULL,
                has_artwork INTEGER NOT NULL,
                available INTEGER NOT NULL,
                file_size INTEGER NOT NULL,
                modified_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_artist_album
                ON tracks(artist COLLATE NOCASE, album COLLATE NOCASE, track_number);
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json TEXT NOT NULL
            );",
        )?;
        Ok(Self { connection })
    }

    pub(crate) fn load_state(&self) -> Result<StoredState, CoreError> {
        let stored: Option<String> = self
            .connection
            .query_row("SELECT json FROM app_state WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        match stored {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(StoredState::default()),
        }
    }

    pub(crate) fn save_state(&mut self, state: &StoredState) -> Result<(), CoreError> {
        let json = serde_json::to_string(state)?;
        self.connection.execute(
            "INSERT INTO app_state(id, json) VALUES(1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            [json],
        )?;
        Ok(())
    }

    pub(crate) fn replace_scan(&mut self, tracks: &[ScannedTrack]) -> Result<(), CoreError> {
        let transaction = self.connection.transaction()?;
        transaction.execute("UPDATE tracks SET available = 0", [])?;
        {
            let mut statement = transaction.prepare_cached(
                "INSERT INTO tracks(
                    id, path, title, artist, album, album_artist, track_number, disc_number,
                    year, duration_ms, format, has_artwork, available, file_size, modified_ms
                 ) VALUES(
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14
                 ) ON CONFLICT(path) DO UPDATE SET
                    id = excluded.id,
                    title = excluded.title,
                    artist = excluded.artist,
                    album = excluded.album,
                    album_artist = excluded.album_artist,
                    track_number = excluded.track_number,
                    disc_number = excluded.disc_number,
                    year = excluded.year,
                    duration_ms = excluded.duration_ms,
                    format = excluded.format,
                    has_artwork = excluded.has_artwork,
                    available = 1,
                    file_size = excluded.file_size,
                    modified_ms = excluded.modified_ms",
            )?;
            for scanned in tracks {
                let track = &scanned.track;
                statement.execute(params![
                    track.id,
                    scanned.canonical_path.to_string_lossy(),
                    track.title,
                    track.artist,
                    track.album,
                    track.album_artist,
                    track.track_number,
                    track.disc_number,
                    track.year,
                    i64::try_from(track.duration_ms).unwrap_or(i64::MAX),
                    track.format,
                    track.has_artwork,
                    i64::try_from(scanned.file_size).unwrap_or(i64::MAX),
                    scanned.modified_ms,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn tracks(&self) -> Result<Vec<Track>, CoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, artist, album, album_artist, track_number, disc_number,
                    year, duration_ms, format, available, has_artwork
             FROM tracks
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE,
                      COALESCE(disc_number, 1), COALESCE(track_number, 0), title COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], track_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    pub(crate) fn track(&self, id: &str) -> Result<Option<Track>, CoreError> {
        self.connection
            .query_row(
                "SELECT id, title, artist, album, album_artist, track_number, disc_number,
                        year, duration_ms, format, available, has_artwork
                 FROM tracks WHERE id = ?1",
                [id],
                track_from_row,
            )
            .optional()
            .map_err(CoreError::from)
    }

    pub(crate) fn track_path(&self, id: &str) -> Result<Option<PathBuf>, CoreError> {
        self.connection
            .query_row(
                "SELECT path FROM tracks WHERE id = ?1 AND available = 1",
                [id],
                |row| row.get::<_, String>(0).map(PathBuf::from),
            )
            .optional()
            .map_err(CoreError::from)
    }

    pub(crate) fn artwork(&self, id: &str) -> Result<Option<Artwork>, CoreError> {
        let Some(path) = self.track_path(id)? else {
            return Ok(None);
        };
        let tagged = read_from_path(&path)
            .map_err(|error| CoreError::Media(format!("cannot read embedded artwork: {error}")))?;
        let Some(picture) = tagged
            .primary_tag()
            .or_else(|| tagged.first_tag())
            .and_then(|tag| tag.pictures().first())
        else {
            return Ok(None);
        };
        if picture.data().is_empty() || picture.data().len() > MAX_ARTWORK_BYTES {
            return Ok(None);
        }
        let Some(mime_type) = picture.mime_type().map(lofty::picture::MimeType::as_str) else {
            return Ok(None);
        };
        if !mime_type.starts_with("image/") {
            return Ok(None);
        }
        Ok(Some(Artwork {
            mime_type: mime_type.to_owned(),
            data: picture.data().to_vec(),
        }))
    }
}

fn track_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get(3)?,
        album_artist: row.get(4)?,
        track_number: row.get(5)?,
        disc_number: row.get(6)?,
        year: row.get(7)?,
        duration_ms: u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
        format: row.get(9)?,
        available: row.get(10)?,
        has_artwork: row.get(11)?,
    })
}

pub(crate) fn scan_music(roots: &[PathBuf]) -> Result<Vec<ScannedTrack>, CoreError> {
    if roots.is_empty() {
        return Err(CoreError::InvalidInput(
            "at least one music folder is required".into(),
        ));
    }

    let mut canonical_roots = Vec::with_capacity(roots.len());
    for root in roots {
        let canonical = root
            .canonicalize()
            .map_err(|error| CoreError::Media(format!("cannot open music folder: {error}")))?;
        if !canonical.is_dir() {
            return Err(CoreError::InvalidInput(
                "music root is not a directory".into(),
            ));
        }
        canonical_roots.push(canonical);
    }

    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for root in &canonical_roots {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() || !is_supported(entry.path()) {
                continue;
            }
            let Ok(canonical) = entry.path().canonicalize() else {
                continue;
            };
            if !canonical.starts_with(root) || !seen.insert(canonical.clone()) {
                continue;
            }
            if let Ok(track) = inspect_track(&canonical) {
                output.push(track);
            }
        }
    }
    Ok(output)
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn inspect_track(path: &Path) -> Result<ScannedTrack, CoreError> {
    let metadata = fs::metadata(path).map_err(|error| CoreError::Media(error.to_string()))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| {
            i64::try_from(value.as_millis()).unwrap_or(i64::MAX)
        });
    let fallback_title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_owned();

    let parsed = read_from_path(path).ok();
    let tag = parsed
        .as_ref()
        .and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
    let properties = parsed.as_ref().map(AudioFile::properties);
    let title = tag
        .and_then(Accessor::title)
        .map_or(fallback_title, std::borrow::Cow::into_owned);
    let artist = tag
        .and_then(Accessor::artist)
        .map_or_else(|| "Unknown Artist".to_owned(), std::borrow::Cow::into_owned);
    let album = tag
        .and_then(Accessor::album)
        .map_or_else(|| "Unknown Album".to_owned(), std::borrow::Cow::into_owned);
    let album_artist = tag
        .and_then(|value| value.get_string(lofty::tag::ItemKey::AlbumArtist))
        .map_or_else(|| artist.clone(), ToOwned::to_owned);
    let duration_ms = properties.map_or(0, |value| {
        u64::try_from(value.duration().as_millis()).unwrap_or(u64::MAX)
    });
    let id = blake3::hash(path.to_string_lossy().as_bytes())
        .to_hex()
        .to_string();
    let format = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    let has_artwork = tag.is_some_and(|value| value.picture_count() > 0);

    Ok(ScannedTrack {
        track: Track {
            id,
            title,
            artist,
            album,
            album_artist,
            track_number: tag.and_then(Accessor::track),
            disc_number: tag.and_then(Accessor::disk),
            year: tag
                .and_then(Accessor::date)
                .map(|date| u32::from(date.year)),
            duration_ms,
            format,
            available: true,
            has_artwork,
        },
        canonical_path: path.to_owned(),
        file_size: metadata.len(),
        modified_ms,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn ignores_non_media_and_does_not_follow_symlinks() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let outside = tempdir()?;
        fs::write(directory.path().join("notes.txt"), b"not music")?;
        fs::write(directory.path().join("song.mp3"), b"not really mp3")?;
        fs::write(outside.path().join("outside.mp3"), b"not really mp3")?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), directory.path().join("linked-library"))?;
        let found = scan_music(&[directory.path().to_path_buf()])?;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].track.title, "song");
        Ok(())
    }
}
