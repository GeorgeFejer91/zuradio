use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use lofty::file::TaggedFileExt;
use lofty::read_from_path;
use lofty::tag::{Accessor, ItemKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub(crate) const MAX_CHUNK_BYTES: usize = 8 * 1024;
const MAX_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_RELATIVE_PATH_CHARS: usize = 512;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "mp4", "ogg", "opus", "wav", "webm",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadFileSpec {
    pub(crate) file_id: String,
    pub(crate) relative_path: String,
    pub(crate) size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum UploadOperation {
    Begin {
        transfer_id: String,
        files: Vec<UploadFileSpec>,
    },
    Chunk {
        transfer_id: String,
        file_id: String,
        offset: u64,
        data: String,
    },
    FinishFile {
        transfer_id: String,
        file_id: String,
        sha256: String,
    },
    Commit {
        transfer_id: String,
    },
    Abort {
        transfer_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadOutcome {
    pub(crate) status: &'static str,
    pub(crate) transfer_id: String,
    pub(crate) file_id: Option<String>,
    pub(crate) received: Option<u64>,
    pub(crate) imported: Vec<ImportedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedFile {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) album: String,
    pub(crate) year: Option<u32>,
}

#[derive(Debug, Error)]
pub(crate) enum UploadError {
    #[error("upload request is invalid")]
    Invalid,
    #[error("upload transfer was not found")]
    NotFound,
    #[error("upload is too large")]
    TooLarge,
    #[error("only supported audio files can be uploaded")]
    Unsupported,
    #[error("uploaded file failed its integrity check")]
    Integrity,
    #[error("uploaded media could not be read")]
    Media,
    #[error("upload storage is unavailable")]
    Storage,
}

impl From<io::Error> for UploadError {
    fn from(_: io::Error) -> Self {
        Self::Storage
    }
}

#[derive(Debug)]
struct UploadFile {
    spec: UploadFileSpec,
    staged_path: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    received: u64,
    digest: Option<String>,
}

#[derive(Debug)]
struct UploadBatch {
    directory: PathBuf,
    files: HashMap<String, UploadFile>,
}

#[derive(Debug)]
pub(crate) struct UploadManager {
    staging_root: PathBuf,
    library_root: PathBuf,
    batches: HashMap<String, UploadBatch>,
}

impl UploadManager {
    pub(crate) fn new(data_dir: &Path) -> Result<Self, UploadError> {
        let staging_root = data_dir.join("uploads");
        let library_root = data_dir.join("library");
        fs::create_dir_all(&staging_root)?;
        fs::create_dir_all(&library_root)?;
        Ok(Self {
            staging_root,
            library_root,
            batches: HashMap::new(),
        })
    }

    pub(crate) fn library_root(&self) -> &Path {
        &self.library_root
    }

    pub(crate) fn execute(
        &mut self,
        operation: UploadOperation,
    ) -> Result<UploadOutcome, UploadError> {
        match operation {
            UploadOperation::Begin { transfer_id, files } => self.begin(transfer_id, files),
            UploadOperation::Chunk {
                transfer_id,
                file_id,
                offset,
                data,
            } => self.chunk(&transfer_id, &file_id, offset, &data),
            UploadOperation::FinishFile {
                transfer_id,
                file_id,
                sha256,
            } => self.finish_file(&transfer_id, &file_id, &sha256),
            UploadOperation::Commit { transfer_id } => self.commit(&transfer_id),
            UploadOperation::Abort { transfer_id } => self.abort(&transfer_id),
        }
    }

    pub(crate) fn revoke_all(&mut self) {
        for (_, batch) in self.batches.drain() {
            drop(batch.files);
            let _ = fs::remove_dir_all(batch.directory);
        }
    }

    fn begin(
        &mut self,
        transfer_id: String,
        files: Vec<UploadFileSpec>,
    ) -> Result<UploadOutcome, UploadError> {
        validate_id(&transfer_id)?;
        if files.is_empty() || files.len() > MAX_FILES || self.batches.contains_key(&transfer_id) {
            return Err(UploadError::Invalid);
        }
        let total = files.iter().try_fold(0_u64, |sum, spec| {
            validate_spec(spec)?;
            sum.checked_add(spec.size).ok_or(UploadError::TooLarge)
        })?;
        if total > MAX_BATCH_BYTES {
            return Err(UploadError::TooLarge);
        }

        let directory = self.staging_root.join(&transfer_id);
        fs::create_dir(&directory).map_err(|_| UploadError::Invalid)?;
        let mut entries = HashMap::with_capacity(files.len());
        for spec in files {
            if entries.contains_key(&spec.file_id) {
                let _ = fs::remove_dir_all(&directory);
                return Err(UploadError::Invalid);
            }
            let extension = Path::new(source_name(&spec.relative_path)?)
                .extension()
                .and_then(|value| value.to_str())
                .ok_or(UploadError::Unsupported)?
                .to_ascii_lowercase();
            let staged_path = directory.join(format!("{}.part.{extension}", spec.file_id));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_path)?;
            entries.insert(
                spec.file_id.clone(),
                UploadFile {
                    spec,
                    staged_path,
                    file: Some(file),
                    hasher: Sha256::new(),
                    received: 0,
                    digest: None,
                },
            );
        }
        self.batches.insert(
            transfer_id.clone(),
            UploadBatch {
                directory,
                files: entries,
            },
        );
        Ok(outcome("ready", transfer_id, None, None, Vec::new()))
    }

    fn chunk(
        &mut self,
        transfer_id: &str,
        file_id: &str,
        offset: u64,
        encoded: &str,
    ) -> Result<UploadOutcome, UploadError> {
        validate_id(transfer_id)?;
        validate_id(file_id)?;
        if encoded.len() > 12_000 {
            return Err(UploadError::TooLarge);
        }
        let bytes = STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| UploadError::Invalid)?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(UploadError::TooLarge);
        }
        let batch = self
            .batches
            .get_mut(transfer_id)
            .ok_or(UploadError::NotFound)?;
        let entry = batch.files.get_mut(file_id).ok_or(UploadError::NotFound)?;
        if entry.digest.is_some() || offset != entry.received {
            return Err(UploadError::Invalid);
        }
        let next = entry
            .received
            .checked_add(u64::try_from(bytes.len()).map_err(|_| UploadError::TooLarge)?)
            .ok_or(UploadError::TooLarge)?;
        if next > entry.spec.size {
            return Err(UploadError::TooLarge);
        }
        let file = entry.file.as_mut().ok_or(UploadError::Invalid)?;
        file.write_all(&bytes)?;
        entry.hasher.update(&bytes);
        entry.received = next;
        Ok(outcome(
            "chunk",
            transfer_id.to_owned(),
            Some(file_id.to_owned()),
            Some(next),
            Vec::new(),
        ))
    }

    fn finish_file(
        &mut self,
        transfer_id: &str,
        file_id: &str,
        expected_digest: &str,
    ) -> Result<UploadOutcome, UploadError> {
        if expected_digest.len() != 64
            || !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(UploadError::Invalid);
        }
        let batch = self
            .batches
            .get_mut(transfer_id)
            .ok_or(UploadError::NotFound)?;
        let entry = batch.files.get_mut(file_id).ok_or(UploadError::NotFound)?;
        if entry.received != entry.spec.size || entry.digest.is_some() {
            return Err(UploadError::Integrity);
        }
        if let Some(mut file) = entry.file.take() {
            file.flush()?;
            file.sync_all()?;
        }
        let actual = encode_hex(&entry.hasher.clone().finalize());
        if !actual.eq_ignore_ascii_case(expected_digest) {
            return Err(UploadError::Integrity);
        }
        entry.digest = Some(actual);
        Ok(outcome(
            "verified",
            transfer_id.to_owned(),
            Some(file_id.to_owned()),
            Some(entry.received),
            Vec::new(),
        ))
    }

    fn commit(&mut self, transfer_id: &str) -> Result<UploadOutcome, UploadError> {
        let batch = self
            .batches
            .remove(transfer_id)
            .ok_or(UploadError::NotFound)?;
        if batch.files.values().any(|entry| entry.digest.is_none()) {
            self.batches.insert(transfer_id.to_owned(), batch);
            return Err(UploadError::Integrity);
        }
        let prepared = batch
            .files
            .values()
            .map(|entry| prepare_import(&self.library_root, entry))
            .collect::<Result<Vec<_>, _>>();
        let prepared = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir_all(&batch.directory);
                return Err(error);
            }
        };
        let mut imported = Vec::with_capacity(prepared.len());
        for item in prepared {
            if let Some(parent) = item.destination.parent() {
                fs::create_dir_all(parent)?;
            }
            if item.destination.exists() {
                fs::remove_file(&item.staged_path)?;
            } else {
                fs::rename(&item.staged_path, &item.destination)?;
            }
            imported.push(item.imported);
        }
        let _ = fs::remove_dir(&batch.directory);
        Ok(outcome(
            "committed",
            transfer_id.to_owned(),
            None,
            None,
            imported,
        ))
    }

    fn abort(&mut self, transfer_id: &str) -> Result<UploadOutcome, UploadError> {
        let batch = self
            .batches
            .remove(transfer_id)
            .ok_or(UploadError::NotFound)?;
        drop(batch.files);
        fs::remove_dir_all(batch.directory)?;
        Ok(outcome(
            "aborted",
            transfer_id.to_owned(),
            None,
            None,
            Vec::new(),
        ))
    }
}

fn validate_spec(spec: &UploadFileSpec) -> Result<(), UploadError> {
    validate_id(&spec.file_id)?;
    if spec.size == 0 || spec.size > MAX_FILE_BYTES {
        return Err(UploadError::TooLarge);
    }
    if spec.relative_path.is_empty()
        || spec.relative_path.chars().count() > MAX_RELATIVE_PATH_CHARS
        || spec.relative_path.contains('\0')
        || spec.relative_path.starts_with(['/', '\\'])
        || spec
            .relative_path
            .split(['/', '\\'])
            .any(|component| matches!(component, "." | "..") || component.ends_with(':'))
    {
        return Err(UploadError::Invalid);
    }
    let name = source_name(&spec.relative_path)?;
    if !supported_extension(name) {
        return Err(UploadError::Unsupported);
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), UploadError> {
    if value.len() < 8
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(UploadError::Invalid);
    }
    Ok(())
}

fn supported_extension(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn source_name(relative_path: &str) -> Result<&str, UploadError> {
    relative_path
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or(UploadError::Invalid)
}

struct PreparedImport {
    imported: ImportedFile,
    staged_path: PathBuf,
    destination: PathBuf,
}

fn prepare_import(library_root: &Path, entry: &UploadFile) -> Result<PreparedImport, UploadError> {
    let parsed = read_from_path(&entry.staged_path).map_err(|_| UploadError::Media)?;
    let tag = parsed.primary_tag().or_else(|| parsed.first_tag());
    let inferred = infer_from_relative_path(&entry.spec.relative_path)?;
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
        .and_then(|value| value.get_string(ItemKey::AlbumArtist))
        .unwrap_or(&artist);
    let year = tag
        .and_then(Accessor::date)
        .map(|date| u32::from(date.year))
        .or(inferred.year);
    let track_number = tag.and_then(Accessor::track).or(inferred.track_number);
    let extension = Path::new(source_name(&entry.spec.relative_path)?)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or(UploadError::Unsupported)?
        .to_ascii_lowercase();
    let album_folder = year.map_or_else(
        || sanitize_component(&album),
        |value| format!("{} ({value})", sanitize_component(&album)),
    );
    let directory = library_root
        .join(sanitize_component(album_artist))
        .join(album_folder);
    let prefix = track_number.map_or_else(String::new, |value| format!("{value:02} - "));
    let digest = entry.digest.as_deref().ok_or(UploadError::Integrity)?;
    let digest_prefix = digest.get(..12).ok_or(UploadError::Integrity)?;
    let filename = format!(
        "{prefix}{} [{digest_prefix}].{extension}",
        sanitize_component(&title)
    );
    let destination = directory.join(filename);
    Ok(PreparedImport {
        imported: ImportedFile {
            title,
            artist,
            album,
            year,
        },
        staged_path: entry.staged_path.clone(),
        destination,
    })
}

#[derive(Debug)]
struct InferredMetadata {
    title: String,
    artist: String,
    album: String,
    year: Option<u32>,
    track_number: Option<u32>,
}

fn infer_from_relative_path(relative_path: &str) -> Result<InferredMetadata, UploadError> {
    let name = source_name(relative_path)?;
    let stem = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let digits = stem.bytes().take_while(u8::is_ascii_digit).count();
    let (track_number, remainder) = if (1..=4).contains(&digits) {
        let number = stem
            .get(..digits)
            .and_then(|value| value.parse::<u32>().ok());
        let rest = stem
            .get(digits..)
            .unwrap_or_default()
            .trim_start_matches([' ', '-', '_', '.'])
            .trim();
        if rest.is_empty() {
            (None, stem)
        } else {
            (number, rest)
        }
    } else {
        (None, stem)
    };
    let filename_parts: Vec<_> = remainder
        .split(" - ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    let (filename_artist, title) = if filename_parts.len() >= 2 {
        (Some(filename_parts[0]), filename_parts[1..].join(" - "))
    } else {
        (None, remainder.replace(['_', '.'], " "))
    };
    let mut folders: Vec<_> = relative_path.split(['/', '\\']).collect();
    folders.pop();
    let album_source = folders.last().copied().unwrap_or_default();
    let year = album_source
        .split(|character: char| !character.is_ascii_digit())
        .find_map(|part| {
            (part.len() == 4)
                .then(|| part.parse::<u32>().ok())
                .flatten()
                .filter(|value| (1000..=9999).contains(value))
        });
    let album = year.map_or_else(
        || album_source.trim().to_owned(),
        |value| {
            album_source
                .replace(&value.to_string(), "")
                .trim_matches([' ', '-', '_', '.', '(', ')', '[', ']'])
                .to_owned()
        },
    );
    let folder_artist = folders
        .len()
        .checked_sub(2)
        .and_then(|index| folders.get(index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    Ok(InferredMetadata {
        title: fallback_if_empty(&title, "Untitled"),
        artist: filename_artist
            .or(folder_artist)
            .map_or_else(|| "Unknown Artist".to_owned(), ToOwned::to_owned),
        album: fallback_if_empty(&album, "Unknown Album"),
        year,
        track_number,
    })
}

fn fallback_if_empty(value: &str, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_owned()
    } else {
        value.trim().to_owned()
    }
}

fn sanitize_component(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(80)
        .collect();
    if cleaned.is_empty() || matches!(cleaned.as_str(), "." | "..") {
        "Unknown".to_owned()
    } else {
        cleaned
    }
}

fn outcome(
    status: &'static str,
    transfer_id: String,
    file_id: Option<String>,
    received: Option<u64>,
    imported: Vec<ImportedFile>,
) -> UploadOutcome {
    UploadOutcome {
        status,
        transfer_id,
        file_id,
        received,
        imported,
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_paths_and_unsupported_files() {
        for bad in ["notes.txt", "folder/", "..", "song.exe"] {
            let spec = UploadFileSpec {
                file_id: "file-12345678".into(),
                relative_path: bad.into(),
                size: 10,
            };
            assert!(validate_spec(&spec).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn accepts_the_complete_supported_audio_format_matrix() {
        let expected = [
            "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "mp4", "ogg", "opus", "wav", "webm",
        ];
        assert_eq!(SUPPORTED_EXTENSIONS, expected);
        for extension in expected {
            let spec = UploadFileSpec {
                file_id: "file-12345678".into(),
                relative_path: format!("Album/Track.{extension}"),
                size: 10,
            };
            assert!(validate_spec(&spec).is_ok(), "rejected {extension}");
        }
    }

    #[test]
    fn enforces_order_size_and_digest() -> Result<(), UploadError> {
        let directory = tempdir().map_err(|_| UploadError::Storage)?;
        let mut manager = UploadManager::new(directory.path())?;
        let transfer = "transfer-12345678";
        let file = "file-12345678";
        manager.execute(UploadOperation::Begin {
            transfer_id: transfer.into(),
            files: vec![UploadFileSpec {
                file_id: file.into(),
                relative_path: "Album/song.mp3".into(),
                size: 4,
            }],
        })?;
        assert!(matches!(
            manager.execute(UploadOperation::Chunk {
                transfer_id: transfer.into(),
                file_id: file.into(),
                offset: 1,
                data: STANDARD.encode(b"test"),
            }),
            Err(UploadError::Invalid)
        ));
        manager.execute(UploadOperation::Chunk {
            transfer_id: transfer.into(),
            file_id: file.into(),
            offset: 0,
            data: STANDARD.encode(b"test"),
        })?;
        assert!(matches!(
            manager.execute(UploadOperation::FinishFile {
                transfer_id: transfer.into(),
                file_id: file.into(),
                sha256: "0".repeat(64),
            }),
            Err(UploadError::Integrity)
        ));
        Ok(())
    }

    #[test]
    fn sanitizes_metadata_components() {
        assert_eq!(sanitize_component("../A/B: C"), ".._A_B_ C");
        assert_eq!(sanitize_component(".."), "Unknown");
    }

    #[test]
    fn infers_upload_metadata_from_folder_and_filename() -> Result<(), UploadError> {
        let inferred = infer_from_relative_path(
            "Night Signals/Glass City (2024)/03 - Paper Satellites - Neon Harbor.flac",
        )?;
        assert_eq!(inferred.title, "Neon Harbor");
        assert_eq!(inferred.artist, "Paper Satellites");
        assert_eq!(inferred.album, "Glass City");
        assert_eq!(inferred.year, Some(2024));
        assert_eq!(inferred.track_number, Some(3));
        Ok(())
    }
}
