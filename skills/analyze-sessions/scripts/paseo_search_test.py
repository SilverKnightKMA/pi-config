#!/usr/bin/env python3
"""paseo_search_test.py — network-free tests for the analyze-sessions scripts.

Fixture strategy: in-process monkeypatch of S.PASEO_AGENTS_DIR to a tmpdir with
fake agent records + native transcript JSONL, then run the real mains via
redirect_stdout. Case T1 is the regression for the 315b696 indent bug (a match
in the MIDDLE of a file must be found — the bug only ever saw the last line).
Cases T4/T5 assert the CAPPED contract: truncation MUST announce itself; no
announcement = complete output.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import paseo_sessions as S
import paseo_search
import paseo_show
import paseo_prompts

RESULTS = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, cond, detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


def msg(role: str, text: str, ts: int = 1690000000000) -> str:
    return json.dumps({"type": "message", "timestamp": ts,
                       "message": {"role": role, "content": text}})


def make_env(agents: dict[str, list[str]]) -> Path:
    """agents: {agent_id: [jsonl lines]} → returns tmp PASEO_AGENTS_DIR root."""
    root = Path(tempfile.mkdtemp(prefix="paseo-t-"))
    ws = root / "home-coder-workspaces-learn"
    ws.mkdir(parents=True)
    for aid, lines in agents.items():
        tdir = root / "transcripts"
        tdir.mkdir(exist_ok=True)
        tpath = tdir / f"{aid}.jsonl"
        tpath.write_text("\n".join(lines) + "\n", encoding="utf-8")
        rec = {
            "id": aid, "provider": "pi", "cwd": "/home/coder/workspaces/learn",
            "title": "Fixture Agent", "createdAt": "2026-08-30T00:00:00Z",
            "updatedAt": "2026-09-24T00:00:00Z",
            "runtimeInfo": {"sessionId": aid},
            "persistence": {"sessionId": aid, "nativeHandle": str(tpath)},
        }
        (ws / f"{aid}.json").write_text(json.dumps(rec), encoding="utf-8")
    return root


def run_main(mod, argv: list[str]) -> tuple[str, int]:
    old_argv, old_dir = sys.argv, S.PASEO_AGENTS_DIR
    sys.argv = [mod.__file__] + argv
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            rc = mod.main()
    finally:
        sys.argv, S.PASEO_AGENTS_DIR = old_argv, old_dir
    return out.getvalue(), rc


def main() -> int:
    # isolate BOTH data sources: paseo records + pi's global store (om workers
    # leaked real agents into the first test run — load_summaries merges both)
    S.PI_SESSIONS_DIR = Path("/nonexistent-pi-sessions")

    # ---- fixture: 5 messages, NEEDLE only in the MIDDLE (message 3) ----
    lines = [
        msg("user", "hello start"),
        msg("assistant", "mid reply one"),
        msg("user", "please find the ZQXNEEDLE token here"),
        msg("assistant", "answer without token"),
        msg("user", "bye end"),
    ]
    root = make_env({"aaaa1111-2222-3333-4444-555566667777": lines})
    S.PASEO_AGENTS_DIR = root

    # T1 — regression 315b696: match in MIDDLE of file must be found
    out, rc = run_main(paseo_search, ["ZQXNEEDLE"])
    check("T1 mid-file hit found (315b696 regression)", rc == 0 and "ZQXNEEDLE" in out and "1 hit(s)" in out,
          f"rc={rc} out={out[:200]!r}")

    # T2 — No hits path
    out, rc = run_main(paseo_search, ["NOTPRESENTXYZ"])
    check("T2 No hits.", rc == 0 and "No hits." in out)

    # T3 — prompts-only counts only user-role matches
    both = make_env({"bbbb1111-0000-0000-0000-000000000001": [
        msg("user", "token ALPHATOK in user line"),
        msg("assistant", "token ALPHATOK in assistant line"),
    ]})
    S.PASEO_AGENTS_DIR = both
    out, rc = run_main(paseo_search, ["ALPHATOK", "--prompts-only"])
    check("T3 prompts-only role filter (1 of 2)", rc == 0 and "1 hit(s)" in out, f"out={out[:200]!r}")

    # T4 — hit-limit cap announces itself, exit 0
    two = make_env({"cccc1111-0000-0000-0000-000000000001": [
        msg("user", "needle CAPME once"), msg("user", "needle CAPME twice"),
    ]})
    S.PASEO_AGENTS_DIR = two
    out, rc = run_main(paseo_search, ["CAPME", "--limit-hits", "1"])
    check("T4 hit-limit CAPPED notice", rc == 0 and "hit limit 1 reached" in out)

    # T5 — byte cap announces itself, exit 0
    big = make_env({"dddd1111-0000-0000-0000-000000000001": [
        msg("user", "byte needle BYTECAP " + "x" * 4000), msg("user", "byte needle BYTECAP again " + "y" * 4000),
    ]})
    S.PASEO_AGENTS_DIR = big
    out, rc = run_main(paseo_search, ["BYTECAP", "--max-output-bytes", "100"])
    check("T5 byte-cap CAPPED notice, rc 0", rc == 0 and "OUTPUT CAPPED" in out)

    # T6 — override widens: no cap notice, both hits (reset to the 2-hit env)
    S.PASEO_AGENTS_DIR = two
    out, rc = run_main(paseo_search, ["CAPME", "--limit-hits", "10"])
    check("T6 override widens (2 hits, no CAPPED)", rc == 0 and "2 hit(s)" in out
          and "hit limit" not in out and "OUTPUT CAPPED" not in out)

    # T7 — show message cap
    S.PASEO_AGENTS_DIR = two
    out, rc = run_main(paseo_show, ["cccc1111", "--limit", "1"])
    check("T7 show --limit CAPPED notice", rc == 0 and "OUTPUT CAPPED at 1" in out)

    # T8 — prompts caps (per-agent + max-agents)
    many = []
    for i in range(25):
        many.append(msg("user", f"prompt number {i} PROMPTCAP"))
    S.PASEO_AGENTS_DIR = make_env({"eeee1111-0000-0000-0000-000000000001": many})
    out, rc = run_main(paseo_prompts, ["--limit", "3"])
    check("T8 prompts --limit CAPPED notice", rc == 0 and "OUTPUT CAPPED" in out and "truncated at 3" in out)

    # T9 — long prompt truncated to max chars, not dropped (scan_transcript fix)
    S.PASEO_AGENTS_DIR = make_env({"ffff1111-0000-0000-0000-000000000001": [
        msg("user", "L" * 3000),
    ]})
    summ = S.load_summaries(S.Filters(), want_prompts=True, max_prompt_chars=2000)
    ok = bool(summ) and len(summ[0].user_prompts) == 1 and len(summ[0].user_prompts[0]) == 2000
    check("T9 long prompt truncated [:2000] not dropped", ok,
          f"n={len(summ[0].user_prompts) if summ else 0}")

    # T10 — parse-fail NOTE (P3 probe reminder): garbage lines that MATCH the
    # needle but fail json parse (needle-filter runs before parse) trip the NOTE
    noisy = [msg("user", "clean ZQXCLEAN line for NOTE test")]
    noisy += ["{not json but contains ZQXCLEAN here" for _ in range(60)]
    S.PASEO_AGENTS_DIR = make_env({"gggg1111-0000-0000-0000-000000000001": noisy})
    out, rc = run_main(paseo_search, ["ZQXCLEAN"])
    check("T10 parse-fail NOTE reminder", rc == 0 and "NOTE:" in out and "paseo_probe.py" in out
          and "1 hit(s)" in out, f"rc={rc} out={out[:200]!r}")

    failed = [n for n, c, _ in RESULTS if not c]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} pass")
    if failed:
        print("FAILED:", ", ".join(failed))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
