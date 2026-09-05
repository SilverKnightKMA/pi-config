#!/usr/bin/env python3
"""paseo_prompts — dump user prompts from Paseo agents (all providers) for pattern mining.

Same shape as pi analyze-sessions prompts.py: markdown grouped by workspace,
--format jsonl available, prompts above --max-chars dropped (they're almost
always pasted context). Prompts come from the native transcript when the
persistence handle resolves; metadata-only agents fall back to their first
prompt from the title.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import paseo_sessions as S


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--max-chars", type=int, default=2000)
    p.add_argument("--format", choices=["md", "jsonl"], default="md")
    S.add_filter_args(p)
    args = p.parse_args()

    if not args.since and not args.until:
        args.since = "30d"

    summaries = S.load_summaries(S.filters_from_args(args),
                                 want_prompts=True,
                                 max_prompt_chars=args.max_chars)
    if not summaries:
        S.stderr("No agents matched.")
        return 0

    if args.format == "jsonl":
        for s in summaries:
            for pr in s.user_prompts:
                print(json.dumps({
                    "agent": s.agent_id,
                    "provider": s.provider,
                    "workspace": s.workspace,
                    "title": s.title,
                    "prompt": pr,
                }, ensure_ascii=False))
        return 0

    by_ws: dict[str, list] = {}
    for s in summaries:
        by_ws.setdefault(s.workspace, []).append(s)

    for ws in sorted(by_ws):
        print(f"# {ws}\n")
        for s in by_ws[ws]:
            header = f"## {s.agent_id[:8]} · {s.provider} · {s.updated:%Y-%m-%d}"
            if s.title:
                header += f" · {s.title[:60]}"
            print(header + "\n")
            if s.user_prompts:
                for pr in s.user_prompts:
                    print(f"> {pr}\n")
            elif s.first_prompt:
                print(f"> (title only) {s.first_prompt}\n")
            else:
                print("> (no prompts in transcript)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
