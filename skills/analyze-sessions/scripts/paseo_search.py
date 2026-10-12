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
    p.add_argument("--max-output-bytes", type=int, default=65536,
                   help="total stdout budget (safe default; raise to WIDEN, never to shrink)")
    p.add_argument("--per-agent", type=int, default=10,
                   help="max detail hits printed per agent (safe default; raise to WIDEN)")
    S.add_filter_args(p)
    args = p.parse_args()

    flags = re.IGNORECASE
    pattern = re.compile(re.escape(args.pattern) if args.literal else args.pattern, flags)

    filters = S.filters_from_args(args)
    summaries = S.load_summaries(filters, want_prompts=args.prompts_only)
    if not summaries:
        S.stderr("No agents matched.")
        return 0

    parse_fail = 0  # counted in pass 1 only (pass 2 re-parses the same lines)

    def scan_agent(s, count_fails: bool = True):
        """Stream (role, text) matches for one agent — shared by both passes.
        Constant memory: line-by-line (2026-09-24 #286: read_text().splitlines()
        OOM-killed on the 533MB main-session transcript)."""
        nonlocal parse_fail
        try:
            fh = s.transcript.open(encoding="utf-8", errors="replace")
        except Exception:
            return
        with fh:
            for line in fh:
                if not pattern.search(line):
                    continue
                # Skip the raw-JSON noise: only count hits inside message text values
                try:
                    entry = json.loads(line)
                except Exception:
                    if count_fails:
                        parse_fail += 1
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
                if pattern.search(text):
                    yield role, text

    # ---- pass 1: count hits per agent (2026-10-12 #331 summary-first) ----
    # A chatty agent (e.g. a 689MB main transcript) can eat the whole
    # --limit-hits budget — or the caller's own `head` pipe can cut the tail —
    # hiding every OTHER matching agent (the sec-lab workspace was missed this
    # way). The bounded MATCHED header prints BEFORE details, so no downstream
    # truncation can ever hide which agents matched.
    COUNT_CAP = 9999
    counts: dict = {}
    meta: dict = {}
    for s in summaries:
        if not s.transcript:
            continue
        n = 0
        for _ in scan_agent(s):
            n += 1
            if n >= COUNT_CAP:
                break
        if n:
            counts[s.agent_id[:8]] = n
            meta[s.agent_id[:8]] = (s.provider, (s.title or "untitled")[:40])

    if not counts:
        print("No hits.")
        if parse_fail > 50:
            print(f"NOTE: {parse_fail} lines failed json parse — transcript shape may have changed; run paseo_probe.py before trusting coverage")
        return 0

    total_hits = sum(counts.values())
    print(f"MATCHED {len(counts)} agent(s), {total_hits} hit(s):")
    for k, n in sorted(counts.items(), key=lambda kv: -kv[1])[:10]:
        prov, title = meta[k]
        print(f"  {k} · {prov} · {title} · {n} hits")
    if len(counts) > 10:
        print(f"  +{len(counts) - 10} more agents — narrow with --workspace/--session or raise --limit-hits")

    # ---- pass 2: details (per-agent cap: one agent cannot monopolize) ----
    hits = 0
    printed = 0
    per_agent = max(1, args.per_agent)
    capped_noted: set = set()

    def outp(s: str = "") -> None:
        nonlocal printed
        print(s)
        printed += len(s) + 1

    for s in summaries:
        key = s.agent_id[:8]
        if not s.transcript or key not in counts:
            continue
        shown_for_agent = 0
        for role, text in scan_agent(s, count_fails=False):
            if shown_for_agent >= per_agent:
                if key not in capped_noted:
                    capped_noted.add(key)
                    outp(f"  (per-agent cap {per_agent} reached — raise --per-agent)")
                continue
            if shown_for_agent == 0:
                outp(f"\n=== {key} · {s.provider} · {s.title[:50]} ===")
            shown_for_agent += 1
            hits += 1
            if hits > args.limit_hits:
                outp(f"\n(hit limit {args.limit_hits} reached — raise --limit-hits)")
                return 0
            if printed > args.max_output_bytes:
                outp(f"\nOUTPUT CAPPED at ~{args.max_output_bytes // 1024}KB — raise with --max-output-bytes or narrow filters")
                return 0

            # Show the matching message text with limited context
            text_lines = text.split("\n")
            for li, tl in enumerate(text_lines):
                if pattern.search(tl):
                    lo = max(0, li - args.context)
                    hi = min(len(text_lines), li + args.context + 1)
                    outp(f"  [{role}] (line {li + 1}):")
                    for cl in text_lines[lo:hi]:
                        outp(f"    | {cl[:160]}")
                    break

    print(f"\n— {total_hits} hit(s) across {len(counts)} agents")
    if parse_fail > 50:
        print(f"NOTE: {parse_fail} lines failed json parse — transcript shape may have changed; run paseo_probe.py before trusting coverage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
