/**
 * The HTTP vocabulary the diff routes speak.
 *
 * The Host half runs inside the DSH process with no resolvable third-party
 * dependencies of its own — the plugin is linked into a profile whose
 * `node_modules` are not on this package's resolution path — so everything here
 * is built on `node:http` shapes plus Node's globals.
 *
 * Discipline (borrowed from the shipped route families):
 *
 * - one JSON writer, one error writer, so no route invents its own envelope;
 * - no exception escapes a handler (the webserver answers a throwing handler
 *   `400` with an empty body, which tells the client nothing);
 * - every route is fenced to this machine, reads included: the listing exposes
 *   the names of the user's changed files and their content is served
 *   alongside.
 */

/** Largest accepted request body (64 KiB — the write route sends an id and a turn). */
const MAX_BODY_BYTES = 64 * 1024

/** A failure with a status and a machine-readable code the client renders. */
export class DiffError extends Error {
  /**
   * @param code - stable failure code, e.g. `diff/not-a-repository`.
   * @param message - message for the log and the wire.
   * @param status - HTTP status.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DiffError'
    this.code = code
    this.status = status
  }

  /** The JSON body this failure is written as. */
  get payload() {
    return { ok: false, error: { code: this.code, message: this.message } }
  }
}

/**
 * A logger that never throws when the host's logger shape differs.
 *
 * Logging runs inside request handling, so an incompatible logger must cost the
 * message, never the response.
 *
 * @param ctx - host context.
 * @returns the `{ info, warn }` sink the routes and libraries use.
 */
export function createLogger(ctx) {
  const emit = (level, message) => {
    try {
      ctx?.logger?.[level]?.(message)
    } catch {
      /* logging must never break a request */
    }
  }
  return {
    info: message => emit('info', message),
    warn: message => emit('warn', message),
  }
}

/**
 * Write one JSON response.
 *
 * @param res - server response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
export function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * Write the refusal one failure stands for.
 *
 * @param res - server response.
 * @param error - the thrown value.
 * @param logger - `{ warn }` sink.
 * @returns the status written.
 */
export function writeError(res, error, logger) {
  if (error instanceof DiffError) {
    writeJson(res, error.status, error.payload)
    return error.status
  }
  logger?.warn?.(`dsh-diff-view: handler failed: ${error?.stack ?? String(error)}`)
  writeJson(res, 500, {
    ok: false,
    error: { code: 'diff/failed', message: 'the diff view plugin failed to answer this request' },
  })
  return 500
}

/**
 * Read and parse a bounded JSON request body.
 *
 * The plugin's one write route takes a Session id and an optional turn number,
 * so the cap is small on purpose: a malformed or oversized body must cost a
 * rejected request, never memory.
 *
 * @param req - incoming request.
 * @returns the parsed object; `{}` for an empty body.
 * @throws {DiffError} `diff/bad-body` when the body is oversized or not a JSON object.
 */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      throw new DiffError('diff/bad-body', 'the request body is too large', 413)
    }
    chunks.push(chunk)
  }
  if (total === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new DiffError('diff/bad-body', 'the request body is not valid JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DiffError('diff/bad-body', 'the request body must be a JSON object', 400)
  }
  return parsed
}

/**
 * Whether a request originates on the loopback interface.
 *
 * @param req - incoming request.
 * @returns true when the peer is this machine.
 */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
}

/**
 * Decide whether a peer may reach these routes.
 *
 * Loopback is admitted outright — that peer is the machine's own user and the
 * path the in-app panel uses. Anything else is decided by the shell's own fence
 * (`ctx.connection`); a missing service leaves the route closed rather than
 * trusting a network peer on the strength of a missing dependency.
 *
 * @param ctx - host Context.
 * @param req - incoming request.
 * @returns the rejection status, or `undefined` when the peer is admitted.
 */
export function peerRejection(ctx, req) {
  if (isLoopback(req)) return undefined
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers: req.headers ?? {} })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      /* an incompatible fence shape must not open the route */
    }
  }
  return 403
}

/**
 * The query string of a request as a plain object.
 *
 * @param req - incoming request.
 * @returns one string per parameter; a repeated parameter keeps its first value.
 */
export function queryOf(req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const out = {}
  for (const [key, value] of url.searchParams) {
    if (!(key in out)) out[key] = value
  }
  return out
}

/**
 * Read one required string parameter.
 *
 * @param source - the query object.
 * @param name - the parameter's name.
 * @returns the trimmed value.
 * @throws {DiffError} `diff/bad-request` when it is absent or empty.
 */
export function requiredString(source, name) {
  const value = source?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DiffError('diff/bad-request', `"${name}" is required`, 400)
  }
  return value.trim()
}
