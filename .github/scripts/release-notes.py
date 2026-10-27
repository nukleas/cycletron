#!/usr/bin/env python3
"""Print one release's notes from CHANGELOG.md, without its heading.

    release-notes.py <version> [--footer FILE]

Exits non-zero when the changelog has no `## <version>` section, or the
section is empty, so a release can't go out without notes.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def section(text: str, version: str) -> str | None:
    heading = re.compile(r"^## " + re.escape(version) + r"(?: \(.*\))?\s*$", re.M)
    m = heading.search(text)
    if not m:
        return None
    rest = text[m.end():]
    nxt = re.search(r"^## ", rest, re.M)
    return (rest[: nxt.start()] if nxt else rest).strip()


def main() -> None:
    args = sys.argv[1:]
    footer = None
    if "--footer" in args:
        i = args.index("--footer")
        footer = Path(args[i + 1]).read_text().strip()
        del args[i : i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    version = args[0].removeprefix("v")
    notes = section((ROOT / "CHANGELOG.md").read_text(), version)
    if not notes:
        sys.exit(
            f"::error::CHANGELOG.md has no notes under '## {version}'. "
            "Cut releases with scripts/cut-release.sh (docs/RELEASE.md)."
        )
    print(notes + ("\n\n" + footer if footer else ""))


if __name__ == "__main__":
    main()
