/**
 * The conversation half of the per-turn view: what was asked in a turn, and
 * what the turn finally answered.
 *
 * Both live in the Session log, which is durable — unlike the change records,
 * which the Host keeps in memory and drops when the Session is disposed. That
 * asymmetry is the reason this module exists at all: a turn's PROMPT and ANSWER
 * survive a restart, so a per-turn browser can still show them for every turn of
 * a Session that was recorded days ago, while its file comparisons are gone.
 *
 * ## How a turn is recognized
 *
 * `turn/start` and `turn/end` carry the turn number; the message events between
 * them do not (`user/message` carries a message, not a turn). So the fold is
 * positional: it walks the log in order and attributes every message to the turn
 * that was open when it arrived. The union with the change records is what the
 * routes serve, because a compacted log can miss the `turn/start` of a turn the
 * recorder still remembers.
 *
 * ## What counts as the answer
 *
 * The LAST assistant text of the turn — a turn may produce several assistant
 * messages (one per step, interleaved with tool calls), and the reader's "最终
 * 应答" is the final one, not the first. A turn whose last assistant message was
 * interrupted mid-stream is marked, because a prefix is not an answer.
 *
 * @module dsh-diff-view/lib/turns
 */

/** Default number of turns served. */
export const TURN_LIMIT = 200
/** Default characters kept per text in a listing. */
export const TURN_PREVIEW_CHARS = 160
/** Default characters kept per text in one turn's detail. */
export const TURN_TEXT_CHARS = 8_000

/**
 * One message's text, from its model-facing content blocks.
 *
 * Reasoning and tool-call blocks are skipped on purpose: the question is what
 * the turn SAID, and a transcript that mixes in the working is harder to read
 * than the working's result.
 *
 * @param content - a message's `content`.
 * @returns the joined text, or `''`.
 */
export function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Clip one text to a bound, saying whether anything was dropped.
 *
 * @param text - the text.
 * @param limit - maximum characters.
 * @returns `{ text, truncated }`.
 */
export function clipText(text, limit) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/**
 * Fold a Session log into one record per turn.
 *
 * @param events - the decoded Session events, in order.
 * @param options - `{ preview }` characters kept per text.
 * @returns `{ turns, order }`: a `Map<turn, record>` plus its turn numbers in log order.
 */
export function foldConversation(events, options = {}) {
  const preview = options.preview ?? TURN_PREVIEW_CHARS
  const turns = new Map()
  let open

  const ensure = (turn) => {
    let record = turns.get(turn)
    if (record === undefined) {
      record = { turn, seq: undefined, time: undefined, prompt: null, answer: null, open: true, turns: [] }
      turns.set(turn, record)
    }
    return record
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn !== 'number') continue
      open = turn
      const record = ensure(turn)
      record.open = true
      if (record.seq === undefined) record.seq = event.seq
      if (record.time === undefined) record.time = event.time
      continue
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (typeof turn === 'number') {
        ensure(turn).open = false
        if (open === turn) open = undefined
      }
      continue
    }
    if (open === undefined) continue
    const record = ensure(open)
    if (event.type === 'user/message') {
      const text = textOfBlocks(event.data?.content)
      if (text === '') continue
      const human = event.data?.source?.kind === 'user'
      /* The prompt a person typed is the turn's question. Injected context
       * (skill bodies, file-change notices, goal rounds) is real log content and
       * is kept as a fallback, because a turn that only continues a goal still
       * asked SOMETHING. */
      if (record.prompt === null || (human && record.prompt.human !== true)) {
        record.prompt = { ...clipText(text, preview), human, seq: event.seq, time: event.time, source: event.data?.source?.kind }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOfBlocks(event.data?.message?.content ?? event.data?.content)
      if (text === '') continue
      record.answer = {
        ...clipText(text, preview),
        seq: event.seq,
        time: event.time,
        step: event.data?.step,
        interrupted: event.data?.interrupted === true,
      }
    }
  }

  return { turns, order: [...turns.keys()] }
}

/**
 * The turn numbers one Session's view lists, newest first.
 *
 * The union of what the log describes and what the change recorder kept: a
 * compacted log may have lost a turn's `turn/start` while its changed files are
 * still recorded, and a turn can change nothing at all.
 *
 * @param order - turn numbers in log order.
 * @param changeTurns - turn numbers the change records mention.
 * @param limit - maximum turns served.
 * @returns turn numbers, newest first.
 */
export function turnNumbers(order, changeTurns, limit = TURN_LIMIT) {
  const seen = new Set(order)
  for (const turn of changeTurns) seen.add(turn)
  return [...seen].sort((left, right) => right - left).slice(0, limit)
}
