/**
 * 配置文件读取。
 *
 * 位置固定为 `<agent dir>/oh-my-tps.json`，不做项目级配置：
 * 扩展工厂执行时拿不到 `ctx`，也就无法判断项目是否被信任。
 *
 * 本模块只做结构校验，不校验颜色名是否合法——颜色名需要主题实例才能验证，
 * 那一步由入口在 `session_start` 时完成。
 * 路径由调用方传入而非在此处计算，以便测试直接指向临时文件。
 */
import { readFileSync } from "node:fs";

export const CONFIG_FILE_NAME = "oh-my-tps.json";

export interface BuiltinRendererConfig {
	/** 是否启用内置渲染器。关闭后不影响任何第三方渲染器。 */
	enabled: boolean;
	/** 整行颜色，取值为 Pi 的主题色名。合法性由入口校验。 */
	color: string;
}

export interface TpsConfig {
	builtinRenderer: BuiltinRendererConfig;
}

export const DEFAULT_CONFIG: TpsConfig = {
	builtinRenderer: { enabled: true, color: "dim" },
};

export interface ConfigLoadResult {
	config: TpsConfig;
	/** 非致命问题，调用方负责告知用户。 */
	warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取配置。文件缺失、无法解析或字段非法时回落到默认值，
 * 并把原因写进 `warnings`，绝不让状态栏因为一份坏配置而消失。
 */
export function loadConfig(path: string): ConfigLoadResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		// 文件不存在是常态，静默使用默认值。
		return { config: DEFAULT_CONFIG, warnings: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: DEFAULT_CONFIG,
			warnings: [`${path}: invalid JSON (${message}); using default configuration`],
		};
	}

	if (!isPlainObject(parsed)) {
		return { config: DEFAULT_CONFIG, warnings: [`${path}: top level must be an object; using default configuration`] };
	}

	const warnings: string[] = [];
	const config: TpsConfig = { builtinRenderer: { ...DEFAULT_CONFIG.builtinRenderer } };

	const rawRenderer = parsed.builtinRenderer;
	if (rawRenderer === undefined) return { config, warnings };

	if (!isPlainObject(rawRenderer)) {
		warnings.push(`${path}: builtinRenderer must be an object; using defaults`);
		return { config, warnings };
	}

	if (rawRenderer.enabled !== undefined) {
		if (typeof rawRenderer.enabled === "boolean") {
			config.builtinRenderer.enabled = rawRenderer.enabled;
		} else {
			warnings.push(`${path}: builtinRenderer.enabled must be a boolean; using default`);
		}
	}

	if (rawRenderer.color !== undefined) {
		if (typeof rawRenderer.color === "string" && rawRenderer.color.length > 0) {
			config.builtinRenderer.color = rawRenderer.color;
		} else {
			warnings.push(`${path}: builtinRenderer.color must be a non-empty string; using default`);
		}
	}

	return { config, warnings };
}
