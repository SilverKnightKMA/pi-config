/**
 * web-fetch image attachment tests — #109 (v1.4.94, opencode port).
 * Direct image/* URLs return a text header + ImageContent block instead of
 * "Unsupported content type"; size ceiling 5MB; audio/video/zip unchanged.
 * Global fetch is stubbed — no network.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import webFetch from "./index";

interface CapturedTool {
	name: string;
	execute: (id: string, params: { url: string }, signal?: undefined) => Promise<any>;
}

function captureTool(): CapturedTool {
	const captured = {} as Partial<CapturedTool>;
	webFetch({
		registerTool: (d: any) => {
			captured.name = d.name;
			captured.execute = d.execute;
		},
	} as never);
	return captured as CapturedTool;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** A real 1x1 PNG (69 bytes) — exercises the resize path with decodable bytes. */
const VALID_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function imageResponse(type: string, body: BodyInit, headers: Record<string, string> = {}): Response {
	return new Response(body, { status: 200, headers: { "content-type": type, ...headers } });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
	// keep Jina fallback inert in case a test strays there
	(globalThis as any).fetch = async () => new Response("jina-off", { status: 500 });
});
afterEach(() => {
	(globalThis as any).fetch = realFetch;
});

describe("web_fetch image/* attachment (#109)", () => {
	test("image/png returns text header + ImageContent block", async () => {
		const tool = captureTool();
		(globalThis as any).fetch = async () => imageResponse("image/png", PNG_BYTES);
		const res = await tool.execute("t1", { url: "https://x.test/pic/diagram.png" });
		expect(res.content).toHaveLength(2);
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("https://x.test/pic/diagram.png");
		expect(res.content[0].text).toContain("image/png");
		expect(res.content[1].type).toBe("image");
		expect(res.content[1].mimeType).toBe("image/png");
		expect(res.content[1].data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
		expect(res.details.image).toBe(true);
		expect(res.details.bytes).toBe(PNG_BYTES.byteLength);
	});

	test("charset params are stripped from the mimeType", async () => {
		const tool = captureTool();
		(globalThis as any).fetch = async () => imageResponse("image/jpeg; charset=binary", PNG_BYTES);
		const res = await tool.execute("t2", { url: "https://x.test/photo.jpg" });
		expect(res.content[1].mimeType).toBe("image/jpeg");
	});

	test("declared Content-Length over 5MB refuses (generic size gate, no body read)", async () => {
		const tool = captureTool();
		// Response ctor recomputes content-length (fetch spec) — fake the object.
		let bodyRead = false;
		(globalThis as any).fetch = async () => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/png", "content-length": String(6 * 1024 * 1024) }),
			arrayBuffer: async () => {
				bodyRead = true;
				return PNG_BYTES.buffer;
			},
			text: async () => "",
		});
		await expect(tool.execute("t3", { url: "https://x.test/huge.png" })).rejects.toThrow(/too large/i);
		expect(bodyRead).toBe(false); // refuses on declared length alone
	});

	test("audio stays unsupported (no attachment for non-image media)", async () => {
		const tool = captureTool();
		(globalThis as any).fetch = async () => imageResponse("audio/mpeg", new Uint8Array([1, 2]));
		await expect(tool.execute("t4", { url: "https://x.test/a.mp3" })).rejects.toThrow("Unsupported content type: audio/mpeg");
	});

	test("plain text path is unchanged", async () => {
		const tool = captureTool();
		(globalThis as any).fetch = async () => imageResponse("text/plain", "hello world");
		const res = await tool.execute("t5", { url: "https://x.test/readme.txt" });
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("hello world");
		expect(res.details.image).toBeUndefined();
	});

	test("decodable image runs the resize path and still attaches (resized or fallback)", async () => {
		const tool = captureTool();
		const valid = Uint8Array.from(atob(VALID_PNG_B64), (c) => c.charCodeAt(0));
		(globalThis as any).fetch = async () => imageResponse("image/png", valid);
		const res = await tool.execute("t7", { url: "https://x.test/tiny.png" });
		const img = res.content[1];
		expect(img.type).toBe("image");
		expect(img.mimeType.startsWith("image/")).toBe(true); // PNG kept, or JPEG if resize picked the smaller encode
		expect(img.data.length).toBeGreaterThan(0);
		expect(res.details.bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
	});

	test("body larger than 5MB refuses even without content-length", async () => {
		const tool = captureTool();
		const big = new Uint8Array(6 * 1024 * 1024);
		(globalThis as any).fetch = async () => imageResponse("image/png", big);
		await expect(tool.execute("t6", { url: "https://x.test/big.png" })).rejects.toThrow("Image too large");
	});
});
