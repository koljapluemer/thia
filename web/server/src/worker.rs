//! The Node helper (`web/server/worker/worker.ts`): compiling and checking views, bundling npm packages. One child,
//! started on first use and again if it dies, spoken to in JSON lines; calls run concurrently and are matched to
//! answers by id.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

/// How the worker is started.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub node: String,
    pub script: PathBuf,
    /// the agent template, with its node_modules: what the server's agent reads besides the draft
    pub template: PathBuf,
    pub npm_cache: PathBuf,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Running {
    stdin: ChildStdin,
    pending: Pending,
    _child: Child,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

pub struct Worker {
    config: WorkerConfig,
    running: tokio::sync::Mutex<Option<Running>>,
    next: AtomicU64,
}

const CALL_TIMEOUT: Duration = Duration::from_secs(300);

impl Worker {
    pub fn new(config: WorkerConfig) -> Self {
        Worker { config, running: tokio::sync::Mutex::default(), next: AtomicU64::new(1) }
    }

    pub fn config(&self) -> &WorkerConfig {
        &self.config
    }

    /// The repo checkout the worker and the agent template are in (`packages/workshop/agent-template`'s).
    pub fn repo(&self) -> PathBuf {
        self.config.template.ancestors().nth(3).map_or_else(|| PathBuf::from("."), std::path::Path::to_path_buf)
    }

    fn spawn(&self) -> Result<Running, String> {
        let mut child = Command::new(&self.config.node)
            .arg(&self.config.script)
            .current_dir(self.config.script.parent().unwrap_or(std::path::Path::new(".")))
            .env("THIA_NPM_CACHE", &self.config.npm_cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("starting the worker ({}): {e}", self.config.script.display()))?;
        let stdin = child.stdin.take().ok_or("the worker has no stdin")?;
        let stdout = child.stdout.take().ok_or("the worker has no stdout")?;
        let pending: Pending = Arc::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (p, a) = (pending.clone(), alive.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = msg["id"].as_u64() else { continue };
                let answer = if msg["ok"].as_bool() == Some(true) { Ok(msg["result"].clone()) } else { Err(msg["error"].as_str().unwrap_or("the worker failed").to_owned()) };
                if let Some(tx) = p.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id) {
                    let _ = tx.send(answer);
                }
            }
            // gone: whoever waits hears so, and the next call starts another
            a.store(false, Ordering::SeqCst);
            for (_, tx) in p.lock().unwrap_or_else(std::sync::PoisonError::into_inner).drain() {
                let _ = tx.send(Err("the worker stopped".into()));
            }
        });
        Ok(Running { stdin, pending, _child: child, alive })
    }

    /// One operation (`check`, `compile`, `npm`) with its arguments; what it answered.
    pub async fn call(&self, op: &str, mut args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        args["id"] = json!(id);
        args["op"] = json!(op);
        let (tx, rx) = oneshot::channel();
        {
            let mut running = self.running.lock().await;
            if running.as_ref().is_none_or(|r| !r.alive.load(Ordering::SeqCst)) {
                *running = Some(self.spawn()?);
            }
            let r = running.as_mut().expect("just started");
            r.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id, tx);
            let line = format!("{args}\n");
            if let Err(e) = r.stdin.write_all(line.as_bytes()).await {
                *running = None;
                return Err(format!("writing to the worker: {e}"));
            }
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("the worker stopped".into()),
            Err(_) => Err(format!("the worker took longer than {} s", CALL_TIMEOUT.as_secs())),
        }
    }

    /// The check (`@gestalts/check`'s `checkView`, and whether what the view pins bundles) on a draft's files, as the
    /// agent sees them: whether it passed, and its report.
    pub async fn check(&self, files: &std::collections::BTreeMap<String, String>, gestalts: &[String]) -> Result<(bool, String), String> {
        let r = self.call("check", json!({ "files": files, "gestalts": gestalts })).await?;
        Ok((r["ok"].as_bool().unwrap_or(false), r["output"].as_str().unwrap_or_default().to_owned()))
    }

    /// A viz's check (`@gestalts/check`'s `checkViz`), rendered in headless Chromium (`VizRender::Worker`): whether it
    /// passed, and its report and screenshots as MCP content. `binary` is its `files/`, as base64.
    pub async fn check_viz(&self, files: &std::collections::BTreeMap<String, String>, binary: &std::collections::BTreeMap<String, String>) -> Result<(bool, Vec<Value>), String> {
        let r = self.call("check-viz", json!({ "files": files, "binary": binary })).await?;
        Ok((r["ok"].as_bool().unwrap_or(false), r["content"].as_array().cloned().unwrap_or_default()))
    }

    /// The same check on a draft as ymls (its view `view` among them): each problem, none when it passed.
    pub async fn check_draft(&self, ymls: &std::collections::BTreeMap<String, String>, view: &str, gestalts: &[String]) -> Result<Vec<String>, String> {
        let ymls: Vec<_> = ymls.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect();
        let r = self.call("check-draft", json!({ "ymls": ymls, "view": view, "gestalts": gestalts })).await?;
        if r["ok"] == true {
            return Ok(vec![]);
        }
        Ok(r["problems"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(str::to_owned)).collect())
    }

    /// A view's draft as ymls (its view `view` among them) as the agent sees it: its files and its brief.
    pub async fn files_of(&self, ymls: &BTreeMap<String, String>, view: &str) -> Result<(BTreeMap<String, String>, String), String> {
        let r = self.call("files-of", json!({ "ymls": yml_list(ymls), "view": view })).await?;
        let files = serde_json::from_value(r["files"].clone()).map_err(|e| format!("the worker's files: {e}"))?;
        Ok((files, r["spec"].as_str().unwrap_or_default().to_owned()))
    }

    /// What changed files (`None`: deleted) make of a view's draft, as the page's `applyFiles` and `saveDraft` make it.
    pub async fn apply_files(&self, ymls: &BTreeMap<String, String>, view: &str, changed: &BTreeMap<String, Option<String>>) -> Result<Applied, String> {
        let r = self.call("apply-files", json!({ "ymls": yml_list(ymls), "view": view, "changed": changed })).await?;
        let strings = |k: &str| r[k].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>();
        Ok(Applied { put: ymls_of(&r["put"])?, remove: strings("remove"), problems: strings("problems") })
    }

    /// A new view draft's yml, as the page's `createDraft` makes it: its id and text.
    pub async fn new_view(&self, draft: &str, title: &str, package: &str, lang: &str) -> Result<(String, String), String> {
        let r = self.call("new-view", json!({ "draft": draft, "title": title, "package": package, "lang": lang })).await?;
        one_yml(&r)
    }

    /// The view's yml with `spec` as its brief.
    pub async fn set_spec(&self, ymls: &BTreeMap<String, String>, view: &str, spec: &str) -> Result<(String, String), String> {
        let r = self.call("set-spec", json!({ "ymls": yml_list(ymls), "view": view, "spec": spec })).await?;
        one_yml(&r)
    }
}

/// What a change to a draft's files is as ymls: what to write (the view's last), which members are gone, and what
/// couldn't be read.
#[derive(Debug, Default)]
pub struct Applied {
    pub put: Vec<(String, String)>,
    pub remove: Vec<String>,
    pub problems: Vec<String>,
}

fn yml_list(ymls: &BTreeMap<String, String>) -> Vec<Value> {
    ymls.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect()
}

fn one_yml(v: &Value) -> Result<(String, String), String> {
    match (v["id"].as_str(), v["text"].as_str()) {
        (Some(id), Some(text)) => Ok((id.to_owned(), text.to_owned())),
        _ => Err("the worker answered no yml".into()),
    }
}

fn ymls_of(v: &Value) -> Result<Vec<(String, String)>, String> {
    v.as_array().into_iter().flatten().map(one_yml).collect()
}
