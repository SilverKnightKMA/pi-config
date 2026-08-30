#!/usr/bin/env python3
"""paseo_cost — cost rollups across Paseo agents (all providers).

Same shape as pi analyze-sessions cost.py: --by total|day|workspace|provider|model|agent,
--since/--until filters, --json output. Costs come from the native transcript
(omp/pi JSONL) when the persistence handle resolves; agents of providers whose
transcripts live elsewhere (claude/codex/...) contribute rows with unknown cost
so the inventory stays complete.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import paseo_sessions as S


def build_report(summaries, by: str):
    total = sum(s.cost_usd for s in summaries)
    if by == "total":
        return {"by": by, "total_usd": total, "agents": len(summaries)}

    groups: dict[str, dict] = defaultdict(lambda: {"usd": 0.0, "agents": 0, "messages": 0})
    for s in summaries:
        keys = group_keys(s, by)
        for k in keys:
            g = groups[k]
            g["usd"] += s.cost_usd
            g["agents"] += 1
            g["messages"] += s.message_count
    return {
        "by": by,
        "total_usd": total,
        "agents": len(summaries),
        "groups": [
            {"key": k, **v} for k, v in sorted(groups.items(), key=lambda kv: -kv[1]["usd"])
        ],
    }


def group_keys(s: S.AgentSummary, by: str) -> list[str]:
    if by == "day":
        return [s.updated.strftime("%Y-%m-%d")]
    if by == "workspace":
        return [s.workspace]
    if by == "provider":
        return [s.provider]
    if by == "model":
        return [s.model or "(unknown)"]
    if by == "kind":
        return [s.kind]
    if by == "agent":
        return [f"{s.agent_id[:8]} {s.title[:40]}".strip()]
    raise SystemExit(f"unknown --by: {by}")


def print_report(report) -> None:
    print(f"Total: ${report['total_usd']:.4f} across {report['agents']} agents")
    if report["by"] == "total":
        return
    print()
    print(f"{'group':<50} {'usd':>10} {'agents':>7} {'msgs':>8}")
    for g in report["groups"]:
        label = g["key"][:48]
        print(f"{label:<50} {g['usd']:>10.4f} {g['agents']:>7} {g['messages']:>8}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--by", default="day",
                   choices=["total", "day", "workspace", "provider", "model", "kind", "agent"])
    p.add_argument("--limit", type=int, help="cap groups shown")
    p.add_argument("--json", action="store_true")
    S.add_filter_args(p)
    args = p.parse_args()

    if not args.since and not args.until and not args.session:
        args.since = "7d"

    filters = S.filters_from_args(args)
    group_limit = args.limit if args.by != "total" else None
    if args.by != "total":
        filters.limit = None

    summaries = S.load_summaries(filters)
    if not summaries:
        S.stderr("No agents matched.")
        return 0

    report = build_report(summaries, args.by)
    if group_limit:
        report["groups"] = report["groups"][:group_limit]

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
