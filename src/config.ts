/**
 * The configuration surface of the image-price fallback.
 *
 * Every field is optional and every default is stated here rather than implied
 * by the code that reads it, because the numbers are the plugin's whole
 * opinion: they are the per-image visual-token estimate a route that declares
 * no pricing is charged. `divisor`, `minTokens` and `maxTokens` are the
 * calibration knobs a route can be tuned with, which is the affordance the
 * source report asked for — an operator must be able to correct the estimate
 * for a gateway from configuration, without a patch to the plugin.
 *
 * @module @argszero/dsh-image-price-fallback/config
 */

/** Whether the fallback prices routes nobody claims, or is mounted inert. */
export type FallbackMode = 'auto' | 'off'

/**
 * How much is logged. `summary` writes one line per route, the first time this
 * plugin prices one, which is the only durable answer to "is it working?" for a
 * plugin that changes a number rather than an outcome.
 */
export type FallbackLog = 'off' | 'summary'

/** The plugin's configuration, as written in a profile patch. */
export interface Config {
  /** `auto` (default) prices routes that declare no pricing; `off` mounts nothing. */
  mode?: FallbackMode
  /**
   * Pixels per estimated visual token. Applied as `width * height / divisor`.
   * Default `750` — the rate Anthropic publishes for its vision accounting.
   */
  divisor?: number
  /** Lowest visual-token estimate charged for one retained image. Default `85` — OpenAI's low-detail base cost. */
  minTokens?: number
  /** Highest visual-token estimate charged for one retained image. Default `1600`. */
  maxTokens?: number
  /** Provider routes to price. Empty (the default) means every route that declares no pricing of its own. */
  providers?: readonly string[]
  /** `summary` (default) logs one line per priced route; `off` logs nothing. */
  log?: FallbackLog
}

/** The resolved settings every decision reads. */
export interface Settings {
  readonly mode: FallbackMode
  readonly divisor: number
  readonly minTokens: number
  readonly maxTokens: number
  readonly providers: readonly string[]
  readonly log: FallbackLog
}

/**
 * The defaults, exported so a host can render them and a test can pin them.

 * Deliberately **not** exported as the plugin's `Config`: cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`. The entry point exports
 * `{ name, inject, apply }` with no `Config`, and these defaults arrive through
 * `apply(ctx, config = {})`.
 */
export const defaultConfig: Settings = {
  mode: 'auto',
  divisor: 750,
  minTokens: 85,
  maxTokens: 1600,
  providers: [],
  log: 'summary',
}

/** `True` for a usable finite number above zero. */
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Resolve one configuration into the settings every decision reads.
 *
 * An unusable number is refused rather than repaired: silently substituting a
 * default for a divisor an operator typed is how a calibration knob becomes a
 * mystery. Only omissions fall back to {@link defaultConfig}.
 * @param config - the plugin configuration.
 * @returns the resolved settings.
 * @throws when a supplied field is not usable.
 */
export function normalizeConfig(config: Config = {}): Settings {
  const mode = config.mode ?? defaultConfig.mode
  if (mode !== 'auto' && mode !== 'off') {
    throw new TypeError(`image-price-fallback: mode must be 'auto' or 'off', received ${JSON.stringify(config.mode)}`)
  }
  const log = config.log ?? defaultConfig.log
  if (log !== 'off' && log !== 'summary') {
    throw new TypeError(`image-price-fallback: log must be 'off' or 'summary', received ${JSON.stringify(config.log)}`)
  }
  const divisor = config.divisor ?? defaultConfig.divisor
  if (!positive(divisor)) {
    throw new TypeError(`image-price-fallback: divisor must be a finite number above zero, received ${JSON.stringify(config.divisor)}`)
  }
  const minTokens = config.minTokens ?? defaultConfig.minTokens
  if (!Number.isInteger(minTokens) || minTokens < 0) {
    throw new TypeError(`image-price-fallback: minTokens must be a non-negative integer, received ${JSON.stringify(config.minTokens)}`)
  }
  const maxTokens = config.maxTokens ?? defaultConfig.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < minTokens) {
    throw new TypeError(`image-price-fallback: maxTokens must be an integer at least minTokens (${minTokens}), received ${JSON.stringify(config.maxTokens)}`)
  }
  const providers = config.providers ?? defaultConfig.providers
  if (!Array.isArray(providers) || providers.some(provider => typeof provider !== 'string' || provider === '')) {
    throw new TypeError(`image-price-fallback: providers must be a list of non-empty provider ids, received ${JSON.stringify(config.providers)}`)
  }
  return { mode, divisor, minTokens, maxTokens, providers: [...providers], log }
}
