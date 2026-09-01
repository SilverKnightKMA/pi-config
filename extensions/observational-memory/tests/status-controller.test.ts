import { describe, expect, it } from "bun:test";

import { StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: () => {},
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return { ui, footer: () => status.get("om") };
}

describe("StatusController footer gauges", () => {
	it("shows a bare footer until gauges are set", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("clearing gauges returns to the bare footer", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		sc.setGauges(undefined);
		expect(footer()).toBe("om");
	});
});

describe("StatusController footer v2 (2026-09-01)", () => {
	function recordingUI() {
		const status = new Map<string, string | undefined>();
		const calls: Array<[string, string]> = [];
		const ui: StatusUI = {
			setStatus: (key, text) => status.set(key, text),
			setWidget: () => {},
			theme: { fg: (color, text) => { calls.push([color, text]); return text; } },
		};
		return { ui, footer: () => status.get("om"), calls };
	}

	it("uses readable labels obs/pool/ctx instead of O/C/X", () => {
		const { ui, footer } = recordingUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 100, nextMax: 10_000, poolValue: 100, poolMax: 10_000, ctxValue: 100, ctxMax: 150_000 });
		expect(footer()).toContain("obs");
		expect(footer()).toContain("pool");
		expect(footer()).toContain("ctx");
		expect(footer()).not.toMatch(/\b[OCX]\b/);
	});

	it("colors pool/ctx warning at >=80% and error at >=95%; obs stays dim", () => {
		const { ui, calls } = recordingUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 9_000, nextMax: 10_000, poolValue: 8_500, poolMax: 10_000, ctxValue: 149_000, ctxMax: 150_000 });
		const byText = (t: string) => calls.filter(([, txt]) => txt === t).map(([c]) => c);
		expect(byText("pool")).toEqual(["muted"]);
		expect(byText("ctx")).toEqual(["muted"]);
		// bar fill for pool (85%) -> warning; ctx (99%) -> error; obs (90%) -> dim (never warns)
		const barCalls = calls.filter(([, txt]) => txt.includes("█") || txt.includes("░"));
		expect(barCalls.some(([c]) => c === "warning")).toBe(true);
		expect(barCalls.some(([c]) => c === "error")).toBe(true);
	});

	it("updateContext re-renders the footer without touching other gauges", () => {
		const { ui, footer } = recordingUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 100, nextMax: 10_000, poolValue: 100, poolMax: 10_000, ctxValue: 10_000, ctxMax: 150_000 });
		sc.updateContext(120_000);
		expect(footer()).toContain("ctx");
		sc.updateContext(null); // no-op, footer unchanged
		expect(footer()).toContain("ctx");
	});
});
