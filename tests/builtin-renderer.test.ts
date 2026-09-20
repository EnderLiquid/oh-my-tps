import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBuiltinRenderer, formatStatusText } from "../extensions/shared/builtin-renderer.js";
import type { TpsPhase, TpsReading, TtftReading } from "../extensions/shared/events.js";

const view = (phase: TpsPhase, ttft: TtftReading, tps: TpsReading) => ({ phase, ttft, tps, updatedAt: 0 });

test("各读数按语义加上 A / L 后缀", () => {
	assert.equal(
		formatStatusText(view("streaming", { value: 0.8, kind: "locked" }, { value: 48.63, kind: "live" })),
		"τ0.8 Δ48.6",
	);
	assert.equal(
		formatStatusText(view("waiting", { value: 1.1, kind: "counting" }, { value: 49.7, kind: "last" })),
		"τ1.1 Δ49.7L",
	);
	assert.equal(
		formatStatusText(view("idle", { value: 0.8, kind: "average" }, { value: 52.4, kind: "average" })),
		"τ0.8A Δ52.4A",
	);
});

test("无有效值时不显示数字", () => {
	assert.equal(
		formatStatusText(view("waiting", { value: null, kind: "unknown" }, { value: null, kind: "unknown" })),
		"τ… Δ?",
	);
});

interface FakeUi {
	ctx: ExtensionContext;
	statuses: (string | undefined)[];
	notifications: string[];
}

function createContext(mode: ExtensionContext["mode"]): FakeUi {
	const statuses: (string | undefined)[] = [];
	const notifications: string[] = [];
	// 只实现渲染器实际用到的部分，其余通过断言补齐为完整的 ExtensionContext。
	const ctx = {
		hasUI: true,
		mode,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</>` },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, notifications };
}

test("TUI 模式下整行套上配置的颜色", () => {
	const { ctx, statuses } = createContext("tui");
	const renderer = createBuiltinRenderer(ctx, { color: "dim" });

	renderer.render(view("streaming", { value: 0.8, kind: "locked" }, { value: 48.6, kind: "live" }));
	assert.deepEqual(statuses, ["<dim>τ0.8 Δ48.6</>"]);
});

test("非 TUI 模式下写入纯文本，不注入 ANSI 序列", () => {
	const { ctx, statuses } = createContext("rpc");
	const renderer = createBuiltinRenderer(ctx, { color: "dim" });

	renderer.render(view("streaming", { value: 0.8, kind: "locked" }, { value: 48.6, kind: "live" }));
	assert.deepEqual(statuses, ["τ0.8 Δ48.6"]);
});

test("收到 null 时清除状态", () => {
	const { ctx, statuses } = createContext("tui");
	const renderer = createBuiltinRenderer(ctx, { color: "dim" });

	renderer.render(null);
	assert.deepEqual(statuses, [undefined]);
});

test("没有 UI 时不写入任何内容", () => {
	const { ctx, statuses } = createContext("tui");
	ctx.hasUI = false;
	const renderer = createBuiltinRenderer(ctx, { color: "dim" });

	renderer.render(view("idle", { value: 1, kind: "average" }, { value: 2, kind: "average" }));
	renderer.clear();
	assert.deepEqual(statuses, []);
});
