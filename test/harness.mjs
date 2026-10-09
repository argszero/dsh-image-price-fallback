/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime`, the
 * REAL `TokenMeter` and a REAL durable `Session`.
 *
 * Nothing about the seam is simulated. The plugin wraps whatever
 * `ctx.get('llm')` resolves to, and this harness measures through
 * `meter.measure(session)` — the meter's own public entry point, calling
 * `ctx.get('llm').imageRequestPricing()` exactly as `_routeImagePricing()` does.
 * That is what makes the central assertion in `test/seam.spec.mjs` meaningful:
 * the number that changes is the one compaction's range selection reads.
 *
 * The only fabricated articles are the two adapters:
 *
 * - `gateway` — the shape under test: it overrides `providerInfo` and
 *   `resolveModel` and **deliberately does not implement
 *   `imageRequestPricing`**, exactly as `PiAiAdapter` does not. This is the
 *   adapter every OpenAI-compatible and Anthropic-compatible gateway route is
 *   served by.
 * - `declared` — a route that prices its own images with a marker number, so the
 *   "never second-guess a declared price" arm has something to compare against.
 *
 * `test/seam.spec.mjs` also runs the same measurement with the plugin absent, so
 * every change is measured against the same session priced by the same meter
 * when nothing is mounted. A control arm is what turns "the number moved" into
 * "the plugin moved it".
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { LlmAdapter, LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as plugin from '../lib/index.js'

/** The visual-token number the `declared` adapter charges, so it is recognisable. */
export const DECLARED_VISUAL_TOKENS = 12_345

/** The text the `declared` adapter ships beside a retained image. */
export const DECLARED_TEXT = 'declared-route-handle'

/** The image the harness appends by default: 1024x1024, the estimate's largest common case. */
export const IMAGE_SIZE = { width: 1024, height: 1024 }

/** The estimate `ceil(1024 * 1024 / 750)` clamps to, for the default image. */
export const EXPECTED_VISUAL_TOKENS = Math.ceil((IMAGE_SIZE.width * IMAGE_SIZE.height) / 750)

/** The adapter shape under test: image-capable, and declaring no image pricing. */
class GatewayAdapter extends LlmAdapter {
  constructor() {
    super()
    this.modalities = ['text', 'image']
  }

  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: [...this.modalities],
      context: { contextWindow: 256_000 },
    })
  }

  async *stream() {
    throw new Error('the gateway adapter double does not stream')
  }
}

/** A route that declares its own image pricing, which the plugin must leave alone. */
class DeclaredAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 256_000 },
    })
  }

  imageRequestPricing() {
    return {
      priceImages: images => images.map(() => ({ visualTokens: DECLARED_VISUAL_TOKENS, text: DECLARED_TEXT })),
    }
  }

  async *stream() {
    throw new Error('the declared adapter double does not stream')
  }
}

/** One durable image-bearing user message. */
export function imageMessage(name = 'photo', size = IMAGE_SIZE) {
  return createUserMessage({
    content: [
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${name.padEnd(8, '0')}`),
          mediaType: 'image/png',
          bytes: 4096,
          width: size.width,
          height: size.height,
          name,
        },
      },
    ],
    source: { kind: 'user' },
  })
}

/** The canonical request header one route is measured under. */
export function header(provider, model) {
  return canonicalHeader({ config: { provider, model } })
}

/**
 * Mount a real context with a real meter, and by default this plugin.
 *
 * @param spec - `plugin: false` mounts everything except the plugin (the control
 *   arm); `config` is the plugin configuration; `modalities` is what the gateway
 *   route advertises; `images` are the occurrences appended to the session;
 *   `route` names the provider/model the session's request header selects.
 * @returns the context, the llm runtime, the meter, the session, the mount fork
 *   and the captured log.
 */
export async function world(spec = {}) {
  const ctx = new Context()
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  new SessionProjectionRegistry(ctx)
  ctx.provide('attachments', { fileHostPath: ref => `/host/${ref.name}` })
  ctx.provide('fs', { processPathFromHostPath: path => path.replace('/host/', '/sandbox/') })

  const llm = new LlmRuntime(ctx)
  const gateway = new GatewayAdapter()
  gateway.modalities = spec.modalities ?? ['text', 'image']
  llm.registerAdapter(['gateway'], gateway)
  llm.registerAdapter(['declared'], new DeclaredAdapter())
  const meter = new TokenMeter(ctx)

  const session = Session.create(
    SessionId(`c575-${Math.random().toString(36).slice(2)}`),
    undefined,
    undefined,
    undefined,
    [imageOffloadProjection],
  )
  const route = spec.route ?? { provider: 'gateway', model: 'vision' }
  for (const image of spec.images ?? [imageMessage()]) {
    session.append('user/message', image, { surfaceOp: 'append' })
  }
  session.append('request/header', { header: header(route.provider, route.model), reason: 'initial' })

  const fork = spec.plugin === false ? undefined : await ctx.plugin(plugin, spec.config ?? {})

  // A route's modality is resolved the first time the meter asks about it, so
  // the first measurement of a session is deliberately left unpriced. Real
  // sessions take that measurement on every step long before compaction
  // decides, so the harness warms the route here — two measurements, one to
  // start the lookup and one once it has landed — unless an arm asks for the
  // cold state explicitly.
  if (fork !== undefined && spec.cold !== true) {
    meter.measure(session) // asks the route, which starts the modality lookup
    await new Promise(resolve => setTimeout(resolve, 25))
    meter.measure(session) // the lookup has landed: this is the priced measurement
  }
  return { ctx, llm, meter, session, fork, logged }
}

/**
 * The node-price change one priced image produces.
 *
 * A route pricing replaces the structural price of the image block with
 * `visualTokens` plus the text the occurrence contributes, so the delta is not
 * the visual tokens alone. Both other terms are read from the meter itself
 * rather than hardcoded: the structural price is
 * `estimateMessage(with image) - estimateMessage(the same message without it)`,
 * and a retained occurrence contributes an empty model-visible text block,
 * whose price is the fixed `BLOCK_OVERHEAD` of 4.
 *
 * @param control - a harness without the plugin, measuring the same session.
 * @param visualTokens - the visual tokens the plugin is expected to charge.
 * @returns the expected change in one node's `tokens`.
 */
export function expectedImageDelta(control, visualTokens) {
  const withoutImage = createUserMessage({
    content: [{ type: 'text', text: 'look at this' }],
    source: { kind: 'user' },
  })
  const structural = control.meter.estimateMessage(imageMessage()) - control.meter.estimateMessage(withoutImage)
  return visualTokens + 4 - structural
}

/** Let the plugin's asynchronous modality lookup settle. */
export function settle() {
  return new Promise(resolve => setTimeout(resolve, 25))
}

/** The first surface node's measured price under the real meter. */
export function firstNode(harness) {
  const measurement = harness.meter.measure(harness.session)
  const node = measurement.nodes[0]
  if (node === undefined) throw new Error('the harness session has no surface node to price')
  return { node, measurement }
}

/** The captured log as one string, in order. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
