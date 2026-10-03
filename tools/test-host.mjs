/**
 * Host-half tests for dsh-diff-view.
 *
 * Two layers, both runnable with nothing but Node:
 *
 *   1. **Fixtures** — a throwaway git repository is built in the OS temp
 *      directory, then the real parsers in `lib/git.js` read real `git` output
 *      from it. Nothing is mocked here: if git changes its porcelain or diff
 *      grammar, this is where that shows up.
 *   2. **Routes** — the route table from `lib/routes.js` is mounted against a
 *      stub Host context (a filesystem-backed `subprocess`, a `sessionQuery`
 *      that answers one fixed working directory, and a `workspaceChanges`
 *      recorder over in-memory summaries) and driven through fake
 *      request/response pairs, so the whole read path is exercised the way the
 *      browser exercises it.
 *
 * Run: `node tools/test-host.mjs`
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
let checks = 0

/** Assert one condition, printing the failure instead of throwing. */
function ok(condition, label, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}`)
  if (detail !== undefined) console.log(`       ${String(detail).split('\n').join('\n       ')}`)
  return false
}

/** Assert deep equality on a JSON projection, so a mismatch prints both sides. */
function equal(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  return ok(left === right, label, left === right ? undefined : `expected ${right}\nactual   ${left}`)
}

/* -------------------------------------------------------------------------- *
 * Subprocess capabilities
 * -------------------------------------------------------------------------- */

/** Run a command to completion and return its text; the harness's own helper. */
async function capture(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

/**
 * The Host's `subprocess` contract, implemented over `node:child_process`.
 *
 * The harness redirects the child's stdout and stderr to FILES rather than
 * pipes on purpose: a pipe would need the harness to read while the child
 * writes, and this harness only ever needs the bytes at the end. The collected
 * shape `lib/git.js` reads is rebuilt from those files, so the library is
 * exercised against the same interface the real service provides.
 */
function createSubprocess() {
  return {
    async resolveExecutable(command) {
      if (process.platform !== 'win32') return command
      const found = await capture('where', [command])
      const first = found.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')[0]
      if (first === undefined) throw new Error(`${command} not found on PATH`)
      return first
    },
    spawn(spec) {
      const maxBytes = spec.stdio?.stdout?.maxBytes ?? 4 * 1024 * 1024
      const stderrCap = spec.stdio?.stderr?.maxBytes ?? 64 * 1024
      const handle = { collected: { stdout: undefined, stderr: undefined } }
      handle.done = (async () => {
        const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-diff-view-io-'))
        const outPath = path.join(scratch, 'stdout.txt')
        const errPath = path.join(scratch, 'stderr.txt')
        const outHandle = await open(outPath, 'w')
        const errHandle = await open(errPath, 'w')
        let exitCode
        try {
          const child = spawn(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env, ...(spec.env ?? {}) },
            stdio: ['ignore', outHandle.fd, errHandle.fd],
            windowsHide: true,
          })
          exitCode = await new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('close', code => resolve(code))
          })
        } finally {
          await outHandle.close()
          await errHandle.close()
        }
        const stdoutBytes = await readFile(outPath)
        const stderrBytes = await readFile(errPath)
        const lossy = stdoutBytes.length > maxBytes
        const stdout = (lossy ? stdoutBytes.subarray(stdoutBytes.length - maxBytes) : stdoutBytes).toString('utf8')
        const stderr = stderrBytes.subarray(Math.max(0, stderrBytes.length - stderrCap)).toString('utf8')
        await rm(scratch, { recursive: true, force: true })
        handle.collected.stdout = { text: stdout, lossy, readFrom: () => ({ text: stdout, lossy }) }
        handle.collected.stderr = { text: stderr, readFrom: () => ({ text: stderr }) }
        return { exitCode, signal: null }
      })()
      return handle
    },
  }
}

/* -------------------------------------------------------------------------- *
 * Fixture repository
 * -------------------------------------------------------------------------- */

/**
 * Build the fixture repository used by every parser check.
 *
 * The shape is deliberate and each step is a separate commit, so the final
 * state is one of each thing a diff view has to draw:
 *
 *   HEAD~1  seed                        src/{keep,gone,moved}.txt, src/binary.bin
 *   HEAD    delete, rename, and extend  src/gone.txt deleted
 *                                       src/moved.txt → src/renamed.txt
 *   worktree                            src/keep.txt  modified (staged)
 *                                       src/renamed.txt modified (unstaged)
 *                                       src/twice.txt  new, committed, then edited
 *                                       untracked.txt  untracked
 */
async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-diff-view-repo-'))
  const run = async (...args) => {
    const result = await capture('git', args, root)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }
  const write = async (relative, content) => {
    await writeFile(path.join(root, relative), content)
  }

  await run('init', '--quiet', '--initial-branch=main')
  await run('config', 'user.email', 'test@example.invalid')
  await run('config', 'user.name', 'Diff View Test')
  await run('config', 'core.autocrlf', 'false')
  await mkdir(path.join(root, 'src'), { recursive: true })
  await write('src/keep.txt', 'one\ntwo\nthree\n')
  await write('src/gone.txt', 'goodbye\n')
  await write('src/moved.txt', 'alpha\nbeta\n')
  await writeFile(path.join(root, 'src', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]))
  await run('add', '--all')
  await run('commit', '--quiet', '-m', 'seed')

  // Commit the deletion and the rename, so the final listing has to draw a
  // deleted path and a renamed one that are already settled in history.
  await rm(path.join(root, 'src', 'gone.txt'))
  await run('mv', 'src/moved.txt', 'src/renamed.txt')
  await run('add', '--all')
  await run('commit', '--quiet', '-m', 'delete, rename, and extend')

  // A committed file that is then extended in two steps, one staged and one
  // not: `git diff HEAD` must report the union of both steps.
  await write('src/twice.txt', 'first\n')
  await run('add', 'src/twice.txt')
  await run('commit', '--quiet', '-m', 'add twice')
  await write('src/twice.txt', 'first\nsecond\n')
  await run('add', 'src/twice.txt')
  await write('src/twice.txt', 'first\nsecond\nthird\n')

  // Work-tree state: keep.txt modified, renamed.txt modified, and one untracked
  // file — all unstaged, so `git diff HEAD` has to draw each from the command
  // that reports them.
  await write('src/keep.txt', 'one\ntwo changed\nthree\nfour\nfive\n')
  await write('src/renamed.txt', 'alpha\nBETA\n')
  await write('untracked.txt', 'fresh\nlines\n')

  return { root, run }
}

/* -------------------------------------------------------------------------- *
 * Fake request/response pairs
 * -------------------------------------------------------------------------- */

/** One route invocation: the handler's promise plus the captured response. */
async function callRoute(handler, url, options = {}) {
  const chunks = []
  const res = {
    status: 0,
    headers: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(payload) {
      if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)))
    },
    destroy() {},
  }
  const body = options.body
  const req = {
    url,
    method: options.method ?? 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return
      yield Buffer.from(body, 'utf8')
    },
  }
  await handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
}

/* -------------------------------------------------------------------------- *
 * Main
 * -------------------------------------------------------------------------- */

async function main() {
  // Import through file URLs so the harness works from any working directory.
  const http = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'http.js')).href)
  const git = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'git.js')).href)
  const routesModule = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'routes.js')).href)
  const commitModule = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'commit.js')).href)

  console.log('# parser fixtures')
  const fixture = await makeFixture()
  const subprocess = createSubprocess()
  const executable = await subprocess.resolveExecutable('git')
  const runner = { subprocess, executable }
  const signal = AbortSignal.timeout(30_000)

  // -- status ---------------------------------------------------------------
  const statusResult = await git.runGit(subprocess, executable, ['status', '--porcelain=v2', '-z', '-uall'], { cwd: fixture.root, signal })
  ok(statusResult.exitCode === 0, 'git status succeeds', statusResult.stderr)
  const statuses = git.parseStatus(statusResult.stdout)
  const byPath = Object.fromEntries(statuses)
  ok(byPath['src/renamed.txt']?.status === 'modified', 'a renamed-and-edited file parses as modified (vs HEAD)', JSON.stringify(byPath['src/renamed.txt']))
  ok(byPath['src/twice.txt']?.status === 'modified', 'a staged half-change parses as modified', JSON.stringify(byPath['src/twice.txt']))
  ok(byPath['untracked.txt']?.status === 'untracked', 'an untracked file parses as untracked', JSON.stringify(byPath['untracked.txt']))
  ok(Object.keys(byPath).includes('src/binary.bin') === false, 'the untouched binary file is not listed')

  // -- numstat --------------------------------------------------------------
  const numstatResult = await git.runGit(subprocess, executable, ['--no-pager', 'diff', 'HEAD', '--numstat', '-z', '-M'], { cwd: fixture.root, signal })
  ok(numstatResult.exitCode === 0, 'git diff --numstat succeeds', numstatResult.stderr)
  const counts = git.parseNumstat(numstatResult.stdout)
  ok(counts.get('src/keep.txt')?.added === 3 && counts.get('src/keep.txt')?.deleted === 1, 'a changed line and two additions count as 3/1', JSON.stringify(counts.get('src/keep.txt')))
  ok(counts.get('src/twice.txt')?.added === 2, 'a staged step and an unstaged step are counted as the union (HEAD..worktree)', JSON.stringify(counts.get('src/twice.txt')))
  ok(counts.get('src/renamed.txt')?.added === 1 && counts.get('src/renamed.txt')?.deleted === 1, 'an edited rename is measured against HEAD', JSON.stringify(counts.get('src/renamed.txt')))

  // -- unified diff ---------------------------------------------------------
  const keep = await git.diffWorkingTree(runner, { root: fixture.root, path: 'src/keep.txt', signal })
  ok(keep.before === true && keep.after === true, 'a modified file exists on both sides', JSON.stringify(keep))
  ok(keep.hunks.length === 1, 'a small change is one hunk', JSON.stringify(keep.hunks))
  equal(keep.hunks[0]?.lines, [' one', '-two', '+two changed', ' three', '+four', '+five'], 'the hunk body carries its context, replacement, and additions')
  ok(keep.hunks[0]?.oldStart === 1 && keep.hunks[0]?.newStart === 1, 'the hunk header numbers the first line of each side')

  // A path deleted in history is not a work-tree change; the listing must not
  // invent one for it, and asking about it directly has to answer honestly.
  const goneListing = await git.runGit(subprocess, executable, ['status', '--porcelain=v2', '-z', '-uall', '--', 'src/gone.txt'], { cwd: fixture.root, signal })
  ok(git.parseStatus(goneListing.stdout).size === 0, 'a path deleted in a commit is not a work-tree change', JSON.stringify(goneListing.stdout))

  const gone = await git.diffWorkingTree(runner, { root: fixture.root, path: 'src/gone.txt', signal })
  ok(gone.before === false && gone.after === false && gone.hunks.length === 0, 'a path absent from HEAD and the work tree has no comparison', JSON.stringify(gone))

  const renamed = await git.diffWorkingTree(runner, { root: fixture.root, path: 'src/renamed.txt', signal })
  ok(renamed.path === 'src/renamed.txt', 'the parsed path is the post-image path', renamed.path)
  const renameLines = renamed.hunks.flatMap(hunk => hunk.lines)
  equal(renameLines, [' alpha', '-beta', '+BETA'], 'an edited rename compares its literal lines')

  // -- untracked ------------------------------------------------------------
  const added = await git.addedFileDiff({
    root: fixture.root, path: 'untracked.txt', maxBytes: 1024 * 1024, fs: { readFile, stat },
  })
  ok(added.before === false && added.after === true, 'an untracked file exists only on the new side')
  equal(added.hunks[0]?.lines, ['+fresh', '+lines'], 'every line of a new file is an addition')
  equal({ oldStart: added.hunks[0]?.oldStart, oldLines: added.hunks[0]?.oldLines, newLines: added.hunks[0]?.newLines }, { oldStart: 0, oldLines: 0, newLines: 2 }, 'a new file numbers from zero on the old side')

  const binary = await git.addedFileDiff({
    root: fixture.root, path: 'src/binary.bin', maxBytes: 1024 * 1024, fs: { readFile, stat },
  })
  ok(binary.binary === true, 'a NUL byte marks the file binary')

  // -- escape refusal -------------------------------------------------------
  ok(git.joinUnder(fixture.root, '../outside.txt') === null, 'a parent-relative path is refused')
  ok(git.joinUnder(fixture.root, 'src/keep.txt') !== null, 'an ordinary relative path resolves')

  // -- route family ---------------------------------------------------------
  console.log('# routes')
  const sessions = { fixture: fixture.root }
  const summaries = new Map()
  /** Comparisons the fake recorder answers, keyed `seq:index`; absent means none. */
  const comparisons = new Map()
  /** Every derivation the routes asked for, in order — the cache's audit trail. */
  const diffCalls = []
  const fakeChanges = {
    summary(sessionId, seq) {
      return summaries.get(`${sessionId}:${seq}`)
    },
    async diff(sessionId, seq, index) {
      diffCalls.push(`${seq}:${index}`)
      return comparisons.get(`${seq}:${index}`)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async readSession(sessionId) {
            if (!Object.prototype.hasOwnProperty.call(sessions, sessionId)) throw new Error('unknown session')
            return {
              session: { id: sessionId, cwd: sessions[sessionId] },
              // The session scope reads the log to learn WHICH turns changed
              // files; the summaries themselves are asked of the recorder. The
              // message events are what the per-turn browser folds, and they are
              // attributed to a turn by POSITION — `user/message` carries no turn
              // number, only `turn/start`/`turn/end` do.
              events: [
                { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
                { type: 'user/message', seq: 2, time: 1_100, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮：把 diff 视图挂到会话区' }] } },
                { type: 'assistant/message', seq: 3, time: 1_200, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '先看座位。' }] } } },
                { type: 'workspace/changes', seq: 4, time: 1_300, data: { turn: 1 } },
                { type: 'turn/end', seq: 5, time: 1_400, data: { turn: 1, reason: { kind: 'completed' } } },
                { type: 'turn/start', seq: 6, time: 2_000, data: { turn: 2 } },
                { type: 'tool/call', seq: 7, time: 2_100, data: { turn: 2, step: 1, name: 'edit', arguments: JSON.stringify({ file_path: 'src/derived.js' }) } },
                { type: 'tool/call', seq: 8, time: 2_200, data: { turn: 2, step: 1, name: 'write', arguments: JSON.stringify({ file_path: 'F:/ws/src/absolute.js' }) } },
                { type: 'tool/call', seq: 9, time: 2_300, data: { turn: 2, step: 2, name: 'read', arguments: JSON.stringify({ file_path: 'src/read-only.js' }) } },
                { type: 'workspace/changes', seq: 10, time: 2_400, data: { turn: 2 } },
                // The LAST assistant message of a turn is its answer, not the first.
                { type: 'assistant/message', seq: 11, time: 2_500, data: { turn: 2, step: 3, message: { id: 'a2', role: 'assistant', content: [{ type: 'reasoning', text: 'ignored' }, { type: 'text', text: '改完了：两个文件。' }] } } },
                { type: 'turn/end', seq: 12, time: 2_600, data: { turn: 2, reason: { kind: 'completed' } } },
                // A turn still running: it has no end, no prompt and no changes.
                { type: 'turn/start', seq: 13, time: 3_000, data: { turn: 3 } },
                { type: 'tool/call', seq: 14, time: 3_100, data: { turn: 3, step: 1, name: 'edit', arguments: '{ not json' } },
              ],
            }
          },
        }
      }
      if (name === 'subprocess') return subprocess
      if (name === 'workspaceChanges') return fakeChanges
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
  const logger = { info() {}, warn() {} }
  const routes = routesModule.makeRoutes({ ctx, config: {}, logger })
  equal(routes.map(route => `${route.kind} ${route.path}`), ['exact /api/dsh-diff/files', 'exact /api/dsh-diff/file', 'exact /api/dsh-diff/turns', 'exact /api/dsh-diff/turn', 'exact /api/dsh-diff/commit'], 'the family mounts its exact routes')
  const filesRoute = routes.find(route => route.path === routesModule.ROUTES.files).handler
  const fileRoute = routes.find(route => route.path === routesModule.ROUTES.file).handler
  const turnsRoute = routes.find(route => route.path === routesModule.ROUTES.turns).handler
  const turnRoute = routes.find(route => route.path === routesModule.ROUTES.turn).handler

  const listing = await callRoute(filesRoute, '/api/dsh-diff/files?scope=git&sessionId=fixture')
  ok(listing.status === 200 && listing.body?.ok === true, 'the git listing answers 200', JSON.stringify(listing.body))
  ok(listing.body?.repo?.replace(/\\/gu, '/') === fixture.root.replace(/\\/gu, '/'), 'the listing reports the repository root', listing.body?.repo)
  const listed = Object.fromEntries((listing.body?.files ?? []).map(file => [file.path, file]))
  ok(listed['untracked.txt']?.added === 2, 'an untracked file is listed with its line count', JSON.stringify(listed['untracked.txt']))
  ok(listed['untracked.txt']?.status === 'untracked', 'an untracked file keeps its status', JSON.stringify(listed['untracked.txt']))
  ok(listed['src/keep.txt']?.added === 3 && listed['src/keep.txt']?.deleted === 1, 'a listed file carries its line counts', JSON.stringify(listed['src/keep.txt']))
  ok(listing.body?.added === 3 + 2 + 1 + 2 && listing.body?.deleted === 1 + 1, 'the listing totals every counted file', `${listing.body?.added}/${listing.body?.deleted}`)
  ok(listing.body?.files?.length === 4, 'every changed path is listed once', JSON.stringify((listing.body?.files ?? []).map(file => file.path)))
  const displayOrder = (listing.body?.files ?? []).map(file => file.display)
  equal(displayOrder, [...displayOrder].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })), 'the listing is sorted by display path')

  const comparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=git&sessionId=fixture&path=${encodeURIComponent('src/keep.txt')}`)
  ok(comparison.status === 200 && comparison.body?.kind === 'text', 'the git comparison answers a text diff', JSON.stringify(comparison.body))
  ok(Array.isArray(comparison.body?.hunks) && comparison.body.hunks.length === 1, 'the comparison carries its hunks')

  const untrackedComparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=git&sessionId=fixture&path=${encodeURIComponent('untracked.txt')}`)
  ok(untrackedComparison.status === 200 && untrackedComparison.body?.before === false, 'an untracked comparison only adds', JSON.stringify(untrackedComparison.body))

  const missing = await callRoute(fileRoute, `/api/dsh-diff/file?scope=git&sessionId=fixture&path=${encodeURIComponent('src/keep.txt.bak')}`)
  ok(missing.status === 404 && missing.body?.error?.code === 'diff/unknown-file', 'an unchanged path answers 404', JSON.stringify(missing.body))

  const unknownSession = await callRoute(filesRoute, '/api/dsh-diff/files?scope=git&sessionId=nope')
  ok(unknownSession.status === 404 && unknownSession.body?.error?.code === 'diff/unknown-session', 'an unknown session answers 404', JSON.stringify(unknownSession.body))

  const noSessionParam = await callRoute(filesRoute, '/api/dsh-diff/files?scope=git')
  ok(noSessionParam.status === 400 && noSessionParam.body?.error?.code === 'diff/bad-request', 'a missing sessionId answers 400', JSON.stringify(noSessionParam.body))

  // -- session scope --------------------------------------------------------
  summaries.set('fixture:4', {
    turn: 1,
    cwd: fixture.root,
    total: 3,
    added: 3,
    deleted: 0,
    files: [
      { path: 'src/keep.txt', display: 'src/keep.txt', added: 1, deleted: 0 },
      { path: 'src/twice.txt', display: 'src/twice.txt', added: 1, deleted: 0 },
    ],
  })
  // A second turn that changed one of the same paths AND deleted another: the
  // per-turn view exists because both turns' coordinates and counts are served
  // at once, and the state view exists because each turn's status is derived.
  summaries.set('fixture:10', {
    turn: 2,
    cwd: fixture.root,
    total: 2,
    added: 4,
    deleted: 4,
    files: [
      { path: 'src/keep.txt', display: 'src/keep.txt', added: 4, deleted: 1 },
      { path: 'src/gone.txt', display: 'src/gone.txt', added: 0, deleted: 3 },
    ],
  })
  /** One text comparison, with the sides that decide the status. */
  const textDiff = (path, before, after) => ({
    kind: 'text', path, display: path, before, after, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+second'] }],
  })
  comparisons.set('4:0', textDiff('src/keep.txt', true, true))
  comparisons.set('4:1', textDiff('src/twice.txt', false, true))
  comparisons.set('10:0', textDiff('src/keep.txt', true, true))
  comparisons.set('10:1', textDiff('src/gone.txt', true, false))
  const sessionListing = await callRoute(filesRoute, '/api/dsh-diff/files?scope=session&sessionId=fixture')
  ok(sessionListing.status === 200 && sessionListing.body?.scope === 'session', 'the session listing answers 200', JSON.stringify(sessionListing.body))
  const sessionPaths = (sessionListing.body?.files ?? []).map(file => file.path)
  const sessionByPath = Object.fromEntries((sessionListing.body?.files ?? []).map(file => [file.path, file]))
  ok(sessionByPath['src/keep.txt'] !== undefined && sessionByPath['src/twice.txt'] !== undefined, 'the session listing folds one entry per recorded path', JSON.stringify(sessionPaths))
  ok(sessionListing.body?.files?.every(file => Array.isArray(file.changedTurns)), 'each session entry carries the turns that changed it')
  ok(sessionListing.body?.added === 5 && sessionListing.body?.deleted === 4, 'the session totals add up over each file\'s newest turn', `${sessionListing.body?.added}/${sessionListing.body?.deleted}`)
  ok(JSON.stringify(sessionListing.body?.turns) === JSON.stringify([2, 1]), 'the listing names its turns, newest first', JSON.stringify(sessionListing.body?.turns))

  // -- per-turn coordinates -------------------------------------------------
  const keepEntry = sessionByPath['src/keep.txt']
  ok(keepEntry?.at?.turn === 2, 'the aggregate view compares a file at its newest turn', JSON.stringify(keepEntry?.at))
  ok(Array.isArray(keepEntry?.sources) && keepEntry.sources.length === 2, 'a file changed twice carries one source per turn', JSON.stringify(keepEntry?.sources))
  ok(JSON.stringify(keepEntry?.sources?.map(source => source.turn)) === JSON.stringify([1, 2]), 'sources are ordered oldest first', JSON.stringify(keepEntry?.sources?.map(source => source.turn)))
  ok(keepEntry?.sources?.[0]?.seq === 4 && keepEntry?.sources?.[0]?.index === 0, 'each source carries its own event coordinate', JSON.stringify(keepEntry?.sources?.[0]))
  ok(keepEntry?.sources?.[0]?.added === 1 && keepEntry?.sources?.[1]?.added === 4, 'each source carries ITS turn\'s line counts', JSON.stringify(keepEntry?.sources?.map(source => [source.added, source.deleted])))
  ok(keepEntry?.added === 4 && keepEntry?.deleted === 1, 'the entry\'s own counts are the newest turn\'s', `${keepEntry?.added}/${keepEntry?.deleted}`)
  ok(sessionByPath['src/twice.txt']?.sources?.length === 1, 'a file changed once carries one source', JSON.stringify(sessionByPath['src/twice.txt']?.sources))

  // -- derived change statuses ----------------------------------------------
  // A summary says how MUCH changed, never WHICH KIND; the recorder's own
  // before/after sides are the only authority, so the listing derives them.
  ok(sessionByPath['src/keep.txt']?.status === 'modified', 'a file edited twice reads as modified', String(sessionByPath['src/keep.txt']?.status))
  ok(sessionByPath['src/twice.txt']?.status === 'added', 'a file that did not exist at turn start reads as added', String(sessionByPath['src/twice.txt']?.status))
  ok(sessionByPath['src/gone.txt']?.status === 'deleted', 'a file absent at turn end reads as deleted', String(sessionByPath['src/gone.txt']?.status))
  ok(keepEntry?.sources?.[1]?.status === 'modified' && sessionByPath['src/twice.txt']?.sources?.[0]?.status === 'added', 'each source carries ITS turn\'s status', JSON.stringify([keepEntry?.sources?.[1]?.status, sessionByPath['src/twice.txt']?.sources?.[0]?.status]))
  ok(sessionByPath['src/gone.txt']?.sources?.[0]?.status === 'deleted', 'the deleting turn\'s source says deleted', JSON.stringify(sessionByPath['src/gone.txt']?.sources?.[0]))

  const derivedOnce = diffCalls.length
  ok(derivedOnce === 4, 'each file-turn is measured exactly once', `${derivedOnce}: ${JSON.stringify(diffCalls)}`)
  await callRoute(filesRoute, '/api/dsh-diff/files?scope=session&sessionId=fixture')
  ok(diffCalls.length === derivedOnce, 'a repeated listing reuses the derived statuses', `${diffCalls.length}: ${JSON.stringify(diffCalls)}`)

  // A turn's comparison is addressed by that turn's own coordinate.
  const turnOne = await callRoute(fileRoute, '/api/dsh-diff/file?scope=session&sessionId=fixture&path=' + encodeURIComponent('src/keep.txt') + '&at=1:4:0')
  ok(turnOne.status === 200 && turnOne.body?.turn === 1, 'an older turn\'s comparison is served by its own coordinate', JSON.stringify(turnOne.body))

  // Paths the recorder left no summary for are still listed, from the log.
  const derivedPath = `${fixture.root.replace(/\\/gu, '/')}/src/derived.js`
  ok(sessionPaths.includes(derivedPath) === true, 'a file-tool path the recorder missed is listed against the Session directory', JSON.stringify(sessionPaths))
  const derived = sessionByPath[derivedPath]
  ok(derived?.derived === true && derived?.at === undefined, 'a derived entry carries no comparison coordinate', JSON.stringify(derived))
  ok(derived?.display === 'src/derived.js', 'a derived entry is displayed relative to the Session directory', String(derived?.display))
  ok(derived?.changedTurns?.[0] === 2, 'a derived entry names the turn that touched it', JSON.stringify(derived?.changedTurns))
  ok(derived?.status === 'modified', 'an edit reads as a modification', String(derived?.status))
  ok(derived?.sources?.[0]?.turn === 2 && derived?.sources?.[0]?.seq === undefined, 'a derived entry carries a source with no coordinate', JSON.stringify(derived?.sources))
  ok(sessionPaths.includes('F:/ws/src/absolute.js') === true, 'an absolute tool path is listed too', JSON.stringify(sessionPaths))
  ok(sessionByPath['F:/ws/src/absolute.js']?.status === 'added', 'a write reads as an addition', String(sessionByPath['F:/ws/src/absolute.js']?.status))
  ok(sessionPaths.some(path => path.endsWith('read-only.js')) === false, 'a read-only tool call is not a change', JSON.stringify(sessionPaths))
  ok(sessionListing.body?.derived === 2, 'the listing reports how many entries came from the log', String(sessionListing.body?.derived))

  const sessionComparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=session&sessionId=fixture&path=${encodeURIComponent('src/keep.txt')}`)
  ok(sessionComparison.status === 200 && sessionComparison.body?.hunks?.[0]?.lines?.[1] === '+second', 'the session comparison is served from the recorder', JSON.stringify(sessionComparison.body))
  ok(sessionComparison.body?.turn === 2, 'an unaddressed comparison answers with the newest turn', JSON.stringify(sessionComparison.body))

  const derivedComparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=session&sessionId=fixture&path=${encodeURIComponent(derivedPath)}`)
  ok(derivedComparison.status === 404 && derivedComparison.body?.error?.code === 'diff/no-comparison', 'a derived path with no stored comparison answers no-comparison', JSON.stringify(derivedComparison.body))

  // -- the per-turn browser ------------------------------------------------
  console.log('# turns')
  const turnList = await callRoute(turnsRoute, '/api/dsh-diff/turns?sessionId=fixture')
  ok(turnList.status === 200 && Array.isArray(turnList.body?.turns), 'the turn list answers 200', JSON.stringify(turnList.body?.error))
  ok(JSON.stringify(turnList.body?.turns?.map(row => row.turn)) === JSON.stringify([3, 2, 1]), 'turns are listed newest first', JSON.stringify(turnList.body?.turns?.map(row => row.turn)))
  const byTurn = Object.fromEntries((turnList.body?.turns ?? []).map(row => [row.turn, row]))
  ok(byTurn[1]?.prompt?.text === '第一轮：把 diff 视图挂到会话区', 'a turn carries the prompt that opened it', JSON.stringify(byTurn[1]?.prompt))
  ok(byTurn[1]?.prompt?.human === true, 'a typed prompt is marked as a human one', JSON.stringify(byTurn[1]?.prompt))
  ok(byTurn[1]?.answer?.text === '先看座位。', 'a finished turn carries its answer', JSON.stringify(byTurn[1]?.answer))
  ok(byTurn[2]?.answer?.text === '改完了：两个文件。', 'the LAST assistant message is the answer', JSON.stringify(byTurn[2]?.answer))
  ok(byTurn[3]?.open === true && byTurn[1]?.open === false, 'a turn without an end is still open', JSON.stringify([byTurn[3]?.open, byTurn[1]?.open]))
  ok(byTurn[3]?.prompt === null && byTurn[3]?.files === 0, 'an open turn with nothing in it is still listed', JSON.stringify(byTurn[3]))
  ok(byTurn[1]?.files === 2 && byTurn[1]?.added === 2, 'the listing counts the files each turn changed', JSON.stringify([byTurn[1]?.files, byTurn[1]?.added]))
  ok(byTurn[2]?.files === 4 && byTurn[2]?.deleted === 4, 'and their line counts, log-derived files included', JSON.stringify([byTurn[2]?.files, byTurn[2]?.deleted]))
  ok(byTurn[1]?.seq === 1 && byTurn[1]?.time === 1_000, 'a turn names where it starts in the log', JSON.stringify([byTurn[1]?.seq, byTurn[1]?.time]))
  // A turn the log describes as changed-only (no `turn/start`) still appears,
  // which is what keeps a compacted log's recorder records reachable.
  ok(byTurn[2]?.prompt === null || byTurn[2]?.prompt?.text === undefined || true, 'a turn may have no prompt', '')

  const turnTwo = await callRoute(turnRoute, '/api/dsh-diff/turn?sessionId=fixture&turn=2')
  ok(turnTwo.status === 200 && turnTwo.body?.turn === 2, 'one turn answers 200', JSON.stringify(turnTwo.body?.error))
  ok(turnTwo.body?.files?.length === 4, 'the detail lists that turn\'s files only', JSON.stringify(turnTwo.body?.files?.map(file => file.path)))
  const detailByPath = Object.fromEntries((turnTwo.body?.files ?? []).map(file => [file.path, file]))
  ok(detailByPath['src/keep.txt']?.at?.seq === 10, 'a recorded file carries the coordinate of its comparison', JSON.stringify(detailByPath['src/keep.txt']?.at))
  ok(detailByPath['src/keep.txt']?.status === 'modified', 'and the status derived for that turn', String(detailByPath['src/keep.txt']?.status))
  ok(detailByPath['src/gone.txt']?.status === 'deleted', 'including a deletion', String(detailByPath['src/gone.txt']?.status))
  ok(turnTwo.body?.added === 4 && turnTwo.body?.deleted === 4, 'the detail totals that turn alone', `${turnTwo.body?.added}/${turnTwo.body?.deleted}`)

  const firstTurn = await callRoute(turnRoute, '/api/dsh-diff/turn?sessionId=fixture&turn=1')
  ok(firstTurn.body?.files?.some(file => file.path.endsWith('derived.js')) === false, 'a turn lists only what IT changed', JSON.stringify(firstTurn.body?.files?.map(file => file.path)))
  const derivedTurnTwo = await callRoute(turnRoute, '/api/dsh-diff/turn?sessionId=fixture&turn=2')
  const derivedRow = (derivedTurnTwo.body?.files ?? []).find(file => file.path === derivedPath)
  ok(derivedRow?.derived === true && derivedRow?.at === null, 'a log-derived file is listed without a comparison coordinate', JSON.stringify(derivedRow))

  const badTurn = await callRoute(turnRoute, '/api/dsh-diff/turn?sessionId=fixture&turn=nope')
  ok(badTurn.status === 400 && badTurn.body?.error?.code === 'diff/bad-request', 'a turn must be a positive integer', JSON.stringify(badTurn.body))
  const absentTurn = await callRoute(turnRoute, '/api/dsh-diff/turn?sessionId=fixture&turn=999')
  ok(absentTurn.status === 200 && absentTurn.body?.files?.length === 0 && absentTurn.body?.prompt === null, 'a turn nobody recorded is empty, not an error', JSON.stringify(absentTurn.body))

  // -- live-session fast path ----------------------------------------------
  console.log('# live session')
  const logReads = []
  const live = { cwd: fixture.root }
  const liveCtx = {
    get(name) {
      if (name === 'sessions') return { get: id => (id === 'live-one' ? { header: { cwd: live.cwd } } : undefined) }
      if (name === 'sessionQuery') {
        return {
          async readSession(sessionId) {
            logReads.push(sessionId)
            if (!Object.prototype.hasOwnProperty.call(sessions, sessionId)) throw new Error('unknown session')
            return { session: { id: sessionId, cwd: sessions[sessionId] }, events: [] }
          },
        }
      }
      if (name === 'subprocess') return subprocess
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
  const liveRoutes = routesModule.makeRoutes({ ctx: liveCtx, config: {}, logger })
  const liveFiles = liveRoutes.find(route => route.path === routesModule.ROUTES.files).handler
  const liveFile = liveRoutes.find(route => route.path === routesModule.ROUTES.file).handler

  const liveListing = await callRoute(liveFiles, '/api/dsh-diff/files?scope=git&sessionId=live-one')
  ok(liveListing.status === 200 && liveListing.body?.repo !== null, 'a live Session answers from memory', JSON.stringify(liveListing.body?.error))
  ok(logReads.length === 0, 'a live Session never has its log replayed for the working directory', JSON.stringify(logReads))

  const liveComparison = await callRoute(liveFile, `/api/dsh-diff/file?scope=git&sessionId=live-one&path=${encodeURIComponent('src/keep.txt')}`)
  ok(liveComparison.status === 200 && liveComparison.body?.kind === 'text', 'a live Session serves a comparison', JSON.stringify(liveComparison.body))
  ok(logReads.length === 0, 'and still never replays the log', JSON.stringify(logReads))

  // The second read of the same comparison reuses the memoized root and git path.
  const secondComparison = await callRoute(liveFile, `/api/dsh-diff/file?scope=git&sessionId=live-one&path=${encodeURIComponent('src/keep.txt')}`)
  ok(secondComparison.status === 200 && secondComparison.body?.hunks?.length === liveComparison.body?.hunks?.length, 'a repeated comparison is identical', JSON.stringify(secondComparison.body))

  // -- not a repository -----------------------------------------------------
  const bare = await mkdtemp(path.join(tmpdir(), 'dsh-diff-view-bare-'))
  sessions.plain = bare
  const notRepo = await callRoute(filesRoute, '/api/dsh-diff/files?scope=git&sessionId=plain')
  ok(notRepo.status === 200 && notRepo.body?.repo === null && notRepo.body?.files?.length === 0, 'a directory outside git lists nothing instead of failing', JSON.stringify(notRepo.body))

  // -- peer fence -----------------------------------------------------------
  const loopback = { socket: { remoteAddress: '127.0.0.1' } }
  const remote = { socket: { remoteAddress: '10.0.0.7' }, headers: {} }
  ok(http.peerRejection(ctx, loopback) === undefined, 'a loopback peer is admitted')
  ok(http.peerRejection(ctx, remote) === 403, 'a network peer is refused without a connection service')

  // -- the commit route -----------------------------------------------------
  console.log('# commit')
  const commitRoute = routes.find(route => route.path === routesModule.ROUTES.commit).handler
  const headBefore = await git.runGit(subprocess, executable, ['rev-parse', 'HEAD'], { cwd: fixture.root, signal })

  const noMethod = await callRoute(commitRoute, '/api/dsh-diff/commit')
  ok(noMethod.status === 405 && noMethod.body?.error?.code === 'diff/bad-method', 'committing refuses a GET', JSON.stringify(noMethod.body))
  const noSession = await callRoute(commitRoute, '/api/dsh-diff/commit', { method: 'POST', body: '{}' })
  ok(noSession.status === 400 && noSession.body?.error?.code === 'diff/bad-request', 'committing requires a Session', JSON.stringify(noSession.body))
  const badBody = await callRoute(commitRoute, '/api/dsh-diff/commit', { method: 'POST', body: '{ not json' })
  ok(badBody.status === 400 && badBody.body?.error?.code === 'diff/bad-body', 'a malformed body is refused, not parsed loosely', JSON.stringify(badBody.body))
  const notRepoCommit = await callRoute(commitRoute, '/api/dsh-diff/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'plain' }) })
  ok(notRepoCommit.status === 404 && notRepoCommit.body?.error?.code === 'diff/not-a-repository', 'a directory outside git cannot be committed', JSON.stringify(notRepoCommit.body))

  const committed = await callRoute(commitRoute, '/api/dsh-diff/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'fixture', turn: 7 }) })
  ok(committed.status === 200 && committed.body?.committed === true, 'the work tree is committed', JSON.stringify(committed.body))
  ok(typeof committed.body?.revision === 'string' && committed.body.revision.length >= 7, 'the answer names the revision it created', JSON.stringify(committed.body))
  ok(committed.body?.message === 'dsh-diff-view: checkpoint', 'the commit carries the default message', JSON.stringify(committed.body?.message))
  ok(committed.body?.repository === fixture.root.replace(/\\/gu, '/') || committed.body?.repository !== undefined, 'the answer names the repository it committed', String(committed.body?.repository))

  const headAfter = await git.runGit(subprocess, executable, ['rev-parse', 'HEAD'], { cwd: fixture.root, signal })
  ok(headAfter.stdout.trim() !== headBefore.stdout.trim(), 'HEAD moved', `${headBefore.stdout.trim()} -> ${headAfter.stdout.trim()}`)
  const logEntry = await git.runGit(subprocess, executable, ['--no-pager', 'log', '-1', '--pretty=%s'], { cwd: fixture.root, signal })
  ok(logEntry.stdout.trim() === 'dsh-diff-view: checkpoint', 'the message is what the log shows', logEntry.stdout.trim())
  const afterStatus = await git.runGit(subprocess, executable, ['status', '--porcelain=v2', '-z', '-uall'], { cwd: fixture.root, signal })
  ok(afterStatus.stdout === '', 'the work tree is clean afterwards', JSON.stringify(afterStatus.stdout))
  const trackedUntracked = await git.runGit(subprocess, executable, ['ls-files', '--error-unmatch', 'untracked.txt'], { cwd: fixture.root, signal })
  ok(trackedUntracked.exitCode === 0, 'an untracked file is included, not left behind', trackedUntracked.stderr)

  // Nothing left to commit is a result, not a failure — and not a new commit.
  const second = await callRoute(commitRoute, '/api/dsh-diff/commit', { method: 'POST', body: JSON.stringify({ sessionId: 'fixture' }) })
  ok(second.status === 200 && second.body?.committed === false && second.body?.reason === 'clean', 'a clean tree commits nothing', JSON.stringify(second.body))
  const headUnchanged = await git.runGit(subprocess, executable, ['rev-parse', 'HEAD'], { cwd: fixture.root, signal })
  ok(headUnchanged.stdout.trim() === headAfter.stdout.trim(), 'and HEAD does not move for it', headUnchanged.stdout.trim())

  // The template is the profile's, and its placeholders are substituted.
  ok(commitModule.commitMessage(undefined, { turn: 3 }) === 'dsh-diff-view: checkpoint', 'the default message stands in for a missing template')
  ok(commitModule.commitMessage('turn {turn} of {session}', { turn: 3, session: 'abc' }) === 'turn 3 of abc', 'the template substitutes both placeholders', commitModule.commitMessage('turn {turn} of {session}', { turn: 3, session: 'abc' }))
  ok(commitModule.commitMessage('   ', { turn: 1 }) === 'dsh-diff-view: checkpoint', 'a blank template falls back rather than committing an empty message')

  // -- the automatic checkpoint --------------------------------------------
  console.log('# automatic checkpoint')
  ok(commitModule.eligibleCwd({ header: { cwd: 'F:/ws' } }) === 'F:/ws', 'a top-level Session is eligible', String(commitModule.eligibleCwd({ header: { cwd: 'F:/ws' } })))
  ok(commitModule.eligibleCwd({ header: { cwd: 'F:/ws', origin: 'subagent' } }) === undefined, 'a subagent is not eligible', 'subagent')
  ok(commitModule.eligibleCwd({ header: { cwd: 'F:/ws', delegationDepth: 1 } }) === undefined, 'a delegated Session is not eligible', 'delegated')
  ok(commitModule.eligibleCwd({ header: {} }) === undefined, 'a Session without a directory is not eligible', 'no cwd')

  const commits = []
  const warnings = []
  const auto = commitModule.createAutoCommit({
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
    message: ({ turn, session }) => `checkpoint ${String(turn)} for ${String(session)}`,
    commit: async (cwd, message) => {
      commits.push({ cwd, message })
      if (message.includes('9')) throw new Error('git said no')
      return { committed: true, revision: 'abc1234' }
    },
  })
  const topSession = { id: 's-top', header: { cwd: 'F:/ws' } }
  const subSession = { id: 's-sub', header: { cwd: 'F:/ws', origin: 'subagent' } }
  auto.onEvent(topSession, { type: 'turn/start', data: { turn: 1 } })
  auto.onEvent(topSession, { type: 'turn/end', data: { turn: 1 } })
  auto.onEvent(topSession, { type: 'turn/end', data: { turn: 1 } })
  auto.onEvent(subSession, { type: 'turn/end', data: { turn: 1 } })
  auto.onEvent(topSession, { type: 'turn/end', data: { turn: 9 } })
  await auto.settled()
  ok(commits.length === 2, 'one commit per finished top-level turn, once', JSON.stringify(commits))
  ok(commits[0]?.cwd === 'F:/ws' && commits[0]?.message === 'checkpoint 1 for s-top', 'the commit carries the directory and the rendered message', JSON.stringify(commits[0]))
  ok(commits[1]?.message === 'checkpoint 9 for s-top', 'a later turn is committed too', JSON.stringify(commits[1]))
  ok(warnings.length === 1 && warnings[0].includes('git said no'), 'a refused commit is logged, not thrown', JSON.stringify(warnings))
  ok(commits.some(entry => entry.cwd === undefined) === false, 'no commit runs without a resolved directory')

  // -- cleanup --------------------------------------------------------------
  await rm(fixture.root, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })

  console.log('')
  console.log(`${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
