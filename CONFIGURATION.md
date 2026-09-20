# Configuration and Custom Rendering

[简体中文](./CONFIGURATION.zh-CN.md) | English

This document covers how to configure `oh-my-tps` and how to customize how the readout is rendered.

## Config file

The config file lives at `~/.pi/agent/oh-my-tps.json` (affected by `PI_CODING_AGENT_DIR`). Project-level configuration is not supported. When the file is absent, all defaults apply.

```json
{
  "builtinRenderer": {
    "enabled": true,
    "color": "dim"
  }
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `builtinRenderer.enabled` | boolean | `true` | Whether to enable the built-in renderer |
| `builtinRenderer.color` | theme color name | `"dim"` | Color of the whole built-in readout line |

`builtinRenderer` refers to the built-in renderer shipped with this extension. Disabling it does not affect any custom renderer.

`color` only accepts Pi theme color names, such as `dim`, `muted`, `accent`, `text`. This is a deliberate tradeoff: supporting hex values, 256 colors, or per-theme overrides would make the config and color resolution heavier, and this is only a status-bar readout. If you need those capabilities, disable the built-in renderer and subscribe to the event bus to render it yourself.

When the file is not valid JSON, or a field type or color name is wrong, the default is used instead and a warning is shown.

Configuration changes take effect after `/reload`.

## Disabling the built-in renderer

```json
{
  "builtinRenderer": {
    "enabled": false
  }
}
```

If no other custom renderer exists, the status bar shows nothing. This is expected.

## Custom renderers

The extension core only measures data and broadcasts the results to Pi's event bus. The built-in renderer is itself a subscriber, so a custom renderer is a peer to it. With a custom renderer you can display the data any way you like, including somewhere other than the footer.

### Event contract

| Channel | Direction | Payload |
| --- | --- | --- |
| `oh-my-tps:status` | core → subscribers | `TpsStatusView`, or `null` |
| `oh-my-tps:request` | subscribers → core | none (`undefined`) |

A `null` payload on `oh-my-tps:status` means "clear the display", which differs from `phase: "idle"`: the latter means idle but still showing the recent average.

The event bus does not replay history, so a subscriber loaded after the core receives none of the earlier snapshots. Emit `oh-my-tps:request` right after subscribing; the core will immediately resend the current snapshot.

### Types

```ts
export type TpsPhase = "idle" | "waiting" | "streaming" | "settled";

/** counting: TTFT is accumulating; locked: locked for this round; average: recent average; unknown: no valid value */
export type TtftKind = "counting" | "locked" | "average" | "unknown";

/** live: current round's live value; settled: current round's settled value; last: previous round's settled value; average: recent average; unknown: no valid value */
export type TpsKind = "live" | "settled" | "last" | "average" | "unknown";

export interface TpsStatusView {
  phase: TpsPhase;
  ttft: { value: number | null; kind: TtftKind };
  tps: { value: number | null; kind: TpsKind };
  /** epoch milliseconds */
  updatedAt: number;
}
```

`value` is in seconds (TTFT) or tokens per second (TPS). When `value` is `null`, `kind` is `"unknown"`, and the renderer decides what placeholder to show.

Types and channel constants can be imported from a side-effect-free subpath:

```ts
import {
  TPS_STATUS_CHANNEL,
  TPS_REQUEST_CHANNEL,
  type TpsStatusView,
} from "oh-my-tps/events";
```

This entry contains only constants and types; it does not pull in the measurement logic or its dependencies.

### Minimal skeleton

The skeleton below is a minimal renderer. It does not use `view.ttft.kind` or `view.tps.kind`.

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
    // The bus does not replay history; pull the current snapshot after subscribing.
    pi.events.emit(TPS_REQUEST_CHANNEL, undefined);
  });

  pi.on("session_shutdown", async () => {
    ctx = undefined;
  });
}
```

### Render locations

`ctx.ui.setStatus(key, text)` has two limitations:

- Newlines and repeated spaces are collapsed, so it cannot output multiple lines.
- Statuses from multiple extensions are sorted by key and joined with spaces on a single line, so it cannot take a line of its own.

Use `ctx.ui.setWidget(key, content)` when you need multiple lines or a dedicated line.

### Other notes

- `ctx.ui.theme` is a Proxy; calling `.fg()` at render time follows the current theme automatically. Do not cache the result.
- Pi has no theme-change event. With `setStatus`, text already written is not redrawn when the theme changes; it waits for the next snapshot. A `setWidget` factory, by contrast, receives the current theme on every render.
- In RPC mode the text passed to `setStatus` is forwarded to the client verbatim. Return early on `ctx.mode !== "tui"` as the skeleton does, so ANSI sequences are not written outside a terminal.
- In `print` and `json` modes, `hasUI` is false and `setStatus` is a no-op.

### Troubleshooting

Exceptions from event bus subscribers are caught and only written to stderr; they never appear in the TUI. If the status bar does not show what you expect, first check whether your renderer is throwing: look at the Pi process's stderr, or temporarily add a `console.error` in the render function to see whether it is called at all.

Common mistakes:

- Forgetting to emit `oh-my-tps:request`, so the subscription starts after the last snapshot and receives nothing.
- Accessing `ctx` before `session_start`, when it has not been assigned yet.
- Writing to `setStatus` from both a custom renderer and the built-in renderer, so the two are joined on the same line.
