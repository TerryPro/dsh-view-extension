/**
 * Git access for the diff view: one bounded runner, the working-tree listing,
 * and the unified-diff parser.
 *
 * ## What "the diff" means here
 *
 * The git scope answers one question: **what differs between `HEAD` and the
 * working tree right now** — staged and unstaged changes together, plus
 * untracked files. That is the set a person reviews before committing, and
 * `git diff HEAD` is the one command that expresses it; `--cached` plus
 * `--unstaged` would only rebuild the same union with two calls and a
 * double-counting problem for a path in both.
 *
 * ## Why the parser is hand-written
 *
 * A unified diff has exactly three grammars — file header, hunk header, and
 * ` ` / `+` / `-` body lines — and the shell's own `WorkspaceDiffHunk` shape
 * (`$packages/deliverables/workspace-changes`) is what the client already knows
 * how to draw, so the parser's job is to translate one into the other and
 * nothing more. It reads bytes from `git`, never a file on disk, and it never
 * guesses: anything it cannot classify is dropped rather than shown wrong.
 *
 * Rename detection (`-M`) is deliberately NOT requested for the per-file read
 * even though the listing asks for it: with a single pathspec, `-M` can decide a
 * renamed path is a brand-new file with no difference, which is the one answer a
 * comparison must never give for a file whose content the user just changed.
 * The listing already names the rename; the comparison then shows the literal
 * post-image content of the path the user selected.
 *
 * The header grammar is settled before parsing rather than after:
 * `--src-prefix` / `--dst-prefix` are passed explicitly so `a/` and `b/` hold
 * regardless of the user's `diff.noprefix`, and `--line-prefix` carries a
 * control character that cannot occur in a path, which is what lets a body line
 * that itself begins with `diff --git` be told apart from a file header.
 *
 * @module dsh-diff-view/lib/git
 */
import { join, resolve, sep } from 'node:path'

import { DiffError } from './http.js'

/** Milliseconds one git command gets before it is terminated. */
const TIMEOUT_MS = 20_000
/** In-memory stdout cap for one git command. */
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Grace between the termination request and the kill. */
const TERMINATE_GRACE_MS = 2_000

/**
 * Marker prefixed to every body line of a diff (`--line-prefix`).
 *
 * It has to be a string a path cannot contain: `\u0001` is outside every
 * filesystem's printable set, so a line starting with it is body text and a
 * line starting with `diff --git` is a header, always.
 */
const LINE_MARKER = '\u0001'

/** Environment every git child runs under: no prompts, no locks, stable locale. */
const GIT_ENV = {
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
}

/** One settled git command; a nonzero exit is a result, not an exception. */
export class GitResult {
  /**
   * @param {number|null} exitCode - exit status, null when the child was signalled.
   * @param {string} stdout - collected standard output.
   * @param {string} stderr - collected error output.
   * @param {boolean} truncated - whether stdout hit the cap and lost its head.
   */
  constructor(exitCode, stdout, stderr, truncated) {
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
    this.truncated = truncated
  }
}

/**
 * Run `git` with arguments that are never shell-interpreted.
 *
 * @param subprocess - the `ctx.subprocess` capability.
 * @param executable - the resolved `git` path.
 * @param args - git arguments.
 * @param options - `{ cwd, signal, maxBytes? }`.
 * @returns the settled command facts.
 * @throws {DiffError} `diff/timeout` when the command outlives its budget.
 */
export async function runGit(subprocess, executable, args, options) {
  /* One bound for every local read, and a longer one where a command talks to a
   * remote: 20 seconds is generous for `git log` and tight for `git push` on a
   * slow link, and a push that is killed mid-flight reports a failure that did not
   * happen. */
  const budget = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS
  const timeout = AbortSignal.timeout(budget)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxBytes ?? OUTPUT_MAX_BYTES },
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: TERMINATE_GRACE_MS,
    signal,
    env: GIT_ENV,
  })
  const outcome = await handle.done
  if (signal.aborted) {
    throw new DiffError(
      'diff/timeout',
      timeout.aborted
        ? `git ${args.join(' ')} timed out after ${budget}ms`
        : `git ${args.join(' ')} was aborted`,
      504,
    )
  }
  const stdout = handle.collected?.stdout?.readFrom(0) ?? { text: '', lossy: false }
  const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
  return new GitResult(outcome.exitCode, stdout.text, stderr, stdout.lossy === true)
}

/**
 * Resolve the `git` executable, or explain that there is none.
 *
 * @param subprocess - the `ctx.subprocess` capability.
 * @param signal - cancellation.
 * @returns the executable path.
 * @throws {DiffError} `diff/no-git` when git is not installed.
 */
export async function resolveGit(subprocess, signal) {
  try {
    const found = await subprocess.resolveExecutable('git', GIT_ENV, signal)
    if (typeof found === 'string' && found !== '') return found
  } catch (error) {
    throw new DiffError('diff/no-git', `git is not available on this machine: ${String(error?.message ?? error)}`, 503)
  }
  throw new DiffError('diff/no-git', 'git is not available on this machine', 503)
}

/**
 * Locate the repository enclosing a working directory.
 *
 * @param git - `{ subprocess, executable }`.
 * @param cwd - absolute directory to test.
 * @param signal - cancellation.
 * @returns `{ root, gitDir }`, or null when the directory is not in a repository.
 */
export async function locateRepository(git, cwd, signal) {
  const found = await runGit(git.subprocess, git.executable, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd, signal })
  if (found.exitCode !== 0) {
    if (/not a git repository/i.test(found.stderr)) return null
    throw new DiffError('diff/git-failed', `git rev-parse failed: ${found.stderr.trim() || 'no diagnostic'}`, 500)
  }
  const lines = found.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length < 2) throw new DiffError('diff/git-failed', 'git rev-parse returned an unexpected shape', 500)
  return { root: lines[0], gitDir: lines[1] }
}

/**
 * Parse `git status --porcelain=v2 -z -uall` into per-path status facts.
 *
 * The v2 format is record-oriented and NUL-terminated exactly so that paths
 * with spaces, tabs, and newlines need no quoting; a rename record carries its
 * original path as a second NUL-terminated field immediately after its own.
 *
 * @param stdout - the command's standard output.
 * @returns a map from repository-relative slash path to `{ status, originalPath }`.
 */
export function parseStatus(stdout) {
  const records = stdout.split('\0')
  const files = new Map()
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at]
    if (record === '') continue
    const kind = record[0]
    if (kind === '#') continue
    if (kind === '?') {
      const path = record.slice(2)
      if (path !== '') files.set(path, { status: 'untracked', originalPath: undefined, tracked: false })
      continue
    }
    if (kind === '!') continue
    if (kind !== '1' && kind !== '2') continue
    const parts = record.split(' ')
    if (parts.length < 9) continue
    const xy = parts[1]
    const renamed = kind === '2'
    let path = parts.slice(8).join(' ')
    let originalPath
    if (renamed) {
      originalPath = records[at + 1]
      at += 1
    }
    if (path === '') continue
    files.set(path, { status: statusOf(xy), originalPath, tracked: true })
  }
  return files
}

/**
 * Classify one two-letter `XY` status code.
 *
 * `X` is the index (staged) side and `Y` the work-tree side, so an untracked
 * letter on either side is what "added" means and the remaining letters are
 * read in that order.
 *
 * @param xy - the two-letter code.
 * @returns the status the list renders.
 */
function statusOf(xy) {
  const [index, work] = [xy[0], xy[1]]
  if (index === '?' || work === '?') return 'untracked'
  if (index === 'A') return 'added'
  if (index === 'D' || work === 'D') return 'deleted'
  if (index === 'R' || work === 'R') return 'renamed'
  if (index === 'C' || work === 'C') return 'copied'
  if (index === 'U' || work === 'U' || (index === 'A' && work === 'A') || (index === 'D' && work === 'D')) return 'conflicted'
  return 'modified'
}

/**
 * Parse `git diff --numstat -z` into per-path line counts.
 *
 * @param stdout - the command's standard output.
 * @returns a map from path to `{ added, deleted, binary }`.
 */
export function parseNumstat(stdout) {
  const fields = stdout.split('\0')
  const counts = new Map()
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at]
    if (field === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field)
    if (match === null) continue
    let path = match[3]
    const binary = match[1] === '-' || match[2] === '-'
    // A rename consumes one more NUL-terminated field (the original path).
    const next = fields[at + 1]
    const following = fields[at + 2]
    if (path === '' && next !== undefined) {
      path = next
      if (following !== undefined && !/^\d/.test(following)) at += 1
    }
    if (path === '') continue
    counts.set(path, {
      added: binary ? 0 : Number(match[1]),
      deleted: binary ? 0 : Number(match[2]),
      binary,
    })
  }
  return counts
}

/**
 * Parse a unified diff produced with {@link LINE_MARKER} line prefixes.
 *
 * `--line-prefix` prefixes EVERY line of the diff, headers included, so the
 * marker is peeled first and the line is then classified the ordinary way. That
 * ordering is what makes a body line that itself begins with `diff --git`,
 * `--- `, or `@@` impossible to confuse with a header: a header arrives with
 * exactly one marker, and a body line arrives with exactly two.
 *
 * @param stdout - the diff text.
 * @param options - `{ fallbackPath }` used when the header is unreadable.
 * @returns `{ before, after, hunks, binary }`; `before`/`after` say which side exists.
 */
export function parseUnifiedDiff(stdout, options = {}) {
  const lines = stdout.split('\n')
  const hunks = []
  let current = null
  let beforePath
  let afterPath
  let binary = false
  const flush = () => {
    if (current !== null && (current.lines.length > 0 || current.oldLines > 0 || current.newLines > 0)) hunks.push(current)
    current = null
  }
  for (const raw of lines) {
    const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const line = trimmed.startsWith(LINE_MARKER) ? trimmed.slice(LINE_MARKER.length) : trimmed
    if (line.startsWith('diff --git ')) {
      flush()
      beforePath = undefined
      afterPath = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      beforePath = headerPath(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      afterPath = headerPath(line.slice(4))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
      continue
    }
    if (line.startsWith('@@')) {
      flush()
      const header = parseHunkHeader(line)
      if (header === null) continue
      current = header
      continue
    }
    if (line.startsWith('\\ No newline')) continue
    // A marker means body text; anything else at this point is a header this
    // parser does not model (`index`, `new file mode`, `old mode`, …).
    if (current === null || !trimmed.startsWith(LINE_MARKER)) continue
    current.lines.push(line)
  }
  flush()
  const path = afterPath !== undefined && afterPath !== '/dev/null'
    ? afterPath
    : beforePath !== undefined && beforePath !== '/dev/null' ? beforePath : options.fallbackPath
  return {
    path,
    before: beforePath !== undefined && beforePath !== '/dev/null',
    after: afterPath !== undefined && afterPath !== '/dev/null',
    hunks,
    binary,
  }
}

/**
 * The path one `---`/`+++` header names, or undefined for `/dev/null`.
 *
 * Quoted headers (a path with a newline, a quote, or a non-ASCII byte under
 * `core.quotePath`) carry C-style escapes; the common ones are decoded so such
 * a path still matches its listing entry.
 *
 * @param value - everything after `--- ` or `+++ `.
 * @returns the path, or undefined when the side is absent.
 */
function headerPath(value) {
  let text = value.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    text = text.slice(1, -1)
      .replace(/\\n/gu, '\n')
      .replace(/\\t/gu, '\t')
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\')
  }
  const tab = text.indexOf('\t')
  if (tab !== -1) text = text.slice(0, tab)
  if (text === '/dev/null' || text === '') return undefined
  if (text.startsWith('a/') || text.startsWith('b/')) return text.slice(2)
  return text
}

/**
 * Parse one `@@ -a,b +c,d @@` header.
 *
 * @param line - the header line.
 * @returns the hunk skeleton, or null when the line is not a hunk header.
 */
function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
  if (match === null) return null
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    lines: [],
  }
}

/**
 * The full unified diff of one path between `HEAD` and the working tree.
 *
 * @param git - `{ subprocess, executable }`.
 * @param options - `{ root, path, signal }`.
 * @returns the parsed comparison.
 */
export async function diffWorkingTree(git, options) {
  const result = await runGit(git.subprocess, git.executable, [
    '--no-pager', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv',
    `--src-prefix=a/`, `--dst-prefix=b/`, `--line-prefix=\u0001`,
    '--unified=3', '--', options.path,
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) {
    throw new DiffError('diff/git-failed', `git diff failed: ${result.stderr.trim() || 'no diagnostic'}`, 500)
  }
  return parseUnifiedDiff(result.stdout, { fallbackPath: options.path })
}

/** The field separator `git log` writes between the parts of one commit line. */
const LOG_FIELD = '\u0001'

/**
 * Read a slice of the repository's history.
 *
 * One line per commit, its fields separated by `\u0001`. One commit MORE than
 * asked for is read, so that "is there more" is an answer rather than a guess,
 * and the extra one is dropped from the result.
 *
 * `--numstat` is what makes a row worth reading: it carries the per-commit
 * `N files, +x −y` a reviewer scans for. It is parsed as NUMBERS rather than
 * through `--shortstat`, whose text git translates ("3 files changed" has a
 * different shape in every locale).
 *
 * @param options - `{ root, git, limit?, skip?, signal }`.
 * @returns `{ commits, more }` — each commit carries `{ sha, short, author, email, at, parents, refs, subject, files, added, deleted, binary }`.
 */
export async function listCommits(options) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 40
  const skip = Number.isSafeInteger(options.skip) && options.skip > 0 ? options.skip : 0
  const spec = ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s'].join(LOG_FIELD)
  const result = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'log',
    `--max-count=${String(limit + 1)}`,
    `--skip=${String(skip)}`,
    '--numstat',
    `--pretty=format:${LOG_FIELD}${spec}`,
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || 'git log failed'
    /* An empty repository has no commits yet: that is a state, not a failure. */
    if (/does not have any commits yet|unknown revision|bad default revision/iu.test(message)) {
      return { commits: [], more: false }
    }
    throw new DiffError('diff/git-failed', message, 500)
  }
  return parseLogNumstat(result.stdout, limit)
}

/**
 * Parse `git log --numstat` output with the header format this module asks for.
 *
 * One header line per commit (each field separated by `\u0001`, the line itself
 * opening with it), then that commit's `\d+\t\d+\tpath` lines until the next
 * header. Numbers are read as numbers rather than through `--shortstat`, whose
 * text git TRANSLATES — parsing "3 files changed" would tie the view to English.
 *
 * @param stdout - the command's output.
 * @param limit - how many commits the caller asked for (the extra probe one is dropped).
 * @returns `{ commits, more }`.
 */
function parseLogNumstat(stdout, limit) {
  const commits = []
  let current = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith(LOG_FIELD)) {
      const parts = line.slice(1).split(LOG_FIELD)
      if (parts.length < 8) continue
      const parents = parts[5].trim() === '' ? [] : parts[5].trim().split(' ')
      current = {
        sha: parts[0],
        short: parts[1],
        author: parts[2],
        email: parts[3],
        at: parts[4],
        parents: parents.length,
        refs: parts[6].split(',').map(part => part.trim()).filter(part => part !== ''),
        subject: parts[7],
        files: 0,
        added: 0,
        deleted: 0,
        binary: false,
      }
      commits.push(current)
      continue
    }
    if (current === null) continue
    const counted = /^(\d+|-)\t(\d+|-)\t/u.exec(line)
    if (counted === null) continue
    current.files += 1
    if (counted[1] === '-' || counted[2] === '-') current.binary = true
    else {
      current.added += Number(counted[1])
      current.deleted += Number(counted[2])
    }
  }
  return { commits, more: commits.length > limit }
}

/**
 * The commits that touched one file — the per-file history a reader asks for by
 * clicking a name in the tree.
 *
 * `--follow` is what makes it honest across a rename: a file that was moved here
 * keeps the history of the name it used to have, which is exactly the history a
 * reader is looking for. It accepts one path only, which is all this needs.
 *
 * @param options - `{ root, git, path, limit?, signal }`.
 * @returns `{ path, commits }` in the same shape {@link listCommits} returns.
 */
export async function fileHistory(options) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 30
  const spec = ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s'].join(LOG_FIELD)
  const result = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'log',
    `--max-count=${String(limit)}`,
    '--follow',
    '--numstat',
    `--pretty=format:${LOG_FIELD}${spec}`,
    '--',
    options.path,
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) {
    throw new DiffError('diff/git-failed', result.stderr.trim() || 'git log failed', 500)
  }
  return { path: options.path, commits: parseLogNumstat(result.stdout, limit).commits }
}

/**
 * The turn→commit mapping for one Session, reconstructed from git history.
 *
 * Every checkpoint commit carries a machine-parseable trailer (`DSH-Turn: N`,
 * `DSH-Session: <id>`) appended by {@link commitMessage}. This function searches
 * the repository's log for those trailers and builds the mapping that lets the
 * per-turn view reconstruct comparisons after a restart — when the Host's
 * in-memory change recorder is gone but git still holds every commit.
 *
 * The search is bounded (200 commits) and cached by the caller, so it costs one
 * `git log` per Session per mount lifetime.
 *
 * @param options - `{ root, git, sessionId, signal }`.
 * @returns `Map<turn, { sha, short }>` — empty when no checkpoint commits exist.
 */
export async function findTurnCommits(options) {
  const result = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'log', '--all',
    '--max-count=200',
    '--numstat',
    `--format=${LOG_FIELD}%H${LOG_FIELD}%h${LOG_FIELD}%B${LOG_FIELD}%x00`,
    '--fixed-strings',
    `--grep=DSH-Session: ${options.sessionId}`,
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) return new Map()
  return parseTurnLog(result.stdout)
}

/**
 * Accumulate one commit's `--numstat` lines into its running totals.
 *
 * @param commit - the entry being filled.
 * @param text - the numstat block for that commit.
 */
function accumulateNumstat(commit, text) {
  for (const line of text.split('\n')) {
    const counted = /^(\d+|-)\t(\d+|-)\t/u.exec(line)
    if (counted === null) continue
    commit.files += 1
    if (counted[1] === '-' || counted[2] === '-') commit.binary = true
    else {
      commit.added += Number(counted[1])
      commit.deleted += Number(counted[2])
    }
  }
}

/**
 * Parse a `git log --numstat` stream whose format ends each commit with a NUL.
 *
 * The layout is `F1 \0 N1 F2 \0 N2 …` where `F` is a format block (starting with
 * {@link LOG_FIELD}) and `N` is that commit's numstat lines. So each NUL-delimited
 * chunk carries the PREVIOUS commit's numstat followed by the NEXT commit's format;
 * the first chunk is a bare format and the last a bare numstat block.
 *
 * @param stdout - the log output.
 * @returns `Map<turn, { sha, short, files, added, deleted, binary }>`.
 */
export function parseTurnLog(stdout) {
  const map = new Map()
  let current = null
  for (const chunk of stdout.split('\0')) {
    const idx = chunk.indexOf(LOG_FIELD)
    if (idx < 0) {
      /* A pure numstat block (the trailing chunk): belongs to the commit in hand. */
      if (current !== null) accumulateNumstat(current, chunk)
      continue
    }
    if (idx > 0 && current !== null) accumulateNumstat(current, chunk.slice(0, idx))
    const parts = chunk.slice(idx + LOG_FIELD.length).split(LOG_FIELD)
    if (parts.length < 3) { current = null; continue }
    const sha = parts[0].trim()
    const short = parts[1].trim()
    const body = parts[2]
    const turnMatch = /DSH-Turn:\s*(\d+)/u.exec(body)
    if (sha === '' || turnMatch === null) { current = null; continue }
    const turn = Number(turnMatch[1])
    if (!Number.isSafeInteger(turn) || turn <= 0) { current = null; continue }
    /* Newest first in git log; keep the FIRST (newest) commit per turn. */
    if (map.has(turn)) { current = null; continue }
    current = { sha, short, files: 0, added: 0, deleted: 0, binary: false }
    map.set(turn, current)
  }
  return map
}

/**
 * Parse `git log` output carrying full commit bodies into a turn→SHA map.
 *
 * Each record is NUL-terminated (`%x00`), and within it the fields are separated
 * by {@link LOG_FIELD}. The body (`%B`) is scanned for the `DSH-Turn: N` trailer.
 *
 * @param stdout - the log output.
 * @returns `Map<turn, { sha, short }>`.
 */
export function parseTurnTrailers(stdout) {
  const map = new Map()
  const records = stdout.split('\0')
  for (const record of records) {
    const trimmed = record.replace(/^[\n\r]+/u, '')
    if (trimmed === '') continue
    const parts = trimmed.split(LOG_FIELD)
    if (parts.length < 3) continue
    const sha = parts[0].trim()
    const short = parts[1].trim()
    const body = parts[2]
    if (sha === '') continue
    const turnMatch = /DSH-Turn:\s*(\d+)/u.exec(body)
    if (turnMatch === null) continue
    const turn = Number(turnMatch[1])
    if (!Number.isSafeInteger(turn) || turn <= 0) continue
    /* Newest first in git log; keep the FIRST (newest) commit per turn in case
     * of duplicates (a re-commit after an amend, for example). */
    if (!map.has(turn)) map.set(turn, { sha, short })
  }
  return map
}

/**
 * The comparison one checkpoint commit made to one file — the git-based
 * reconstruction of what the change recorder would have served.
 *
 * This is {@link diffCommitFile} with the semantics the per-turn view needs:
 * when the recorder is gone (a restart), the commit IS the turn's record, and
 * its diff against its parent IS the turn's comparison.
 *
 * @param options - `{ root, git, sha, path, signal }`.
 * @returns the parsed comparison, or undefined when the commit does not touch the path.
 */
export async function diffTurnFile(options) {
  /* First check whether this commit actually touched the path: a checkpoint
   * commits the WHOLE tree, but the per-turn view asks for one file. If the
   * file is not in the commit's diff-tree, there is nothing to reconstruct. */
  const names = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'diff-tree', '--root', '--first-parent', '-r',
    '--no-commit-id', '--name-only', '-z', options.sha, '--', options.path,
  ], { cwd: options.root, signal: options.signal })
  if (names.exitCode !== 0) return undefined
  const touched = names.stdout.split('\0').filter(token => token !== '')
  if (touched.length === 0) return undefined
  return diffCommitFile(options)
}

/**
 * Where the repository stands: its branch, its upstream, and how far the two have
 * drifted.
 *
 * `status --porcelain=v2 --branch` answers the branch, the upstream and the
 * ahead/behind counts in one process. A branch with no upstream is not an error —
 * it is a branch that has never been published, which is the state a reader most
 * needs to be told about. Merge and rebase state come from the marker files git
 * itself writes, because `status` does not report them.
 *
 * @param options - `{ root, git, gitDir, fs, signal }`.
 * @returns `{ branch, detached, upstream, ahead, behind, unborn, merging, rebasing }`.
 */
export async function repositoryStatus(options) {
  const result = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'status', '--porcelain=v2', '--branch', '-z',
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) {
    throw new DiffError('diff/git-failed', result.stderr.trim() || 'git status failed', 500)
  }
  const status = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    /** A repository with no commits yet: every branch is unborn. */
    unborn: false,
    merging: false,
    rebasing: false,
  }
  for (const header of result.stdout.split('\0')) {
    if (header.startsWith('# branch.head ')) {
      const head = header.slice('# branch.head '.length)
      status.detached = head === '(detached)'
      status.branch = status.detached ? null : head
    } else if (header.startsWith('# branch.upstream ')) {
      status.upstream = header.slice('# branch.upstream '.length)
    } else if (header.startsWith('# branch.ab ')) {
      const counted = /\+(\d+)\s+-(\d+)/u.exec(header)
      if (counted !== null) {
        status.ahead = Number(counted[1])
        status.behind = Number(counted[2])
      }
    } else if (header.startsWith('# branch.oid ')) {
      status.unborn = header.slice('# branch.oid '.length).trim() === '(initial)'
    }
  }
  const exists = async path => {
    try {
      await options.fs.stat(path)
      return true
    } catch (error) {
      return false
    }
  }
  if (typeof options.gitDir === 'string' && options.gitDir !== '') {
    status.merging = await exists(join(options.gitDir, 'MERGE_HEAD'))
    status.rebasing = (await exists(join(options.gitDir, 'rebase-merge'))) || (await exists(join(options.gitDir, 'rebase-apply')))
  }
  return status
}

/**
 * Push the current branch, setting its upstream the first time.
 *
 * The only command here that leaves the machine, so it is deliberately narrow: no
 * force, no tags, no refspecs — `git push` and, when the branch has no upstream
 * yet, `--set-upstream origin <branch>`. Whatever git prints is reported as it is:
 * an authentication failure or an unreachable remote is a result the reader needs
 * to see verbatim, not something to translate into a friendly guess.
 *
 * @param options - `{ root, git, branch, setUpstream, remote?, signal? }`.
 * @returns `{ pushed, branch, upstream, output }`.
 */
export async function pushBranch(options) {
  const args = ['push']
  if (options.setUpstream === true) {
    if (typeof options.branch !== 'string' || options.branch === '') {
      throw new DiffError('diff/bad-request', 'a detached HEAD has no branch to publish', 400)
    }
    args.push('--set-upstream', typeof options.remote === 'string' && options.remote !== '' ? options.remote : 'origin', options.branch)
  }
  const result = await runGit(options.git.subprocess, options.git.executable, args, {
    cwd: options.root,
    signal: options.signal,
    timeoutMs: 180_000,
  })
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.exitCode !== 0) {
    throw new DiffError('diff/push-failed', output === '' ? 'git push failed' : output, 502)
  }
  return { pushed: true, branch: options.branch ?? null, upstream: options.setUpstream === true ? `origin/${String(options.branch)}` : null, output }
}

/**
 * The status letter `--name-status` prints, in the vocabulary the views speak.
 *
 * @param letter - one letter, possibly followed by a similarity score (`R100`).
 * @returns the status name.
 */
export function statusOfLetter(letter) {
  const first = String(letter).charAt(0).toUpperCase()
  if (first === 'A') return 'added'
  if (first === 'D') return 'deleted'
  if (first === 'R') return 'renamed'
  if (first === 'C') return 'copied'
  if (first === 'T') return 'typechange'
  return 'modified'
}

/**
 * One commit: its metadata and the files it touched.
 *
 * `--root` is what makes a repository's FIRST commit readable like any other (it
 * is diffed against the empty tree), and `--first-parent` keeps a merge honest:
 * the merge is read against the branch it merged INTO, rather than as a combined
 * diff no single-file view could render.
 *
 * @param options - `{ root, git, sha, signal }`.
 * @returns `{ commit, files }`.
 */
export async function commitDetail(options) {
  const sha = options.sha
  const meta = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'show', '--no-patch',
    `--pretty=format:%H${LOG_FIELD}%h${LOG_FIELD}%an${LOG_FIELD}%aI${LOG_FIELD}%s`,
    sha,
  ], { cwd: options.root, signal: options.signal })
  if (meta.exitCode !== 0) {
    throw new DiffError('diff/no-such-commit', `cannot read commit "${sha}": ${meta.stderr.trim() || 'git show failed'}`, 404)
  }
  const fields = meta.stdout.split('\n')[0].split(LOG_FIELD)
  const commit = fields.length >= 5
    ? { sha: fields[0], short: fields[1], author: fields[2], at: fields[3], subject: fields[4] }
    : { sha, short: sha.slice(0, 7), author: '', at: '', subject: '' }

  const names = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'diff-tree', '--root', '--first-parent', '-r',
    '--no-commit-id', '--name-status', '-z', '--find-renames', sha,
  ], { cwd: options.root, signal: options.signal })
  if (names.exitCode !== 0) {
    throw new DiffError('diff/git-failed', names.stderr.trim() || 'git diff-tree failed', 500)
  }
  const counts = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'diff-tree', '--root', '--first-parent', '-r',
    '--no-commit-id', '--numstat', '-z', '--find-renames', sha,
  ], { cwd: options.root, signal: options.signal })
  const stats = counts.exitCode === 0 ? parseNumstat(counts.stdout) : new Map()

  const files = []
  const tokens = names.stdout.split('\0').filter(token => token !== '')
  for (let at = 0; at < tokens.length; at += 1) {
    const status = statusOfLetter(tokens[at])
    const path = tokens[at + 1] ?? ''
    at += 1
    /* A rename (or a copy) prints its destination and then its source, so the
     * source is consumed with it rather than mistaken for another entry. */
    if (status === 'renamed' || status === 'copied') at += 1
    if (path === '') continue
    const counted = stats.get(path)
    files.push({
      path,
      status,
      added: counted === undefined ? 0 : counted.added,
      deleted: counted === undefined ? 0 : counted.deleted,
    })
  }
  return { commit, files }
}

/**
 * The comparison one commit made to one file.
 *
 * `diff-tree --root -p` answers for an ordinary commit and for a repository's
 * first commit alike, and it writes the same `--line-prefix` marker as every
 * other diff this plugin serves, so one parser reads them all.
 *
 * @param options - `{ root, git, sha, path, signal }`.
 * @returns the parsed comparison (the shape {@link diffWorkingTree} returns).
 */
export async function diffCommitFile(options) {
  const result = await runGit(options.git.subprocess, options.git.executable, [
    '--no-pager', 'diff-tree', '--root', '--first-parent', '-r', '-p',
    '--no-commit-id', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', `--line-prefix=${LINE_MARKER}`, '--unified=3',
    options.sha, '--', options.path,
  ], { cwd: options.root, signal: options.signal })
  if (result.exitCode !== 0) {
    throw new DiffError('diff/git-failed', result.stderr.trim() || 'git diff-tree failed', 500)
  }
  return parseUnifiedDiff(result.stdout, options.path)
}

/**
 * Read an untracked file as an all-additions comparison.
 *
 * Git has no index entry for a file it does not track, so `git diff` says
 * nothing about it; the honest rendering is every line as an addition, which is
 * what a newly created file is.
 *
 * @param options - `{ root, path, fs, maxBytes? }`; `fs` is the `node:fs/promises` surface (`readFile`, `stat`).
 * @returns the synthetic comparison.
 */
export async function addedFileDiff(options) {
  const fs = options.fs
  const absolute = joinUnder(options.root, options.path)
  if (absolute === null) throw new DiffError('diff/bad-path', `"${options.path}" escapes the repository`, 400)
  const maxBytes = options.maxBytes ?? OUTPUT_MAX_BYTES
  let stats
  try {
    stats = await fs.stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: options.path, before: false, after: false, hunks: [], binary: false, oversized: false }
    }
    throw new DiffError('diff/read-failed', `cannot read "${options.path}": ${String(error?.message ?? error)}`, 500)
  }
  if (stats.isDirectory()) {
    throw new DiffError('diff/not-a-file', `"${options.path}" is a directory`, 400)
  }
  if (typeof stats.size === 'number' && stats.size > maxBytes) {
    return { path: options.path, before: false, after: true, hunks: [], binary: false, oversized: true }
  }
  const buffer = await fs.readFile(absolute)
  if (buffer.includes(0)) {
    return { path: options.path, before: false, after: true, hunks: [], binary: true, oversized: false }
  }
  const text = buffer.toString('utf8')
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return {
    path: options.path,
    before: false,
    after: true,
    binary: false,
    oversized: false,
    hunks: lines.length === 0 ? [] : [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map(line => `+${line.endsWith('\r') ? line.slice(0, -1) : line}`),
    }],
  }
}

/**
 * Join a repository-relative path under a root, refusing anything that escapes.
 *
 * Git reports paths relative to the repository it was asked about, so every
 * served path has already been through git's own normalization; this is the
 * second check, and it is the one that matters, because a path is about to
 * become a file read.
 *
 * @param root - absolute repository root.
 * @param path - repository-relative slash path.
 * @returns the absolute path, or null when it escapes the root.
 */
export function joinUnder(root, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return null
  const absolute = resolve(root, path)
  // The comparison is on the separator-normalized forms: git always reports
  // `/`, while `path.resolve` normalizes to the platform's separator.
  const prefix = `${resolve(root).replace(/[\\/]+$/u, '')}${sep}`
  return `${absolute}${sep}`.startsWith(prefix) ? absolute : null
}
