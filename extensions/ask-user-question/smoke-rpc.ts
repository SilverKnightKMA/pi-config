/**
 * RPC integration smoke test for pi 0.84 (`--mode rpc`).
 *
 * pi 0.84 emits no `ready` frame and `get_state` carries no tool list, so
 * extension load is proven via `get_commands`: the extension registers the
 * `ask-user-question-dev` slash command at activation. The scripted host also
 * answers `select`/`input`/`editor` extension_ui_request frames, so a future
 * model-driven run would round-trip cleanly.
 *
 * Exit 0 = extension loaded, no extension_error frames, protocol healthy.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const PI_BIN = process.env.PI_BIN ?? "pi";
const EXT = new URL("./index.ts", import.meta.url).pathname;

interface Frame {
	type: string;
	id?: string;
	method?: string;
	options?: string[];
	command?: string;
	success?: boolean;
	data?: { commands?: Array<{ name: string }> };
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

	const commandsReceived = Promise.withResolvers<void>();
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
				if (frame.type === "response" && frame.command === "get_commands" && frame.success) {
					commandsReceived.resolve();
				}
				if (frame.type === "extension_ui_request") {
					if (frame.method === "select") {
						send(proc, { type: "extension_ui_response", id: frame.id, value: (frame.options ?? [])[0] });
					} else if (frame.method === "input") {
						send(proc, { type: "extension_ui_response", id: frame.id, value: "1" });
					} else if (frame.method === "editor") {
						send(proc, { type: "extension_ui_response", id: frame.id, value: "host-typed" });
					}
				}
			} catch {
				// non-JSON line — ignore
			}
		}
	});

	send(proc, { id: "cmd-1", type: "get_commands" });
	// Extensions load asynchronously; retry the probe.
	const timeout = delay(20_000).then(() => {
		throw new Error("timeout waiting for get_commands");
	});
	await Promise.race([commandsReceived.promise, timeout]);
	await delay(2000);
	send(proc, { id: "cmd-2", type: "get_commands" });
	await delay(2000);

	proc.stdin.end();
	proc.kill();

	const cmdResp = [...frames]
		.reverse()
		.find((f) => f.type === "response" && f.command === "get_commands" && f.success);
	const commands: Array<{ name: string }> = cmdResp?.data?.commands ?? [];
	const extensionLoaded = commands.some((c) => c.name.includes("ask-user-question-dev"));
	const extensionErrors = frames.filter((f) => f.type === "extension_error");

	console.log(
		JSON.stringify(
			{
				ok: extensionLoaded && extensionErrors.length === 0,
				extensionLoaded,
				registeredCommands: commands.map((c) => c.name),
				extensionErrors,
				frameTypes: [...new Set(frames.map((f) => f.type))],
				stderrTail: stderr.slice(-300),
			},
			null,
			2,
		),
	);

	return extensionLoaded && extensionErrors.length === 0 ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error("smoke harness failed:", error);
		process.exit(2);
	});
