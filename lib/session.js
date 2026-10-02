/**
 * Session lookups the diff routes need: one Session's working directory, and
 * the per-turn change summaries the Host retains for it.
 *
 * Both are read through optional `ctx.get` lookups rather than declared
 * injections, because neither is required for the git scope to work. A profile
 * without the change recorder still gets a working diff view; it just gets a
 * clear `unavailable` answer for the session scope instead of a plugin that
 * refuses to load.
 *
 * @module dsh-diff-view/lib/session
 */
import { DiffError } from './http.js'

/**
 * Resolve one Session's working directory.
 *
 * `sessionQuery` is preferred because it answers for live and persisted
 * Sessions alike without materializing anything; the live-agent registry is the
 * fallback for a Host whose query service is composed differently. A directory
 * the request itself names is never trusted — that is what keeps this plugin
 * from becoming an arbitrary-directory reader.
 *
 * @param ctx - host Context.
 * @param sessionId - the Session to look up.
 * @returns the absolute working directory.
 * @throws {DiffError} `diff/unknown-session` when the Session or its cwd is unknown.
 */
export async function resolveSessionCwd(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && query !== null && typeof query.readSession === 'function') {
    let snapshot
    try {
      snapshot = await query.readSession(sessionId)
    } catch (error) {
      throw new DiffError('diff/unknown-session', `cannot read session "${sessionId}": ${String(error?.message ?? error)}`, 404)
    }
    const cwd = snapshot?.session?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    throw new DiffError('diff/unknown-session', `session "${sessionId}" records no working directory`, 404)
  }

  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
    const agent = sessions.get(sessionId)
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  throw new DiffError('diff/unknown-session', `session "${sessionId}" is not available on this Host`, 404)
}

/**
 * The change recorder, when this Host composes one.
 *
 * @param ctx - host Context.
 * @returns the service, or undefined.
 */
export function changeRecorder(ctx) {
  const service = ctx.get('workspaceChanges')
  if (service === undefined || service === null) return undefined
  if (typeof service.summary !== 'function' || typeof service.diff !== 'function') return undefined
  return service
}

/**
 * Read one Session's raw event log.
 *
 * @param ctx - host Context.
 * @param sessionId - the Session to read.
 * @returns the snapshot's events, in ascending sequence order.
 * @throws {DiffError} `diff/unavailable` when this Host has no query service.
 * @throws {DiffError} `diff/unknown-session` when the Session cannot be read.
 */
export async function readSessionEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || query === null || typeof query.readSession !== 'function') {
    throw new DiffError('diff/unavailable', 'this Host cannot read the session log, so session changes are unavailable', 503)
  }
  let snapshot
  try {
    snapshot = await query.readSession(sessionId)
  } catch (error) {
    throw new DiffError('diff/unknown-session', `cannot read session "${sessionId}": ${String(error?.message ?? error)}`, 404)
  }
  return { events: Array.isArray(snapshot?.events) ? snapshot.events : [], cwd: snapshot?.session?.cwd }
}

/**
 * Every change summary the Session's log announced, newest first.
 *
 * The log is the record of which turns changed files; the summaries themselves
 * are Host memory, so this walks the announced sequences and keeps the ones the
 * recorder still holds. A turn whose summary was replaced by a later one for the
 * same turn is invisible here by construction: the recorder keeps the newest per
 * turn, and this asks it, rather than the log, for the content.
 *
 * @param service - the change recorder.
 * @param sessionId - the Session to read.
 * @param events - the Session's raw events.
 * @returns one entry per turn that announced changes, in descending turn order.
 */
export function announcedSummaries(service, sessionId, events) {
  const turns = []
  const seen = new Set()
  for (const event of events) {
    if (event?.type !== 'workspace/changes') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || seen.has(turn)) continue
    seen.add(turn)
    const summary = service.summary(sessionId, event.seq)
    if (summary === undefined) continue
    turns.push({ turn, seq: event.seq, summary })
  }
  turns.sort((left, right) => right.turn - left.turn)
  return turns
}

/** Wire tool names whose arguments name the one file they mutate. */
const MUTATING_TOOLS = new Set(['write', 'edit'])

/**
 * The files the Session's file tools touched, read straight from the log.
 *
 * This is the scope's second source, and it exists because the first one can be
 * empty: the change recorder summarizes a turn only when it can (a turn with no
 * settled tool result records nothing, and this Host drops the summaries of
 * Sessions that are no longer live). The log, by contrast, always holds the
 * calls, so a reader still gets "these are the files this Session changed, in
 * this turn" — just without a stored before/after comparison.
 *
 * @param events - the Session's raw events.
 * @returns `{ path, turn, added }` per touched path, one entry per path.
 */
export function touchedFiles(events) {
  const byPath = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string' || !MUTATING_TOOLS.has(name)) continue
    const path = pathOfToolArguments(event.data?.arguments)
    if (path === undefined) continue
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : 0
    const existing = byPath.get(path)
    if (existing === undefined) {
      byPath.set(path, { path, turn, added: name === 'write' })
      continue
    }
    if (turn >= existing.turn) existing.turn = turn
    existing.added = existing.added && name === 'write'
  }
  return [...byPath.values()]
}

/**
 * The file one file-tool call names.
 *
 * Tool arguments travel as a JSON string on the wire, and a call whose arguments
 * are still streaming (or malformed) has none: both cases answer undefined
 * rather than throwing, because one unreadable call must not cost the listing.
 *
 * @param raw - the call's argument text.
 * @returns the path, or undefined.
 */
function pathOfToolArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const candidates = [parsed.file_path, parsed.path, parsed.filePath]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * The changed files of one Session, folded across every turn that reported any.
 *
 * A path changed in several turns appears once, carrying the newest turn that
 * changed it and the list of every turn that did — that is the fact a reviewer
 * needs ("this file moved three times, here is the latest"), and it keeps the
 * list stable while the Session is still running.
 *
 * @param turns - as returned by {@link announcedSummaries}.
 * @returns `{ files, cwd, turns }`.
 */
export function foldChangedFiles(turns) {
  const byPath = new Map()
  for (const { turn, seq, summary } of turns) {
    const files = Array.isArray(summary.files) ? summary.files : []
    files.forEach((file, index) => {
      const existing = byPath.get(file.path)
      const source = { turn, seq, index }
      if (existing === undefined) {
        byPath.set(file.path, { file, source, sources: [source] })
        return
      }
      existing.sources.push(source)
      if (turn > existing.source.turn) {
        existing.file = file
        existing.source = source
      }
    })
  }
  const files = [...byPath.values()]
    .map(entry => ({
      path: entry.file.path,
      display: entry.file.display ?? entry.file.path,
      status: entry.file.binary === true ? 'binary' : entry.file.oversized === true ? 'oversized' : 'modified',
      added: typeof entry.file.added === 'number' ? entry.file.added : 0,
      deleted: typeof entry.file.deleted === 'number' ? entry.file.deleted : 0,
      ...(entry.file.binary === true ? { binary: true } : {}),
      ...(entry.file.oversized === true ? { oversized: true } : {}),
      changedTurns: entry.sources.map(source => source.turn).sort((left, right) => left - right),
      at: { turn: entry.source.turn, seq: entry.source.seq, index: entry.source.index },
    }))
    .sort((left, right) => comparePaths(left.display, right.display))
  return {
    files,
    cwd: turns.find(entry => typeof entry.summary.cwd === 'string')?.summary.cwd,
    turns: turns.map(entry => entry.turn),
  }
}

/**
 * The latest turn summary that lists one path.
 *
 * @param turns - as returned by {@link announcedSummaries}.
 * @param path - the path to find.
 * @returns `{ turn, seq, index }`, or undefined when no summary lists the path.
 */
export function locateChangedFile(turns, path) {
  for (const { turn, seq, summary } of turns) {
    const files = Array.isArray(summary.files) ? summary.files : []
    const index = files.findIndex(file => file.path === path)
    if (index !== -1) return { turn, seq, index }
  }
  return undefined
}

/**
 * Order two display paths the way a file list reads: directories first, then
 * natural order within a depth, so `a/2` precedes `a/10`.
 *
 * @param left - first display path.
 * @param right - second display path.
 * @returns a comparator result.
 */
export function comparePaths(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
