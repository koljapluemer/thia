import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import catalog
from data import request
import jobs

ID = "view-1234abcd"


class DataTests(unittest.TestCase):
    def test_snapshot_and_decisions(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            with sqlite3.connect(root / "thia.db") as db:
                db.executescript("""
                    CREATE TABLE submissions(id, source, account, status, note, promoted, decided);
                    INSERT INTO submissions VALUES ('view-1234abcd', 'workshop:view', 'a', 'pending', NULL, NULL, NULL);
                """)
            catalog.write(root, f"submissions/{ID}/index.json", '{"ymls":["haus"],"blobs":[]}')
            catalog.write(root, f"submissions/{ID}/notes/haus.yml", "name: Haus")
            def snapshot(name):
                return request(root, dict(op="snapshot_file", id=ID, group="ymls", name=name))
            self.assertEqual(base64.b64decode(snapshot("haus")), b"name: Haus")
            with self.assertRaises(ValueError):
                snapshot("../../thia.db")
            def decide(note):
                try:
                    return request(root, dict(op="decide", id=ID, status="rejected", note=note))
                except ValueError:
                    return False
            with ThreadPoolExecutor() as pool:
                result = list(pool.map(decide, ["one", "two"]))
            self.assertEqual(result.count(True), 1)
            self.assertTrue(decide("one" if result[0] else "two"))


class CatalogTests(unittest.TestCase):
    def test_import(self):
        with TemporaryDirectory() as temp, patch.object(catalog, "REPO", Path(temp)):
            root = Path(temp)
            catalog.write(root, catalog.SITE, "plugins: []\nmodels: []\n")
            files = {
                "view": "gestalt: view@4\npackage: d-old\nlang: de\nsource: 'export default function View() {}'\nreads: [d-old/item@1]\nwrites: []",
                "gestalt-d-old.item@1": "gestalt: gestalt@1\nname: d-old/item\nversion: 1\nfields: {}",
                "wording": "gestalt: wording@1\nlang: de\nlayer: source\nmessages: {}",
                "item": "id: item\ngestalt: d-old/item@1",
            }

            def fetch(**args):
                if args["op"] == "snapshot":
                    return {"ymls": list(files), "blobs": ["photo.png"]}
                content = b"image" if args["group"] == "blobs" else files[args["name"]].encode()
                return base64.b64encode(content)

            row = dict(id=ID, kind="view", source="workshop:view", title="View",
                       about="A view", credit="Author", created="2026-11-24")
            target, diff = catalog.stage(fetch, row, "view", "model", "lesson", {"Example": 1}, None)
            catalog.apply(diff)
            self.assertEqual(target, "plugins/view")
            self.assertIn("model/item@1", (root / target / "plugin.yml").read_text())
            self.assertTrue((root / "gestalts/model/item/v1.yml").is_file())
            self.assertTrue((root / target / "wording/de.yml").is_file())
            self.assertEqual((root / target / "decks/lesson/blobs/photo.png").read_bytes(), b"image")
            with self.assertRaises(ValueError):
                catalog.stage(fetch, row, "view", "model", "lesson", {"Example": 1}, None)


class JobTests(unittest.TestCase):
    def test_job_success_and_provider_failure(self):
        for provider in ["Ollama", "Gemini"]:
            with self.subTest(provider=provider), TemporaryDirectory() as temp:
                directory = Path(temp)
                jobs.save(directory / "before.json", {"view.tsx": "old"})
                job = {"provider": provider, "model": "test", "prompt": "change text"}
                jobs.save(directory / "job.json", job)
                actions = [{"action": "write", "path": "view.tsx", "content": "new"}, {"action": "finish"}]
                with patch.object(jobs, "complete", side_effect=actions):
                    jobs.run(directory)
                self.assertEqual(json.loads((directory / "after.json").read_text()), {"view.tsx": "new"})
                with patch.object(jobs, "complete", side_effect=ValueError("provider failed")):
                    jobs.run(directory)
                self.assertEqual(json.loads((directory / "job.json").read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
