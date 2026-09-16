#!/usr/bin/env python3
"""om_worker_cost — OM-worker cost rebuilt DIRECTLY from worker transcripts.

Replaces the .runs cost-file analysis role (task #32): the native transcripts at
~/.pi/agent/sessions/<ws>-.memory-<parentSid>--/*.jsonl are the SOURCE OF TRUTH;
the .memory/<parentSid>/.runs/<runId>.cost.json files are a durable cache that can
be GC'd once the transcript rebuild is verified equal (5/5 exact match, 2026-09-16).

Probe rule (SKILL.md): transcript shape is probed, not assumed. usage.cost.total
was verified live 2026-09-16; roles classify by first-prompt marker
(consolidator: "You are folding the observations"), everything else = observer.

Stdlib only. Read-only. Modes:
  default        cost per parent bucket, split by role
  --by day|role  regroup (day = transcript filename date)
  --verify       transcript sum vs .runs/*.cost.json sum per bucket (pre-GC gate)
  --gc-plan N    list .runs cost files older than N days + $ the rollup must retain
  --json         machine-readable
  --self-test    synthetic fixtures, no HOME access
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from collections import defaultdict

SESSIONS_DIR = os.path.expanduser("~/.pi/agent/sessions")
WS_ROOT = os.path.expanduser("~/workspaces")
CONS_MARKER = "you are folding the observations"
HEAD_BYTES = 4096


def bucket_parent(name: str) -> str | None:
    """'--ws-.memory-<sid>--' -> '<sid>'."""
    if ".memory-" not in name or not name.startswith("--"):
        return None
    mid = name.split(".memory-", 1)[1]
    return mid[:-2] if mid.endswith("--") else None


def bucket_memory_root(parent: str, cwd: str | None = None) -> str:
    """Find the .memory/<parent> dir: cwd first (self-test fixtures), then every
    workspace under ~/workspaces (learn/.memory/<sid> is the real layout)."""
    if cwd:
        p = os.path.join(cwd, ".memory", parent)
        if os.path.isdir(p):
            return p
    if os.path.isdir(WS_ROOT):
        for ws in sorted(os.listdir(WS_ROOT)):
            p = os.path.join(WS_ROOT, ws, ".memory", parent)
            if os.path.isdir(p):
                return p
    return os.path.join(WS_ROOT, "learn", ".memory", parent)


def classify_role(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(HEAD_BYTES).lower()
        return "consolidator" if CONS_MARKER in head else "observer"
    except OSError:
        return "unknown"


def transcript_cost(path: str) -> float:
    total = 0.0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"usage"' not in line and '"cost"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                u = rec.get("usage") or (rec.get("message") or {}).get("usage")
                if isinstance(u, dict) and isinstance(u.get("cost"), dict):
                    t = u["cost"].get("total")
                    if isinstance(t, (int, float)):
                        total += t
    except OSError:
        pass
    return total


def day_of(path: str) -> str:
    return os.path.basename(path)[:10]


def scan(cwd: str | None = None) -> list[dict]:
    rows: list[dict] = []
    if not os.path.isdir(SESSIONS_DIR):
        return rows
    for name in sorted(os.listdir(SESSIONS_DIR)):
        parent = bucket_parent(name)
        if not parent:
            continue
        bdir = os.path.join(SESSIONS_DIR, name)
        for fn in sorted(os.listdir(bdir)):
            if not fn.endswith(".jsonl"):
                continue
            p = os.path.join(bdir, fn)
            rows.append(
                {
                    "parent": parent,
                    "file": fn,
                    "day": day_of(p),
                    "role": classify_role(p),
                    "usd": transcript_cost(p),
                    "mtime": os.path.getmtime(p) if os.path.exists(p) else 0.0,
                }
            )
    return rows


def runs_cost_files(parent: str, cwd: str | None = None) -> list[str]:
    d = os.path.join(bucket_memory_root(parent, cwd), ".runs")
    if not os.path.isdir(d):
        return []
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".cost.json")]


def group(rows: list[dict], by: str) -> list[dict]:
    if by == "total":
        return [{"key": "total", "usd": round(sum(r["usd"] for r in rows), 6), "runs": len(rows)}]
    g: dict[str, dict] = defaultdict(lambda: {"usd": 0.0, "runs": 0})
    for r in rows:
        k = r.get(by, "?")
        g[k]["usd"] += r["usd"]
        g[k]["runs"] += 1
    return [
        {"key": k, "usd": round(v["usd"], 6), "runs": v["runs"]} for k, v in sorted(g.items())
    ]


def verify(rows: list[dict], cwd: str | None = None) -> list[dict]:
    by_parent: dict[str, float] = defaultdict(float)
    for r in rows:
        by_parent[r["parent"]] += r["usd"]
    out = []
    for parent, tsum in sorted(by_parent.items()):
        rsum = 0.0
        for f in runs_cost_files(parent, cwd):
            try:
                with open(f, encoding="utf-8") as fh:
                    rsum += float(json.load(fh).get("costUsd", 0.0))
            except (OSError, ValueError):
                pass
        diff = abs(tsum - rsum)
        # transcript is the SOURCE OF TRUTH; the .runs cache may be MISSING files
        # (workers crashed before their turn_end wrote cost.json) — that direction is
        # safe for GC. Only a cache that OVERCLAIMS the source is a red flag.
        out.append(
            {
                "parent": parent,
                "transcript_usd": round(tsum, 6),
                "runs_usd": round(rsum, 6),
                "diff": round(diff, 6),
                "verdict": "MISMATCH-cache-overclaims" if rsum > tsum + 0.005 else "SAFE_TO_GC",
            }
        )
    return out


def gc_plan(days: float, cwd: str | None = None) -> list[dict]:
    """.runs cost files older than `days`; their $ must move into a rollup before deletion."""
    cutoff = time.time() - days * 86400
    seen: set[str] = set()
    plan = []
    for name in sorted(os.listdir(SESSIONS_DIR)) if os.path.isdir(SESSIONS_DIR) else []:
        parent = bucket_parent(name)
        if not parent or parent in seen:
            continue
        seen.add(parent)
        old = [f for f in runs_cost_files(parent, cwd) if os.path.getmtime(f) < cutoff]
        keep_usd = drop_usd = 0.0
        for f in runs_cost_files(parent, cwd):
            try:
                with open(f, encoding="utf-8") as fh:
                    c = float(json.load(fh).get("costUsd", 0.0))
            except (OSError, ValueError):
                continue
            if os.path.getmtime(f) < cutoff:
                drop_usd += c
            else:
                keep_usd += c
        plan.append(
            {
                "parent": parent,
                "delete_files": len(old),
                "delete_usd": round(drop_usd, 6),
                "keep_files": len(runs_cost_files(parent, cwd)) - len(old),
                "keep_usd": round(keep_usd, 6),
            }
        )
    return [p for p in plan if p["delete_files"] > 0]


def self_test() -> int:
    ok = 0

    def check(cond: bool, label: str) -> None:
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + label)
        ok += 1 if cond else 0

    with tempfile.TemporaryDirectory() as td:
        b = os.path.join(td, "--ws-.memory-s1--")
        os.makedirs(b)
        obs = os.path.join(b, "2026-09-15T10-00-00Z_a.jsonl")
        cons = os.path.join(b, "2026-09-15T11-00-00Z_b.jsonl")
        with open(obs, "w") as fh:
            fh.write('You are the observer. Watch.\n')
            fh.write(json.dumps({"usage": {"cost": {"total": 0.0011}}}) + "\n")
            fh.write(json.dumps({"message": {"role": "assistant"}, "usage": {"cost": {"total": 0.0009}}}) + "\n")
        with open(cons, "w") as fh:
            fh.write('You are folding the observations below into the durable topic files.\n')
            fh.write(json.dumps({"usage": {"cost": {"total": 0.08}}}) + "\n")
        check(bucket_parent("--ws-.memory-s1--") == "s1", "bucket_parent parses sid")
        check(classify_role(obs) == "observer", "observer classification")
        check(classify_role(cons) == "consolidator", "consolidator classification")
        check(abs(transcript_cost(obs) - 0.002) < 1e-9, "transcript sum incl. message.usage")
        # verify against a fake .runs next to the "memory root" (cwd = td)
        mem = os.path.join(td, ".memory", "s1", ".runs")
        os.makedirs(mem)
        with open(os.path.join(mem, "x.cost.json"), "w") as fh:
            json.dump({"costUsd": 0.0011}, fh)
        with open(os.path.join(mem, "y.cost.json"), "w") as fh:
            json.dump({"costUsd": 0.0809}, fh)
        os.utime(os.path.join(mem, "y.cost.json"), (time.time() - 10 * 86400,) * 2)  # old → gc candidate
        global SESSIONS_DIR
        saved = SESSIONS_DIR
        SESSIONS_DIR = td
        try:
            rows = scan(td)
            check(len(rows) == 2, "scan finds both transcripts")
            v = verify(rows, td)[0]
            check(v["verdict"] == "SAFE_TO_GC", "verify: runs covered by transcript")
            plan = gc_plan(1, td)  # only the 10-day-old file
            check(plan and plan[0]["delete_files"] == 1 and abs(plan[0]["delete_usd"] - 0.0809) < 1e-9, "gc-plan picks only old files")
            by = group(rows, "role")
            roles = {r["key"]: r["usd"] for r in by}
            check(abs(roles.get("observer", 0) - 0.002) < 1e-9 and abs(roles.get("consolidator", 0) - 0.08) < 1e-9, "role grouping")
        finally:
            SESSIONS_DIR = saved
    print(f"self-test: {ok}/8 pass" if ok == 8 else f"self-test FAILED ({ok}/8)")
    return 0 if ok == 8 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--by", choices=["parent", "day", "role", "total"], default="parent")
    ap.add_argument("--verify", action="store_true", help="transcript vs .runs sums (pre-GC gate)")
    ap.add_argument("--gc-plan", type=float, metavar="DAYS", help="list .runs cost files older than DAYS")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    rows = scan()
    if args.verify:
        out = verify(rows)
    elif args.gc_plan is not None:
        out = gc_plan(args.gc_plan)
    else:
        out = group(rows, args.by)
        out.insert(0, {"key": "(total)", "usd": round(sum(r["usd"] for r in rows), 6), "runs": len(rows)})
    if args.json:
        print(json.dumps(out, indent=1))
        return 0
    for row in out:
        print(" | ".join(f"{k}={v}" for k, v in row.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
