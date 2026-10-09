/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never mentions, must actually ship the
 * files the manifest promises — and must describe its own compatibility range
 * the same way in the manifest and in the README.
 *
 * Each arm is a defect this family has already shipped once somewhere:
 *
 * - A value import declared only in `devDependencies` resolves on the publishing
 *   machine and fails for a consumer with `ERR_MODULE_NOT_FOUND`.
 * - A `files` list that names the entry but not its modules publishes a package
 *   whose own relative imports are missing.
 * - A peer range written too long admits lines where an imported symbol does not
 *   exist; quoted only partially in the README, the documentation becomes the
 *   trap. Both halves are asserted against one list of supported lines.
 *
 * Two claims are specific to this package:
 *
 * - The whole plugin is a **service-instance patch**: it writes
 *   `imageRequestPricing` onto the object `ctx.get('llm')` resolves to. So the
 *   only value import it may make of a harness package is the module that
 *   answers a question at runtime and lives outside that instance
 *   (`offloadedImageText`, from `@deepseek-ai/dsh-llm`) — everything else is a
 *   type and is erased. A dependency here would be how a deployment ends up with
 *   a second copy of the runtime the plugin is patching: the plugin would wrap
 *   one `LlmRuntime` and the meter would read another.
 * - The plugin must not be *silent* about itself. A package that exists to change
 *   a number has no success signal other than its log line, so the manifest's
 *   `description` has to name the symptom an operator would search for.
 *
 * `npm pack --dry-run` is deliberate: it uses npm's own matcher, where a
 * hand-rolled glob would be the same guess the defect is made of.
 *
 * @module test/packaging.spec
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The prerelease lines this plugin claims to work on.
 *
 * The lines were probed with `npm run test:probe-lines`, which pins every harness
 * package to one line and runs the suite against it. Adding a line here without
 * running that is how a wrong range gets published, so the list is the contract
 * and the manifest has to agree with it — not the other way round.
 */
const SUPPORTED_LINES = ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.2']

/** The released line after the last one claimed: the ceiling a range must not cross. */
const NEXT_LINE = '0.3.0'

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export (value or type), `import()` and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])(?:import|export)\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Specifiers a loader resolves at run time: `import x from 'y'`, not `import type { X } from 'y'`. */
function valueSpecifiers(source) {
  return allSpecifiers(source).filter((specifier) => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:import|export)\\s+(?!type\\b)[^'"]*?from\\s*['"]${escaped}['"]`).test(source)
  })
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source).filter(specifier =>
    !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
const importedForValue = new Set()
for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8')
  for (const specifier of bareSpecifiers(source)) imported.add(packageOf(specifier))
  for (const specifier of valueSpecifiers(source)) {
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    importedForValue.add(packageOf(specifier))
  }
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map(file => file.path))
}

test('the walk found the artifact it is meant to be checking', () => {
  // A walk that silently finds nothing would make every assertion below vacuous.
  assert.ok(sourceFiles.some(file => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some(file => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  // The import surface, named rather than counted: a count would pass on any two
  // packages, and what has to be seen are these.
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm']) {
    assert.ok(imported.has(name), `the walk must find the import of ${name}, saw ${[...imported].join(', ')}`)
  }
  const relative = sourceFiles.flatMap(file =>
    allSpecifiers(readFileSync(file, 'utf8')).filter(specifier => specifier.startsWith('.')))
  assert.ok(relative.length >= 4, `expected the entry to reach its own modules, saw ${relative.length} relative specifiers`)
})

test('every bare import in the published artifact is declared', () => {
  const undeclared = [...imported].filter(name => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but not declared in dependencies/peerDependencies: ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('every value import is a peer, and none of them is a dependency', () => {
  // The one value import is a lookup, not a second runtime: `offloadedImageText`
  // reads the harness's own placeholder spelling so the two cannot drift. It has
  // to come from the deployment's copy for the same reason the wrapping does —
  // this package patches a service instance, and a second copy of the package
  // that defines that instance's types is a second conversation.
  assert.ok(importedForValue.has('@deepseek-ai/dsh-llm'),
    `the placeholder lookup is a value import and the walk must see it, saw ${[...importedForValue].join(', ')}`)
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [],
    'this package must have no runtime dependency: a dependency can install a second copy of a harness package')
  for (const name of importedForValue) {
    assert.ok(runtimeDeclared.has(name), `${name} is imported for value but is only a devDependency`)
    assert.ok(Object.keys(manifest.peerDependencies ?? {}).includes(name),
      `${name} is imported for value and must be a peer — the deployment resolves it once, and both sides share that copy`)
  }
})

test('no runtime declaration is left over from a version this plugin no longer describes', () => {
  const unused = [...runtimeDeclared].filter(name => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('every harness peer range admits exactly the lines this plugin claims, and no next line', () => {
  assert.ok(dshPeers.includes('@deepseek-ai/dsh-llm'),
    `expected the runtime peer to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    // The ceiling is the next line, not the next major: a range that reached
    // further would claim a build the suite has never run against. The floor is
    // checked the same way, because a range that reached back past `0.1.7-rc.2`
    // would advertise the builds whose `LlmImageRequestPricing` shape predates
    // the route-pricing seam this plugin exists to answer for.
    assert.ok(!semver.satisfies(NEXT_LINE, range), `the peer range for ${name} must not admit the next released line`)
    assert.ok(!semver.satisfies('0.1.6', range), `the peer range for ${name} must not reach back past the first line the suite ran on`)
  }
})

test('the cordis peer is the one the service and the effect are compiled against', () => {
  // Cordis versions on its own line, so it is not part of `SUPPORTED_LINES` —
  // but it is still a peer the artifact is compiled against, and leaving it out
  // of the manifest would let a consumer install a build where `ctx.get`,
  // `ctx.effect` or `ctx.plugin` has a different contract.
  const range = manifest.peerDependencies['@deepseek-ai/cordis']
  assert.ok(typeof range === 'string' && range.length > 0, 'the cordis peer must carry a range')
  assert.ok(semver.satisfies('4.0.4', range), `the cordis range rejects the version the suite ran against, saw ${range}`)
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits lines
  // where the symbol this plugin answers for does not exist. Both spellings are
  // accepted because a table needs the pipes escaped and prose does not.
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(readme.includes(range.replace(/\|/g, '\\|')) || readme.includes(range),
      `the README must quote the peer range ${range} verbatim (pipes escaped inside a table)`)
  }
  for (const line of SUPPORTED_LINES) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, its modules, the bundle patch, and the type declarations', () => {
  const paths = packedPaths()
  for (const required of [
    'package.json',
    'lib/index.js', 'lib/config.js', 'lib/estimate.js',
    'lib/types/index.d.ts', 'lib/types/config.d.ts', 'lib/types/estimate.d.ts',
    'cordis.patch.yml', 'README.md', 'LICENSE',
  ]) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')),
    'source, tests and scripts stay unpublished')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  assert.ok(patch.includes('image-price-fallback'), 'the bundle patch must use this plugin\'s id')
})

test('every relative import inside the tarball resolves to a file the tarball contains', () => {
  const paths = packedPaths()
  let checked = 0
  for (const file of [...paths].filter(path => path.startsWith('lib/') && path.endsWith('.js'))) {
    for (const specifier of allSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      checked += 1
      const target = resolve(ROOT, dirname(file), specifier)
      const candidates = [target, `${target}.js`, join(target, 'index.js')]
      assert.ok(
        candidates.some(candidate => paths.has(resolve(candidate).slice(ROOT.length + 1))),
        `${file} imports ${specifier}, which the tarball does not contain`,
      )
    }
  }
  assert.ok(checked >= 2, `expected to check the entry's own modules, checked ${checked}`)
})

test('the description names the failure, not the mechanism it is implemented with', () => {
  // The registry's search result is one paragraph, and a user finds this package
  // by its symptom: an image-heavy session whose compaction never fires. The
  // word "pricing" alone would not do — it names the mechanism — so the
  // assertion is on the symptom.
  assert.ok(manifest.description.includes('compaction') && manifest.description.includes('visual tokens'),
    'the description must name the symptom a user would search for')
  assert.ok(manifest.description.length > 400 && manifest.description.length < 2500,
    `the description must be one usable paragraph, saw ${manifest.description.length} characters`)
})

test('every published file the README points at is a file the tarball ships', () => {
  // The README tells a reader to apply `cordis.patch.yml`; a reader who finds it
  // names a path the package does not carry has been told about a file, not
  // given one.
  const paths = packedPaths()
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  for (const named of ['cordis.patch.yml']) {
    assert.ok(readme.includes(named), `the README must name ${named}`)
    assert.ok(paths.has(named), `the README names ${named}, which the tarball does not ship`)
  }
  assert.ok(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8').includes('insert:'),
    'the bundle patch must be a patch the loader can apply, not a placeholder')
})
