# 配置与自定义渲染

本文档说明如何配置 `oh-my-tps`，以及如何自定义状态栏的渲染方式。

## 配置文件

位置固定为 `~/.pi/agent/oh-my-tps.json`（受 `PI_CODING_AGENT_DIR` 影响），不支持项目级配置。文件不存在时全部使用默认值。

```json
{
  "builtinRenderer": {
    "enabled": true,
    "color": "dim"
  }
}
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `builtinRenderer.enabled` | boolean | `true` | 是否启用内置渲染器 |
| `builtinRenderer.color` | 主题色名 | `"dim"` | 内置渲染器的整行颜色 |

`builtinRenderer` 指本插件的内置渲染器，关闭它不影响任何自定义渲染器。

`color` 仅接受 Pi 的主题色名，例如 `dim`、`muted`、`accent`、`text`。这是刻意的取舍：支持 hex、256 色或按主题 override 会让配置与颜色解析变重，而这里只是一个状态栏读数。需要这类能力时，可以关闭内置渲染器，自行订阅事件总线渲染。

文件不是合法 JSON、字段类型或颜色名错误时，都会回退到默认值并弹出警告。

修改配置后需要 `/reload` 才会生效。

## 关闭内置渲染器

```json
{
  "builtinRenderer": {
    "enabled": false
  }
}
```

关闭后若没有其它自定义渲染器，状态栏不显示任何内容，这是预期行为。

## 自定义渲染器

本插件核心只负责测量数据并把结果广播到 Pi 的事件总线。内置渲染器也是一个订阅者，因此自定义渲染器与它是对等关系。通过实现自定义渲染器，你可以用任意方式显示数据，包括 footer 以外的位置。

### 事件契约

| 通道 | 方向 | 载荷 |
| --- | --- | --- |
| `oh-my-tps:status` | 核心 → 订阅者 | `TpsStatusView`，或 `null` |
| `oh-my-tps:request` | 订阅者 → 核心 | 无（`undefined`） |

`oh-my-tps:status` 的载荷为 `null` 时表示清除显示，与 `phase: "idle"` 不同：后者表示空闲但仍应显示最近的平均值。

事件总线不回放历史，晚于核心加载的订阅者收不到此前的快照。因此订阅后应立即发出一次 `oh-my-tps:request`，核心会随即重发当前快照。

### 类型

```ts
export type TpsPhase = "idle" | "waiting" | "streaming" | "settled";

/** counting: TTFT 正在累计；locked: 本轮已锁定；average: 历史平均；unknown: 无有效值 */
export type TtftKind = "counting" | "locked" | "average" | "unknown";

/** live: 本轮实时值；settled: 本轮结算值；last: 上一轮结算值；average: 历史平均；unknown: 无有效值 */
export type TpsKind = "live" | "settled" | "last" | "average" | "unknown";

export interface TpsStatusView {
  phase: TpsPhase;
  ttft: { value: number | null; kind: TtftKind };
  tps: { value: number | null; kind: TpsKind };
  /** epoch 毫秒 */
  updatedAt: number;
}
```

`value` 的单位是秒（TTFT）或每秒 token 数（TPS）。`value` 为 `null` 时 `kind` 为 `"unknown"`，显示什么占位内容由渲染器决定。

类型与通道常量可从无副作用的子路径导入：

```ts
import {
  TPS_STATUS_CHANNEL,
  TPS_REQUEST_CHANNEL,
  type TpsStatusView,
} from "oh-my-tps/events";
```

该入口只含常量与类型，不会连带加载测量逻辑及其依赖。

### 最小骨架

以下骨架是渲染器的最小实现，其中 view.ttft.kind 与 view.tps.kind 未被使用。

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TPS_STATUS_CHANNEL,
  TPS_REQUEST_CHANNEL,
  type TpsStatusView,
} from "oh-my-tps/events";

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;

  const render = (view: TpsStatusView | null) => {
    if (!ctx?.hasUI || ctx.mode !== "tui") return;

    if (!view) {
      ctx.ui.setStatus("my-tps", undefined);
      return;
    }

    const ttft = view.ttft.value === null ? "τ…" : `τ${view.ttft.value.toFixed(1)}`;
    const tps = view.tps.value === null ? "Δ?" : `Δ${view.tps.value.toFixed(1)}`;
    ctx.ui.setStatus("my-tps", ctx.ui.theme.fg("dim", `${ttft} ${tps}`));
  };

  pi.events.on(TPS_STATUS_CHANNEL, (data) => render(data as TpsStatusView | null));

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    // 总线不回放历史，订阅后主动拉取一次当前快照
    pi.events.emit(TPS_REQUEST_CHANNEL, undefined);
  });

  pi.on("session_shutdown", async () => {
    ctx = undefined;
  });
}
```

### 渲染位置

`ctx.ui.setStatus(key, text)` 有两项限制：

- 文本会被压平换行与连续空格，无法输出多行。
- 多个插件的状态按 key 字母序排序后空格拼接在同一行，无法独占一行。

需要多行或独占一行时，改用 `ctx.ui.setWidget(key, content)`。

### 其它要点

- `ctx.ui.theme` 是 Proxy，在渲染时刻调用 `.fg()` 会自动跟随当前主题，不要缓存其结果。
- Pi 没有主题切换事件。使用 `setStatus` 时，已写入的静态文本不会因切换主题而重绘，需等待下一次快照；使用 `setWidget` 的工厂函数则每次渲染都会收到当前主题。
- RPC 模式下 `setStatus` 的文本会原样转发给客户端，建议按上面的骨架以 `ctx.mode !== "tui"` 提前返回，避免把 ANSI 序列写入非终端场景。
- `print` / `json` 模式下 `hasUI` 为 false，`setStatus` 是空操作。

### 排错

事件总线的订阅者异常会被捕获，仅输出到 stderr，不会显示在 TUI 中。若状态栏没有出现预期内容，先确认渲染器是否抛错：查看 Pi 进程的 stderr 输出，或临时在渲染函数中加 `console.error` 观察是否被调用。

常见错误：

- 忘记发出 `oh-my-tps:request`，导致订阅晚于最后一次快照而收不到数据。
- 在 `session_start` 之前访问 `ctx`，此时尚未赋值。
- 自定义渲染器与内置渲染器同时写入 `setStatus`，两者被拼接在同一行。
