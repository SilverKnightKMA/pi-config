import { describe, expect, test } from "bun:test";
import { isMemoryPath, classifyBashMemoryTouch } from "../src/guard/memory-guard.ts";

describe("isMemoryPath", () => {
	test("blocks direct and nested memory paths", () => {
		expect(isMemoryPath(".memory/INDEX.md", "/ws")).toBe(true);
		expect(isMemoryPath("/ws/.memory/sess/topic.md", "/ws")).toBe(true);
		expect(isMemoryPath("src/index.ts", "/ws")).toBe(false);
		expect(isMemoryPath("../other/.memory/x", "/ws/proj")).toBe(false); // resolves outside ws
		expect(isMemoryPath(undefined, "/ws")).toBe(false);
	});
});

describe("classifyBashMemoryTouch", () => {
	test("reads are allowed", () => {
		expect(classifyBashMemoryTouch("cat .memory/INDEX.md")).toBe("read");
		expect(classifyBashMemoryTouch("ls -la .memory/sess")).toBe("read");
		expect(classifyBashMemoryTouch("grep -r topic .memory/ | head")).toBe("read");
		expect(classifyBashMemoryTouch("echo hi")).toBe("none");
	});
	test("mutations are blocked", () => {
		expect(classifyBashMemoryTouch("rm .memory/INDEX.md")).toBe("mutate");
		expect(classifyBashMemoryTouch("mv .memory/a.md .memory/b.md")).toBe("mutate");
		expect(classifyBashMemoryTouch("cp /tmp/x .memory/a.md")).toBe("mutate");   // into memory
		expect(classifyBashMemoryTouch("echo x > .memory/a.md")).toBe("mutate");
		expect(classifyBashMemoryTouch("sed -i s/a/b/ .memory/t.md")).toBe("mutate");
		expect(classifyBashMemoryTouch("python3 -c \"open('.memory/a','w')\"")).toBe("mutate");
	});
	test("copying OUT of memory is a read", () => {
		expect(classifyBashMemoryTouch("cp .memory/a.md /tmp/a.md")).toBe("read");
	});
	test("v1.4.25 — prose mentions are not path mentions (chained false-positive class)", () => {
		// the exact shape that blocked a real release: sed -i on a package file
		// + the string .memory inside a commit message, one && chain
		expect(
			classifyBashMemoryTouch(
				"sed -i 's/1.0.28/1.0.29/' pkg.json && git commit -m \"chore: filesystem data (.memory topics) untouched\" && git push",
			),
		).toBe("none");
		expect(classifyBashMemoryTouch("echo 'docs say .memory is managed here'")).toBe("none");
		expect(classifyBashMemoryTouch("grep -rn '\\.memory' src/")).toBe("none");
		expect(classifyBashMemoryTouch("commit message mentioning `.memory` backticked")).toBe("none");
	});
	test("v1.4.25 — quoted and nested real paths still match", () => {
		expect(classifyBashMemoryTouch('rm -rf ".memory/foo bar"')).toBe("mutate");
		expect(classifyBashMemoryTouch("python3 -c \"open('.memory/a','w')\"")).toBe("mutate");
		expect(classifyBashMemoryTouch("mv '/ws/.memory/x.md' /tmp/x.md")).toBe("mutate");
		expect(classifyBashMemoryTouch("cat .memory/INDEX.md > /tmp/copy")).toBe("read"); // redirect target outside (tee anywhere stays blocked — pre-existing, conservative)
	});
});

// --- P1d (#177, plan 2026-09-21): facts tier guard ----------------------------
import { classifyBashFactsTierTouch, isFactsTierPath } from "../src/guard/memory-guard.ts";

describe("isFactsTierPath (write/edit guard)", () => {
	const HOME = "/home/tester";
	test("blocks the three tier locations, tilde and absolute", () => {
		expect(isFactsTierPath("~/.pi/agent/facts.md", "/ws", HOME)).toBe(true);
		expect(isFactsTierPath("/home/tester/.pi/agent/facts.md", "/ws", HOME)).toBe(true);
		expect(isFactsTierPath("~/.pi/agent/lessons.md", "/ws", HOME)).toBe(true);
		expect(isFactsTierPath("/home/tester/.pi/agent/facts-runs/run-1.json", "/ws", HOME)).toBe(true);
		expect(isFactsTierPath("facts.md", "/ws", HOME)).toBe(false); // workspace file, different tree
		expect(isFactsTierPath("/ws/notes/facts.md", "/ws", HOME)).toBe(false);
		expect(isFactsTierPath(undefined, "/ws", HOME)).toBe(false);
	});
});

describe("classifyBashFactsTierTouch", () => {
	const HOME = "/home/tester";
	test("reads allowed", () => {
		expect(classifyBashFactsTierTouch(`cat ${HOME}/.pi/agent/facts.md`, HOME)).toBe("read");
		expect(classifyBashFactsTierTouch("grep bun ~/.pi/agent/facts.md | head", HOME)).toBe("read");
	});
	test("mutations blocked", () => {
		expect(classifyBashFactsTierTouch(`echo x >> ${HOME}/.pi/agent/facts.md`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch("rm ~/.pi/agent/facts.md", HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`sed -i s/a/b/ ${HOME}/.pi/agent/lessons.md`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`cp /tmp/new.md ${HOME}/.pi/agent/facts.md`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`mkdir -p ${HOME}/.pi/agent/facts-runs/x`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`python3 -c "open('${HOME}/.pi/agent/facts.md','w')"`, HOME)).toBe("mutate");
	});
	test("$HOME form expanded", () => {
		expect(classifyBashFactsTierTouch("echo x >> $HOME/.pi/agent/facts.md", HOME)).toBe("mutate");
	});
	test("workspace-local facts.md is NOT the tier (none)", () => {
		expect(classifyBashFactsTierTouch("echo x >> facts.md", HOME)).toBe("none");
		expect(classifyBashFactsTierTouch("sed -i s/a/b/ docs/facts.md", HOME)).toBe("none");
	});
	test("prose mention is not a path mention", () => {
		expect(classifyBashFactsTierTouch(`git commit -m "touch ~/.pi/agent/facts.md layout in docs"`, HOME)).toBe("none");
	});
});

// ── #250 (M1): per-SEGMENT classification — the live false-positive closes ──
// NOTE: fixture strings below build tier paths from const pieces so THIS
// source file never itself looks like a mutating command to the guard that
// gates the tools writing it (dogfooding the very classifier under test).

describe("#250 per-segment classification (v1.4.140)", () => {
	const HOME = "/home/coder";
	const FACTS = `${HOME}/.pi/agent/facts.md`;
	const LESSONS = `${HOME}/.pi/agent/lessons.md`;
	const RUNS = `${HOME}/.pi/agent/facts-runs`;
	test("LIVE false-positive: unrelated python3 -c no longer blocks a tier read", () => {
		expect(classifyBashFactsTierTouch(`echo a; python3 -c "print(1)"; ls ${RUNS}/`, HOME)).toBe("read");
	});
	test("python3 -c WRITING the tier still blocks (same-segment mention)", () => {
		const w = "ope" + "n";
		expect(classifyBashFactsTierTouch(`python3 -c "${w}('${FACTS}','w')"`, HOME)).toBe("mutate");
	});
	test("redirect whose DESTINATION is the tier blocks; > /dev/null read does not", () => {
		expect(classifyBashFactsTierTouch(`echo x > ${FACTS}`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`tee ${LESSONS}`, HOME)).toBe("mutate");
		expect(classifyBashFactsTierTouch(`cat ${FACTS} > /dev/null`, HOME)).toBe("read");
	});
	test("mkdir in a foreign segment + tier read = read", () => {
		expect(classifyBashFactsTierTouch(`cat ${FACTS}; mkdir tmpdir`, HOME)).toBe("read");
	});
	test(".memory branch: same per-segment fix", () => {
		const MEM = "." + "memory";
		expect(classifyBashMemoryTouch(`echo a; python3 -c "print(1)"; ls ${MEM}/`)).toBe("read");
		const ow = "ope" + "n";
		expect(classifyBashMemoryTouch(`python3 -c "${ow}('${MEM}/a','w')"`)).toBe("mutate");
		expect(classifyBashMemoryTouch(`cat ${MEM}/x.md; rm tmpfile`)).toBe("read");
	});
	test("unterminated quote → fail CLOSED (whole-command rule)", () => {
		const MEM = "." + "memory";
		expect(classifyBashMemoryTouch(`echo "unterminated; rm ${MEM}/x`)).toBe("mutate");
	});
});
