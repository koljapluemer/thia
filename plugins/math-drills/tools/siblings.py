# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml==6.0.3"]
# ///
"""Writes a German sibling of each deck named in SIBLINGS: decks/<deck>-de, made from the built English deck.

A sibling holds the same exercises in another language and practises the same concepts, so what a learner does in
one counts for the other (beliefs are about concepts). Its exercises are items of their own (`<id>-de`): the
instruction is translated, and every number in the TeX is written as German schools write it (`23{,}6`). The
concepts, their links, the item model and the source are the same ymls as the English deck's, and merge with them.

Usage: uv run tools/siblings.py   (after build_decks.py; `mise run math-drills:decks` runs both), then publish-data.
"""

import re
import shutil
from pathlib import Path

import yaml

DECKS = Path(__file__).resolve().parent.parent / "decks"

# per deck: its German title and each instruction its exercises have; a deck with one missing isn't written
SIBLINGS = {
    "stembridge-round-tenth": {
        "title": "Auf Zehntel runden",
        "instructions": {"Round to the nearest tenth:": "Runde auf Zehntel:"},
    },
}

DECIMAL = re.compile(r"(\d)\.(\d)")


def german_tex(text: str) -> str:
    """Decimals in `$…$` with a comma, braced so TeX doesn't space it: `$23.6$` → `$23{,}6$`."""
    return re.sub(r"\$([^$]*)\$", lambda m: "$" + DECIMAL.sub(r"\1{,}\2", m.group(1)) + "$", text)


def write(notes: Path, value: dict) -> str:
    (notes / f"{value['id']}.yml").write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=1000), encoding="utf-8")
    return value["id"]


def sibling(name: str, spec: dict) -> None:
    source = DECKS / name / "notes"
    target = DECKS / f"{name}-de"
    if target.exists():
        shutil.rmtree(target)
    notes = target / "notes"
    notes.mkdir(parents=True)
    ymls = [yaml.safe_load(p.read_text(encoding="utf-8")) for p in sorted(source.glob("*.yml"))]
    deck = next(y for y in ymls if str(y.get("gestalt", "")).startswith("deck@"))
    members = []
    for y in ymls:
        if y is deck:
            continue
        if y["gestalt"] == "multiple-choice@1":
            task = y.get("instruction")
            if task is not None and task not in spec["instructions"]:
                raise SystemExit(f"{name}: no German for the instruction {task!r}")
            y = {**y, "id": f"{y['id']}-de", "prompt": german_tex(y["prompt"]),
                 "options": [{**o, "text": german_tex(o["text"])} for o in y["options"]],
                 **({"instruction": spec["instructions"][task]} if task is not None else {})}
        members.append(write(notes, y))
    write(notes, {"id": f"{deck['id']}-de", "gestalt": "deck@4", "name": f"{name}-de", "title": spec["title"],
                  "members": members, "concepts": deck["concepts"], "lang": "de"})
    shutil.copy(DECKS / name / "LICENSE.md", target / "LICENSE.md")
    print(f"{name}-de: {sum(1 for m in members if m.startswith('mc-'))} exercises")


if __name__ == "__main__":
    for name, spec in SIBLINGS.items():
        sibling(name, spec)
