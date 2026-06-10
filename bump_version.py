#!/usr/bin/env python3
"""Bump the GRIDMAP app version (X.Y.Z).

Usage:
    python3 bump_version.py {x|y|z}

Bumps the chosen component and resets the lower ones to 0 (semver-style):
    x  ->  (X+1).0.0
    y  ->  X.(Y+1).0
    z  ->  X.Y.(Z+1)

GRIDMAP has no single source-of-truth constant — the version is hardcoded in
THREE spots in index.html, all kept in sync here:
  - line-1 comment        <!-- GRIDMAP vX.Y.Z -->
  - header tag span       <span id="tagVersion">X.Y.Z</span>
  - version-morph const   const VER = ' // vX.Y.Z';
"""
import re
import sys
from pathlib import Path

INDEX = Path(__file__).resolve().parent / "index.html"

PATTERNS = [
    re.compile(r'(<!-- GRIDMAP v)(\d+)\.(\d+)\.(\d+)( -->)'),
    re.compile(r'(<span id="tagVersion">)(\d+)\.(\d+)\.(\d+)(</span>)'),
    re.compile(r"(const VER = ' // v)(\d+)\.(\d+)\.(\d+)(';)"),
]


def main():
    arg = sys.argv[1].lower() if len(sys.argv) == 2 else ""
    if arg not in ("x", "y", "z"):
        sys.exit("usage: python3 bump_version.py {x|y|z}")

    text = INDEX.read_text(encoding="utf-8")
    # The displayed span is the canonical reading; fall back to the comment.
    m = PATTERNS[1].search(text) or PATTERNS[0].search(text)
    if not m:
        sys.exit("error: version not found in index.html")

    x, y, z = (int(m.group(i)) for i in (2, 3, 4))
    old = f"{x}.{y}.{z}"
    if arg == "x":
        x, y, z = x + 1, 0, 0
    elif arg == "y":
        y, z = y + 1, 0
    else:
        z += 1
    new = f"{x}.{y}.{z}"

    total = 0
    for p in PATTERNS:
        text, n = p.subn(rf"\g<1>{new}\g<5>", text)
        total += n
        if n == 0:
            print(f"warning: pattern not found/updated: {p.pattern}")
    INDEX.write_text(text, encoding="utf-8")
    print(f"version: {old} -> {new}  ({total}/3 occurrences updated)")


if __name__ == "__main__":
    main()
