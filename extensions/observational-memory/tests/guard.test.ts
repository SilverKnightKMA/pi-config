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
