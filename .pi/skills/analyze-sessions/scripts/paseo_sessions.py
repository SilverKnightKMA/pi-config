#!/usr/bin/env python3
"""paseo-sessions — query Paseo agent sessions across ALL providers.

Mirrors the pi analyze-sessions skill (same filter vocabulary, same output
style) but reads Paseo's data instead of ~/.pi/agent/sessions:

  agent records : ~/.paseo/agents/<workspace-dir>/<agentId>.json
  transcripts   : provider-native files referenced by persistence.nativeHandle
                  (omp/pi → JSONL session files; claude → ~/.claude/projects;
                  codex/copilot/factory-droid → provider-specific, metadata only)

Because every Paseo agent is a provider session plus metadata, cost rollups
read the native transcript when available and fall back to metadata-only rows
(zero cost) otherwise.

Shared by: paseo_cost.py, paseo_prompts.py, paseo_show.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

PASEO_AGENTS_DIR = Path(os.path.expanduser("~/.paseo/agents"))
CLAUDE_PROJECTS = Path(os.path.expanduser("~/.claude/projects"))
PI_SESSIONS_DIR = Path(os.path.expanduser("~/.pi/agent/sessions"))

# Session kinds surfaced by reports: main agents, subagents spawned via the
# subagent-types extension (label subagent.role), and observational-memory
# worker subprocesses (pi sessions named om-observer-*/om-consolidator-* that
# live under <project>/.memory/<sessionId>/ working directories).
KIND_MAIN = "main"
KIND_SUBAGENT = "subagent"
KIND_OM_OBSERVER = "om-observer"
KIND_OM_CONSOLIDATOR = "om-consolidator"


def stderr(*args) -> None:
    print(*args, file=sys.stderr)


# ---------------------------------------------------------------------------
# Filters (same vocabulary as pi analyze-sessions)
# ---------------------------------------------------------------------------

@dataclass
class Filters:
    since: Optional[str] = None
    until: Optional[str] = None
    provider: Optional[str] = None
    workspace: Optional[str] = None          # substring match on workspace dir
    cwd: Optional[str] = None                # substring match on agent cwd
    session: Optional[str] = None            # agent id prefix
    limit: Optional[int] = None
    include_archived: bool = False

    def matches_time(self, ts: datetime) -> bool:
        if self.since:
            until_ts = parse_date(self.until) if self.until else datetime.now(timezone.utc)
            return parse_date(self.since) <= ts <= until_ts
        if self.until:
            return ts <= parse_date(self.until)
        return True


def add_filter_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--since", help="inclusive lower bound: 7d, 30d, 2026-08-01, ...")
    p.add_argument("--until", help="inclusive upper bound (date)")
    p.add_argument("--provider", help="filter by provider: omp, pi, claude, codex, ...")
    p.add_argument("--workspace", help="substring match on workspace directory name")
    p.add_argument("--cwd", help="substring match on agent cwd")
    p.add_argument("--session", help="agent id (or unique prefix)")
    p.add_argument("--include-archived", action="store_true",
                   help="include archived agents (excluded by default)")


def filters_from_args(args) -> Filters:
    return Filters(
        since=args.since, until=args.until, provider=args.provider,
        workspace=args.workspace, cwd=args.cwd, session=args.session,
        limit=getattr(args, "limit", None), include_archived=args.include_archived,
    )


def parse_date(value: str) -> datetime:
    v = value.strip().lower()
    if v.endswith("d") and v[:-1].isdigit():
        return datetime.now(timezone.utc) - timedelta(days=int(v[:-1]))
    if v.endswith("h") and v[:-1].isdigit():
        return datetime.now(timezone.utc) - timedelta(hours=int(v[:-1]))
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def ts_from_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Agent records
# ---------------------------------------------------------------------------

@dataclass
class AgentSummary:
    agent_id: str
    provider: str
    title: str
    workspace: str
    cwd: str
    created: datetime
    updated: datetime
    archived: bool
    model: str
    transcript: Optional[Path]
    # session kind: main | subagent | om-observer | om-consolidator
    kind: str = KIND_MAIN
    # filled lazily from transcript scan
    cost_usd: float = 0.0
    message_count: int = 0
    user_prompts: list = field(default_factory=list)
    first_prompt: str = ""


def iter_agent_records(filters: Filters) -> Iterator[AgentSummary]:
    if not PASEO_AGENTS_DIR.exists():
        return
    for ws_dir in sorted(PASEO_AGENTS_DIR.iterdir()):
        if not ws_dir.is_dir():
            continue
        if filters.workspace and filters.workspace not in ws_dir.name:
            continue
        for rec_path in sorted(ws_dir.glob("*.json")):
            try:
                d = json.loads(rec_path.read_text())
            except Exception:
                continue
            archived = d.get("archivedAt") is not None
            if archived and not filters.include_archived:
                continue
            provider = d.get("provider") or "unknown"
            if filters.provider and filters.provider != provider:
                continue
            labels = d.get("labels") or {}
            kind = KIND_SUBAGENT if "subagent.role" in labels else KIND_MAIN
            cwd = d.get("cwd") or ""
            if filters.cwd and filters.cwd not in cwd:
                continue
            agent_id = d.get("id") or rec_path.stem
            if filters.session and not agent_id.startswith(filters.session):
                continue
            created = ts_from_iso(d.get("createdAt") or "1970-01-01T00:00:00Z")
            if not filters.matches_time(created):
                continue
            handle = (d.get("persistence") or {}).get("nativeHandle")
            transcript = Path(handle) if handle else None
            if transcript and not transcript.exists():
                transcript = None
            config = d.get("config") or {}
            yield AgentSummary(
                agent_id=agent_id,
                provider=provider,
                title=d.get("title") or "",
                workspace=ws_dir.name,
                cwd=cwd,
                created=created,
                updated=ts_from_iso(d.get("updatedAt") or d.get("createdAt") or "1970-01-01T00:00:00Z"),
                archived=archived,
                model=config.get("model") or (d.get("runtimeInfo") or {}).get("model") or "",
                transcript=transcript,
                kind=kind,
            )

# ---------------------------------------------------------------------------
# Observational-memory worker sessions (pi-native, no Paseo record)
# ---------------------------------------------------------------------------

def _worker_kind(session_name: str) -> Optional[str]:
    """Classify an om worker by its pi session_info name; None if not one."""
    if session_name.startswith("om-observer-"):
        return KIND_OM_OBSERVER
    if session_name.startswith("om-consolidator-"):
        return KIND_OM_CONSOLIDATOR
    return None


def iter_om_worker_records(filters: Filters) -> Iterator[AgentSummary]:
    """Yield om worker sessions from pi's global store.

    Workers are plain `pi -p` runs whose cwd is the parent session's
    `.memory/<sessionId>/` dir, so pi files them under a bucket named
    `<workspace-bucket>.memory-<sessionId>--`. They have no ~/.paseo record;
    the session JSONL is the only source. Session name (om-observer-*/
    om-consolidator-*) distinguishes the role.
    """
    if not PI_SESSIONS_DIR.exists():
        return
    for bucket in sorted(PI_SESSIONS_DIR.iterdir()):
        if not bucket.is_dir() or ".memory-" not in bucket.name:
            continue
        # bucket name: --<flattened-project-cwd>-.memory-<sessionId>--
        ws_part = bucket.name.split(".memory-")[0][2:].rstrip("-")
        if filters.workspace and filters.workspace not in ws_part:
            continue
        for jsonl in sorted(bucket.glob("*.jsonl")):
            session_name = ""
            created: datetime
            try:
                with jsonl.open() as f:
                    for line in f:
                        try:
                            e = json.loads(line)
                        except Exception:
                            continue
                        if e.get("type") == "session_info" and e.get("name"):
                            session_name = e["name"]
                            break
                created = datetime.fromtimestamp(jsonl.stat().st_mtime, tz=timezone.utc)
            except Exception:
                continue
            kind = _worker_kind(session_name)
            if not kind:
                continue
            if not filters.matches_time(created):
                continue
            yield AgentSummary(
                agent_id=jsonl.stem.split("_", 1)[-1],
                provider="pi",
                title=session_name,
                workspace=bucket.name,
                cwd=str(bucket),
                created=created,
                updated=created,
                archived=False,
                model="",
                transcript=jsonl,
                kind=kind,
            )


# ---------------------------------------------------------------------------
# Native transcript scan (omp/pi JSONL)
# ---------------------------------------------------------------------------

def scan_transcript(summary: AgentSummary, want_prompts: bool, max_prompt_chars: int) -> None:
    """Populate cost/message counts/user prompts from the native JSONL file."""
    if not summary.transcript:
        return
    cost = 0.0
    count = 0
    prompts: list[str] = []
    first = ""
    try:
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
                count += 1
                if role == "assistant":
                    usage = (msg.get("usage") or {}).get("cost") or {}
                    cost += usage.get("total") or 0
                elif role == "user" and want_prompts:
                    content = msg.get("content")
                    text = content if isinstance(content, str) else "\n".join(
                        c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text"
                    ).strip()
                    if not text:
                        continue
                    if not first:
                        first = text
                    if len(text) <= max_prompt_chars:
                        prompts.append(text)
    except Exception:
        pass
    summary.cost_usd = cost
    summary.message_count = count
    summary.user_prompts = prompts
    summary.first_prompt = first[:200]


def load_summaries(filters: Filters, want_prompts: bool = False,
                   max_prompt_chars: int = 2000) -> list[AgentSummary]:
    out: list[AgentSummary] = []
    for s in iter_agent_records(filters):
        scan_transcript(s, want_prompts, max_prompt_chars)
        out.append(s)
    for s in iter_om_worker_records(filters):
        scan_transcript(s, want_prompts, max_prompt_chars)
        out.append(s)
    out.sort(key=lambda s: s.updated, reverse=True)
    if filters.limit:
        out = out[:filters.limit]
    return out
