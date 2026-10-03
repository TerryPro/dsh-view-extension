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

/** How long one Session's decoded event log stays usable (milliseconds). */
const SESSION_LOG_TTL_MS = 1_000
/** Sessions whose decoded log may be retained at once. */
const SESSION_LOG_CACHE_MAX = 4

/**
 * A caller-owned cache for decoded Session logs.
 *
 * The window and the bound are both small on purpose: the point is to collapse
 * the repeated reads inside one interaction, not to remember the log.
 *
 * @returns `{ entries: Map }` to hand to {@link readSessionEvents}.
 */
export function createLogCache() {
  return { entries: new Map() }
}

/** How many derived statuses one mount remembers. */
const STATUS_CACHE_MAX = 4_000
/** How many status derivations one request is willing to pay for. */
const STATUS_ENRICH_LIMIT = 400

/**
 * A caller-owned cache of per-file change statuses.
 *
 * A status is not in the recorder's summary — `WorkspaceChangedFile` carries
 * counts and a binary flag and nothing about ADDED versus MODIFIED versus
 * DELETED. The only authority is the comparison the recorder serves, whose
 * `before`/`after` say which sides exist; deriving it therefore costs one
 * recorder call per file-turn. Records are immutable once written for a
 * sequence, so a derived status is worth remembering for as long as the mount
 * lives (see {@link enrichStatuses}).
 *
 * @returns `{ entries: Map }`.
 */
export function createStatusCache() {
  return { entries: new Map() }
}

/**
 * Derive the status of every listed file-turn from the recorder's comparison.
 *
 * Attaches a `Map<index, status>` to each turn it can resolve, which
 * {@link foldChangedFiles} then reads. Bounded twice over: each request pays for
 * at most {@link STATUS_ENRICH_LIMIT} derivations, and the cache keeps at most
 * {@link STATUS_CACHE_MAX}. A derivation that fails or is aborted leaves that
 * file as `modified` for THIS answer without caching a guess.
 *
 * @param service - the change recorder.
 * @param sessionId - the Session whose turns these are.
 * @param turns - as returned by {@link announcedSummaries}; mutated in place.
 * @param cache - the mount's status cache.
 * @param options - `{ signal }`.
 * @returns the number of derivations actually performed (for tests and logs).
 */
export async function enrichStatuses(service, sessionId, turns, cache, options = {}) {
  let derived = 0
  for (const turn of turns) {
    const files = Array.isArray(turn.summary.files) ? turn.summary.files : []
    const statuses = new Map()
    for (let index = 0; index < files.length; index += 1) {
      const facts = fileFacts(files[index])
      if (facts.binary === true || facts.oversized === true) {
        statuses.set(index, facts.status)
        continue
      }
      const key = `${sessionId}:${turn.seq}:${index}`
      const remembered = cache.entries.get(key)
      if (remembered !== undefined) {
        statuses.set(index, remembered)
        continue
      }
      if (derived >= STATUS_ENRICH_LIMIT) {
        statuses.set(index, 'modified')
        continue
      }
      let status = 'modified'
      let certain = false
      try {
        const diff = await service.diff(sessionId, turn.seq, index, options.signal)
        if (diff !== undefined) {
          status = statusOfComparison(diff)
          certain = true
        }
      } catch {
        /* a comparison that cannot be read leaves this file's status unknown */
      }
      derived += 1
      if (certain) {
        cache.entries.set(key, status)
        while (cache.entries.size > STATUS_CACHE_MAX) {
          const oldest = cache.entries.keys().next().value
          if (oldest === undefined) break
          cache.entries.delete(oldest)
        }
      }
      statuses.set(index, status)
    }
    turn.statuses = statuses
  }
  return derived
}

/**
 * What one served comparison says about the file's change.
 *
 * `before` and `after` are the recorder's own reading of which sides exist, so
 * they are the definition of the three states git would print as `A`, `M`, and
 * `D`. A rename cannot be told apart from a modification here and is reported as
 * one.
 *
 * @param diff - a served `WorkspaceFileDiff`.
 * @returns the status.
 */
export function statusOfComparison(diff) {
  if (diff === undefined || diff === null) return 'modified'
  if (diff.kind === 'binary') return 'binary'
  if (diff.kind === 'oversized') return 'oversized'
  if (diff.before === false && diff.after !== false) return 'added'
  if (diff.before !== false && diff.after === false) return 'deleted'
  return 'modified'
}

/**
 * Resolve one Session's working directory.
 *
 * Order matters, and it is about cost, not preference: the live-session store
 * answers from memory in microseconds, while `sessionQuery.readSession` reads
 * and replays the Session's whole log — hundreds of milliseconds once a Session
 * has a few thousand events, paid on EVERY diff request. The log is therefore
 * the last resort (a Session this Host no longer holds live), never the first.
 *
 * A directory the request itself names is never trusted: that is what keeps this
 * plugin from becoming an arbitrary-directory reader.
 *
 * @param ctx - host Context.
 * @param sessionId - the Session to look up.
 * @returns the absolute working directory.
 * @throws {DiffError} `diff/unknown-session` when the Session or its cwd is unknown.
 */
export async function resolveSessionCwd(ctx, sessionId) {
  const live = liveSession(ctx, sessionId)
  if (live !== undefined) return live

  const agents = ctx.get('agents')
  const agent = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  const agentCwd = agent?.session?.header?.cwd
  if (typeof agentCwd === 'string' && agentCwd !== '') return agentCwd

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
  throw new DiffError('diff/unknown-session', `session "${sessionId}" is not available on this Host`, 404)
}

/**
 * The working directory of a Session this Host still holds live, if any.
 *
 * @param ctx - host Context.
 * @param sessionId - the Session to look up.
 * @returns the absolute directory, or undefined.
 */
function liveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  const session = sessions.get(sessionId)
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
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
 * The read is memoized for a moment because the same log is asked for several
 * times in a burst — a scope switch and the file read that follows it, or two
 * panel mounts in the same second — and each miss costs a full log replay. The
 * window is deliberately tiny: a change list one second stale is a change list,
 * while one a minute stale is a lie.
 *
 * @param ctx - host Context.
 * @param sessionId - the Session to read.
 * @param cache - the caller-owned cache (`{ entries: Map }`), so it dies with the mount.
 * @returns `{ events, cwd }`.
 * @throws {DiffError} `diff/unavailable` when this Host has no query service.
 * @throws {DiffError} `diff/unknown-session` when the Session cannot be read.
 */
export async function readSessionEvents(ctx, sessionId, cache) {
  const now = Date.now()
  const hit = cache?.entries.get(sessionId)
  if (hit !== undefined && now - hit.at < SESSION_LOG_TTL_MS) return hit.value

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
  const value = {
    events: Array.isArray(snapshot?.events) ? snapshot.events : [],
    cwd: snapshot?.session?.cwd,
  }
  if (cache !== undefined) {
    cache.entries.set(sessionId, { at: now, value })
    // Bounded: one entry per Session, and only the most recent few Sessions.
    while (cache.entries.size > SESSION_LOG_CACHE_MAX) {
      const oldest = cache.entries.keys().next().value
      if (oldest === undefined) break
      cache.entries.delete(oldest)
    }
  }
  return value
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
 * How one listed file reads: the status letter and the counts a row shows.
 *
 * @param file - one entry of a turn summary's `files`.
 * @returns `{ status, added, deleted, binary, oversized }`.
 */
export function fileFacts(file) {
  const binary = file.binary === true
  const oversized = file.oversized === true
  return {
    status: binary ? 'binary' : oversized ? 'oversized' : 'modified',
    added: !binary && typeof file.added === 'number' ? file.added : 0,
    deleted: !binary && typeof file.deleted === 'number' ? file.deleted : 0,
    ...(binary ? { binary: true } : {}),
    ...(oversized ? { oversized: true } : {}),
  }
}

/**
 * The changed files of one Session, folded across every turn that reported any.
 *
 * A path changed in several turns appears once, carrying the newest turn that
 * changed it AND every turn that did with that turn's own coordinate, counts and
 * status. The newest is what the aggregate view shows ("this file moved three
 * times, here is the latest"); the full list is what makes both a per-turn view
 * and a state-at-turn view possible without a second read, and it keeps the list
 * stable while the Session runs.
 *
 * A turn's statuses come from {@link enrichStatuses} when the caller ran it;
 * without them a source is `modified`, which is the one status a summary's own
 * numbers cannot contradict.
 *
 * @param turns - as returned by {@link announcedSummaries}, optionally enriched.
 * @returns `{ files, cwd, turns }`.
 */
export function foldChangedFiles(turns) {
  const byPath = new Map()
  for (const turn of turns) {
    const files = Array.isArray(turn.summary.files) ? turn.summary.files : []
    files.forEach((file, index) => {
      const existing = byPath.get(file.path)
      const status = turn.statuses?.get(index) ?? fileFacts(file).status
      const source = { turn: turn.turn, seq: turn.seq, index, file, status }
      if (existing === undefined) {
        byPath.set(file.path, { file, source, sources: [source] })
        return
      }
      existing.sources.push(source)
      if (turn.turn > existing.source.turn) {
        existing.file = file
        existing.source = source
      }
    })
  }
  const files = [...byPath.values()]
    .map((entry) => {
      const latest = fileFacts(entry.file)
      const status = entry.source.status ?? latest.status
      const sources = entry.sources
        .slice()
        .sort((left, right) => left.turn - right.turn)
        .map(source => ({
          turn: source.turn,
          seq: source.seq,
          index: source.index,
          ...fileFacts(source.file),
          status: source.status ?? 'modified',
        }))
      return {
        path: entry.file.path,
        display: entry.file.display ?? entry.file.path,
        ...latest,
        /** The newest turn's status — what the aggregate view's letter shows. */
        status,
        changedTurns: sources.map(source => source.turn),
        /** The newest turn that changed this path — the aggregate view's comparison. */
        at: { turn: entry.source.turn, seq: entry.source.seq, index: entry.source.index },
        /** Every turn that changed it, oldest first, each with its own counts and status. */
        sources,
      }
    })
    .sort((left, right) => comparePaths(left.display, right.display))
  return {
    files,
    cwd: turns.find(entry => typeof entry.summary.cwd === 'string')?.summary.cwd,
    /* Oldest first, like the turn browser's own list: a session is read from its
     * beginning, and a reversed strip makes the reader translate turn numbers
     * before they can pick one. */
    turns: turns.map(entry => entry.turn).sort((left, right) => left - right),
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
