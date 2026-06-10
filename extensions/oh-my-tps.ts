import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectAssistantText, type AssistantContentBlock } from "./shared/content.js";
import { estimateTokens } from "./shared/token-estimator.js";

const STATUS_KEY = "oh-my-tps";
const WAITING_UPDATE_MS = 200;
const MIN_STREAM_SECONDS = 0.1;
const MAX_RECENT_SAMPLES = 5;
const UNKNOWN_DELTA_LABEL = "Δ?";
const UNKNOWN_TTFT_LABEL = "τ…";
const EMPTY_STATUS_LABEL = `${UNKNOWN_TTFT_LABEL} ${UNKNOWN_DELTA_LABEL}`;

type RequestPhase = "idle" | "waiting" | "streaming" | "settled";

type RequestSample = {
	tps: number;
	ttft: number;
};

function formatNumber(value: number): string {
	return value.toFixed(1);
}

function isFinitePositive(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export default function ohMyTps(pi: ExtensionAPI): void {
	let phase: RequestPhase = "idle";
	let requestIndexInPrompt = 0;
	let requestStartedAt = 0;
	let streamStartedAt = 0;
	let lockedTtft: number | null = null;
	let lastLiveTps: number | null = null;
	let lastFinalTps: number | null = null;
	let recentSamples: RequestSample[] = [];
	let waitingTimer: NodeJS.Timeout | undefined;
	let currentWaitingDeltaLabel = UNKNOWN_DELTA_LABEL;
	let lastMessageText = "";

	function stopWaitingTimer(): void {
		if (waitingTimer) clearInterval(waitingTimer);
		waitingTimer = undefined;
	}

	function setStatus(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function getAverageSample(): RequestSample | null {
		if (recentSamples.length === 0) return null;
		let totalTps = 0;
		let totalTtft = 0;
		for (const sample of recentSamples) {
			totalTps += sample.tps;
			totalTtft += sample.ttft;
		}
		return {
			tps: totalTps / recentSamples.length,
			ttft: totalTtft / recentSamples.length,
		};
	}

	function pushSample(sample: RequestSample): void {
		recentSamples.push(sample);
		if (recentSamples.length > MAX_RECENT_SAMPLES) {
			recentSamples = recentSamples.slice(-MAX_RECENT_SAMPLES);
		}
	}

	function renderIdle(ctx: ExtensionContext): void {
		phase = "idle";
		stopWaitingTimer();
		const avg = getAverageSample();
		if (!avg) {
			setStatus(ctx, EMPTY_STATUS_LABEL);
			return;
		}
		setStatus(ctx, `τ${formatNumber(avg.ttft)}A Δ${formatNumber(avg.tps)}A`);
	}

	function selectWaitingDeltaLabel(): string {
		if (requestIndexInPrompt <= 1) {
			const avg = getAverageSample();
			return avg ? `Δ${formatNumber(avg.tps)}A` : UNKNOWN_DELTA_LABEL;
		}
		if (isFinitePositive(lastFinalTps)) {
			return `Δ${formatNumber(lastFinalTps)}L`;
		}
		const avg = getAverageSample();
		return avg ? `Δ${formatNumber(avg.tps)}A` : UNKNOWN_DELTA_LABEL;
	}

	function renderWaiting(ctx: ExtensionContext): void {
		stopWaitingTimer();
		const update = () => {
			const elapsed = Math.max(0, (performance.now() - requestStartedAt) / 1000);
			setStatus(ctx, `τ${formatNumber(elapsed)} ${currentWaitingDeltaLabel}`);
		};
		update();
		waitingTimer = setInterval(update, WAITING_UPDATE_MS);
	}

	function renderStreaming(ctx: ExtensionContext, estimatedTps: number | null): void {
		const ttftLabel = isFinitePositive(lockedTtft) ? `τ${formatNumber(lockedTtft)}` : UNKNOWN_TTFT_LABEL;
		const deltaLabel = isFinitePositive(estimatedTps) ? `Δ${formatNumber(estimatedTps)}` : currentWaitingDeltaLabel;
		setStatus(ctx, `${ttftLabel} ${deltaLabel}`);
	}

	function beginWaiting(ctx: ExtensionContext): void {
		requestIndexInPrompt += 1;
		phase = "waiting";
		requestStartedAt = performance.now();
		streamStartedAt = 0;
		lockedTtft = null;
		lastLiveTps = null;
		lastMessageText = "";
		currentWaitingDeltaLabel = selectWaitingDeltaLabel();
		renderWaiting(ctx);
	}

	function beginStreaming(now: number): void {
		phase = "streaming";
		stopWaitingTimer();
		streamStartedAt = now;
		lockedTtft = requestStartedAt > 0 ? Math.max(0, (now - requestStartedAt) / 1000) : null;
	}

	function finalizeRequest(ctx: ExtensionContext, outputTokens: number): void {
		phase = "settled";
		stopWaitingTimer();

		const elapsed = streamStartedAt > 0 ? Math.max(0, (performance.now() - streamStartedAt) / 1000) : 0;
		let finalTps: number | null = null;
		if (elapsed > 0 && outputTokens > 0) {
			finalTps = outputTokens / elapsed;
		} else if (isFinitePositive(lastLiveTps)) {
			finalTps = lastLiveTps;
		}

		if (isFinitePositive(finalTps)) {
			lastFinalTps = finalTps;
		}

		if (isFinitePositive(finalTps) && isFinitePositive(lockedTtft)) {
			pushSample({ tps: finalTps, ttft: lockedTtft });
		}

		const ttftLabel = isFinitePositive(lockedTtft) ? `τ${formatNumber(lockedTtft)}` : UNKNOWN_TTFT_LABEL;
		const deltaLabel = isFinitePositive(finalTps) ? `Δ${formatNumber(finalTps)}` : currentWaitingDeltaLabel;
		setStatus(ctx, `${ttftLabel} ${deltaLabel}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		requestIndexInPrompt = 0;
		renderIdle(ctx);
	});

	pi.on("agent_start", async () => {
		requestIndexInPrompt = 0;
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		beginWaiting(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const now = performance.now();
		if (phase === "waiting") {
			beginStreaming(now);
		}

		const currentText = collectAssistantText(event.message as { content?: AssistantContentBlock[] });
		lastMessageText = currentText;

		const elapsed = streamStartedAt > 0 ? (now - streamStartedAt) / 1000 : 0;
		let estimatedTps: number | null = null;
		if (elapsed >= MIN_STREAM_SECONDS && lastMessageText.length > 0) {
			const estimatedTokens = estimateTokens(lastMessageText);
			estimatedTps = estimatedTokens / elapsed;
			if (isFinitePositive(estimatedTps)) {
				lastLiveTps = estimatedTps;
			}
		}

		renderStreaming(ctx, estimatedTps);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const outputTokens = event.message.usage?.output ?? 0;
		finalizeRequest(ctx, outputTokens);
	});

	pi.on("agent_end", async (_event, ctx) => {
		renderIdle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWaitingTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
