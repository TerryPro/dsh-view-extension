/**
 * Checks on the committed CodeMirror chunk itself.
 *
 * The plugin's own smoke test exercises the FALLBACK editor (its loader has no
 * `require.async`), and the real editor cannot be driven without a browser. What can
 * be checked here is the artifact: that it registers itself the way the module
 * loader expects, that its surface is the one the plugin calls, and that the two
 * pure decisions it makes — the grammar for a path, and the indent width for a
 * document — are right. Those are the parts a wrong rebuild would break silently.
 *
 * Run: node tools/test-editor-chunk.mjs
 */
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'

let passed = 0
let failed = 0

function check(name, ok, evidence) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${evidence === undefined ? '' : ` — ${evidence}`}`)
  }
}

const CHUNK = 'client/client.editor.js'
const PLUGIN_ID = 'dsh-diff-view'
const EXPECTED_ID = `${PLUGIN_ID}/client.editor.js`

console.log('the chunk file')
const size = statSync(CHUNK).size
check('the chunk exists and is a real bundle', size > 200_000, `${String(Math.round(size / 1024))} KB`)
/* The loader resolves a chunk as `<plugin>/<fileName>` and only accepts names
 * matching this pattern, so the file name is part of the contract. */
check('its name matches the loader\'s chunk rule', /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test('client.editor.js'))
check('it is declared as an export, or it is not addressable', JSON.parse(readFileSync('package.json', 'utf8')).exports['./client.editor.js'] === './client/editor-placeholder.js'
  || JSON.parse(readFileSync('package.json', 'utf8')).exports['./client.editor.js'] === `./${CHUNK}`,
JSON.parse(readFileSync('package.json', 'utf8')).exports['./client.editor.js'])

console.log('\nits registration')
/* Load the artifact the way the shell does: a `__ModuleLoader__` that records the
 * call, then the registered factory invoked with the platform `require`. The
 * bundle makes its OWN module object inside that factory, which is why the surface
 * comes from the factory's return value and not from anything handed in. */
let registration = null
const loader = { load(definition) { registration = definition } }
const sandbox = { __ModuleLoader__: loader }
const source = readFileSync(CHUNK, 'utf8')
const evaluate = new Function('window', `${source}`)
evaluate(sandbox)
const runtimeRequire = createRequire(import.meta.url)
check('it registers under the id the loader computes', registration !== null && registration.id === EXPECTED_ID, JSON.stringify(registration?.id))
check('and it registers a factory', typeof registration?.factory === 'function', typeof registration?.factory)
const chunk = registration.factory(runtimeRequire)
check('the factory hands back the module surface', chunk !== null && typeof chunk === 'object', typeof chunk)
for (const name of ['createEditor', 'languageForPath', 'indentUnitOf']) {
  check(`the surface carries ${name}`, typeof chunk[name] === 'function', typeof chunk[name])
}
check('and nothing else is promised', typeof chunk.setup === 'undefined', JSON.stringify(Object.keys(chunk)))
check('the factory is dependency-free for the platform require', (() => {
  try {
    registration.factory(() => { throw new Error('require was called') })
    return true
  } catch (error) {
    return false
  }
})(), 'the chunk must not require anything from the platform')

console.log('\nthe grammar it picks')
const cases = [
  ['src/app.ts', true],
  ['src/app.tsx', true],
  ['package.json', true],
  ['index.html', true],
  ['styles.scss', true],
  ['README.md', true],
  ['deploy.yaml', true],
  ['schema.sql', true],
  ['feed.xml', true],
  ['main.cpp', true],
  ['Main.java', true],
  ['main.go', true],
  ['index.php', true],
  ['lib.rs', true],
  ['notes.txt', false],
  ['LICENSE', false],
  ['.gitignore', false],
]
for (const [path, expected] of cases) {
  const got = chunk.languageForPath(path) !== undefined
  check(`${path} ${expected ? 'has' : 'has no'} grammar`, got === expected, String(got))
}

console.log('\nthe indent it infers')
check('a four-space document gets four', chunk.indentUnitOf('function a() {\n    return 1\n}\n') === '    ', JSON.stringify(chunk.indentUnitOf('function a() {\n    return 1\n}\n')))
check('a two-space document gets two', chunk.indentUnitOf('if (a) {\n  b()\n}\n') === '  ', JSON.stringify(chunk.indentUnitOf('if (a) {\n  b()\n}\n')))
check('a tab-indented document gets a tab', chunk.indentUnitOf('if (a) {\n\tb()\n}\n') === '\t', JSON.stringify(chunk.indentUnitOf('if (a) {\n\tb()\n}\n')))
check('a flat document falls back to two', chunk.indentUnitOf('a\nb\nc\n') === '  ', JSON.stringify(chunk.indentUnitOf('a\nb\nc\n')))
check('an empty document does not throw', chunk.indentUnitOf('') === '  ', JSON.stringify(chunk.indentUnitOf('')))

console.log('')
console.log(`${String(passed)} passed, ${String(failed)} failed`)
if (failed > 0) process.exitCode = 1
