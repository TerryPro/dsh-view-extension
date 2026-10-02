/**
 * The `/api/dsh-diff/*` route family.
 *
 * Two exact routes mirror what the browser half needs and nothing more:
 *
 * | Route | Verb | What it answers |
 * |---|---|---|
 * | `files` | GET | the changed files of one scope, with status and line counts |
 * | `file` | GET | one file's comparison as structured hunks |
 *
 * A scope is `git` (the Session's working tree against `HEAD`) or `session`
 * (the turns the Host's change recorder summarized). Both read the same
 * envelope, so the client renders one list against either.
 *
 * Every handler is wrapped once, so peer fencing and error translation are
 * properties of the family rather than of each route: a handler body only ever
 * throws a `DiffError` and only ever answers through the JSON writer.
 *
 * @module dsh-diff-view/lib/routes
 */
import { readFile, stat } from 'node:fs/promises'

import {
  addedFileDiff, diffWorkingTree, joinUnder, locateRepository, parseNumstat, parseStatus, resolveGit, runGit,
} from './git.js'
import { DiffError, peerRejection, queryOf, requiredString, writeError, writeJson } from './http.js'
import {
  announcedSummaries, changeRecorder, comparePaths, foldChangedFiles, locateChangedFile, readSessionEvents,
  resolveSessionCwd, touchedFiles,
} from './session.js'

/** Exact route paths; the client bundle mirrors these literals. */
export const ROUTES = {
  files: '/api/dsh-diff/files',
  file: '/api/dsh-diff/file',
}

/** Largest untracked file rendered as an all-additions comparison. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/** Build the route table for one plugin mount. */
export function makeRoutes({ ctx, config, logger }) {
  /**
   * Wrap one handler with the family's peer fence and error discipline.
   *
   * @param handler - the route body.
   * @returns the `WebRoute['handler']` to register.
   */
  function route(handler) {
    return async (req, res) => {
      const rejection = peerRejection(ctx, req)
      if (rejection !== undefined) {
        writeJson(res, rejection, { ok: false, error: { code: 'diff/forbidden', message: 'this route only answers this machine' } })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        if (!res.headersSent) writeError(res, error, logger)
        else res.destroy()
      }
    }
  }

  /** The `{ subprocess, executable }` pair every git call needs. */
  async function gitFor(signal) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
      throw new DiffError('diff/unavailable', 'this Host has no subprocess capability, so git diffs are unavailable', 503)
    }
    return { subprocess, executable: await resolveGit(subprocess, signal) }
  }

  /**
   * The repository one Session's working directory lives in.
   *
   * A directory outside every repository is a normal answer, not a failure: the
   * client shows "not a git repository" and offers the session scope instead.
   */
  async function repositoryFor(sessionId, signal) {
    const cwd = await resolveSessionCwd(ctx, sessionId)
    const git = await gitFor(signal)
    const repository = await locateRepository(git, cwd, signal)
    return { cwd, git, repository }
  }

  /**
   * Line counts for untracked paths, which `git diff` cannot report.
   *
   * A count is what the list shows next to a path, and for an untracked file the
   * only source is the file itself. The read is bounded, binary-aware, and a
   * failure downgrades that one entry to "counts unknown" rather than failing
   * the listing.
   */
  async function untrackedCounts(root, paths) {
    const counts = new Map()
    for (const path of paths) {
      const absolute = joinUnder(root, path)
      if (absolute === null) continue
      try {
        const stats = await stat(absolute)
        if (stats.isDirectory()) {
          counts.set(path, { added: 0, deleted: 0, binary: false, directory: true })
          continue
        }
        if (stats.size > MAX_UNTRACKED_BYTES) {
          counts.set(path, { added: 0, deleted: 0, binary: false, oversized: true })
          continue
        }
        const buffer = await readFile(absolute)
        if (buffer.includes(0)) {
          counts.set(path, { added: 0, deleted: 0, binary: true })
          continue
        }
        const text = buffer.toString('utf8')
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        counts.set(path, { added: lines, deleted: 0, binary: false })
      } catch {
        /* an unreadable untracked path is listed without counts */
      }
    }
    return counts
  }

  /**
   * The git scope's file list.
   *
   * `git diff HEAD` and `git status` are asked in the same breath: status is the
   * authority on which paths changed and how, numstat is the authority on how
   * much. A path git reports as changed but numstat omits (a submodule bump, a
   * mode-only change) is still listed, with zero counts.
   */
  async function gitFiles(sessionId, signal) {
    const { cwd, git, repository } = await repositoryFor(sessionId, signal)
    if (repository === null) {
      return { scope: 'git', cwd, repo: null, files: [], added: 0, deleted: 0, turn: undefined }
    }
    const [statusResult, numstatResult] = await Promise.all([
      runGit(git.subprocess, git.executable, ['status', '--porcelain=v2', '-z', '-uall'], { cwd: repository.root, signal }),
      runGit(git.subprocess, git.executable, ['--no-pager', 'diff', 'HEAD', '--numstat', '-z', '-M'], { cwd: repository.root, signal }),
    ])
    if (statusResult.exitCode !== 0) {
      throw new DiffError('diff/git-failed', `git status failed: ${statusResult.stderr.trim() || 'no diagnostic'}`, 500)
    }
    const statuses = parseStatus(statusResult.stdout)
    const counts = numstatResult.exitCode === 0 ? parseNumstat(numstatResult.stdout) : new Map()
    const untracked = [...statuses.entries()].filter(([, entry]) => entry.tracked === false).map(([path]) => path)
    const extra = await untrackedCounts(repository.root, untracked)

    let added = 0
    let deleted = 0
    const files = []
    for (const [path, entry] of statuses) {
      const measured = counts.get(path) ?? extra.get(path)
      const binary = measured?.binary === true
      const directory = measured?.directory === true
      const fileAdded = binary || directory ? 0 : measured?.added ?? 0
      const fileDeleted = binary || directory ? 0 : measured?.deleted ?? 0
      added += fileAdded
      deleted += fileDeleted
      files.push({
        path,
        display: relativeDisplay(repository.root, cwd, path),
        status: directory ? 'directory' : binary ? 'binary' : entry.status,
        added: fileAdded,
        deleted: fileDeleted,
        ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
        ...(binary ? { binary: true } : {}),
        ...(measured?.oversized === true ? { oversized: true } : {}),
      })
    }
    files.sort((left, right) => comparePaths(left.display, right.display))
    return {
      scope: 'git',
      cwd,
      repo: repository.root,
      gitDir: repository.gitDir,
      files,
      added,
      deleted,
      truncated: statusResult.truncated,
      turn: undefined,
    }
  }

  /** The session scope's file list: every turn the recorder announced, folded. */
  async function sessionFiles(sessionId, signal) {
    const cwd = await resolveSessionCwd(ctx, sessionId)
    const { events } = await readSessionEvents(ctx, sessionId)
    const service = changeRecorder(ctx)
    const turns = service === undefined ? [] : announcedSummaries(service, sessionId, events)
    const folded = foldChangedFiles(turns)
    const recorded = new Set(folded.files.map(file => file.path))
    let added = 0
    let deleted = 0
    for (const file of folded.files) {
      added += file.added
      deleted += file.deleted
    }
    // Paths the log's file tools touched but no summary covers: listed, with the
    // turn that touched them and no line counts, because the comparison the
    // recorder would have kept is not there to count.
    const derived = []
    for (const touch of touchedFiles(events)) {
      const absolute = displayedPath(cwd, touch.path)
      if (absolute === null) continue
      if (recorded.has(absolute.path)) continue
      derived.push({
        path: absolute.path,
        display: absolute.display,
        status: touch.added ? 'added' : 'modified',
        added: 0,
        deleted: 0,
        changedTurns: [touch.turn],
        at: undefined,
        derived: true,
        turn: touch.turn,
      })
    }
    const files = [...folded.files, ...derived].sort((left, right) => comparePaths(left.display, right.display))
    return {
      scope: 'session',
      cwd: folded.cwd ?? cwd,
      repo: null,
      files,
      added,
      deleted,
      turns: folded.turns,
      turn: folded.turns[0],
      derived: derived.length,
    }
  }

  /** One file's comparison in the requested scope. */
  async function fileComparison(scope, sessionId, path, at, signal) {
    if (scope === 'session') {
      const service = changeRecorder(ctx)
      if (service === undefined) {
        throw new DiffError('diff/unavailable', 'this Host composes no change recorder, so session changes are unavailable', 503)
      }
      const { events } = await readSessionEvents(ctx, sessionId)
      const turns = announcedSummaries(service, sessionId, events)
      const located = at === undefined ? locateChangedFile(turns, path) : at
      if (located === undefined) {
        // The list can derive a path from the log's file tools when the recorder
        // kept no summary; there is then no stored comparison to serve, and
        // saying so is the honest answer.
        throw new DiffError('diff/no-comparison', `the Host kept no comparison for "${path}"`, 404)
      }
      const diff = await service.diff(sessionId, located.seq, located.index, signal)
      if (diff === undefined) {
        throw new DiffError('diff/no-comparison', `the Host no longer holds the comparison for "${path}"`, 404)
      }
      return { ...toHunks(diff), path, display: diff.display ?? path, turn: located.turn }
    }

    const { cwd, git, repository } = await repositoryFor(sessionId, signal)
    if (repository === null) {
      throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
    }
    const statusResult = await runGit(git.subprocess, git.executable, ['status', '--porcelain=v2', '-z', '-uall', '--', path], { cwd: repository.root, signal })
    const statuses = statusResult.exitCode === 0 ? parseStatus(statusResult.stdout) : new Map()
    const entry = statuses.get(path)
    if (entry?.tracked === false) {
      const added = await addedFileDiff({ root: repository.root, path, fs: { readFile, stat }, maxBytes: MAX_UNTRACKED_BYTES })
      return { ...toHunks(added), path, display: relativeDisplay(repository.root, cwd, path), turn: undefined }
    }
    const diff = await diffWorkingTree(git, { root: repository.root, path, signal })
    if (!diff.before && !diff.after && diff.hunks.length === 0) {
      // No index entry and no diff: the path is untracked but arrived after the
      // status snapshot, or it is simply unchanged. Only the first is a file.
      const added = await addedFileDiff({ root: repository.root, path, fs: { readFile, stat }, maxBytes: MAX_UNTRACKED_BYTES })
        .catch(() => undefined)
      if (added !== undefined && (added.after || added.hunks.length > 0)) {
        return { ...toHunks(added), path, display: relativeDisplay(repository.root, cwd, path), turn: undefined }
      }
      throw new DiffError('diff/unknown-file', `"${path}" has no changes against HEAD`, 404)
    }
    return { ...toHunks(diff), path, display: relativeDisplay(repository.root, cwd, path), turn: undefined }
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.files,
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const scope = query.scope === 'session' ? 'session' : 'git'
        const sessionId = requiredString(query, 'sessionId')
        const signal = AbortSignal.timeout(30_000)
        const payload = scope === 'session' ? await sessionFiles(sessionId, signal) : await gitFiles(sessionId, signal)
        writeJson(res, 200, { ok: true, scope, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.file,
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const scope = query.scope === 'session' ? 'session' : 'git'
        const sessionId = requiredString(query, 'sessionId')
        const path = requiredString(query, 'path')
        const at = parseAt(query.at)
        const signal = AbortSignal.timeout(30_000)
        const payload = await fileComparison(scope, sessionId, path, at, signal)
        writeJson(res, 200, { ok: true, scope, ...payload })
      }),
    },
  ]
}

/**
 * Parse the `at` coordinate a session-scope comparison may carry.
 *
 * @param value - the raw query value.
 * @returns `{ turn, seq, index }`, or undefined when the request names none.
 */
function parseAt(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const parts = value.split(':')
  if (parts.length !== 3) return undefined
  const [turn, seq, index] = parts.map(Number)
  if (![turn, seq, index].every(Number.isSafeInteger)) return undefined
  return { turn, seq, index }
}

/**
 * Translate one served comparison into the client's hunk shape.
 *
 * The shell's own `WorkspaceFileDiff` is already the right vocabulary — the
 * client draws it for `workspace/changes` — so both scopes are projected onto
 * it rather than inventing a second shape for the same picture.
 *
 * @param diff - a git-parsed or recorder-served comparison.
 * @returns `{ kind, before, after, hunks, coarse }`.
 */
function toHunks(diff) {
  if (diff.kind === 'binary' || diff.binary === true) {
    return { kind: 'binary', before: true, after: true, hunks: [], coarse: false }
  }
  if (diff.kind === 'oversized' || diff.oversized === true) {
    return { kind: 'oversized', before: true, after: true, hunks: [], coarse: false }
  }
  return {
    kind: 'text',
    before: diff.before !== false,
    after: diff.after !== false,
    hunks: Array.isArray(diff.hunks) ? diff.hunks : [],
    coarse: diff.coarse === true,
  }
}

/**
 * How one repository path reads in a list rooted at the Session directory.
 *
 * A Session directory is usually the repository root or a directory inside it;
 * both spellings are shown, because "where is this file relative to what I am
 * working in" is the question the list answers.
 *
 * @param root - repository root.
 * @param cwd - Session working directory.
 * @param path - repository-relative path.
 * @returns the display path.
 */
function relativeDisplay(root, cwd, path) {
  const normalizedRoot = root.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const normalizedCwd = (cwd ?? root).replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (normalizedCwd === normalizedRoot) return path
  if (normalizedCwd.startsWith(`${normalizedRoot}/`)) {
    const prefix = `${normalizedCwd.slice(normalizedRoot.length + 1)}/`
    if (path.startsWith(prefix)) return path.slice(prefix.length)
    const depth = prefix.split('/').length - 1
    return `${'../'.repeat(depth)}${path}`
  }
  return `${normalizedRoot}/${path}`
}

/**
 * One path a file tool named, as the session scope's list addresses it.
 *
 * A tool argument may be relative to the working directory or absolute, and the
 * list needs both spellings: the absolute one to serve against the recorder,
 * and the workspace-relative one to show. A path outside the working directory
 * keeps its absolute spelling in both fields rather than being dropped — a file
 * the agent edited is the interesting part, wherever it lives.
 *
 * @param cwd - the Session's working directory.
 * @param raw - the path the tool arguments carried.
 * @returns `{ path, display }`, or null when the value is not a usable path.
 */
function displayedPath(cwd, raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return null
  const slashed = raw.replace(/\\/gu, '/')
  const absolute = /^[A-Za-z]:\//u.test(slashed) || slashed.startsWith('/')
    ? slashed.replace(/\/+$/u, '')
    : `${String(cwd).replace(/\\/gu, '/').replace(/\/+$/u, '')}/${slashed.replace(/^\.\//u, '')}`
  const normalizedCwd = String(cwd).replace(/\\/gu, '/').replace(/\/+$/u, '')
  const display = absolute === normalizedCwd
    ? absolute
    : absolute.startsWith(`${normalizedCwd}/`) ? absolute.slice(normalizedCwd.length + 1) : absolute
  return { path: absolute, display }
}
