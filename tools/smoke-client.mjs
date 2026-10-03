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
 *
 * Enough of the real thing to make a hook-using, memoized component tree
 * behave: per-component hook scopes (so a memoized child keeps its own slots),
 * `React.memo` with a custom comparator and the bailout it implies, and effect
 * flushing on render.
 * ------------------------------------------------------------------ */

let hooksState = { slots: [], index: 0, dirty: false, pending: [] }

/**
 * The dirty flag is process-wide on purpose: a store notification arrives while
 * no component is rendering, so it cannot belong to any one component's scope.
 */
let anyDirty = false

/** Every hook scope a component render created, so a teardown can reach them. */
const componentScopes = new Set()
/** How many times each host element type was actually called. */
const renderCounts = new Map()

function countRender(name) {
  renderCounts.set(name, (renderCounts.get(name) ?? 0) + 1)
}

/** Read one counter. */
function rendersOf(name) {
  return renderCounts.get(name) ?? 0
}

/** Clear the counters. */
function resetRenderCounts() {
  renderCounts.clear()
}

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

/** Component instances by tree path, so the bailout can return the previous element. */
const componentInstances = new Map()

/**
 * Elements built since the last reset.
 *
 * This is the number that decides whether a refresh is felt: React reconciles
 * whatever a component returns, so an element built for a 1000-line comparison
 * is 1000 elements reconciled — per render, forever, unless the subtree bails
 * out of a memo.
 */
let elementsCreated = 0

/** Store notifications delivered to the view: each one is a render. */
let notifications = 0

const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
      .filter(child => child !== null && child !== undefined && child !== false && child !== true)
    elementsCreated += 1
    return { __el: true, type, props: Object.assign({}, props, { children }) }
  },
  Fragment: Symbol('Fragment'),
  memo(component, sameProps) {
    const compared = sameProps ?? ((previous, next) => {
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
      for (const key of keys) if (previous[key] !== next[key]) return false
      return true
    })
    const Memoized = function Memoized(props) {
      return component(props)
    }
    Memoized.__memo = { component, compared }
    return Memoized
  },
  useState(initial) {
    const at = hooksState.index
    /* The setter belongs to the component that created it: an event handler runs
     * long after the render, when `hooksState` is somebody else's scope. */
    const scope = hooksState
    hooksState.index += 1
    if (!(at in scope.slots)) scope.slots[at] = typeof initial === 'function' ? initial() : initial
    return [scope.slots[at], (value) => {
      const next = typeof value === 'function' ? value(scope.slots[at]) : value
      if (next === scope.slots[at]) return
      scope.slots[at] = next
      anyDirty = true
    }]
  },
  useEffect(fn, deps) { registerEffect(fn, deps) },
  useLayoutEffect(fn, deps) { registerEffect(fn, deps) },
  useRef(initial) {
    const at = hooksState.index
    const scope = hooksState
    hooksState.index += 1
    if (!(at in scope.slots)) scope.slots[at] = { current: initial }
    return scope.slots[at]
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useSyncExternalStore(subscribe, getSnapshot) {
    const at = hooksState.index
    const scope = hooksState
    hooksState.index += 1
    if (!(at in scope.slots)) {
      scope.slots[at] = { unsubscribe: subscribe(() => { notifications += 1; anyDirty = true }) }
    }
    return getSnapshot()
  },
}

/**
 * Render one component function inside its own hook scope.
 *
 * The scope is keyed by the component's own props object, and `render()` reuses
 * the props objects it created on the previous pass — so a component that is
 * re-rendered keeps its hook state (mount semantics), and a memoized component
 * whose props did not change keeps its whole subtree, which is the bailout the
 * render-count assertions measure.
 */
/**
 * Render one component function inside its own hook scope.
 *
 * A component INSTANCE is identified by its position in the tree (or its
 * explicit `key`), exactly as React identifies it — never by its type, because
 * the same type is legitimately mounted many times over (one file row per
 * file). The scope therefore survives re-renders and state written by an event
 * handler is visible on the next pass.
 */
function renderComponent(type, props, path) {
  const outer = hooksState
  const name = (type.__memo === undefined ? type.name : type.__memo.component.name) || 'component'
  const instance = componentInstances.get(path)

  /* The memo bailout: unchanged props under the component's own comparator keep
   * the subtree it produced last time, exactly as React does. The comparison is
   * recomputed against the CURRENT props on every pass — caching its previous
   * answer would freeze the row at whatever it showed first. */
  if (type.__memo !== undefined && instance !== undefined && type.__memo.compared(instance.props, props)) {
    countRender(`${name}:bailout`)
    componentInstances.set(path, { ...instance, props })
    return instance.element
  }

  const scope = instance !== undefined ? instance.scope : { slots: [], index: 0, dirty: false, pending: [] }
  scope.index = 0
  hooksState = scope
  let rendered
  try {
    countRender(name)
    rendered = (type.__memo === undefined ? type : type.__memo.component)(props)
  } finally {
    hooksState = outer
  }
  for (const entry of scope.pending) {
    const cleanup = entry.fn()
    scope.slots[entry.at].cleanup = typeof cleanup === 'function' ? cleanup : undefined
  }
  /* The queue is per render pass: leaving an entry in it would re-run the effect
   * on every later pass, which is a harness bug, not a component one. */
  scope.pending = []
  const element = resolveChildren(rendered, path)
  componentInstances.set(path, { props, scope, element })
  return element
}

/** Resolve one element's rendered output, giving every child a stable path. */
function resolveChildren(rendered, path) {
  const list = Array.isArray(rendered) ? rendered : [rendered]
  return list.map((child, index) => {
    const key = child !== null && child !== undefined && child.__el === true && child.props.key !== undefined
      ? `k:${child.props.key}`
      : `i:${index}`
    return resolveNode(child, `${path}/${key}`)
  }).flat().filter(child => child !== null && child !== undefined)
}

/** Resolve function components and fragments into a plain element tree. */
function resolveNode(node, path = 'root') {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (node.__el !== true) return node
  if (node.type === React.Fragment) return resolveChildren(node.props.children, `${path}/frag`)
  if (typeof node.type === 'function') return renderComponent(node.type, node.props, path)
  return {
    type: node.type,
    props: node.props,
    children: resolveChildren(node.props.children, path),
  }
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
  /* Every component instance goes with the unmount: leaving them behind would
   * make the next render a re-render of dead state, which is how a test ends up
   * asserting against the previous block's screen. */
  for (const instance of componentInstances.values()) {
    for (const slot of instance.scope.slots) {
      if (slot !== null && typeof slot === 'object') {
        if (typeof slot.unsubscribe === 'function') slot.unsubscribe()
        if (typeof slot.cleanup === 'function') slot.cleanup()
      }
    }
  }
  componentInstances.clear()
  componentScopes.clear()
  // The plugin's own `ctx.effect` bodies hold the per-Session controllers; a
  // remount in the real shell keeps them, so the test keeps them too — except
  // when it is deliberately starting over.
  if (unmount.disposeControllers === true) {
    for (const cleanup of pluginCleanups.splice(0)) cleanup()
  }
  hooksState.slots = []
  hooksState.index = 0
  hooksState.pending = []
}
unmount.disposeControllers = false

/**
 * Render until no state write is outstanding.
 *
 * Each pass resolves the whole tree; component scopes are keyed by tree path, so
 * a component that is rendered again keeps its hooks and its memo state. A pass
 * that produces no state write ends the loop.
 */
async function render(element, passes = 40) {
  let tree = null
  for (let pass = 0; pass < passes; pass += 1) {
    anyDirty = false
    tree = resolveNode(element)
    await settle(4)
    if (!anyDirty) break
  }
  return tree
}

/** Add one more render pass after an interaction changed state. */
async function rerender(element) {
  return await render(element)
}

/**
 * Count what one silent refresh costs.
 *
 * The refresh is driven directly (rather than by the timer) and measured BEFORE
 * any further render pass, so the numbers describe the tick itself: how many
 * store notifications it published (each one is a render in the real shell) and
 * how many elements were built while it ran.
 *
 * @returns `{ elements, rows, bailouts, notifications, requests }`.
 */
async function measureRefresh() {
  const before = {
    elements: elementsCreated,
    requests: requests.length,
    notifications,
    rows: rendersOf('FileRow'),
    bailouts: rendersOf('FileRow:bailout'),
  }
  await registration.options.inject('sess-1').controller.refresh('sess-1')
  await settle(6)
  const measured = {
    elements: elementsCreated - before.elements,
    rows: rendersOf('FileRow') - before.rows,
    bailouts: rendersOf('FileRow:bailout') - before.bailouts,
    notifications: notifications - before.notifications,
    requests: requests.length - before.requests,
  }
  // A pass afterwards only refreshes the tree the caller asserts against; it is
  // deliberately outside the measurement.
  await rerender(viewElement())
  return measured
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
  /**
   * The bundle tags its stylesheet with `data-plugin` so the module system owns
   * it — an untagged `<style>` is claimed by the next plugin to materialize and
   * deleted with it. This stub answers the one selector that mechanism needs, and
   * records the attributes so the test can assert them.
   */
  querySelector(selector) {
    const match = /^style\[data-plugin="([^"]+)"\]$/u.exec(selector)
    if (match === null) return null
    return styleNodes.find(node => node.attributes?.['data-plugin'] === match[1]) || null
  },
  createElement() {
    return {
      id: '',
      textContent: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      remove() {},
    }
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

/**
 * The shell's UI primitives, standing in for the page's own.
 *
 * The bundle REQUIRES these rather than re-implementing them, so a harness that
 * refused the require would test the fallback path instead of the shipped one.
 * Each stub keeps the real module's contract — and the SHAPE matters as much as
 * the behaviour: the shell's `MarkdownText` is `memo(...)`, i.e. an OBJECT rather
 * than a function. A plain-function stub let a `typeof === 'function'` guard pass
 * here while rejecting the real module in production, which is precisely the bug
 * this stub now prevents.
 */
const primitivesStub = {
  MarkdownText: React.memo(function MarkdownText(props) {
    return React.createElement('div', { 'data-markdown': '', 'data-variant': props.variant ?? 'body' }, props.text)
  }),
  Tag: function Tag(props) {
    return React.createElement('span', { 'data-tone': props.tone ?? 'outline' }, props.children)
  },
  /* The tree vocabulary, shaped like the shell's own: a type-coloured file sheet,
   * the open/closed folder pair (the icon IS the expansion state), and a path
   * label that splits directories from the trailing name. */
  FileTypeIcon: React.memo(function FileTypeIcon(props) {
    return React.createElement('span', { 'data-file-icon': props.kind ?? props.path ?? '', 'data-size': String(props.size ?? 28) })
  }),
  classifyFileType(name) {
    if (/\.(md|markdown)$/iu.test(name)) return 'markdown'
    if (/\.(js|mjs|cjs|ts|tsx|json|yml|yaml)$/iu.test(name)) return 'code'
    return 'other'
  },
  IconFolderOpenRegular: function IconFolderOpenRegular() {
    return React.createElement('span', { 'data-folder': 'open' })
  },
  IconFolderCloseRegular: function IconFolderCloseRegular() {
    return React.createElement('span', { 'data-folder': 'closed' })
  },
  PathLabel: function PathLabel(props) {
    const at = props.path.lastIndexOf('/')
    return React.createElement('span', { 'data-path-label': '', title: props.path, className: props.className },
      at === -1 ? null : React.createElement('span', { 'data-path-directory': '' }, props.path.slice(0, at + 1)),
      React.createElement('span', { 'data-path-name': '' }, at === -1 ? props.path : props.path.slice(at + 1)))
  },
  relativeTime(at, now) {
    const MIN = 60_000
    const HOUR = 3_600_000
    const DAY = 86_400_000
    const diff = Math.max(0, now - at)
    if (diff < MIN) return { unit: 'now', n: 0 }
    if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
    if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
    if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
    if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
    return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
  },
}

let primitivesAsked = false
const requireStub = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    primitivesAsked = true
    return primitivesStub
  }
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
  requests.push({
    url: String(url),
    credentials: options?.credentials,
    method: options?.method ?? 'GET',
    body: options?.body,
  })
  const body = responses.get(String(url))
  if (body === undefined) {
    return {
      ok: false,
      status: 404,
      async json() { return { ok: false, error: { code: 'diff/unknown-file', message: 'no such file' } } },
    }
  }
  if (body.__status !== undefined && body.__status >= 400) {
    return { ok: false, status: body.__status, async json() { return body } }
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
      /* Answer the key UNCHANGED, which is what a page whose locale service does
       * not own this namespace looks like: the plugin then falls back to its own
       * dictionary — the same fallback that has to interpolate `{name}` itself. */
      return (key) => key
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
check('it registers all three of its tabs', registrations.length === 3, String(registrations.length))
check('all seats are conversation.view', registrations.every(entry => entry.options.name === 'conversation.view'), JSON.stringify(registrations.map(entry => entry.options.name)))
check('the tabs have distinct ids', JSON.stringify(registrations.map(entry => entry.options.id)) === JSON.stringify(['diff', 'turns', 'files']), JSON.stringify(registrations.map(entry => entry.options.id)))
check('each tab sorts after the shipped views', registrations.every(entry => entry.options.order > 10), JSON.stringify(registrations.map(entry => entry.options.order)))
check('the tabs keep the order they are listed in', registrations[0].options.order < registrations[1].options.order && registrations[1].options.order < registrations[2].options.order, JSON.stringify(registrations.map(entry => entry.options.order)))
check('each label is a thunk (locale-following)', registrations.every(entry => typeof entry.options.label === 'function'))
check('the labels differ', registrations[0].options.label() !== registrations[1].options.label(), `${registrations[0].options.label()} / ${registrations[1].options.label()}`)
check('the dictionaries register under the plugin namespace', localeRegistered?.namespace === 'dsh-diff-view', localeRegistered?.namespace)
check('the dictionaries carry both locales', localeRegistered?.dictionaries?.zh !== undefined && localeRegistered?.dictionaries?.en !== undefined)
check('exactly one stylesheet is appended', styleNodes.length === 1, String(styleNodes.length))
check('the stylesheet is namespaced', styleNodes[0]?.textContent.includes('.dshdv-root') === true)
check('the stylesheet uses a theme token', styleNodes[0]?.textContent.includes('--dsw-alias-') === true)

/* The row selection visual is the shell's own, not this plugin's invention.
 * `ui-workspace` Rows `.sessionRow.selected` and `ui-sidebar-files` FilesBody
 * `.row:hover` both use ONE interactive fill token and `--dsw-radius-md`; an
 * accent bar, a brand tint or a bold name reads as a foreign element inside the
 * shell, so this guard exists to keep them out. */
const styles = styleNodes[0]?.textContent ?? ''
const rowRule = /^\.dshdv-row\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
const selectedRule = /\.dshdv-row\[aria-selected="true"\]\{([^}]*)\}/u.exec(styles)?.[1] ?? ''
const hoverRule = /\.dshdv-row:hover\{([^}]*)\}/u.exec(styles)?.[1] ?? ''
check('a row uses the shell radius token', rowRule.includes('var(--dsw-radius-md'), rowRule)
check('a row uses primary ink', rowRule.includes('var(--dsw-alias-label-primary'), rowRule)
check('selection uses the shell interactive fill', selectedRule.includes('var(--dsw-alias-interactive-bg-hover'), selectedRule)
check('hover uses the same fill as selection', hoverRule.includes('var(--dsw-alias-interactive-bg-hover'), hoverRule)
check('selection adds no accent bar', selectedRule.includes('box-shadow') === false, selectedRule)
check('selection adds no brand tint', selectedRule.includes('brand') === false, selectedRule)
check('selection does not bold the name', styles.includes('.dshdv-row[aria-selected="true"] .dshdv-name') === false)
const toolRule = /^\.dshdv-btn\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('the strip button is the shell 28px icon button', toolRule.includes('width:28px') && toolRule.includes('height:28px'), toolRule)
check('the strip button fills with the shared interactive token', styles.includes('.dshdv-btn:hover{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover'), 'btn hover rule')

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

/* One file changed in both turns (with different numbers each time) and one
 * changed only in the first: exactly the shape the per-turn view exists for. */
const SESSION_LIST = {
  ok: true,
  scope: 'session',
  cwd: 'F:/ws',
  repo: null,
  added: 5,
  deleted: 1,
  turns: [1, 2],
  turn: 2,
  files: [
    {
      path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 4, deleted: 1,
      changedTurns: [1, 2], at: { turn: 2, seq: 9, index: 0 },
      sources: [
        { turn: 1, seq: 4, index: 0, status: 'modified', added: 1, deleted: 0 },
        { turn: 2, seq: 9, index: 0, status: 'modified', added: 4, deleted: 1 },
      ],
    },
    {
      path: 'src/early.txt', display: 'src/early.txt', status: 'added', added: 1, deleted: 0,
      changedTurns: [1], at: { turn: 1, seq: 4, index: 1 },
      sources: [{ turn: 1, seq: 4, index: 1, status: 'added', added: 1, deleted: 0 }],
    },
    {
      path: 'src/late.txt', display: 'src/late.txt', status: 'added', added: 5, deleted: 0,
      changedTurns: [2], at: { turn: 2, seq: 9, index: 2 },
      sources: [{ turn: 2, seq: 9, index: 2, status: 'added', added: 5, deleted: 0 }],
    },
    {
      path: 'src/gone.txt', display: 'src/gone.txt', status: 'deleted', added: 0, deleted: 3,
      changedTurns: [2], at: { turn: 2, seq: 9, index: 1 },
      sources: [{ turn: 2, seq: 9, index: 1, status: 'deleted', added: 0, deleted: 3 }],
    },
  ],
}

/** One session comparison, addressed by turn. */
function sessionDiff(turn, body, path = 'src/keep.txt') {
  return { ok: true, scope: 'session', path, kind: 'text', before: true, after: true, coarse: false, turn, hunks: body }
}

/* The client percent-encodes the whole `at` value, colons included. */
const SESSION_FILES = {
  keepOne: '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Fkeep.txt&at=1%3A4%3A0',
  keepTwo: '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Fkeep.txt&at=2%3A9%3A0',
  earlyOne: '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Fearly.txt&at=1%3A4%3A1',
  lateTwo: '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Flate.txt&at=2%3A9%3A2',
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
    [SESSION_FILES.keepOne, sessionDiff(1, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+turn-one'] }])],
    [SESSION_FILES.keepTwo, sessionDiff(2, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+turn-two'] }])],
    [SESSION_FILES.earlyOne, sessionDiff(1, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+early', '+file'] }], 'src/early.txt')],
    [SESSION_FILES.lateTwo, sessionDiff(2, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+late', '+file'] }], 'src/late.txt')],
  ])
}

const registration = registrations[0]
const DiffView = registration.component
const viewProps = {
  sessionId: 'sess-1',
  t: (key, values) => {
    const copies = {
      'view.label': '变更',
      'turn.all': '全部轮次',
      'turn.chip': '第 {turn} 轮',
      'turn.tag': 'T{turn}',
      'turn.lastChange': '最后一次改动：第 {turn} 轮',
      'mode.delta': '本轮改动',
      'mode.state': '累计状态',
      'summary.deletedFiles': '{count} 个已删除',
      'commit.action': '记一笔',
      'commit.title': '提交到 git',
      'commit.confirm': '确认提交？',
      'commit.busy': '正在提交…',
      'commit.done': '已提交 {revision}',
      'commit.clean': '没有需要提交的改动',
      'commit.failed': '提交失败：{detail}',
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
      'turns.label': '逐轮',
      'turns.ask': '提问',
      'turns.answer': '最终应答',
      'turns.noAsk': '这一轮没有记录到提问',
      'turns.noAnswer': '这一轮还没有应答',
      'turns.truncated': '内容较长，此处只显示前 {count} 字',
      'turns.list.loading': '正在读取轮次…',
      'turns.list.empty': '这个会话还没有轮次记录',
      'turns.turn': '第 {turn} 轮',
      'turns.open': '进行中',
      'turns.files': '本轮改动',
      'turns.fileCount': '{count} 个文件',
      'turns.noFiles': '这一轮没有改动文件',
      'turns.detail.loading': '正在读取这一轮…',
      'turns.label.turn': '轮次',
      'turns.retry': '重试',
      'diff.norecord': '这一轮没有留下对比记录',
      /* The file view's copy, including the one key that interpolates a value. */
      'files.unsavedConfirm': '{name} 有未保存的修改，确定关闭吗？',
      'files.binary': '二进制文件，不能编辑',
      'files.noTabs': '从左侧选择一个文件打开',
      'files.dirty': '未保存',
      'files.saved': '已保存',
      'files.loading': '正在读取…',
      'files.label': '文件',
      'files.highlight': '高亮',
      'files.edit': '编辑',
      'files.conflict': '磁盘上的这个文件已经变了',
      'files.overwrite': '仍然覆盖',
      'files.reload': '重新载入',
      'files.close': '关闭',
      'files.save': '保存',
      'files.refresh': '刷新目录',
      'files.fileCount': '{count} 个标签',
      'files.empty': '这个目录是空的',
      'files.truncated': '目录过大，只列出了前 {count} 项',
      'files.oversized': '文件太大（上限 {count} 字节）',
      'files.saveFailed': '保存失败：{detail}',
      'files.root': '工作目录',
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

/* The flex row that places the list beside the comparison has exactly two
 * children. Splice a header or a scroll body into it and the detail pane stops
 * being a column: the code column collapses and every line wraps into a
 * readable-looking mess. This is the structure assertion that catches it. */
const main = findAll(tree, node => node.props !== undefined && node.props.className === 'dshdv-main')[0]
check('the main row exists', main !== undefined)
check('the main row holds exactly the list and the detail pane', (main?.children ?? []).length === 2, JSON.stringify((main?.children ?? []).map(child => child?.props?.className)))
const body = findAll(tree, node => node.props !== undefined && node.props.className === 'dshdv-body')[0]
check('the detail pane is one column', body !== undefined)
const bodyChildren = (body?.children ?? []).map(child => child?.props?.className)
check('the detail column holds the header and the comparison', bodyChildren.length === 2 && bodyChildren[0] === 'dshdv-head' && String(bodyChildren[1]).startsWith('dshdv-scroll'), JSON.stringify(bodyChildren))
check('the header is not a sibling of the list', (main?.children ?? []).every(child => child?.props?.className !== 'dshdv-head'))
check('the comparison scroll is not a sibling of the list', (main?.children ?? []).every(child => String(child?.props?.className ?? '').indexOf('dshdv-scroll') === -1))

const lines = findAll(tree, node => node.props !== undefined && node.props['data-kind'] !== undefined)
check('every hunk line is drawn', lines.length === 5, String(lines.length))
check('a deletion is marked as one', lines.some(line => line.props['data-kind'] === 'del'))
check('an addition is marked as one', lines.some(line => line.props['data-kind'] === 'add'))
const addedLine = lines.find(line => line.props['data-kind'] === 'add')
check('an addition keeps its text', textOf(addedLine).includes('two changed'), textOf(addedLine))
check('the selected path is shown in the header', findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-path'] !== undefined).length === 1)

/* The comparison is drawn in the shell's own vocabulary — `ui-primitives`'
 * DiffBlock and CodeCard — so these guards are what keeps it there: no
 * line-number gutter (a different application's diff), the state colour with the
 * 3px inset bar on a tinted row, and the code-block font/radius on the card. */
check('a line carries no line-number gutter', findAll(tree, node => ['dshdv-no', 'dshdv-sign'].includes(node.props?.className)).length === 0, JSON.stringify(findAll(tree, node => ['dshdv-no', 'dshdv-sign'].includes(node.props?.className)).map(node => node.props.className)))
const lineRule = /^\.dshdv-line\[data-kind="add"\]\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('an added line uses the shell diff tint', lineRule.includes('var(--dsw-alias-code-diff-added'), lineRule)
check('an added line uses the shell state colour', lineRule.includes('var(--dsw-alias-state-success-primary'), lineRule)
check('an added line carries the shell inset bar', lineRule.includes('inset 3px 0 0'), lineRule)
const codeRule = /^\.dshdv-code\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('the card uses the shell code-block fill', codeRule.includes('var(--dsw-alias-markdown-code-block'), codeRule)
check('the card uses the shell large radius', codeRule.includes('var(--dsw-radius-lg'), codeRule)
const unifiedRule = /^\.dshdv-line\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('diff lines use the shell markdown code font', unifiedRule.includes('var(--dsw-font-markdown-code-block'), unifiedRule)
check('wrap is the shell attribute, not a row class', styles.includes('.dshdv-code[data-code-wrap="true"] .dshdv-line'), 'wrap rule')
const bubbleRule = /^\.dshdv-tvBubble\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('the question bubble uses the shell bubble fill', bubbleRule.includes('var(--dsw-specific-bubble'), bubbleRule)
check('the question bubble uses the shell bubble radius', bubbleRule.includes('var(--dsw-radius-xl'), bubbleRule)
check('the question bubble follows the body font axis', bubbleRule.includes('--dsh-content-font-size') && bubbleRule.includes('--dsh-content-font-delta'), bubbleRule)

/* The composer contract. A full-height pane that scrolls internally must take
 * `data-conversation-composer-overlay`, or the composer becomes a second stacked
 * block in the conversation's own scroller instead of floating over the pane —
 * the shell's trajectory view takes the same attribute and reserves the same
 * band. Both halves are asserted because either one alone is a broken layout:
 * the attribute without clearance hides the last row, and clearance without the
 * attribute reserves space under a composer that is not there. */
const rootRule = /^\.dshdv-root\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
check('the tab host reserves the live composer height', rootRule.includes('--dshdv-bottom-clearance') && rootRule.includes('var(--dsh-composer-height'), rootRule)
check('the tab host never scrolls itself', rootRule.includes('overflow:hidden') && rootRule.includes('height:100%'), rootRule)
check('every inner scroller clears the composer', /\.dshdv-listBody,\.dshdv-scroll,\.dshdv-tvListBody,\.dshdv-tvSaid,\.dshdv-tvFileList\{padding-bottom:var\(--dshdv-bottom-clearance\)\}/u.test(styles), 'clearance rule')

/* The composer is hidden while a NON-conversation view is elected. The rule is
 * keyed on the elected view's own root, which works because the shell's view host
 * renders one view at a time — so this guard has two halves that must keep
 * agreeing: the selectors in the stylesheet, and the attributes on the roots. A
 * rename on either side would silently stop hiding the composer, which is exactly
 * the kind of failure nobody notices until a reader cannot send a message. */
const hideRule = /\[data-conversation-scroll\]:has\(\[([^\]]+)\]\)>\[data-composer-seat\](?=,|\{)/gu
const hiddenBy = [...styles.matchAll(/\[data-conversation-scroll\]:has\(\[([^\]]+)\]\)>\[data-composer-seat\]/gu)].map(match => match[1])
check('the composer is hidden in the changes tab', hiddenBy.includes('data-dsh-diff-view'), JSON.stringify(hiddenBy))
check('the composer is hidden in the turn tab', hiddenBy.includes('data-dsh-diff-turns'), JSON.stringify(hiddenBy))
check('the composer is hidden in every full-bleed view', hiddenBy.includes('data-conversation-composer-overlay'), JSON.stringify(hiddenBy))
check('the hiding rule is display:none, not a remount', /\[data-conversation-scroll\]:has\(\[data-conversation-composer-overlay\]\)>\[data-composer-seat\]\{display:none\}/u.test(styles), 'hide rule')

/* The turn tab's right column: question and answer over the upper third, changed
 * files over the lower two thirds. Asserted as a RATIO rather than as two
 * spellings of `flex`, because the point is the geometry a reader sees. */
const flexBasisOf = (rule) => {
  const shorthand = /(?:^|;)flex:([^;]*)/u.exec(rule)?.[1] ?? ''
  const basis = shorthand.trim().split(/\s+/u).find(part => part.endsWith('%')) ?? ''
  return Number.parseFloat(basis) || 0
}
const saidRule = /^\.dshdv-tvSaid\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
const filesRule = /^\.dshdv-tvFiles\{([^}]*)\}/mu.exec(styles)?.[1] ?? ''
const saidBasis = flexBasisOf(saidRule)
const filesBasis = flexBasisOf(filesRule)
check('the answer pane takes a third of the column', Math.abs(saidBasis - 100 / 3) < 0.01, `${saidBasis}% — ${saidRule}`)
check('the files pane takes two thirds of the column', Math.abs(filesBasis - 200 / 3) < 0.01, `${filesBasis}% — ${filesRule}`)
check('the two panes add up to the column', Math.abs(saidBasis + filesBasis - 100) < 0.01, `${saidBasis} + ${filesBasis}`)
check('neither pane is content-sized any more', saidRule.includes('max-height') === false && saidRule.includes('flex:0 0'), saidRule)
check('the bundle asks the page for the shell primitives', primitivesAsked === true, 'the primitives module was required at load')

console.log('\nthe auto-refresh cadence')
seedRoutes()
unmount()
tree = await render(viewElement())
const beforeRefresh = requests.length
await registration.options.inject('sess-1').controller.refresh('sess-1')
await settle(6)
tree = await rerender(viewElement())
check('a silent refresh re-reads the list', requests.length > beforeRefresh, `${beforeRefresh} -> ${requests.length}`)
check('a silent refresh does not re-read an unchanged comparison', requests.filter(entry => entry.url === FILE_KEEP).length === 1, JSON.stringify(requests.map(entry => entry.url)))
check('a silent refresh keeps the comparison on screen', findAll(tree, node => typeof node.children?.[0] === 'string' && node.children[0].startsWith('@@')).length === 1)
check('a silent refresh keeps the rows on screen', findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).length === 3)
check('a silent refresh never shows the list spinner', textOf(tree).includes('正在读取改动…') === false, textOf(tree))
check('the cadence schedules one read at a time rather than polling', timers.intervals.length === 0, `${timers.intervals.length} intervals`)
check('the next read is scheduled with a timeout', timers.timeouts.length >= 1, `${timers.timeouts.length} timeouts`)

/* The cost a refresh must NOT pay: rebuilding the comparison on screen. A diff
 * is the largest subtree in this view, so re-creating it every tick is what a
 * reader feels as stutter even when every value is identical. */
const budget = await measureRefresh()
check('a silent refresh with nothing new publishes no state change', budget.notifications === 0, `${budget.notifications} notifications`)
check('a silent refresh does not rebuild the comparison on screen', budget.elements === 0, `${budget.elements} elements built`)
check('a silent refresh does not re-render a file row', budget.rows === 0, `${budget.rows} rows rendered`)
console.log(`  ·  one silent refresh on an unchanged tree: ${budget.requests} request, ${budget.notifications} store notifications, ${budget.elements} elements, ${budget.rows} row renders, ${budget.bailouts} memo bailouts`)

// A file whose own numbers moved is the one case that must re-read.
seedRoutes()
responses.set(FILES_GIT, {
  ok: true, scope: 'git', cwd: 'F:/ws', repo: 'F:/ws', added: 9, deleted: 2,
  files: [
    { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 7, deleted: 2 },
    { path: 'untracked.txt', display: 'untracked.txt', status: 'untracked', added: 2, deleted: 0 },
    { path: 'src/logo.png', display: 'src/logo.png', status: 'binary', added: 0, deleted: 0, binary: true },
  ],
})
await registration.options.inject('sess-1').controller.refresh('sess-1')
await settle(6)
check('a file whose counts moved is re-read', requests.filter(entry => entry.url === FILE_KEEP).length === 1, JSON.stringify(requests.map(entry => entry.url)))

console.log('\nselection and layouts')
seedRoutes()
// Measure what one click costs: rows are memoized, the list fold keeps
// unchanged entries as the same objects, and the handlers are stable — so a
// click must re-render the two rows whose selection flipped and nothing else.
resetRenderCounts()
const selectedBefore = findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined)
  .filter(node => node.props['aria-selected'] === true).map(node => node.props['data-path'])
const secondRow = findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'untracked.txt')[0]
secondRow.props.onClick()
tree = await rerender(viewElement())
const selectedAfter = findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined)
  .filter(node => node.props['aria-selected'] === true).map(node => node.props['data-path'])
check('the row that was selected before the click was the first file', JSON.stringify(selectedBefore) === JSON.stringify(['src/keep.txt']), JSON.stringify(selectedBefore))
check('the clicked row becomes the selected one', JSON.stringify(selectedAfter) === JSON.stringify(['untracked.txt']), JSON.stringify(selectedAfter))
const rowRenders = rendersOf('FileRow')
const rowBailouts = rendersOf('FileRow:bailout')
check('a click re-renders only the rows whose selection changed', rowRenders <= 4, `${rowRenders} row renders (limit 4)`)
check('every other row bails out of the memo', rowBailouts >= 1, `${rowBailouts} memo bailouts`)
console.log(`  ·  one click: ${rowRenders} FileRow renders, ${rowBailouts} memo bailouts, ${requests.length} requests`)
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

console.log('\nthe turn filter')
/** The turn chips currently rendered, in order. */
const turnChips = () => findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-turn'] !== undefined)
/** The row paths currently rendered. */
const rowPaths = () => findAll(tree, node => node.props !== undefined && node.props['data-path'] !== undefined).map(node => node.props['data-path'])
/** The last session comparison the view asked for. */
const lastSessionAt = () => {
  const call = requests.map(entry => parsed(entry.url)).filter(entry => entry.pathname === '/api/dsh-diff/file' && entry.searchParams.get('scope') === 'session').pop()
  return call?.searchParams.get('at') ?? null
}

seedRoutes()
// The search box still holds the previous block's needle; clear it the way a
// reader would before reading the turn strip's own numbers.
const staleFilter = findAll(tree, node => node.type === 'input' && node.props !== undefined && node.props['data-dsh-diff-filter'] !== undefined)[0]
staleFilter.props.onChange({ target: { value: '' } })
tree = await rerender(viewElement())
check('the turn strip is present in the session scope', findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-turns'] !== undefined).length === 1)
/** One chip, found by the turn it names — the strip's order is asserted separately. */
const chipFor = (turn) => turnChips().find(chip => chip.props['data-turn'] === String(turn))
const chips = turnChips()
check('one chip per turn plus the aggregate', chips.length === 3, JSON.stringify(chips.map(chip => chip.props['data-turn'])))
check('the first turn is at the top of the strip', JSON.stringify(chips.map(chip => chip.props['data-turn'])) === JSON.stringify(['all', '1', '2']), JSON.stringify(chips.map(chip => chip.props['data-turn'])))
check('the aggregate chip counts every file', textOf(chips[0]).includes('4'), textOf(chips[0]))
check('a turn chip counts only its own files', textOf(chipFor(1)).includes('2') && textOf(chipFor(2)).includes('3'), `${textOf(chipFor(1))} / ${textOf(chipFor(2))}`)
check('the aggregate chip starts pressed', chips[0].props['aria-pressed'] === true)
check('the aggregate view lists every file', rowPaths().length === 4, JSON.stringify(rowPaths()))

// Turn 1: the two files it touched, and the comparison read at TURN 1's coordinate.
chipFor(1).props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('choosing a turn presses its chip', chipFor(1).props['aria-pressed'] === true, JSON.stringify(turnChips().map(chip => chip.props['aria-pressed'])))
check('choosing a turn narrows the list to its files', JSON.stringify(rowPaths().sort()) === JSON.stringify(['src/early.txt', 'src/keep.txt']), JSON.stringify(rowPaths()))
check('the first file of that turn becomes selected', lastSessionAt() === '1:4:0', String(lastSessionAt()))
/* This pair of assertions is also the regression guard for a memo comparator
 * that compared a prop DiffBody never receives: a comparison that arrived in the
 * SAME phase as the one on screen was silently ignored, so the pane kept showing
 * the previous turn's (or file's) content. A local read is fast enough that no
 * render happens in between, which is exactly how that bug survived the git-scope
 * tests — there the phase changes, here it may not. */
check('the comparison on screen is that turn\'s', textOf(tree).includes('turn-one'), textOf(tree))
const firstRowCounts = textOf(findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'src/keep.txt')[0])
check('a row shows THAT turn\'s counts', firstRowCounts.includes('+1') && firstRowCounts.includes('+4') === false, firstRowCounts)

// Turn 2: only the files that turn changed, deletions included.
chipFor(2).props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('the other turn lists only its own files', JSON.stringify(rowPaths().sort()) === JSON.stringify(['src/gone.txt', 'src/keep.txt', 'src/late.txt']), JSON.stringify(rowPaths()))
check('the comparison is read at that turn\'s coordinate', lastSessionAt() === '2:9:0', String(lastSessionAt()))
check('the comparison on screen switched turns', textOf(tree).includes('turn-two') && textOf(tree).includes('turn-one') === false, textOf(tree))
check('the row counts are that turn\'s', textOf(findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'src/keep.txt')[0]).includes('+4'), textOf(findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'src/keep.txt')[0]))

// Back to the aggregate: everything, compared at each file's newest turn.
chipFor('all').props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('the aggregate chip restores every file', rowPaths().length === 4, JSON.stringify(rowPaths()))
check('the aggregate view compares at the newest turn again', lastSessionAt() === '2:9:0', String(lastSessionAt()))

console.log('\nthe state axis')
/** The mode chips currently rendered. */
const modeChips = () => findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-mode'] !== undefined)
/** Press the chip for one axis. */
const chooseMode = async (mode) => {
  modeChips().find(chip => chip.props['data-mode'] === mode).props.onClick()
  await settle(4)
  tree = await rerender(viewElement())
}

seedRoutes()
check('the axis switch is present', modeChips().length === 2, String(modeChips().length))
check('the delta axis starts pressed', modeChips()[0].props['aria-pressed'] === true && modeChips()[1].props['aria-pressed'] === false, JSON.stringify(modeChips().map(chip => chip.props['aria-pressed'])))
check('the delta axis counts a turn\'s OWN files', textOf(chipFor(2)).includes('3'), textOf(chipFor(2)))
check('the delta axis lists every changed file', rowPaths().length === 4, JSON.stringify(rowPaths()))

// Turn 2 in the delta axis: exactly what that turn touched, deletions included.
chipFor(2).props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('the delta axis lists what the turn touched', JSON.stringify(rowPaths().sort()) === JSON.stringify(['src/gone.txt', 'src/keep.txt', 'src/late.txt']), JSON.stringify(rowPaths()))

// The state axis at the same turn: what EXISTS after it.
await chooseMode('state')
check('the state axis is pressed', modeChips()[1].props['aria-pressed'] === true, JSON.stringify(modeChips().map(chip => chip.props['aria-pressed'])))
check('a file deleted by the turn leaves the state list', rowPaths().includes('src/gone.txt') === false, JSON.stringify(rowPaths()))
check('a file added by the turn joins the state list', rowPaths().includes('src/late.txt') === true, JSON.stringify(rowPaths()))
check('the state axis keeps files changed by earlier turns', rowPaths().includes('src/early.txt') === true, JSON.stringify(rowPaths()))
check('the state list is the files that exist', rowPaths().length === 3, JSON.stringify(rowPaths()))
check('the deleted file is counted, not listed', textOf(tree).includes('1 个已删除'), textOf(tree))
check('the axis switch is remembered', storage.get('dsh-diff-view.mode') === 'state', String(storage.get('dsh-diff-view.mode')))
check('the state axis counts files changed up to the turn', textOf(chipFor(1)).includes('2'), textOf(chipFor(1)))

// A file whose last change is an EARLIER turn is still compared at that turn.
const earlyRow = findAll(tree, node => node.props !== undefined && node.props['data-path'] === 'src/early.txt')[0]
check('a row names the turn of its last change', textOf(earlyRow).includes('T1'), textOf(earlyRow))
earlyRow.props.onClick()
await settle(4)
tree = await rerender(viewElement())
check('selecting it reads ITS last change, not the bound turn', lastSessionAt() === '1:4:1', String(lastSessionAt()))
check('the pane shows that earlier turn\'s comparison', textOf(tree).includes('early'), textOf(tree))
check('the header names the last change', textOf(tree).includes('最后一次改动：第 1 轮'), textOf(tree))

// Back to the delta axis: the same turn now lists only what it touched.
await chooseMode('delta')
check('the delta axis is pressed again', modeChips()[0].props['aria-pressed'] === true, JSON.stringify(modeChips().map(chip => chip.props['aria-pressed'])))
check('the delta axis drops the file the turn did not change', rowPaths().includes('src/early.txt') === false, JSON.stringify(rowPaths()))
check('the delta axis brings the deleted file back', rowPaths().includes('src/gone.txt') === true, JSON.stringify(rowPaths()))

console.log('\nthe checkpoint button')
const COMMIT_URL = '/api/dsh-diff/commit'
/** The button as it currently stands. */
const commitButton = () => findAll(tree, node => node.type === 'button' && node.props !== undefined && node.props['data-dsh-diff-commit'] !== undefined)[0]
/** The note the last checkpoint left, if any. */
const commitNote = () => findAll(tree, node => node.props !== undefined && node.props['data-dsh-diff-commit-note'] !== undefined)[0]
/** Press it twice: arm, then commit. */
const pressCheckpoint = async () => {
  commitButton().props.onClick()
  tree = await rerender(viewElement())
  commitButton().props.onClick()
  await settle(4)
  tree = await rerender(viewElement())
}

seedRoutes()
check('the checkpoint button is present', commitButton() !== undefined)
check('it starts idle', commitButton().props['data-dsh-diff-commit'] === 'idle', String(commitButton().props['data-dsh-diff-commit']))

// First press only arms it: nothing is committed until the second.
commitButton().props.onClick()
tree = await rerender(viewElement())
check('the first press arms it', commitButton().props['data-dsh-diff-commit'] === 'confirm', String(commitButton().props['data-dsh-diff-commit']))
check('the armed button names what the next press does', textOf(commitButton()).includes('确认提交？'), textOf(commitButton()))
check('arming commits nothing', requests.some(entry => entry.url === COMMIT_URL) === false, JSON.stringify(requests.map(entry => entry.url)))

// The second press commits: one POST carrying the Session.
responses.set(COMMIT_URL, { ok: true, committed: true, revision: 'abc1234', repository: 'F:/ws', message: 'dsh-diff-view: checkpoint' })
const listReadsBefore = requests.filter(entry => entry.url === FILES_SESSION).length
commitButton().props.onClick()
await settle(4)
tree = await rerender(viewElement())
const commitCall = requests.filter(entry => entry.url === COMMIT_URL).pop()
check('the second press commits', commitCall !== undefined, JSON.stringify(requests.map(entry => entry.url)))
check('it commits with a POST', commitCall?.method === 'POST', String(commitCall?.method))
check('the body names the session', JSON.parse(commitCall?.body ?? '{}').sessionId === 'sess-1', String(commitCall?.body))
check('the body names the turn being viewed', JSON.parse(commitCall?.body ?? '{}').turn === 2, String(commitCall?.body))
check('the button reports the revision it created', textOf(commitNote() ?? { props: {} }).includes('已提交 abc1234'), textOf(tree))
check('the list is re-read after a commit', requests.filter(entry => entry.url === FILES_SESSION).length > listReadsBefore, JSON.stringify(requests.map(entry => entry.url)))
check('the button returns to idle', commitButton().props['data-dsh-diff-commit'] === 'done', String(commitButton().props['data-dsh-diff-commit']))

// A clean tree is an answer, not a failure.
responses.set(COMMIT_URL, { ok: true, committed: false, reason: 'clean' })
await pressCheckpoint()
check('a clean tree says so', textOf(commitNote() ?? { props: {} }).includes('没有需要提交的改动'), textOf(tree))

// A refusal is reported with git's own words.
responses.set(COMMIT_URL, { __status: 500, ok: false, error: { code: 'diff/commit-failed', message: 'Please tell me who you are' } })
await pressCheckpoint()
check('a refused commit is reported', textOf(commitNote() ?? { props: {} }).includes('提交失败：Please tell me who you are'), textOf(tree))

// An armed button must not survive a remount: the reader who armed it is gone.
commitButton().props.onClick()
tree = await rerender(viewElement())
check('it can be armed again', commitButton().props['data-dsh-diff-commit'] === 'confirm', String(commitButton().props['data-dsh-diff-commit']))
unmount()
tree = await render(viewElement())
check('a remount disarms it', commitButton().props['data-dsh-diff-commit'] === 'idle', String(commitButton().props['data-dsh-diff-commit']))

console.log('\nunavailable and failed states')
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

console.log('\nthe per-turn browser')
const TurnsView = registrations[1].component
const turnFace = registrations[1].options.inject('sess-1')
const TURNS_LIST = '/api/dsh-diff/turns?sessionId=sess-1'
const TURN_DETAIL = turn => `/api/dsh-diff/turn?sessionId=sess-1&turn=${turn}`
const TURN_FILE = '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Fkeep.txt&at=2%3A9%3A0'
const TURN_FILE_ONE = '/api/dsh-diff/file?scope=session&sessionId=sess-1&path=src%2Fearly.txt&at=1%3A4%3A1'

/**
 * An answer with the shapes a real one has: a heading, prose, a bulleted list
 * with inline code, and a fenced block. Rendered by the shell's `MarkdownText`
 * when the page exposes it, and by the bundle's own renderer when it does not —
 * the assertions below check BOTH paths.
 */
const MARKDOWN_ANSWER = '## 结论\n\n改完了：两个文件。\n\n- `keep.txt` 改了 4 行\n- `gone.txt` 删了 3 行\n\n| 文件 | 改动 |\n|---|---|\n| keep.txt | +4 −1 |\n\n```js\nconst a = 1\n```\n'

const turnListResponse = {
  ok: true,
  cwd: 'F:/ws',
  /* Oldest first: the route's own order, which the view renders verbatim. */
  turns: [
    { turn: 1, open: false, seq: 1, time: 1000, prompt: { text: '第一轮'.repeat(60), truncated: true, human: true }, answer: { text: '先看座位。', truncated: false }, files: 2, added: 2, deleted: 0 },
    { turn: 2, open: false, seq: 6, time: 2000, prompt: { text: '第二轮：把状态也算出来', truncated: false, human: true }, answer: { text: MARKDOWN_ANSWER, truncated: false }, files: 3, added: 4, deleted: 4 },
    { turn: 3, open: true, seq: 13, time: 3000, prompt: null, answer: null, files: 0, added: 0, deleted: 0 },
  ],
}

/** One turn's detail, shaped the way the route serves it. */
function turnDetail(turn, files, prompt, answer, extra = {}) {
  return Object.assign({
    ok: true,
    cwd: 'F:/ws',
    turn,
    open: false,
    prompt,
    answer,
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
  }, extra)
}

/**
 * Install the turn browser's fixtures.
 *
 * Deliberately NOT `seedRoutes()`: that one covers the two tabs of the changes
 * view and would leave every turn route answering 404, which the pane correctly
 * renders as its error state — a mistake that reads like a product bug.
 */
function seedTurnRoutes() {
  requests.length = 0
  responses = new Map([
    [TURNS_LIST, turnListResponse],
    [TURN_DETAIL(2), turnDetail(2, [
      { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 4, deleted: 1, at: { turn: 2, seq: 9, index: 0 } },
      { path: 'src/gone.txt', display: 'src/gone.txt', status: 'deleted', added: 0, deleted: 3, at: { turn: 2, seq: 9, index: 1 } },
      { path: 'F:/ws/src/absolute.js', display: 'F:/ws/src/absolute.js', status: 'added', added: 0, deleted: 0, at: null, derived: true },
    ], { text: '第二轮：把状态也算出来', truncated: false, human: true }, { text: MARKDOWN_ANSWER, truncated: false })],
    [TURN_DETAIL(1), turnDetail(1, [
      { path: 'src/early.txt', display: 'src/early.txt', status: 'added', added: 2, deleted: 0, at: { turn: 1, seq: 4, index: 1 } },
    ], { text: '第一轮'.repeat(60), truncated: true, human: true }, { text: '先看座位。', truncated: false })],
    [TURN_DETAIL(3), turnDetail(3, [], null, null, { open: true })],
    [TURN_FILE, { ok: true, scope: 'session', path: 'src/keep.txt', kind: 'text', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+turn-two'] }] }],
    [TURN_FILE_ONE, { ok: true, scope: 'session', path: 'src/early.txt', kind: 'text', before: false, after: true, coarse: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+early', '+file'] }] }],
  ])
}

seedTurnRoutes()
requests.length = 0
unmount.disposeControllers = true
unmount()
let turnTree = await render(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
/** The turn rows currently rendered. */
const turnRows = () => findAll(turnTree, node => node.type === 'button' && node.props !== undefined && node.props['data-turn'] !== undefined)
/** The file rows of the turn in view. */
const turnFileRows = () => findAll(turnTree, node => node.type === 'button' && node.props !== undefined && node.props['data-path'] !== undefined)

check('the turn browser reads its own route', requests.some(entry => entry.url === TURNS_LIST), JSON.stringify(requests.map(entry => entry.url)))
check('the turn tab takes the composer overlay contract', findAll(turnTree, node => node.props?.['data-conversation-composer-overlay'] !== undefined).length === 1, String(findAll(turnTree, node => node.props?.['data-conversation-composer-overlay'] !== undefined).length))
/* The attribute the hiding rule keys on must be on the SAME root the rule names. */
check('the turn tab is the root the hiding rule names', findAll(turnTree, node => node.props?.['data-dsh-diff-turns'] !== undefined).length === 1, String(findAll(turnTree, node => node.props?.['data-dsh-diff-turns'] !== undefined).length))
check('it lists one row per turn', turnRows().length === 3, JSON.stringify(turnRows().map(row => row.props['data-turn'])))
check('the first turn is at the top', JSON.stringify(turnRows().map(row => row.props['data-turn'])) === JSON.stringify(['1', '2', '3']), JSON.stringify(turnRows().map(row => row.props['data-turn'])))
check('a running turn is marked', textOf(turnRows()[2]).includes('进行中'), textOf(turnRows()[2]))
check('a row carries the turn\'s own counts', textOf(turnRows()[1]).includes('3') && textOf(turnRows()[1]).includes('+4'), textOf(turnRows()[1]))
check('a turn with no changes shows none', textOf(turnRows()[2]).includes('+') === false, textOf(turnRows()[2]))
check('the newest turn starts selected', turnRows()[2].props['aria-selected'] === true, JSON.stringify(turnRows().map(row => row.props['aria-selected'])))
check('selecting reads that turn', requests.some(entry => entry.url === TURN_DETAIL(3)), JSON.stringify(requests.map(entry => entry.url)))
check('a row is dated the way the shell dates a row', textOf(turnRows()[0]).includes('时间') === false && /\d/u.test(textOf(turnRows()[0])), textOf(turnRows()[0]))
check('an open turn with no changes says so', textOf(turnTree).includes('这一轮没有改动文件'), textOf(turnTree))
check('an open turn with no prompt says so', textOf(turnTree).includes('这一轮没有记录到提问'), textOf(turnTree))

// Turn 2: question above, answer below it, changed files underneath.
turnRows()[1].props.onClick()
await settle(4)
turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
check('choosing a turn reads its detail', requests.some(entry => entry.url === TURN_DETAIL(2)), JSON.stringify(requests.map(entry => entry.url)))
check('the detail shows the question', textOf(turnTree).includes('第二轮：把状态也算出来'), textOf(turnTree))
check('and the answer', textOf(turnTree).includes('改完了：两个文件。'), textOf(turnTree))
/* The shell's own language: a question is a right-aligned bubble on
 * `--dsw-specific-bubble`, an answer is Markdown. Neither carries a visible
 * label in chat, so both carry an accessible one instead of invented chrome. */
check('the question is drawn as the shell\'s user bubble', findAll(turnTree, node => node.props?.className === 'dshdv-tvBubble').length === 1, JSON.stringify(findAll(turnTree, node => node.props?.className === 'dshdv-tvBubble').length))
check('the answer goes through the shell\'s Markdown renderer', findAll(turnTree, node => node.props?.['data-markdown'] !== undefined).length === 1)
check('the markdown renderer is given its chrome copy', findAll(turnTree, node => node.props?.['data-markdown'] !== undefined)[0] !== undefined)
check('each block is named for assistive tech', findAll(turnTree, node => node.props?.['aria-label'] === '提问').length === 1 && findAll(turnTree, node => node.props?.['aria-label'] === '最终应答').length === 1, JSON.stringify(findAll(turnTree, node => node.props?.['aria-label'] !== undefined).map(node => node.props['aria-label'])))
check('the changed files are listed', turnFileRows().length === 3, JSON.stringify(turnFileRows().map(row => row.props['data-path'])))
check('the first file of the turn is selected', turnFileRows()[0].props['aria-selected'] === true, JSON.stringify(turnFileRows().map(row => row.props['aria-selected'])))
check('its comparison is read at that turn\'s coordinate', requests.some(entry => entry.url === TURN_FILE), JSON.stringify(requests.map(entry => entry.url)))
check('the comparison is drawn', textOf(turnTree).includes('turn-two'), textOf(turnTree))
check('a deletion is shown with its status', textOf(turnFileRows()[1]).includes('D'), textOf(turnFileRows()[1]))

// A file whose turn kept no comparison says so instead of failing.
turnFileRows()[2].props.onClick()
await settle(4)
turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
check('a file with no stored comparison asks for none', requests.some(entry => entry.url.includes('absolute.js')) === false, JSON.stringify(requests.map(entry => entry.url)))
check('and says there is none', textOf(turnTree).includes('这一轮没有留下对比记录'), textOf(turnTree))

// Turn 1: a long prompt is clipped, and the note says so.
turnRows()[0].props.onClick()
await settle(4)
turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
check('a truncated text is noted', textOf(turnTree).includes('内容较长'), textOf(turnTree))
check('the truncated prompt is shown as far as it goes', textOf(turnTree).includes('第一轮'), textOf(turnTree))
check('that turn\'s own file is listed', turnFileRows().length === 1 && turnFileRows()[0].props['data-path'] === 'src/early.txt', JSON.stringify(turnFileRows().map(row => row.props['data-path'])))
check('and read at its own turn', requests.some(entry => entry.url === TURN_FILE_ONE), JSON.stringify(requests.map(entry => entry.url)))
check('an addition-only comparison shows its created note', findAll(turnTree, node => node.props?.['data-diff-note'] === 'diff.created').length === 1, JSON.stringify(findAll(turnTree, node => node.props?.['data-diff-note'] !== undefined).map(node => node.props['data-diff-note'])))
check('the comparison carries the shell\'s code-wrap attribute', findAll(turnTree, node => node.props?.['data-code-wrap'] !== undefined).length >= 1)

// A failed turn list is the list's own state, with a way back.
unmount()
responses = new Map()
turnTree = await render(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
check('a failed turn list explains itself', textOf(turnTree).includes('读取失败'), textOf(turnTree))
check('and offers a retry', textOf(turnTree).includes('重试'), textOf(turnTree))
check('with no rows to mislead', turnRows().length === 0, JSON.stringify(turnRows().length))

/* A page WITHOUT the shell's primitives.
 *
 * The bundle is loaded once per realm, but its factory is a pure function of the
 * require it is handed, so a second call with a require that refuses the
 * primitives module is exactly the page this fallback exists for: the answer must
 * still be RENDERED as Markdown, never shown as its own source. */
console.log('\nthe built-in Markdown renderer (no shell primitives)')
const bareRegistrations = []
const barePlugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`refused: ${name}`)
})
const bareCtx = {
  effect(fn) { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
  locale: { register() {}, bind() { return (key) => key } },
  slots: {
    inject(slot, register) { register() },
    register(options, component) { bareRegistrations.push({ options, component }); return () => {} },
  },
}
barePlugin.apply(bareCtx)
check('the plugin still registers its tabs without the primitives', bareRegistrations.length === 3, String(bareRegistrations.length))
const BareTurns = bareRegistrations[1]?.component
const bareFace = bareRegistrations[1]?.options.inject('sess-1')
responses = new Map([
  [TURNS_LIST, turnListResponse],
  [TURN_DETAIL(2), turnDetail(2, [
    { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 4, deleted: 1, at: { turn: 2, seq: 9, index: 0 } },
  ], { text: '第二轮：把状态也算出来', truncated: false, human: true }, { text: MARKDOWN_ANSWER, truncated: false })],
  [TURN_FILE, { ok: true, scope: 'session', path: 'src/keep.txt', kind: 'text', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+turn-two'] }] }],
])
unmount()
let bareTree = await render(React.createElement(BareTurns, Object.assign({}, viewProps, bareFace)))
const bareTurnTwo = findAll(bareTree, node => node.type === 'button' && node.props?.['data-turn'] === '2')[0]
bareTurnTwo.props.onClick()
await settle(4)
bareTree = await rerender(React.createElement(BareTurns, Object.assign({}, viewProps, bareFace)))
const bareMarker = findAll(bareTree, node => node.props?.['data-markdown'] !== undefined)[0]
check('the answer falls back to the built-in renderer', bareMarker?.props['data-markdown'] === 'builtin', JSON.stringify(bareMarker?.props))
check('a heading becomes a heading block', findAll(bareTree, node => node.props?.className === 'dshdv-mdH' && node.props?.['data-level'] === '2').length === 1, JSON.stringify(findAll(bareTree, node => node.props?.className === 'dshdv-mdH').length))
check('a list becomes a list', findAll(bareTree, node => node.type === 'ul').length === 1 && findAll(bareTree, node => node.type === 'li').length === 2, JSON.stringify(findAll(bareTree, node => node.type === 'li').length))
check('inline code becomes code', findAll(bareTree, node => node.props?.className === 'dshdv-mdCode').length === 2, JSON.stringify(findAll(bareTree, node => node.props?.className === 'dshdv-mdCode').map(node => textOf(node))))
const hasClass = (node, name) => String(node?.props?.className ?? '').split(/\s+/u).includes(name)
check('a fence becomes a code block, not literal backticks', findAll(bareTree, node => hasClass(node, 'dshdv-mdFence')).length === 1 && textOf(bareTree).includes('const a = 1'), textOf(bareTree))
const bareLangs = findAll(bareTree, node => hasClass(node, 'dshdv-mdFenceLang'))
check('a fence names its language', bareLangs.length === 1 && textOf(bareLangs[0]).trim() === 'js', JSON.stringify({ count: bareLangs.length, text: bareLangs.map(node => textOf(node)) }))
check('a pipe table becomes a real table', findAll(bareTree, node => node.type === 'table').length === 1 && findAll(bareTree, node => node.type === 'th').length === 2, JSON.stringify({ tables: findAll(bareTree, node => node.type === 'table').length, headers: findAll(bareTree, node => node.type === 'th').length }))
check('no raw Markdown syntax is left in the prose', textOf(bareTree).includes('## ') === false && textOf(bareTree).includes('```') === false, textOf(bareTree))
check('the answer text survives the fallback', textOf(bareTree).includes('改完了：两个文件。'), textOf(bareTree))
check('the shell renderer is not used on this page', findAll(bareTree, node => node.props?.['data-markdown'] === '').length === 0)

console.log('\nthe turn browser\'s refresh cost')
/*
 * The turn browser ticks on a timer like the changes tab, so it owes the same
 * guarantee: a tick that finds nothing new must cost nothing but its list read —
 * no detail read, no comparison read, and no element rebuilt. A "silent" tick
 * that re-read every turn and re-blank the diff is exactly what made this pane
 * feel slow: the trap was comparing the selected row against a synthesized
 * stand-in, which can never be equal, so every tick took the slow path.
 */
const turnsRefresh = async () => {
  const face = registrations[1].options.inject('sess-1')
  const before = { elements: elementsCreated, requests: requests.length, notifications }
  await face.controller.refresh('sess-1')
  await settle(6)
  return {
    elements: elementsCreated - before.elements,
    notifications: notifications - before.notifications,
    requests: requests.length - before.requests,
    urls: requests.slice(before.requests).map(entry => entry.url),
  }
}
/** Re-render the turn tab into the tree the assertions read. */
const showTurns = async () => {
  turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
}

seedTurnRoutes()
unmount()
turnTree = await render(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
const idleTick = await turnsRefresh()
await showTurns()
check('a quiet tick reads only the turn list', idleTick.requests === 1 && idleTick.urls[0] === TURNS_LIST, JSON.stringify(idleTick.urls))
check('a quiet tick re-reads no turn detail', idleTick.urls.some(url => url.includes('/api/dsh-diff/turn?') || url.includes('&turn=')) === false, JSON.stringify(idleTick.urls))
check('a quiet tick re-reads no comparison', idleTick.urls.some(url => url.includes('/api/dsh-diff/file')) === false, JSON.stringify(idleTick.urls))
check('a quiet tick publishes no state change', idleTick.notifications === 0, `${idleTick.notifications} store notifications`)
check('a quiet tick builds nothing', idleTick.elements === 0, `${idleTick.elements} elements`)
console.log(`  ·  one quiet tick: ${idleTick.requests} request, ${idleTick.notifications} store notifications, ${idleTick.elements} elements`)

// An older turn cannot change, so a tick while one is in view reads only the list.
const olderRow = findAll(turnTree, node => node.type === 'button' && node.props?.['data-turn'] === '1')[0]
olderRow.props.onClick()
await settle(4)
turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
const oldTick = await turnsRefresh()
check('an older turn costs only the list read', oldTick.requests === 1 && oldTick.elements === 0, JSON.stringify(oldTick.urls))

// A RUNNING turn is the one case a tick must chase: its answer grows, and the
// list's own preview is what says so.
const growing = JSON.parse(JSON.stringify(turnListResponse))
growing.turns[2].answer = { text: '第三轮：正在写', truncated: false }
growing.turns[2].files = 1
growing.turns[2].added = 3
responses = new Map([
  [TURNS_LIST, growing],
  [TURN_DETAIL(3), turnDetail(3, [
    { path: 'src/keep.txt', display: 'src/keep.txt', status: 'modified', added: 3, deleted: 0, at: { turn: 3, seq: 13, index: 0 } },
  ], null, { text: '第三轮：正在写', truncated: false }, { open: true })],
  [TURN_FILE, { ok: true, scope: 'session', path: 'src/keep.txt', kind: 'text', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+running'] }] }],
])
const newestRow = findAll(turnTree, node => node.type === 'button' && node.props?.['data-turn'] === '3')[0]
newestRow.props.onClick()
await settle(4)
turnTree = await rerender(React.createElement(TurnsView, Object.assign({}, viewProps, turnFace)))
const beforeGrowth = requests.length
const grownTick = await turnsRefresh()
check('a growing turn is re-read', grownTick.urls.some(url => url.includes('turn=3')) === true, JSON.stringify(grownTick.urls))
check('and its answer is on screen', textOf(turnTree).includes('第三轮：正在写'), textOf(turnTree))
/* The cost of a turn that moved: its own detail, plus the comparison of a file
 * that just appeared in it. Nothing about any other turn, and no comparison it
 * already had. */
check('the grown tick re-reads only the running turn', grownTick.urls.every(url => url === TURNS_LIST || url.includes('turn=3') || url.includes('at=3%3A13%3A0')), JSON.stringify(grownTick.urls))
check('the grown tick costs at most its own three reads', grownTick.urls.length <= 3, JSON.stringify(grownTick.urls))
check('the grown tick leaves other turns alone', grownTick.urls.some(url => /turn=(1|2)\b/u.test(url)) === false, JSON.stringify(grownTick.urls))

// A second tick with the SAME preview is quiet again: the detail now agrees with
// the row, which is the state the broken comparison could never reach.
const settledTick = await turnsRefresh()
check('a settled turn goes quiet again', settledTick.requests === 1 && settledTick.elements === 0, JSON.stringify(settledTick.urls))

console.log('\nthe file view')
const FilesView = registrations[2].component
const filesFace = registrations[2].options.inject('sess-1')
const TREE = path => `/api/dsh-diff/tree?sessionId=sess-1&path=${encodeURIComponent(path)}`
const READ = path => `/api/dsh-diff/read?sessionId=sess-1&path=${encodeURIComponent(path)}`
const WRITE = '/api/dsh-diff/write'
const ROOT_TREE = TREE('')
const SRC_TREE = TREE('src')

const treeResponse = (path, entries, truncated = false) => ({ ok: true, cwd: 'F:/ws', path, entries, truncated })
const readResponse = (path, text, extra = {}) => Object.assign({ ok: true, cwd: 'F:/ws', path, text, mtimeMs: 1000, bytes: text.length }, extra)

function seedFiles() {
  requests.length = 0
  responses = new Map([
    [ROOT_TREE, treeResponse('', [
      { name: 'src', type: 'directory' },
      { name: 'tools', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ])],
    [SRC_TREE, treeResponse('src', [
      { name: 'keep.txt', type: 'file' },
      { name: 'binary.bin', type: 'file' },
    ])],
    [READ('README.md'), readResponse('README.md', '# hello\nworld\n')],
    [READ('src/keep.txt'), readResponse('src/keep.txt', 'first\nsecond\n')],
    [READ('src/binary.bin'), readResponse('src/binary.bin', '', { binary: true })],
  ])
}

seedFiles()
unmount()
let fileTree = await render(React.createElement(FilesView, Object.assign({}, viewProps, filesFace)))
await settle(4)
const showFiles = async () => {
  fileTree = await rerender(React.createElement(FilesView, Object.assign({}, viewProps, filesFace)))
}
await showFiles()
/** The tree rows currently rendered. */
const treeRows = () => findAll(fileTree, node => node.type === 'button' && node.props?.['data-path'] !== undefined && node.props?.['role'] === 'treeitem')
/** The open tabs currently rendered. */
const tabNodes = () => findAll(fileTree, node => node.props?.['data-path'] !== undefined && node.props?.['role'] === 'tab')
/** One editor pane by path. */
const paneFor = path => findAll(fileTree, node => node.props?.['data-dsh-diff-files-pane'] === path)[0]
/** The editor of one file, wherever it is mounted. */
const editorFor = path => findAll(fileTree, node => node.props?.['data-dsh-diff-files-editor'] === path)[0]
const closeButtons = () => findAll(fileTree, node => node.props?.className === 'dshdv-fvTabClose')
const dirtyDots = () => findAll(fileTree, node => node.props?.className === 'dshdv-fvDot').length

check('the file view reads the working directory root', requests.some(entry => entry.url === ROOT_TREE), JSON.stringify(requests.map(entry => entry.url)))
check('the tree header shows the root as the shell shows a path', findAll(fileTree, node => node.props?.['data-path-label'] !== undefined).length === 1 && textOf(findAll(fileTree, node => node.props?.['data-path-label'] !== undefined)[0]).includes('ws'), textOf(fileTree))
check('the tree header offers a reload', findAll(fileTree, node => node.props?.['data-dsh-diff-files-refresh'] !== undefined).length === 1)
check('the root level renders its entries', treeRows().length === 3, JSON.stringify(treeRows().map(node => node.props['data-path'])))
check('the tree lists directories first', treeRows()[0].props['data-path'] === 'src', JSON.stringify(treeRows().map(node => node.props['data-path'])))
check('a directory starts collapsed', treeRows()[0].props['aria-expanded'] === false, String(treeRows()[0].props['aria-expanded']))
/* The shell's own language: the folder glyph carries the expansion state, so a
 * twist triangle would be a second, foreign affordance. */
check('a directory is drawn with the closed folder glyph', findAll(fileTree, node => node.props?.['data-folder'] === 'closed').length >= 1, JSON.stringify(findAll(fileTree, node => node.props?.['data-folder'] !== undefined).map(node => node.props['data-folder'])))
check('no twist triangle is used', findAll(fileTree, node => node.props?.className === 'dshdv-fvTwist').length === 0)
check('files are drawn with the shell\'s type icons', findAll(fileTree, node => node.props?.['data-file-icon'] !== undefined).length >= 1, JSON.stringify(findAll(fileTree, node => node.props?.['data-file-icon'] !== undefined).map(node => node.props['data-file-icon'])))
check('no editor is offered before a file is opened', textOf(fileTree).includes('从左侧选择一个文件打开'), textOf(fileTree))

// Expanding a directory reads only that level.
treeRows()[0].props.onClick()
await settle(4)
await showFiles()
check('expanding a directory reads that level', requests.some(entry => entry.url === SRC_TREE), JSON.stringify(requests.map(entry => entry.url)))
check('its children are rendered', treeRows().some(node => node.props['data-path'] === 'src/keep.txt'), JSON.stringify(treeRows().map(node => node.props['data-path'])))
check('the directory reports itself expanded', treeRows()[0].props['aria-expanded'] === true, String(treeRows()[0].props['aria-expanded']))

// Opening a file reads it and shows an editor holding its text.
treeRows().find(node => node.props['data-path'] === 'src/keep.txt').props.onClick()
await settle(4)
await showFiles()
check('opening a file reads it', requests.some(entry => entry.url === READ('src/keep.txt')), JSON.stringify(requests.map(entry => entry.url)))
check('a tab appears for it', tabNodes().some(node => node.props['data-path'] === 'src/keep.txt'), JSON.stringify(tabNodes().map(node => node.props['data-path'])))
check('the editor holds the file text', editorFor('src/keep.txt')?.props.defaultValue === 'first\nsecond\n', JSON.stringify(editorFor('src/keep.txt')?.props.defaultValue))
check('the pane is the active one', paneFor('src/keep.txt')?.props['data-active'] === 'true', JSON.stringify(paneFor('src/keep.txt')?.props))

// A second file: both panes stay MOUNTED, so the first draft cannot be lost.
treeRows().find(node => node.props['data-path'] === 'README.md').props.onClick()
await settle(4)
await showFiles()
check('every open file keeps its editor mounted', findAll(fileTree, node => node.props?.['data-dsh-diff-files-editor'] !== undefined).length === 2, JSON.stringify(findAll(fileTree, node => node.props?.['data-dsh-diff-files-editor'] !== undefined).map(node => node.props['data-dsh-diff-files-editor'])))
check('only the active pane is visible', paneFor('src/keep.txt')?.props.hidden === true && paneFor('README.md')?.props.hidden !== true, JSON.stringify([paneFor('src/keep.txt')?.props.hidden, paneFor('README.md')?.props.hidden]))

editorFor('README.md').props.onInput({ target: { value: '# hello\nworld\nedited\n' } })
await settle(2)
await showFiles()
check('typing marks the tab dirty', dirtyDots() === 1, String(dirtyDots()))
check('the status line says unsaved', textOf(fileTree).includes('未保存'), textOf(fileTree))

// Ctrl+S saves with the freshness pair the read produced.
responses.set(WRITE, { ok: true, path: 'README.md', mtimeMs: 2000, bytes: 24 })
editorFor('README.md').props.onKeyDown({ ctrlKey: true, key: 's', preventDefault() {}, currentTarget: { value: '# hello\nworld\nedited\n' } })
await settle(4)
await showFiles()
const savedCall = requests.filter(entry => entry.url === WRITE).pop()
const savedBody = JSON.parse(savedCall?.body ?? '{}')
check('the save is a POST to the write route', savedCall?.method === 'POST' && savedBody.path === 'README.md', JSON.stringify({ method: savedCall?.method, path: savedBody.path }))
check('the save carries what the reader typed', savedBody.content === '# hello\nworld\nedited\n', JSON.stringify(savedBody.content))
check('the save carries the freshness pair it read', savedBody.expected?.mtimeMs === 1000 && savedBody.expected?.bytes === '# hello\nworld\n'.length, JSON.stringify(savedBody.expected))
check('a saved tab is no longer dirty', dirtyDots() === 0, String(dirtyDots()))

// A refused save is a conflict with an explicit overwrite, never a silent retry.
responses.set(WRITE, { __status: 409, ok: false, error: { code: 'diff/conflict', message: 'changed on disk' } })
editorFor('src/keep.txt').props.onInput({ target: { value: 'first\nsecond\nlocal\n' } })
await settle(2)
await showFiles()
editorFor('src/keep.txt').props.onKeyDown({ ctrlKey: true, key: 's', preventDefault() {}, currentTarget: { value: 'first\nsecond\nlocal\n' } })
await settle(4)
await showFiles()
/* A conflict belongs to the tab that hit it, and is shown there — not on whatever
 * tab the reader happens to be looking at. */
check('a conflict is not shown on another tab', findAll(fileTree, node => node.props?.['data-dsh-diff-files-overwrite'] !== undefined).length === 0, textOf(fileTree))
findAll(fileTree, node => node.props?.['className'] === 'dshdv-fvTabName' && node.props?.['title'] === 'src/keep.txt')[0].props.onClick()
await settle(2)
await showFiles()
check('a refused save is reported as a conflict', findAll(fileTree, node => node.props?.['data-dsh-diff-files-overwrite'] !== undefined).length === 1, textOf(fileTree))
check('the conflict keeps the draft dirty', dirtyDots() === 1, String(dirtyDots()))
responses.set(WRITE, { ok: true, path: 'src/keep.txt', mtimeMs: 3000, bytes: 19 })
requests.length = 0
findAll(fileTree, node => node.props?.['data-dsh-diff-files-overwrite'] !== undefined)[0].props.onClick()
await settle(4)
await showFiles()
const overwriteBody = JSON.parse(requests.filter(entry => entry.url === WRITE).pop()?.body ?? '{}')
check('an explicit overwrite sends no expectation', overwriteBody.expected === undefined, JSON.stringify(overwriteBody.expected))
check('and it clears the conflict', findAll(fileTree, node => node.props?.['data-dsh-diff-files-overwrite'] !== undefined).length === 0, textOf(fileTree))

// Closing a dirty tab asks first; refusing keeps it.
const confirmations = []
windowStub.confirm = (question) => { confirmations.push(question); return false }
editorFor('README.md').props.onInput({ target: { value: '# hello\nworld\ndirty\n' } })
await settle(2)
await showFiles()
const readmeTabIndex = tabNodes().findIndex(node => node.props['data-path'] === 'README.md')
closeButtons()[readmeTabIndex].props.onClick()
await settle(2)
await showFiles()
check('closing a dirty tab asks first', confirmations.length === 1 && confirmations[0].includes('README.md'), JSON.stringify(confirmations))
check('refusing the question keeps the tab', tabNodes().some(node => node.props['data-path'] === 'README.md'), JSON.stringify(tabNodes().map(node => node.props['data-path'])))
windowStub.confirm = () => true
closeButtons()[readmeTabIndex].props.onClick()
await settle(2)
await showFiles()
check('accepting closes it', tabNodes().every(node => node.props['data-path'] !== 'README.md'), JSON.stringify(tabNodes().map(node => node.props['data-path'])))

// Binary files are refused with a reason instead of an editor.
treeRows().find(node => node.props['data-path'] === 'src/binary.bin').props.onClick()
await settle(4)
await showFiles()
check('a binary file gets no editor', editorFor('src/binary.bin') === undefined)
check('and says why', textOf(fileTree).includes('二进制文件'), textOf(fileTree))

// The highlight toggle renders the shell's own code card — for a TEXT tab; a
// binary tab has no highlighted view to offer, only its "not editable" notice.
tabNodes().find(node => node.props['data-path'] === 'src/keep.txt') !== undefined
findAll(fileTree, node => node.props?.['className'] === 'dshdv-fvTabName' && node.props?.['title'] === 'src/keep.txt')[0].props.onClick()
await settle(2)
await showFiles()
check('a text tab offers the highlight toggle', findAll(fileTree, node => node.props?.['data-dsh-diff-files-highlight-toggle'] !== undefined).length === 1, textOf(fileTree))
findAll(fileTree, node => node.props?.['data-dsh-diff-files-highlight-toggle'] !== undefined)[0].props.onClick()
await settle(2)
await showFiles()
check('the highlighted view is mounted', findAll(fileTree, node => node.props?.['data-dsh-diff-files-highlight'] !== undefined).length === 1, textOf(fileTree))
check('and it went through the shell\'s code card', findAll(fileTree, node => node.props?.['data-markdown'] !== undefined || node.props?.className === 'dshdv-fvHighlight').length >= 1, textOf(fileTree))

/* The stylesheet is tagged with the plugin's own name. Untagged, the module
 * loader hands it to the next plugin that materializes and deletes it when that
 * plugin unloads — a stylesheet that belongs to nobody does not survive. */
check('the stylesheet is tagged as this plugin\'s', styleNodes[0]?.attributes?.['data-plugin'] === 'dsh-diff-view', JSON.stringify(styleNodes[0]?.attributes))

console.log('\nunmount')
unmount()
const cleanups = []
for (const label of effects) cleanups.push(label)
check('the plugin registered its effects', effects.length >= 1, effects.join(','))

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
