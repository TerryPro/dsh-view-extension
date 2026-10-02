/**
 * dsh-diff-view — host half.
 *
 * Serves one HTTP route family (`/api/dsh-diff/*`) that answers the two
 * questions a diff view asks:
 *
 * | Route | Verb | Answer |
 * |---|---|---|
 * | `files` | GET | the changed files of one scope, with status and line counts |
 * | `file` | GET | one file's comparison as structured hunks |
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
 * is also why this plugin needs no Remote namespace and no persistence: every
 * answer is computed for the request and dropped.
 *
 * ## Session addressing
 *
 * A request names a Session, never a path. The working directory is resolved
 * from the Session's own header on the Host (`sessionQuery` first, then the
 * live-agent registry), so a page cannot ask this plugin to read an arbitrary
 * directory — the worst a crafted request can do is name a Session the user
 * already has open.
 *
 * @module dsh-diff-view
 */
import { makeRoutes, ROUTES } from './lib/routes.js'
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
 * Mount the diff routes.
 *
 * @param ctx - host plugin context carrying `webServer`.
 * @param config - raw plugin config; `null` and `undefined` are both accepted.
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx)
  const routes = makeRoutes({ ctx, config: config ?? {}, logger })
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  logger.info(`dsh-diff-view: mounted ${routes.length} routes under ${ROUTES.files.replace(/\/files$/u, '/*')}`)
}
