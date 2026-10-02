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
import { resolve, sep } from 'node:path'

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
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
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
        ? `git ${args.join(' ')} timed out after ${TIMEOUT_MS}ms`
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
