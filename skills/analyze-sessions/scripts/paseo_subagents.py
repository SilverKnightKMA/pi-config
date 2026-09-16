#!/usr/bin/env python3
"""Per-child-run subagent cost (O1, #105).

`paseo_cost.py --by kind` gives one aggregate $ per kind; this script splits
the subagent kind into PER-RUN rows with the parent mapping (labels
`subagent.role` + `subagent.parent`), so "which parent burned money on which
children" is one query. Cost source = the child's own transcript
(nativeHandle JSONL, probed path message.usage.cost.*) — the parent's
usage.cost covers only the parent's own LLM calls, so child transcript sums
are NOT double-counted there.

Double-count guards (both verified clean on 2026-09-16 data; kept as cheap
safety assertions because pi resume can in principle re-link a record):
  * two agent records sharing one persistence.sessionId → count the run ONCE
    (newest activity wins), report "+N dup records skipped"
  * a child record whose nativeHandle is missing → row with $0.00 flagged
    `no-transcript`, never silently dropped

Stdlib only. Read-only. ~100 lines by design — reuse paseo_sessions.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from paseo_sessions import (
    Filters,
    KIND_SUBAGENT,
    add_filter_args,
    filters_from_args,
    iter_agent_records,
    scan_transcript,
)


def collect_runs(filters: Filters):
    """Return (rows, parents, dup_records_skipped). rows sorted by cost desc."""
    parents = {}
    children = []
    for s in iter_agent_records(filters):
        if s.kind == KIND_SUBAGENT:
            children.append(s)
        else:
            parents[s.agent_id] = s.title

    # guard 1: same pi session id under multiple records -> one run
    by_sid = {}
    dup = 0
    for s in children:
        key = s.session_id or s.agent_id
        prev = by_sid.get(key)
        if prev is None:
            by_sid[key] = s
        else:
            dup += 1
            if s.updated > prev.updated:
                by_sid[key] = s  # newest activity represents the run

    rows = []
    for s in by_sid.values():
        cost, msgs, flag = 0.0, 0, ""
        if s.transcript:
            scan_transcript(s, want_prompts=False, max_prompt_chars=0)
            cost, msgs = s.cost_usd, s.message_count
        else:
            flag = "no-transcript"
        role = s.labels.get("subagent.role") or "?"
        parent = s.labels.get("subagent.parent") or s.labels.get("paseo.parent-agent-id") or ""
        rows.append(
            {
                "role": role,
                "parent": parent,
                "parentTitle": parents.get(parent, ""),
                "agent": s.agent_id[:8],
                "title": s.title,
                "cost": cost,
                "messages": msgs,
                "activity": s.updated.isoformat(timespec="minutes"),
                "flag": flag,
            }
        )
    rows.sort(key=lambda r: -r["cost"])
    return rows, parents, dup


def rollup(rows, key):
    agg = {}
    for r in rows:
        k = r[key] or "?"
        a = agg.setdefault(k, {"cost": 0.0, "runs": 0})
        a["cost"] += r["cost"]
        a["runs"] += 1
    return sorted(agg.items(), key=lambda kv: -kv[1]["cost"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_filter_args(ap)
    ap.add_argument("--by", choices=["run", "role", "parent", "total"], default="run")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    filters = filters_from_args(args)

    rows, parents, dup = collect_runs(filters)
    total = sum(r["cost"] for r in rows)

    if args.json:
        print(json.dumps({"runs": rows[: args.limit], "total": total, "dupRecordsSkipped": dup}, indent=2))
        return 0

    print(f"# subagent runs: {len(rows)} | total ${total:.4f} | dup records skipped: {dup}")
    if args.by == "total":
        return 0
    if args.by == "run":
        for r in rows[: args.limit]:
            flag = f" [{r['flag']}]" if r["flag"] else ""
            print(f"  ${r['cost']:8.4f}  {r['role']:<12} {r['agent']}  {r['activity']}{flag}  {r['title'][:56]}")
        return 0
    for k, a in rollup(rows, args.by)[: args.limit]:
        extra = f" ({parents.get(k, '')[:40]})" if args.by == "parent" and k in parents else ""
        print(f"  ${a['cost']:8.4f}  {a['runs']:3d} runs  {k}{extra}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
