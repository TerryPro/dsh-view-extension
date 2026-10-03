/**
 * The build input for `client/client.editor.js` — the CodeMirror chunk.
 *
 * This file is NOT shipped: it exists so the committed chunk can be rebuilt with
 * `npm run build:editor`. The chunk is committed because a plugin must not require
 * its users to have a build step; this is the step that produced it.
 *
 * ## Two decisions worth knowing
 *
 * **The theme is built from the shell's own variables.** Every colour below is a
 * `--dsw-*` / `--ds-*` token with a literal fallback, so the editor follows the
 * shell's light/dark theme by itself instead of looking like a guest in the pane.
 *
 * **Languages are imported explicitly, never through `@codemirror/language-data`.**
 * That package resolves grammars with dynamic `import()`, which emits code-split
 * chunks of its own — and this loader serves exactly ONE sibling file per plugin.
 *
 * @module dsh-diff-view/tools/editor-entry
 */
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, indentMore, indentLess } from '@codemirror/commands'
import { searchKeymap, search, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import {
  bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, foldGutter,
  foldKeymap, codeFolding,
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { rust } from '@codemirror/lang-rust'

/**
 * The editor's look, in the shell's vocabulary.
 *
 * A CodeMirror theme is a list of selectors and style objects; using the design
 * tokens here is what keeps the editor the same object as the rest of the pane —
 * same ink, same hairlines, same radius, same code font.
 */
const shellTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--dsw-alias-label-primary, #1b1f24)',
    backgroundColor: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2, #fafafa))',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--ds-font-family-code, monospace)',
    lineHeight: '1.6',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { caretColor: 'var(--dsw-alias-label-primary, #1b1f24)', padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary, #1b1f24)' },
  /* The gutters: the muted ink the shell's own file tree uses, and no border of
   * their own — the pane already has one. */
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-tertiary, #8b939e)',
    border: 'none',
    fontSize: '11px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '32px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px', cursor: 'pointer' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-secondary, #5b636e)' },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.05))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.14))',
  },
  '&.cm-focused': { outline: 'none' },
  /* Search hits, in the shell's own "attention" ink. */
  '.cm-searchMatch': { backgroundColor: 'var(--dsw-alias-state-warn-primary, #c08a20)', opacity: '.35' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--dsw-alias-state-warn-primary, #c08a20)', opacity: '.6' },
  '.cm-selectionMatch': { backgroundColor: 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.12))' },
  /* The search panel and the completion popup are the two places CodeMirror draws
   * chrome of its own; both are dressed as the shell's surfaces. */
  '.cm-panels': {
    backgroundColor: 'var(--dsw-alias-bg-layer-1, #fff)',
    color: 'var(--dsw-alias-label-primary, #1b1f24)',
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.08))',
  },
  '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-textfield': {
    font: 'inherit',
    color: 'inherit',
    backgroundColor: 'var(--dsw-alias-bg-layer-1, #fff)',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    padding: '3px 6px',
  },
  '.cm-panel.cm-search label': { color: 'var(--dsw-alias-label-secondary, #5b636e)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--dsw-alias-bg-layer-1, #fff)',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))',
    color: 'var(--dsw-alias-label-primary, #1b1f24)',
  },
})

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
  less: () => css(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  yml: () => yaml(),
  yaml: () => yaml(),
  sql: () => sql(),
  xml: () => xml(),
  svg: () => xml(),
  c: () => cpp(),
  h: () => cpp(),
  cc: () => cpp(),
  cpp: () => cpp(),
  hpp: () => cpp(),
  java: () => java(),
  go: () => go(),
  php: () => php(),
  rs: () => rust(),
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
 * How wide one indent step is in THIS document.
 *
 * Read from the file rather than assumed: a tab-indented file and a two-space file
 * are both common, and honouring what is already there is the difference between an
 * editor that helps and one that fights the reader.
 *
 * @param doc - the document's text.
 * @returns the string one indent level inserts.
 */
export function indentUnitOf(doc) {
  const lines = String(doc).split('\n', 200)
  let tabs = 0
  let twos = 0
  let fours = 0
  for (const line of lines) {
    const match = /^([ \t]+)\S/u.exec(line)
    if (match === null) continue
    if (match[1].includes('\t')) tabs += 1
    else if (match[1].length % 4 === 0) fours += 1
    else if (match[1].length % 2 === 0) twos += 1
  }
  if (tabs > twos && tabs > fours) return '\t'
  return fours > twos ? '    ' : '  '
}

/**
 * Mount an editor over one element.
 *
 * The returned handle is the whole surface the plugin uses: the view stays alive
 * while its tab does (so the draft, the undo history and the folded ranges survive
 * a tab switch), and everything the plugin toggles goes through a compartment so it
 * can change without rebuilding the view.
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
        /* Folding: a gutter of its own plus the fold commands on the keymap. */
        codeFolding(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        indentUnit.of(indentUnitOf(options.doc ?? '')),
        EditorState.tabSize.of(4),
        bracketMatching(),
        closeBrackets(),
        /* Word completion from the document itself, plus whatever the grammar
         * offers. A language SERVER is out of reach here; this is the honest
         * ceiling without one. */
        autocompletion({ activateOnTyping: true, closeOnBlur: true }),
        search({ top: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        shellTheme,
        keymap.of([
          /* The reason this chunk exists: Tab indents (and Shift+Tab outdents) the
           * selection instead of walking out of the editor. */
          indentWithTab,
          { key: 'Mod-]', preventDefault: true, run: indentMore },
          { key: 'Mod-[', preventDefault: true, run: indentLess },
          { key: 'Mod-s', preventDefault: true, run: () => { options.onSave?.(view.state.doc.toString()); return true } },
          { key: 'Mod-f', preventDefault: true, run: openSearchPanel },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...foldKeymap,
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
    /** Swap the grammar (a tab reused for another file). */
    setLanguage: (language) => {
      view.dispatch({ effects: languageCompartment.reconfigure(language ?? []) })
    },
    focus: () => { view.focus() },
    destroy: () => { view.destroy() },
  }
}
