/**
 * dsh-diff-view — host half.
 *
 * Serves one HTTP route family (`/api/dsh-diff/*`) that answers the two
 * questions a diff view asks, plus the one action that makes the answers
 * durable:
 *
 * | Route | Verb | Answer |
 * |---|---|---|
 * | `files` | GET | the changed files of one scope, with status and line counts |
 * | `file` | GET | one file's comparison as structured hunks |
 * | `commit` | POST | commit the Session's work tree (the only write path) |
 *
 * ## Why a host half is needed at all
 *
 * The browser cannot run `git`, and it cannot read the Session's working
 * directory: `workspaceFiles` (the shell's own Remote capability) is scoped to
 * exactly one Session root and refuses everything else. Both diff scopes here
 * need something the page does not own:
 *
 *   - **git** — the working tree of the Session's `cwd`: `git status`,
 *     `git diff HEAD`, and the file bytes behind an untracked path;
 *   - **session** — the per-turn change summaries the Host retains for a live
 *     Session (`ctx.workspaceChanges`), which live in Host memory and are
 *     reachable from no browser at all.
 *
 * So the Host owns the data plane and the browser owns presentation. That split
 * is also why this plugin needs no Remote namespace: every read is computed for
 * the request and dropped, and the only thing it ever writes is a commit the
 * user asked for (see `lib/commit.js` for what that deliberately excludes).
 *
 * ## Session addressing
 *
 * A request names a Session, never a path. The working directory is resolved
 * from the Session's own header on the Host (`sessionQuery` first, then the
 * live-agent registry), so a page cannot ask this plugin to read — or commit —
 * an arbitrary directory: the worst a crafted request can do is name a Session
 * the user already has open.
 *
 * @module dsh-diff-view
 */
import { checkpointFor, makeRoutes, ROUTES } from './lib/routes.js'
import { commitMessage, createAutoCommit } from './lib/commit.js'
import { createLogger } from './lib/http.js'

/** Stable cordis plugin name (must match the patch row). */
export const name = 'dsh-diff-view'

/**
 * Services required before the routes can mount.
 *
 * `webServer` is the only hard dependency: the Session lookup and the change
 * recorder are read through optional `ctx.get` lookups so that a profile
 * without the change recorder still gets the git scope (and a clear
 * `unavailable` answer for the session scope) instead of a plugin that refuses
 * to load.
 */
export const inject = ['webServer']

/**
 * Mount the diff routes, and — only when asked — the automatic checkpoint.
 *
 * `config.autoCommit` defaults to false and stays false: committing the user's
 * work tree is a decision about their history, so it happens when they press
 * the button or when they say so in the profile, never as a surprise on load.
 *
 * @param ctx - host plugin context carrying `webServer`.
 * @param config - raw plugin config; `null` and `undefined` are both accepted.
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx)
  const settings = config ?? {}
  const routes = makeRoutes({ ctx, config: settings, logger })
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  logger.info(`dsh-diff-view: mounted ${routes.length} routes under ${ROUTES.files.replace(/\/files$/u, '/*')}`)

  if (settings.autoCommit !== true) return
  const auto = createAutoCommit({
    logger,
    message: ({ turn, session }) => commitMessage(settings.commitMessage, { turn, session }),
    commit: (cwd, message) => checkpointFor(ctx, { cwd, message }),
  })
  ctx.effect(() => ctx.on('session/event', (session, event) => auto.onEvent(session, event)))
  logger.info('dsh-diff-view: automatic checkpoint is ON for finished top-level turns (subagent turns excluded)')
}
