#!/usr/bin/env python3
"""paseo_search — regex search across ALL Paseo agent transcripts.

Same shape as pi analyze-sessions search.py, but walks every Paseo agent's
native transcript (via persistence handles under ~/.paseo/agents), so one
query reaches omp + pi + any other transcript-backed provider at once.

The typical workflow (as demonstrated in the author's video): mine your own
past prompts for recurring behavioral instructions — then turn the winners
into snippets.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import paseo_sessions as S


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("pattern", help="regex to search for (case-insensitive)")
    p.add_argument("--context", type=int, default=2, help="context lines around each hit")
    p.add_argument("--literal", action="store_true", help="treat pattern as a literal string")
    p.add_argument("--prompts-only", action="store_true",
                   help="search user prompts only (not assistant output)")
    p.add_argument("--limit-hits", type=int, default=50, help="max total hits printed")
    S.add_filter_args(p)
    args = p.parse_args()

    flags = re.IGNORECASE
    pattern = re.compile(re.escape(args.pattern) if args.literal else args.pattern, flags)

    filters = S.filters_from_args(args)
    summaries = S.load_summaries(filters, want_prompts=args.prompts_only)
    if not summaries:
        S.stderr("No agents matched.")
        return 0

    hits = 0
    for s in summaries:
        if not s.transcript:
            continue
        shown_for_agent = 0
        try:
            lines = s.transcript.read_text(errors="replace").splitlines()
        except Exception:
            continue
        for i, line in enumerate(lines):
            m = pattern.search(line)
            if not m:
                continue
            # Skip the raw-JSON noise: only count hits inside message text values
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("type") != "message":
                continue
            msg = entry.get("message") or {}
            role = msg.get("role")
            if args.prompts_only and role != "user":
                continue
            content = msg.get("content")
            text = content if isinstance(content, str) else "\n".join(
                c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text"
            )
            if not pattern.search(text):
                continue

            if shown_for_agent == 0:
                print(f"\n=== {s.agent_id[:8]} · {s.provider} · {s.title[:50]} ===")
            shown_for_agent += 1
            hits += 1
            if hits > args.limit_hits:
                print(f"\n(hit limit {args.limit_hits} reached — raise --limit-hits)")
                return 0

            # Show the matching message text with limited context
            text_lines = text.split("\n")
            for li, tl in enumerate(text_lines):
                if pattern.search(tl):
                    lo = max(0, li - args.context)
                    hi = min(len(text_lines), li + args.context + 1)
                    print(f"  [{role}] (line {li + 1}):")
                    for cl in text_lines[lo:hi]:
                        print(f"    | {cl[:160]}")
                    break

    if hits == 0:
        print("No hits.")
    else:
        print(f"\n— {hits} hit(s) across {len(summaries)} agents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
