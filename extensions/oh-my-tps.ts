import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "./shared/token-estimator.js";

const STATUS_KEY = "oh-my-tps";
const WAITING_UPDATE_MS = 200;
const UNKNOWN_DELTA_LABEL = "Δ?";
const UNKNOWN_TTFT_LABEL = "τ…";

const LIVE_TPS_WINDOW_SECONDS = 5;
const MIN_LIVE_TPS_ELAPSED_SECONDS = 2;
const MIN_SETTLE_TPS_DURATION_SECONDS = 2;
const MAX_RECENT_SAMPLES = 5;

type RequestPhase = "idle" | "waiting" | "streaming" | "settled";
type TpsSource = "usage" | "live-fallback";

type LiveDelta = {
	receivedAt: number;
	delta: string;
};

type SettledTps = {
	tps: number;
	source: TpsSource;
};

type ContentDelta = {
	delta: string;
	isLiveTpsDelta: boolean;
};

function formatNumber(value: number): string {
	return value.toFixed(1);
}

function isFinitePositive(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function getContentDelta(event: { assistantMessageEvent: { type: string; delta?: string } }): ContentDelta | null {
	const { type, delta } = event.assistantMessageEvent;
	if (typeof delta !== "string" || delta.length === 0) return null;
	if (type === "thinking_delta") return { delta, isLiveTpsDelta: false };
	if (type === "text_delta" || type === "toolcall_delta") return { delta, isLiveTpsDelta: true };
	return null;
}

export default function ohMyTps(pi: ExtensionAPI): void {
	let phase: RequestPhase = "idle";
	let requestStartedAt: number | null = null;
	let firstContentDeltaAt: number | null = null;
	let firstLiveDeltaAt: number | null = null;
	let lockedTtft: number | null = null;
	let liveQueue: LiveDelta[] = [];
	let currentLiveTps: number | null = null;
	let lastValidLiveTps: number | null = null;
	let roundSettledTps: SettledTps | null = null;
	let lastSettledTps: SettledTps | null = null;
	const recentTtftSamples: number[] = [];
	const recentTpsSamples: SettledTps[] = [];
	let waitingTimer: NodeJS.Timeout | undefined;

	function stopWaitingTimer(): void {
		if (waitingTimer) clearInterval(waitingTimer);
		waitingTimer = undefined;
	}

	function setStatus(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function getAverage(values: number[]): number | null {
		if (values.length === 0) return null;
		let total = 0;
		for (const value of values) total += value;
		return total / values.length;
	}

	function pushRecent<T>(samples: T[], sample: T): void {
		samples.push(sample);
		if (samples.length > MAX_RECENT_SAMPLES) {
			samples.splice(0, samples.length - MAX_RECENT_SAMPLES);
		}
	}

	function getAverageTtft(): number | null {
		return getAverage(recentTtftSamples);
	}

	function getAverageTps(): number | null {
		return getAverage(recentTpsSamples.map((sample) => sample.tps));
	}

	function getAverageTtftLabel(): string {
		const average = getAverageTtft();
		return isFiniteNonNegative(average) ? `τ${formatNumber(average)}A` : UNKNOWN_TTFT_LABEL;
	}

	function getAverageTpsLabel(): string {
		const average = getAverageTps();
		return isFinitePositive(average) ? `Δ${formatNumber(average)}A` : UNKNOWN_DELTA_LABEL;
	}

	function getLastOrAverageTpsLabel(lastTps: SettledTps | null = lastSettledTps): string {
		if (lastTps) return `Δ${formatNumber(lastTps.tps)}L`;
		return getAverageTpsLabel();
	}

	function resetRequestMeasurement(): void {
		requestStartedAt = null;
		firstContentDeltaAt = null;
		firstLiveDeltaAt = null;
		lockedTtft = null;
		liveQueue = [];
		currentLiveTps = null;
		lastValidLiveTps = null;
		roundSettledTps = null;
	}

	function renderIdle(ctx: ExtensionContext): void {
		phase = "idle";
		stopWaitingTimer();
		resetRequestMeasurement();
		setStatus(ctx, `${getAverageTtftLabel()} ${getAverageTpsLabel()}`);
	}

	function renderWaiting(ctx: ExtensionContext): void {
		stopWaitingTimer();
		const update = () => {
			if (phase !== "waiting" || requestStartedAt === null) return;
			const elapsed = Math.max(0, (performance.now() - requestStartedAt) / 1000);
			setStatus(ctx, `τ${formatNumber(elapsed)} ${getLastOrAverageTpsLabel()}`);
		};
		update();
		waitingTimer = setInterval(update, WAITING_UPDATE_MS);
	}

	function renderStreaming(ctx: ExtensionContext): void {
		const ttftLabel = isFiniteNonNegative(lockedTtft) ? `τ${formatNumber(lockedTtft)}` : UNKNOWN_TTFT_LABEL;
		const tpsLabel = isFinitePositive(currentLiveTps)
			? `Δ${formatNumber(currentLiveTps)}`
			: getLastOrAverageTpsLabel();
		setStatus(ctx, `${ttftLabel} ${tpsLabel}`);
	}

	function renderSettled(ctx: ExtensionContext, settledTps: SettledTps | null, previousLastTps: SettledTps | null): void {
		const ttftLabel = isFiniteNonNegative(lockedTtft)
			? `τ${formatNumber(lockedTtft)}`
			: getAverageTtftLabel();
		const tpsLabel = settledTps
			? `Δ${formatNumber(settledTps.tps)}`
			: getLastOrAverageTpsLabel(previousLastTps);
		setStatus(ctx, `${ttftLabel} ${tpsLabel}`);
	}

	function beginWaiting(ctx: ExtensionContext): void {
		phase = "waiting";
		resetRequestMeasurement();
		requestStartedAt = performance.now();
		renderWaiting(ctx);
	}

	function beginStreaming(now: number): void {
		if (requestStartedAt === null) return;
		phase = "streaming";
		stopWaitingTimer();
		firstContentDeltaAt = now;
		lockedTtft = Math.max(0, (now - requestStartedAt) / 1000);
		if (isFiniteNonNegative(lockedTtft)) {
			pushRecent(recentTtftSamples, lockedTtft);
		}
	}

	function updateLiveTps(now: number, delta: string): void {
		if (firstLiveDeltaAt === null) firstLiveDeltaAt = now;
		liveQueue.push({ receivedAt: now, delta });

		const cutoff = now - LIVE_TPS_WINDOW_SECONDS * 1000;
		liveQueue = liveQueue.filter((item) => item.receivedAt >= cutoff);

		const elapsed = Math.max(0, (now - firstLiveDeltaAt) / 1000);
		if (elapsed < MIN_LIVE_TPS_ELAPSED_SECONDS) return;

		const duration = Math.min(LIVE_TPS_WINDOW_SECONDS, elapsed);
		const estimatedTokens = estimateTokens(liveQueue.map((item) => item.delta).join(""));
		const tps = duration > 0 ? estimatedTokens / duration : null;
		if (!isFinitePositive(tps)) return;

		currentLiveTps = tps;
		lastValidLiveTps = tps;
	}

	function resolveSettledTps(outputTokens: number | undefined, messageEndedAt: number): SettledTps | null {
		if (isFinitePositive(outputTokens)) {
			if (firstContentDeltaAt === null) return null;
			const duration = Math.max(0, (messageEndedAt - firstContentDeltaAt) / 1000);
			if (duration < MIN_SETTLE_TPS_DURATION_SECONDS) return null;

			const tps = outputTokens / duration;
			return isFinitePositive(tps) ? { tps, source: "usage" } : null;
		}

		return isFinitePositive(lastValidLiveTps) ? { tps: lastValidLiveTps, source: "live-fallback" } : null;
	}

	function finalizeRequest(ctx: ExtensionContext, outputTokens: number | undefined): void {
		if (phase !== "waiting" && phase !== "streaming") return;

		const previousLastTps = lastSettledTps;
		phase = "settled";
		stopWaitingTimer();

		const settledTps = resolveSettledTps(outputTokens, performance.now());
		roundSettledTps = settledTps;
		if (settledTps) pushRecent(recentTpsSamples, settledTps);

		renderSettled(ctx, settledTps, previousLastTps);
		lastSettledTps = settledTps;
	}

	pi.on("session_start", async (_event, ctx) => {
		renderIdle(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		beginWaiting(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const contentDelta = getContentDelta(event);
		if (!contentDelta || (phase !== "waiting" && phase !== "streaming")) return;

		const now = performance.now();
		if (phase === "waiting") beginStreaming(now);
		if (phase !== "streaming") return;

		if (contentDelta.isLiveTpsDelta) updateLiveTps(now, contentDelta.delta);
		renderStreaming(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		finalizeRequest(ctx, event.message.usage?.output);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "waiting" || phase === "streaming") {
			lastSettledTps = null;
		}
		renderIdle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWaitingTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
