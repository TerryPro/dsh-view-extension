/**
 * dsh-diff-view — client-half smoke test.
 *
 * Two things are under test, and they are different in kind:
 *
 * 1. **The plugin contract** — the bundle loads in a fresh realm, exports
 *    `apply`/`inject`, claims exactly one `conversation.view` seat with the
 *    identity the shell expects, and appends exactly one owned stylesheet. A
 *    bundle whose `apply` throws takes the whole shell boot down, so this is the
 *    panic button.
 *
 * 2. **The view's semantics** — the list is read from the plugin's own host
 *    routes, both scopes render, a row selects a file and fetches its
 *    comparison, the status letters and the hunk body are drawn, the filter
 *    narrows the list, and a failed read becomes the reader-facing message
 *    rather than an empty pane.
 *
 * It runs the bundle in a VM realm with the globals the client half touches and
 * a minimal React (hooks, effects, `useSyncExternalStore`), so the interactive
 * path is exercised for real rather than asserted about.
 *
 * Usage: `node tools/smoke-client.mjs`
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'client', 'client.js')

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) await tick()
}

/* ------------------------------------------------------------------ *
 * Minimal React
 * ------------------------------------------------------------------ */

const hooksState = { slots: [], index: 0, dirty: false, pending: [] }

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  for (let at = 0; at < previous.length; at += 1) if (previous[at] !== next[at]) return false
  return true
}

function registerEffect(fn, deps) {
  const at = hooksState.index
  hooksState.index += 1
  const previous = hooksState.slots[at]
  if (previous !== undefined && sameDeps(previous.deps, deps)) return
  if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
  hooksState.slots[at] = { deps: deps === undefined ? undefined : deps.slice(), cleanup: undefined }
  hooksState.pending.push({ at, fn })
}

const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
      .filter(child => child !== null && child !== undefined && child !== false && child !== true)
    return { __el: true, type, props: Object.assign({}, props, { children }) }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const at = hooksState.index
    hooksState.index += 1
    if (!(at in hooksState.slots)) hooksState.slots[at] = typeof initial === 'function' ? initial() : initial
    return [hooksState.slots[at], (value) => {
      const next = typeof value === 'function' ? value(hooksState.slots[at]) : value
      if (next === hooksState.slots[at]) return
      hooksState.slots[at] = next
      hooksState.dirty = true
    }]
  },
  useEffect(fn, deps) { registerEffect(fn, deps) },
  useLayoutEffect(fn, deps) { registerEffect(fn, deps) },
  useRef(initial) {
    const at = hooksState.index
    hooksState.index += 1
    if (!(at in hooksState.slots)) hooksState.slots[at] = { current: initial }
    return hooksState.slots[at]
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useSyncExternalStore(subscribe, getSnapshot) {
    const at = hooksState.index
    hooksState.index += 1
    if (!(at in hooksState.slots)) {
      hooksState.slots[at] = { unsubscribe: subscribe(() => { hooksState.dirty = true }) }
    }
    return getSnapshot()
  },
}

/** Resolve function components and fragments into a plain element tree. */
function resolveNode(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolveNode)
  if (node.__el !== true) return node
  if (node.type === React.Fragment) return chunksOf(node.props.children)
  if (typeof node.type === 'function') return resolveNode(node.type(node.props))
  return { type: node.type, props: node.props, children: (node.props.children || []).map(resolveNode) }
}

function chunksOf(children) {
  return (children || []).map(resolveNode)
}

function childrenOf(node) {
  if (node === null || node === undefined) return []
  if (Array.isArray(node)) return node
  return node.children || (node.props && node.props.children) || []
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.__el !== true && node.props === undefined) return
  visit(node)
  for (const child of childrenOf(node)) walk(child, visit)
}

function findAll(node, predicate) {
  const found = []
  walk(node, (child) => {
    if (predicate(child)) found.push(child)
  })
  return found
}

/** The concatenated text under one node, for copy assertions. */
function textOf(node) {
  let out = ''
  walk(node, (child) => {
    for (const piece of childrenOf(child)) {
      if (typeof piece === 'string' || typeof piece === 'number') out += `${piece} `
      else if (Array.isArray(piece)) out += piece.filter(entry => typeof entry === 'string').join(' ') + ' '
    }
  })
  return out
}

/** Tear down the previous mount the way React would: run every cleanup. */
function unmount() {
  for (const slot of hooksState.slots) {
    if (slot !== null && typeof slot === 'object') {
      if (typeof slot.unsubscribe === 'function') slot.unsubscribe()
      if (typeof slot.cleanup === 'function') slot.cleanup()
    }
  }
  // The plugin's own `ctx.effect` bodies hold the per-Session controllers; a
  // remount in the real shell keeps them, so the test keeps them too — except
  // when it is deliberately starting over.
  if (unmount.disposeControllers === true) {
    for (const cleanup of pluginCleanups.splice(0)) cleanup()
  }
  hooksState.slots = []
  hooksState.index = 0
  hooksState.dirty = false
  hooksState.pending = []
  hooksState.mounted = false
}
unmount.disposeControllers = false

/** Render until nothing is dirty and no effect is pending.
 *
 * The first call after an {@link unmount} is a MOUNT: the hook table starts
 * empty, so every effect runs. A later call is a re-render of that same mount,
 * so hook slots and their deps survive exactly as React keeps them — which is
 * what makes "did this effect re-run?" mean anything.
 */
async function render(element, passes = 40) {
  if (hooksState.mounted !== true) {
    hooksState.slots = []
    hooksState.mounted = true
  }
  let tree = null
  for (let pass = 0; pass < passes; pass += 1) {
    hooksState.index = 0
    hooksState.dirty = false
    hooksState.pending = []
    tree = resolveNode(element)
    for (const entry of hooksState.pending) {
      const cleanup = entry.fn()
      hooksState.slots[entry.at].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    await settle(4)
    if (!hooksState.dirty && hooksState.pending.length === 0) break
  }
  return tree
}

/** Add one more render pass after an interaction changed state. */
async function rerender(element) {
  return await render(element)
}

/* ------------------------------------------------------------------ *
 * DOM, storage, and fetch stubs
 * ------------------------------------------------------------------ */

const styleNodes = []
const documentStub = {
  hidden: false,
  head: { append(node) { styleNodes.push(node) } },
  getElementById(id) {
    return styleNodes.find(node => node.id === id) || null
  },
  createElement() {
    return { id: '', textContent: '', remove() {} }
  },
  addEventListener() {},
  removeEventListener() {},
}

const storage = new Map()
const timers = { intervals: [], timeouts: [] }
const windowStub = {
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
  },
  setInterval(fn, ms) {
    const handle = { fn, ms }
    timers.intervals.push(handle)
    return handle
  },
  clearInterval(handle) {
    const at = timers.intervals.indexOf(handle)
    if (at >= 0) timers.intervals.splice(at, 1)
  },
  setTimeout(fn, ms) {
    const handle = { fn, ms }
    timers.timeouts.push(handle)
    return handle
  },
  clearTimeout(handle) {
    const at = timers.timeouts.indexOf(handle)
    if (at >= 0) timers.timeouts.splice(at, 1)
  },
}

let loaded = null
windowStub.__ModuleLoader__ = { load(definition) { loaded = definition } }

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}") — the bundle must stay dependency-free`)
}

/**
 * Every request the view made, in order.
 *
 * The view calls the plugin's own routes with a page-relative URL
 * (`/api/dsh-diff/...`), exactly as the host half mounts them, so these
 * constants are the literals the bundle must produce.
 */
const requests = []
fetchStub.calls = 0
/** Per-URL canned answers; a missing entry is a 404 with an error envelope. */
let responses = new Map()
/** Prefix standing in for the page origin the shell serves. */
const ORIGIN = 'http://host'

async function fetchStub(url, options) {
  fetchStub.calls += 1
  requests.push({ url: String(url), credentials: options?.credentials })
  const body = responses.get(String(url))
  if (body === undefined) {
    return {
      ok: false,
      status: 404,
      async json() { return { ok: false, error: { code: 'diff/unknown-file', message: 'no such file' } } },
    }
  }
  return { ok: true, status: 200, async json() { return body } }
}

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  fetch: fetchStub,
  navigator: {},
  Intl,
  URLSearchParams,
  encodeURIComponent,
  require: requireStub,
})

/* ------------------------------------------------------------------ *
 * 1. module load + plugin contract
 * ------------------------------------------------------------------ */

console.log('module load')
const source = await readFile(BUNDLE, 'utf8')
let loadError = null
try {
  vm.runInContext(source, context, { filename: 'client.js' })
} catch (error) {
  loadError = error
}
check('the bundle executes without throwing', loadError === null, loadError?.message)
check('it registers exactly one loader entry', loaded !== null)
check('the entry id is the package name', loaded?.id === 'dsh-diff-view', String(loaded?.id))
check('the factory is callable', typeof loaded?.factory === 'function')

if (loaded === null) {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(1)
}

console.log('\nplugin contract')
const plugin = loaded.factory(requireStub)
check('exports.apply is a function', typeof plugin.apply === 'function')
check('exports.inject is an array', Array.isArray(plugin.inject))
for (const service of ['slots', 'locale']) {
  check(`inject names ${service}`, plugin.inject.includes(service), plugin.inject.join(','))
}

/* ------------------------------------------------------------------ *
 * 2. apply(ctx): the seat, its identity, and its stylesheet
 * ------------------------------------------------------------------ */

console.log('\napply(ctx) registration')

const registrations = []
const injected = []
const effects = []
/** Cleanup returned by each `ctx.effect` body, so the test can dispose the plugin. */
const pluginCleanups = []
let localeRegistered = null

const ctx = {
  effect(fn, label) {
    effects.push(label)
    const cleanup = fn()
    if (typeof cleanup === 'function') pluginCleanups.push(cleanup)
    return () => { if (typeof cleanup === 'function') cleanup() }
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistered = { namespace, dictionaries }
    },
    bind() {
      return (key) => `t:${key}`
    },
  },
  slots: {
    inject(slot, register) {
      injected.push(slot)
      register()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

let applyError = null
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply does not throw', applyError === null, applyError?.message)
check('it injects the conversation view seat', injected.includes('conversation.view'), injected.join(','))
check('it registers exactly one entry', registrations.length === 1, String(registrations.length))
check('the seat is conversation.view', registrations[0]?.options.name === 'conversation.view', registrations[0]?.options.name)
check('the view id is diff', registrations[0]?.options.id === 'diff', registrations[0]?.options.id)
check('the view sorts after the shipped views', registrations[0]?.options.order > 10, String(registrations[0]?.options.order))
check('the label is a thunk (locale-following)', typeof registrations[0]?.options.label === 'function')
check('the dictionaries register under the plugin namespace', localeRegistered?.namespace === 'dsh-diff-view', localeRegistered?.namespace)
check('the dictionaries carry both locales', localeRegistered?.dictionaries?.zh !== undefined && localeRegistered?.dictionaries?.en !== undefined)
check('exactly one stylesheet is appended', styleNodes.length === 1, String(styleNodes.length))
check('the stylesheet is namespaced', styleNodes[0]?.textContent.includes('.dshdv-root') === true)
check('the stylesheet uses a theme token', styleNodes[0]?.textContent.includes('--dsw-alias-') === true)

/* ------------------------------------------------------------------ *
 * 3. the view: list, selection, comparison, filter, errors
 * ------------------------------------------------------------------ */

const FILES_GIT = '/api/dsh-diff/files?scope=git&sessionId=sess-1'
const FILES_SESSION = '/api/dsh-diff/files?scope=session&sessionId=sess-1'
const FILE_KEEP = '/api/dsh-diff/file?scope=git&sessionId=sess-1&path=src%2Fkeep.txt'
const FILE_UNTRACKED = '/api/dsh-diff/file?scope=git&sessionId=sess-1&path=untracked.txt'

const GIT_LIST = {
  ok: true,
  scope: 'git',
  cwd: 'F:/ws',
  repo: 'F:/ws',
  added: 4,
  deleted: 1,
  files: [
    { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 3, deleted: 1 },
    { path: 'untracked.txt', display: 'untracked.txt', status: 'untracked', added: 2, deleted: 0 },
    { path: 'src/logo.png', display: 'src/logo.png', status: 'binary', added: 0, deleted: 0, binary: true },
  ],
}

const TEXT_DIFF = {
  ok: true,
  scope: 'git',
  path: 'src/keep.txt',
  kind: 'text',
  before: true,
  after: true,
  coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' one', '-two', '+two changed', ' three', '+four'] },
  ],
}

const SESSION_LIST = {
  ok: true,
  scope: 'session',
  cwd: 'F:/ws',
  repo: null,
  added: 5,
  deleted: 1,
  turns: [2, 1],
  turn: 2,
  files: [
    { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 4, deleted: 1, changedTurns: [1, 2], at: { turn: 2, seq: 9, index: 0 } },
  ],
}

function seedRoutes() {
  requests.length = 0
  responses = new Map([
    [FILES_GIT, GIT_LIST],
    [FILES_SESSION, SESSION_LIST],
    [FILE_KEEP, TEXT_DIFF],
    [FILE_UNTRACKED, {
      ok: true,
      scope: 'git',
      path: 'untracked.txt',
      kind: 'text',
      before: false,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+fresh', '+lines'] }],
    }],
  ])
}

const registration = registrations[0]
const DiffView = registration.component
const viewProps = {
  sessionId: 'sess-1',
  t: (key, values) => {
    const copies = {
      'view.label': '变更',
      'scope.git': '工作区',
      'scope.session': '本次会话',
      'summary.files': '{count} 个文件',
      'summary.added': '+{count}',
      'summary.deleted': '−{count}',
      'filter.placeholder': '筛选文件…',
      'action.refresh': '刷新',
      'action.auto': '自动刷新',
      'action.split': '并排对比',
      'action.wrap': '自动换行',
      'action.copy': '复制路径',
      'list.empty': '当前范围没有改动',
      'list.emptyFiltered': '没有匹配的文件',
      'list.loading': '正在读取改动…',
      'diff.empty': '从左侧选择一个文件查看对比',
      'diff.loading': '正在读取对比…',
      'diff.binary': '二进制文件，无法显示文本对比',
      'status.modified': '修改',
      'status.untracked': '未跟踪',
      'status.binary': '二进制',
      'error.retry': '重试',
      'error.generic': '读取失败',
      'notice.notRepo': '不是 git 仓库',
    }
    let text = copies[key] ?? key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  },
}

/** Compose the view element from the injected face, the way the slot does. */
function viewElement() {
  const face = registration.options.inject('sess-1')
  return React.createElement(DiffView, Object.assign({}, viewProps, face))
}

/** Split a request URL back into shape for shape assertions. */
function parsed(url) {
  return new URL(url, ORIGIN)
}

console.log('\nthe git scope')
seedRoutes()
unmount()
let tree = await render(viewElement())
check('it reads the file list from the plugin route', requests.some(entry => entry.url === FILES_GIT), JSON.stringify(requests.map(entry => entry.url)))
check('the list request is same-origin credentialed', requests[0]?.credentials === 'same-origin', String(requests[0]?.credentials))
check('it selected the first file automatically', requests.some(entry => entry.url === FILE_KEEP), JSON.stringify(requests.map(entry => entry.url)))
const rows = findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined)
check('one row per listed file', rows.length === 3, String(rows.length))
check('the modified file is drawn as M', rows[0]?.props?.title?.includes('修改') === true, String(rows[0]?.props?.title))
check('the untracked file is drawn as U', textOf(rows[1]).includes('U'), textOf(rows[1]))
check('a row shows its directory and name', textOf(rows[0]).includes('keep.txt'), textOf(rows[0]))
check('a row shows its line counts', textOf(rows[0]).includes('+3') && textOf(rows[0]).includes('−1'), textOf(rows[0]))
check('the toolbar counts the files', textOf(tree).includes('3 个文件'), textOf(tree))
check('the toolbar totals additions and deletions', textOf(tree).includes('+4') && textOf(tree).includes('−1'), textOf(tree))

const hunkHeaders = findAll(tree, node => typeof node.children?.[0] === 'string' && node.children[0].startsWith('@@'))
check('the first file comparison is drawn', hunkHeaders.length === 1, String(hunkHeaders.length))
check('the hunk header carries both ranges', hunkHeaders[0]?.children?.[0] === '@@ -1,3 +1,4 @@', String(hunkHeaders[0]?.children?.[0]))
const lines = findAll(tree, node => node.props !== undefined && node.props['data-kind'] !== undefined)
check('every hunk line is drawn', lines.length === 5, String(lines.length))
check('a deletion is marked as one', lines.some(line => line.props['data-kind'] === 'del'))
check('an addition is marked as one', lines.some(line => line.props['data-kind'] === 'add'))
const addedLine = lines.find(line => line.props['data-kind'] === 'add')
check('an addition keeps its text', textOf(addedLine).includes('two changed'), textOf(addedLine))
check('the selected path is shown in the header', findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-path'] !== undefined).length === 1)

console.log('\nselection and layouts')
seedRoutes()
const secondRow = findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'untracked.txt')[0]
secondRow.props.onClick()
tree = await rerender(viewElement())
check('selecting a row reads that file', requests.some(entry => entry.url === FILE_UNTRACKED), JSON.stringify(requests.map(entry => entry.url)))
check('the new comparison replaces the old one', textOf(tree).includes('fresh'), textOf(tree))
const notedLines = findAll(tree, node => node.props !== undefined && node.props['data-diff-note'] !== undefined)
check('a new file is labelled as created', notedLines.length === 1 && notedLines[0].props['data-diff-note'] === 'diff.created', JSON.stringify(notedLines.map(node => node.props['data-diff-note'])))

// Split view is a local layout choice, and a one-sided comparison ignores it.
const splitButton = findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-dsh-diff-split'] !== undefined)[0]
check('the split control is present', splitButton !== undefined)
splitButton.props.onClick()
tree = await rerender(viewElement())
check('a one-sided comparison stays unified', findAll(tree, node => node.props !== undefined && node.props['data-diff-view'] !== undefined)[0]?.props['data-diff-view'] === 'unified', 'split requested on an addition-only diff')

// Wrap is a per-browser preference written where the shell keeps its own.
const wrapButton = findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-dsh-diff-wrap'] !== undefined)[0]
check('wrap starts on', wrapButton?.props['data-dsh-diff-wrap'] === 'on', String(wrapButton?.props['data-dsh-diff-wrap']))
wrapButton.props.onClick()
tree = await rerender(viewElement())
check('turning wrap off persists the choice', storage.get('dsh-diff-view.wrap') === 'nowrap', String(storage.get('dsh-diff-view.wrap')))
check('the wrap control reports its state', findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-wrap'] === 'off').length === 1)

console.log('\nfiltering')
const filterInput = findAll(tree, node => node.type === 'input' && node.props !== undefined && node.props['data-dsh-diff-filter'] !== undefined)[0]
check('the filter field is present', filterInput !== undefined)
filterInput.props.onChange({ target: { value: 'untracked' } })
tree = await rerender(viewElement())
check('the filter narrows the list', findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).length === 1, String(findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).length))
check('the kept row is the matching one', findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'untracked.txt').length === 1)
filterInput.props.onChange({ target: { value: 'nothing-matches' } })
tree = await rerender(viewElement())
check('an empty filter result explains itself', textOf(tree).includes('没有匹配的文件'), textOf(tree))

console.log('\nthe session scope')
seedRoutes()
const sessionTab = findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-scope'] === 'session')[0]
check('the scope switch is present', sessionTab !== undefined)
sessionTab.props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('the session scope reads its own list', requests.some(entry => entry.url === FILES_SESSION), JSON.stringify(requests.map(entry => entry.url)))
check('the session scope keeps its own copy', textOf(tree).includes('本次会话'), textOf(tree))
const sessionFileCall = requests.map(entry => parsed(entry.url)).find(entry => entry.pathname === '/api/dsh-diff/file')
check('a session file carries its turn coordinate', sessionFileCall?.searchParams.get('at') === '2:9:0', sessionFileCall?.search ?? 'no file call')
check('a session file decodes to its repository path', sessionFileCall?.searchParams.get('path') === 'src/keep.txt', sessionFileCall?.searchParams.get('path') ?? '')
check('the chosen scope is remembered', storage.get('dsh-diff-view.scope') === 'session', String(storage.get('dsh-diff-view.scope')))

console.log('\nunavailable and failed states')
seedRoutes()
responses.delete(FILE_KEEP)
storage.set('dsh-diff-view.scope', 'git')
unmount.disposeControllers = true
unmount()
tree = await render(viewElement())
check('a failed comparison offers a retry', textOf(tree).includes('重试'), textOf(tree))

// A listing failure is the list's own state: the whole pane has to say so and
// offer the way back, rather than keeping a previous scope's rows on screen.
responses = new Map()
unmount()
tree = await render(viewElement())
check('a failed listing explains itself', textOf(tree).includes('读取失败'), textOf(tree))
check('a failed listing offers a retry', textOf(tree).includes('重试'), textOf(tree))
check('a failed listing renders no rows', findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).length === 0)

// A Session whose directory is outside git is a normal answer, not a failure:
// the list is empty and the pane explains which scope can still answer.
responses = new Map([
  [FILES_GIT, { ok: true, scope: 'git', cwd: 'F:/plain', repo: null, files: [], added: 0, deleted: 0 }],
])
storage.set('dsh-diff-view.scope', 'git')
unmount.disposeControllers = true
unmount()
tree = await render(viewElement())
check('a directory outside git says so', textOf(tree).includes('不是 git 仓库'), textOf(tree))
check('an empty scope lists nothing rather than failing', findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).length === 0)
check('an empty scope still offers its other scope', findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-scope'] === 'session').length === 1)

// A Session with nothing recorded in the change recorder answers the same way
// from the other side.
responses = new Map([
  [FILES_SESSION, { ok: true, scope: 'session', cwd: 'F:/ws', repo: null, files: [], added: 0, deleted: 0, turns: [] }],
])
unmount.disposeControllers = true
unmount()
tree = await render(viewElement())
const sessionSwitch = findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-scope'] === 'session')[0]
sessionSwitch.props.onClick()
tree = await rerender(viewElement())
check('a session with no recorded change says so', findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-notice'] !== undefined).length === 1, textOf(tree))
check('the notice names the session scope', textOf(tree).includes('notice.noSession'), textOf(tree))

console.log('\nunmount')
unmount()
const cleanups = []
for (const label of effects) cleanups.push(label)
check('the plugin registered its effects', effects.length >= 1, effects.join(','))

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
