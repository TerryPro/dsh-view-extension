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

import { checkpoint, commitMessage, DEFAULT_MESSAGE } from './commit.js'
import {
  addedFileDiff, diffWorkingTree, joinUnder, locateRepository, parseNumstat, parseStatus, resolveGit, runGit,
} from './git.js'
import {
  DiffError, peerRejection, queryOf, readJsonBody, requiredString, writeError, writeJson,
} from './http.js'
import {
  announcedSummaries, changeRecorder, comparePaths, createLogCache, createStatusCache, enrichStatuses,
  foldChangedFiles, locateChangedFile, readSessionEvents, resolveSessionCwd, touchedFiles,
} from './session.js'
import { clipText, foldConversation, TURN_PREVIEW_CHARS, TURN_TEXT_CHARS, turnNumbers } from './turns.js'

/** Exact route paths; the client bundle mirrors these literals. */
export const ROUTES = {
  files: '/api/dsh-diff/files',
  file: '/api/dsh-diff/file',
  commit: '/api/dsh-diff/commit',
  turns: '/api/dsh-diff/turns',
  turn: '/api/dsh-diff/turn',
}

/** Largest untracked file rendered as an all-additions comparison. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
/** How long one repository lookup stays usable (milliseconds). */
const REPOSITORY_TTL_MS = 10_000
/** How long a resolved `git` path stays usable before it is looked up again. */
const EXECUTABLE_TTL_MS = 60_000

/** Build the route table for one plugin mount. */
export function makeRoutes({ ctx, config, logger }) {
  /**
   * Per-mount memo of the expensive lookups.
   *
   * A git command costs ~40 ms on Windows purely in process creation, and a
   * Session's working directory is asked for by every request; resolving either
   * of them again per request is what made selecting a file feel slow. These
   * hold only paths and roots — never file content — so a stale entry can cost a
   * re-lookup, not a wrong comparison.
   */
  const memo = {
    log: createLogCache(),
    statuses: createStatusCache(),
    executable: { value: undefined, at: 0 },
    repositories: new Map(),
  }
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

  /** The `{ subprocess, executable }` pair every git call needs, resolved at most once a minute. */
  async function gitFor(signal) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
      throw new DiffError('diff/unavailable', 'this Host has no subprocess capability, so git diffs are unavailable', 503)
    }
    if (memo.executable.value === undefined || Date.now() - memo.executable.at > EXECUTABLE_TTL_MS) {
      memo.executable.value = await resolveGit(subprocess, signal)
      memo.executable.at = Date.now()
    }
    return { subprocess, executable: memo.executable.value }
  }

  /**
   * The repository one Session's working directory lives in.
   *
   * A directory outside every repository is a normal answer, not a failure: the
   * client shows "not a git repository" and offers the session scope instead.
   * The lookup is memoized per directory because a work tree does not move.
   */
  async function repositoryFor(sessionId, signal) {
    const cwd = await resolveSessionCwd(ctx, sessionId)
    const hit = memo.repositories.get(cwd)
    if (hit !== undefined && Date.now() - hit.at < REPOSITORY_TTL_MS) {
      return { cwd, git: hit.git, repository: hit.repository }
    }
    const git = await gitFor(signal)
    const repository = await locateRepository(git, cwd, signal)
    memo.repositories.set(cwd, { at: Date.now(), git, repository })
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
    const picture = await sessionChanges(sessionId, signal)
    return {
      scope: 'session',
      cwd: picture.cwd,
      repo: null,
      files: picture.files,
      added: picture.added,
      deleted: picture.deleted,
      turns: picture.turns,
      turn: picture.turns[0],
      derived: picture.derived,
    }
  }

  /**
   * One Session's whole change picture: the recorder's folded records plus the
   * paths only the log knows about.
   *
   * Shared by the file listing and the per-turn browser so both describe the same
   * tree from the same read — the log is decoded once per request either way, and
   * the derived statuses are cached per file-turn.
   */
  async function sessionChanges(sessionId, signal) {
    const cwd = await resolveSessionCwd(ctx, sessionId)
    const { events } = await readSessionEvents(ctx, sessionId, memo.log)
    const service = changeRecorder(ctx)
    const summaries = service === undefined ? [] : announcedSummaries(service, sessionId, events)
    // A summary says how MUCH changed, never WHICH KIND: added, modified and
    // deleted are only distinguishable from the comparison the recorder serves,
    // so each file-turn is measured once and remembered for this mount.
    if (service !== undefined) await enrichStatuses(service, sessionId, summaries, memo.statuses, { signal })
    const folded = foldChangedFiles(summaries)
    const recorded = new Set(folded.files.map(file => file.path))
    let added = 0
    let deleted = 0
    for (const file of folded.files) {
      added += file.added
      deleted += file.deleted
    }
    // Paths the log's file tools touched but no summary covers: listed, with the
    // turn that touched them and no line counts, because the comparison the
    // recorder would have kept is not there to count. They carry the same
    // `sources` shape as a recorded file, with no comparison coordinate — so a
    // per-turn view treats them uniformly instead of special-casing them.
    const derived = []
    for (const touch of touchedFiles(events)) {
      const absolute = displayedPath(cwd, touch.path)
      if (absolute === null) continue
      if (recorded.has(absolute.path)) continue
      const status = touch.added ? 'added' : 'modified'
      derived.push({
        path: absolute.path,
        display: absolute.display,
        status,
        added: 0,
        deleted: 0,
        changedTurns: [touch.turn],
        at: undefined,
        sources: [{ turn: touch.turn, status, added: 0, deleted: 0, derived: true }],
        derived: true,
        turn: touch.turn,
      })
    }
    const files = [...folded.files, ...derived].sort((left, right) => comparePaths(left.display, right.display))
    return { cwd, events, files, added, deleted, turns: folded.turns, derived: derived.length }
  }

  /**
   * The per-turn list a reviewer navigates by.
   *
   * A turn exists if EITHER half of the Session knows it — the log's `turn/start`
   * or a change record — because a compacted log can lose the first while the
   * second still remembers the turn, and plenty of turns change no files at all.
   */
  async function turnsList(sessionId, signal) {
    const picture = await sessionChanges(sessionId, signal)
    const { turns: conversation, order } = foldConversation(picture.events, { preview: TURN_PREVIEW_CHARS })
    const changedTurns = new Set()
    for (const file of picture.files) {
      for (const source of file.sources ?? []) changedTurns.add(source.turn)
    }
    const rows = turnNumbers(order, changedTurns).map((turn) => {
      const said = conversation.get(turn)
      const counts = perTurnCounts(picture.files, turn)
      return {
        turn,
        /** Whether the turn is still running; a turn with no `turn/end` is open. */
        open: said === undefined ? false : said.open === true,
        seq: said?.seq,
        time: said?.time,
        prompt: said?.prompt ?? null,
        answer: said?.answer ?? null,
        files: counts.files,
        added: counts.added,
        deleted: counts.deleted,
      }
    })
    return { cwd: picture.cwd, turns: rows, derived: picture.derived }
  }

  /** One turn in full: what was asked, what it answered, and what it changed. */
  async function turnDetail(sessionId, turn, signal) {
    const picture = await sessionChanges(sessionId, signal)
    const { turns: conversation } = foldConversation(picture.events, { preview: TURN_TEXT_CHARS })
    const said = conversation.get(turn)
    const files = []
    let added = 0
    let deleted = 0
    for (const file of picture.files) {
      const source = (file.sources ?? []).find(entry => entry.turn === turn)
      if (source === undefined) continue
      files.push({
        path: file.path,
        display: file.display,
        status: source.status,
        added: source.added,
        deleted: source.deleted,
        /* A comparison is addressable only when the recorder kept one, which is
         * exactly when the source carries an event coordinate. */
        at: typeof source.seq === 'number' && typeof source.index === 'number'
          ? { turn, seq: source.seq, index: source.index }
          : null,
        ...(source.derived === true ? { derived: true } : {}),
        ...(source.binary === true ? { binary: true } : {}),
        ...(source.oversized === true ? { oversized: true } : {}),
      })
      added += source.added
      deleted += source.deleted
    }
    return {
      cwd: picture.cwd,
      turn,
      open: said === undefined ? false : said.open === true,
      seq: said?.seq,
      time: said?.time,
      prompt: said?.prompt ?? null,
      answer: said?.answer ?? null,
      files,
      added,
      deleted,
    }
  }

  /** One file's comparison in the requested scope. */
  async function fileComparison(scope, sessionId, path, at, signal) {
    if (scope === 'session') {
      const service = changeRecorder(ctx)
      if (service === undefined) {
        throw new DiffError('diff/unavailable', 'this Host composes no change recorder, so session changes are unavailable', 503)
      }
      const { events } = await readSessionEvents(ctx, sessionId, memo.log)
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
    /* The diff comes first because it answers the common case on its own: a
     * tracked file that differs from HEAD needs nothing else, and asking git for
     * its status first would spend a second process spawn (~40 ms on Windows) to
     * learn what the diff already said. Only an empty diff is ambiguous — the
     * path may be untracked, or simply unchanged — and only then is the status
     * read worth paying for. */
    const diff = await diffWorkingTree(git, { root: repository.root, path, signal })
    if (diff.before || diff.after || diff.hunks.length > 0) {
      return { ...toHunks(diff), path, display: relativeDisplay(repository.root, cwd, path), turn: undefined }
    }
    const statusResult = await runGit(git.subprocess, git.executable, ['status', '--porcelain=v2', '-z', '-uall', '--', path], { cwd: repository.root, signal })
    const statuses = statusResult.exitCode === 0 ? parseStatus(statusResult.stdout) : new Map()
    const entry = statuses.get(path)
    if (entry?.tracked === false) {
      const added = await addedFileDiff({ root: repository.root, path, fs: { readFile, stat }, maxBytes: MAX_UNTRACKED_BYTES })
      return { ...toHunks(added), path, display: relativeDisplay(repository.root, cwd, path), turn: undefined }
    }
    throw new DiffError('diff/unknown-file', `"${path}" has no changes against HEAD`, 404)
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

    {
      kind: 'exact',
      path: ROUTES.turns,
      /** Every turn of one Session, newest first: what was asked, what changed. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const signal = AbortSignal.timeout(30_000)
        const payload = await turnsList(sessionId, signal)
        writeJson(res, 200, { ok: true, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.turn,
      /** One turn in full, with more of the text than the listing carries. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const turn = Number(query.turn)
        if (!Number.isSafeInteger(turn) || turn <= 0) {
          throw new DiffError('diff/bad-request', '"turn" must be a positive integer', 400)
        }
        const signal = AbortSignal.timeout(30_000)
        const payload = await turnDetail(sessionId, turn, signal)
        writeJson(res, 200, { ok: true, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.commit,
      /**
       * The plugin's only write route: commit the Session's work tree.
       *
       * Deliberately narrow. It takes a Session id (and optionally the turn the
       * reader is looking at) and it commits — it never pushes, never chooses a
       * remote, never rewrites history, and it refuses to invent a commit when
       * the tree is clean. A caller cannot point it at an arbitrary directory:
       * the path comes from the Session, never from the request.
       */
      handler: route(async (req, res) => {
        if (req.method !== 'POST') throw new DiffError('diff/bad-method', 'committing takes a POST', 405)
        const body = await readJsonBody(req)
        const sessionId = requiredString(body, 'sessionId')
        const turn = typeof body.turn === 'number' && Number.isSafeInteger(body.turn) ? body.turn : undefined
        const signal = AbortSignal.timeout(60_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        const text = commitMessage(config?.commitMessage ?? DEFAULT_MESSAGE, { turn, session: sessionId })
        const result = await checkpoint(git, {
          root: repository.root,
          message: text,
          signal,
        })
        logger.info(`dsh-diff-view: commit requested for ${sessionId}${turn === undefined ? '' : ` turn ${String(turn)}`}: ${result.committed ? `committed ${String(result.revision)}` : 'nothing to commit'}`)
        writeJson(res, 200, { ok: true, repository: repository.root, message: text, ...result })
      }),
    },
  ]
}

/**
 * Commit the work tree that contains one directory — the automatic checkpoint's
 * entry point.
 *
 * The route reaches the same operation through its per-mount memo; this door is
 * for the caller that already holds the directory the Host resolved from a
 * Session header and needs it once per turn, where a memo would buy nothing and
 * a stale repository root would be one more thing to reason about.
 *
 * @param ctx - host Context.
 * @param options - `{ cwd, message, signal? }`.
 * @returns `{ committed, reason?, revision?, repository, message }`.
 * @throws {DiffError} when there is no git, or the directory is outside a repository.
 */
export async function checkpointFor(ctx, options) {
  const signal = options.signal ?? AbortSignal.timeout(60_000)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    throw new DiffError('diff/unavailable', 'this Host has no subprocess capability, so git commits are unavailable', 503)
  }
  const executable = await resolveGit(subprocess, signal)
  const git = { subprocess, executable }
  const repository = await locateRepository(git, options.cwd, signal)
  if (repository === null) {
    throw new DiffError('diff/not-a-repository', `"${options.cwd}" is not inside a git repository`, 404)
  }
  const result = await checkpoint(git, { root: repository.root, message: options.message, signal })
  return { repository: repository.root, message: options.message, ...result }
}

/**
 * How many files one turn changed, and how much.
 *
 * @param files - the folded session files.
 * @param turn - the turn to count.
 * @returns `{ files, added, deleted }`.
 */
function perTurnCounts(files, turn) {
  let count = 0
  let added = 0
  let deleted = 0
  for (const file of files) {
    const source = (file.sources ?? []).find(entry => entry.turn === turn)
    if (source === undefined) continue
    count += 1
    added += source.added
    deleted += source.deleted
  }
  return { files: count, added, deleted }
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
