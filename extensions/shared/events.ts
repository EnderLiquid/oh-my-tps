/**
 * oh-my-tps 对外的事件契约。
 *
 * 该模块只包含常量与类型，没有任何副作用，因此可以安全地被第三方插件导入，
 * 不会连带加载测量逻辑与其依赖。包通过 `oh-my-tps/events` 子路径导出它。
 */

/** 核心广播测量结果的通道。载荷为 `TpsStatusView`，或 `null` 表示清除显示。 */
export const TPS_STATUS_CHANNEL = "oh-my-tps:status";

/** 订阅者主动拉取当前快照的通道。事件总线不回放历史，晚加载的订阅者需要这一步。 */
export const TPS_REQUEST_CHANNEL = "oh-my-tps:request";

export type TpsPhase = "idle" | "waiting" | "streaming" | "settled";

/** counting：TTFT 正在累计；locked：本轮已锁定；average：历史平均；unknown：无有效值。 */
export type TtftKind = "counting" | "locked" | "average" | "unknown";

/** live：本轮实时值；settled：本轮结算值；last：上一轮结算值；average：历史平均；unknown：无有效值。 */
export type TpsKind = "live" | "settled" | "last" | "average" | "unknown";

export interface TtftReading {
	/** 秒。`kind` 为 `"unknown"` 时为 `null`。 */
	value: number | null;
	kind: TtftKind;
}

export interface TpsReading {
	/** 每秒 token 数。`kind` 为 `"unknown"` 时为 `null`。 */
	value: number | null;
	kind: TpsKind;
}

export interface TpsStatusView {
	phase: TpsPhase;
	ttft: TtftReading;
	tps: TpsReading;
	/** 快照生成时刻的 epoch 毫秒。 */
	updatedAt: number;
}
