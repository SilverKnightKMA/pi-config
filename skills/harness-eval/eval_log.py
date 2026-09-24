#!/usr/bin/env python3
"""eval_log.py — durable timeline for eval/teach/port events (user 2026-09-24).

WHY: reconstructing "when did we eval X and what came of it" from session
transcripts needs analyze-sessions over 500MB+ files. The eval process logs
its own events instead: one JSONL line per event, tiny, greppable, honest.

Contract:
- append  — one event; validates kind + target; ts = now UTC (or --ts for
            backfill, which also stamps backfill:true so history is never
            mistaken for live capture).
- query   — bounded filter (--kind/--target/--since/--last); prints a table.
- The JSONL is append-only; edits mean fabrication — add a correcting event
  (kind=note) instead of rewriting history.

Timeline file: pi-config/docs/eval-timeline.jsonl (repo-tracked, next to
ext-eval-index.md which stays the human-curated INDEX; this is the LEDGER).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

TIMELINE = Path(__file__).resolve().parent.parent.parent / "docs" / "eval-timeline.jsonl"

KINDS = (
    "landscape",    # Mode 1 scan of a family
    "deep-eval",    # Mode 2 one candidate
    "self-eval",    # Mode 2 'với chính nó'
    "sync-upstream",  # Mode 3 drift check
    "teach",        # teaching session (quiz-verified)
    "port",         # shipped a port/borrow piece
    "decision",     # user verdict on an eval outcome
    "note",         # correction / annotation
)

QUERY_ROW_CAP = 50
COMPACT_AFTER_DAYS = 180  # growth policy (user 2026-09-24)
ARCHIVE_NAME = "eval-timeline.archive.jsonl"
PERMANENT_KINDS = {"port", "decision"}  # never compacted — the permanent record


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(raw: str) -> str:
    # accept YYYY-MM-DD or full ISO
    try:
        if len(raw) == 10:
            dt.datetime.strptime(raw, "%Y-%m-%d")
        else:
            dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SystemExit(f"--ts must be YYYY-MM-DD or ISO datetime: {raw!r} ({exc})")
    return raw


def cmd_append(args: argparse.Namespace) -> int:
    if args.kind not in KINDS:
        raise SystemExit(f"--kind must be one of: {', '.join(KINDS)}")
    if not args.target.strip():
        raise SystemExit("--target is required (e.g. 'extensions/task', '@pify/swarm', 'skill:harness-eval')")
    event = {
        "ts": args.ts or now_iso(),
        "kind": args.kind,
        "target": args.target.strip(),
    }
    if args.ts:
        event["backfill"] = True
    for key in ("verdict", "report", "commit", "task", "note"):
        val = getattr(args, key)
        if val:
            event[key] = val
    TIMELINE.parent.mkdir(parents=True, exist_ok=True)
    with TIMELINE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    print(f"appended: {event['ts']} {event['kind']} {event['target']}")
    return 0


def load_events() -> list[dict]:
    if not TIMELINE.exists():
        return []
    out = []
    with TIMELINE.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def cmd_query(args: argparse.Namespace) -> int:
    events = load_events()
    if args.kind:
        events = [e for e in events if e.get("kind") == args.kind or e.get("kind_orig") == args.kind]
    if args.target:
        needle = args.target.lower()
        events = [e for e in events if needle in str(e.get("target", "")).lower()]
    if args.since:
        events = [e for e in events if str(e.get("ts", "")) >= args.since]
    events.sort(key=lambda e: str(e.get("ts", "")))
    shown = events[-args.last:]
    for e in shown:
        tail = " ".join(
            f"{k}={e[k]}" for k in ("verdict", "task", "commit", "report", "note") if k in e
        )
        bf = " [backfill]" if e.get("backfill") else ""
        print(f"{e.get('ts', '?')}{bf}  {e.get('kind', '?'):13} {e.get('target', '?')}  {tail}")
    total = len(events)
    print(f"— {len(shown)} of {total} event(s)"
          + (f" (OUTPUT CAPPED at {QUERY_ROW_CAP} — raise with --last)" if total > QUERY_ROW_CAP else ""))
    return 0


def cmd_compact(args: argparse.Namespace) -> int:
    """Roll old detail events into one summary line per (kind,target).

    port/decision stay verbatim in the live file; everything older than the
    cutoff is summarized and MOVED to the archive (moved, never deleted).
    """
    events = load_events()
    cutoff = (
        dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    keep: list[dict] = []
    rolled: list[dict] = []
    for e in events:
        if e.get("kind") in PERMANENT_KINDS or str(e.get("ts", "")) >= cutoff:
            keep.append(e)
        else:
            rolled.append(e)
    if not rolled:
        print(f"compact: nothing older than {args.days}d — live file unchanged ({len(events)} events)")
        return 0
    # one summary line per (kind, target)
    buckets: dict[tuple[str, str], list[dict]] = {}
    for e in rolled:
        buckets.setdefault((str(e.get("kind", "?")), str(e.get("target", "?"))), []).append(e)
    summaries = []
    for (kind, target), items in sorted(buckets.items()):
        first = min(str(e.get("ts", "")) for e in items)
        last = max(str(e.get("ts", "")) for e in items)
        summaries.append({
            "ts": now_iso(),
            "kind": "note",
            "kind_orig": kind,  # query --kind still finds compacted history
            "target": target,
            "note": f"compact: {len(items)} {kind} event(s) {first}..{last} rolled into archive",
            "compacted": {"kind": kind, "count": len(items), "first": first, "last": last},
        })
    archive = TIMELINE.parent / ARCHIVE_NAME
    with archive.open("a", encoding="utf-8") as fh:
        for e in rolled:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    with TIMELINE.open("w", encoding="utf-8") as fh:
        for e in keep + summaries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"compact: {len(rolled)} event(s) -> {archive.name}; {len(summaries)} summary line(s); live file now {len(keep) + len(summaries)}")
    return 0


def self_test() -> int:
    assert set(KINDS) == {
        "landscape", "deep-eval", "self-eval", "sync-upstream", "teach", "port", "decision", "note",
    }, "kind vocabulary drifted"
    ev = {"ts": "2026-09-24", "kind": "port", "target": "x", "backfill": True}
    assert json.loads(json.dumps(ev)) == ev
    assert PERMANENT_KINDS <= set(KINDS), "permanent kinds must be valid kinds"
    print("self-test: 3/3 ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("append", help="log one eval/teach/port event")
    a.add_argument("--kind", required=True, choices=KINDS)
    a.add_argument("--target", required=True)
    a.add_argument("--verdict")
    a.add_argument("--report", help="path or URL of the full report")
    a.add_argument("--commit")
    a.add_argument("--task", help="board task id, e.g. #302")
    a.add_argument("--note")
    a.add_argument("--ts", type=parse_ts, help="backfill timestamp (day precision OK)")
    a.set_defaults(fn=cmd_append)

    q = sub.add_parser("query", help="bounded timeline query")
    q.add_argument("--kind", choices=KINDS)
    q.add_argument("--target", help="substring match")
    q.add_argument("--since", help="YYYY-MM-DD")
    q.add_argument("--last", type=int, default=QUERY_ROW_CAP)
    q.set_defaults(fn=cmd_query)

    st = sub.add_parser("self-test")
    st.set_defaults(fn=lambda _a: self_test())

    c = sub.add_parser("compact", help="roll old detail events into summaries (growth policy)")
    c.add_argument("--days", type=int, default=COMPACT_AFTER_DAYS)
    c.set_defaults(fn=cmd_compact)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
