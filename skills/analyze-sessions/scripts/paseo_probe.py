#!/usr/bin/env python3
"""paseo_probe.py — introspect the REAL shape of a transcript JSONL at analysis time.

Rule (SKILL.md): pi transcript shape changes across versions. NEVER hand-parse from
memory. Run this probe on the exact file you are about to query, read the field paths
it reports, and build your query from THOSE paths. When pi changes shape, the probe
reports the new shape — nothing here to go stale.

Stdlib only. Read-only.

Usage:
    python3 paseo_probe.py <file.jsonl> [<file2.jsonl> ...] [--sample N]
    python3 paseo_probe.py --self-test

Output per file:
  - record types observed (count)
  - top field paths per type (dot notation, [] marks array elements; depth 3)
  - distribution of message.role values and message.content[].type values
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import tempfile
import os

MAX_PATHS_PER_TYPE = 18
DEFAULT_SAMPLE = 400


def walk(obj, prefix, counter, depth=3):
    """Collect observed field paths from a nested dict/list structure."""
    if depth == 0:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else str(k)
            counter[p] += 1
            if isinstance(v, dict):
                walk(v, p, counter, depth - 1)
            elif isinstance(v, list):
                for el in v[:3]:
                    if isinstance(el, dict):
                        walk(el, p + "[]", counter, depth - 1)
                    elif el is not None:
                        counter[p + "[]"] += 1
                        break


def probe_file(path, sample):
    types = collections.Counter()
    paths = collections.defaultdict(collections.Counter)
    roles = collections.Counter()
    parts = collections.Counter()
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                types["<unparsable>"] += 1
                continue
            if not isinstance(rec, dict):
                types["<non-dict>"] += 1
                continue
            t = str(rec.get("type", "<no-type>"))
            types[t] += 1
            walk(rec, "", paths[t])
            if t == "message":
                m = rec.get("message")
                if isinstance(m, dict):
                    roles[str(m.get("role"))] += 1
                    c = m.get("content")
                    if isinstance(c, list):
                        for p in c:
                            if isinstance(p, dict):
                                parts[str(p.get("type"))] += 1
                            else:
                                parts[f"<{type(p).__name__}>"] += 1
                    elif isinstance(c, str):
                        parts["<plain-string>"] += 1
            n += 1
            if sample and n >= sample:
                break
    return types, paths, roles, parts, n


def report(path, types, paths, roles, parts, n, sample):
    out = [f"# {os.path.basename(path)} — scanned {n} line(s){f' (sample of {sample})' if sample and n >= sample else ''}"]
    out.append("## Record types: " + ", ".join(f"{t}={c}" for t, c in types.most_common()))
    for t, counter in sorted(paths.items()):
        top = counter.most_common(MAX_PATHS_PER_TYPE)
        more = f" (+{len(counter) - len(top)} more)" if len(counter) > len(top) else ""
        out.append(f"## type={t} field paths:{more}")
        for p, c in top:
            out.append(f"  {p}  x{c}")
    if roles:
        out.append("## message.role values: " + ", ".join(f"{r}={c}" for r, c in roles.most_common()))
    if parts:
        out.append("## message.content[].type values: " + ", ".join(f"{p}={c}" for p, c in parts.most_common()))
    return "\n".join(out)


def self_test():
    ok = True

    def check(name, cond):
        nonlocal ok
        print(("PASS" if cond else "FAIL"), name)
        ok = ok and cond

    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        tmp = fh.name
        rows = [
            {"type": "session", "id": "s1", "timestamp": "2026-09-13T00:00:00Z"},
            {"type": "message", "id": "m1", "parentId": "s1", "timestamp": "2026-09-13T00:00:01Z",
             "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
            {"type": "message", "id": "m2", "parentId": "m1",
             "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "..."},
                                                          {"type": "toolCall", "toolCallId": "c1"}]}},
            {"type": "message", "id": "m3", "parentId": "m2",
             "message": {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "ok"}]}},
        ]
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    try:
        types, paths, roles, parts, n = probe_file(tmp, None)
        check("4 lines parsed", n == 4)
        check("type counts", types.get("message") == 3 and types.get("session") == 1)
        check("role path discovered", "message.role" in paths["message"])
        check("role values", roles.get("user") == 1 and roles.get("toolResult") == 1)
        check("content part types", parts.get("toolCall") == 1 and parts.get("text") == 2)
        text = report(tmp, types, paths, roles, parts, n, None)
        check("report shows dot path", "message.role" in text)
        check("report shows [] marker", "message.content[].type" in text)
        # malformed line handling
        with open(tmp, "a") as fh:
            fh.write("not json\n")
        types2, _, _, _, _ = probe_file(tmp, None)
        check("unparsable counted, no crash", types2.get("<unparsable>") == 1)
    finally:
        os.unlink(tmp)
    print("SELF-TEST", "OK" if ok else "FAILED")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="Introspect the real shape of a transcript JSONL before querying it.")
    ap.add_argument("files", nargs="*", help="transcript .jsonl file(s)")
    ap.add_argument("--sample", type=int, default=DEFAULT_SAMPLE, help=f"max lines to scan per file (default {DEFAULT_SAMPLE}; 0 = all)")
    ap.add_argument("--self-test", action="store_true", help="run built-in checks and exit")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not args.files:
        ap.error("provide at least one .jsonl file (or --self-test)")
    rc = 0
    for f in args.files:
        try:
            res = probe_file(f, args.sample or None)
            print(report(f, *res, args.sample or None))
            print()
        except FileNotFoundError:
            print(f"ERROR: no such file: {f}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
