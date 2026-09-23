#!/usr/bin/env python3
"""adr-check — validate MADR-lite decision records. Stdlib only.

Standard basis (credit):
- MADR 3.0 field set — https://adr.github.io/madr (github.com/adr/madr)
- YAML-frontmatter variant per smadr — github.com/zircote/structured-madr
  (and adrkit.dev/schema); here checked by this SELF-CONTAINED script
  instead of a third-party action, so the repo needs no new deps.

Anti-fabrication boundary: schema checks prove STRUCTURE only. The rule that
stops invented history is the EVIDENCE requirement — every record must cite
at least one resolvable reference (task #NNN | commit sha 7-40 hex | http link).
"""
import re
import sys
from pathlib import Path

DECISIONS = Path(__file__).parent
STATUS_ENUM = {"proposed", "accepted", "rejected", "deprecated"}
FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NAME_RE = re.compile(r"^\d{4}-[a-z0-9][a-z0-9-]*\.md$")
EVIDENCE_RE = re.compile(r"(#\d+|\b[0-9a-f]{7,40}\b|https?://\S+)")
REQUIRED_SECTIONS = ("## Context", "## Decision", "## Consequences", "## Evidence")


def check(path: Path) -> list[str]:
    errs = []
    if path.name == "0000-template.md":
        return errs  # template itself is not a record
    if not NAME_RE.match(path.name):
        errs.append(f"{path.name}: filename must be NNNN-slug.md")
    text = path.read_text(encoding="utf-8")
    m = FM_RE.match(text)
    if not m:
        return errs + [f"{path.name}: missing YAML frontmatter (--- block)"]
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    status = fm.get("status", "")
    if not (status in STATUS_ENUM or status.startswith("superseded")):
        errs.append(f"{path.name}: status '{status}' not in enum "
                    f"{sorted(STATUS_ENUM)} (+'superseded by ...')")
    if not DATE_RE.match(fm.get("date", "")):
        errs.append(f"{path.name}: date '{fm.get('date')}' must be YYYY-MM-DD")
    if not fm.get("deciders"):
        errs.append(f"{path.name}: deciders missing")
    for sec in REQUIRED_SECTIONS:
        if sec not in text:
            errs.append(f"{path.name}: missing section '{sec}'")
    ev_m = re.search(r"## Evidence\s*\n(.*?)(\n## |\Z)", text, re.S)
    if ev_m and not EVIDENCE_RE.search(ev_m.group(1)):
        errs.append(f"{path.name}: Evidence section has NO resolvable ref "
                    "(task #NNN | commit sha | http link) — anti-fabrication rule")
    return errs


def main() -> int:
    records = sorted(DECISIONS.glob("*.md"))
    if len(records) <= 1:  # only the template, or nothing
        print("adr-check: no decision records yet (only template) — OK")
        return 0
    failures = []
    for p in records:
        failures += check(p)
    n_ok = len(records) - 1 - len({e.split(":")[0] for e in failures})
    if failures:
        print("adr-check: FAIL")
        for e in failures:
            print(f"  - {e}")
        return 1
    print(f"adr-check: {len(records) - 1} record(s) OK, structure + evidence-ref valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
