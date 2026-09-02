use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::read_from_path;
use lofty::tag::Accessor;
use rusqlite::{Connection, OptionalExtension, params};
use walkdir::WalkDir;

use crate::{CoreError, RecognitionStatus, StoredState, Track, TrackRecognition};

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
                ,title_override TEXT
                ,artist_override TEXT
                ,album_override TEXT
                ,album_artist_override TEXT
                ,track_number_override INTEGER
                ,disc_number_override INTEGER
                ,year_override INTEGER
                ,recognition_status TEXT NOT NULL DEFAULT 'pending'
                ,recognition_provider TEXT
                ,recognition_label TEXT
                ,recognition_title TEXT
                ,recognition_artist TEXT
                ,recognition_album TEXT
                ,recognition_genre TEXT
                ,recognition_external_id TEXT
                ,recognition_updated_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_artist_album
                ON tracks(artist COLLATE NOCASE, album COLLATE NOCASE, track_number);
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json TEXT NOT NULL
            );",
        )?;
        ensure_override_columns(&connection)?;
        ensure_recognition_columns(&connection)?;
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
        upsert_tracks(&transaction, tracks)?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn upsert_scan(&mut self, track: &ScannedTrack) -> Result<(), CoreError> {
        let transaction = self.connection.transaction()?;
        upsert_tracks(&transaction, std::slice::from_ref(track))?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn tracks(&self) -> Result<Vec<Track>, CoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id,
                    COALESCE(title_override, title),
                    COALESCE(artist_override, artist),
                    COALESCE(album_override, album),
                    COALESCE(album_artist_override, album_artist),
                    COALESCE(track_number_override, track_number),
                    COALESCE(disc_number_override, disc_number),
                    COALESCE(year_override, year),
                    duration_ms, format, available, has_artwork,
                    recognition_status, recognition_provider, recognition_label,
                    recognition_title, recognition_artist, recognition_album, recognition_genre,
                    recognition_external_id, recognition_updated_ms
             FROM tracks
             WHERE available = 1
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE,
                      COALESCE(disc_number, 1), COALESCE(track_number, 0), title COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], track_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    pub(crate) fn track(&self, id: &str) -> Result<Option<Track>, CoreError> {
        self.connection
            .query_row(
                "SELECT id,
                        COALESCE(title_override, title),
                        COALESCE(artist_override, artist),
                        COALESCE(album_override, album),
                        COALESCE(album_artist_override, album_artist),
                        COALESCE(track_number_override, track_number),
                        COALESCE(disc_number_override, disc_number),
                        COALESCE(year_override, year),
                        duration_ms, format, available, has_artwork,
                        recognition_status, recognition_provider, recognition_label,
                        recognition_title, recognition_artist, recognition_album, recognition_genre,
                        recognition_external_id, recognition_updated_ms
                 FROM tracks WHERE id = ?1",
                [id],
                track_from_row,
            )
            .optional()
            .map_err(CoreError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn update_track_metadata(
        &mut self,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        album_artist: &str,
        track_number: Option<u32>,
        disc_number: Option<u32>,
        year: Option<u32>,
    ) -> Result<(), CoreError> {
        let changed = self.connection.execute(
            "UPDATE tracks SET
                title_override = ?2,
                artist_override = ?3,
                album_override = ?4,
                album_artist_override = ?5,
                track_number_override = ?6,
                disc_number_override = ?7,
                year_override = ?8
             WHERE id = ?1",
            params![
                id,
                title,
                artist,
                album,
                album_artist,
                track_number,
                disc_number,
                year
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound("track not found".into()));
        }
        Ok(())
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

    pub(crate) fn recognition_candidates(
        &self,
        retry_failures: bool,
    ) -> Result<Vec<(String, PathBuf)>, CoreError> {
        let query = if retry_failures {
            "SELECT id, path
             FROM tracks
             WHERE available = 1
               AND recognition_status IN ('pending', 'unavailable', 'error')
             ORDER BY modified_ms ASC, id ASC"
        } else {
            "SELECT id, path
             FROM tracks
             WHERE available = 1
               AND recognition_status = 'pending'
             ORDER BY modified_ms ASC, id ASC"
        };
        let mut statement = self.connection.prepare(query)?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, PathBuf::from(row.get::<_, String>(1)?)))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    pub(crate) fn update_recognition(
        &mut self,
        id: &str,
        recognition: &TrackRecognition,
    ) -> Result<(), CoreError> {
        let changed = self.connection.execute(
            "UPDATE tracks SET
                recognition_status = ?2,
                recognition_provider = ?3,
                recognition_label = ?4,
                recognition_title = ?5,
                recognition_artist = ?6,
                recognition_album = ?7,
                recognition_genre = ?8,
                recognition_external_id = ?9,
                recognition_updated_ms = ?10
             WHERE id = ?1 AND available = 1",
            params![
                id,
                recognition_status_name(recognition.status),
                recognition.provider.as_deref(),
                recognition.label.as_deref(),
                recognition.title.as_deref(),
                recognition.artist.as_deref(),
                recognition.album.as_deref(),
                recognition.genre.as_deref(),
                recognition.external_id.as_deref(),
                recognition.updated_at_ms,
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::NotFound("track not found".into()));
        }
        Ok(())
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

fn ensure_override_columns(connection: &Connection) -> Result<(), CoreError> {
    for (name, definition) in [
        ("title_override", "TEXT"),
        ("artist_override", "TEXT"),
        ("album_override", "TEXT"),
        ("album_artist_override", "TEXT"),
        ("track_number_override", "INTEGER"),
        ("disc_number_override", "INTEGER"),
        ("year_override", "INTEGER"),
    ] {
        let exists = {
            let mut statement = connection.prepare("PRAGMA table_info(tracks)")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|column| column == name)
        };
        if !exists {
            connection.execute(
                &format!("ALTER TABLE tracks ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    Ok(())
}

fn ensure_recognition_columns(connection: &Connection) -> Result<(), CoreError> {
    for (name, definition) in [
        (
            "recognition_status",
            "TEXT NOT NULL DEFAULT 'pending' CHECK (recognition_status IN ('pending', 'recognized', 'no_match', 'unavailable', 'error'))",
        ),
        ("recognition_provider", "TEXT"),
        ("recognition_label", "TEXT"),
        ("recognition_title", "TEXT"),
        ("recognition_artist", "TEXT"),
        ("recognition_album", "TEXT"),
        ("recognition_genre", "TEXT"),
        ("recognition_external_id", "TEXT"),
        ("recognition_updated_ms", "INTEGER"),
    ] {
        let exists = {
            let mut statement = connection.prepare("PRAGMA table_info(tracks)")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|column| column == name)
        };
        if !exists {
            connection.execute(
                &format!("ALTER TABLE tracks ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    Ok(())
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
        recognition: TrackRecognition {
            status: recognition_status_from_name(&row.get::<_, String>(12)?)?,
            provider: row.get(13)?,
            label: row.get(14)?,
            title: row.get(15)?,
            artist: row.get(16)?,
            album: row.get(17)?,
            genre: row.get(18)?,
            external_id: row.get(19)?,
            updated_at_ms: row.get(20)?,
        },
    })
}

const fn recognition_status_name(status: RecognitionStatus) -> &'static str {
    match status {
        RecognitionStatus::Pending => "pending",
        RecognitionStatus::Recognized => "recognized",
        RecognitionStatus::NoMatch => "no_match",
        RecognitionStatus::Unavailable => "unavailable",
        RecognitionStatus::Error => "error",
    }
}

fn recognition_status_from_name(value: &str) -> rusqlite::Result<RecognitionStatus> {
    match value {
        "pending" => Ok(RecognitionStatus::Pending),
        "recognized" => Ok(RecognitionStatus::Recognized),
        "no_match" => Ok(RecognitionStatus::NoMatch),
        "unavailable" => Ok(RecognitionStatus::Unavailable),
        "error" => Ok(RecognitionStatus::Error),
        _ => Err(rusqlite::Error::InvalidColumnType(
            12,
            "recognition_status".into(),
            rusqlite::types::Type::Text,
        )),
    }
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
            if let Ok(track) = inspect_track(&canonical, root) {
                output.push(track);
            }
        }
    }
    Ok(output)
}

pub(crate) fn scan_file(path: &Path, root: &Path) -> Result<ScannedTrack, CoreError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| CoreError::Media(format!("cannot open music folder: {error}")))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| CoreError::Media(format!("cannot open music file: {error}")))?;
    if !canonical_root.is_dir()
        || !canonical_path.is_file()
        || !canonical_path.starts_with(&canonical_root)
        || !is_supported(&canonical_path)
    {
        return Err(CoreError::InvalidInput(
            "music file is outside the managed library or unsupported".into(),
        ));
    }
    inspect_track(&canonical_path, &canonical_root)
}

fn upsert_tracks(
    transaction: &rusqlite::Transaction<'_>,
    tracks: &[ScannedTrack],
) -> Result<(), CoreError> {
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
            recognition_status = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN 'pending'
                ELSE tracks.recognition_status
            END,
            recognition_provider = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_provider
            END,
            recognition_label = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_label
            END,
            recognition_title = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_title
            END,
            recognition_artist = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_artist
            END,
            recognition_album = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_album
            END,
            recognition_genre = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_genre
            END,
            recognition_external_id = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_external_id
            END,
            recognition_updated_ms = CASE
                WHEN tracks.file_size != excluded.file_size
                  OR tracks.modified_ms != excluded.modified_ms
                THEN NULL
                ELSE tracks.recognition_updated_ms
            END,
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
    Ok(())
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn inspect_track(path: &Path, root: &Path) -> Result<ScannedTrack, CoreError> {
    let metadata = fs::metadata(path).map_err(|error| CoreError::Media(error.to_string()))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| {
            i64::try_from(value.as_millis()).unwrap_or(i64::MAX)
        });
    let inferred = infer_from_path(path, root);

    let parsed = read_from_path(path).ok();
    let tag = parsed
        .as_ref()
        .and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
    let properties = parsed.as_ref().map(AudioFile::properties);
    let title = tag
        .and_then(Accessor::title)
        .filter(|value| !value.trim().is_empty())
        .map_or(inferred.title, |value| value.trim().to_owned());
    let artist = tag
        .and_then(Accessor::artist)
        .filter(|value| !value.trim().is_empty())
        .map_or(inferred.artist, |value| value.trim().to_owned());
    let album = tag
        .and_then(Accessor::album)
        .filter(|value| !value.trim().is_empty())
        .map_or(inferred.album, |value| value.trim().to_owned());
    let album_artist = tag
        .and_then(|value| value.get_string(lofty::tag::ItemKey::AlbumArtist))
        .filter(|value| !value.trim().is_empty())
        .map_or_else(|| artist.clone(), |value| value.trim().to_owned());
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
            track_number: tag.and_then(Accessor::track).or(inferred.track_number),
            disc_number: tag.and_then(Accessor::disk),
            year: tag
                .and_then(Accessor::date)
                .map(|date| u32::from(date.year))
                .or(inferred.year),
            duration_ms,
            format,
            available: true,
            has_artwork,
            recognition: TrackRecognition::default(),
        },
        canonical_path: path.to_owned(),
        file_size: metadata.len(),
        modified_ms,
    })
}

#[derive(Debug, PartialEq, Eq)]
struct PathMetadata {
    title: String,
    artist: String,
    album: String,
    year: Option<u32>,
    track_number: Option<u32>,
}

fn infer_from_path(path: &Path, root: &Path) -> PathMetadata {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let (track_number, without_number) = strip_track_number(stem);
    let filename_parts: Vec<_> = without_number
        .split(" - ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    let (filename_artist, title) = if filename_parts.len() >= 2 {
        (
            Some(filename_parts[0].to_owned()),
            filename_parts[1..].join(" - "),
        )
    } else {
        (None, clean_filename(without_number))
    };
    let parents: Vec<String> = path
        .strip_prefix(root)
        .ok()
        .and_then(Path::parent)
        .map(|parent| {
            parent
                .components()
                .filter_map(|component| component.as_os_str().to_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let album_source = parents.last().map_or("", String::as_str);
    let (album_name, year) = album_and_year(album_source);
    let folder_artist = parents
        .len()
        .checked_sub(2)
        .and_then(|index| parents.get(index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    PathMetadata {
        title: nonempty_or(&title, "Untitled"),
        artist: filename_artist
            .as_deref()
            .or(folder_artist)
            .map_or_else(|| "Unknown Artist".to_owned(), ToOwned::to_owned),
        album: nonempty_or(&album_name, "Unknown Album"),
        year,
        track_number,
    }
}

fn strip_track_number(value: &str) -> (Option<u32>, &str) {
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 4 {
        return (None, value.trim());
    }
    let Some(number) = value
        .get(..digits)
        .and_then(|prefix| prefix.parse::<u32>().ok())
    else {
        return (None, value.trim());
    };
    let rest = value
        .get(digits..)
        .unwrap_or_default()
        .trim_start_matches([' ', '-', '_', '.']);
    if rest.is_empty() {
        (None, value.trim())
    } else {
        (Some(number), rest.trim())
    }
}

fn album_and_year(value: &str) -> (String, Option<u32>) {
    let year = value
        .split(|character: char| !character.is_ascii_digit())
        .find_map(|part| {
            (part.len() == 4)
                .then(|| part.parse::<u32>().ok())
                .flatten()
                .filter(|candidate| (1000..=9999).contains(candidate))
        });
    let album = year.map_or_else(
        || value.trim().to_owned(),
        |candidate| {
            value
                .replace(&candidate.to_string(), "")
                .trim_matches([' ', '-', '_', '.', '(', ')', '[', ']'])
                .trim()
                .to_owned()
        },
    );
    (album, year)
}

fn clean_filename(value: &str) -> String {
    let without_digest = value
        .rsplit_once(" [")
        .and_then(|(title, suffix)| {
            suffix.strip_suffix(']').filter(|digest| {
                digest.len() == 12 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })?;
            Some(title)
        })
        .unwrap_or(value);
    without_digest.replace(['_', '.'], " ").trim().to_owned()
}

fn nonempty_or(value: &str, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_owned()
    } else {
        value.trim().to_owned()
    }
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

    #[test]
    fn infers_artist_album_year_track_and_title_from_path() {
        let root = Path::new("/music");
        let inferred = infer_from_path(
            Path::new("/music/Night Signals/Glass City (2024)/03 - Neon Harbor.mp3"),
            root,
        );
        assert_eq!(
            inferred,
            PathMetadata {
                title: "Neon Harbor".into(),
                artist: "Night Signals".into(),
                album: "Glass City".into(),
                year: Some(2024),
                track_number: Some(3),
            }
        );
    }

    #[test]
    fn filename_artist_takes_precedence_when_present() {
        let inferred = infer_from_path(
            Path::new("/music/Loose/07 - Paper Satellites - After Rain.ogg"),
            Path::new("/music"),
        );
        assert_eq!(inferred.artist, "Paper Satellites");
        assert_eq!(inferred.title, "After Rain");
        assert_eq!(inferred.album, "Loose");
    }

    #[test]
    fn hides_managed_digest_suffix_from_fallback_titles() {
        let inferred = infer_from_path(
            Path::new("/music/Kevin/Unknown Album/Arpent [ef06d8b524c1].mp3"),
            Path::new("/music"),
        );
        assert_eq!(inferred.title, "Arpent");
    }

    #[test]
    fn recognizes_the_complete_supported_audio_format_matrix() {
        let expected = [
            "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "mp4", "ogg", "opus", "wav", "webm",
        ];
        assert_eq!(SUPPORTED_EXTENSIONS, expected);
        for extension in expected {
            assert!(is_supported(Path::new(&format!("track.{extension}"))));
            assert!(is_supported(Path::new(&format!(
                "TRACK.{}",
                extension.to_ascii_uppercase()
            ))));
        }
        assert!(!is_supported(Path::new("cover.jpg")));
        assert!(!is_supported(Path::new("track.flac.exe")));
    }
}
