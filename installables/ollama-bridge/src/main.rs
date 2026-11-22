//! gestalts-ollama-bridge (experimental): lets a website you allow run an Ollama model on this computer with the
//! website's own tools. It speaks claude-bridge's protocol to the page; inside, it calls Ollama's `/api/chat` with tools
//! in a loop, on the files the page sent, kept in memory.

use std::sync::Arc;

use clap::{Parser, Subcommand};

mod config;
mod ollama;
mod run;
mod server;

pub const NAME: &str = "gestalts-ollama-bridge";
pub const TITLE: &str = "Ollama bridge";
pub const PORT: u16 = 7738;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    #[arg(long, global = true, default_value_t = PORT)]
    port: u16,
    /// keeps the allowed sites apart, e.g. `--profile dev`
    #[arg(long, global = true)]
    profile: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// headless (there is no tray yet)
    Serve {
        /// development: pages on localhost may use it without asking
        #[arg(long)]
        dev: bool,
    },
}

/// Asks in a dialog, from a blocking thread.
struct DialogAsker;
impl server::Asker for DialogAsker {
    fn allow(&self, origin: &str) -> bool {
        let answer = rfd::MessageDialog::new()
            .set_title(TITLE)
            .set_level(rfd::MessageLevel::Warning)
            .set_description(format!(
                "Allow {origin} to run Ollama models on this computer?\n\nIt can then have a local model read and change \
                 the files it sends here. Allow only sites you trust."))
            .set_buttons(rfd::MessageButtons::YesNo)
            .show();
        answer == rfd::MessageDialogResult::Yes
    }
}

fn main() {
    let cli = Cli::parse();
    let Command::Serve { dev } = cli.command;
    if let Err(e) = serve(cli.port, cli.profile.as_deref(), dev) {
        eprintln!("{NAME}: {e}");
        std::process::exit(1);
    }
}

fn serve(port: u16, profile: Option<&str>, dev: bool) -> Result<(), String> {
    let paths = config::Paths::new(profile)?;
    let bridge = server::Bridge::new(paths, dev, Arc::new(DialogAsker), ollama::Ollama::from_env()?);
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        println!("{NAME} on http://127.0.0.1:{port}{}", if dev { " (dev: localhost pages are allowed)" } else { "" });
        let s = bridge.status().await;
        match (s.found, s.has_model) {
            (true, true) => println!("ollama: {} at {}", s.model, s.host),
            (true, false) => println!("ollama: at {}, but without {}: run `ollama pull {}`", s.host, s.model, s.model),
            _ => println!("ollama: nothing answers at {}; start it, or set GESTALTS_OLLAMA_HOST", s.host),
        }
        server::serve(bridge, listener, stop_requested()).await
    })
}

/// Resolves on Ctrl+C, or on SIGTERM on Unix.
pub async fn stop_requested() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("can watch SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    { let _ = tokio::signal::ctrl_c().await; }
}
