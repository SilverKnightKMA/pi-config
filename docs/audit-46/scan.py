#!/usr/bin/env python3
"""Audit #46 step 1 — static environment-assumption scan over pi-config extensions + paseo-plugins.
Outputs: findings JSON (raw), counts per (unit,group), coverage report to stdout."""
import json, os, re, sys

PI_EXT = os.path.expanduser("~/workspaces/pi-config/extensions")
PLUGINS = os.path.expanduser("~/workspaces/paseo-plugins")
PLUGIN_DIRS = ["agent-health","lessons","memory","om-panel","om-status","paseo-subagents","plan","snip","subagent-reply","task"]

EXCLUDE_DIRS = {"node_modules",".git","dist","coverage",".memory"}
SKIP_FILES = {"package-lock.json","pnpm-lock.yaml","yarn.lock"}

# Pattern groups: name -> (regex, classification default, platforms affected, note)
GROUPS = [
    ("homedir-api",    r"os\.homedir\(|from ['\"]os['\"]",                     "portable",  "",            "os.homedir() adapts to any user home"),
    ("env-HOME",       r"process\.env\.HOME",                                  "adapt",     "win",         "HOME unset on Windows; use os.homedir()"),
    ("hardcoded-home", r"/home/coder",                                         "broken",    "any",         "literal /home/coder path"),
    ("tilde-literal",  r"~\/\.p[ia]|'~'|\"~\"",                                "check",     "any",         "literal ~ passed to fs = no expansion"),
    ("dotpi-path",     r"\.pi/agent|\.paseo|\.pi['\"/]|'\.pi'|\"\.pi\"",       "portable*", "any",         "home-anchored dot-paths (portable IF via homedir)"),
    ("fs-watch",       r"fs\.watch\(|watchFile\(",                             "portable*", "win,mac",     "watch backend differs per OS; recursive flag support varies"),
    ("unix-socket",    r"net\.createServer|createConnection|\.sock\b|unix:",   "adapt",     "win",         "AF_UNIX socket"),
    ("symlink",        r"symlink|readlink|lstat\(",                            "portable*", "win",         "symlink on Windows needs privilege/dev-mode"),
    ("chmod",          r"chmod|0o600|0o700|0o755",                             "portable*", "win",         "POSIX perms partially no-op on Windows"),
    ("procfs",         r"/proc/",                                              "broken",    "win,mac",     "procfs is Linux-only"),
    ("inotify",        r"inotify",                                             "note",      "",            "inotify references (docs/config)"),
    ("fwdslash-build", r"\$\{[a-zA-Z_][a-zA-Z0-9_.\[\]']*[^}]*\}/[a-zA-Z_.{]", "adapt",     "win",         "template-literal path built with '/' separator"),
    ("line-ending",    r"split\('\\n'\)|split\(\"\\\\n\"\)|join\('\\n'\)",     "portable*", "win",         "LF line-ending assumption (CRLF files break parse)"),
    ("eol-crlf",       r"os\.EOL|\\r\\n|CRLF",                                 "note",      "win",         "EOL/CRLF handling"),
    ("container-only", r"gosu|docker ",                                        "note",      "bare,win",   "container tooling assumption"),
    ("signals",        r"process\.kill|SIGTERM|SIGKILL|SIGUSR|setsid|nohup",   "adapt",     "win",         "POSIX signals limited on Windows"),
    ("child-spawn",    r"spawn\(|spawnSync|execFile|child_process",            "portable*", "win",         "child process spawn (check shell paths)"),
    ("unix-ids",       r"getuid|setuid|getgid",                                "broken",    "win",         "POSIX uid/gid"),
]

def iter_ts_files(root, unit, subdirs=None):
    base = os.path.join(root, unit) if unit else root
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES: continue
            if fn.endswith((".ts",".tsx",".js",".mjs",".py",".json")) and not fn.endswith(".test-bundle.js"):
                yield os.path.join(dirpath, fn)

def unit_of(path, root):
    rel = os.path.relpath(path, root)
    return rel.split(os.sep)[0]

def main():
    units = []  # (repo, unit)
    for d in sorted(os.listdir(PI_EXT)):
        if os.path.isdir(os.path.join(PI_EXT,d)) and d not in EXCLUDE_DIRS:
            units.append(("pi-config", d))
    for d in PLUGIN_DIRS:
        units.append(("paseo-plugins", d))

    compiled = [(n, re.compile(rx), cls, plat, note) for (n,rx,cls,plat,note) in GROUPS]
    findings = []
    for repo, unit in units:
        root = PI_EXT if repo=="pi-config" else PLUGINS
        for path in iter_ts_files(root, unit):
            try: text = open(path, encoding="utf-8", errors="replace").read()
            except Exception: continue
            is_test = ".test." in os.path.basename(path) or "/tests/" in path.replace(os.sep,"/")
            for lineno, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if not stripped: continue
                for name, rx, cls, plat, note in compiled:
                    if rx.search(line):
                        f_cls = cls
                        if name=="hardcoded-home" and (is_test or stripped.startswith(("*","//","#","<!--")) or "docs/" in path):
                            f_cls = "note"
                        findings.append({
                            "repo":repo,"unit":unit,
                            "file":os.path.relpath(path, root),
                            "line":lineno,"group":name,"cls":f_cls,
                            "plat":plat,
                            "snippet":stripped[:160]
                        })
    with open("/tmp/audit46-findings.json","w") as f:
        json.dump(findings, f, indent=1)
    # summary
    from collections import Counter
    c = Counter((f["repo"],f["unit"],f["group"],f["cls"]) for f in findings)
    print(f"TOTAL FINDINGS: {len(findings)}")
    for (repo,unit,group,cls),n in sorted(c.items()):
        print(f"{repo:14s} {unit:22s} {group:15s} {cls:10s} {n}")
    # coverage: units with zero findings
    found_units = {(f["repo"],f["unit"]) for f in findings}
    print("\nUNITS WITH ZERO FINDINGS:", [f"{r}/{u}" for r,u in units if (r,u) not in found_units])

if __name__=="__main__":
    main()
