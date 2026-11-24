from base64 import b64decode
import json
import os
import re
import sqlite3
import subprocess

from ruamel.yaml.error import YAMLError

import streamlit as st

import catalog
import jobs
from data import request

st.set_page_config(page_title="Gestalts CMS", layout="wide")
st.title("Gestalts CMS")
target = st.sidebar.radio("Data source", ["Local", "SSH"])
host = os.getenv("GESTALTS_CMS_SSH")
page = st.sidebar.radio("Page", ["Submissions", "Catalog", "Runs"])
if target == "SSH" and (not host or not re.fullmatch(r"[\w.@-]+", host) or host.startswith("-")):
    st.error("Set GESTALTS_CMS_SSH to the SSH destination and restart the CMS.")
    st.stop()


def fetch(**args):
    if target == "Local":
        return request(catalog.REPO / "server-data", args)
    process = subprocess.run(["ssh", "-o", "BatchMode=yes", host], input=json.dumps(args),
                             capture_output=True, check=True, timeout=60, text=True)
    response = json.loads(process.stdout)
    if "error" in response:
        raise ValueError(response["error"])
    return response["result"]


def show_patch(diff, name):
    if not diff:
        st.info("No changes.")
        return
    if len(diff) > 120_000:
        st.caption("Showing the first 120 KB of the patch. Review the full changes in Git after applying.")
    st.code(diff[:120_000].decode(errors="replace"), language="diff")
    if st.button("Apply to checkout", key=name):
        catalog.apply(diff)
        st.success("Applied. Review the checkout and run the repository checks.")


def submissions():
    offset = st.number_input("Page", min_value=1, step=1, key="submission-page") - 1
    rows = fetch(op="submissions", offset=offset * 50)
    if not rows:
        st.info("No submissions on this page.")
        return
    row = st.selectbox("Submission", rows, format_func=lambda r: f"{r['title']} · {r['email']} · {r['status']}")
    st.write({k: row[k] for k in ("source", "about", "credit", "created", "note", "promoted")})
    sid = row["id"]
    index = fetch(op="snapshot", id=sid)
    choice = st.selectbox("Snapshot file", [(group, name) for group in ("ymls", "blobs") for name in index[group]],
                          format_func=lambda entry: entry[1], index=None)
    if choice:
        group, name = choice
        content = b64decode(fetch(op="snapshot_file", id=sid, group=group, name=name))
        if group == "ymls":
            st.code(content.decode(), language="yaml")
        else:
            st.download_button("Download artifact", content, file_name=name)
    if row["status"] != "pending":
        return
    with st.form(f"reject-{sid}-{target}"):
        note = st.text_area("Rejection note")
        if st.form_submit_button("Reject submission"):
            fetch(op="decide", id=sid, status="rejected", note=note)
            st.rerun()
    slug = re.sub(r"[^a-z0-9]+", "-", row["title"].lower()).strip("-")[:48].rstrip("-") or "view"
    earlier = fetch(op="prior", id=sid)
    prior_path = earlier["promoted"] if earlier else None
    prior = {}
    if prior_path and re.fullmatch(r"plugins/(?:vizint/decks/)?" + catalog.SLUG, prior_path):
        origin = catalog.REPO / prior_path / "origin.yml"
        if origin.resolve() == origin and origin.is_file():
            prior = catalog.read_yaml(origin.read_text())
    with st.form(f"stage-{sid}-{target}"):
        plugin = st.text_input("Plugin", prior_path.split("/")[1] if prior_path else slug)
        package = st.text_input("Model package", prior.get("package", slug))
        deck = st.text_input("Deck", prior.get("deck", slug))
        concept_text = st.text_area("Concept weights (YAML mapping)", placeholder="Fractions: 1")
        if st.form_submit_button("Prepare import"):
            destination, diff = catalog.stage(fetch, row, plugin, package, deck, catalog.read_yaml(concept_text) or {}, earlier)
            st.session_state[f"patch-{sid}-{target}"] = diff
            st.session_state[f"path-{sid}-{target}"] = destination
            st.session_state[f"deck-{sid}-{target}"] = deck
            st.session_state[f"destination-{sid}-{target}"] = destination
    diff = st.session_state.get(f"patch-{sid}-{target}")
    if diff is not None:
        show_patch(diff, f"apply-{sid}-{target}")
        destination = st.session_state[f"path-{sid}-{target}"]
        parts = destination.split("/")
        prepared_deck = st.session_state[f"deck-{sid}-{target}"]
        preview = f"/v/{parts[1]}/{prepared_deck}" if len(parts) == 2 else f"/v/vizint/{parts[-1]}"
        st.link_button("Preview on local site", os.getenv("GESTALTS_CMS_SITE", "http://localhost:5177").rstrip("/") + preview)
    destination = st.text_input("Committed catalog path", st.session_state.get(f"path-{sid}-{target}", ""),
                                key=f"destination-{sid}-{target}")
    if st.button("Record acceptance after checks and commit", disabled=not destination):
        if not re.fullmatch(r"plugins/(?:vizint/decks/)?" + catalog.SLUG, destination):
            raise ValueError("Invalid catalog path")
        origin = catalog.read_yaml(catalog.git(catalog.REPO, "show", f"HEAD:{destination}/origin.yml").decode())
        if origin.get("submission") != sid or origin.get("source") != row["source"]:
            raise ValueError("HEAD does not contain this submission at that path")
        fetch(op="decide", id=sid, status="accepted", target=destination)
        st.rerun()


def catalog_page():
    site = catalog.read_yaml((catalog.REPO / catalog.SITE).read_text())
    plugin = st.selectbox("Catalog plugin", [ref.removeprefix("../../plugins/") for ref in site["plugins"]])
    sources = jobs.files(plugin)
    name = st.selectbox("Source or metadata file", list(sources))
    if not name:
        return
    path = f"plugins/{plugin}/{name}"
    with st.form(f"catalog-{path}"):
        content = st.text_area("Source", sources[name], height=400)
        if st.form_submit_button("Prepare changes"):
            st.session_state["catalog-diff"] = (path, catalog.patch([path], lambda root: catalog.write(root, path, content)))
    prepared = st.session_state.get("catalog-diff")
    if prepared and prepared[0] == path:
        show_patch(prepared[1], "apply-catalog")


def runs():
    local, remote = st.tabs(["Model jobs", "Server records"])
    with local:
        with st.form("new-job"):
            plugin = st.selectbox("Plugin", sorted(path.parent.name for path in (catalog.REPO / "plugins").glob("*/plugin.yml")))
            provider = st.selectbox("Provider", ["Ollama", "Gemini"])
            model = st.text_input("Model")
            prompt = st.text_area("Prompt")
            if st.form_submit_button("Start job"):
                jobs.start(plugin, provider, model, prompt)
        st.button("Refresh jobs")
        directories = sorted(jobs.ROOT.glob("*/job.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        job_path = st.selectbox("Local run", directories, format_func=lambda p: p.parent.name, index=None)
        if job_path:
            job = json.loads(job_path.read_text())
            if job["status"] == "running":
                try:
                    os.kill(job["pid"], 0)
                except ProcessLookupError:
                    job["status"] = "interrupted"
            st.json(job)
            directory = job_path.parent
            logs = directory / "events.jsonl"
            if st.checkbox("Show local log"):
                if logs.exists():
                    st.code(logs.read_text()[-100000:], language="json")
                process_log = directory / "process.log"
                if process_log.exists() and process_log.stat().st_size:
                    st.code(process_log.read_text()[-100000:])
            if job["status"] == "completed":
                show_patch(jobs.proposed(directory), f"apply-{directory.name}")
    with remote:
        if not st.checkbox("Load server runs"):
            return
        offset = st.number_input("Run page", min_value=1, step=1) - 1
        rows = fetch(op="runs", offset=offset * 50)
        st.dataframe(rows)
        selected = st.selectbox("Run", [row["id"] for row in rows], index=None)
        if selected:
            offset = st.number_input("Event page", min_value=1, step=1) - 1
            events = fetch(op="events", id=selected, offset=offset * 50)
            st.json(events)
            hashes = sorted(set(re.findall(r'"\$blob": "([0-9a-f]{64})"', json.dumps(events))))
            sha = st.selectbox("Referenced blob", hashes, index=None)
            if sha:
                st.download_button("Download blob", b64decode(fetch(op="blob", sha=sha)), file_name=sha)


try:
    {"Submissions": submissions, "Catalog": catalog_page, "Runs": runs}[page]()
except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, KeyError, TypeError, YAMLError) as error:
    if isinstance(error, subprocess.CalledProcessError) and error.stderr:
        st.error(error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr)
    else:
        st.error(str(error))
