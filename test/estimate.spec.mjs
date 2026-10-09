/**
 * The estimate, arm by arm.
 *
 * Each case here is a claim `src/estimate.ts` makes to its reader: the formula,
 * the two clamps, what an unmeasurable image costs, that an offloaded occurrence
 * is never charged visual tokens, and that the price count is exactly the
 * occurrence count. The packaging guard in `test/packaging.spec.mjs` covers the
 * manifest; this file covers the numbers.
 *
 * @module test/estimate.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { offloadedImageText } from '@deepseek-ai/dsh-llm'
import { defaultConfig, normalizeConfig } from '../lib/config.js'
import { createRoutePricing, describePricing, estimateVisualTokens, priceOccurrences } from '../lib/estimate.js'

/** The defaults, as one pricing object. */
const DEFAULTS = defaultConfig

/** One durable image reference of the given size. */
function ref(width, height, name = 'photo') {
  return { attachmentId: `sha256:${name.padEnd(8, '0')}`, mediaType: 'image/png', bytes: 4096, width, height, name }
}

test('the estimate is the published rate, rounded up', () => {
  assert.equal(estimateVisualTokens(ref(1024, 1024), DEFAULTS), 1399)
  assert.equal(estimateVisualTokens(ref(800, 600), DEFAULTS), 640)
  assert.equal(estimateVisualTokens(ref(750, 750), DEFAULTS), 750)
})

test('an image below the base cost is charged the base cost, not its raw ratio', () => {
  // ceil(10 * 10 / 750) is 1; a one-token image is the understatement this
  // plugin exists to remove, so the floor holds.
  assert.equal(estimateVisualTokens(ref(10, 10), DEFAULTS), 85)
  assert.equal(estimateVisualTokens(ref(255, 255), DEFAULTS), 87)
})

test('an image above the ceiling is charged the ceiling', () => {
  assert.equal(estimateVisualTokens(ref(4000, 4000), DEFAULTS), 1600)
  assert.equal(estimateVisualTokens(ref(20_000, 20_000), DEFAULTS), 1600)
})

test('an image whose dimensions cannot be read is charged the base cost, never zero', () => {
  assert.equal(estimateVisualTokens(ref(0, 0), DEFAULTS), 85)
  assert.equal(estimateVisualTokens(ref(-100, 500), DEFAULTS), 85)
  assert.equal(estimateVisualTokens(ref(Number.NaN, 500), DEFAULTS), 85)
  assert.equal(estimateVisualTokens(ref(Number.POSITIVE_INFINITY, 500), DEFAULTS), 85)
  assert.equal(estimateVisualTokens({}, DEFAULTS), 85)
})

test('the divisor is the calibration knob, and it moves the price', () => {
  assert.equal(estimateVisualTokens(ref(1024, 1024), { ...DEFAULTS, divisor: 1500 }), 700)
  assert.equal(estimateVisualTokens(ref(1024, 1024), { ...DEFAULTS, divisor: 375 }), 1600)
})

test('the clamps are the calibration knobs too', () => {
  assert.equal(estimateVisualTokens(ref(1024, 1024), { ...DEFAULTS, maxTokens: 1000 }), 1000)
  assert.equal(estimateVisualTokens(ref(10, 10), { ...DEFAULTS, minTokens: 500 }), 500)
})

test('an offloaded occurrence is priced as its placeholder text, with no visual tokens', () => {
  const attachment = ref(1024, 1024)
  const prices = priceOccurrences([{ type: 'image', attachment, offloaded: true }], DEFAULTS)
  assert.equal(prices.length, 1)
  assert.equal(prices[0].visualTokens, 0)
  assert.equal(prices[0].text, offloadedImageText(attachment))
})

test('a retained occurrence is priced as pixels and quotes no text', () => {
  const prices = priceOccurrences([{ type: 'image', attachment: ref(1024, 1024) }], DEFAULTS)
  assert.equal(prices[0].visualTokens, 1399)
  assert.equal(prices[0].text, '')
})

test('every occurrence is answered, in order, one price each', () => {
  const occurrences = [
    { type: 'image', attachment: ref(1024, 1024, 'first') },
    { type: 'image', attachment: ref(100, 100, 'second'), offloaded: true },
    { type: 'image', attachment: ref(2000, 1000, 'third') },
  ]
  const prices = priceOccurrences(occurrences, DEFAULTS)
  assert.equal(prices.length, occurrences.length)
  assert.equal(prices[0].visualTokens, 1399)
  assert.equal(prices[1].visualTokens, 0)
  assert.equal(prices[2].visualTokens, 1600)
  assert.equal(priceOccurrences([], DEFAULTS).length, 0)
})

test('the pricing object is the interface the meter calls', () => {
  const pricing = createRoutePricing(DEFAULTS)
  const prices = pricing.priceImages([{ type: 'image', attachment: ref(1024, 1024) }])
  assert.equal(prices.length, 1)
  assert.equal(prices[0].visualTokens, 1399)
})

test('the formula is described the way it is applied', () => {
  assert.equal(describePricing(DEFAULTS), 'ceil(width * height / 750) clamped to 85..1600')
  // A configured deployment is the case the description exists for: it is what
  // the mount line and the per-route line print, so a description that keeps
  // naming the defaults tells the operator the wrong rate is in force.
  assert.equal(
    describePricing({ ...DEFAULTS, divisor: 1500, minTokens: 40, maxTokens: 900 }),
    'ceil(width * height / 1500) clamped to 40..900',
    'the description names the settings in force, not the defaults',
  )
})

test('the defaults are the documented ones', () => {
  assert.deepEqual(normalizeConfig(), DEFAULTS)
  assert.deepEqual(normalizeConfig({}), DEFAULTS)
})

test('a configuration overrides only what it states', () => {
  assert.deepEqual(normalizeConfig({ divisor: 1000 }), { ...DEFAULTS, divisor: 1000 })
  assert.deepEqual(normalizeConfig({ mode: 'off', log: 'off', providers: ['gateway'] }), {
    ...DEFAULTS,
    mode: 'off',
    log: 'off',
    providers: ['gateway'],
  })
})

test('an unusable field is refused rather than silently repaired', () => {
  assert.throws(() => normalizeConfig({ mode: 'sometimes' }), /mode must be 'auto' or 'off'/)
  assert.throws(() => normalizeConfig({ log: 'loud' }), /log must be 'off' or 'summary'/)
  assert.throws(() => normalizeConfig({ divisor: 0 }), /divisor must be a finite number above zero/)
  assert.throws(() => normalizeConfig({ divisor: -5 }), /divisor must be a finite number above zero/)
  assert.throws(() => normalizeConfig({ divisor: Number.NaN }), /divisor must be a finite number above zero/)
  assert.throws(() => normalizeConfig({ minTokens: -1 }), /minTokens must be a non-negative integer/)
  assert.throws(() => normalizeConfig({ maxTokens: 10, minTokens: 100 }), /at least minTokens/)
  assert.throws(() => normalizeConfig({ maxTokens: 1.5 }), /maxTokens must be an integer/)
  assert.throws(() => normalizeConfig({ providers: [''] }), /providers must be a list of non-empty provider ids/)
  assert.throws(() => normalizeConfig({ providers: [7] }), /providers must be a list of non-empty provider ids/)
})

test('the resolved settings never alias the caller\u2019s array', () => {
  const providers = ['gateway']
  const resolved = normalizeConfig({ providers })
  providers.push('other')
  assert.deepEqual(resolved.providers, ['gateway'])
})
