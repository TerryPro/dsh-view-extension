/**
 * Committing the work tree: the plugin's ONE write path, and the only reason it
 * ever stages or commits anything.
 *
 * ## Why it exists
 *
 * The Host's per-turn change records live in memory and are deleted when their
 * Session is disposed (the recorder clears its map and removes its private
 * object store), so a restart loses every comparison it had kept. Git is the one
 * store that is already there, already durable, and already understood by both
 * scopes of this plugin. A commit at the end of a turn therefore buys three
 * things at once:
 *
 *   - the turn's work survives a restart, because it is in the history;
 *   - the **working-tree** scope becomes "what changed since the last
 *     checkpoint" — the current turn, exactly;
 *   - `git restore`, `git diff HEAD~1`, `git log` and the shell's own cards all
 *     keep working, because this is an ordinary commit and nothing else.
 *
 * ## What it deliberately does NOT do
 *
 * It never pushes, never touches a remote, never rewrites or amends history, and
 * never runs when the work tree is clean. It runs the repository's own hooks:
 * a repository that lints or tests on commit is making a claim about its
 * history, and a checkpoint is not entitled to bypass it. A hook that refuses
 * the commit is reported, not worked around.
 *
 * @module dsh-diff-view/lib/commit
 */
import { DiffError } from './http.js'
import { runGit } from './git.js'

/** Default commit message; `{turn}` and `{session}` are substituted. */
export const DEFAULT_MESSAGE = 'dsh-diff-view: checkpoint'

/**
 * Whether this Session's turns are the ones a checkpoint describes.
 *
 * A subagent shares its parent's working directory and runs INSIDE the parent's
 * turn, so committing at its turn end would split the parent's work across two
 * commits. The recorder draws the same line, which is why the rule is copied
 * rather than invented.
 *
 * @param session - a live Session.
 * @returns the working directory, or undefined when this Session is not eligible.
 */
export function eligibleCwd(session) {
  const header = session?.header
  if (header === undefined || header === null) return undefined
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined
  return typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
}

/**
 * Render the commit message one checkpoint carries.
 *
 * @param template - the configured template.
 * @param values - `{ turn, session }`.
 * @returns the message, trimmed and never empty.
 */
export function commitMessage(template, values) {
  const source = typeof template === 'string' && template.trim() !== '' ? template : DEFAULT_MESSAGE
  const rendered = source
    .replace(/\{turn\}/gu, values.turn === undefined ? '?' : String(values.turn))
    .replace(/\{session\}/gu, values.session === undefined ? '?' : String(values.session))
  return rendered.trim() === '' ? DEFAULT_MESSAGE : rendered.trim()
}

/**
 * Stage the whole work tree and commit it.
 *
 * @param git - `{ subprocess, executable }`.
 * @param options - `{ root, message, signal }`.
 * @returns `{ committed, reason?, revision? }`; a clean tree is a result, not a failure.
 * @throws {DiffError} `diff/git-failed` when staging fails.
 * @throws {DiffError} `diff/commit-failed` when the commit itself is refused.
 */
export async function checkpoint(git, options) {
  const status = await runGit(git.subprocess, git.executable, ['status', '--porcelain=v2', '-z', '-uall'], { cwd: options.root, signal: options.signal })
  if (status.exitCode !== 0) {
    throw new DiffError('diff/git-failed', `git status failed: ${status.stderr.trim() || 'no diagnostic'}`, 500)
  }
  if (status.stdout === '') return { committed: false, reason: 'clean' }

  const staged = await runGit(git.subprocess, git.executable, ['add', '--all'], { cwd: options.root, signal: options.signal })
  if (staged.exitCode !== 0) {
    throw new DiffError('diff/git-failed', `git add failed: ${staged.stderr.trim() || 'no diagnostic'}`, 500)
  }

  const committed = await runGit(git.subprocess, git.executable, ['commit', '--quiet', '-m', options.message], { cwd: options.root, signal: options.signal })
  if (committed.exitCode !== 0) {
    throw new DiffError('diff/commit-failed', committed.stderr.trim() || committed.stdout.trim() || 'git commit was refused', 500)
  }

  const head = await runGit(git.subprocess, git.executable, ['rev-parse', '--short', 'HEAD'], { cwd: options.root, signal: options.signal })
  return { committed: true, revision: head.exitCode === 0 ? head.stdout.trim() : undefined }
}

/**
 * The opt-in automatic checkpoint: one commit per finished top-level turn.
 *
 * Commits are serialized through one chain, because two `git add` runs against
 * one index would fight over `index.lock`, and a failure is logged and dropped
 * rather than retried into the next turn. `resolveGit`/`locateRepository` are
 * the caller's business: this only decides WHEN to call {@link checkpoint}.
 *
 * @param options - `{ ctx, logger, commit, message, isEligible? }`, where
 *   `commit(cwd, message)` is the caller's staged-and-committed operation.
 * @returns the listener to register, plus its chain for tests to await.
 */
export function createAutoCommit(options) {
  const { logger, commit, message } = options
  const isEligible = options.isEligible ?? eligibleCwd
  let chain = Promise.resolve()
  /** Turns already handled, so a repeated event cannot commit twice. */
  const done = new Set()

  /**
   * Handle one Session event.
   * @param session - the Session that appended it.
   * @param event - the appended event.
   */
  function onEvent(session, event) {
    if (event?.type !== 'turn/end') return
    const cwd = isEligible(session)
    if (cwd === undefined) return
    const turn = event.data?.turn
    const key = `${session.id}:${turn}`
    if (turn === undefined || done.has(key)) return
    done.add(key)
    chain = chain
      .then(async () => {
        const text = message({ turn, session: session.id })
        const result = await commit(cwd, text)
        if (result.committed === true) {
          logger.info(`dsh-diff-view: checkpointed turn ${String(turn)} of ${session.id} as ${String(result.revision)} ("${text}")`)
        } else {
          logger.info(`dsh-diff-view: turn ${String(turn)} of ${session.id} left nothing to commit`)
        }
      })
      .catch((error) => {
        logger.warn(`dsh-diff-view: checkpoint for turn ${String(turn)} of ${session.id} failed: ${String(error?.message ?? error)}`)
      })
  }

  return {
    onEvent,
    /** Await the commits scheduled so far (tests and orderly shutdown). */
    settled: () => chain,
  }
}
