#!/usr/bin/env python3
"""
Fail the build if anything but the Zenoh adapter imports Zenoh. ANI-196 / ADR-001.

Components depend on the Bus port (miniapps/assistant/src/bus/bus.ts), so the
transport can be swapped and tests run without it. That only stays true if
nobody reaches past the port, and one convenient import is all it takes.

The adapter may live in any file whose name contains "zenoh-adapter" or
"zenoh_adapter", e.g. bus/zenoh-adapter.ts or ZenohAdapter.kt.

Usage:  python3 scripts/check-bus-imports.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOTS = ["miniapps", "mobile/modules", "mobile/src"]
SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".kt", ".swift", ".py"}
# Real import statements only, anchored at the start of a line, so a comment
# that mentions Zenoh is not a finding. A check that cries wolf gets ignored.
IMPORT = re.compile(
    r"""^\s*(?:"""
    r"""import\b[^;\n]*\bfrom\s+['"][^'"]*zenoh[^'"]*['"]"""   # TS/JS: import x from "...zenoh..."
    r"""|import\s+['"][^'"]*zenoh[^'"]*['"]"""                   # TS/JS: import "...zenoh..."
    r"""|(?:const|let|var)\s+[^=\n]+=\s*(?:await\s+)?(?:require|import)\(\s*['"][^'"]*zenoh"""  # require/dynamic import
    r"""|import\s+io\.zenoh\b"""                                # Kotlin/Java
    r"""|import\s+Zenoh\b"""                                     # Swift
    r"""|(?:from|import)\s+zenoh\b"""                            # Python
    r""")""",
    re.IGNORECASE | re.MULTILINE,
)
ADAPTER = re.compile(r"zenoh[-_]?adapter", re.IGNORECASE)


def run(repo: Path) -> tuple[list[str], int]:
    problems, scanned = [], 0
    for root in ROOTS:
        base = repo / root
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file() or p.suffix not in SUFFIXES or "node_modules" in p.parts:
                continue
            scanned += 1
            if ADAPTER.search(p.name):
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
            for m in IMPORT.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                problems.append(f"{p.relative_to(repo)}:{line}  imports Zenoh outside its adapter")
    return problems, scanned


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    problems, scanned = run(repo)
    if not problems:
        print(f"bus imports: {scanned} files scanned, clean")
        return 0
    print("BUS IMPORT CHECK FAILED\n")
    for p in problems:
        print(f"  {p}")
    print("\nDepend on the Bus port in miniapps/assistant/src/bus/bus.ts. Only a *zenoh-adapter* file may import Zenoh.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
