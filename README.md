# @argszero/dsh-image-price-fallback

Prices request images for the token meter on LLM routes whose adapter declares no
image pricing — the routes where an image-heavy session's history is priced by the
length of its own JSON reference, and compaction therefore never fires on the
conversation body.

Cordis plugin for
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## The problem

`LlmAdapter.imageRequestPricing()` is part of the adapter contract, and its default
answer is `undefined`:

```ts
// packages/llm/llm/src/index.ts
/**
 * Resolve provider-side request-image pricing for one exact model route.
 * The default declares none, so consumers fall back to their own neutral
 * estimate. Implementations must answer synchronously without I/O; the
 * token meter resolves this per measurement.
 */
imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
  return undefined
}
```

The token meter is that consumer, and it asks the route on every measurement:

```ts
// packages/llm/token-meter/src/index.ts
/** Resolve the routed model's image pricing, when the llm service and route declare one. */
private _routeImagePricing(header: EpochHeader | undefined): LlmImageRequestPricing | undefined {
  const config = header?.config
  if (config === undefined) return undefined
  return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
}
```

An answer of `undefined` is not an error — it is the documented instruction to fall
back to the meter's own neutral estimate. For an image block that estimate is the
JSON length of the reference:

```ts
// packages/llm/token-meter/src/estimate.ts
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}
```

with `BLOCK_OVERHEAD = 4` and `CHARS_PER_TOKEN = 4`. A durable image reference
serializes to a few dozen characters, so a retained image is priced at a few dozen
tokens while the provider charges a thousand or more.

The built-in DeepSeek adapter implements the method. The `pi-ai` adapter — the one
behind every OpenAI-compatible and Anthropic-compatible gateway route, which is the
ordinary path for third-party models — overrides `providerInfo`,
`providerRetryPolicy`, `listModels`, `resolveModel` and `prepareCall`, and inherits
the base `undefined`. Its `resolveModel()` still reports the model's real
`inputModalities`, image included, so the request really does carry the pixels while
the meter prices them as a string.

### Where that becomes visible

Two quantities are affected, and only one of them has a safety net.

The session total is anchor-corrected: on steps whose request header matches the
last provider-anchored one, the gate compares real usage against the compaction
threshold, so the *trigger* still sees the truth.

The per-node prices are not. They are what compaction's range selection reads to
decide which span to summarize, so an image-heavy span priced in the tens of tokens
per image is priced as cheap and is left in place. That is the reported symptom:
compaction never selects the actual conversation body in an image-heavy session.

## The seam

One property, on one object: the `llm` service instance that every
`ctx.get('llm')` view reads.

```ts
// what the plugin writes, in effect
const previous = instance.imageRequestPricing          // the route's own implementation
instance.imageRequestPricing = (provider, model) => {
  const own = previous(provider, model)                // the route answers first, always
  return own === undefined ? fallback(provider, model) : own
}
```

`LlmRuntime.imageRequestPricing` is the single funnel every route passes through —

```ts
// packages/llm/llm/src/index.ts
imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
  return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
}
```

— so patching that one method covers every adapter, including ones written later.

Three rules the plugin will not break:

- **A route that declares its own pricing is never second-guessed.** The route's
  answer wins whenever it is not `undefined`.
- **A model that cannot receive an image is never priced.** `resolveModelInfo()` is
  consulted, and a route that reports no `image` modality is left exactly as it is.
- **An unresolved modality is left alone, not guessed.** Modality is resolved
  asynchronously and cached, so the first measurement of a route — and any
  measurement taken before the resolution lands — reports what it reports today.
  Every later measurement is priced.

Mounts stack. Every layer calls the route implementation the first mount found, and
the outermost live layer owns the property, so mounting a second time takes effect
and unmounting it re-installs the first. Unmounting the last layer restores the
descriptor the first mount found, so a route with no own property gets the prototype
method back rather than a permanent shadow.

## Install

```sh
npm install @argszero/dsh-image-price-fallback
```

Mount it from a profile with the bundle patch this package ships:

```yaml
# cordis.patch.yml (the three lines below are the whole patch)
- insert:
    - id: image-price-fallback
      name: '@argszero/dsh-image-price-fallback'
```

Or mount it directly:

```ts
ctx.plugin(await import('@argszero/dsh-image-price-fallback'), { divisor: 750 })
```

## Configuration

Every field is optional. Defaults are the published rates, and each is a knob so a
gateway can be calibrated from configuration rather than from a patch.

| field | default | meaning |
|---|---|---|
| `mode` | `'auto'` | `auto` prices routes that declare no pricing; `off` mounts nothing at all. |
| `divisor` | `750` | Pixels per estimated visual token. Applied as `width * height / divisor`. 750 is the rate Anthropic publishes for its vision accounting. |
| `minTokens` | `85` | Lowest estimate charged for one retained image — OpenAI's low-detail base cost. |
| `maxTokens` | `1600` | Highest estimate charged for one retained image. |
| `providers` | `[]` (every route) | Provider routes to price. A route not named here is left alone. |
| `log` | `'summary'` | `summary` writes one line per priced route, the first time it is priced; `off` writes nothing. |

An unusable field is **refused rather than repaired**: a `divisor` of `0` fails the
mount instead of silently becoming the default, because a calibration knob that
quietly ignores what it was set to is how a wrong number becomes a mystery.

The mount line states what it wrapped and at what rate, and each priced route is
announced once:

```
image-price-fallback: wrapping LlmRuntime.imageRequestPricing; routes that declare no pricing are priced at ceil(width * height / 750) clamped to 85..1600
image-price-fallback: gateway/vision declares no request-image pricing but accepts images; pricing each retained image at ceil(width * height / 750) clamped to 85..1600
```

For a plugin whose whole effect is a number, that line is the only durable answer to
"is it working?".

## Honest boundaries

- **This is an estimate, not a measurement.** A price must be answered synchronously
  on every measurement — the meter resolves it inside `measure()` — so no tokenizer
  for an unknown gateway model can be called. The plugin prices from the durable
  reference's normalized `width` and `height`, which is the input every published
  vision accounting is built from. The point is to stop pricing a retained image at
  the length of its own reference; it is a floor in the right order of magnitude,
  and no more.
- **A retained image is charged pixels and no text.** The DeepSeek adapter adds the
  handle line its serializer ships beside the image. No such line is known to exist
  on an unknown gateway route, and inventing one would quote text the model never
  reads.
- **An offloaded occurrence is charged nothing.** The runtime replaces it with a
  placeholder instead of sending pixels, so its price is `visualTokens: 0` and the
  placeholder text is taken from the harness's own `offloadedImageText()` rather
  than re-spelled here.
- **One route's first measurement is left as it was.** Modality is resolved off the
  measurement path; until it lands, the plugin answers exactly what the meter
  answers today. Real sessions measure on every step long before compaction
  decides, so this is a warm-up, not a hole.
- **The plugin prices images, not routes.** If a route under-charges images for a
  reason that is not "the adapter never implemented the method" — a provider that
  bills vision by a different rule — the `divisor`, `minTokens` and `maxTokens`
  knobs are the answer, not a route-specific branch here.

## Tests

```sh
npm test                 # the suite
npm run test:inject      # defect injection: every arm must be caught
npm run test:probe-lines # every harness line the peer range claims
```

The suite runs against a **real** `LlmRuntime`, a **real** `TokenMeter` and a real
durable `Session` inside a real cordis `Context`. The number it asserts on is the
number the meter reports, and every arm has a control measurement taken with the
plugin absent — so "the number moved" is measured as "the plugin moved it".

`test:inject` mutates the source one distinction at a time, rebuilds, and requires
that the suite catches the mutation. An arm that leaves the suite green is reported
as a failure of the harness rather than hidden: 23 arms, all caught, none silent.
The arms that matter most are the two-mount stack (a second mount that defers to the
first is mounted, logged and inert) and the three deferrals — a declared price, a
model that cannot receive an image, and an unresolved modality are each one edit
away from being overwritten.

## Compatibility

Peer ranges, quoted verbatim:

```json
"@deepseek-ai/cordis": "^4.0.2",
"@deepseek-ai/dsh-llm": ">=0.1.7-rc.2 <0.1.8 || >=0.2.0-rc.1 <0.2.1 || >=0.2.1-alpha.1 <0.3.0"
```

Verified against these harness lines, each by pinning **every** harness package in
the line's closure, installing, building and running the suite in a scratch tree:

- `0.1.7-rc.2`
- `0.2.0-rc.2`
- `0.2.1-alpha.2`

`@deepseek-ai/dsh-llm` is a peer rather than a dependency on purpose: the plugin
patches a service instance, and a `dependencies` entry is how a deployment ends up
with a second copy of the package that defines that instance's types — a copy whose
wrapping reaches nothing the host is listening to.

## License

MIT
