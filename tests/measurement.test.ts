/**
 * 测量核心的行为测试。
 *
 * 核心不依赖 Pi，也不依赖真实时钟，因此这里直接注入时间与定时器，
 * 断言的对象是核心发出的快照序列。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TpsStatusView } from "../extensions/shared/events.js";
import { createTpsMeasurement } from "../extensions/shared/measurement.js";

interface Harness {
	measurement: ReturnType<typeof createTpsMeasurement>;
	snapshots: (TpsStatusView | null)[];
	at(milliseconds: number): void;
	/** 模拟 waiting 阶段的定时刷新。 */
	tick(): void;
	latest(): TpsStatusView;
	count(): number;
}

function createHarness(): Harness {
	let now = 0;
	let timer: (() => void) | undefined;
	const snapshots: (TpsStatusView | null)[] = [];

	const measurement = createTpsMeasurement({
		sink: (view) => snapshots.push(view),
		now: () => now,
		setTimer: (callback) => {
			timer = callback;
			return {} as ReturnType<typeof setInterval>;
		},
		clearTimer: () => {
			timer = undefined;
		},
		estimateTokens: (text) => text.length,
	});

	return {
		measurement,
		snapshots,
		at(milliseconds) {
			now = milliseconds;
		},
		tick() {
			timer?.();
		},
		latest() {
			const view = snapshots.at(-1);
			assert.ok(view, "expected a status snapshot");
			return view;
		},
		count() {
			return snapshots.length;
		},
	};
}

const assistantUpdate = (type: string, delta: string | undefined) => ({ assistantMessageEvent: { type, delta } });

test("元数据和思考增量只影响 TTFT，不进入 live TPS 队列", () => {
	const h = createHarness();
	h.measurement.start();

	h.measurement.beginWaiting();
	assert.deepEqual(h.latest().ttft, { value: 0, kind: "counting" });
	assert.deepEqual(h.latest().tps, { value: null, kind: "unknown" });

	h.at(500);
	h.tick();
	assert.deepEqual(h.latest().ttft, { value: 0.5, kind: "counting" });

	// 空增量不产生快照。
	const before = h.count();
	h.measurement.handleMessageUpdate(assistantUpdate("text_start", undefined));
	assert.equal(h.count(), before);

	h.at(1_000);
	h.measurement.handleMessageUpdate(assistantUpdate("thinking_delta", "隐藏推理摘要"));
	assert.deepEqual(h.latest().ttft, { value: 1, kind: "locked" });
	assert.deepEqual(h.latest().tps, { value: null, kind: "unknown" });

	h.at(1_200);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "aa"));
	assert.deepEqual(h.latest().tps, { value: null, kind: "unknown" });

	h.at(3_200);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "bbb"));
	assert.deepEqual(h.latest().tps, { value: 2.5, kind: "live" });

	h.at(4_000);
	h.measurement.finalize(12);
	assert.deepEqual(h.latest().tps, { value: 4, kind: "settled" });

	h.measurement.handleAgentEnd();
	assert.deepEqual(h.latest().ttft, { value: 1, kind: "average" });
	assert.deepEqual(h.latest().tps, { value: 4, kind: "average" });
});

test("缺少 usage 时，最后一次有效 live TPS 结算并纳入平均值", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	h.at(500);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "abc"));
	h.at(2_500);
	h.measurement.handleMessageUpdate(assistantUpdate("toolcall_delta", "def"));
	assert.deepEqual(h.latest().tps, { value: 3, kind: "live" });

	h.at(2_600);
	h.measurement.finalize(undefined);
	assert.deepEqual(h.latest().ttft, { value: 0.5, kind: "locked" });
	assert.deepEqual(h.latest().tps, { value: 3, kind: "settled" });

	h.measurement.handleAgentEnd();
	assert.deepEqual(h.latest().ttft, { value: 0.5, kind: "average" });
	assert.deepEqual(h.latest().tps, { value: 3, kind: "average" });
});

test("重复 finalize 不会重复结算或污染平均值", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	h.at(1_000);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "a"));
	h.at(4_000);
	h.measurement.finalize(10);
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "settled" });

	const before = h.count();
	h.at(5_000);
	h.measurement.finalize(100);
	assert.equal(h.count(), before);

	h.measurement.handleAgentEnd();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "average" });
});

test("无有效结算时，旧 last TPS 只可用于当前 settled 回退", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	h.at(1_000);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "a"));
	h.at(4_000);
	h.measurement.finalize(10);
	h.measurement.handleAgentEnd();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "average" });

	h.at(5_000);
	h.measurement.beginWaiting();
	assert.deepEqual(h.latest().ttft, { value: 0, kind: "counting" });
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "last" });

	h.at(6_000);
	h.measurement.finalize(undefined);
	assert.deepEqual(h.latest().ttft, { value: 1, kind: "average" });
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "last" });

	// 本轮没有结算值，旧的 last 随之作废。
	h.measurement.handleAgentEnd();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "average" });

	h.at(7_000);
	h.measurement.beginWaiting();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "average" });
});

test("被中断的轮次不再对外显示上一轮结算值", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	h.at(1_000);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "a"));
	h.at(4_000);
	h.measurement.finalize(10);
	h.measurement.handleAgentEnd();

	// 第二轮在流式中被中断：既没有结算值，也不应沿用上一轮的 last。
	h.at(5_000);
	h.measurement.beginWaiting();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "last" });

	h.at(6_000);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "b"));
	h.measurement.handleAgentEnd();

	h.at(7_000);
	h.measurement.beginWaiting();
	assert.deepEqual(h.latest().tps, { value: 3.3333333333333335, kind: "average" });
});

test("waiting 阶段按间隔刷新，离开该阶段后停止", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	h.at(200);
	h.tick();
	assert.deepEqual(h.latest().ttft, { value: 0.2, kind: "counting" });

	h.at(1_000);
	h.measurement.handleMessageUpdate(assistantUpdate("text_delta", "a"));
	assert.deepEqual(h.latest().ttft, { value: 1, kind: "locked" });

	// 已进入 streaming，旧的 waiting 定时器不应再产生快照。
	const before = h.count();
	h.tick();
	assert.equal(h.count(), before);
});

test("stop 广播清除信号，refresh 重发当前快照", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();

	const latest = h.latest();
	h.measurement.refresh();
	assert.deepEqual(h.latest(), latest);

	h.measurement.stop();
	assert.equal(h.snapshots.at(-1), null);

	// 已停止后刷新只应继续广播清除信号，而不是重新给出过期数据。
	h.measurement.refresh();
	assert.equal(h.snapshots.at(-1), null);
});

test("stop 之后迟到的事件不再让状态栏重新亮起", () => {
	const h = createHarness();
	h.measurement.start();
	h.measurement.beginWaiting();
	h.measurement.stop();

	const afterStop = h.count();

	// 会话切换或 reload 后，旧实例可能仍收到事件。
	h.measurement.beginWaiting();
	h.measurement.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "late" } });
	h.measurement.finalize(10);
	h.measurement.handleAgentEnd();

	assert.equal(h.count(), afterStop, "不应产生任何新快照");
	assert.equal(h.snapshots.at(-1), null, "最后一次广播仍应为清除信号");
});
