use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use zuradio_core::{RecognitionStatus, TrackRecognition};

const PROVIDER: &str = "shazam_songrec";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CAPTURE_BYTES: usize = 256 * 1024;

#[derive(Debug)]
enum RecognizerCommand {
    Native(OsString),
    Flatpak(OsString),
}

#[derive(Debug)]
enum AttemptError {
    Unavailable,
    Failed,
}

#[derive(Debug)]
struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub(crate) async fn recognize_file(path: &Path) -> TrackRecognition {
    let explicit = std::env::var_os("ZURADIO_RECOGNIZER_COMMAND").filter(|value| !value.is_empty());
    if let Some(program) = explicit {
        return recognition_from_attempt(
            run_command(RecognizerCommand::Native(program), path).await,
        );
    }

    let native = native_songrec_command();
    match run_command(native, path).await {
        Ok(recognition) => recognition,
        Err(AttemptError::Failed) => status(RecognitionStatus::Error),
        Err(AttemptError::Unavailable) => {
            let Some(flatpak) = command_on_path("flatpak") else {
                return status(RecognitionStatus::Unavailable);
            };
            if !flatpak_application_available(flatpak.as_os_str()).await {
                return status(RecognitionStatus::Unavailable);
            }
            recognition_from_attempt(
                run_command(RecognizerCommand::Flatpak(flatpak.into_os_string()), path).await,
            )
        }
    }
}

async fn flatpak_application_available(program: &OsStr) -> bool {
    let status = Command::new(program)
        .args(["info", "re.fossplant.songrec"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    matches!(
        tokio::time::timeout(Duration::from_secs(5), status).await,
        Ok(Ok(exit_status)) if exit_status.success()
    )
}

fn recognition_from_attempt(attempt: Result<TrackRecognition, AttemptError>) -> TrackRecognition {
    match attempt {
        Ok(recognition) => recognition,
        Err(AttemptError::Unavailable) => status(RecognitionStatus::Unavailable),
        Err(AttemptError::Failed) => status(RecognitionStatus::Error),
    }
}

fn native_songrec_command() -> RecognizerCommand {
    for candidate in conventional_songrec_paths() {
        if candidate.is_file() {
            return RecognizerCommand::Native(candidate.into_os_string());
        }
    }
    RecognizerCommand::Native(OsString::from("songrec"))
}

fn conventional_songrec_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/lib/zuradio/songrec/songrec"));
        candidates.push(home.join(".local/bin/songrec"));
        candidates.push(home.join(".cargo/bin/songrec"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.push(profile.join(".cargo/bin/songrec.exe"));
    }
    candidates
}

fn command_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&paths) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let executable = directory.join(format!("{name}.exe"));
            if executable.is_file() {
                return Some(executable);
            }
        }
    }
    None
}

async fn run_command(
    command: RecognizerCommand,
    path: &Path,
) -> Result<TrackRecognition, AttemptError> {
    let (program, arguments) = match command {
        RecognizerCommand::Native(program) => (
            program,
            vec![
                OsString::from("recognize"),
                OsString::from("--json"),
                path.as_os_str().to_owned(),
            ],
        ),
        RecognizerCommand::Flatpak(program) => (
            program,
            vec![
                OsString::from("run"),
                OsString::from("--file-forwarding"),
                OsString::from("re.fossplant.songrec"),
                OsString::from("recognize"),
                OsString::from("--json"),
                OsString::from("@@"),
                path.as_os_str().to_owned(),
                OsString::from("@@"),
            ],
        ),
    };
    let output = process_output(program, arguments).await?;
    classify_output(&output)
}

async fn process_output(
    program: OsString,
    arguments: Vec<OsString>,
) -> Result<ProcessOutput, AttemptError> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AttemptError::Unavailable
            } else {
                AttemptError::Failed
            }
        })?;
    let stdout = child.stdout.take().ok_or(AttemptError::Failed)?;
    let stderr = child.stderr.take().ok_or(AttemptError::Failed)?;
    let completed = tokio::time::timeout(PROCESS_TIMEOUT, async move {
        let (status, stdout, stderr) =
            tokio::join!(child.wait(), read_bounded(stdout), read_bounded(stderr),);
        Ok::<_, std::io::Error>(ProcessOutput {
            success: status?.success(),
            stdout: stdout?,
            stderr: stderr?,
        })
    })
    .await
    .map_err(|_| AttemptError::Failed)?
    .map_err(|_| AttemptError::Failed)?;
    Ok(completed)
}

async fn read_bounded<R>(mut reader: R) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::new();
    let mut buffer = vec![0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(captured)
}

fn classify_output(output: &ProcessOutput) -> Result<TrackRecognition, AttemptError> {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("not installed") || stderr.contains("unknown application") {
        return Err(AttemptError::Unavailable);
    }
    let stdout = std::str::from_utf8(&output.stdout).map_err(|_| AttemptError::Failed)?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        if output.success || stderr.contains("no match for this song") {
            return Ok(status(RecognitionStatus::NoMatch));
        }
        return Err(AttemptError::Failed);
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| AttemptError::Failed)?;
    let Some(track) = value.get("track") else {
        if value
            .get("matches")
            .and_then(serde_json::Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            return Ok(status(RecognitionStatus::NoMatch));
        }
        return Err(AttemptError::Failed);
    };
    let title = clean_text(track.get("title").and_then(serde_json::Value::as_str), 180)
        .ok_or(AttemptError::Failed)?;
    let artist = clean_text(
        track.get("subtitle").and_then(serde_json::Value::as_str),
        180,
    )
    .ok_or(AttemptError::Failed)?;
    let external_id = clean_text(track.get("key").and_then(serde_json::Value::as_str), 120);
    let album = clean_text(track_metadata(track, "album"), 220);
    let genre = clean_text(
        track
            .get("genres")
            .and_then(|genres| genres.get("primary"))
            .and_then(serde_json::Value::as_str),
        120,
    );
    Ok(TrackRecognition {
        status: RecognitionStatus::Recognized,
        provider: Some(PROVIDER.into()),
        label: Some(format!("{artist} — {title}")),
        title: Some(title),
        artist: Some(artist),
        album,
        genre,
        external_id,
        updated_at_ms: Some(now_ms()),
    })
}

fn track_metadata<'a>(track: &'a serde_json::Value, wanted: &str) -> Option<&'a str> {
    track
        .get("sections")?
        .as_array()?
        .iter()
        .filter_map(|section| {
            section
                .get("metadata")
                .and_then(serde_json::Value::as_array)
        })
        .flatten()
        .find(|entry| {
            entry
                .get("title")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|title| title.eq_ignore_ascii_case(wanted))
        })
        .and_then(|entry| entry.get("text"))
        .and_then(serde_json::Value::as_str)
}

fn clean_text(value: Option<&str>, maximum: usize) -> Option<String> {
    let cleaned = value?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(maximum)
        .collect::<String>();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn status(status: RecognitionStatus) -> TrackRecognition {
    TrackRecognition {
        status,
        provider: Some(PROVIDER.into()),
        label: None,
        title: None,
        artist: None,
        album: None,
        genre: None,
        external_id: None,
        updated_at_ms: Some(now_ms()),
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
    use super::*;

    #[test]
    fn parses_a_bounded_parallel_shazam_label() -> Result<(), Box<dyn std::error::Error>> {
        let output = ProcessOutput {
            success: true,
            stdout: br#"{"matches":[{"id":"match"}],"track":{"key":"42","title":"Recognized Title","subtitle":"Recognized Artist","genres":{"primary":"Electronic"},"sections":[{"metadata":[{"title":"Album","text":"Recognized Album"}]}]}}"#.to_vec(),
            stderr: Vec::new(),
        };
        let recognition = classify_output(&output).map_err(|error| format!("{error:?}"))?;
        assert_eq!(recognition.status, RecognitionStatus::Recognized);
        assert_eq!(
            recognition.label.as_deref(),
            Some("Recognized Artist — Recognized Title")
        );
        assert_eq!(recognition.external_id.as_deref(), Some("42"));
        assert_eq!(recognition.title.as_deref(), Some("Recognized Title"));
        assert_eq!(recognition.artist.as_deref(), Some("Recognized Artist"));
        assert_eq!(recognition.album.as_deref(), Some("Recognized Album"));
        assert_eq!(recognition.genre.as_deref(), Some("Electronic"));
        Ok(())
    }

    #[test]
    fn distinguishes_no_match_from_a_failed_process() {
        let no_match = ProcessOutput {
            success: true,
            stdout: Vec::new(),
            stderr: b"Error: No match for this song".to_vec(),
        };
        assert!(matches!(
            classify_output(&no_match),
            Ok(TrackRecognition {
                status: RecognitionStatus::NoMatch,
                ..
            })
        ));

        let failure = ProcessOutput {
            success: false,
            stdout: Vec::new(),
            stderr: b"Network unreachable".to_vec(),
        };
        assert!(matches!(
            classify_output(&failure),
            Err(AttemptError::Failed)
        ));
    }
}
