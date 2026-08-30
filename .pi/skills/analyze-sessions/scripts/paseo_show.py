#!/usr/bin/env python3
"""paseo_show — render one Paseo agent's transcript (all providers).

Same shape as pi analyze-sessions show_session.py. Requires a transcript-backed
agent (omp/pi); prints the conversation with per-message cost when present.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import paseo_sessions as S


def find_agent(prefix: str):
    filters = S.Filters(session=prefix, include_archived=True)
    matches = list(S.iter_agent_records(filters))
    if not matches:
        raise SystemExit(f"No agent with id prefix {prefix!r}")
    if len(matches) > 1:
        ids = "\n".join(f"  {m.agent_id}" for m in matches[:10])
        raise SystemExit(f"Ambiguous prefix, matches:\n{ids}")
    return matches[0]


def render(summary: S.AgentSummary, max_chars: int) -> None:
    print(f"# {summary.title or summary.agent_id}")
    print(f"agent    : {summary.agent_id}")
    print(f"provider : {summary.provider}  model: {summary.model}")
    print(f"workspace: {summary.workspace}")
    print(f"cwd      : {summary.cwd}")
    print(f"created  : {summary.created:%Y-%m-%d %H:%M}  updated: {summary.updated:%Y-%m-%d %H:%M}")
    print(f"archived : {summary.archived}")
    print()

    if not summary.transcript:
        print("(no native transcript on disk — metadata only)")
        return
    print(f"transcript: {summary.transcript}\n")

    total_cost = 0.0
    with summary.transcript.open() as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "message":
                continue
            msg = e.get("message") or {}
            role = msg.get("role")
            ts = (e.get("timestamp") or 0) / 1000 if isinstance(e.get("timestamp"), int) else None
            ts_str = f" [{ts}]" if ts else ""
            if role == "user":
                content = msg.get("content")
                text = content if isinstance(content, str) else "\n".join(
                    c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text"
                ).strip()
                if text:
                    print(f"--- USER{ts_str} ---")
                    print(text[:max_chars] + ("\n…(truncated)" if len(text) > max_chars else ""))
                    print()
            elif role == "assistant":
                parts = [c.get("text", "") for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
                text = "\n".join(x for x in parts if x).strip()
                usage = (msg.get("usage") or {}).get("cost") or {}
                cost = usage.get("total") or 0
                total_cost += cost
                if text:
                    print(f"--- ASSISTANT{ts_str} (${cost:.4f}) ---")
                    print(text[:max_chars] + ("\n…(truncated)" if len(text) > max_chars else ""))
                    print()
    print(f"\n— transcript cost total: ${total_cost:.4f}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("agent", help="agent id (or unique prefix)")
    p.add_argument("--max-chars", type=int, default=1500)
    args = p.parse_args()
    render(find_agent(args.agent), args.max_chars)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
