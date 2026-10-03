/**
 * The file view's data plane: list a directory, read a file, and write one back.
 *
 * ## Why the Host does this instead of `workspaceFiles`
 *
 * The shell already exposes a session-scoped file capability
 * (`@deepseek-ai/dsh-api-workspace-files`: `list` / `stat` / `read` / `readBytes`
 * / `changes`), and a plugin that only *reads* should use it — it resolves every
 * path against the Session root, gates kinds and sizes, and needs no host half.
 *
 * An EDITOR cannot: that capability exposes no write, and its `stat.version` is
 * documented as an opaque freshness token ("never parsed"), so it cannot be
 * compared against anything this side of the wire. Rather than mix two
 * vocabularies for freshness — the shell's opaque token for the read and a
 * local one for the write — both ends of the comparison live here: one read
 * returns the file WITH its `(mtimeMs, bytes)` pair, and one write refuses to
 * land unless that pair still matches what is on disk.
 *
 * Every path is resolved against the Session's own working directory and refused
 * if it escapes (`joinUnder`), so the worst a crafted request can do is name a
 * file the Session already owns.
 *
 * @module dsh-diff-view/lib/workspace
 */
import { rename, rm, writeFile } from 'node:fs/promises'

import { joinUnder } from './git.js'
import { DiffError } from './http.js'

/** Entries one directory listing returns before it is called truncated. */
export const TREE_ENTRY_CAP = 500
/** Largest file this editor will open (and therefore the largest it will save). */
export const EDIT_MAX_BYTES = 2 * 1024 * 1024

/** Directories first, then by name — the order every file tree uses. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * One level of the workspace tree.
 *
 * @param options - `{ root, path, fs }`; `path` is workspace-relative (`''` or `'.'` = the root).
 * @returns `{ path, entries, truncated }`.
 * @throws {DiffError} `diff/bad-path` when the path escapes the root.
 */
export async function listDirectory(options) {
  const relative = options.path === '' ? '.' : options.path
  const absolute = joinUnder(options.root, relative)
  if (absolute === null) throw new DiffError('diff/bad-path', `"${options.path}" escapes the workspace`, 400)
  let dirents
  try {
    dirents = await options.fs.readdir(absolute, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new DiffError('diff/not-found', `"${options.path}" does not exist`, 404)
    if (error?.code === 'ENOTDIR') throw new DiffError('diff/not-a-directory', `"${options.path}" is not a directory`, 400)
    throw new DiffError('diff/read-failed', `cannot list "${options.path}": ${String(error?.message ?? error)}`, 500)
  }
  const entries = []
  for (const dirent of dirents) {
    const type = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other'
    entries.push({ name: dirent.name, type })
  }
  entries.sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
  const truncated = entries.length > TREE_ENTRY_CAP
  return { path: options.path, entries: truncated ? entries.slice(0, TREE_ENTRY_CAP) : entries, truncated }
}

/**
 * One file, with the freshness pair a later write is checked against.
 *
 * @param options - `{ root, path, fs, maxBytes? }`.
 * @returns `{ path, text, mtimeMs, bytes, binary?, oversized? }`.
 * @throws {DiffError} `diff/bad-path`, `diff/not-found`, `diff/not-a-file`, `diff/read-failed`.
 */
export async function readWorkspaceFile(options) {
  const absolute = joinUnder(options.root, options.path)
  if (absolute === null) throw new DiffError('diff/bad-path', `"${options.path}" escapes the workspace`, 400)
  const maxBytes = options.maxBytes ?? EDIT_MAX_BYTES
  let stats
  try {
    stats = await options.fs.stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new DiffError('diff/not-found', `"${options.path}" does not exist`, 404)
    throw new DiffError('diff/read-failed', `cannot read "${options.path}": ${String(error?.message ?? error)}`, 500)
  }
  if (stats.isDirectory()) throw new DiffError('diff/not-a-file', `"${options.path}" is a directory`, 400)
  const bytes = typeof stats.size === 'number' ? stats.size : 0
  const base = { path: options.path, mtimeMs: Math.round(stats.mtimeMs), bytes }
  if (bytes > maxBytes) return { ...base, oversized: true }
  const buffer = await options.fs.readFile(absolute)
  if (buffer.includes(0)) return { ...base, binary: true }
  return { ...base, text: buffer.toString('utf8') }
}

/**
 * Write one file, atomically, and only if the disk still looks as it did.
 *
 * The write lands through a temporary file in the same directory followed by a
 * rename, so a reader never sees half a file and a crash cannot leave one. The
 * `expected` pair comes from {@link readWorkspaceFile}; a mismatch means someone
 * (or something) changed the file since it was read, and the honest answer is to
 * refuse and let the reader decide — never to overwrite silently.
 *
 * @param options - `{ root, path, content, expected?, fs }`.
 * @returns `{ path, mtimeMs, bytes, created? }`.
 * @throws {DiffError} `diff/bad-path`, `diff/not-a-file`, `diff/conflict` (409), `diff/write-failed`.
 */
export async function writeWorkspaceFile(options) {
  const absolute = joinUnder(options.root, options.path)
  if (absolute === null) throw new DiffError('diff/bad-path', `"${options.path}" escapes the workspace`, 400)
  let before
  try {
    const stats = await options.fs.stat(absolute)
    if (stats.isDirectory()) throw new DiffError('diff/not-a-file', `"${options.path}" is a directory`, 400)
    before = { mtimeMs: Math.round(stats.mtimeMs), bytes: typeof stats.size === 'number' ? stats.size : 0 }
  } catch (error) {
    if (error instanceof DiffError) throw error
    if (error?.code !== 'ENOENT') {
      throw new DiffError('diff/write-failed', `cannot inspect "${options.path}": ${String(error?.message ?? error)}`, 500)
    }
    before = undefined
  }
  const expected = options.expected
  if (expected !== undefined && expected !== null) {
    const matches = before !== undefined
      && Number(expected.mtimeMs) === before.mtimeMs
      && Number(expected.bytes) === before.bytes
    if (!matches) {
      throw new DiffError('diff/conflict', `"${options.path}" changed on disk since it was read`, 409)
    }
  }
  const temporary = `${absolute}.dsh-diff-tmp-${String(process.pid)}-${String(Date.now())}`
  try {
    await writeFile(temporary, options.content, 'utf8')
    await rename(temporary, absolute)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw new DiffError('diff/write-failed', `cannot write "${options.path}": ${String(error?.message ?? error)}`, 500)
  }
  const after = await options.fs.stat(absolute)
  return {
    path: options.path,
    mtimeMs: Math.round(after.mtimeMs),
    bytes: typeof after.size === 'number' ? after.size : 0,
    ...(before === undefined ? { created: true } : {}),
  }
}
