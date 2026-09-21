/**
 * 内置渲染器：把快照画成 `τ0.8 Δ48.6` 写入 footer。
 *
 * 它与第三方渲染器一样是事件总线的订阅者，只是随插件一起加载。
 * 可通过配置里的 `builtinRenderer.enabled` 关闭。
 */
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TpsStatusView } from "./events.js";

const STATUS_KEY = "oh-my-tps";
const UNKNOWN_TTFT_LABEL = "τ…";
const UNKNOWN_DELTA_LABEL = "Δ?";

/** 后缀含义：`A` 为平均值，`L` 为上一轮结算值。 */
const AVERAGE_SUFFIX = "A";
const LAST_SUFFIX = "L";

function formatNumber(value: number): string {
	return value.toFixed(1);
}

function formatTtft(view: TpsStatusView): string {
	const { value, kind } = view.ttft;
	if (value === null) return UNKNOWN_TTFT_LABEL;
	const suffix = kind === "average" ? AVERAGE_SUFFIX : "";
	return `τ${formatNumber(value)}${suffix}`;
}

function formatTps(view: TpsStatusView): string {
	const { value, kind } = view.tps;
	if (value === null) return UNKNOWN_DELTA_LABEL;
	const suffix = kind === "average" ? AVERAGE_SUFFIX : kind === "last" ? LAST_SUFFIX : "";
	return `Δ${formatNumber(value)}${suffix}`;
}

/** 把快照格式化为 footer 文本，不含颜色。 */
export function formatStatusText(view: TpsStatusView): string {
	return `${formatTtft(view)} ${formatTps(view)}`;
}

export interface BuiltinRendererOptions {
	/** 整行颜色。传入主题不认识的色名时抛出，由调用方处理。 */
	color: ThemeColor;
}

export interface BuiltinRenderer {
	render(view: TpsStatusView | null): void;
	/** 清除已写入的状态。 */
	clear(): void;
}

export function createBuiltinRenderer(ctx: ExtensionContext, options: BuiltinRendererOptions): BuiltinRenderer {
	function clear(): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	return {
		clear,
		render(view) {
			if (!ctx.hasUI) return;
			if (view === null) {
				clear();
				return;
			}

			const text = formatStatusText(view);
			// RPC 会把文本原样转发给客户端，非终端场景不应写入 ANSI 序列。
			if (ctx.mode !== "tui") {
				ctx.ui.setStatus(STATUS_KEY, text);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(options.color, text));
		},
	};
}
