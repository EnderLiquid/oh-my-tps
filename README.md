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

- `τ`: TTFT, time to first token, in seconds
- `Δ`: TPS, tokens per second

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

- `A`: Average, the average final value across recent requests
- `L`: Last, the final value from the previous request

A quick way to read them:

- `τ0.8 Δ48.6`: the response is currently streaming; TTFT was about 0.8s and the current live TPS estimate is about 48.6
- `τ1.1 Δ49.7L`: the request has been sent, but streaming has not started yet; TTFT is still counting, so the extension shows the previous request's final TPS as a reference
- `τ0.8A Δ52.4A`: Pi is currently idle, so the extension shows the recent average performance

The live `Δ` shown during streaming is an estimate. The final `Δ` shown after the response ends is more trustworthy.

## How it works

This section is for people who want to know what the extension is actually measuring.

### State machine

Internally, the extension moves through four phases:

1. **waiting**: the request has been sent and is waiting for the first token
2. **streaming**: the assistant is actively streaming output
3. **settled**: the response has finished
4. **idle**: the turn is over and the extension is showing historical values

Example:

```text
idle τ… Δ? (before the very first request)
    -> waiting(req1) τ0.2 Δ? (first request in the prompt, no usable average yet, τ updates every 200ms)
    ...
-> idle τ1.5A Δ50.0A (idle, with historical averages available)
    -> waiting(req1) τ0.2 Δ50.0A  (first request in the prompt, shows average as baseline while waiting)
    -> streaming(req1) τ1.3 Δ51.0  (live Δ updates, τ is now locked)
    -> settled(req1) τ1.3 Δ52.0  (final Δ locked, τ locked)
    -> waiting(req2+) τ0.2 Δ52.0L  (second or later request in the same prompt, uses last final value as baseline)
    -> streaming(req2+) τ1.7 Δ49.0  (live Δ updates, τ locked)
    -> settled(req2+) τ1.7 Δ49.5  (final Δ locked, τ locked)
-> idle τ1.5A Δ50.0A
```

### Where `τ` comes from

`τ` is straightforward.

Once a provider request is sent, the extension enters `waiting` and refreshes the elapsed time every 200ms. The moment the first assistant streaming update arrives, that time delta is locked in as the TTFT for the request.

So in practice:

- during `waiting`, `τ` keeps increasing
- once `streaming` begins, `τ` stops changing
- the `τ` shown later in `settled`, the historical `τ` reused before the next request, and the `τ` that contributes to idle averages are all based on that final locked TTFT

### Where live `Δ` and final `Δ` come from

These two values come from different sources, and that distinction matters.

#### Live `Δ`

During streaming, the provider does not continuously tell Pi exactly how many new output tokens just arrived. That means live `Δ` has to be estimated locally.

The current implementation does this:

1. Take all assistant text that has streamed so far for the current response
2. Estimate how many tokens that text roughly corresponds to with [`tokenx`](https://github.com/johannschopplich/tokenx)
3. Divide that estimate by the elapsed streaming time

In other words, live `Δ` is essentially:

```text
estimated output tokens so far / elapsed streaming time so far
```

It is not the provider's real-time token truth. It is a local approximation meant for UI feedback.

#### Final settled `Δ`

When the response ends, if the provider returns `usage.output`, the extension uses that to compute the final TPS:

```text
final output tokens / total streaming time
```

This is usually more trustworthy than live `Δ`, because it is based on the provider's final reported output token count rather than a local estimate.

If a provider or a specific response does not return usable output token data, the extension falls back to the last live estimate as a best-effort display value.

### Why live and final values can differ

#### 1. Token estimation is heuristic

`tokenx` is not an exact tokenizer. It is a lightweight heuristic estimator. That is why it works well for fast UI updates: it is small, fast, and easy to run on every streaming update. The tradeoff is obvious: it is not designed to match every model family exactly.

`tokenx` is designed and benchmarked closer to **GPT-style tokenization / English text**. When you use other model families or output that contains non-English text, the live estimate can drift further away from the final settled value.

#### 2. Streaming itself is uneven

Model output does not arrive in the UI as a perfectly uniform token-by-token stream. The observed readout is affected by things like:

- the provider's own SSE / chunk flush strategy
- how Pi receives and surfaces updates
- structural changes caused by thinking blocks, tool calls, and normal text appearing together

So live `Δ` typically behaves like this:

- unstable at first, then gradually settles
- often approaches the final settled value, but does not perfectly match it

### Average value `A`

In the current implementation, `A` means the average final performance across the most recent 5 provider requests.

- average `τ`: the average final TTFT across those recent requests
- average `Δ`: the average settled TPS across those recent requests

### How to interpret the data

A good rule of thumb is:

- `τ`: highly useful
- settled / average `Δ`: the most useful numbers when comparing results
- live `Δ`: reflects real-time trend and perceived speed

## Where it fits

- useful as a rough quantitative reference for LLM latency and speed
- useful for quickly spotting obviously slow requests in long Pi sessions
- not meant for strict model benchmarking

## License

MIT License
