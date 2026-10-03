/**
 * The build input for `client/client.editor.js` — the CodeMirror chunk.
 *
 * This file is NOT shipped: it exists so the committed chunk can be rebuilt with
 * `npm run build:editor`. The chunk is committed because a plugin must not require
 * its users to have a build step; this is the step that produced it.
 *
 * Why the explicit language imports and not `@codemirror/language-data`: that
 * package resolves grammars through dynamic `import()`, which would emit code-split
 * chunks of its own — and this loader serves exactly ONE sibling file per plugin.
 * The languages below are the ones that can be bundled inline.
 *
 * @module dsh-diff-view/tools/editor-entry
 */
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, search, highlightSelectionMatches } from '@codemirror/search'
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

/** Extensions that get a grammar, chosen by the file's own name. */
const LANGUAGES = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  scss: () => css(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
}

/**
 * The grammar for one path, or nothing when this chunk has none.
 *
 * @param path - the file's path or name.
 * @returns a CodeMirror language extension, or undefined.
 */
export function languageForPath(path) {
  const at = String(path).lastIndexOf('.')
  if (at <= 0) return undefined
  const pick = LANGUAGES[String(path).slice(at + 1).toLowerCase()]
  return pick === undefined ? undefined : pick()
}

/**
 * Mount an editor over one element.
 *
 * The returned handle is the whole surface the plugin uses: the view stays alive
 * while its tab does (so a draft and the undo history survive a tab switch), and
 * everything the plugin toggles — wrapping, the grammar — goes through a
 * compartment so it can change without rebuilding the view.
 *
 * @param options - `{ parent, doc, language, wrap, onChange, onSave }`.
 * @returns the editor handle.
 */
export function createEditor(options) {
  const wrapCompartment = new Compartment()
  const languageCompartment = new Compartment()
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc ?? '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        closeBrackets(),
        search({ top: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          /* The reason this chunk exists: Tab indents (and Shift+Tab outdents) the
           * selection instead of walking out of the editor. */
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              options.onSave?.(view.state.doc.toString())
              return true
            },
          },
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        languageCompartment.of(options.language ?? []),
        wrapCompartment.of(options.wrap === true ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(update => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString())
        }),
      ],
    }),
  })
  return {
    view,
    /** The live document — what a save must write. */
    text: () => view.state.doc.toString(),
    /** Replace the whole document (a reload from disk). */
    setText: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    /** Turn wrapping on or off without rebuilding the view. */
    setWrap: (on) => {
      view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) })
    },
    /** Swap the grammar (a tab is reused for another file). */
    setLanguage: (language) => {
      view.dispatch({ effects: languageCompartment.reconfigure(language ?? []) })
    },
    focus: () => { view.focus() },
    destroy: () => { view.destroy() },
  }
}
