/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and this harness reports it as a
 * failure of itself rather than hiding it.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and one
 * that does not compile is reported as TYPEFAIL, because it never reached the
 * suite either.
 *
 * Every arm is a defect this package could plausibly have shipped — one
 * distinction it exists to make, removed with one edit. The arms that matter
 * most are the ones where the plugin would still *look* like it works:
 *
 * - **the stack** (`installationFor` reusing what the first mount captured).
 *   The obvious way to layer two mounts is to let the second call the first,
 *   and it is wrong: the first wrapper answers `undefined` from the route by
 *   returning *its own* price, so the second mount — the operator's most recent
 *   configuration — becomes inert while appearing mounted. An arm that
 *   re-captures the previous property restores exactly that bug, and the
 *   two-mount arms are what must catch it.
 * - **the deferrals** — never second-guess a declared price, never price a model
 *   that cannot receive an image, never guess an unresolved modality. Each one
 *   removed turns the plugin from a fallback into a rewrite of the truth.
 * - **the calibration** — a floor, a ceiling and a divisor that are all
 *   configuration. An estimator that ignores one of its three knobs still
 *   produces a plausible number, which is why each is a separate arm.
 * - **the offloaded occurrence** — pricing an image that is not sent as pixels
 *   charges the route for something the request does not carry.
 * - **the refusal** — a config field that is silently repaired instead of
 *   refused is how a calibration knob becomes a mystery.
 * - **the restoration** — a mount that never lets go leaves the property
 *   shadowed by a wrapper whose plugin is gone.
 *
 * ```sh
 * node scripts/inject-defects.mjs                    # every arm
 * node scripts/inject-defects.mjs --filter=divisor   # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The arm the plugin exists for. A wrapper that answers without asking the
    // route first overrides a provider that priced its own images correctly.
    name: 'route: a declared price is second-guessed',
    file: 'src/index.ts',
    edits: [['      return own === undefined ? routes.price(provider, model) : own',
      '      return routes.price(provider, model) ?? own']],
  },
  {
    // A second mount that calls the first instead of the route. The first
    // wrapper fills the gap, so the second mount's configuration never reaches
    // the meter — mounted, logged, and inert.
    name: 'stack: a later mount reuses the layer below instead of the route',
    file: 'src/index.ts',
    edits: [['  const existing = carrier[STACK]\n  if (existing !== undefined) return existing as Installation',
      '  const existing = carrier[STACK]\n  void existing']],
  },
  {
    // Every model that reports any modality at all becomes image-capable.
    name: 'modality: any reported modality is read as image support',
    file: 'src/index.ts',
    edits: [["      (info) => { this.settle(key, state, info.inputModalities?.includes('image') === true, undefined) },",
      '      (info) => { this.settle(key, state, info.inputModalities !== undefined, undefined) },']],
  },
  {
    // An unresolved modality is guessed instead of left alone: the first
    // measurement of every route prices images the model may not accept.
    name: 'modality: an unresolved route is priced instead of left as it is',
    file: 'src/index.ts',
    edits: [['      this.resolve(provider, model, key, state)\n      return undefined',
      '      this.resolve(provider, model, key, state)\n      return this.pricing']],
  },
  {
    // The allowlist is compared against the model id, so no configured provider
    // name ever matches and the plugin prices nothing it was scoped to price.
    name: 'scope: the provider allowlist is matched against the model',
    file: 'src/index.ts',
    edits: [['    if (this.settings.providers.length > 0 && !this.settings.providers.includes(provider)) return undefined',
      '    if (this.settings.providers.length > 0 && !this.settings.providers.includes(model)) return undefined']],
  },
  {
    // The announcement is written on every measurement rather than once per
    // route, which is the difference between a diagnostic and a flood.
    name: 'log: the route announcement is written every time',
    file: 'src/index.ts',
    edits: [["    if (this.settings.log === 'summary' && state.announced !== true) {",
      "    if (this.settings.log === 'summary') {"]],
  },
  {
    // `log: 'off'` is ignored: the operator asked for silence and gets a line
    // per route.
    name: 'log: logging happens even when it is switched off',
    file: 'src/index.ts',
    edits: [["    if (this.settings.log === 'summary' && state.announced !== true) {",
      '    if (state.announced !== true) {']],
  },
  {
    // `mode: 'off'` is ignored, so the documented way to mount the plugin
    // without changing any number changes every number.
    name: 'mode: the off switch does not switch anything off',
    file: 'src/index.ts',
    // The comparison is moved to the other field rather than falsified:
    // `settings.mode` is a two-member union, so `mode === 'off' && mode ===
    // 'auto'` is a TS2367, and a mutation that does not compile never reaches
    // the suite at all.
    edits: [["  if (settings.mode === 'off') return", "  if (settings.log === 'off') return"]],
  },
  {
    // The disposer does nothing: unmounting leaves the property pointing at a
    // wrapper whose plugin is gone, and the prototype method stays shadowed.
    name: 'restore: unmounting leaves the wrapper installed',
    file: 'src/index.ts',
    edits: [['    return () => { removeLayer(instance, state, layer) }', '    return () => {}']],
  },
  {
    // An occurrence the surface marks offloaded is not sent as pixels, so
    // pricing it charges the route for an image the request does not carry.
    // The price is mutated rather than the condition: `ImageBlock['offloaded']`
    // is `true | undefined`, so every comparison that could flip the branch is a
    // type error, and the arm would never reach the suite at all.
    name: 'offloaded: an offloaded occurrence is priced as pixels',
    file: 'src/estimate.ts',
    edits: [['      return { visualTokens: 0, text: offloadedImageText(block.attachment) }',
      '      return { visualTokens: estimateVisualTokens(block.attachment, pricing), text: offloadedImageText(block.attachment) }']],
  },
  {
    // A retained image is given the offloaded placeholder text, quoting a
    // handle the model never reads.
    name: 'offloaded: a retained image is answered with the placeholder text',
    file: 'src/estimate.ts',
    edits: [["    return { visualTokens: estimateVisualTokens(block.attachment, pricing), text: '' }",
      '    return { visualTokens: estimateVisualTokens(block.attachment, pricing), text: offloadedImageText(block.attachment) }']],
  },
  {
    // An unmeasurable image is priced at zero, recreating the understatement
    // this plugin exists to remove.
    name: 'estimate: an unreadable reference is priced at nothing',
    file: 'src/estimate.ts',
    edits: [['    return pricing.minTokens\n  }', '    return 0\n  }']],
  },
  {
    // The floor is dropped: a small image is charged its raw pixels-over-divisor,
    // below the published base cost.
    name: 'estimate: the floor is not applied',
    file: 'src/estimate.ts',
    edits: [['  return Math.min(pricing.maxTokens, Math.max(pricing.minTokens, raw))',
      '  return Math.min(pricing.maxTokens, raw)']],
  },
  {
    // The ceiling is dropped: one image can be charged an unbounded number.
    name: 'estimate: the ceiling is not applied',
    file: 'src/estimate.ts',
    edits: [['  return Math.min(pricing.maxTokens, Math.max(pricing.minTokens, raw))',
      '  return Math.max(pricing.minTokens, raw)']],
  },
  {
    // The divisor knob is ignored: every route is priced at the built-in rate
    // whatever the operator configured.
    name: 'estimate: the configured divisor is not used',
    file: 'src/estimate.ts',
    edits: [['  const raw = Math.ceil((width * height) / pricing.divisor)', '  const raw = Math.ceil(width * height)']],
  },
  {
    // One price per surface instead of one per occurrence: the meter throws on
    // a count mismatch, so this is caught rather than silently misaligned.
    name: 'estimate: a surface is priced as one image',
    file: 'src/estimate.ts',
    edits: [['  return images.map((block) => {', '  return images.slice(0, 1).map((block) => {']],
  },
  {
    // The one-line description stops naming the divisor that is in force, so
    // the log no longer says what the deployment is actually charged.
    name: 'estimate: the description hides the configured divisor',
    file: 'src/estimate.ts',
    edits: [['  return `ceil(width * height / ${pricing.divisor}) clamped to ${pricing.minTokens}..${pricing.maxTokens}`',
      '  return `ceil(width * height / 750) clamped to ${pricing.minTokens}..${pricing.maxTokens}`']],
  },
  {
    // An unusable divisor is repaired to the default instead of refused, which
    // is how a calibration knob becomes a mystery.
    name: 'config: an unusable divisor is silently repaired',
    file: 'src/config.ts',
    edits: [['  const divisor = config.divisor ?? defaultConfig.divisor',
      '  const divisor = positive(config.divisor) ? config.divisor : defaultConfig.divisor']],
  },
  {
    // The mode check is removed: any spelling is accepted and read as `auto`.
    // Deleted whole rather than falsified — `mode` is a two-member union, so
    // every comparison that would falsify this `if` is a compile error, and an
    // arm that does not compile never reaches the suite.
    name: 'config: an unknown mode is accepted',
    file: 'src/config.ts',
    edits: [[
      "  if (mode !== 'auto' && mode !== 'off') {\n    throw new TypeError(`image-price-fallback: mode must be 'auto' or 'off', received ${JSON.stringify(config.mode)}`)\n  }\n",
      '',
    ]],
  },
  {
    // `maxTokens` is no longer required to be at least `minTokens`, so a
    // configuration whose ceiling is below its floor mounts and clamps upward.
    name: 'config: a ceiling below the floor is accepted',
    file: 'src/config.ts',
    edits: [['  if (!Number.isInteger(maxTokens) || maxTokens < minTokens) {', '  if (!Number.isInteger(maxTokens)) {']],
  },
  {
    // The resolved settings alias the array the caller passed, so a later
    // mutation of the caller's config changes what a mounted plugin prices.
    name: 'config: the resolved providers alias the caller’s array',
    file: 'src/config.ts',
    edits: [['  return { mode, divisor, minTokens, maxTokens, providers: [...providers], log }',
      '  return { mode, divisor, minTokens, maxTokens, providers, log }']],
  },
  {
    // A supplied divisor is ignored, so the documented override does nothing.
    name: 'config: a supplied divisor is ignored',
    file: 'src/config.ts',
    edits: [['  const divisor = config.divisor ?? defaultConfig.divisor', '  const divisor = defaultConfig.divisor']],
  },
  {
    // The published default drifts from the documented one.
    name: 'config: the documented default divisor drifts',
    file: 'src/config.ts',
    edits: [['  divisor: 750,', '  divisor: 1000,']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm can leave the suite waiting on
 * something, and a mutant that never terminates is a mutant the suite cannot
 * report on. It is killed here and counted as caught, which is what it is — the
 * suite never reaches its assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug. Measured
  // in this family: one flat `edits: ['…', '…']` reported "the suite stayed
  // green" while the real mutation was never applied.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      const first = String(built.output).split('\n').find(line => line.trim().length > 0) ?? ''
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: `the mutation does not compile, so the suite never ran: ${first}` })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
