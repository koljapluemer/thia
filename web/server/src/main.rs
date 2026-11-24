//! `thia-server serve` runs thia's server; `thia-server admin …` makes schools and accounts.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use thia_server::worker::WorkerConfig;
use thia_server::{AppState, Limits, Services, auth, db, now_iso, random_hex, random_token};

#[derive(Parser)]
#[command(about = "thia's server: accounts, drafts, MCP, publishing, lessons")]
struct Cli {
    /// where everything lives: thia.db, drafts/, lessons/, npm/, runtime/
    #[arg(long, env = "THIA_DATA", default_value = "server-data")]
    data: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serves the app's API and the lesson domain
    Serve {
        /// the app's API (`/api`), behind the app's domain
        #[arg(long, default_value = "127.0.0.1:7740")]
        app: SocketAddr,
        /// the lesson domain: the player, lessons and npm bundles
        #[arg(long, default_value = "127.0.0.1:7741")]
        lessons: SocketAddr,
        /// cookies without `Secure`, for a local run over http
        #[arg(long)]
        insecure_cookies: bool,
        /// the repo checkout: the worker (web/server/worker) and the agent template (packages/workshop) are in it
        #[arg(long, env = "THIA_REPO", default_value = ".")]
        repo: PathBuf,
        #[arg(long, env = "THIA_NODE", default_value = "node")]
        node: String,
        /// the lesson domain as students reach it, for links
        #[arg(long, env = "THIA_LESSON_ORIGIN", default_value = "http://127.0.0.1:7741")]
        lesson_origin: String,
    },
    /// Schools and accounts
    Admin {
        #[command(subcommand)]
        command: Admin,
    },
}

#[derive(Subcommand)]
enum Admin {
    /// A school; prints its id
    AddSchool { name: String },
    /// Lets an account review submissions for the public site, or (--revoke) no longer
    #[command(name = "grant-admin")]
    Grant {
        email: String,
        #[arg(long)]
        revoke: bool,
    },
    /// Lets an account's drafts use every model package in the repo, with more room, or (--revoke) no longer
    #[command(name = "grant-maintainer")]
    GrantMaintainer {
        email: String,
        #[arg(long)]
        revoke: bool,
    },
    /// A new password for an account, signing it out everywhere; prints it
    ResetPassword {
        #[arg(long)]
        email: String,
    },
    /// A build of the site (web/site/dist), which plays lessons, under runtime/<its version>/, for the lessons made
    /// against it; prints the version
    InstallPlayer {
        #[arg(long, default_value = "web/site/dist")]
        dist: PathBuf,
    },
    /// The index of agent runs made anew from their records (runs/); prints how many
    #[command(name = "reindex-runs")]
    ReindexRuns,
    /// The record of agent runs: list, summary, show, diff, stream, blob, note
    Runs {
        #[command(subcommand)]
        command: Box<thia_server::runs::cli::Command>,
    },
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    std::fs::create_dir_all(&cli.data).map_err(|e| format!("{}: {e}", cli.data.display()))?;
    let db = db::Db::open(&cli.data.join("thia.db")).map_err(|e| e.to_string())?;
    let limits = Limits::default();
    match cli.command {
        Command::Admin { command } => {
            let now = now_iso();
            match command {
                Admin::AddSchool { name } => {
                    let id = random_hex(8);
                    db.add_school(&id, &name, &now).map_err(|e| e.to_string())?;
                    println!("{id}");
                }
                Admin::Grant { email, revoke } => {
                    if !db.set_admin(&email.trim().to_lowercase(), !revoke).map_err(|e| e.to_string())? {
                        return Err(format!("no account {email}"));
                    }
                }
                Admin::GrantMaintainer { email, revoke } => {
                    if !db.set_maintainer(&email.trim().to_lowercase(), !revoke).map_err(|e| e.to_string())? {
                        return Err(format!("no account {email}"));
                    }
                }
                Admin::InstallPlayer { dist } => {
                    let meta = std::fs::read_to_string(dist.join("gestalts-runtime.json")).map_err(|e| format!("{}: {e}: build the player first", dist.display()))?;
                    let version = serde_json::from_str::<serde_json::Value>(&meta).ok().and_then(|v| v["version"].as_str().map(str::to_owned)).ok_or("gestalts-runtime.json has no version")?;
                    let to = cli.data.join("runtime").join(&version);
                    copy_dir(&dist, &to, PLAYER_SKIPS).map_err(|e| format!("{}: {e}", to.display()))?;
                    println!("{version}");
                }
                Admin::ReindexRuns => {
                    let root = cli.data.join("runs");
                    let n = db.with(|c| Ok(thia_server::runs::Runs::open(c, root, false).and_then(|r| r.reindex(c)))).map_err(|e| e.to_string())??;
                    println!("{n}");
                }
                Admin::Runs { command } => thia_server::runs::cli::run(&db, &cli.data, *command, &mut std::io::stdout().lock())?,
                Admin::ResetPassword { email } => {
                    let password = random_token(12);
                    if !db.set_password(&email.trim().to_lowercase(), &auth::hash_password(&password)).map_err(|e| e.to_string())? {
                        return Err(format!("no account {email}"));
                    }
                    println!("{password}");
                }
            }
            Ok(())
        }
        Command::Serve { app, lessons, insecure_cookies, repo, node, lesson_origin } => {
            let repo = std::fs::canonicalize(&repo).map_err(|e| format!("{}: {e}", repo.display()))?;
            let services = Services {
                worker: WorkerConfig {
                    node,
                    script: repo.join("web/server/worker/worker.ts"),
                    template: repo.join("packages/workshop/agent-template"),
                    npm_cache: std::path::absolute(cli.data.join("npm-cache")).map_err(|e| e.to_string())?,
                },
                lesson_origin,
            };
            let state = AppState::new(db, cli.data, limits, !insecure_cookies, services)?;
            // a chat host's run ends when no call comes for it a while, whether or not another call comes at all
            let sweeping = state.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    sweeping.mcp.sweep(&sweeping).await;
                }
            });
            let app_listener = tokio::net::TcpListener::bind(app).await.map_err(|e| format!("{app}: {e}"))?;
            let lesson_listener = tokio::net::TcpListener::bind(lessons).await.map_err(|e| format!("{lessons}: {e}"))?;
            eprintln!("app API on http://{app}/api (MCP at /mcp), lessons on http://{lessons}");
            let a = axum::serve(app_listener, thia_server::app(state.clone()));
            let l = axum::serve(lesson_listener, thia_server::lessons(state));
            tokio::select! {
                r = a => r.map_err(|e| e.to_string()),
                r = l => r.map_err(|e| e.to_string()),
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
    }
}

/// What of the site's build a player doesn't need: its prerendered pages, sitemap and the like (each version is kept
/// for good, so these would add up).
const PLAYER_SKIPS: &[&str] = &["o", "v", "404.html", "sitemap.xml", "robots.txt"];

/// `from` into `to`, but for the top-level entries named in `skip`.
fn copy_dir(from: &std::path::Path, to: &std::path::Path, skip: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        if e.file_name().to_str().is_some_and(|n| skip.contains(&n)) {
            continue;
        }
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()), &[])?;
        } else {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}
