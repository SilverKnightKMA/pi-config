#!/usr/bin/env python3
"""crawl_test.py — unit tests for the P1 sanity-floor logic (#293).

Network-free: feeds check_floors() synthetic result dicts.
Run: python3 crawl_test.py  (exit 0 = pass, prints PASS/FAIL per case)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from crawl import check_floors, FLOORS  # noqa: E402


def case(name, got, want_fail):
    errs = check_floors(got)
    failed = bool(errs)
    ok = failed == want_fail
    print(f"{'PASS' if ok else 'FAIL'}: {name} -> {errs or 'no errors'}")
    return ok


ok = True
# red: every source below its floor must produce exactly one error
ok &= case("all sources empty (the 2026-09-23 silent bug)",
           {s: {"count": 0} for s in FLOORS}, want_fail=True)
ok &= case("pidev 500 < floor 1000", {"pidev": {"count": 500}}, want_fail=True)
ok &= case("cafe 10 < floor 50", {"cafe": {"count": 10}}, want_fail=True)
ok &= case("gh source 0 < floor 1", {"gh-amos": {"count": 0}}, want_fail=True)
# green: counts at/above floor pass
ok &= case("all sources at today's real counts (gh 6/23, cafe 106, pidev 5248)",
           {"gh-amos": {"count": 6}, "gh-pify": {"count": 23},
            "cafe": {"count": 106}, "pidev": {"count": 5248}}, want_fail=False)
# green: sources not requested are not judged
ok &= case("only cafe requested and healthy", {"cafe": {"count": 106}}, want_fail=False)
# edge: missing 'count' key treated as 0 -> fails floor
ok &= case("malformed result (no count) fails", {"cafe": {}}, want_fail=True)

print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
