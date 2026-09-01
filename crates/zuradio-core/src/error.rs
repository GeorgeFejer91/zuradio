use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    NotFound,
    Conflict,
    Forbidden,
    Storage,
    Media,
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("state changed; refresh and retry")]
    Conflict,
    #[error("this role is not allowed to perform that action")]
    Forbidden,
    #[error("storage operation failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("storage operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("stored data is invalid: {0}")]
    StoredData(#[from] serde_json::Error),
    #[error("media scan failed: {0}")]
    Media(String),
}

impl CoreError {
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::Conflict => ErrorCode::Conflict,
            Self::Forbidden => ErrorCode::Forbidden,
            Self::Storage(_) | Self::Io(_) | Self::StoredData(_) => ErrorCode::Storage,
            Self::Media(_) => ErrorCode::Media,
        }
    }
}
