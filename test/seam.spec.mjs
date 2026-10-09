/**
 * The end-to-end witness: the gap exists on a route whose adapter declares no
 * pricing, this plugin closes it, and the number that moves is the one the real
 * `TokenMeter` produces from a real session.
 *
 * The control arms are not decoration. "The node price went up" is consistent
 * with a broken meter, a mispriced session, or this plugin pricing something it
 * was never asked about. Measuring the same session with the plugin absent, with
 * a route that declares its own price, and with a route that cannot receive an
 * image, is what leaves this plugin as the only difference.
 *
 * @module test/seam.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DECLARED_TEXT, DECLARED_VISUAL_TOKENS, EXPECTED_VISUAL_TOKENS, expectedImageDelta, firstNode, header, imageMessage,
  logText, settle, world,
} from './harness.mjs'

test('a gateway route that declares no image pricing is what the meter under-prices (the control arm)', async () => {
  const harness = await world({ plugin: false })
  const { node } = firstNode(harness)

  // The gap, measured: this adapter never implements `imageRequestPricing`, so
  // the route resolves to no pricing at all and the retained image is charged
  // the structural heuristic — a few dozen tokens for a 1024x1024 image.
  assert.equal(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.equal(node.tokens, node.heuristicTokens)
  assert.ok(node.tokens < 100, `the heuristic prices a 1024x1024 image at ${node.tokens} tokens`)
})

test('the plugin prices that route, and the real meter reports the change', async () => {
  const control = await world({ plugin: false })
  const harness = await world()

  assert.notEqual(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  const before = firstNode(control).node
  const after = firstNode(harness).node

  assert.equal(after.heuristicTokens, before.heuristicTokens, 'the fixed heuristic itself must not move')
  assert.ok(after.tokens > before.tokens, `the priced node must exceed the heuristic (${after.tokens} vs ${before.tokens})`)
  assert.equal(
    after.tokens - before.tokens,
    expectedImageDelta(control, EXPECTED_VISUAL_TOKENS),
    'the node gains exactly the estimated visual tokens for one 1024x1024 image, less the structural price it replaces',
  )
  assert.equal(firstNode(harness).measurement.surfaceTokens, after.tokens)
})

test('the estimate follows the configuration the operator wrote', async () => {
  const control = await world({ plugin: false })
  const harness = await world({ config: { divisor: 1500 } })
  const { node } = firstNode(harness)
  const heuristic = firstNode(control).node.tokens
  assert.equal(node.tokens - heuristic, expectedImageDelta(control, 700))
})

test('the wrapped method is the one a fresh service view resolves', async () => {
  const harness = await world()

  // The meter calls `this.ctx.get('llm').imageRequestPricing(...)`; a fresh view
  // must reach the wrapper, not the prototype method it shadows.
  const view = harness.ctx.get('llm')
  const pricing = view.imageRequestPricing('gateway', 'vision')
  assert.notEqual(pricing, undefined)
  const prices = pricing.priceImages([{ type: 'image', attachment: imageMessage('view').content[1].attachment }])
  assert.equal(prices.length, 1)
  assert.equal(prices[0].visualTokens, EXPECTED_VISUAL_TOKENS)
})

test('a route that declares its own pricing is never second-guessed', async () => {
  const harness = await world({ route: { provider: 'declared', model: 'vision' } })
  const { node } = firstNode(harness)

  // The declared adapter charges 12345 visual tokens plus its own handle text.
  assert.ok(node.tokens > DECLARED_VISUAL_TOKENS, `the declared price must be the one used (${node.tokens})`)
  assert.ok(node.tokens < DECLARED_VISUAL_TOKENS + 100, 'this plugin must not have added its own estimate on top')
  const pricing = harness.llm.imageRequestPricing('declared', 'vision')
  assert.equal(pricing.priceImages([{ type: 'image', attachment: imageMessage().content[1].attachment }])[0].text, DECLARED_TEXT)
})

test('a model that cannot receive an image is left exactly as it is', async () => {
  const harness = await world({ modalities: ['text'] })
  const { node } = firstNode(harness)

  assert.equal(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.equal(node.tokens, node.heuristicTokens, 'a text-only route keeps the behaviour it has today')
})

test('a measurement taken before the modality lookup lands is left as it is, and the next one is priced', async () => {
  const harness = await world({ cold: true })
  const cold = firstNode(harness).node
  const heuristic = firstNode(await world({ plugin: false })).node.tokens

  assert.equal(cold.tokens, heuristic, 'the first measurement must not guess a modality')
  await settle()
  const warm = firstNode(harness).node
  assert.ok(warm.tokens > heuristic, 'the measurement after the lookup lands is priced')
})

test('the provider allowlist scopes the plugin', async () => {
  const control = await world({ plugin: false })
  const heuristic = firstNode(control).node.tokens

  // Both directions, because only the pair distinguishes "the list is read" from
  // "the plugin refuses everything whenever a list is present": a route that is
  // *on* the list must be priced, and one that is not must be left alone.
  const listed = await world({ config: { providers: ['gateway'] } })
  assert.notEqual(
    listed.llm.imageRequestPricing('gateway', 'vision'),
    undefined,
    'a listed provider is priced',
  )
  assert.equal(firstNode(listed).node.tokens - heuristic, expectedImageDelta(control, EXPECTED_VISUAL_TOKENS))

  const unlisted = await world({ config: { providers: ['other-gateway'] } })
  assert.equal(unlisted.llm.imageRequestPricing('gateway', 'vision'), undefined, 'an unlisted provider is left alone')
  assert.equal(firstNode(unlisted).node.tokens, heuristic)
})

test('mode off mounts nothing at all', async () => {
  const harness = await world({ config: { mode: 'off' } })
  const control = await world({ plugin: false })
  assert.equal(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.equal(firstNode(harness).node.tokens, firstNode(control).node.tokens)
  assert.equal(logText(harness.logged), '')
})

test('an unusable configuration refuses to mount', async () => {
  await assert.rejects(world({ config: { divisor: 0 } }), /divisor must be a finite number above zero/)
})

test('the route is logged once, and only when logging is on', async () => {
  const harness = await world()
  firstNode(harness)
  await settle()
  firstNode(harness)
  await settle()
  firstNode(harness)
  const lines = logText(harness.logged).split('\n').filter(line => line.includes('declares no request-image pricing'))
  assert.equal(lines.length, 1, 'one line per priced route, however many measurements are taken')
  assert.match(lines[0], /gateway\/vision/)
  assert.match(lines[0], /ceil\(width \* height \/ 750\) clamped to 85\.\.1600/)

  const quiet = await world({ config: { log: 'off' } })
  firstNode(quiet)
  await settle()
  firstNode(quiet)
  assert.doesNotMatch(logText(quiet.logged), /declares no request-image pricing/)
})

test('the mount says what it wrapped and at what rate', async () => {
  const harness = await world()
  assert.match(logText(harness.logged), /wrapping LlmRuntime\.imageRequestPricing/)
  assert.match(logText(harness.logged), /ceil\(width \* height \/ 750\) clamped to 85\.\.1600/)
})

test('unmounting restores the route to the state it had before', async () => {
  const harness = await world()
  assert.notEqual(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.notEqual(Object.getOwnPropertyDescriptor(harness.llm, 'imageRequestPricing'), undefined)

  await harness.fork.dispose()
  await settle()

  assert.equal(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.equal(
    Object.getOwnPropertyDescriptor(harness.llm, 'imageRequestPricing'),
    undefined,
    'the prototype method must be reachable again, not left shadowed by a copy',
  )
  assert.equal(firstNode(harness).node.tokens, firstNode(await world({ plugin: false })).node.tokens)
})

test('a second mount over the first one is restored in the right order', async () => {
  const harness = await world()
  const first = harness.llm.imageRequestPricing

  const second = await harness.ctx.plugin(await import('../lib/index.js'), { divisor: 1500 })
  firstNode(harness)
  await settle()
  const wrapped = harness.llm.imageRequestPricing
  assert.notEqual(wrapped, first, 'the second mount owns the property while it is mounted')
  const control = await world({ plugin: false })
  const heuristic = firstNode(control).node.tokens
  assert.equal(firstNode(harness).node.tokens - heuristic, expectedImageDelta(control, 700))

  await second.dispose()
  assert.equal(harness.llm.imageRequestPricing, first, 'the first wrapper must be back in place')
  assert.equal(firstNode(harness).node.tokens - heuristic, expectedImageDelta(control, EXPECTED_VISUAL_TOKENS))
})

test('unmounting a lower layer under a higher one leaves the higher one in force', async () => {
  const harness = await world()
  const first = harness.fork

  const second = await harness.ctx.plugin(await import('../lib/index.js'), { divisor: 1500 })
  firstNode(harness)
  await settle()

  // The lower mount leaves first — the order that strands a naive chain: the
  // property belongs to the second mount, so the first mount's disposer must
  // leave it alone, and the second mount's disposer must not put the departed
  // first wrapper back.
  await first.dispose()
  await settle()
  const control = await world({ plugin: false })
  const heuristic = firstNode(control).node.tokens
  assert.equal(firstNode(harness).node.tokens - heuristic, expectedImageDelta(control, 700))
  assert.notEqual(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)

  await second.dispose()
  await settle()
  assert.equal(harness.llm.imageRequestPricing('gateway', 'vision'), undefined)
  assert.equal(
    Object.getOwnPropertyDescriptor(harness.llm, 'imageRequestPricing'),
    undefined,
    'the last layer leaving must give the prototype method back, not a departed wrapper',
  )
  assert.equal(firstNode(harness).node.tokens - heuristic, 0)
})

test('the session header is what selects the route, and another route is priced on its own terms', async () => {
  const harness = await world({ route: { provider: 'gateway', model: 'other-vision' } })
  assert.match(logText(harness.logged), /gateway\/other-vision/)
  assert.equal(harness.llm.imageRequestPricing('gateway', 'never-measured'), undefined, 'a route is resolved when it is asked about, not in advance')
  assert.equal(header('gateway', 'other-vision').config.model, 'other-vision')
})
