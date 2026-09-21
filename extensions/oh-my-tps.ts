/**
 * oh-my-tps 插件入口。
 *
 * 本文件只做 Pi 适配：把 Pi 的事件转换为测量核心的调用，
 * 并把核心产出的快照广播到事件总线。渲染逻辑不在这里，
 * 内置渲染器与第三方渲染器一样，都是总线的订阅者。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createBuiltinRenderer } from "./shared/builtin-renderer.js";
import { CONFIG_FILE_NAME, loadConfig } from "./shared/config.js";
import { TPS_REQUEST_CHANNEL, TPS_STATUS_CHANNEL, type TpsStatusView } from "./shared/events.js";
import { createTpsMeasurement, type TpsMeasurement } from "./shared/measurement.js";

/**
 * 校验配置里的颜色名。
 *
 * 主题实例只在渲染时才有意义，且 Pi 的主题色集合会随版本增删，
 * 因此不用静态列表校验，而是探测当前主题是否认识该色名。
 */
function resolveThemeColor(ctx: ExtensionContext, color: string): ThemeColor {
	try {
		ctx.ui.theme.fg(color as ThemeColor, "");
		return color as ThemeColor;
	} catch {
		ctx.ui.notify(`oh-my-tps: unknown theme color "${color}"; falling back to "dim"`, "warning");
		return "dim";
	}
}

export default function ohMyTps(pi: ExtensionAPI): void {
	let measurement: TpsMeasurement | undefined;
	let statusUnsubscribe: (() => void) | undefined;

	// 订阅者可能在 session_start 之前就发出拉取请求，因此监听器在工厂阶段注册。
	pi.events.on(TPS_REQUEST_CHANNEL, () => {
		measurement?.refresh();
	});

	// session_start 在 new / resume / fork 时会重复触发，先释放上一轮的订阅与计时器。
	function teardown(): void {
		measurement?.stop();
		measurement = undefined;
		statusUnsubscribe?.();
		statusUnsubscribe = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		teardown();

		const { config, warnings } = loadConfig(join(getAgentDir(), CONFIG_FILE_NAME));
		for (const warning of warnings) {
			ctx.ui.notify(warning, "warning");
		}

		if (config.builtinRenderer.enabled) {
			const color = resolveThemeColor(ctx, config.builtinRenderer.color);
			const renderer = createBuiltinRenderer(ctx, { color });
			statusUnsubscribe = pi.events.on(TPS_STATUS_CHANNEL, (data) => {
				renderer.render((data ?? null) as TpsStatusView | null);
			});
		}

		measurement = createTpsMeasurement({
			sink: (view) => {
				pi.events.emit(TPS_STATUS_CHANNEL, view);
			},
		});
		measurement.start();
	});

	pi.on("before_provider_request", async () => {
		measurement?.beginWaiting();
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		measurement?.handleMessageUpdate(event);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		measurement?.finalize(event.message.usage?.output);
	});

	pi.on("agent_end", async () => {
		measurement?.handleAgentEnd();
	});

	pi.on("session_shutdown", async () => {
		teardown();
	});
}
