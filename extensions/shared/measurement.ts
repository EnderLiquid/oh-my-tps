/**
 * TPS 测量核心。
 *
 * 该模块不依赖 Pi：它只消费归一化的增量数据、产出快照，
 * 因此可以在没有 UI 的测试环境中直接驱动，也便于将来复用到别的前端。
 */
import { estimateTokens as defaultEstimateTokens } from "./token-estimator.js";
import type { TpsReading, TpsStatusView, TtftReading } from "./events.js";

const MILLISECONDS_PER_SECOND = 1_000;

/** waiting 阶段快照的刷新间隔。 */
const WAITING_UPDATE_MS = 200;

/** 实时 TPS 的滑动窗口长度。 */
const LIVE_TPS_WINDOW_MS = 5_000;

/** 短于该时长不计算实时 TPS，避免开头几个 token 造成剧烈抖动。 */
const MIN_LIVE_TPS_ELAPSED_MS = 2_000;

/** 短于该时长不采用 `usage.output` 结算 TPS。 */
const MIN_SETTLE_TPS_DURATION_MS = 2_000;

/** 平均值保留的样本数。 */
const MAX_RECENT_SAMPLES = 5;

type RequestPhase = TpsStatusView["phase"];

/** 结算 TPS 的来源。视图暂不暴露该信息，保留以备后续追加字段。 */
type TpsSource = "usage" | "live-fallback";

type LiveDelta = {
	receivedAt: number;
	delta: string;
};

type SettledTps = {
	tps: number;
	source: TpsSource;
};

/** 从流式事件中提取出的、与测量相关的增量。 */
export type ContentDelta = {
	delta: string;
	isLiveTpsDelta: boolean;
};

/** 流式事件中测量所需的最小结构。 */
export type ContentDeltaEvent = {
	assistantMessageEvent: { type: string; delta?: string };
};

type TimerHandle = ReturnType<typeof setInterval>;

export interface TpsMeasurementOptions {
	/** 快照接收者。收到 `null` 表示应清除显示。 */
	sink: (view: TpsStatusView | null) => void;
	/** 单调时钟。默认 `performance.now`，单位毫秒。 */
	now?: () => number;
	/** 定时器注入点，仅用于测试。 */
	setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	/** token 估算注入点，仅用于测试。 */
	estimateTokens?: (text: string) => number;
}

export interface TpsMeasurement {
	/** 会话开始：回到 idle 并广播首个快照。 */
	start(): void;
	/** 会话结束：停止计时并广播清除信号。 */
	stop(): void;
	/** 重新广播当前快照。供晚加载的订阅者主动拉取。 */
	refresh(): void;
	/** 请求已发出，等待首个 token。 */
	beginWaiting(): void;
	handleMessageUpdate(event: ContentDeltaEvent): void;
	/** 助手消息结束，尝试用 `usage.output` 结算本轮 TPS。 */
	finalize(outputTokens: number | undefined): void;
	handleAgentEnd(): void;
}

function isFinitePositive(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 从流式事件中提取增量。
 *
 * 思考增量计入 TTFT 但不计入 TPS：加密推理不会下发 thinking_delta，
 * 而 TPS 只统计真正输出到用户可见内容上的 token。
 */
export function getContentDelta(event: ContentDeltaEvent): ContentDelta | null {
	const { type, delta } = event.assistantMessageEvent;
	if (typeof delta !== "string" || delta.length === 0) return null;
	if (type === "thinking_delta") return { delta, isLiveTpsDelta: false };
	if (type === "text_delta" || type === "toolcall_delta") return { delta, isLiveTpsDelta: true };
	return null;
}

export function createTpsMeasurement(options: TpsMeasurementOptions): TpsMeasurement {
	const now = options.now ?? (() => performance.now());
	const setTimer = options.setTimer ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
	const clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle));
	const estimate = options.estimateTokens ?? ((text) => defaultEstimateTokens(text));

	let phase: RequestPhase = "idle";
	let stopped = true;

	// 本轮测量状态
	let requestStartedAt: number | null = null;
	let firstContentDeltaAt: number | null = null;
	let firstLiveDeltaAt: number | null = null;
	let lockedTtft: number | null = null;
	let liveQueue: LiveDelta[] = [];
	let currentLiveTps: number | null = null;
	let lastValidLiveTps: number | null = null;

	// 跨轮状态
	let lastSettledTps: SettledTps | null = null;
	const recentTtftSamples: number[] = [];
	const recentTpsSamples: SettledTps[] = [];

	let waitingTimer: TimerHandle | undefined;

	function emit(view: TpsStatusView | null): void {
		options.sink(view);
	}

	function stopWaitingTimer(): void {
		if (waitingTimer !== undefined) clearTimer(waitingTimer);
		waitingTimer = undefined;
	}

	function getAverage(values: number[]): number | null {
		if (values.length === 0) return null;
		let total = 0;
		for (const value of values) total += value;
		return total / values.length;
	}

	function getAverageTtft(): number | null {
		return getAverage(recentTtftSamples);
	}

	function getAverageTps(): number | null {
		return getAverage(recentTpsSamples.map((sample) => sample.tps));
	}

	function pushRecent<T>(samples: T[], sample: T): void {
		samples.push(sample);
		if (samples.length > MAX_RECENT_SAMPLES) {
			samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
		}
	}

	function resetRequestMeasurement(): void {
		requestStartedAt = null;
		firstContentDeltaAt = null;
		firstLiveDeltaAt = null;
		lockedTtft = null;
		liveQueue = [];
		currentLiveTps = null;
		lastValidLiveTps = null;
	}

	function buildTtft(): TtftReading {
		if (phase === "waiting" && requestStartedAt !== null) {
			const elapsed = Math.max(0, (now() - requestStartedAt) / MILLISECONDS_PER_SECOND);
			return isFiniteNonNegative(elapsed) ? { value: elapsed, kind: "counting" } : { value: null, kind: "unknown" };
		}
		if (isFiniteNonNegative(lockedTtft)) return { value: lockedTtft, kind: "locked" };

		const average = getAverageTtft();
		return isFiniteNonNegative(average) ? { value: average, kind: "average" } : { value: null, kind: "unknown" };
	}

	/**
	 * @param settled 本轮结算值，仅 settled 阶段可能非空。
	 */
	function buildTps(settled: SettledTps | null): TpsReading {
		if (settled) return { value: settled.tps, kind: "settled" };
		if (phase === "streaming" && isFinitePositive(currentLiveTps)) {
			return { value: currentLiveTps, kind: "live" };
		}
		// idle 阶段不显示回退值，只显示平均值。
		if (phase !== "idle" && lastSettledTps) return { value: lastSettledTps.tps, kind: "last" };

		const average = getAverageTps();
		return isFinitePositive(average) ? { value: average, kind: "average" } : { value: null, kind: "unknown" };
	}

	function buildView(settled: SettledTps | null = null): TpsStatusView {
		return {
			phase,
			ttft: buildTtft(),
			tps: buildTps(settled),
			updatedAt: Date.now(),
		};
	}

	function renderIdle(): void {
		phase = "idle";
		stopWaitingTimer();
		resetRequestMeasurement();
		emit(buildView());
	}

	function renderWaiting(): void {
		stopWaitingTimer();
		emit(buildView());
		waitingTimer = setTimer(() => {
			// 定时器可能在阶段切换后仍触发一次，这里以 phase 为准。
			if (phase !== "waiting") return;
			emit(buildView());
		}, WAITING_UPDATE_MS);
	}

	function beginStreaming(at: number): void {
		if (requestStartedAt === null) return;
		phase = "streaming";
		stopWaitingTimer();
		firstContentDeltaAt = at;
		lockedTtft = Math.max(0, (at - requestStartedAt) / MILLISECONDS_PER_SECOND);
		if (isFiniteNonNegative(lockedTtft)) pushRecent(recentTtftSamples, lockedTtft);
	}

	function updateLiveTps(at: number, delta: string): void {
		if (firstLiveDeltaAt === null) firstLiveDeltaAt = at;
		liveQueue.push({ receivedAt: at, delta });

		const cutoff = at - LIVE_TPS_WINDOW_MS;
		liveQueue = liveQueue.filter((item) => item.receivedAt >= cutoff);

		const elapsedMs = Math.max(0, at - firstLiveDeltaAt);
		if (elapsedMs < MIN_LIVE_TPS_ELAPSED_MS) return;

		// 采样时长不足一个完整窗口时，按实际经过的时长折算。
		const durationMs = Math.min(LIVE_TPS_WINDOW_MS, elapsedMs);
		const estimatedTokens = estimate(liveQueue.map((item) => item.delta).join(""));
		const tps = durationMs > 0 ? (estimatedTokens * MILLISECONDS_PER_SECOND) / durationMs : null;
		if (!isFinitePositive(tps)) return;

		currentLiveTps = tps;
		lastValidLiveTps = tps;
	}

	function resolveSettledTps(outputTokens: number | undefined, messageEndedAt: number): SettledTps | null {
		if (isFinitePositive(outputTokens)) {
			if (firstContentDeltaAt === null) return null;
			const durationMs = Math.max(0, messageEndedAt - firstContentDeltaAt);
			if (durationMs < MIN_SETTLE_TPS_DURATION_MS) return null;

			const tps = (outputTokens * MILLISECONDS_PER_SECOND) / durationMs;
			return isFinitePositive(tps) ? { tps, source: "usage" } : null;
		}

		return isFinitePositive(lastValidLiveTps) ? { tps: lastValidLiveTps, source: "live-fallback" } : null;
	}

	return {
		start() {
			stopped = false;
			renderIdle();
		},

		stop() {
			stopped = true;
			stopWaitingTimer();
			emit(null);
		},

		refresh() {
			emit(stopped ? null : buildView());
		},

		beginWaiting() {
			phase = "waiting";
			resetRequestMeasurement();
			requestStartedAt = now();
			renderWaiting();
		},

		handleMessageUpdate(event) {
			const contentDelta = getContentDelta(event);
			if (!contentDelta) return;
			if (phase !== "waiting" && phase !== "streaming") return;

			const at = now();
			if (phase === "waiting") beginStreaming(at);
			if (phase !== "streaming") return;

			if (contentDelta.isLiveTpsDelta) updateLiveTps(at, contentDelta.delta);
			emit(buildView());
		},

		finalize(outputTokens) {
			if (phase !== "waiting" && phase !== "streaming") return;

			phase = "settled";
			stopWaitingTimer();

			const settledTps = resolveSettledTps(outputTokens, now());
			if (settledTps) pushRecent(recentTpsSamples, settledTps);

			// 本轮没有结算值时，视图会回退到 lastSettledTps 作为 `L`。
			// 因此必须先广播再更新它，否则回退值会变成本轮的新值。
			emit(buildView(settledTps));
			lastSettledTps = settledTps;
		},

		handleAgentEnd() {
			// 被中断的轮次没有结算值，其旧的 last 不应继续对外显示。
			if (phase === "waiting" || phase === "streaming") lastSettledTps = null;
			renderIdle();
		},
	};
}
