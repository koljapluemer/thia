//! Where the bridge keeps the sites allowed to use it (per OS: XDG on Linux, Application Support on macOS, AppData on
//! Windows). As in claude-bridge (`installables/claude-bridge/src/config.rs`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Paths {
    /// the allowed sites (tokens.json)
    pub config: PathBuf,
}

impl Paths {
    /// `profile` keeps a development bridge (`--profile dev`) apart from an installed one.
    pub fn new(profile: Option<&str>) -> Result<Paths, String> {
        let name = profile.map_or_else(|| "gestalts-ollama-bridge".to_owned(), |p| format!("gestalts-ollama-bridge-{p}"));
        let dirs = directories::ProjectDirs::from("com", "koljasam", &name).ok_or("cannot find a home directory")?;
        Ok(Paths { config: dirs.config_dir().into() })
    }

    pub fn tokens_file(&self) -> PathBuf { self.config.join("tokens.json") }
}

/// The sites allowed to run models here: origin -> its token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tokens(pub BTreeMap<String, String>);

impl Tokens {
    pub fn load(paths: &Paths) -> Tokens {
        std::fs::read(paths.tokens_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths) -> std::io::Result<()> {
        write_secret(&paths.tokens_file(), serde_json::to_vec_pretty(self).expect("tokens serialize"))
    }

    /// Whether `token` is the one `origin` was given.
    pub fn allows(&self, origin: &str, token: &str) -> bool {
        self.0.get(origin).is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes()))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Writes a secret, readable only by this user.
pub fn write_secret(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes.as_ref())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, bytes.as_ref())?;
    std::fs::rename(tmp, path)
}
