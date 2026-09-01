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
});
