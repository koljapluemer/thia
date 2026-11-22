//! Ollama's HTTP API, called as it is: `GET /api/tags` for what's there, `POST /api/chat` with tools, not streamed.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

/// The default: the largest model with tool calling that fits 8 GB of VRAM.
pub const DEFAULT_MODEL: &str = "qwen3.5:9b";
pub const DEFAULT_HOST: &str = "http://127.0.0.1:11434";
pub const DEFAULT_CTX: u32 = 32768;
/// a local model on a small GPU can take long for one answer
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone)]
pub struct Ollama {
    pub host: String,
    pub model: String,
    pub ctx: u32,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub found: bool,
    pub host: String,
    pub model: String,
    pub has_model: bool,
}

/// One answer: what it said and the tools it calls, `(name, arguments)`.
#[derive(Debug, Default)]
pub struct Reply {
    pub content: String,
    pub calls: Vec<(String, Value)>,
    /// the message as Ollama gave it, for the conversation
    pub message: Value,
}

impl Ollama {
    /// `GESTALTS_OLLAMA_HOST`, `GESTALTS_OLLAMA_MODEL`, `GESTALTS_OLLAMA_CTX`.
    pub fn from_env() -> Result<Ollama, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let ctx = match var("GESTALTS_OLLAMA_CTX") {
            Some(c) => c.trim().parse().map_err(|_| format!("GESTALTS_OLLAMA_CTX: a number of tokens, not {c:?}"))?,
            None => DEFAULT_CTX,
        };
        Ok(Ollama::new(var("GESTALTS_OLLAMA_HOST").unwrap_or_else(|| DEFAULT_HOST.into()), var("GESTALTS_OLLAMA_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into()), ctx))
    }

    pub fn new(host: String, model: String, ctx: u32) -> Ollama {
        let http = reqwest::Client::builder().timeout(CHAT_TIMEOUT).build().expect("an HTTP client");
        Ollama { host: host.trim_end_matches('/').to_owned(), model, ctx, http }
    }

    pub async fn status(&self) -> Status {
        let tags = async {
            let r = self.http.get(format!("{}/api/tags", self.host)).timeout(Duration::from_secs(3)).send().await.ok()?;
            r.json::<Value>().await.ok()
        }.await;
        let has = |names: &Value| names["models"].as_array().is_some_and(|ms| ms.iter().any(|m| {
            let n = m["name"].as_str().unwrap_or_default();
            n == self.model || n == format!("{}:latest", self.model)
        }));
        Status { found: tags.is_some(), host: self.host.clone(), model: self.model.clone(), has_model: tags.as_ref().is_some_and(has) }
    }

    /// One chat round: `messages` (system first), `tools` as Ollama takes them.
    pub async fn chat(&self, model: &str, messages: &[Value], tools: &[Value]) -> Result<Reply, String> {
        let mut body = json!({ "model": model, "messages": messages, "stream": false, "options": { "num_ctx": self.ctx } });
        if !tools.is_empty() { body["tools"] = Value::Array(tools.to_vec()); }
        let r = self.http.post(format!("{}/api/chat", self.host)).json(&body).send().await
            .map_err(|e| format!("Ollama at {} doesn't answer: {e}", self.host))?;
        let status = r.status();
        let v: Value = r.json().await.map_err(|e| format!("Ollama answered {status} with something else than JSON: {e}"))?;
        if !status.is_success() || v.get("error").is_some() {
            return Err(format!("Ollama: {}", v["error"].as_str().unwrap_or(status.as_str())));
        }
        let m = &v["message"];
        let calls = m["tool_calls"].as_array().map(|cs| cs.iter().map(|c| {
            let f = &c["function"];
            let args = match &f["arguments"] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                a => a.clone(),
            };
            (f["name"].as_str().unwrap_or_default().to_owned(), if args.is_object() { args } else { json!({}) })
        }).collect()).unwrap_or_default();
        // its thinking stays out of the conversation: it's long, and the next round doesn't need it
        let mut message = json!({ "role": "assistant", "content": m["content"].as_str().unwrap_or_default() });
        if let Some(tc) = m.get("tool_calls") { message["tool_calls"] = tc.clone(); }
        Ok(Reply { content: m["content"].as_str().unwrap_or_default().to_owned(), calls, message })
    }
}

/// A tool as Ollama takes it.
pub fn tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}
