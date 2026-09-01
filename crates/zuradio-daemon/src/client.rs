use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;
use zuradio_core::{Action, ActionRequest, ActionResult, Actor, AppSnapshot};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFile {
    pub base_url: String,
    pub cli_token: String,
    pub host_url: String,
}

#[derive(Debug)]
pub struct Client {
    runtime: RuntimeFile,
}

impl Client {
    pub fn from_data_dir(data_dir: &Path) -> anyhow::Result<Self> {
        let path = data_dir.join("runtime.json");
        let content = fs::read_to_string(&path)
            .with_context(|| format!("Zuradio is not running (missing {})", path.display()))?;
        let runtime = serde_json::from_str(&content).context("runtime file is invalid")?;
        Ok(Self { runtime })
    }

    pub fn snapshot(&self) -> anyhow::Result<AppSnapshot> {
        self.get("/api/v1/snapshot")
    }

    #[must_use]
    pub fn host_url(&self) -> &str {
        &self.runtime.host_url
    }

    pub fn scan(&self, roots: &[PathBuf]) -> anyhow::Result<AppSnapshot> {
        #[derive(Serialize)]
        struct ScanRequest<'a> {
            roots: &'a [PathBuf],
        }
        self.post("/api/v1/scan", &ScanRequest { roots })
    }

    pub fn action(&self, action: Action) -> anyhow::Result<ActionResult> {
        let snapshot = self.snapshot()?;
        let request = ActionRequest {
            protocol: 1,
            command_id: Uuid::new_v4().to_string(),
            expected_revision: Some(snapshot.revision),
            actor: Actor::local(),
            action,
        };
        self.post("/api/v1/action", &request)
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let url = format!("{}{}", self.runtime.base_url, path);
        let mut response = ureq::get(&url)
            .header(
                "Authorization",
                &format!("Bearer {}", self.runtime.cli_token),
            )
            .call()
            .with_context(|| format!("request to {url} failed"))?;
        read_response(&mut response)
    }

    fn post<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> anyhow::Result<T> {
        let url = format!("{}{}", self.runtime.base_url, path);
        let mut response = ureq::post(&url)
            .header(
                "Authorization",
                &format!("Bearer {}", self.runtime.cli_token),
            )
            .send_json(body)
            .with_context(|| format!("request to {url} failed"))?;
        read_response(&mut response)
    }
}

fn read_response<T: DeserializeOwned>(
    response: &mut http::Response<ureq::Body>,
) -> anyhow::Result<T> {
    let status = response.status();
    let value: serde_json::Value = response
        .body_mut()
        .read_json()
        .context("server returned invalid JSON")?;
    if !status.is_success() {
        bail!("server rejected the request ({status}): {value}");
    }
    serde_json::from_value(value).context("server response has the wrong shape")
}
