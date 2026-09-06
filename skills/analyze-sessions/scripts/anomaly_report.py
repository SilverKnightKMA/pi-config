#!/usr/bin/env python3
"""anomaly_report.py — deterministic anomaly analysis over local agent data.

Sources (all optional; missing sources are reported, never fatal):
  ~/.pi/agent/sessions/*/*.jsonl      pi session transcripts (stopReason, usage, cost)
  ~/.pi/agent/sse-probe.jsonl         provider SSE stream-drop events
  ~/.pi/agent/zombie-watchdog.jsonl   stuck/zombie agent detections
  <workspaces>/*/.memory/*/.runs/*.cost.json   OM worker-run costs

Doctrine (enforced in code, not prose):
  - deterministic only: no model calls, no LLM judgment
  - unknown stays unknown: < MIN_BASELINE points -> counts only, no flags
  - rates need Wilson support AND a minimum denominator, else raw counts
  - MAD == 0 is an explicit branch, never an epsilon division
  - the evaluated point never sits in its own baseline (self-masking)
  - seasonal baseline = same hour on prior days (no rolling windows on raw signal)
  - adjacent flagged buckets merge into one episode
  - every metric carries the action it triggers (no action -> it should not exist)
  - attribution localizes to an edge (provider<->agent etc.), never convicts

Usage:
  python3 anomaly_report.py                 # markdown report, last 7 days
  python3 anomaly_report.py --days 30
  python3 anomaly_report.py --json          # machine-readable findings
  python3 anomaly_report.py --record        # append act-now findings to the notebook
  python3 anomaly_report.py --self-test     # assert pure stats functions
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path(os.environ.get("PI_HOME", os.path.expanduser("~")))
AGENT = HOME / ".pi" / "agent"
SESSIONS = AGENT / "sessions"
SSE_PROBE = AGENT / "sse-probe.jsonl"
ZW = AGENT / "zombie-watchdog.jsonl"
NOTEBOOK = AGENT / "anomaly-notebook.md"

# Search roots for .memory worker-run costs (workspaces live side by side).
WORKSPACE_ROOTS = [HOME / "workspaces"]

MIN_BASELINE = 5          # fewer baseline points -> counts only, no flags
MIN_DENOMINATOR = 10      # below this, never report a rate, only counts
Z_THRESHOLD = 3.0         # robust z flag threshold
COST_FLOOR_USD = 1.0      # below this a cost outlier cannot matter to a human
ACT_NOW_MAX_AGE_DAYS = 2  # older findings degrade to trend (nothing to act on in the past)
WILSON_Z = 1.96           # 95% score interval
FRESHNESS_DAYS = 7        # a source older than this is "silent"
JOIN_WINDOW_MIN = 5       # SSE-drop <-> session-abort join window (minutes)

# metric -> the one action it triggers. A metric with no action is ceremony.
ACTIONS = {
    "abort-rate": "check provider relay health; switch provider if sustained",
    "sse-drop": "correlate with relay logs; route around the failing provider",
    "cost-session": "inspect the session for rework loops before spending more",
    "completion-tokens": "inspect for runaway generation in that session",
    "empty-stop-turn": "open the session at that turn; silent failures hide there",
    "volume-drop": "check whether agents/workers stopped being spawned",
    "zombie-rate": "kill or restart the stuck agent; check its last tool call",
    "worker-cost": "inspect OM worker spawning for that workspace",
    "source-stale": "check whether the producer crashed (monitor-of-monitors)",
    "sse-abort-join": "confirm relay kills reach user-visible turns; plan mitigation",
    "zw-silence": "check the watchdog is alive; a dead watchdog sees no zombies",
}


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def short_ws(name: str) -> str:
    """Human-readable workspace: strip the --home-coder-workspaces- wrapper."""
    n = name.strip("-")
    for pre in ("home/coder/workspaces/", "home-coder-workspaces-"):
        if n.startswith(pre):
            n = n[len(pre):]
            break
    return n or name


def hour_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H")


def day_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- statistics


def median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def mad(xs: list[float]) -> float:
    if not xs:
        return 0.0
    m = median(xs)
    return median([abs(x - m) for x in xs])


def robust_z(baseline: list[float], x: float) -> float | None:
    """MAD-scaled robust z. MAD==0 is a branch: x==median -> 0.0, else large.

    Returns None when the baseline is too small to mean anything.
    """
    if len(baseline) < MIN_BASELINE:
        return None
    m = median(baseline)
    d = mad(baseline)
    if d == 0:
        return 0.0 if x == m else 99.0
    return 0.6745 * (x - m) / d


def wilson_interval(k: int, n: int) -> tuple[float, float]:
    """Wilson score interval for a binomial rate. n<=0 -> (0,1) = no knowledge."""
    if n <= 0:
        return 0.0, 1.0
    p = k / n
    denom = 1 + WILSON_Z * WILSON_Z / n
    center = (p + WILSON_Z * WILSON_Z / (2 * n)) / denom
    half = WILSON_Z * math.sqrt(p * (1 - p) / n + WILSON_Z * WILSON_Z / (4 * n * n)) / denom
    return max(0.0, center - half), min(1.0, center + half)


def merge_episodes(buckets: list[tuple[str, float]]) -> list[tuple[str, str, float]]:
    """Merge chronologically adjacent flagged hour buckets into episodes.

    buckets: sorted [(hourKey, score)] -> [(startHour, endHour, peakScore)]
    """
    out: list[tuple[str, str, float]] = []
    for key, score in sorted(buckets):
        if out:
            start, end, peak = out[-1]
            prev = parse_ts(end + ":00:00+00:00") if len(end) == 13 else parse_ts(end)
            cur = parse_ts(key + ":00:00+00:00") if len(key) == 13 else parse_ts(key)
            if (cur - prev) <= timedelta(hours=1):
                out[-1] = (start, key, max(peak, score))
                continue
        out.append((key, key, score))
    return out


# ----------------------------------------------------------------- collectors


def collect_sessions(days: int) -> list[dict]:
    """One record per assistant message end across all pi session files."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out: list[dict] = []
    if not SESSIONS.is_dir():
        return out
    for wsdir in SESSIONS.iterdir():
        if not wsdir.is_dir():
            continue
        for f in wsdir.glob("*.jsonl"):
            sid = f.stem.split("_", 1)[-1]
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if '"stopReason"' not in line and '"usage"' not in line:
                            continue
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if rec.get("type") != "message":
                            continue
                        m = rec.get("message", {})
                        if m.get("role") != "assistant":
                            continue
                        ts = rec.get("timestamp")
                        if not ts:
                            continue
                        dt = parse_ts(ts)
                        if dt < cutoff:
                            continue
                        usage = m.get("usage") or {}
                        cost = usage.get("cost") or {}
                        if isinstance(cost, dict):
                            cost_usd = float(cost.get("total") or 0)
                        else:
                            cost_usd = float(cost or usage.get("costUsd") or 0)
                        content = m.get("content")
                        text_len = 0
                        n_toolcalls = 0
                        if isinstance(content, list):
                            for part in content:
                                if part.get("type") == "text":
                                    text_len += len(part.get("text") or "")
                                elif part.get("type") == "toolCall":
                                    n_toolcalls += 1
                        out.append(
                            {
                                "ts": dt,
                                "sessionId": sid,
                                "workspace": wsdir.name,
                                "provider": m.get("provider") or "unknown",
                                "model": m.get("model") or "unknown",
                                "stopReason": m.get("stopReason") or "",
                                "costUsd": cost_usd,
                                "inTok": int(usage.get("input") or 0),
                                "outTok": int(usage.get("output") or 0),
                                "textLen": text_len,
                                "nToolCalls": n_toolcalls,
                            }
                        )
            except OSError:
                continue
    out.sort(key=lambda r: r["ts"])
    return out


def collect_jsonl(path: Path) -> list[dict]:
    out: list[dict] = []
    if not path.is_file():
        return out
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    rec["_ts"] = parse_ts(rec.get("ts", "")) if rec.get("ts") else None
                    out.append(rec)
                except (json.JSONDecodeError, ValueError):
                    continue
    except OSError:
        pass
    return out


def collect_worker_runs(days: int) -> list[dict]:
    """Per-run cost records, keyed by (workspace, session, day) from mtimes."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out: list[dict] = []
    for root in WORKSPACE_ROOTS:
        if not root.is_dir():
            continue
        for cost in root.glob("*/.memory/*/.runs/*.cost.json"):
            try:
                mtime = datetime.fromtimestamp(cost.stat().st_mtime, timezone.utc)
                if mtime < cutoff:
                    continue
                data = json.loads(cost.read_text(encoding="utf-8"))
                parts = cost.parts
                out.append(
                    {
                        "ts": mtime,
                        "workspace": parts[-5] if len(parts) >= 5 else "?",
                        "sessionId": parts[-3] if len(parts) >= 3 else "?",
                        "costUsd": float(data.get("costUsd", 0)),
                    }
                )
            except (OSError, json.JSONDecodeError, ValueError):
                continue
    out.sort(key=lambda r: r["ts"])
    return out


def source_freshness(now: datetime) -> list[dict]:
    rows = []
    for name, path, producer in [
        ("sessions", SESSIONS, "pi session processes"),
        ("sse-probe", SSE_PROBE, "sse-probe extension"),
        ("zombie-watchdog", ZW, "zombie-watchdog extension"),
    ]:
        if name == "sessions":
            files = list(SESSIONS.rglob("*.jsonl")) if SESSIONS.is_dir() else []
            latest = max((f.stat().st_mtime for f in files), default=None)
        else:
            latest = path.stat().st_mtime if path.is_file() else None
        if latest is None:
            rows.append({"source": name, "state": "missing", "ageDays": None, "producer": producer})
            continue
        age = (now - datetime.fromtimestamp(latest, timezone.utc)).total_seconds() / 86400
        rows.append(
            {
                "source": name,
                "state": "stale" if age > FRESHNESS_DAYS else "fresh",
                "ageDays": round(age, 2),
                "producer": producer,
            }
        )
    return rows


# ------------------------------------------------------------------ detectors


def finding(sev: str, metric: str, scope: str, detail: str, evidence: str, score: float = 0.0) -> dict:
    return {
        "severity": sev,  # "act-now" | "trend" | "info"
        "metric": metric,
        "action": ACTIONS.get(metric, "none"),
        "scope": scope,
        "detail": detail,
        "evidence": evidence,
        "score": round(score, 2),
    }


def detect_stopreason_anomalies(recs: list[dict]) -> list[dict]:
    """Rate of abnormal stopReasons (not stop/toolUse) per provider per day.

    Flag only when Wilson intervals separate AND the denominator is honest.
    """
    abn = defaultdict(int)
    tot = defaultdict(int)
    for r in recs:
        k = (day_key(r["ts"]), r["provider"])
        tot[k] += 1
        if r["stopReason"] not in ("stop", "toolUse"):
            abn[k] += 1
    keys = sorted(tot)
    out: list[dict] = []
    # baseline = same provider, prior days within window
    for k in keys:
        day, provider = k
        n, a = tot[k], abn[k]
        prior_n = [tot[(d, p)] for d, p in keys if p == provider and (d, p) != k]
        prior_a = [abn[(d, p)] for d, p in keys if p == provider and (d, p) != k]
        if n < MIN_DENOMINATOR:
            if a:
                out.append(finding("info", "abort-rate", provider,
                                   f"{a} abnormal-stop turns on {day} (n={n} < {MIN_DENOMINATOR}: counts only, no rate)",
                                   "insufficient denominator -> unknown stays unknown"))
            continue
        if len(prior_n) < MIN_BASELINE:
            continue
        lo_now, hi_now = wilson_interval(a, n)
        pooled_k = sum(prior_a)
        pooled_n = sum(prior_n)
        lo_base, hi_base = wilson_interval(pooled_k, pooled_n)
        if lo_now > hi_base and (a / n) > (pooled_k / pooled_n):
            sev = "act-now" if (datetime.now(timezone.utc) - parse_ts(day + "T00:00:00+00:00")).days <= ACT_NOW_MAX_AGE_DAYS else "trend"
            out.append(finding(sev, "abort-rate", provider,
                               f"{a}/{n} abnormal-stop rate {a/n:.0%} on {day} vs baseline {pooled_k/pooled_n:.0%} "
                               f"(Wilson {lo_now:.0%}-{hi_now:.0%} vs {lo_base:.0%}-{hi_base:.0%})",
                               f"stopReason != stop/toolUse; sessions/*/  {day}"))
    return out


def detect_empty_stop_turns(recs: list[dict]) -> list[dict]:
    """E35 silent-failure class: stopReason 'stop' with zero text AND zero tool calls."""
    hits = defaultdict(list)
    for r in recs:
        if r["stopReason"] == "stop" and r["textLen"] == 0 and r["nToolCalls"] == 0:
            hits[(r["workspace"], day_key(r["ts"]))].append(r)
    out = []
    for (ws, day), rows in sorted(hits.items()):
        out.append(finding("trend", "empty-stop-turn", f"{ws} {day}",
                           f"{len(rows)} silent empty stop-turn(s) (no text, no tool call)",
                           f"session {rows[0]['sessionId']} at {rows[0]['ts'].strftime('%H:%M')}Z"))
    return out


def detect_cost_outliers(recs: list[dict]) -> list[dict]:
    """Session cost as log robust z vs same-model sessions (evaluated session excluded)."""
    by_session: dict[str, dict] = {}
    for r in recs:
        s = by_session.setdefault(r["sessionId"], {"cost": 0.0, "model": r["model"], "ws": r["workspace"], "last": r["ts"]})
        s["cost"] += r["costUsd"]
    out = []
    for sid, s in by_session.items():
        peers = [v["cost"] for k, v in by_session.items() if k != sid and v["model"] == s["model"] and v["cost"] > 0]
        if s["cost"] <= 0 or s["cost"] < COST_FLOOR_USD:
            continue  # sub-floor costs cannot matter; flagging them is noise
        z = robust_z([math.log(c) for c in peers], math.log(s["cost"]))
        if z is not None and z > Z_THRESHOLD:
            out.append(finding("trend", "cost-session", f"{short_ws(s['ws'])} {sid[:8]}",
                               f"${s['cost']:.2f} vs median ${math.exp(median([math.log(c) for c in peers])):.2f} for {s['model']}",
                               f"robust z={z:.1f}", score=z))
    out.sort(key=lambda f: -f["score"])
    return out[:10]


def detect_completion_token_outliers(recs: list[dict]) -> list[dict]:
    per_turn = defaultdict(list)
    for r in recs:
        if r["outTok"] > 0:
            per_turn[r["model"]].append(r["outTok"])
    med = {m: median([math.log(t) for t in v]) for m, v in per_turn.items() if len(v) >= MIN_BASELINE}
    out = []
    seen = set()
    for r in recs:
        if r["model"] not in med or r["outTok"] <= 0:
            continue
        z = robust_z([math.log(t) for t in per_turn[r["model"]] if t != r["outTok"]], math.log(r["outTok"]))
        if z is not None and z > Z_THRESHOLD and r["sessionId"] not in seen:
            seen.add(r["sessionId"])
            out.append(finding("trend", "completion-tokens", f"{r['sessionId'][:8]} {r['model']}",
                               f"{r['outTok']} output tokens in one turn", f"robust z={z:.1f}", score=z))
    out.sort(key=lambda f: -f["score"])
    return out[:5]


def detect_volume_drop(recs: list[dict]) -> list[dict]:
    """Sessions per day vs prior days (same window). Drop = collective anomaly."""
    per_day: dict[str, set] = defaultdict(set)
    for r in recs:
        per_day[day_key(r["ts"])].add(r["sessionId"])
    days = sorted(per_day)
    out = []
    for d in days:
        prior = [len(per_day[p]) for p in days if p < d]
        z = robust_z([float(x) for x in prior], float(len(per_day[d])))
        if z is not None and z < -Z_THRESHOLD:
            out.append(finding("trend", "volume-drop", d,
                               f"{len(per_day[d])} sessions vs median {median([float(x) for x in prior]):.0f} of prior days",
                               f"robust z={z:.1f}"))
    return out


def detect_sse_drops(sse: list[dict], recs: list[dict]) -> list[dict]:
    """SSE drops per provider per hour vs same-provider other hours + abort join."""
    out: list[dict] = []
    if not sse:
        return out
    per_provider_hour: dict[tuple, int] = defaultdict(int)
    for e in sse:
        if e.get("_ts"):
            per_provider_hour[(e.get("provider", "?"), hour_key(e["_ts"]))] += 1
    flagged_by_provider: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for (provider, hk), count in per_provider_hour.items():
        prior = [float(c) for (p, h), c in per_provider_hour.items() if p == provider and h != hk]
        z = robust_z(prior, float(count))
        if z is not None and z > Z_THRESHOLD:
            flagged_by_provider[provider].append((hk, z))
    for provider, flagged in flagged_by_provider.items():
        for start, end, peak in merge_episodes(flagged):
            sev = "act-now" if (datetime.now(timezone.utc) - parse_ts(start[:10] + "T00:00:00+00:00")).days <= ACT_NOW_MAX_AGE_DAYS else "trend"
            out.append(finding(sev, "sse-drop", f"provider {provider} {start}..{end}",
                               "SSE-drop cluster", f"peak robust z={peak:.1f}", score=peak))
    # join: drops that landed inside a session abort window
    aborts = [r["ts"] for r in recs if r["stopReason"] in ("aborted", "error")]
    joined = 0
    for e in sse:
        t = e.get("_ts")
        if not t:
            continue
        if any(abs((a - t).total_seconds()) <= JOIN_WINDOW_MIN * 60 for a in aborts):
            joined += 1
    if joined:
        out.append(finding("act-now" if joined >= 3 else "trend", "sse-abort-join",
                           f"{joined}/{len(sse)} drops within +/-{JOIN_WINDOW_MIN}min of a session abort",
                           "cause->symptom propagation confirmed",
                           "sse-probe.jsonl x sessions/*"))
    return out


def detect_zombie(zw: list[dict]) -> list[dict]:
    out: list[dict] = []
    if not zw:
        return out
    per_day: dict[str, int] = defaultdict(int)
    for e in zw:
        if e.get("_ts"):
            per_day[day_key(e["_ts"])] += 1
    days = sorted(per_day)
    for d in days:
        prior = [float(per_day[p]) for p in days if p < d]
        z = robust_z(prior, float(per_day[d]))
        if z is not None and z > Z_THRESHOLD:
            out.append(finding("trend", "zombie-rate", d,
                               f"{per_day[d]} zombie detections vs median {median(prior):.0f}",
                               f"robust z={z:.1f}", score=z))
    return out


def detect_worker_cost(runs: list[dict]) -> list[dict]:
    per_day_ws: dict[tuple, float] = defaultdict(float)
    for r in runs:
        per_day_ws[(day_key(r["ts"]), r["workspace"])] += r["costUsd"]
    out = []
    for (day, ws), cost in per_day_ws.items():
        prior = [v for (d, w), v in per_day_ws.items() if w == ws and d != day]
        if cost <= 0:
            continue
        z = robust_z([math.log(v) for v in prior if v > 0], math.log(cost))
        if z is not None and z > Z_THRESHOLD:
            out.append(finding("trend", "worker-cost", f"{ws} {day}",
                               f"${cost:.2f} OM worker spend vs prior median", f"robust z={z:.1f}", score=z))
    return out


def detect_silence(fresh: list[dict]) -> list[dict]:
    out = []
    for row in fresh:
        if row["state"] == "stale":
            out.append(finding("act-now", "source-stale", row["source"],
                               f"no data for {row['ageDays']} days (>{FRESHNESS_DAYS})",
                               f"producer: {row['producer']}"))
        elif row["state"] == "missing":
            out.append(finding("trend", "source-stale", row["source"],
                               "source absent (may simply have no events yet)",
                               f"producer: {row['producer']}"))
    return out


def detect_zw_silence(zw: list[dict]) -> list[dict]:
    if not zw:
        return []
    gaps = []
    ts = sorted(e["_ts"] for e in zw if e.get("_ts"))
    for a, b in zip(ts, ts[1:]):
        gaps.append((b - a).total_seconds() / 86400)
    if not ts:
        return []
    last = ts[-1]
    now = datetime.now(timezone.utc)
    silence = (now - last).total_seconds() / 86400
    if len(gaps) >= MIN_BASELINE and silence > max(3 * median(gaps), FRESHNESS_DAYS):
        return [finding("trend", "zw-silence", "zombie-watchdog",
                        f"silent {silence:.1f} days vs median inter-event gap {median(gaps):.1f}",
                        "a watchdog that stopped writing sees no zombies")]
    return []


# --------------------------------------------------------------------- output


def render_markdown(findings: list[dict], fresh: list[dict], stats: dict) -> str:
    lines: list[str] = []
    lines.append("# Anomaly report")
    lines.append("")
    lines.append(f"window: {stats['days']}d · sessions: {stats['sessions']} · assistant turns: {stats['turns']} "
                 f"· sse events: {stats['sse']} · zw events: {stats['zw']} · worker runs: {stats['runs']}")
    lines.append("")
    for name, state, age in [(f["source"], f["state"], f["ageDays"]) for f in fresh]:
        lines.append(f"- source {name}: {state}" + (f" ({age}d)" if age is not None else ""))
    lines.append("")
    act = [f for f in findings if f["severity"] == "act-now"]
    trend = [f for f in findings if f["severity"] == "trend"]
    info = [f for f in findings if f["severity"] == "info"]
    if not findings:
        lines.append("No anomalies flagged. (Absence of findings is not proof of health — see footer.)")
        lines.append("")
    for title, group in (("Act now", act), ("Trend notes", trend), ("Raw counts (insufficient baseline)", info)):
        if not group:
            continue
        lines.append(f"## {title}")
        lines.append("")
        for f in group:
            lines.append(f"- **[{f['metric']}]** {f['scope']} — {f['detail']}")
            lines.append(f"  - action: {f['action']} · evidence: {f['evidence']}")
        lines.append("")
    lines.append("## Known unknowns")
    lines.append("")
    lines.append("- Output-quality anomalies have no ground-truth signal here; only ops symptoms are measured.")
    lines.append("- Attribution localizes to an edge (provider↔agent, worker↔orchestrator); fault-side requires human confirmation, then record with --record.")
    lines.append("- Level shifts (a provider permanently getting worse) are absorbed by these baselines; compare fixed windows manually if suspected.")
    lines.append("")
    return "\n".join(lines)


def record_notebook(findings: list[dict], path: Path) -> int:
    """Append act-now findings as unconfirmed notebook lines (deduped per day)."""
    today = day_key(datetime.now(timezone.utc))
    existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    written = 0
    with open(path, "a", encoding="utf-8") as fh:
        for f in findings:
            if f["severity"] != "act-now":
                continue
            key = f"{today} [{f['metric']}] {f['scope']}"
            if key in existing:
                continue
            fh.write(f"- {today} [{f['metric']}] {f['scope']} UNCONFIRMED — {f['detail']} · evidence: {f['evidence']}\n")
            written += 1
    return written


# ------------------------------------------------------------------ self-test


def self_test() -> int:
    assert median([1, 2, 3, 4, 5]) == 3
    assert median([1, 2]) == 1.5
    assert mad([1, 1, 1, 1]) == 0
    z = robust_z([1, 1, 1, 1, 1], 1)
    assert z == 0.0, "MAD=0 with x==median must be 0"
    z = robust_z([1, 1, 1, 1, 1], 5)
    assert z == 99.0, "MAD=0 with x!=median must flag"
    assert robust_z([1, 2], 3) is None, "tiny baselines must abstain"
    lo, hi = wilson_interval(0, 10)
    assert lo == 0.0 and hi > 0, "Wilson upper bound must be positive at k=0"
    lo, hi = wilson_interval(10, 10)
    assert hi == 1.0 and lo < 1, "Wilson lower bound must be below 1 at k=n"
    lo1, _ = wilson_interval(9, 10)
    assert lo1 > 0.5
    eps = merge_episodes([("2026-09-05T10", 3.1), ("2026-09-05T11", 4.0), ("2026-09-05T14", 2.0)])
    assert len(eps) == 2 and eps[0][0] == "2026-09-05T10" and eps[0][1] == "2026-09-05T11" and eps[0][2] == 4.0
    print("self-test: all assertions passed")
    return 0


# ----------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--record", action="store_true", help="append act-now findings to the ops notebook")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    now = datetime.now(timezone.utc)
    recs = collect_sessions(args.days)
    sse = collect_jsonl(SSE_PROBE)
    zw = collect_jsonl(ZW)
    runs = collect_worker_runs(args.days)
    fresh = source_freshness(now)

    findings: list[dict] = []
    findings += detect_silence(fresh)
    findings += detect_stopreason_anomalies(recs)
    findings += detect_empty_stop_turns(recs)
    findings += detect_cost_outliers(recs)
    findings += detect_completion_token_outliers(recs)
    findings += detect_volume_drop(recs)
    findings += detect_sse_drops(sse, recs)
    findings += detect_zombie(zw)
    findings += detect_zw_silence(zw)
    findings += detect_worker_cost(runs)

    order = {"act-now": 0, "trend": 1, "info": 2}
    findings.sort(key=lambda f: (order[f["severity"]], -f["score"]))

    stats = {
        "days": args.days,
        "sessions": len({r["sessionId"] for r in recs}),
        "turns": len(recs),
        "sse": len(sse),
        "zw": len(zw),
        "runs": len(runs),
    }

    if args.json:
        print(json.dumps({"stats": stats, "freshness": fresh, "findings": findings}, indent=1, default=str))
    else:
        print(render_markdown(findings, fresh, stats))

    if args.record:
        n = record_notebook(findings, NOTEBOOK)
        print(f"notebook: {n} new line(s) -> {NOTEBOOK}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
