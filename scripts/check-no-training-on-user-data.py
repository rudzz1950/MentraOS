#!/usr/bin/env python3
"""
Fail the build if the product gains a way to train a model on what it captured.

ANI-90. Fine-tuning on captured user data is not inadvisable here; it is
incompatible with the consent guarantee. ADR-002 requires revocation to be
provably complete. A database honours DELETE WHERE scope_id = ?. Weights do
not: a model trained on someone's words cannot unlearn them when they revoke,
and the product would be asserting a deletion it cannot perform.

The temptation is strong ("learns from your usage" demos well) and the
violation is invisible in a diff: a training job looks like any other upload.
So, like the voice-biometrics check, this makes the rule hard to break by
accident rather than relying on everyone remembering it.

Two rules:

  1. App code never contains fine-tuning machinery. Not the frameworks (PEFT,
     TRL, Unsloth, Axolotl), not a hosted fine-tune API, not a training loop.
     Personalisation is retrieval into the context window, which is revocable
     and already built.

  2. Training code lives only under `training/`, and that directory declares
     every dataset it uses in `training/DATA_SOURCES.json`, each one synthetic
     or curated and none containing user data. Training code may not reach
     into the memory store, transcripts or captures.

If an ADR genuinely allows an exception, the line carries
  no-user-data-training:allow ADR-00N
and this file changes in the same pull request.

Usage:  python3 scripts/check-no-training-on-user-data.py [paths...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# App code: where training machinery must never appear.
APP_ROOTS = [
    "miniapps",
    "mobile/modules/engine/src",
    "mobile/modules/bluetooth-sdk/src",
    "mobile/src",
    "proto",
    "tools/myglasses",
]

TRAINING_ROOT = "training"
MANIFEST = "training/DATA_SOURCES.json"

SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".kt", ".swift", ".py", ".ipynb", ".sh", ".yaml", ".yml", ".json"}

# Specific names, not words like "train" or "tune": a check that fires on a
# "train" timetable or a "tune" in a music miniapp is a check everyone learns
# to ignore.
MACHINERY = [
    (r"\bfrom\s+peft\b|\bimport\s+peft\b|\bLoraConfig\b|\bget_peft_model\b", "PEFT / LoRA adapter training"),
    (r"\bfrom\s+trl\b|\bimport\s+trl\b|\bSFTTrainer\b|\bDPOTrainer\b", "TRL fine-tuning"),
    (r"\bunsloth\b", "Unsloth fine-tuning"),
    (r"\baxolotl\b", "Axolotl fine-tuning"),
    (r"\btransformers\b.*\bTrainer\b|\bTrainingArguments\b", "Hugging Face Trainer"),
    (r"fine_tuning\.jobs|/v1/fine_tuning|/v1/fine-tunes|fine_tunes\.create|createFineTuneJob", "hosted fine-tune API"),
    (r"\bloss\.backward\(\)|\boptimizer\.step\(\)", "a training loop"),
]

# What training code must not read: the stores that hold the wearer's and
# other people's words.
USER_DATA = [
    (r"miniapps/assistant/src/memory|from\s+['\"].*memory/(?:memory|index)['\"]", "the memory store"),
    (r"\bexportAll\b|\bimportChecked\b|\bMemoryExport\b", "a memory export"),
    (r"['\"]mem:(?:index|vectors|revoked)?['\"]?", "the memory store's storage keys"),
    (r"\bTranscriptSource\b|\btranscription\.(?:on|configure)\b", "live transcripts"),
    (r"\bcaptured\b.*\bscopeId\b|\bscopeId\b.*\bcaptured\b", "captured, consent-scoped data"),
]

ALLOW = re.compile(r"no-user-data-training:allow\s+ADR-\d+")
SELF = Path(__file__).resolve()
OK_KINDS = {"synthetic", "curated"}


def compiled(rules):
    return [(re.compile(p, re.IGNORECASE), why) for p, why in rules]


def files_under(repo: Path, roots: list[str]) -> list[Path]:
    out: list[Path] = []
    for root in roots:
        base = repo / root
        if base.is_file():
            out.append(base)
        elif base.is_dir():
            out += [
                p for p in base.rglob("*")
                if p.is_file() and p.suffix in SUFFIXES and p.resolve() != SELF
                and "node_modules" not in p.parts
            ]
    return sorted(set(out))


def scan(path: Path, rules) -> list[tuple[int, str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        if ALLOW.search(line):
            continue
        for rx, why in rules:
            if rx.search(line):
                hits.append((n, why, line.strip()[:120]))
                break
    return hits


def check_manifest(repo: Path) -> list[str]:
    """Problems with training/DATA_SOURCES.json. Empty when it is sound."""
    path = repo / MANIFEST
    if not path.exists():
        return [f"{MANIFEST} is missing: training code exists, so every dataset it uses must be declared"]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"{MANIFEST} is not valid JSON: {e}"]
    sources = doc.get("sources") if isinstance(doc, dict) else None
    if not isinstance(sources, list) or not sources:
        return [f"{MANIFEST} must have a non-empty \"sources\" list"]
    problems = []
    for i, s in enumerate(sources):
        name = s.get("name", f"sources[{i}]") if isinstance(s, dict) else f"sources[{i}]"
        if not isinstance(s, dict):
            problems.append(f"{name}: not an object")
            continue
        if s.get("kind") not in OK_KINDS:
            problems.append(f"{name}: kind must be one of {sorted(OK_KINDS)}, got {s.get('kind')!r}")
        if s.get("contains_user_data") is not False:
            problems.append(f"{name}: contains_user_data must be stated, and false")
        if not s.get("provenance"):
            problems.append(f"{name}: provenance must say where the data came from")
    return problems


def run(repo: Path, app_roots: list[str] | None = None) -> tuple[list[str], int]:
    """(problems, files scanned). Separate from main so it can be tested on a temp tree."""
    problems: list[str] = []
    app = files_under(repo, app_roots or APP_ROOTS)
    for f in app:
        for n, why, line in scan(f, compiled(MACHINERY)):
            problems.append(f"{f.relative_to(repo)}:{n}  {why} in app code\n    {line}")

    training = files_under(repo, [TRAINING_ROOT])
    code = [f for f in training if f.resolve() != (repo / MANIFEST).resolve()]
    if code:
        problems += check_manifest(repo)
        for f in code:
            for n, why, line in scan(f, compiled(USER_DATA)):
                problems.append(f"{f.relative_to(repo)}:{n}  training code reads {why}\n    {line}")
    return problems, len(app) + len(training)


def main(argv: list[str]) -> int:
    repo = Path(__file__).resolve().parent.parent
    rest = [a for a in argv[1:] if not a.startswith("--")]
    problems, scanned = run(repo, rest or None)
    if not problems:
        print(f"no training on user data: {scanned} files scanned, clean")
        return 0
    print("TRAINING-ON-USER-DATA CHECK FAILED\n")
    for p in problems:
        print(f"  {p}\n")
    print(
        "Weights cannot honour a revocation, so nothing captured from the wearer\n"
        "or the people around them may be trained on. Fine-tune on synthetic or\n"
        "curated data only, declared in training/DATA_SOURCES.json, and keep\n"
        "personalisation in retrieval, where deleting a scope deletes it.\n\n"
        "If an ADR genuinely permits an exception, mark the line\n"
        "  no-user-data-training:allow ADR-00N\n"
        "and update scripts/check-no-training-on-user-data.py in the same change."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
