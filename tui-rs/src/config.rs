use anyhow::{Context, Result};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}};

pub fn find_repo_root(start: &Path) -> Result<PathBuf> {
    let mut cur = start
        .canonicalize()
        .with_context(|| format!("canonicalize {:?}", start))?;

    loop {
        if cur.join("swarmfs.config.json").exists() {
            return Ok(cur);
        }
        if !cur.pop() {
            anyhow::bail!("could not find swarmfs.config.json in {} or any parent", start.display())
        }
    }
}

pub fn load_config(repo_root: &Path) -> Result<Value> {
    let cfg_path = repo_root.join("swarmfs.config.json");
    let data = fs::read_to_string(&cfg_path).with_context(|| format!("read {:?}", cfg_path))?;
    let v: Value = serde_json::from_str(&data).context("parse swarmfs.config.json")?;
    Ok(v)
}

pub fn resolve_data_dir(repo_root: &Path, cfg: &Value) -> Result<PathBuf> {
    let data_dir = cfg
        .get("dataDir")
        .and_then(|v| v.as_str())
        .unwrap_or("./swarmfs-data");

    let p = PathBuf::from(data_dir);
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(repo_root.join(p))
    }
}

pub fn stable_hash16(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    hex::encode(out)[0..16].to_string()
}

fn windows_hash_path_string(p: &Path) -> String {
    let p = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = p.to_string_lossy().to_string();
    // Windows canonicalize() often returns a verbatim path (\\?\C:\...).
    // Node's path.resolve returns a non-verbatim path (C:\...).
    // Strip the verbatim prefix so both sides hash the same string.
    s.strip_prefix("\\\\?\\")
        .unwrap_or(&s)
        .to_string()
}

pub fn ipc_endpoint(data_dir: &Path) -> String {
    // Match Node logic: win32 => \\.\pipe\swarmfs-<hash>, else <dataDir>/swarmfs.sock
    if cfg!(windows) {
        let dir = windows_hash_path_string(data_dir);
        format!("\\\\.\\pipe\\swarmfs-{}", stable_hash16(&dir))
    } else {
        data_dir.join("swarmfs.sock").to_string_lossy().to_string()
    }
}

pub fn get_repo_root(cwd: &Path) -> Result<PathBuf> {
    if let Ok(v) = std::env::var("SWARMFS_REPO_ROOT") {
        return Ok(PathBuf::from(v));
    }
    find_repo_root(cwd)
}

pub fn get_ipc_endpoint(repo_root: &Path) -> Result<(PathBuf, PathBuf, String)> {
    if let Ok(v) = std::env::var("SWARMFS_IPC_ENDPOINT") {
        return Ok((repo_root.to_path_buf(), PathBuf::new(), v));
    }

    let cfg = load_config(repo_root)?;
    let data_dir = resolve_data_dir(repo_root, &cfg)?;
    let endpoint = ipc_endpoint(&data_dir);
    Ok((repo_root.to_path_buf(), data_dir, endpoint))
}
