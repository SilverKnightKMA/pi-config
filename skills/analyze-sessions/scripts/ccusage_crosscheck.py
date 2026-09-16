#!/usr/bin/env python3
"""O5 (#105): cross-check pi transcript usage against ccusage (v20+, native
`ccusage pi` reader — installed as an external CLI tool, no code port).

Method: ccusage `pi session --json` and this script both read the SAME
~/.pi/agent/sessions JSONL files; per session we diff:
  * token totals  input/output/cacheRead/cacheWrite — MUST match exactly
    (same fields, same files; a mismatch = a parser bug on one side)
  * cost          pi usage.cost.total (provider-reported per call) vs
    ccusage totalCost (LiteLLM price table) — expected to DIVERGE in general;
    for pi model ids ccusage honors the provider-reported cost, observed
    ratio 1.00x on 2026-09-16. We report the ratio, not a failure.

Verdict: PASS when every compared session matches tokens exactly.
Usage:
  python3 scripts/ccusage_crosscheck.py                 # 25 newest sessions
  python3 scripts/ccusage_crosscheck.py --limit 100
  python3 scripts/ccusage_crosscheck.py --session <sessionId-prefix>
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

PI_SESSIONS = Path(os.path.expanduser("~/.pi/agent/sessions"))


def scan_file(path: Path):
    """Sum pi-native usage fields from one transcript (probe-verified paths)."""
    acc = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0, "assistant": 0}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            msg = rec.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            u = msg.get("usage") or {}
            acc["input"] += u.get("input") or 0
            acc["output"] += u.get("output") or 0
            acc["cacheRead"] += u.get("cacheRead") or 0
            acc["cacheWrite"] += u.get("cacheWrite") or 0
            acc["cost"] += ((u.get("cost") or {}).get("total")) or 0.0
            acc["assistant"] += 1
    return acc


def ccusage_sessions():
    out = subprocess.run(
        ["ccusage", "pi", "session", "--json", "--offline"],
        capture_output=True, text=True, timeout=300,
    )
    if out.returncode != 0:
        sys.stderr.write(out.stderr[:500])
        sys.exit(2)
    return {s["sessionId"]: s for s in json.loads(out.stdout).get("sessions", [])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--session", help="sessionId prefix (single-session check)")
    args = ap.parse_args()

    files = sorted(PI_SESSIONS.glob("*/*.jsonl"), key=os.path.getmtime, reverse=True)
    if args.session:
        files = [f for f in files if args.session in f.name]
    files = files[: args.limit]

    cc = ccusage_sessions()
    print(f"# cross-check {len(files)} pi sessions vs ccusage (tokens must match; $ uses different price tables)")
    ok = compared = 0
    cost_pi = cost_cc = 0.0
    for f in files:
        sid = f.name.rsplit("_", 1)[-1].removesuffix(".jsonl")
        row = cc.get(sid)
        mine = scan_file(f)
        if row is None:
            print(f"  {sid[:8]}  NOT IN CCUSAGE  (assistant msgs: {mine['assistant']})")
            continue
        compared += 1
        tok_ok = (
            row["inputTokens"] == mine["input"]
            and row["outputTokens"] == mine["output"]
            and row["cacheReadTokens"] == mine["cacheRead"]
            and row["cacheCreationTokens"] == mine["cacheWrite"]
        )
        ok += tok_ok
        cost_pi += mine["cost"]
        cost_cc += row["totalCost"]
        if not tok_ok:
            print(
                f"  {sid[:8]}  TOKEN MISMATCH "
                f"cc=({row['inputTokens']}/{row['outputTokens']}/{row['cacheReadTokens']}/{row['cacheCreationTokens']}) "
                f"mine=({mine['input']}/{mine['output']}/{mine['cacheRead']}/{mine['cacheWrite']})"
            )
    ratio = (cost_cc / cost_pi) if cost_pi else 0.0
    print(f"# token-exact: {ok}/{compared}")
    print(f"# cost: pi(provider-reported) ${cost_pi:.4f}  ccusage(LiteLLM) ${cost_cc:.4f}  ratio {ratio:.2f}x")
    print("# verdict:", "PASS" if compared and ok == compared else "INVESTIGATE")
    return 0 if compared and ok == compared else 1


if __name__ == "__main__":
    raise SystemExit(main())
