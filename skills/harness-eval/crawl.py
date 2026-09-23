#!/usr/bin/env python3
"""harness-eval crawler (#281) — one tool, four approved sources, zero deps.

Sources (user-approved 2026-09-24; search stays manual):
  gh-amos   GitHub user  amosblomqvist — ALL repos        (REST API, paginated)
  gh-pify   GitHub org   pifydev       — ALL repos        (REST API, paginated)
  pidev     pi.dev/packages registry — enumerated via its OWN documented discovery
            mechanism: npm keyword `pi-package` (public npm + keyword + conventional
            dirs / pi manifest = eligible for the gallery; pi.dev has no JSON API,
            /packages.json is 404, so the npm registry IS the machine interface —
            10.5k keyword hits vs the ~5.7k curated gallery view; every hit keeps
            full npm metadata). Paginated -/v1/search 250/page.
  cafe      paseo.cafe registry        — first-class JSON API /api/plugins

Output: ~/workspaces/learn/harness-eval-cache/<src>-<YYYYMMDD>.json per source
        + catalog.md merged summary. Cached per day; --force re-crawls.
        GITHUB_TOKEN env (optional) lifts the 60 req/h anonymous limit.
Usage:  python3 crawl.py [--force] [src ...]   (default: all four)
"""
import json, os, re, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

CACHE = Path.home() / "workspaces" / "learn" / "harness-eval-cache"
UA = {"User-Agent": "harness-eval-crawler/1.0 (+pi-config skill)"}
TODAY = datetime.now(timezone.utc).strftime("%Y%m%d")


def fetch(url: str, as_text: bool = True, retries: int = 3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read()
            return data.decode("utf-8", "replace") if as_text else data
        except Exception as e:  # noqa: BLE001 — network best-effort with retry
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"fetch failed after {retries}: {url}: {last}")


def fetch_json(url: str):
    return json.loads(fetch(url))


# ── P1 sanity floors (#293, user-approved 2026-09-24): a source returning
# far fewer items than its floor is a CRAWL BUG (seen 2026-09-23: pidev regex
# bug returned 0 items and still exited 0). Exit 1 loudly instead.
FLOORS = {"gh-amos": 1, "gh-pify": 1, "cafe": 50, "pidev": 1000}


def check_floors(results: dict) -> list[str]:
    errors = []
    for src, floor in FLOORS.items():
        if src in results:
            n = results[src].get("count", 0) or 0
            if n < floor:
                errors.append(f"source '{src}' returned {n} items — below sanity "
                              f"floor {floor}; likely a crawl bug, NOT a quiet ok")
    return errors


# ── GitHub: user + org, ALL repos ────────────────────────────────────────────
# ── P4 supply-chain pre-filter (user-approved 2026-09-24): 2 cheap existence ─
# checks from OpenSSF Scorecard's derivable set (source: github.com/ossf/scorecard
# checks.md; only SECURITY.md + dependabot.yml are checkable without deep API).
# PRE-FILTER, not a security certificate.
def check_supply_chain(full_name: str) -> dict:
    def exists(path: str) -> bool:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{full_name}/contents/{path}",
            headers={**UA, **({"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"}
                             if os.environ.get("GITHUB_TOKEN") else {}),
                     "Accept": "application/vnd.github+json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status == 200
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            raise
    return {"securityMd": exists("SECURITY.md"), "dependabot": exists(".github/dependabot.yml")}


def crawl_github(kind: str, name: str) -> dict:
    out, page = [], 1
    while True:
        url = (f"https://api.github.com/{kind}/{name}/repos?per_page=100&page={page}"
               "&type=owner&sort=pushed")
        req = urllib.request.Request(url, headers={
            **UA,
            **({"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"} if os.environ.get("GITHUB_TOKEN") else {}),
            "Accept": "application/vnd.github+json",
        })
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                batch = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                raise RuntimeError(
                    f"GitHub API {e.code} (rate limit?) crawling {kind}/{name} — "
                    "set GITHUB_TOKEN to lift the 60 req/h anonymous cap") from e
            raise
        if not batch:
            break
        for it in batch:
            out.append({
                "name": it.get("name"),
                "repo": it.get("full_name"),
                "desc": it.get("description"),
                "stars": it.get("stargazers_count"),
                "language": it.get("language"),
                "license": (it.get("license") or {}).get("spdx_id"),
                "archived": it.get("archived"),
                "pushed_at": it.get("pushed_at"),
                "fork": it.get("fork"),
                "url": it.get("html_url"),
            })
        if len(batch) < 100:
            break
        page += 1
        time.sleep(0.4)
    # supply-chain checks: token-gated (anon 60 req/h would be exhausted by 2×N calls)
    sc_ok = bool(os.environ.get("GITHUB_TOKEN"))
    for it in out:
        if sc_ok:
            try:
                it["supplyChain"] = check_supply_chain(it["full_name"])
            except Exception as e:  # rate-limit/transient: never kill the crawl
                it["supplyChain"] = {"error": str(e)[:80]}
        else:
            it["supplyChain"] = {"skipped": "set GITHUB_TOKEN to enable"}
    return {"source": f"github:{name}", "kind": kind, "count": len(out), "repos": out,
            "supplyChainNote": "P4 pre-filter: SECURITY.md + dependabot.yml existence only "
                               "(OpenSSF Scorecard derivable subset) — not a security certificate"}


# ── pi.dev/packages — via npm keyword `pi-package` (its discovery mechanism) ─
def crawl_pidev() -> dict:
    seen: dict[str, dict] = {}
    total, frm = None, 0
    while True:
        d = fetch_json("https://registry.npmjs.org/-/v1/search"
                       f"?text=keywords:pi-package&size=250&from={frm}")
        total = d.get("total", total)
        objs = d.get("objects", [])
        if not objs:
            break
        for o in objs:
            p = o.get("package", {})
            name = p.get("name")
            if not name:
                continue
            links = p.get("links") or {}
            repo = p.get("repository", {}).get("url") if isinstance(p.get("repository"), dict) else p.get("repository")
            score = o.get("score") or {}
            detail = score.get("detail") or {}
            seen[name] = {
                "name": name,
                "version": p.get("version"),
                "desc": p.get("description"),
                "keywords": p.get("keywords", []),
                "repo": repo or links.get("repository"),
                "npm": links.get("npm", f"https://www.npmjs.com/package/{name}"),
                "publisher": (p.get("publisher") or {}).get("username"),
                "date": p.get("date"),
                "score": {"final": score.get("final"), **{k: detail.get(k) for k in ("popularity", "quality", "maintenance")}},
            }
        frm += 250
        if frm >= (total or 0):
            break
        time.sleep(0.35)
    pkgs = sorted(seen.values(), key=lambda p: -(p["score"].get("popularity") or 0))
    return {"source": "pi.dev/packages (via npm keyword pi-package)", "count": len(seen),
            "npm_keyword_total": total, "gallery_note": "pi.dev gallery curates a subset "
            "(~5.7k) of these — packages with valid pi resources; the npm enumeration is "
            "the superset", "packages": pkgs}


# ── paseo.cafe — first-class JSON API ────────────────────────────────────────
def crawl_cafe() -> dict:
    d = fetch_json("https://paseo.cafe/api/plugins")
    keep = []
    for p in d.get("plugins", []):
        keep.append({
            "name": p.get("name") or p.get("id"),
            "repo": p.get("repo"),
            "desc": p.get("description"),
            "categories": p.get("categories"),
            "license": p.get("license"),
            "npm_version": ((p.get("npm") or {}).get("version")),
            "downloads_30d": ((p.get("npm") or {}).get("downloadsLast30Days")),
            "stars": ((p.get("repoMeta") or {}).get("stars")),
            "pushed_at": ((p.get("repoMeta") or {}).get("pushedAt")),
            "security": ((p.get("security") or {}).get("status"),
                         (p.get("security") or {}).get("blockingFindings")),
            "health": p.get("health"),
            "url": p.get("url"),
        })
    return {"source": "paseo.cafe", "count": d.get("count"), "generated_at": d.get("generatedAt"),
            "plugins": keep}


# ── run/cache/merge ──────────────────────────────────────────────────────────
def main() -> int:
    # --supply-chain OWNER/REPO — on-demand pre-filter for an EVAL shortlist candidate
    if "--supply-chain" in sys.argv:
        target = sys.argv[sys.argv.index("--supply-chain") + 1]
        print(json.dumps({"repo": target, **check_supply_chain(target),
                          "note": "pre-filter only, not a security certificate"}))
        return 0
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv
    sources = {
        "gh-amos": lambda: crawl_github("users", "amosblomqvist"),
        "gh-pify": lambda: crawl_github("orgs", "pifydev"),
        "pidev": crawl_pidev,
        "cafe": crawl_cafe,
    }
    todo = args or list(sources)
    CACHE.mkdir(parents=True, exist_ok=True)
    results, skipped = {}, []
    for src in todo:
        if src not in sources:
            print(f"unknown source: {src} (known: {', '.join(sources)})")
            return 2
        out = CACHE / f"{src}-{TODAY}.json"
        if out.exists() and not force:
            results[src] = json.loads(out.read_text())
            skipped.append(src)
            continue
        print(f"crawling {src} ...", flush=True)
        results[src] = sources[src]()
        out.write_text(json.dumps(results[src], ensure_ascii=False, indent=1))
        print(f"  -> {out.name} ({results[src]['count']} items)")

    errs = check_floors(results)
    if errs:  # P1 #293: silent-empty source must FAIL, not exit 0
        for e in errs:
            print(f"CRAWL-FLOOR-FAIL: {e}", file=sys.stderr)
        return 1

    md = [f"# harness-eval crawled catalog — {TODAY}", ""]
    for src in ("gh-amos", "gh-pify"):
        if src in results:
            r = results[src]
            md += [f"## {r['source']} — {r['count']} repos", "",
                   "| repo | ★ | lang | license | pushed | sc(SEC/dep) | desc |",
                   "|---|---|---|---|---|---|---|"]
            for x in sorted(r["repos"], key=lambda x: -(x["stars"] or 0)):
                sc = x.get("supplyChain") or {}
                scs = ("y" if sc.get("securityMd") else "n") if "securityMd" in sc else "?"
                scd = ("y" if sc.get("dependabot") else "n") if "dependabot" in sc else "?"
                md.append(f"| [{x['repo']}]({x['url']}) | {x['stars']} | {x['language']} | "
                          f"{x['license']} | {(x['pushed_at'] or '')[:10]} | {scs}/{scd} | "
                          f"{(x['desc'] or '')[:75]} |")
            md.append("")
    if "pidev" in results:
        r = results["pidev"]
        md += [f"## pi.dev/packages (npm keyword `pi-package`) — {r['count']} packages "
               f"(npm total {r.get('npm_keyword_total')}; gallery curates ~5.7k)", "",
               "| package | v | publisher | date | popularity | desc |", "|---|---|---|---|---|---|"]
        for p in r["packages"][:200]:  # top 200 in the summary; full list in JSON
            md.append(f"| {p['name']} | {p['version']} | {p['publisher']} | {(p['date'] or '')[:10]} | "
                      f"{p['score'].get('popularity')} | {(p['desc'] or '')[:70]} |")
        if r["count"] > 200:
            md.append(f"| … {r['count'] - 200} more in pidev-{TODAY}.json | | | | |")
        md.append("")
    if "cafe" in results:
        r = results["cafe"]
        md += [f"## paseo.cafe — {r['count']} plugins", "",
               "| plugin | ★ | dl/30d | security | tests | categories | desc |", "|---|---|---|---|---|---|---|"]
        for p in sorted(r["plugins"], key=lambda x: -(x["stars"] or 0)):
            sec, blk = p["security"] or ("?", "?")
            h = p.get("health") or {}
            md.append(f"| [{p['name']}]({p['url']}) | {p['stars']} | {p['downloads_30d']} | "
                      f"{sec}(blk:{blk}) | {'✓' if h.get('hasTests') else '✗'} | "
                      f"{','.join((p['categories'] or [])[:3])} | {(p['desc'] or '')[:60]} |")
        md.append("")
    (CACHE / "catalog.md").write_text("\n".join(md))
    print(f"merged summary -> {CACHE / 'catalog.md'}"
          + (f" (cache-hit: {', '.join(skipped)})" if skipped else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
