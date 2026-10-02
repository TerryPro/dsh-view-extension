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
async function callRoute(handler, url) {
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
  const req = {
    url,
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
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
  const fakeChanges = {
    summary(sessionId, seq) {
      return summaries.get(`${sessionId}:${seq}`)
    },
    async diff(sessionId, seq, index) {
      const summary = summaries.get(`${sessionId}:${seq}`)
      const file = summary?.files?.[index]
      if (file === undefined) return undefined
      return {
        kind: 'text',
        path: file.path,
        display: file.display,
        before: true,
        after: true,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '+second'] }],
        coarse: false,
      }
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
              // files; the summaries themselves are asked of the recorder.
              events: [
                { type: 'turn/end', seq: 3, data: { turn: 1 } },
                { type: 'workspace/changes', seq: 4, data: { turn: 1 } },
                { type: 'tool/call', seq: 5, data: { turn: 2, name: 'edit', arguments: JSON.stringify({ file_path: 'src/derived.js' }) } },
                { type: 'tool/call', seq: 6, data: { turn: 2, name: 'write', arguments: JSON.stringify({ file_path: 'F:/ws/src/absolute.js' }) } },
                { type: 'tool/call', seq: 7, data: { turn: 2, name: 'read', arguments: JSON.stringify({ file_path: 'src/read-only.js' }) } },
                { type: 'tool/call', seq: 8, data: { turn: 3, name: 'edit', arguments: '{ not json' } },
                { type: 'turn/end', seq: 9, data: { turn: 3 } },
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
  equal(routes.map(route => `${route.kind} ${route.path}`), ['exact /api/dsh-diff/files', 'exact /api/dsh-diff/file'], 'the family mounts two exact routes')
  const filesRoute = routes.find(route => route.path === routesModule.ROUTES.files).handler
  const fileRoute = routes.find(route => route.path === routesModule.ROUTES.file).handler

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
    total: 2,
    added: 5,
    deleted: 1,
    files: [
      { path: 'src/keep.txt', display: 'src/keep.txt', added: 4, deleted: 1 },
      { path: 'src/twice.txt', display: 'src/twice.txt', added: 1, deleted: 0 },
    ],
  })
  const sessionListing = await callRoute(filesRoute, '/api/dsh-diff/files?scope=session&sessionId=fixture')
  ok(sessionListing.status === 200 && sessionListing.body?.scope === 'session', 'the session listing answers 200', JSON.stringify(sessionListing.body))
  const sessionPaths = (sessionListing.body?.files ?? []).map(file => file.path)
  const sessionByPath = Object.fromEntries((sessionListing.body?.files ?? []).map(file => [file.path, file]))
  ok(sessionByPath['src/keep.txt'] !== undefined && sessionByPath['src/twice.txt'] !== undefined, 'the session listing folds one entry per recorded path', JSON.stringify(sessionPaths))
  ok(sessionListing.body?.files?.every(file => Array.isArray(file.changedTurns)), 'each session entry carries the turns that changed it')
  ok(sessionListing.body?.added === 5 && sessionListing.body?.deleted === 1, 'the session totals add up')
  ok(sessionByPath['src/keep.txt']?.at !== undefined && sessionByPath['src/keep.txt']?.at.turn === 1, 'a recorded entry carries the coordinate of its comparison', JSON.stringify(sessionByPath['src/keep.txt']?.at))

  // Paths the recorder left no summary for are still listed, from the log.
  const derivedPath = `${fixture.root.replace(/\\/gu, '/')}/src/derived.js`
  ok(sessionPaths.includes(derivedPath) === true, 'a file-tool path the recorder missed is listed against the Session directory', JSON.stringify(sessionPaths))
  const derived = sessionByPath[derivedPath]
  ok(derived?.derived === true && derived?.at === undefined, 'a derived entry carries no comparison coordinate', JSON.stringify(derived))
  ok(derived?.display === 'src/derived.js', 'a derived entry is displayed relative to the Session directory', String(derived?.display))
  ok(derived?.changedTurns?.[0] === 2, 'a derived entry names the turn that touched it', JSON.stringify(derived?.changedTurns))
  ok(derived?.status === 'modified', 'an edit reads as a modification', String(derived?.status))
  ok(sessionPaths.includes('F:/ws/src/absolute.js') === true, 'an absolute tool path is listed too', JSON.stringify(sessionPaths))
  ok(sessionByPath['F:/ws/src/absolute.js']?.status === 'added', 'a write reads as an addition', String(sessionByPath['F:/ws/src/absolute.js']?.status))
  ok(sessionPaths.some(path => path.endsWith('read-only.js')) === false, 'a read-only tool call is not a change', JSON.stringify(sessionPaths))
  ok(sessionListing.body?.derived === 2, 'the listing reports how many entries came from the log', String(sessionListing.body?.derived))

  const sessionComparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=session&sessionId=fixture&path=${encodeURIComponent('src/keep.txt')}`)
  ok(sessionComparison.status === 200 && sessionComparison.body?.hunks?.[0]?.lines?.[1] === '+second', 'the session comparison is served from the recorder', JSON.stringify(sessionComparison.body))
  ok(sessionComparison.body?.turn === 1, 'the session comparison names its turn', JSON.stringify(sessionComparison.body))

  const derivedComparison = await callRoute(fileRoute, `/api/dsh-diff/file?scope=session&sessionId=fixture&path=${encodeURIComponent(derivedPath)}`)
  ok(derivedComparison.status === 404 && derivedComparison.body?.error?.code === 'diff/no-comparison', 'a derived path with no stored comparison answers no-comparison', JSON.stringify(derivedComparison.body))

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

  // -- cleanup --------------------------------------------------------------
  await rm(fixture.root, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })

  console.log('')
  console.log(`${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
