/**
 * The token meter charges visual tokens only when a route's adapter declares a
 * request-image price. This plugin answers for the routes where none does.
 *
 * ## The gap, read from the source
 *
 * `LlmAdapter.imageRequestPricing()` is documented to return `undefined` by
 * default — *"The default declares none, so consumers fall back to their own
 * neutral estimate."* The token meter is that consumer: `_routeImagePricing()`
 * resolves `ctx.get('llm').imageRequestPricing(provider, model)` and hands the
 * answer to `priceSurface()`, which keeps the fixed structural heuristic when the
 * answer is absent. That heuristic prices an image block by the JSON length of
 * its *reference* — `BLOCK_OVERHEAD + ceil(JSON.stringify(reference).length / 4)`,
 * a few dozen tokens — while the route charges the provider's real vision rate.
 *
 * The built-in DeepSeek adapter implements the method. The `pi-ai` adapter —
 * which serves every OpenAI-compatible and Anthropic-compatible gateway route,
 * the ordinary path for third-party models — does not: it overrides
 * `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel` and
 * `prepareCall`, and inherits the base `undefined`. Its `modelInfo()` still
 * advertises the model's real `inputModalities`, image included, so the request
 * really does carry the pixels while the meter prices them as a string.
 *
 * ## What that costs, and where it is visible
 *
 * Two quantities are affected, and only one of them has a safety net:
 *
 * - `measure().totalTokens` compares the **provider-anchored** baseline against
 *   the compaction threshold, so on the steps whose request header matches the
 *   last anchored one the real usage is what the gate sees.
 * - `measure().nodes[].tokens` are priced by `priceSurface()` and are **never**
 *   anchor-corrected. Compaction's range selection reads exactly those
 *   (`compaction-basic/src/region.ts`: *"retention, range selection, and the
 *   shrink comparison read the route-priced `tokens` instead"*), so an image-heavy
 *   span is priced in the tens of tokens per image and is not the span that gets
 *   summarized — the symptom reported as "the range selector never selected the
 *   actual conversation body".
 *
 * ## What this plugin does, and what it refuses to do
 *
 * It wraps the `llm` service instance's `imageRequestPricing` — the same
 * instance every `ctx.get('llm')` view reads, which is the seam the meter
 * resolves through — calls the route's own implementation first, and answers
 * only when the route answered `undefined` **and** `resolveModelInfo()` reports
 * the model accepts images. It never second-guesses a route that declares a
 * price, and never prices a model that cannot receive an image.
 *
 * The estimate is a dimension-based one (`src/estimate.ts` states the published
 * provenance of each constant) because `priceImages()` must answer
 * synchronously. Modality is resolved asynchronously and cached, so the first
 * measurement of a route — and any measurement taken before the resolution
 * lands — is left exactly as it is today rather than guessed.
 *
 * Mounts stack, and the stack is what makes two mounts behave. Every layer calls
 * the route implementation the first mount found, so a second mount's
 * configuration is the one in force while it is mounted — a layer that deferred
 * to the layer below it instead would leave the second mount's settings inert,
 * which is a silent failure for whoever mounted it. The outermost live layer owns
 * the property; unmounting re-installs the layer below it, and unmounting the last
 * one restores the descriptor the first mount found, so a route that had no own
 * property gets the prototype method back rather than a permanent shadow.
 *
 * @module @argszero/dsh-image-price-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmImageRequestPricing, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { createRoutePricing, describePricing } from './estimate.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'image-price-fallback'

/** The `llm` service owns the method this plugin wraps. */
export const inject = ['llm']

export type { Config, FallbackLog, FallbackMode, Settings } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { VisualPricing } from './estimate.ts'
export { createRoutePricing, describePricing, estimateVisualTokens, priceOccurrences } from './estimate.ts'

/** The key `getTraceable()` files the underlying instance under — cross-copy stable. */
const ORIGINAL = Symbol.for('cordis.original')

/**
 * Where one instance's stack of this plugin's layers is filed.
 *
 * A `Symbol.for` key, like `ORIGINAL`: two copies of this plugin loaded by
 * different paths must agree on where the stack lives, or the second copy would
 * start a second stack on the same instance and one of them would be orphaned.
 */
const STACK = Symbol.for('@argszero/dsh-image-price-fallback/stack')

/** The method as it is installed on the service instance. */
type PriceMethod = (provider: string, model: string) => LlmImageRequestPricing | undefined

/** Everything one instance's mounts share: what they wrap, and who owns the property. */
interface Installation {
  /** The descriptor the first mount found, restored when the last mount leaves. */
  previous: PropertyDescriptor | undefined
  /** The route implementation every layer calls first, bound to the instance. */
  declared: PriceMethod
  /** The layers in mount order; the last one owns the property. */
  layers: PriceMethod[]
}

/**
 * Write one pricing method onto the instance as its own property.
 * @param instance - the llm service instance.
 * @param method - the method to install.
 */
function defineMethod(instance: LlmRuntime, method: PriceMethod): void {
  Object.defineProperty(instance, 'imageRequestPricing', {
    value: method,
    writable: true,
    enumerable: false,
    configurable: true,
  })
}

/**
 * The installation filed on one instance, created by the first mount.
 *
 * `previous` is captured once, by the first mount, and `declared` binds whatever
 * method the instance carried at that moment — the route's own implementation, or
 * a foreign wrapper's. Later mounts reuse both, which is what makes every layer
 * ask the same route the same question instead of asking the layer below.
 * @param instance - the llm service instance.
 * @returns the installation, existing or newly filed.
 */
function installationFor(instance: LlmRuntime): Installation {
  const carrier = instance as unknown as Record<PropertyKey, unknown>
  const existing = carrier[STACK]
  if (existing !== undefined) return existing as Installation
  const created: Installation = {
    previous: Object.getOwnPropertyDescriptor(instance, 'imageRequestPricing'),
    declared: instance.imageRequestPricing.bind(instance),
    layers: [],
  }
  Object.defineProperty(instance, STACK, {
    value: created,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  return created
}

/**
 * Add one layer, and hand it the property.
 * @param instance - the llm service instance.
 * @param state - the instance's installation.
 * @param layer - the method this mount installs.
 */
function installLayer(instance: LlmRuntime, state: Installation, layer: PriceMethod): void {
  state.layers.push(layer)
  defineMethod(instance, layer)
}

/**
 * Remove one layer, restoring the one below it or, for the last layer, the
 * descriptor the first mount found.
 *
 * A layer is replaced only while it owns the property: a later mount holds it
 * until its own disposal, and a wrapper that is not ours may have taken it since
 * — overwriting either would discard work this plugin does not own.
 * @param instance - the llm service instance.
 * @param state - the instance's installation.
 * @param layer - the method this mount installed.
 */
function removeLayer(instance: LlmRuntime, state: Installation, layer: PriceMethod): void {
  const index = state.layers.indexOf(layer)
  if (index >= 0) state.layers.splice(index, 1)
  const remaining = state.layers[state.layers.length - 1]
  if (remaining !== undefined) {
    if (instance.imageRequestPricing === layer) defineMethod(instance, remaining)
    return
  }
  if (instance.imageRequestPricing === layer) {
    if (state.previous === undefined) Reflect.deleteProperty(instance, 'imageRequestPricing')
    else Object.defineProperty(instance, 'imageRequestPricing', state.previous)
  }
  Reflect.deleteProperty(instance, STACK)
}

/** One resolved route: whether the model accepts images, and whether it was already logged. */
interface RouteState {
  acceptsImages?: boolean
  announced?: boolean
  warned?: boolean
}

/**
 * The instance `ctx.get('llm')` is a view of.
 *
 * A view is built per read and holds no stable identity, so the property has to
 * be written on the instance behind it. `getTraceable()` files that instance
 * under a `Symbol.for` key; the context's own property access resolves to the
 * same object, and is the fallback when the service is not traced.
 * @param ctx - the plugin context, with `llm` declared.
 * @returns the service instance, or `undefined` when no `llm` service is mounted.
 */
function llmInstance(ctx: Context): LlmRuntime | undefined {
  const view = ctx.get('llm') as Record<PropertyKey, unknown> | undefined
  const original = view?.[ORIGINAL]
  if (original !== undefined && original !== null) return original as LlmRuntime
  return ctx.llm
}

/**
 * The per-route state and the decision this plugin makes for one route.
 *
 * The class is the whole policy in one place: a route the adapter already priced
 * never reaches here; an unlisted provider is left alone; an unknown modality is
 * left alone and resolved for the next measurement; only an image-capable route
 * with no declared price is priced.
 */
class RoutePricing {
  private readonly ctx: Context
  private readonly settings: Settings
  private readonly routes = new Map<string, RouteState>()
  /** The pricing object every priced route is answered with. */
  readonly pricing: LlmImageRequestPricing

  /**
   * @param ctx - the plugin context, for the logger and the modality lookup.
   * @param settings - the resolved configuration.
   */
  constructor(ctx: Context, settings: Settings) {
    this.ctx = ctx
    this.settings = settings
    this.pricing = createRoutePricing(settings)
  }

  /**
   * Answer for one route the adapter declined to price.
   * @param provider - the route's provider id.
   * @param model - the exact model id.
   * @returns a pricing object, or `undefined` to leave the meter as it is.
   */
  price(provider: string, model: string): LlmImageRequestPricing | undefined {
    if (this.settings.providers.length > 0 && !this.settings.providers.includes(provider)) return undefined
    const key = `${provider}\u0000${model}`
    const state = this.routes.get(key) ?? {}
    if (state.acceptsImages === undefined) {
      this.resolve(provider, model, key, state)
      return undefined
    }
    if (!state.acceptsImages) return undefined
    if (this.settings.log === 'summary' && state.announced !== true) {
      state.announced = true
      this.routes.set(key, state)
      this.ctx.logger.info(
        `image-price-fallback: ${provider}/${model} declares no request-image pricing but accepts images; `
        + `pricing each retained image at ${describePricing(this.settings)}`,
      )
    }
    this.routes.set(key, state)
    return this.pricing
  }

  /**
   * Resolve whether one route accepts images, once, off the measurement path.
   *
   * A failure is cached as "does not accept images": the meter then keeps the
   * behaviour it has today, which is the safe direction for a plugin whose own
   * bug would otherwise misprice every image in a deployment. The reason is
   * logged once, so a cache that never fills is visible rather than silent.
   */
  private resolve(provider: string, model: string, key: string, state: RouteState): void {
    this.routes.set(key, state)
    let pending: Promise<{ readonly inputModalities?: readonly string[] }>
    try {
      pending = Promise.resolve(this.ctx.llm.resolveModelInfo(provider, model))
    } catch (error: unknown) {
      this.settle(key, state, false, error)
      return
    }
    pending.then(
      (info) => { this.settle(key, state, info.inputModalities?.includes('image') === true, undefined) },
      (error: unknown) => { this.settle(key, state, false, error) },
    )
  }

  /** Record one resolution, and say so once when it failed. */
  private settle(key: string, state: RouteState, acceptsImages: boolean, error: unknown): void {
    state.acceptsImages = acceptsImages
    if (!acceptsImages && error !== undefined && state.warned !== true) {
      state.warned = true
      this.ctx.logger.warn(
        'image-price-fallback: cannot resolve the model modalities for one route, leaving its images '
        + `unpriced for this process: ${String(error)}`,
      )
    }
    this.routes.set(key, state)
  }
}

/**
 * Mount the fallback.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the mount
 * throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  const routes = new RoutePricing(ctx, settings)

  ctx.effect(() => {
    const instance = llmInstance(ctx)
    if (instance === undefined || typeof instance.imageRequestPricing !== 'function') {
      ctx.logger.warn('image-price-fallback: the mounted llm service exposes no imageRequestPricing; nothing was wrapped')
      return () => {}
    }
    const state = installationFor(instance)
    const layer: PriceMethod = function imageRequestPricing(
      provider: string,
      model: string,
    ): LlmImageRequestPricing | undefined {
      const own = state.declared(provider, model)
      return own === undefined ? routes.price(provider, model) : own
    }
    installLayer(instance, state, layer)
    ctx.logger.info(
      `image-price-fallback: wrapping ${instance.constructor.name}.imageRequestPricing; `
      + `routes that declare no pricing are priced at ${describePricing(settings)}`,
    )
    return () => { removeLayer(instance, state, layer) }
  }, 'image-price-fallback: price request images on routes whose adapter declares no pricing')
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
