import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Buffer } from "node:buffer";
import ts from "typescript";

const sourcePath = new URL("../extensions/oh-my-tps.ts", import.meta.url);
const source = readFileSync(sourcePath, "utf8")
	.replace(/^import type .*?;\r?\n/m, "")
	.replace(
		/^import \{ estimateTokens \} from "\.\/shared\/token-estimator\.js";\r?\n/m,
		"const estimateTokens = (text) => text.length;\n",
	);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
	},
}).outputText;
const extensionUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { default: ohMyTps } = await import(extensionUrl);

class FakePi {
	constructor() {
		this.handlers = new Map();
	}

	on(event, handler) {
		this.handlers.set(event, handler);
	}

	async emit(event, payload, ctx) {
		await this.handlers.get(event)?.(payload, ctx);
	}
}

function createContext() {
	const statuses = [];
	return {
		ctx: {
			hasUI: true,
			ui: {
				setStatus(_key, value) {
					statuses.push(value);
				},
			},
		},
		latestStatus() {
			return statuses.at(-1);
		},
	};
}

async function withFakeClock(callback) {
	const originalPerformance = globalThis.performance;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let now = 0;
	Object.defineProperty(globalThis, "performance", {
		configurable: true,
		value: { now: () => now },
	});
	globalThis.setInterval = (callback, milliseconds) => ({ callback, milliseconds });
	globalThis.clearInterval = () => {};

	try {
		await callback({
			at(milliseconds) {
				now = milliseconds;
			},
		});
	} finally {
		Object.defineProperty(globalThis, "performance", {
			configurable: true,
			value: originalPerformance,
		});
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

function assistantUpdate(type, delta) {
	return {
		message: { role: "assistant" },
		assistantMessageEvent: { type, delta },
	};
}

function assistantEnd(output) {
	return {
		message: {
			role: "assistant",
			...(output === undefined ? {} : { usage: { output } }),
		},
	};
}

async function shutdown(pi, ctx) {
	await pi.emit("session_shutdown", {}, ctx);
}

test("元数据和思考增量只影响 TTFT，不进入 live TPS 队列", { concurrency: false }, async () => {
	await withFakeClock(async (clock) => {
		const pi = new FakePi();
		const { ctx, latestStatus } = createContext();
		ohMyTps(pi);

		await pi.emit("before_provider_request", {}, ctx);
		clock.at(500);
		await pi.emit("message_update", assistantUpdate("text_start", undefined), ctx);
		assert.equal(latestStatus(), "τ0.0 Δ?");

		clock.at(1000);
		await pi.emit("message_update", assistantUpdate("thinking_delta", "隐藏推理摘要"), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ?");

		clock.at(1200);
		await pi.emit("message_update", assistantUpdate("text_delta", "aa"), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ?");

		clock.at(3200);
		await pi.emit("message_update", assistantUpdate("text_delta", "bbb"), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ2.5");

		clock.at(4000);
		await pi.emit("message_end", assistantEnd(12), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ4.0");

		await pi.emit("agent_end", {}, ctx);
		assert.equal(latestStatus(), "τ1.0A Δ4.0A");
		await shutdown(pi, ctx);
	});
});

test("缺少 usage 时，最后一次有效 live TPS 结算并纳入平均值", { concurrency: false }, async () => {
	await withFakeClock(async (clock) => {
		const pi = new FakePi();
		const { ctx, latestStatus } = createContext();
		ohMyTps(pi);

		await pi.emit("before_provider_request", {}, ctx);
		clock.at(500);
		await pi.emit("message_update", assistantUpdate("text_delta", "abc"), ctx);
		clock.at(2500);
		await pi.emit("message_update", assistantUpdate("toolcall_delta", "def"), ctx);
		assert.equal(latestStatus(), "τ0.5 Δ3.0");

		clock.at(2600);
		await pi.emit("message_end", assistantEnd(undefined), ctx);
		assert.equal(latestStatus(), "τ0.5 Δ3.0");

		await pi.emit("agent_end", {}, ctx);
		assert.equal(latestStatus(), "τ0.5A Δ3.0A");
		await shutdown(pi, ctx);
	});
});

test("重复 message_end 不会重复结算或污染平均值", { concurrency: false }, async () => {
	await withFakeClock(async (clock) => {
		const pi = new FakePi();
		const { ctx, latestStatus } = createContext();
		ohMyTps(pi);

		await pi.emit("before_provider_request", {}, ctx);
		clock.at(1000);
		await pi.emit("message_update", assistantUpdate("text_delta", "a"), ctx);
		clock.at(4000);
		await pi.emit("message_end", assistantEnd(10), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ3.3");

		clock.at(5000);
		await pi.emit("message_end", assistantEnd(100), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ3.3");

		await pi.emit("agent_end", {}, ctx);
		assert.equal(latestStatus(), "τ1.0A Δ3.3A");
		await shutdown(pi, ctx);
	});
});

test("无有效结算时，旧 last TPS 只可用于当前 settled 回退", { concurrency: false }, async () => {
	await withFakeClock(async (clock) => {
		const pi = new FakePi();
		const { ctx, latestStatus } = createContext();
		ohMyTps(pi);

		await pi.emit("before_provider_request", {}, ctx);
		clock.at(1000);
		await pi.emit("message_update", assistantUpdate("text_delta", "a"), ctx);
		clock.at(4000);
		await pi.emit("message_end", assistantEnd(10), ctx);
		assert.equal(latestStatus(), "τ1.0 Δ3.3");
		await pi.emit("agent_end", {}, ctx);

		clock.at(5000);
		await pi.emit("before_provider_request", {}, ctx);
		assert.equal(latestStatus(), "τ0.0 Δ3.3L");
		clock.at(6000);
		await pi.emit("message_end", assistantEnd(undefined), ctx);
		assert.equal(latestStatus(), "τ1.0A Δ3.3L");
		await pi.emit("agent_end", {}, ctx);

		clock.at(7000);
		await pi.emit("before_provider_request", {}, ctx);
		assert.equal(latestStatus(), "τ0.0 Δ3.3A");
		await shutdown(pi, ctx);
	});
});
