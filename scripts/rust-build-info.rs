use std::path::PathBuf;
use std::process::Command;

fn git(root: &PathBuf, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|s| !s.is_empty())
}

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let root = manifest.ancestors().find(|p| p.join(".git").exists()).map(PathBuf::from);
    let commit = std::env::var("GESTALTS_GIT_COMMIT").ok().or_else(|| git(root.as_ref()?, &["rev-parse", "HEAD"]));
    let dirty = std::env::var("GESTALTS_GIT_DIRTY").ok().or_else(|| {
        let root = root.as_ref()?;
        let out = Command::new("git").arg("-C").arg(root).args(["status", "--porcelain"]).output().ok()?;
        out.status.success().then(|| (!out.stdout.is_empty()).to_string())
    });
    println!("cargo:rerun-if-env-changed=GESTALTS_GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=GESTALTS_GIT_DIRTY");
    println!("cargo:rerun-if-env-changed=GESTALTS_BUILD");
    if let Some(root) = root {
        println!("cargo:rerun-if-changed={}", root.join(".git/HEAD").display());
    }
    if let Some(v) = commit { println!("cargo:rustc-env=GESTALTS_GIT_COMMIT={v}"); }
    if let Some(v) = dirty { println!("cargo:rustc-env=GESTALTS_GIT_DIRTY={v}"); }
    if let Ok(v) = std::env::var("GESTALTS_BUILD") { println!("cargo:rustc-env=GESTALTS_BUILD={v}"); }
}
