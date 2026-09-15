// smoke-one.mjs — child runner: load ONE extension index.ts and activate it
// against a recording stub. Used by smoke-extensions.mjs (repo tree + host tree).
// Crash class this guards (session 01a093d5, 2026-09-13): a TS-syntax-breaking
// edit shipped without a load check crashes pi AT EXTENSION LOAD, the daemon
// retries and spawns a pi storm. tsc alone is not enough when files are edited
// in place and the process is restarted by hand — this runner executes exactly
// what pi would execute: import + activate().
//
// argv: [2] = absolute path to index.ts
// stdout: JSON { ok, activated, error? } ; exit 0 = clean load.

const file = process.argv[2];
const fail = (error) => {
	process.stdout.write(JSON.stringify({ ok: false, activated: false, error: String(error).slice(0, 2000) }));
	process.exit(0); // structured failure, not a crash
};
if (!file) fail("missing argv[2]");

try {
	const mod = await import(new URL(`file://${file}`).href);
	if (typeof mod.default !== "function") {
		fail(`default export is ${typeof mod.default}, expected activate(pi) function`);
	}
	// Chainable recording stub: any prop access returns a callable proxy, any
	// call returns the same proxy — activate() can register handlers/tools/
	// commands freely; we only care that it does not throw.
	const stubProxy = new Proxy(function stub() {}, {
		get(_t, prop) {
			if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
			if (typeof prop === "symbol") return undefined;
			return stubProxy;
		},
		apply() {
			return stubProxy;
		},
	});
	mod.default(stubProxy);
	process.stdout.write(JSON.stringify({ ok: true, activated: true }));
	// activate() may have started timers/watchers that keep the event loop
	// alive; the load contract is satisfied — exit now instead of hanging.
	process.exit(0);
} catch (e) {
	fail(e?.stack ?? e);
}
