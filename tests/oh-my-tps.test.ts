/**
 * 插件入口的集成测试。
 *
 * 用假的 Pi API 驱动入口，断言的是「总线上的事件序列」与「写入 footer 的文本」，
 * 也就是第三方渲染器能观察到的那一层。
 *
 * 入口内部会创建真实的 waiting 定时器，因此每个 rig 都在测试结束后收尾，
 * 否则进程会被定时器挂住而无法退出。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { TPS_REQUEST_CHANNEL, TPS_STATUS_CHANNEL, type TpsStatusView } from "../extensions/shared/events.js";

// 入口会读取真实配置文件，测试里把它指向一个不存在的路径。
process.env.PI_CODING_AGENT_DIR = fileURLToPath(new URL("./fixtures/agent-dir", import.meta.url));

const { default: ohMyTps } = await import("../extensions/oh-my-tps.js");

type Handler = (payload: unknown, ctx: ExtensionContext) => Promise<void> | void;

class FakePi {
	handlers = new Map<string, Handler>();

	on(event: string, handler: Handler): void {
		this.handlers.set(event, handler);
	}

	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		await this.handlers.get(event)?.(payload, ctx);
	}

	private channels = new Map<string, ((data: unknown) => void)[]>();

	events: EventBus = {
		emit: (channel: string, data: unknown) => {
			for (const handler of this.channels.get(channel) ?? []) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.channels.get(channel) ?? [];
			handlers.push(handler);
			this.channels.set(channel, handlers);
			return () => {
				this.channels.set(
					channel,
					handlers.filter((item) => item !== handler),
				);
			};
		},
	};
}

interface FakeUi {
	ctx: ExtensionContext;
	statuses: (string | undefined)[];
	notifications: string[];
	latestStatus(): string | undefined;
}

function createContext(mode: ExtensionContext["mode"] = "tui"): FakeUi {
	const statuses: (string | undefined)[] = [];
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		mode,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</>` },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, notifications, latestStatus: () => statuses.at(-1) };
}

const assistantUpdate = (type: string, delta: string | undefined) => ({
	message: { role: "assistant" },
	assistantMessageEvent: { type, delta },
});

const assistantEnd = (output?: number) => ({
	message: { role: "assistant", ...(output === undefined ? {} : { usage: { output } }) },
});

interface Rig extends FakeUi {
	pi: FakePi;
	snapshots: (TpsStatusView | null)[];
	start(reason?: string): Promise<void>;
	shutdown(): Promise<void>;
}

const rigs: Rig[] = [];

after(async () => {
	for (const rig of rigs) await rig.shutdown();
});

function createRig(mode: ExtensionContext["mode"] = "tui"): Rig {
	const pi = new FakePi();
	const context = createContext(mode);
	const snapshots: (TpsStatusView | null)[] = [];
	pi.events.on(TPS_STATUS_CHANNEL, (data) => snapshots.push(data as TpsStatusView | null));
	ohMyTps(pi as unknown as ExtensionAPI);

	const rig: Rig = {
		...context,
		pi,
		snapshots,
		async start(reason = "startup") {
			await pi.emit("session_start", { type: "session_start", reason }, context.ctx);
		},
		async shutdown() {
			await pi.emit("session_shutdown", { type: "session_shutdown" }, context.ctx);
		},
	};
	rigs.push(rig);
	return rig;
}

test("快照被广播到总线，内置渲染器据此写入 footer", async () => {
	const rig = createRig();
	await rig.start();

	assert.equal(rig.snapshots.length, 1);
	assert.equal(rig.snapshots[0]!.phase, "idle");
	assert.deepEqual(rig.snapshots[0]!.ttft, { value: null, kind: "unknown" });
	assert.equal(rig.latestStatus(), "<dim>τ… Δ?</>");
});

test("订阅者可通过 request 通道拉取当前快照", async () => {
	const rig = createRig();
	await rig.start();

	const before = rig.snapshots.length;
	rig.pi.events.emit(TPS_REQUEST_CHANNEL, undefined);
	assert.equal(rig.snapshots.length, before + 1);
});

test("start 之前收到 request 不会抛错", () => {
	const pi = new FakePi();
	ohMyTps(pi as unknown as ExtensionAPI);
	assert.doesNotThrow(() => pi.events.emit(TPS_REQUEST_CHANNEL, undefined));
});

test("完整一轮：等待、流式、结算、回到空闲", async () => {
	const rig = createRig();
	await rig.start();

	await rig.pi.emit("before_provider_request", {}, rig.ctx);
	assert.equal(rig.latestStatus(), "<dim>τ0.0 Δ?</>");

	await rig.pi.emit("message_update", assistantUpdate("text_delta", "abc"), rig.ctx);
	assert.equal(rig.latestStatus(), "<dim>τ0.0 Δ?</>");

	await rig.pi.emit("message_end", assistantEnd(12), rig.ctx);
	assert.equal(rig.latestStatus(), "<dim>τ0.0 Δ?</>");

	await rig.pi.emit("agent_end", {}, rig.ctx);
	assert.equal(rig.latestStatus(), "<dim>τ0.0A Δ?</>");
});

test("非助手角色的消息不进入测量", async () => {
	const rig = createRig();
	await rig.start();

	const before = rig.snapshots.length;
	await rig.pi.emit(
		"message_update",
		{ message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "x" } },
		rig.ctx,
	);
	assert.equal(rig.snapshots.length, before);
});

test("session_shutdown 广播清除信号并清空 footer", async () => {
	const rig = createRig();
	await rig.start();

	await rig.shutdown();
	assert.equal(rig.snapshots.at(-1), null);
	assert.equal(rig.latestStatus(), undefined);
});

test("重复 session_start 不会叠加订阅", async () => {
	const rig = createRig();
	await rig.start();
	await rig.start("reload");

	const before = rig.statuses.length;
	rig.pi.events.emit(TPS_REQUEST_CHANNEL, undefined);
	assert.equal(rig.statuses.length, before + 1);
});

test("非 TUI 模式下 footer 得到的是纯文本", async () => {
	const rig = createRig("rpc");
	await rig.start();
	assert.equal(rig.latestStatus(), "τ… Δ?");
});
