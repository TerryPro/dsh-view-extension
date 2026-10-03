/**
 * Build `client/client.editor.js` — the lazily loaded CodeMirror chunk.
 *
 * ## Why a committed build artifact
 *
 * A DSH plugin must not require a build step from the person installing it, and
 * this repo deliberately has none for its own halves (they are plain JS the browser
 * loads as they are). The editor is the one part that cannot be hand-written: a
 * real editing surface means a real editor library. So the library is bundled HERE,
 * once, and the result is committed; this script is how it was made, and how it is
 * remade when the editor changes.
 *
 * ## The wrapper
 *
 * The client module loader serves exactly one sibling file per plugin, resolved as
 * `<plugin>/<fileName>` from a `require.async('./…')` call, and it expects that file
 * to register itself: `__ModuleLoader__.load({ id, factory })` with the id
 * `"<pluginId>/<fileName>"`. The bundle is therefore emitted as CommonJS and wrapped
 * in that call, with the loader's `require` handed to it (CodeMirror has no external
 * dependency, so it never calls it).
 *
 * @module dsh-diff-view/tools/build-editor
 */
import { build } from 'esbuild'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outfile = join(root, 'client', 'client.editor.js')
/** Must match the loader's `CLIENT_CHUNK` pattern: `client.<name>.js`. */
const fileName = 'client.editor.js'
const id = `dsh-diff-view/${fileName}`

await build({
  entryPoints: [join(here, 'editor-entry.js')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  banner: {
    js: `/* CodeMirror 6, bundled for dsh-diff-view. Rebuild with: npm run build:editor */\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: function (require) { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

const size = statSync(outfile).size
console.log(`${fileName}: ${(size / 1024).toFixed(0)} KB (id ${id})`)
