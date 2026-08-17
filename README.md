# Oh My TPS

English | [简体中文](./README.zh-CN.md)

## Install

### npm package

```bash
pi install npm:oh-my-tps
```

### Git repository

```bash
pi install git:github.com/EnderLiquid/oh-my-tps
```

## What it does

`oh-my-tps` does one thing:
it adds a tiny live speed readout to the Pi TUI so you can see first-token latency and output speed while the model is responding.

- `τ`: TTFT, how long it takes for the first token to arrive, in seconds
- `Δ`: TPS, tokens output per second

What it looks like:

```text
τ0.8 Δ48.6
```

That's it.

Ten characters. It just works.

If you want, you can keep reading for the details—but at this point you already know how to use it.

## Reading the numbers

You will see readings like these in the TUI footer area:

```text
τ0.8 Δ48.6
τ1.1 Δ49.7L
τ0.8A Δ52.4A
```

Suffixes:

- `A`: Average. TTFT and TPS maintain separate histories.
- `L`: Last valid final TPS from the previous round, used only for `Δ`.

Here is how to read them:

- `τ0.8 Δ48.6`: the response is streaming, TTFT was about 0.8 seconds, and a valid current live TPS is available.
- `τ1.1 Δ49.7L`: the request has been sent, but the first token has not arrived yet. TTFT is still counting, while `Δ` temporarily shows the previous round's last valid final TPS.
- `τ0.8A Δ52.4A`: Pi is idle and shows recent averages for TTFT and TPS.

While a response is streaming, `Δ` may still show the previous TPS, the average TPS, or an unknown value until live TPS satisfies its initial calculation condition. When a response ends, `Δ` prefers the provider's `usage.output`; it uses the last valid live TPS only when no usable `usage.output` is available. When the current round has no valid final TPS, the final state falls back to the previous-round TPS from before this request, then to the average TPS.

## How it works

This section is for readers who want to understand what the extension measures.

### State machine

Internally, the extension has four phases:

1. **Waiting**: a request has been sent and is waiting for the first token.
2. **Streaming**: the first token has arrived and the response is streaming.
3. **Final**: the response has ended and the TPS settlement attempt for this round is complete.
4. **Idle**: no provider request is currently being processed.

Example:

```text
idle τ… Δ? (no historical samples yet)
    -> waiting τ0.2 Δ? (waiting for the first token; τ updates every 200ms)
    -> streaming τ1.3 Δ? (the first token may have come from thinking; τ is locked and live TPS is not ready yet)
    -> streaming τ1.3 Δ51.0 (a new non-thinking delta arrived and live TPS has met the observation condition)
    -> final τ1.3 Δ52.0 (this round's valid final TPS came from `usage.output` or the live-TPS fallback)
    -> idle τ1.3A Δ52.0A
    -> waiting τ0.2 Δ52.0L (prefer the previous round's last valid final TPS)
```

### Where `τ` comes from

TTFT is the time from sending a request until the first token arrives.

The extension uses the first non-empty streaming delta that carries tokens as its observable signal. These events trigger TTFT when `delta.length > 0`:

- `text_delta`
- `thinking_delta`
- `toolcall_delta`

These events do not trigger TTFT:

- `text_start`
- `thinking_start`
- `toolcall_start`
- Empty deltas and other metadata events

After the first valid delta arrives, the extension locks the difference between that moment and the request start time as the TTFT for this round.

In practice:

- `τ` keeps increasing during the waiting phase.
- Once the first text, thinking, or tool-call token arrives, the extension enters the streaming phase and locks `τ`.
- Metadata such as `thinking_start` does not end the wait, but a non-empty `thinking_delta` does.
- If a provider encrypts thinking content and does not transmit thinking deltas, the extension can measure TTFT only to the first observable token; it cannot recover the internal timing of the hidden thinking phase.

TTFT and TPS histories are maintained independently. As soon as the first token arrives, the round can contribute to the TTFT average even if it ultimately has no valid TPS.

### Where live `Δ` comes from

Providers do not continuously tell Pi exactly how many tokens they just generated, so live TPS must be estimated locally. The current implementation uses a rolling queue of non-thinking deltas:

- Includes non-empty `text_delta` events.
- Includes non-empty `toolcall_delta` events.
- Excludes every `thinking_delta`, including thinking summaries.

The default window is the most recent 5 seconds. Whenever a new non-thinking delta arrives, the extension:

1. Adds the raw delta and its arrival time to the queue.
2. Removes entries outside the window.
3. Concatenates the deltas currently in the window in arrival order.
4. Uses [`tokenx`](https://github.com/johannschopplich/tokenx) to estimate the token count of that concatenated content.
5. Divides the window's token count by the observation duration to produce a new live TPS.

The formula is:

```text
live TPS = estimated tokens from non-thinking deltas in the recent window
           /
           min(5 seconds, observation duration since the first non-thinking delta)
```

The extension observes at least 2 seconds from the first non-thinking delta before calculating live TPS for the first time. This avoids unusually high values caused by a tiny denominator at the start of streaming or by a provider flushing its initial buffered content all at once.

Live TPS is the delivery rate of response text and tool arguments in the recent window. It is recalculated only when a new non-thinking delta arrives; no background timer is used.

### Where final `Δ` comes from

When a response ends, the extension settles TPS in this order.

#### 1. Provider `usage.output`

When the provider returns a finite positive `usage.output`, and at least 2 seconds have passed from the first non-empty text, thinking, or tool-call delta to the end of the response, the extension uses:

```text
final TPS = usage.output
            /
            (response end time - first valid content delta time)
```

`usage.output` is usually the provider-reported count of real output tokens and may include reasoning tokens. Therefore, its numerator may include thinking tokens, while its denominator starts at the first observable content delta.

For models with encrypted thinking, hidden thinking may have occurred before the first observable delta. The client cannot know the duration of that hidden reasoning, so final TPS from `usage.output` may be slightly higher than the true value.

#### 2. Live-TPS fallback

Only when the provider has no usable `usage.output` does the extension use the last valid live TPS from the current round:

```text
final TPS = last valid live TPS from the current round
```

This source excludes thinking and reflects only the recent-window output rate for text and tool arguments.

If the provider returns a usable `usage.output`, but fewer than 2 seconds have elapsed from the first valid content delta to the response end, the extension does not switch to the live-TPS fallback. That round has no valid final TPS.

### Why live and final values can differ

#### 1. Token estimation is heuristic

`tokenx` is not an exact tokenizer. It is a lightweight, heuristic estimator. Its advantage is that it is small and fast enough for live UI updates. The tradeoff is clear: it is not designed to align exactly with every model.

`tokenx` is designed and benchmarked more closely around **GPT tokenization / English text**. The estimate can drift further when using other model families or output containing non-English text.

#### 2. Streaming output is uneven

Model output does not arrive in the UI at a perfectly uniform rate, one token at a time. The observed rate is affected by factors such as:

- The provider's SSE / chunk flush strategy.
- How Pi publishes events.
- Structural changes caused by thinking, tool calls, and normal text appearing together.

#### 3. The two TPS values measure different scopes

Live TPS and final TPS from `usage.output` are defined differently:

- Live TPS counts only non-thinking text and tool calls in the recent window.
- Final TPS from `usage.output` uses provider-reported output tokens and the time from the first text, thinking, or tool-call delta to response end.
- Live TPS excludes thinking, while final TPS from `usage.output` may include reasoning tokens.

So the two values need not match even when neither has estimation error. The live value reflects the output cadence near the end of the current response, while the final value reflects the overall observable streaming phase of the round.

### Average value `A`

The extension maintains up to five TTFT samples and five TPS samples separately:

- TTFT can enter its history once the first token arrives.
- TPS enters its history only when the round has a valid final TPS.
- Final TPS calculated from the provider's `usage.output`, as well as final TPS from the live-TPS fallback, both enter the average TPS.
- A request can therefore contribute TTFT without contributing TPS.

`A` is the average of recent valid samples. It does not guarantee that the TTFT and TPS averages come from exactly the same set of requests, nor that every TPS sample in the average uses the same token scope.

### How to interpret the data

A good rule of thumb is:

- `τ`: highly useful for observing request latency.
- Final / average `Δ`: useful for observing recent overall output-speed performance.
- Live `Δ`: useful for observing the current real-time output speed of response text or tool arguments.

## Where it fits

- Useful as a rough quantitative reference for LLM speed and latency.
- Useful for quickly spotting an obviously slow request in a long session.
- Not intended for strict model-performance comparisons or benchmarking.

## License

MIT License
