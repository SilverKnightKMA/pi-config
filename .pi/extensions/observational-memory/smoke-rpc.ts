/**
 * RPC integration smoke test for observational-memory (pi 0.84 `--mode rpc`).
 *
 * Proves: the orchestrator extension loads, registers the om/om:status/om:compact/
 * om:consolidate commands, and the `/om on` gate round-trips a custom message onto
 * the transcript (the Paseo timeline channel) — no extension_error frames.
 *
 * Exit 0 = loaded + commands + gate timeline message observed.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const PI_BIN = process.env.PI_BIN ?? "pi";
const EXT = new URL("./src/index.ts", import.meta.url).pathname;

interface Frame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: { commands?: Array<{ name: string }> };
	message?: { role?: string; customType?: string; content?: string };
	[key: string]: unknown;
}

function send(proc: ChildProcessWithoutNullStreams, frame: Frame): void {
	proc.stdin.write(JSON.stringify(frame) + "\n");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
	const proc = spawn(PI_BIN, ["--mode", "rpc", "--extension", EXT, "--no-session"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	}) as ChildProcessWithoutNullStreams;

	const frames: Frame[] = [];
	let stderr = "";
	proc.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const gateMessageSeen = Promise.withResolvers<void>();
	let buf = "";
	proc.stdout.on("data", (chunk: Buffer) => {
		buf += chunk.toString();
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			try {
				const frame: Frame = JSON.parse(line);
				frames.push(frame);
				if (frame.message?.customType === "om-timeline" && frame.message.content?.includes("om enabled")) {
					gateMessageSeen.resolve();
				}
			} catch {
				// non-JSON line — ignore
			}
		}
	});

	// Extensions load asynchronously; probe commands repeatedly until present.
	async function waitForCommands(tries: number): Promise<Array<{ name: string }>> {
		for (let i = 0; i < tries; i++) {
			send(proc, { id: `cmd-${i}`, type: "get_commands" });
			await delay(500);
			const resp = [...frames]
				.reverse()
				.find((f) => f.type === "response" && f.command === "get_commands" && f.success);
			const commands = resp?.data?.commands ?? [];
			if (commands.some((c) => c.name === "om")) return commands;
		}
		return [];
	}

	const commands = await waitForCommands(10);

	// Slash commands ride the prompt channel: message "/om on".
	if (commands.some((c) => c.name === "om")) {
		send(proc, { id: "om-on", type: "prompt", message: "/om on" });
		await Promise.race([gateMessageSeen.promise, delay(15_000)]);
	}

	await delay(500);
	proc.stdin.end();
	proc.kill();

	const omCommands = commands.filter((c) => c.name.startsWith("om")).map((c) => c.name).sort();
	const extensionErrors = frames.filter((f) => f.type === "extension_error");
	const timelineSeen = frames.some((f) => f.message?.customType === "om-timeline");

	console.log(
		JSON.stringify(
			{
				ok: omCommands.length >= 4 && extensionErrors.length === 0 && timelineSeen,
				omCommands,
				timelineMessageSeen: timelineSeen,
				extensionErrors,
				frameTypes: [...new Set(frames.map((f) => f.type))],
				stderrTail: stderr.slice(-300),
			},
			null,
			2,
		),
	);

	return omCommands.length >= 4 && extensionErrors.length === 0 && timelineSeen ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error("smoke harness failed:", error);
		process.exit(2);
	});
