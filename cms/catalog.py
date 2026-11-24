"""Prepare catalog changes as Git patches in an isolated directory."""
from base64 import b64decode
from datetime import datetime, timezone
from hashlib import sha256
from io import StringIO
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory

from ruamel.yaml import YAML

from data import key

REPO = Path(__file__).resolve().parents[1]
SITE = "web/site/distribution.yml"
SLUG = r"[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?"


def git(root, *args, data=None):
    return subprocess.run(
        ["git", "-C", str(root), *args], input=data, capture_output=True, check=True,
    ).stdout


def read_yaml(text):
    return YAML(typ="safe").load(text)


def yaml_text(value):
    stream = StringIO()
    YAML().dump(value, stream)
    return stream.getvalue()


def write(root, path, content):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content if isinstance(content, bytes) else content.encode())


def patch(paths, change):
    with TemporaryDirectory() as directory:
        scratch = Path(directory)
        git(scratch, "init", "-q", "--template=")
        for path in sorted(set(paths)):
            source = REPO / path
            if source.resolve() != source:
                raise ValueError(f"Unexpected symlink at {path}")
            if source.is_dir():
                if any(p.is_symlink() for p in source.rglob("*")):
                    raise ValueError(f"Unexpected symlink under {path}")
                shutil.copytree(source, scratch / path)
            elif source.is_file():
                write(scratch, path, source.read_bytes())
        git(scratch, "add", "-f", ".")
        git(scratch, "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
            "-c", "user.name=Gestalts", "-c", "user.email=cms@localhost",
            "commit", "-qm", "Before", "--allow-empty")
        change(scratch)
        git(scratch, "add", "-f", "-A")
        return git(scratch, "diff", "--cached", "--binary")


def apply(diff):
    git(REPO, "apply", "--check", data=diff)
    git(REPO, "apply", data=diff)


def stage(fetch, row, plugin, package, deck, concepts, earlier):
    plugin, package, deck = (key(value, SLUG) for value in (plugin, package, deck))
    viz = row["kind"] == "viz"
    target = f"plugins/vizint/decks/{deck}" if viz else f"plugins/{plugin}"
    definitions = f"gestalts/{package}"
    if not concepts or any(not isinstance(name, str) or not name.strip() or name.strip() != name
                           or type(weight) not in (int, float) or not 0 < weight <= 1
                           for name, weight in concepts.items()):
        raise ValueError("Enter concept names and weights above zero and at most one")

    if not isinstance(concepts, dict):
        raise ValueError("Concept weights must be a YAML mapping")
    prior = {}
    if (REPO / target).resolve() != REPO / target:
        raise ValueError("Catalog target must not contain symlinks")
    if (REPO / target).exists():
        origin = REPO / target / "origin.yml"
        prior = read_yaml(origin.read_text()) if origin.is_file() and not origin.is_symlink() else {}
        if not earlier or earlier["promoted"] != target or prior.get("submission") != earlier["id"]:
            raise ValueError(f"{target} belongs to another catalog entry")
    if earlier and earlier["promoted"] != target:
        raise ValueError("Use the original target when accepting an update")
    if not viz and (REPO / definitions).exists() and prior.get("package") != package:
        raise ValueError(f"{definitions} already exists")
    if not viz and prior.get("package") and prior["package"] != package:
        raise ValueError("Use the original model package when accepting an update")

    index = fetch(op="snapshot", id=row["id"])
    notes = {name: b64decode(fetch(op="snapshot_file", id=row["id"], group="ymls", name=name)).decode()
             for name in index["ymls"]}
    docs = {name: read_yaml(text) for name, text in notes.items()}
    if not all(isinstance(doc, dict) for doc in docs.values()):
        raise ValueError("Snapshot YAML must contain mappings")
    views = [(name, doc) for name, doc in docs.items() if doc.get("gestalt") in {"view@2", "view@3", "view@4"}]
    if not viz and len(views) != 1:
        raise ValueError("Expected exactly one view in the snapshot")
    if viz and sum(doc.get("gestalt") == "viz@1" for doc in docs.values()) != 1:
        raise ValueError("Expected exactly one viz in the snapshot")
    view_id, view = ("", {}) if viz else views[0]
    old = view.get("package", "")
    if not viz and not old.startswith("d-"):
        raise ValueError("Expected a draft model package")

    def rename(text):
        return text if viz else text.replace(f"{old}/", f"{package}/").replace(f"gestalt-{old}.", f"gestalt-{package}.")

    def change(root):
        content, has_models = {}, False
        lang = view.get("lang", "en")
        for name, text in sorted(notes.items()):
            if name == view_id:
                continue
            doc = read_yaml(rename(text))
            if not viz and name.startswith("gestalt-"):
                short = key(doc["name"].removeprefix(package + "/"), r"[a-z0-9][a-z0-9_.-]*")
                version = int(doc["version"])
                for field in ("id", "gestalt"):
                    doc.pop(field, None)
                write(root, f"{definitions}/{short}/v{version}.yml", yaml_text(doc))
                has_models = True
            elif not viz and doc.get("gestalt") == "wording@1":
                language = key(doc["lang"], r"[A-Za-z0-9-]+")
                layer = key(doc.get("layer", "source"), SLUG)
                for field in ("id", "gestalt"):
                    doc.pop(field, None)
                name = language if layer == "source" else f"{language}-{layer}"
                write(root, f"{target}/wording/{name}.yml", yaml_text(doc))
            else:
                content[name] = rename(text)
        names = {doc.get("name"): name for name, doc in docs.items()
                 if name in content and doc.get("gestalt", "").startswith("concept@")}
        weights = {}
        for name, weight in concepts.items():
            cid = names.get(name) or "concept-" + sha256(name.encode()).hexdigest()[:16]
            if name not in names and cid in content:
                raise ValueError(f"Generated concept ID conflicts with snapshot file {cid}")
            content.setdefault(cid, yaml_text({"id": cid, "gestalt": "concept@2", "name": name}))
            weights[cid] = weight
        deck_path = target if viz else f"{target}/decks/{deck}"
        if not viz and prior.get("deck") and prior["deck"] != deck:
            raise ValueError("Use the original deck name when accepting an update")
        for subdir in ("notes", "blobs"):
            folder = root / deck_path / subdir
            if folder.exists():
                shutil.rmtree(folder)
        deck_id = f"deck-{'vizint' if viz else plugin}-{deck}"
        if deck_id in content:
            raise ValueError("The generated deck ID conflicts with a snapshot file")
        metadata = dict(id=deck_id, gestalt="deck@3" if viz else "deck@4", name=deck,
                        title=row["title"], members=sorted(content), concepts=weights)
        if not viz:
            metadata["lang"] = lang
            if view.get("target_lang"):
                metadata["target_lang"] = view["target_lang"]
        content[deck_id] = yaml_text(metadata)
        for name, text in content.items():
            write(root, f"{deck_path}/notes/{name}.yml", text)
        for name in index["blobs"]:
            write(root, f"{deck_path}/blobs/{name}",
                  b64decode(fetch(op="snapshot_file", id=row["id"], group="blobs", name=name)))
        write(root, f"{deck_path}/index.json", json.dumps(
            {"ymls": sorted(content), "blobs": sorted(index["blobs"])}) + "\n")
        origin = dict(submission=row["id"], source=row["source"], accepted=datetime.now(timezone.utc).isoformat(),
                      licence="CC BY-SA 4.0", deck=deck)
        if row["credit"]:
            origin["credit"] = row["credit"]
        if has_models:
            origin["package"] = package
        write(root, f"{target}/origin.yml", yaml_text(origin))
        if viz:
            return
        manifest = dict(id=plugin, version="1.0.0", title=row["title"], description=row["about"],
                        tags=["learning"], lang=lang, reads=view["reads"], writes=view["writes"])
        for field in ("target_lang", "npm"):
            if view.get(field):
                manifest[field] = view[field]
        write(root, f"{target}/view.tsx", rename(view["source"]))
        write(root, f"{target}/plugin.yml", rename(yaml_text(manifest)))
        yaml = YAML()
        site = yaml.load((root / SITE).read_text())
        for group, path in [("plugins", target)] + ([("models", definitions)] if has_models else []):
            ref = "../../" + path
            if ref not in site[group]:
                site[group].append(ref)
        with (root / SITE).open("w") as stream:
            yaml.dump(site, stream)

    return target, patch([target, SITE] + ([] if viz else [definitions]), change)
