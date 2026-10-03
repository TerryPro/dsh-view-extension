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
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'

import { checkpoint, commitMessage, DEFAULT_MESSAGE } from './commit.js'
import {
  addedFileDiff, commitDetail, diffCommitFile, diffTurnFile, diffWorkingTree, fileHistory,
  findTurnCommits, joinUnder, listCommits, locateRepository, parseNumstat, parseStatus,
  pushBranch, repositoryStatus, resolveGit, runGit,
} from './git.js'
import {
  DiffError, peerRejection, queryOf, readJsonBody, requiredString, writeError, writeJson,
} from './http.js'
import {
  announcedSummaries, changeRecorder, comparePaths, createLogCache, createStatusCache, enrichStatuses,
  foldChangedFiles, locateChangedFile, readSessionEvents, resolveSessionCwd, touchedFiles,
} from './session.js'
import { clipText, foldConversation, TURN_PREVIEW_CHARS, TURN_TEXT_CHARS, turnNumbers } from './turns.js'
import { EDIT_MAX_BYTES, listDirectory, readWorkspaceBytes, readWorkspaceFile, writeWorkspaceFile } from './workspace.js'

/** Exact route paths; the client bundle mirrors these literals. */
export const ROUTES = {
  files: '/api/dsh-diff/files',
  file: '/api/dsh-diff/file',
  commit: '/api/dsh-diff/commit',
  turns: '/api/dsh-diff/turns',
  turn: '/api/dsh-diff/turn',
  tree: '/api/dsh-diff/tree',
  read: '/api/dsh-diff/read',
  write: '/api/dsh-diff/write',
  raw: '/api/dsh-diff/raw',
  /** The history browser: the commit list, and one commit in full. `/commit`
   * WRITES a checkpoint; `/commits` and `/commit-detail` read them back. */
  commits: '/api/dsh-diff/commits',
  commitDetail: '/api/dsh-diff/commit-detail',
  /** The commits that touched one file, the repository's own status, and the push. */
  fileHistory: '/api/dsh-diff/file-history',
  status: '/api/dsh-diff/status',
  push: '/api/dsh-diff/push',
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
    /** Per-session turn→commit mapping, reconstructed from git trailers. */
    turnCommits: new Map(),
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

  /** How long one Session's turn→commit mapping stays usable (milliseconds). */
  const TURN_COMMITS_TTL_MS = 30_000

  /**
   * The turn→commit mapping for one Session, from git trailers.
   *
   * Cached per session because the mapping only grows (a new turn adds a commit)
   * and the cost is one `git log --grep`. A 30-second TTL means a just-committed
   * turn appears in the next read after the cache expires, which is fast enough
   * for a view that re-reads on interaction.
   *
   * Returns an empty Map when the session is not in a repository or has no
   * checkpoint commits — both are normal states, not failures.
   */
  async function turnCommitsFor(sessionId, signal) {
    const hit = memo.turnCommits.get(sessionId)
    if (hit !== undefined && Date.now() - hit.at < TURN_COMMITS_TTL_MS) return hit.value
    let value = new Map()
    try {
      const { git, repository } = await repositoryFor(sessionId, signal)
      if (repository !== null) {
        value = await findTurnCommits({ root: repository.root, git, sessionId, signal })
      }
    } catch {
      /* No git, no repository, or a failed log: the mapping is simply empty,
       * and the per-turn view degrades to "no comparison" as before. */
    }
    memo.turnCommits.set(sessionId, { at: Date.now(), value })
    return value
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
      /* The list reads oldest first, so the turn a reader means by default is the
       * NEWEST one: the aggregate comparison is that turn's, and the checkpoint
       * button names it in the commit it makes. */
      turn: picture.turns.length > 0 ? picture.turns[picture.turns.length - 1] : undefined,
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
   *
   * Each row carries the checkpoint commit's SHA when one exists, so the client
   * can offer "open in Git browser" and the comparison can be reconstructed from
   * git after a restart.
   */
  async function turnsList(sessionId, signal) {
    const picture = await sessionChanges(sessionId, signal)
    const { turns: conversation, order } = foldConversation(picture.events, { preview: TURN_PREVIEW_CHARS })
    const changedTurns = new Set()
    for (const file of picture.files) {
      for (const source of file.sources ?? []) changedTurns.add(source.turn)
    }
    /* The turn→commit mapping: one git log call, cached, and empty when there
     * is no repository or no checkpoint commits. */
    const commits = await turnCommitsFor(sessionId, signal)
    const rows = turnNumbers(order, changedTurns).map((turn) => {
      const said = conversation.get(turn)
      const counts = perTurnCounts(picture.files, turn)
      const commit = commits.get(turn)
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
        /** The checkpoint commit for this turn, when one exists. */
        ...(commit !== undefined ? { sha: commit.sha, short: commit.short } : {}),
      }
    })
    return { cwd: picture.cwd, turns: rows, derived: picture.derived }
  }

  /** One turn in full: what was asked, what it answered, and what it changed. */
  async function turnDetail(sessionId, turn, signal) {
    const picture = await sessionChanges(sessionId, signal)
    const { turns: conversation } = foldConversation(picture.events, { preview: TURN_TEXT_CHARS })
    const said = conversation.get(turn)
    const commits = await turnCommitsFor(sessionId, signal)
    const commit = commits.get(turn)
    const files = []
    let added = 0
    let deleted = 0
    for (const file of picture.files) {
      const source = (file.sources ?? []).find(entry => entry.turn === turn)
      if (source === undefined) continue
      /* A comparison is addressable when the recorder kept one (it carries an
       * event coordinate), OR when a checkpoint commit exists for this turn (the
       * git fallback reconstructs the comparison from the commit's diff). */
      const hasRecorderCoord = typeof source.seq === 'number' && typeof source.index === 'number'
      files.push({
        path: file.path,
        display: file.display,
        status: source.status,
        added: source.added,
        deleted: source.deleted,
        at: hasRecorderCoord
          ? { turn, seq: source.seq, index: source.index }
          : commit !== undefined ? { turn } : null,
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
      /** The checkpoint commit for this turn, when one exists. */
      ...(commit !== undefined ? { sha: commit.sha, short: commit.short } : {}),
    }
  }

  /** One file's comparison in the requested scope. */
  async function fileComparison(scope, sessionId, path, at, signal) {
    /* A commit's comparison: `at` carries the commit, and `diff-tree --root -p`
     * answers for an ordinary commit and a repository's first one alike. */
    if (scope === 'commit') {
      if (at === undefined || at === '') {
        throw new DiffError('diff/bad-request', 'a commit scope needs the commit id in "at"', 400)
      }
      const { git, repository } = await repositoryFor(sessionId, signal)
      if (repository === null) {
        throw new DiffError('diff/not-a-repository', 'this Session is not inside a git repository', 404)
      }
      const compared = await diffCommitFile({ git, root: repository.root, sha: at, path, signal })
      return { ...toHunks(compared), path, display: path, turn: undefined }
    }

    if (scope === 'session') {
      const service = changeRecorder(ctx)
      /* Fast path: the recorder is alive and holds the comparison. */
      if (service !== undefined) {
        const { events } = await readSessionEvents(ctx, sessionId, memo.log)
        const turns = announcedSummaries(service, sessionId, events)
        const located = at === undefined ? locateChangedFile(turns, path) : at
        if (located !== undefined) {
          const diff = await service.diff(sessionId, located.seq, located.index, signal)
          if (diff !== undefined) {
            return { ...toHunks(diff), path, display: diff.display ?? path, turn: located.turn }
          }
        }
      }
      /* Fallback: reconstruct the comparison from the checkpoint commit.
       *
       * After a restart the recorder is gone, but if autoCommit was on (or the
       * user pressed "记一笔"), git holds the turn's commit and its diff against
       * the parent IS the turn's comparison. This is the persistence layer the
       * README argues for: git is already there, already durable, and already
       * understood by both scopes. */
      const turn = at?.turn
      if (turn !== undefined && Number.isSafeInteger(turn) && turn > 0) {
        const commits = await turnCommitsFor(sessionId, signal)
        const entry = commits.get(turn)
        if (entry !== undefined) {
          const { git, repository } = await repositoryFor(sessionId, signal)
          if (repository !== null) {
            const reconstructed = await diffTurnFile({ root: repository.root, git, sha: entry.sha, path, signal })
            if (reconstructed !== undefined) {
              return { ...toHunks(reconstructed), path, display: path, turn, reconstructed: true, sha: entry.sha }
            }
          }
        }
      }
      /* Neither the recorder nor git can answer: the honest response. */
      if (service === undefined) {
        throw new DiffError('diff/unavailable', 'this Host composes no change recorder, so session changes are unavailable', 503)
      }
      throw new DiffError('diff/no-comparison', `the Host kept no comparison for "${path}"`, 404)
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
        const sessionId = requiredString(query, 'sessionId')
        const path = requiredString(query, 'path')
        /* Three scopes: the working tree (`git`), one turn of this Session
         * (`session`), and one commit of the repository's history (`commit`, with
         * the commit id in `at`). */
        const scope = query.scope === 'session' ? 'session' : query.scope === 'commit' ? 'commit' : 'git'
        const at = scope === 'commit' ? requiredString(query, 'at') : parseAt(query.at)
        const signal = AbortSignal.timeout(30_000)
        const payload = await fileComparison(scope, sessionId, path, at, signal)
        writeJson(res, 200, { ok: true, scope, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.tree,
      /** One level of the Session's working tree, directories first. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const path = typeof query.path === 'string' ? query.path : ''
        const cwd = await resolveSessionCwd(ctx, sessionId)
        const payload = await listDirectory({ root: cwd, path, fs: { readdir } })
        writeJson(res, 200, { ok: true, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.read,
      /** One file's text plus the freshness pair a later write is checked against. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const path = requiredString(query, 'path')
        const cwd = await resolveSessionCwd(ctx, sessionId)
        const payload = await readWorkspaceFile({ root: cwd, path, fs: { stat, readFile } })
        writeJson(res, 200, { ok: true, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.write,
      /**
       * The file view's save. Confined to the Session's own working directory,
       * atomic, and refused when the disk moved under the reader — see
       * `lib/workspace.js` for why this cannot go through `workspaceFiles`.
       */
      handler: route(async (req, res) => {
        if (req.method !== 'POST') throw new DiffError('diff/bad-method', 'saving takes a POST', 405)
        const body = await readJsonBody(req, EDIT_MAX_BYTES + 64 * 1024)
        const sessionId = requiredString(body, 'sessionId')
        const path = requiredString(body, 'path')
        if (typeof body.content !== 'string') throw new DiffError('diff/bad-request', '"content" must be a string', 400)
        const expected = body.expected === null || body.expected === undefined
          ? undefined
          : { mtimeMs: Number(body.expected.mtimeMs), bytes: Number(body.expected.bytes) }
        const cwd = await resolveSessionCwd(ctx, sessionId)
        const payload = await writeWorkspaceFile({
          root: cwd,
          path,
          content: body.content,
          expected,
          fs: { stat, writeFile, rename, rm },
        })
        logger.info(`dsh-diff-view: wrote ${path} for ${sessionId} (${String(payload.bytes)} bytes)`)
        writeJson(res, 200, { ok: true, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.raw,
      /**
       * Raw bytes for the viewers that need a URL: the HTML preview iframe and a
       * download. Same containment and cap as the text read — a URL is not a way
       * around either — and `no-store`, because the point of a preview is to show
       * the file as it is now.
       */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const path = requiredString(query, 'path')
        const cwd = await resolveSessionCwd(ctx, sessionId)
        const file = await readWorkspaceBytes({ root: cwd, path, fs: { stat, readFile } })
        res.writeHead(200, {
          'content-type': file.contentType,
          'content-length': String(file.bytes.length),
          'cache-control': 'no-store',
          'content-disposition': `${query.download === '1' ? 'attachment' : 'inline'}; filename="${path.slice(path.lastIndexOf('/') + 1).replace(/"/gu, '')}"`,
        })
        res.end(file.bytes)
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.commits,
      /** The repository's history, newest first, one bounded page at a time. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const signal = AbortSignal.timeout(30_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        const payload = await listCommits({
          root: repository.root,
          git,
          limit: Number(query.limit),
          skip: Number(query.skip),
          signal,
        })
        writeJson(res, 200, { ok: true, repo: repository.root, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.commitDetail,
      /** One commit: who wrote it, when, what it says, and the files it touched. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const sha = requiredString(query, 'sha')
        const signal = AbortSignal.timeout(30_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        const payload = await commitDetail({ root: repository.root, git, sha, signal })
        writeJson(res, 200, { ok: true, repo: repository.root, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.fileHistory,
      /** The commits that touched one file, following it across a rename. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const path = requiredString(query, 'path')
        const signal = AbortSignal.timeout(30_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        const payload = await fileHistory({
          root: repository.root,
          git,
          path,
          limit: Number(query.limit),
          signal,
        })
        writeJson(res, 200, { ok: true, repo: repository.root, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.status,
      /** Where the repository stands: branch, upstream, ahead/behind, in-progress merge. */
      handler: route(async (req, res) => {
        const query = queryOf(req)
        const sessionId = requiredString(query, 'sessionId')
        const signal = AbortSignal.timeout(30_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        /* The marker files live in the git DIRECTORY, which is not always `<root>/.git`
         * (a worktree, a submodule, `GIT_DIR`): git is asked where it is. */
        const located = await runGit(git.subprocess, git.executable, ['rev-parse', '--absolute-git-dir'], {
          cwd: repository.root,
          signal,
        })
        const gitDir = located.exitCode === 0 ? located.stdout.trim() : ''
        const payload = await repositoryStatus({
          root: repository.root,
          git,
          gitDir,
          fs: { stat },
          signal,
        })
        writeJson(res, 200, { ok: true, repo: repository.root, cwd, ...payload })
      }),
    },

    {
      kind: 'exact',
      path: ROUTES.push,
      /**
       * Publish the branch. The one command here that leaves the machine, so it takes
       * a POST like the checkpoint does, and reports git's own words when it fails —
       * an unreachable remote or a missing credential is news the reader needs
       * verbatim, not a friendly guess.
       */
      handler: route(async (req, res) => {
        if (req.method !== 'POST') throw new DiffError('diff/bad-method', 'pushing takes a POST', 405)
        const body = await readJsonBody(req)
        const sessionId = requiredString(body, 'sessionId')
        const signal = AbortSignal.timeout(180_000)
        const { cwd, git, repository } = await repositoryFor(sessionId, signal)
        if (repository === null) {
          throw new DiffError('diff/not-a-repository', `"${cwd}" is not inside a git repository`, 404)
        }
        const payload = await pushBranch({
          root: repository.root,
          git,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          setUpstream: body.setUpstream === true,
          remote: typeof body.remote === 'string' ? body.remote : undefined,
          signal,
        })
        logger.info(`dsh-diff-view: pushed ${String(payload.branch)} for ${sessionId}`)
        writeJson(res, 200, { ok: true, ...payload })
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
 * Two shapes are accepted:
 * - `turn:seq:index` — the recorder's coordinate (fast path, in-memory).
 * - `turn` alone — the git fallback coordinate: the turn number is enough to
 *   find the checkpoint commit and reconstruct the comparison from it.
 *
 * @param value - the raw query value.
 * @returns `{ turn, seq?, index? }`, or undefined when the request names none.
 */
function parseAt(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const parts = value.split(':')
  if (parts.length === 1) {
    /* Turn-only coordinate: the git fallback path. */
    const turn = Number(parts[0])
    if (!Number.isSafeInteger(turn) || turn <= 0) return undefined
    return { turn, seq: undefined, index: undefined }
  }
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
