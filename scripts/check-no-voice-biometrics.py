#!/usr/bin/env python3
"""
Fail the build if anything that computes a speaker embedding enters the tree.

WHY THIS IS A BUILD FAILURE AND NOT A GUIDELINE. The privacy charter says no
biometric templates are ever computed, stored or transmitted, and 03 - Tech &
Architecture calls that constraint the moat: a competitor can add face or voice
recognition in a sprint, and cannot add "we structurally cannot" after shipping
one that can.

A speaker embedding IS a biometric template. "Who said what" is the obvious
next feature, and diarization would break the charter quietly, in a library
call, without anyone deciding to. That is the failure mode worth engineering
against -- not a bad decision, but no decision at all.

ANI-79 found the memory store contradicting ADR-002 within hours of that ADR
being written. A rule nobody can accidentally break is worth more than a rule
everyone agrees with.

THE SANCTIONED ALTERNATIVE, so this script is not just a wall: the
consent-scoped identity token exchange from 03. Two consenting devices swap a
rotating, revocable pseudonymous token and memory is keyed on that. Revoking
consent revokes the memory. No voice print, and it is the differentiated
version rather than a compromise.

Within-session turn separation that stores nothing is arguably outside the
charter. The burden of proof sits on whoever proposes it, and "we delete the
embeddings afterwards" is NOT sufficient -- computed is computed. If it is ever
allowed, it is allowed by an ADR that also updates this file, never by a pull
request that adds an ignore.

Usage:  python3 scripts/check-no-voice-biometrics.py [paths...]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Code WE wrote. This is the enforced set, because a check that fails on code
# we cannot change teaches everyone to pass --no-verify.
#
# Upstream MentraOS is a separate problem: it already ships a `diarization`
# flag on its transcription config, which the fork inherits. That is a real
# contradiction with the charter and it needs a decision, not a build failure
# in our CI -- run with --audit to see those surfaces.
DEFAULT_ROOTS = [
    "miniapps/assistant/src",
    "mobile/modules/engine/src/types/capabilities",
    "mobile/modules/engine/src/utils/buttonGestures.ts",
    "proto",
    "tools/myglasses",
]

# Scanned by --audit only, and reported without failing: code we inherited.
AUDIT_ROOTS = [
    "mobile/modules/miniapp/src",
    "mobile/modules/engine/src",
    "mobile/modules/bluetooth-sdk/src",
]

SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".kt", ".swift", ".py", ".c", ".h", ".proto"}

# Each pattern is a thing that computes or compares a voice identity.
# Keep the list specific: a broad match on "speaker" would fire on an audio
# output device and teach everyone to ignore this script.
FORBIDDEN = [
    (r"\bpyannote\b", "pyannote: speaker diarization"),
    (r"\bresemblyzer\b", "resemblyzer: voice encoder"),
    (r"\bspeechbrain\.(?:pretrained|inference)\b.*\b(?:SpeakerRecognition|EncoderClassifier)\b",
     "speechbrain speaker recognition"),
    (r"\b(?:x_vector|xvector|d_vector|dvector)\b", "x-vector / d-vector speaker embedding"),
    (r"\bECAPA[_-]?TDNN\b", "ECAPA-TDNN speaker embedding"),
    (r"\bspeaker[_-]?embedding", "speaker embedding"),
    (r"\bspeaker[_-]?encoder", "speaker encoder"),
    (r"\bvoice[_-]?print", "voice print"),
    # NOT a bare `speakerId`: in TTS that selects which voice to synthesise
    # with, and matching it fired on eight legitimate lines the first time this
    # ran. A check that cries wolf is a check everyone learns to ignore, so the
    # phrase has to be the identification sense specifically.
    (r"\bspeaker[_-]?(?:identification|verification|recognition)\b",
     "speaker identification / verification"),
    (r"\bdiariz(?:e|ation|er)\b", "diarization"),
    # sherpa-onnx ships speaker identification alongside the STT we do use,
    # so the specific entry points are named rather than the whole package.
    (r"SpeakerEmbeddingExtractor", "sherpa-onnx speaker embedding extractor"),
    (r"SpeakerEmbeddingManager", "sherpa-onnx speaker embedding manager"),
]

COMPILED = [(re.compile(p, re.IGNORECASE), why) for p, why in FORBIDDEN]

# This file necessarily contains every term it bans.
SELF = Path(__file__).resolve()

# A line may opt out ONLY with an ADR reference, so an exemption cannot be
# added silently. The marker names the decision that allows it.
ALLOW = re.compile(r"no-voice-biometrics:allow\s+ADR-\d+")


def scan(path: Path) -> list[tuple[int, str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    hits: list[tuple[int, str, str]] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW.search(line):
            continue
        for rx, why in COMPILED:
            if rx.search(line):
                hits.append((lineno, why, line.strip()[:120]))
                break
    return hits


def main(argv: list[str]) -> int:
    audit = "--audit" in argv
    rest = [a for a in argv[1:] if not a.startswith("--")]
    roots = rest or (AUDIT_ROOTS if audit else DEFAULT_ROOTS)
    repo = Path(__file__).resolve().parent.parent

    files: list[Path] = []
    for root in roots:
        base = repo / root
        if base.is_file():
            files.append(base)
            continue
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.is_file() and p.suffix in SUFFIXES and p.resolve() != SELF:
                files.append(p)

    findings: list[tuple[Path, int, str, str]] = []
    for f in sorted(set(files)):
        for lineno, why, line in scan(f):
            findings.append((f.relative_to(repo), lineno, why, line))

    if not findings:
        print(f"no voice biometrics: {len(files)} files scanned, clean")
        return 0

    if audit:
        # Inherited surfaces. Reported, never fatal: we cannot fix upstream in
        # our own CI, and the decision about what to do with these belongs in
        # an ADR rather than a pre-commit hook.
        print(f"AUDIT: {len(findings)} inherited voice-identity surfaces\n")
        for rel, lineno, why, line in findings:
            print(f"  {rel}:{lineno}  {why}")
            print(f"    {line}\n")
        print(
            "These are in code we inherited from upstream MentraOS, not code we\n"
            "wrote. They still ship in our fork, so the charter claim that we\n"
            "structurally cannot identify a voice is not currently true of the\n"
            "build. That needs a decision: remove the surface from the fork, or\n"
            "stop making the claim in that form."
        )
        return 0

    print("VOICE BIOMETRICS CHECK FAILED\n")
    for rel, lineno, why, line in findings:
        print(f"  {rel}:{lineno}")
        print(f"    {why}")
        print(f"    {line}\n")
    print(
        "A speaker embedding is a biometric template, and the privacy charter\n"
        "forbids computing one. Use the consent-scoped identity token exchange\n"
        "instead: two consenting devices swap a rotating revocable pseudonymous\n"
        "token, and memory is keyed on that.\n\n"
        "If an ADR genuinely permits this, mark the line\n"
        "  no-voice-biometrics:allow ADR-00N\n"
        "and update scripts/check-no-voice-biometrics.py in the same change.\n"
        "Deleting the embedding afterwards is not sufficient: computed is computed."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
