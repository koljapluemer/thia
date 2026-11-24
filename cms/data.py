"""Allowlisted data access. The SSH command uses only Python's standard library."""
import base64
from contextlib import closing
from datetime import datetime, timezone
from itertools import islice
import json
from pathlib import Path
import re
import sqlite3
import sys


def key(value, pattern=r"[a-z0-9]{16,64}"):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError("Invalid identifier")
    return value


def file_at(root, *parts):
    path = root.joinpath(*parts).resolve(strict=True)
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError("Invalid artifact path")
    return path


def artifact(path):
    with path.open("rb") as stream:
        content = stream.read(64 * 1024 * 1024 + 1)
    if len(content) > 64 * 1024 * 1024:
        raise ValueError("Artifact exceeds the size limit")
    return base64.b64encode(content).decode("ascii")


def request(root, args):
    operation = args["op"]
    offset = max(0, int(args.get("offset", 0)))
    mode = "rw" if operation == "decide" else "ro"
    with closing(sqlite3.connect(f"{(root / 'thia.db').absolute().as_uri()}?mode={mode}", uri=True)) as db:
        db.row_factory = sqlite3.Row
        if operation == "submissions":
            sql = """SELECT s.*, a.email FROM submissions s JOIN accounts a ON a.id = s.account
                ORDER BY s.created DESC, s.id DESC LIMIT 50 OFFSET ?"""
            return [dict(row) for row in db.execute(sql, (offset,))]
        if operation == "runs":
            sql = """SELECT id, started, draft, backend, models, outcome, rating
                FROM runs ORDER BY started DESC, id DESC LIMIT 50 OFFSET ?"""
            return [dict(row) for row in db.execute(sql, (offset,))]
        if operation == "blob":
            sha = key(args["sha"], r"[0-9a-f]{64}")
            return artifact(file_at(root / "runs", "blobs", sha[:2], sha))
        pattern = r"[a-z0-9]{16,64}" if operation == "events" else r"[a-z0-9][a-z0-9-]{0,63}-[0-9a-f]{8}"
        item = key(args["id"], pattern)
        if operation == "prior":
            row = db.execute(
                """SELECT previous.id, previous.promoted FROM submissions current
                JOIN submissions previous ON previous.account=current.account AND previous.source=current.source
                WHERE current.id=? AND previous.status='accepted' AND previous.promoted IS NOT NULL
                ORDER BY previous.decided DESC LIMIT 1""", (item,),
            ).fetchone()
            return dict(row) if row else None
        if operation == "events":
            row = db.execute("SELECT path FROM runs WHERE id = ?", (item,)).fetchone()
            if row is None:
                raise ValueError("Run not found")
            with file_at(root / "runs", row["path"]).open() as stream:
                return [json.loads(line) for line in islice(stream, offset, offset + 50) if line.endswith("\n")]
        if operation in {"snapshot", "snapshot_file"}:
            if db.execute("SELECT 1 FROM submissions WHERE id = ?", (item,)).fetchone() is None:
                raise ValueError("Submission not found")
            index = json.loads(file_at(root, "submissions", item, "index.json").read_text())
            if operation == "snapshot":
                return index
            group = args["group"]
            if group not in ("ymls", "blobs"):
                raise ValueError("Invalid artifact group")
            name = args["name"]
            if (not isinstance(name, str) or not name or len(name.encode()) > 200
                or name.startswith(".") or any(c in "/\\" or ord(c) < 32 or 127 <= ord(c) <= 159 for c in name)
                or name not in index[group]):
                raise ValueError("Unknown snapshot file")
            directory, filename = ("notes", name + ".yml") if group == "ymls" else ("blobs", name)
            return artifact(file_at(root, "submissions", item, directory, filename))
        if operation == "decide":
            status = args["status"]
            if status == "rejected":
                note, target = args["note"].strip(), None
                if not 0 < len(note) <= 2000:
                    raise ValueError("Enter a rejection note of up to 2,000 characters")
            elif status == "accepted":
                target, note = key(args["target"], r"plugins/(?:vizint/decks/)?[a-z0-9][a-z0-9-]{0,47}"), None
            else:
                raise ValueError("Unknown decision")
            with db:
                db.execute("BEGIN IMMEDIATE")
                if target is not None:
                    conflict = db.execute(
                        """SELECT 1 FROM submissions previous JOIN submissions current ON current.id=?
                        WHERE previous.promoted=? AND previous.status='accepted'
                        AND (previous.source<>current.source OR previous.account<>current.account)""",
                        (item, target),
                    ).fetchone()
                    if conflict:
                        raise ValueError("Catalog path belongs to another submission source")
                result = db.execute(
                    """UPDATE submissions SET status=?, note=?, promoted=?, decided=?
                    WHERE id=? AND status='pending'""",
                    (status, note, target, datetime.now(timezone.utc).isoformat(), item),
                )
                if result.rowcount == 0:
                    prior = db.execute("SELECT status, note, promoted FROM submissions WHERE id=?", (item,)).fetchone()
                    if prior is None or tuple(prior) != (status, note, target):
                        raise ValueError("Submission is missing or already decided")
            return True
        raise ValueError("Unknown operation")


if __name__ == "__main__":
    try:
        print(json.dumps({"result": request(Path(sys.argv[1]).resolve(), json.loads(sys.stdin.read(16384)))}))
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}))
