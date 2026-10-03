/**
 * dsh-diff-view — browser half.
 *
 * One `conversation.view` tab: the changed files on the left, the selected
 * file's comparison on the right. It sits beside Chat and Trajectory as a third
 * view of the same Session, which is where a review belongs — the trajectory
 * says what the agent did, this says what the working tree now looks like.
 *
 * ## Why the shape is a view tab and not a panel of its own
 *
 * The trajectory's own area is the center column at full width; anything the
 * user calls "the diff view, next to the trajectory" is a sibling of the
 * trajectory inside that area, not a new column. The shell already has exactly
 * that seat — `conversation.view`, the list rendered one entry at a time by
 * `DefaultConversationViews` — so this plugin adds an entry to it and keeps the
 * shell's tab strip, its session scoping, and its lifecycle. No DOM surgery, no
 * second scroll container, and unloading removes the tab and everything it owns.
 *
 * ## Why the data comes from the plugin's own host routes
 *
 * A browser cannot run `git`, and the Session's per-turn change summaries live
 * in Host memory. Both scopes are therefore computed Host-side and fetched as
 * JSON from `/api/dsh-diff/*` (see the host half). The page keeps no cache
 * across mounts on purpose: a diff is a snapshot of a moving tree, and a stale
 * one is worse than a spinner.
 *
 * ## What it deliberately does not do
 *
 * No syntax highlighting: the shell's highlighter is a bundled service this
 * plugin cannot import, and a half-lit diff reads worse than a plain one. No
 * "stage this hunk" write path: this is a reader, and the plugin's routes are
 * read-only for the same reason.
 */

window.__ModuleLoader__.load({
	id: 'dsh-diff-view',

	factory(require) {
		var React = require('react');

		/* ------------------------------------------------------------------ *
		 * Constants
		 * ------------------------------------------------------------------ */

		var NAMESPACE = 'dsh-diff-view';
		/** The changes tab's id in the conversation's roster. */
		var VIEW_ID = 'diff';
		/** The per-turn browser's id: the same data, read as a conversation. */
		var TURNS_ID = 'turns';
		/** How often the turn browser re-reads its list while it is on screen. */
		var TURNS_REFRESH_MS = 8_000;
		/** Its idle cadence: a turn list changes at turn boundaries, not every second. */
		var TURNS_REFRESH_IDLE_MS = 30_000;
		/** How long the reader's activity keeps the faster cadence alive. */
		var TURNS_ACTIVE_MS = 30_000;
		/** How long a silent auto-refresh waits between reads while the reader is active. */
		var AUTO_REFRESH_MS = 4000;
		/** The idle cadence: still fresh, but no longer every few seconds. */
		var AUTO_REFRESH_IDLE_MS = 20000;
		/**
		 * How long the active cadence holds after the reader last did something.
		 *
		 * A diff view is only "live" while someone is working in the tree; once
		 * the reader has been looking at the same picture for half a minute, a
		 * four-second poll is churn, not freshness.
		 */
		var AUTO_REFRESH_ACTIVE_MS = 30000;
		/** Largest number of diff lines drawn for one file. */
		var MAX_RENDERED_LINES = 4000;
		/** Where the wrap preference lives (per browser, like the shell's own). */
		var WRAP_KEY = NAMESPACE + '.wrap';
		/** Where the last scope lives, so reopening the tab lands where it left. */
		var SCOPE_KEY = NAMESPACE + '.scope';
		/** Where the session scope's axis lives (this turn's changes vs the state after it). */
		var MODE_KEY = NAMESPACE + '.mode';

		var FILES_URL = '/api/dsh-diff/files';
		var FILE_URL = '/api/dsh-diff/file';
		var COMMIT_URL = '/api/dsh-diff/commit';
		var TURNS_URL = '/api/dsh-diff/turns';
		var TURN_URL = '/api/dsh-diff/turn';

		var GIT = 'git';
		var SESSION = 'session';
		/** What one turn did: only the files that turn changed, at that turn's own diff. */
		var DELTA_MODE = 'delta';
		/** What exists after a turn: every file changed so far, at its last change up to it. */
		var STATE_MODE = 'state';

		var STRINGS = {
			zh: {
				'view.label': '变更',
				'scope.git': '工作区',
				'scope.session': '本次会话',
				'scope.git.title': 'git 工作区：未提交的全部改动（含未跟踪文件）',
				'scope.session.title': '本次会话：agent 逐轮改动过的文件',
				'action.refresh': '刷新',
				'action.auto': '自动刷新',
				'action.auto.on': '自动刷新：开（每 4 秒）',
				'action.auto.off': '自动刷新：关',
				'action.wrap': '自动换行',
				'action.nowrap': '不换行',
				'action.split': '并排对比',
				'action.unified': '统一视图',
				'action.copy': '复制路径',
				'action.copied': '已复制',
				'filter.placeholder': '筛选文件…',
				'filter.clear': '清除筛选',
				'summary.files': '{count} 个文件',
				'summary.added': '+{count}',
				'summary.deleted': '−{count}',
				'turn.all': '全部轮次',
				'turn.chip': '第 {turn} 轮',
				'turn.label': '按轮次筛选',
				'mode.label': '查看方式',
				'mode.delta': '本轮改动',
				'mode.delta.title': '只看选中的那一轮改了什么',
				'mode.state': '累计状态',
				'mode.state.title': '看截至选中轮次时，工作区里有哪些文件、各是什么状态',
				'turn.lastChange': '最后一次改动：第 {turn} 轮',
				'turn.tag': 'T{turn}',
				'summary.deletedFiles': '{count} 个已删除',
				'commit.action': '记一笔',
				'commit.title': '把当前工作区提交到 git —— 只提交，不推送、不改写历史；工作区干净时不做任何事',
				'commit.confirm': '确认提交？',
				'commit.busy': '正在提交…',
				'commit.done': '已提交 {revision}',
				'commit.clean': '没有需要提交的改动',
				'commit.failed': '提交失败：{detail}',
				'turns.label': '逐轮',
				'turns.ask': '提问',
				'turns.answer': '最终应答',
				'turns.noAsk': '这一轮没有记录到提问',
				'turns.noAnswer': '这一轮还没有应答',
				'turns.truncated': '内容较长，此处只显示前 {count} 字',
				'turns.list.loading': '正在读取轮次…',
				'turns.list.empty': '这个会话还没有轮次记录',
				'turns.turn': '第 {turn} 轮',
				'turns.open': '进行中',
				'turns.files': '本轮改动',
				'turns.fileCount': '{count} 个文件',
				'turns.noFiles': '这一轮没有改动文件',
				'turns.detail.loading': '正在读取这一轮…',
				'turns.label.turn': '轮次',
				'turns.retry': '重试',
				'turns.copy': '复制',
				'turns.copied': '已复制',
				'turns.code': '代码',
				'turns.wrap': '换行',
				'turns.unwrap': '不换行',
				'turns.footnotes': '脚注',
				'time.now': '刚刚',
				'time.minutes': '{n}分钟',
				'time.hours': '{n}小时',
				'time.days': '{n}天',
				'time.months': '{n}个月',
				'time.years': '{n}年',
				'time.ago': '{t}前',
				'list.empty': '当前范围没有改动',
				'list.emptyFiltered': '没有匹配的文件',
				'list.loading': '正在读取改动…',
				'diff.empty': '从左侧选择一个文件查看对比',
				'diff.loading': '正在读取对比…',
				'diff.binary': '二进制文件，无法显示文本对比',
				'diff.norecord': 'Host 没有为这次改动留下前后对比（会话日志记录了这次文件改动，但改动记录器没有生成对比）。可以切到「工作区」查看它现在的差异。',
				'diff.oversized': '文件过大，未生成对比',
				'diff.created': '新增文件',
				'diff.deleted': '删除文件',
				'diff.unchanged': '内容没有变化',
				'diff.truncated': '仅显示前 {count} 行',
				'diff.coarse': '文件过大，已按整文件替换显示',
				'diff.none': '没有可显示的差异内容',
				'notice.notRepo': '当前会话目录不在 git 仓库中，可切换到「本次会话」查看 agent 的改动',
				'notice.noGit': '这台机器上没有找到 git，只能查看「本次会话」的改动',
				'notice.noSession': '本次会话还没有记录到文件改动',
				'status.modified': '修改',
				'status.added': '新增',
				'status.deleted': '删除',
				'status.renamed': '重命名',
				'status.copied': '复制',
				'status.untracked': '未跟踪',
				'status.conflicted': '冲突',
				'status.binary': '二进制',
				'status.oversized': '过大',
				'status.directory': '目录',
				'error.retry': '重试',
				'error.generic': '读取失败',
				'error.unavailable': '此功能在当前 Host 上不可用',
				'error.unknownSession': '找不到这个会话',
				'error.notRepository': '不是 git 仓库',
				'error.noGit': '未找到 git',
				'error.forbidden': '请求被拒绝',
			},
			en: {
				'view.label': 'Changes',
				'scope.git': 'Working tree',
				'scope.session': 'This session',
				'scope.git.title': 'git working tree: every uncommitted change, untracked files included',
				'scope.session.title': 'This session: the files the agent changed, turn by turn',
				'action.refresh': 'Refresh',
				'action.auto': 'Auto refresh',
				'action.auto.on': 'Auto refresh: on (every 4s)',
				'action.auto.off': 'Auto refresh: off',
				'action.wrap': 'Wrap lines',
				'action.nowrap': 'No wrapping',
				'action.split': 'Side by side',
				'action.unified': 'Unified',
				'action.copy': 'Copy path',
				'action.copied': 'Copied',
				'filter.placeholder': 'Filter files…',
				'filter.clear': 'Clear the filter',
				'summary.files': '{count} files',
				'summary.added': '+{count}',
				'summary.deleted': '−{count}',
				'turn.all': 'All turns',
				'turn.chip': 'Turn {turn}',
				'turn.label': 'Filter by turn',
				'mode.label': 'View axis',
				'mode.delta': 'This turn',
				'mode.delta.title': 'Show only what the chosen turn changed',
				'mode.state': 'Cumulative',
				'mode.state.title': 'Show which files exist as of the chosen turn, and what state each is in',
				'turn.lastChange': 'Last changed in turn {turn}',
				'turn.tag': 'T{turn}',
				'summary.deletedFiles': '{count} deleted',
				'commit.action': 'Checkpoint',
				'commit.title': 'Commit the working tree to git — commit only: no push, no history rewrite, and nothing at all when the tree is clean',
				'commit.confirm': 'Commit?',
				'commit.busy': 'Committing…',
				'commit.done': 'Committed {revision}',
				'commit.clean': 'Nothing to commit',
				'commit.failed': 'Commit failed: {detail}',
				'turns.label': 'Turns',
				'turns.ask': 'Asked',
				'turns.answer': 'Answered',
				'turns.noAsk': 'No prompt was recorded for this turn',
				'turns.noAnswer': 'This turn has not answered yet',
				'turns.truncated': 'Long content: the first {count} characters are shown',
				'turns.list.loading': 'Reading turns…',
				'turns.list.empty': 'This session has no recorded turns',
				'turns.turn': 'Turn {turn}',
				'turns.open': 'running',
				'turns.files': 'Changed here',
				'turns.fileCount': '{count} files',
				'turns.noFiles': 'This turn changed no files',
				'turns.detail.loading': 'Reading this turn…',
				'turns.label.turn': 'Turn',
				'turns.retry': 'Retry',
				'turns.copy': 'Copy',
				'turns.copied': 'Copied',
				'turns.code': 'Code',
				'turns.wrap': 'Wrap',
				'turns.unwrap': 'No wrap',
				'turns.footnotes': 'Footnotes',
				'time.now': 'now',
				'time.minutes': '{n}min',
				'time.hours': '{n}h',
				'time.days': '{n}d',
				'time.months': '{n}mo',
				'time.years': '{n}y',
				'time.ago': '{t} ago',
				'list.empty': 'No changes in this scope',
				'list.emptyFiltered': 'No file matches the filter',
				'list.loading': 'Reading changes…',
				'diff.empty': 'Pick a file on the left to see its comparison',
				'diff.loading': 'Reading the comparison…',
				'diff.binary': 'Binary file: no text comparison',
				'diff.norecord': 'The Host kept no before/after comparison for this change (the session log names the file, but the change recorder produced no comparison). Switch to “Working tree” to see how it differs now.',
				'diff.oversized': 'File too large: no comparison generated',
				'diff.created': 'New file',
				'diff.deleted': 'Deleted file',
				'diff.unchanged': 'No content change',
				'diff.truncated': 'Showing the first {count} lines only',
				'diff.coarse': 'File too large: shown as a whole-file replacement',
				'diff.none': 'Nothing to show',
				'notice.notRepo': 'This session’s directory is not inside a git repository; switch to “This session” to see the agent’s changes',
				'notice.noGit': 'git was not found on this machine; only “This session” changes are available',
				'notice.noSession': 'No file change has been recorded for this session yet',
				'status.modified': 'Modified',
				'status.added': 'Added',
				'status.deleted': 'Deleted',
				'status.renamed': 'Renamed',
				'status.copied': 'Copied',
				'status.untracked': 'Untracked',
				'status.conflicted': 'Conflicted',
				'status.binary': 'Binary',
				'status.oversized': 'Too large',
				'status.directory': 'Directory',
				'error.retry': 'Retry',
				'error.generic': 'The read failed',
				'error.unavailable': 'Unavailable on this Host',
				'error.unknownSession': 'That session is unknown',
				'error.notRepository': 'Not a git repository',
				'error.noGit': 'git not found',
				'error.forbidden': 'The request was refused',
			},
		};

		var h = React.createElement;

		/* ------------------------------------------------------------------ *
		 * Stylesheet
		 *
		 * Every rule is namespaced `dshdv-`, and every color goes through a
		 * `--dsw-alias-*` token with a literal fallback, so the view follows the
		 * shell's light/dark switch without owning a theme of its own. The sheet
		 * is inserted once per loaded bundle and removed with it.
		 * ------------------------------------------------------------------ */

		var STYLES = [
			/* The tab host.
			 *
			 * Both views are full-height panes with their own scrollers — the shape
			 * the shell's trajectory view has — so they take the shell's own composer
			 * contract: `data-conversation-composer-overlay` on the root turns the
			 * conversation's scroll body into a clipping box and floats the composer
			 * seat over this pane's bottom instead of stacking it after the pane in
			 * one shared scroller. The shell publishes the seat's live height as
			 * `--dsh-composer-height`, and the view owes it the clearance — see
			 * `--dshdv-bottom-clearance` below, exactly as `ui-trajectory` does it. */
			'.dshdv-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-bg-layer-1,#fff);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;--dshdv-bottom-clearance:calc(var(--dsh-composer-height, 152px) + 16px)}',
			/* The composer belongs to the CONVERSATION view, not to every view.
			 *
			 * The shell renders the composer seat as a sibling of whichever view is
			 * elected, so by default it follows the reader into a diff or a turn
			 * browser — where there is nothing to send to and the seat only eats the
			 * bottom of a full-height pane. The shell has no per-view switch for that,
			 * but it guarantees the signal this rule needs: the view host renders ONE
			 * view at a time (`renderSlot('conversation.view', …, { only: viewId })`),
			 * so the presence of a view's own root in the scroll body says which view
			 * is elected. Both of this plugin's roots are listed explicitly, and the
			 * third clause covers every full-bleed view that takes the shell's own
			 * composer-overlay contract (the trajectory view does) — a view that owns
			 * its pane does not carry the conversation's composer.
			 *
			 * The seat keeps its DOM: nothing unmounts, the draft survives, and the
			 * rule stops matching the moment the conversation view is elected again. */
			'[data-conversation-scroll]:has([data-dsh-diff-view])>[data-composer-seat],'
				+ '[data-conversation-scroll]:has([data-dsh-diff-turns])>[data-composer-seat],'
				+ '[data-conversation-scroll]:has([data-conversation-composer-overlay])>[data-composer-seat]{display:none}',
			'.dshdv-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:none;min-height:38px;box-sizing:border-box}',
			'.dshdv-tabs{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}',
			'.dshdv-tab:hover{color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-barSpacer{flex:1 1 auto;min-width:4px}',
			'.dshdv-filter{position:relative;display:flex;align-items:center;flex:0 1 220px;min-width:120px}',
			'.dshdv-filter input{width:100%;box-sizing:border-box;height:26px;padding:0 22px 0 8px;border:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}',
			'.dshdv-filter input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b6cf6)}',
			'.dshdv-filterClear{position:absolute;right:2px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b939e);cursor:pointer;font-size:14px;line-height:1;padding:2px 5px;border-radius:var(--dsw-radius-sm,6px)}',
			/* The strip's icon button, copied from ui-sidebar-files FilesBody `.tool`:
			 * a 28px box, `--dsw-radius-sm`, a 15px glyph, secondary ink that lifts to
			 * primary over the shared interactive fill. */
			'.dshdv-btn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
			'.dshdv-btn:hover{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-btn[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-btn svg{display:block;width:15px;height:15px}',
			'.dshdv-summary{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;white-space:nowrap}',
			/* The per-turn filter strip: only the session scope has turns, so this
			 * row exists there and nowhere else. */
			'.dshdv-turns{display:flex;align-items:center;gap:6px;flex:none;padding:6px 12px;overflow-x:auto;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-turn{display:inline-flex;flex:none;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;white-space:nowrap}',
			'.dshdv-turn:hover{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-turn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-turn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-turnCount{color:var(--dsw-alias-label-tertiary,#8b939e);font-variant-numeric:tabular-nums}',
			/* The strip is a timeline on the left and an axis switch on the right; the
			 * spacer keeps them apart however many turns there are. */
			'.dshdv-turnsSpacer{flex:1 1 auto;min-width:8px}',
			'.dshdv-modes{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-modes .dshdv-turn{padding:2px 8px}',
			'.dshdv-modes .dshdv-turn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.dshdv-turnTag{flex:none;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px;font-variant-numeric:tabular-nums}',
			/* The per-turn browser: turns on the left, that turn's question, answer
			 * and changed files stacked on the right. */
			'.dshdv-tv{display:flex;flex:1 1 auto;min-height:0;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.dshdv-tvList{display:flex;flex-direction:column;flex:0 0 196px;min-width:0;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-tvListBody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 0 8px 8px;margin-right:2px}',
			'.dshdv-tvRow{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;text-align:left;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1b1f24);padding:5px 8px;border-radius:var(--dsw-radius-md,12px);cursor:pointer}',
			'.dshdv-tvRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-tvRow[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-tvRow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-tvRowTurn{flex:none;font-variant-numeric:tabular-nums}',
			'.dshdv-tvRowMeta{display:inline-flex;align-items:center;gap:6px;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px;font-variant-numeric:tabular-nums}',
			'.dshdv-tvRowTime{flex:none}',
			'.dshdv-tvTag{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px}',
			'.dshdv-tvMain{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
			/* The right column is a fixed split — the turn's question and answer take
			 * the upper THIRD, its changed files the lower TWO THIRDS. Fixed rather
			 * than content-sized on purpose: the reader compares turns by the same
			 * geometry every time, and a long answer scrolls inside its third instead
			 * of pushing the file pane off the bottom of the tab. */
			'.dshdv-tvSaid{flex:0 0 33.3333%;min-height:0;overflow-y:auto;padding:12px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-tvSaidBlock+.dshdv-tvSaidBlock{margin-top:14px}',
			/* The question is the shell's own user bubble: right-aligned, on
			 * `--dsw-specific-bubble`, at `--dsw-radius-xl`, sized by the body axis
			 * the Settings font preference publishes. */
			'.dshdv-tvAskRow{display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0}',
			'.dshdv-tvBubble{max-width:82%;background:var(--dsw-specific-bubble,#eef3ff);border-radius:var(--dsw-radius-xl,20px);padding:10px 16px;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary,#1b1f24);white-space:pre-wrap;word-break:break-word}',
			'.dshdv-tvAskText{display:block}',
			'.dshdv-tvInjected{align-self:flex-end;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:var(--dsh-content-font-size-secondary,13px)}',
			/* The answer is the shell's own Markdown renderer; this only places it. */
			'.dshdv-tvMarkdown{min-width:0;color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-tvMarkdown>*:first-child{margin-top:0}',
			'.dshdv-tvMarkdown>*:last-child{margin-bottom:0}',
			/* The built-in renderer's blocks, used only where the shell exposes no
			 * Markdown primitive. Same tokens as the shell's own markdown sheet
			 * (`MarkdownText.module.css`: `--dsw-font-markdown-base`, `-h1..h4`,
			 * `--dsw-alias-markdown-inline-code` at `0.875em`, list and quote rules),
			 * so the pane does not change rhythm with the renderer. */
			'.dshdv-md{min-width:0;overflow-wrap:anywhere;font:var(--dsw-font-markdown-base,14px/22px var(--dsw-font-family,sans-serif));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-mdP{margin:16px 0;white-space:pre-wrap}',
			'.dshdv-mdP:first-child{margin-top:0}',
			'.dshdv-mdP:last-child{margin-bottom:0}',
			'.dshdv-mdH{margin:32px 0 16px;font-weight:700}',
			'.dshdv-mdH[data-level="1"]{font:var(--dsw-font-markdown-h1,700 21px/30px var(--dsw-font-family,sans-serif))}',
			'.dshdv-mdH[data-level="2"]{font:var(--dsw-font-markdown-h2,700 19px/28px var(--dsw-font-family,sans-serif))}',
			'.dshdv-mdH[data-level="3"]{font:var(--dsw-font-markdown-h3,700 18px/26px var(--dsw-font-family,sans-serif))}',
			'.dshdv-mdH[data-level="4"]{font:var(--dsw-font-markdown-h4,700 16px/24px var(--dsw-font-family,sans-serif));margin:16px 0}',
			'.dshdv-mdH[data-level="5"],.dshdv-mdH[data-level="6"]{font:var(--dsw-font-markdown-base-strong,600 14px/22px var(--dsw-font-family,sans-serif));margin:16px 0}',
			'.dshdv-mdH:first-child{margin-top:0}',
			'.dshdv-mdList{margin:16px 0;padding-left:24px}',
			'.dshdv-mdList li{margin:4px 0}',
			'.dshdv-mdQuote{margin:16px 0;padding-left:16px;border-left:2px solid var(--dsw-alias-label-caption,#9aa3ae);color:var(--dsw-alias-label-secondary,#5b636e);white-space:pre-wrap}',
			'.dshdv-mdRule{margin:24px 0;border:0;border-top:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}',
			'.dshdv-md strong{font-weight:600}',
			'.dshdv-mdCode{padding:1px 4px;font:var(--dsw-font-markdown-code,12px/19px var(--ds-font-family-code,monospace));font-family:var(--ds-font-family-code,monospace);font-size:.875em;background-color:var(--dsw-alias-markdown-inline-code,rgba(0,0,0,.05));border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:var(--dsw-radius-xs,4px)}',
			'.dshdv-mdFence{margin:16px 0;padding-bottom:8px;overflow-x:auto}',
			/* A fence's banner, in the shell's code-block banner vocabulary. */
			'.dshdv-mdFenceBanner{display:flex;align-items:center;gap:12px;padding:8px 18px 6px 22px;background:var(--dsw-alias-markdown-code-block-banner,transparent);color:var(--dsw-alias-label-tertiary,#8b939e);font:11px/18px var(--dsw-font-family,sans-serif)}',
			'.dshdv-mdFenceLang{font-family:var(--ds-font-family-code,monospace)}',
			/* Tables: the shell's own cell rules (`--dsw-alias-border-l3` under the
			 * header, `-l2` between rows) inside a horizontal scroller. */
			'.dshdv-mdTableScroll{max-width:100%;overflow-x:auto;margin:16px 0}',
			'.dshdv-mdTable{border-collapse:collapse;min-width:min(100%,max-content);font:var(--dsw-font-markdown-base,14px/22px var(--dsw-font-family,sans-serif))}',
			'.dshdv-mdTable th{text-align:left;font-weight:600;padding:6px 12px 6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-mdTable td{padding:6px 12px 6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#5b636e);vertical-align:top}',
			'.dshdv-mdTable th:last-child,.dshdv-mdTable td:last-child{padding-right:0}',
			'.dshdv-mdLink{color:var(--dsw-alias-link,#3b6cf6);text-decoration:none}',
			'.dshdv-mdLink:hover{text-decoration:underline}',
			'.dshdv-tvEmpty{margin:0;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:var(--dsh-content-font-size-secondary,13px)}',
			'.dshdv-tvNote{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px}',
			/* The lower two thirds: it takes every pixel the answer's third leaves, so
			 * the two panes always add up to the column exactly. */
			'.dshdv-tvFiles{display:flex;flex-direction:column;flex:1 1 66.6667%;min-height:0}',
			'.dshdv-tvFilesHead{display:flex;align-items:center;gap:8px;flex:none;height:32px;padding:0 12px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-tvFilesHead .dshdv-tvLabel{margin:0}',
			'.dshdv-tvFilesBody{display:flex;flex:1 1 auto;min-height:0;min-width:0}',
			'.dshdv-tvFileList{flex:0 0 190px;min-width:0;overflow-y:auto;padding:6px 0 6px 6px;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-tvFile{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;text-align:left;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1b1f24);padding:5px 7px;border-radius:var(--dsw-radius-md,12px);cursor:pointer}',
			'.dshdv-tvFile:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-tvFile[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-tvDiff{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
			'.dshdv-add{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-del{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-main{display:flex;flex:1 1 auto;min-height:0}',
			'.dshdv-list{flex:0 0 272px;min-width:180px;max-width:45%;display:flex;flex-direction:column;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fafbfc);overflow:hidden}',
			/* The tree's own scroller geometry (ui-sidebar-files FilesBody `.body`): a
			 * 2px scrollbar offset, a stable gutter, and rows inset 8px from the pane
			 * edge so the hover fill never touches the border. */
			'.dshdv-listBody{flex:1 1 auto;overflow:auto;margin-right:2px;padding:8px 0 8px 8px;scrollbar-gutter:stable;contain:content}',
			/* Row vocabulary copied from the shell's own lists — `ui-workspace`'s
			 * Rows (`.sessionRow`), `ui-sidebar-files`' FilesBody (`.row`):
			 * `--dsw-alias-label-primary` ink, `--dsw-radius-md`, and ONE
			 * interactive fill (`--dsw-alias-interactive-bg-hover`) that hover and
			 * selection share. The accent bar, brand tint and bold name this row
			 * used to carry were this plugin's invention; inside the shell they read
			 * as a foreign control, so they are gone. */
			'.dshdv-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,#1b1f24);font:inherit;text-align:left;cursor:pointer;user-select:none}',
			'.dshdv-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-row[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:-2px}',
			'.dshdv-chip{flex:none;width:14px;text-align:center;font-size:11px;font-weight:600;line-height:16px;border-radius:4px}',
			'.dshdv-chip[data-status="added"],.dshdv-chip[data-status="untracked"]{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-chip[data-status="deleted"]{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-chip[data-status="modified"],.dshdv-chip[data-status="renamed"],.dshdv-chip[data-status="copied"]{color:var(--dsw-alias-state-warn-primary,#9a6700)}',
			'.dshdv-chip[data-status="conflicted"]{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-chip[data-status="binary"],.dshdv-chip[data-status="oversized"],.dshdv-chip[data-status="directory"]{color:var(--dsw-alias-label-tertiary,#8b939e)}',
			'.dshdv-names{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
			'.dshdv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}',
			'.dshdv-dirName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b939e)}',
			'.dshdv-counts{flex:none;display:inline-flex;gap:4px;font-size:11px;font-variant-numeric:tabular-nums}',
			'.dshdv-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
			'.dshdv-head{flex:none;display:flex;align-items:center;gap:8px;padding:0 8px 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));height:38px;box-sizing:border-box}',
			'.dshdv-headPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
			'.dshdv-headTools{flex:none;display:inline-flex;gap:2px}',
			'.dshdv-scroll{flex:1 1 auto;overflow:auto;background:var(--dsw-alias-bg-base,#fff)}',
			/* A comparison that is being replaced stays legible but visibly stale:
			 * dimming says "this is not the file you just clicked" without taking
			 * the picture away for the tenth of a second the read takes. */
			'.dshdv-scroll.dshdv-busy{opacity:.45;transition:opacity .12s linear}',
			'.dshdv-headBusy{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b939e)}',
			/* The comparison is drawn in the shell's OWN code-card vocabulary —
			 * `ui-primitives` `DiffBlock`/`CodeCard`: a card on
			 * `--dsw-alias-markdown-code-block` at `--dsw-radius-lg`, body lines at
			 * `--dsw-font-markdown-code-block`, `- `/`+ ` prefixes, the state colour
			 * plus a 3px inset bar on a tinted row, and `data-code-wrap` for the wrap
			 * switch. A two-column line-number gutter would be a different
			 * application's diff, which is exactly what a reader notices first. */
			'.dshdv-code{margin:0;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#fafafa));border-radius:var(--dsw-radius-lg,16px);color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-hunk{padding:6px 0 20px}',
			'.dshdv-hunk+.dshdv-hunk{border-top:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06))}',
			'.dshdv-hunkHeader{padding:0 22px;color:var(--dsw-alias-label-tertiary,#8b939e);font:var(--dsw-font-markdown-code-block,11px/19px var(--ds-font-family-code,monospace));white-space:pre}',
			'.dshdv-line{box-sizing:border-box;min-height:1lh;padding:0 22px;white-space:pre;color:var(--dsw-alias-label-secondary,#5b636e);font:var(--dsw-font-markdown-code-block,11px/19px var(--ds-font-family-code,monospace))}',
			'.dshdv-line[data-kind="del"]::before{content:"- "}',
			'.dshdv-line[data-kind="del"]{color:var(--dsw-alias-state-error-primary,#c0392b);background:var(--dsw-alias-code-diff-deleted,rgba(220,38,38,.08));box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-line[data-kind="add"]::before{content:"+ "}',
			'.dshdv-line[data-kind="add"]{color:var(--dsw-alias-state-success-primary,#1a7f37);background:var(--dsw-alias-code-diff-added,rgba(34,197,94,.08));box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-line[data-kind="context"]::before{content:"  "}',
			'.dshdv-code[data-code-wrap="true"] .dshdv-line,.dshdv-code[data-code-wrap="true"] .dshdv-hunkHeader{white-space:pre-wrap;overflow-wrap:anywhere}',
			'.dshdv-text{flex:1 1 auto;min-width:0}',
			'.dshdv-split{display:flex;align-items:flex-start}',
			'.dshdv-splitCell{flex:1 1 50%;min-width:0;display:flex;align-items:flex-start;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06));padding:0 12px;white-space:pre}',
			'.dshdv-splitCell[data-kind="add"]{color:var(--dsw-alias-state-success-primary,#1a7f37);background:var(--dsw-alias-code-diff-added,rgba(34,197,94,.08))}',
			'.dshdv-splitCell[data-kind="del"]{color:var(--dsw-alias-state-error-primary,#c0392b);background:var(--dsw-alias-code-diff-deleted,rgba(220,38,38,.08))}',
			'.dshdv-splitCell[data-empty="true"]{background:transparent}',
			'.dshdv-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#5b636e);font-size:var(--dsh-content-font-size-secondary,13px)}',
			'.dshdv-status p{margin:0;max-width:44ch;line-height:1.6}',
			/* Every scrolling region a pane can hold ends above the floating composer:
			 * the shell's own trajectory ledger reserves the same band. */
			'.dshdv-listBody,.dshdv-scroll,.dshdv-tvListBody,.dshdv-tvSaid,.dshdv-tvFileList{padding-bottom:var(--dshdv-bottom-clearance)}',
			'.dshdv-note{padding:6px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06))}',
			'.dshdv-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
			'@media (max-width: 720px){.dshdv-list{flex-basis:200px}}',
		];

		var STYLE_ID = NAMESPACE + '-styles';

		/** Insert this bundle's stylesheet once; the module system owns the tag. */
		function ensureStyles() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(STYLE_ID) !== null) return;
			var tag = document.createElement('style');
			tag.id = STYLE_ID;
			tag.textContent = STYLES.join('\n');
			document.head.append(tag);
		}

		/* ------------------------------------------------------------------ *
		 * Icons
		 *
		 * Inline SVG in the shell's own geometry: 16x16, `fill:none`, 1px
		 * `currentColor` stroke. Drawn here rather than imported because the icon
		 * package is not one of the platform words a third-party bundle may
		 * require.
		 * ------------------------------------------------------------------ */

		function icon(paths, extra) {
			return h('svg', Object.assign({
				viewBox: '0 0 16 16',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
			}, extra || {}), paths.map(function (d, index) {
				return h('path', { key: index, d: d });
			}));
		}

		var ICON_REFRESH = [['M13.5 8a5.5 5.5 0 1 1-1.7-3.98'], ['M13.5 2.5v2.6h-2.6']];
		var ICON_WRAP = [['M2.5 4.5h11'], ['M2.5 8h7.5a2 2 0 0 1 0 4H8'], ['M9.5 10.5 8 12l1.5 1.5'], ['M2.5 11.5h3']];
		var ICON_SPLIT = [['M2.5 2.5h11v11h-11z'], ['M8 2.5v11']];
		var ICON_COPY = [['M5.5 5.5h7v7h-7z'], ['M3.5 10.5v-7h7']];
		var ICON_EMPTY = [['M2.5 3.5h11v9h-11z'], ['M5 6.5h6'], ['M5 9.5h4']];
		/** A commit: a node on a line, the shape the shell's own git affordances use. */
		var ICON_COMMIT = [['M8 2.5v11'], ['M5.2 8a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 1 0-5.6 0']];

		/* ------------------------------------------------------------------ *
		 * Small helpers
		 * ------------------------------------------------------------------ */

		/** Split a display path into its directory part and its base name. */
		function splitPath(path) {
			var cut = path.lastIndexOf('/');
			if (cut === -1) return { dir: '', name: path };
			return { dir: path.slice(0, cut), name: path.slice(cut + 1) };
		}

		/** One-line status letter, in the idiom of a source-control list. */
		var STATUS_LETTER = {
			modified: 'M',
			added: 'A',
			untracked: 'U',
			deleted: 'D',
			renamed: 'R',
			copied: 'C',
			conflicted: '!',
			binary: 'B',
			oversized: 'L',
			directory: '/',
		};

		/** Substitute `{name}` placeholders in one dictionary string. */
		function format(template, values) {
			return template.replace(/\{(\w+)\}/gu, function (match, key) {
				return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
			});
		}

		/** Read one string preference; an unreadable store answers with the default. */
		function readPreference(key, fallback) {
			try {
				var value = window.localStorage.getItem(key);
				return value === null || value === '' ? fallback : value;
			} catch (error) {
				return fallback;
			}
		}

		/** Write one string preference; a refused write is not worth failing over. */
		function writePreference(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (error) {
				/* a private-mode refusal costs the preference, never the view */
			}
		}

		/** The translated label for one file status. */
		function statusLabel(t, status) {
			var known = STATUS_LETTER[status] === undefined ? 'modified' : status;
			return t('status.' + known);
		}

		/* ------------------------------------------------------------------ *
		 * Data layer
		 *
		 * One controller per Session, created lazily so a mount is the one event
		 * that matters: the view asks for `sessionId`, and every question it asks
		 * afterwards is addressed by that identity. Reads carry a generation
		 * counter, so a slow answer for a scope or a file the user already left
		 * cannot overwrite the one on screen.
		 * ------------------------------------------------------------------ */

		/**
		 * Whether two values are indistinguishable to the view.
		 *
		 * Arrays compare by length and element identity, plain objects by their
		 * scalar fields (`totals`); anything else by `Object.is`. This is not a
		 * deep equality in general — it is exactly the depth this state has.
		 *
		 * @param left - the value already held.
		 * @param right - the value a patch would install.
		 * @returns whether installing `right` would be invisible.
		 */
		function sameValue(left, right) {
			if (Object.is(left, right)) return true;
			if (Array.isArray(left) && Array.isArray(right)) {
				if (left.length !== right.length) return false;
				for (var at = 0; at < left.length; at += 1) if (!Object.is(left[at], right[at])) return false;
				return true;
			}
			if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
				var leftKeys = Object.keys(left);
				var rightKeys = Object.keys(right);
				if (leftKeys.length !== rightKeys.length) return false;
				for (var index = 0; index < leftKeys.length; index += 1) {
					if (!Object.is(left[leftKeys[index]], right[leftKeys[index]])) return false;
				}
				return true;
			}
			return false;
		}

		/**
		 * Whether a patch would change anything on screen.
		 *
		 * @param current - the state in force.
		 * @param next - the fields a patch wants to write.
		 * @returns true when every field already holds that value.
		 */
		function sameState(current, next) {
			var keys = Object.keys(next);
			for (var at = 0; at < keys.length; at += 1) {
				if (!sameValue(current[keys[at]], next[keys[at]])) return false;
			}
			return true;
		}

		/** The state one Session's view starts from. */
		function initialState() {
			return {
				scope: readPreference(SCOPE_KEY, GIT) === SESSION ? SESSION : GIT,
				files: [],
				repo: null,
				cwd: null,
				turn: undefined,
				turns: [],
				/** The turn the session scope is narrowed to; null is every turn. */
				viewTurn: null,
				/** Which axis the session scope shows: `delta` (a turn's changes) or `state`. */
				viewMode: readPreference(MODE_KEY, DELTA_MODE) === STATE_MODE ? STATE_MODE : DELTA_MODE,
				/** The checkpoint button: idle, armed, in flight, or reporting a result. */
				commitPhase: 'idle',
				/** What the last checkpoint answered — a copy key plus its values. */
				commitNote: null,
				totals: { added: 0, deleted: 0 },
				phase: 'idle',
				error: null,
				selected: null,
				/** Fingerprint of the file the live comparison belongs to. */
				selectedPrint: undefined,
				diff: null,
				/** The path the held comparison was read for; undefined when none is held. */
				diffPath: undefined,
				diffPhase: 'idle',
				diffError: null,
			};
		}

		/**
		 * What a comparison depends on: the path, its status, its counts, and the
		 * turns that changed it.
		 *
		 * The counts are the recorder's or git's own reading of how much the
		 * file changed, so they stand in for "same content, same picture" at a
		 * fraction of the cost of re-reading and re-diffing the file. The
		 * per-turn list belongs in here too: a turn's numbers can be
		 * re-announced while the aggregate stays exactly where it was.
		 */
		function fingerprint(file) {
			if (file === undefined) return undefined;
			var turns = Array.isArray(file.sources)
				? file.sources.map(function (source) {
					return [source.turn, source.seq, source.index, source.status, source.added, source.deleted].join(':');
				}).join(',')
				: String(file.changedTurns === undefined ? '' : file.changedTurns);
			return [
				file.path, file.status, file.added, file.deleted,
				file.at === undefined ? '' : `${file.at.turn}:${file.at.seq}:${file.at.index}`,
				turns,
			].join('\u0000');
		}

		/**
		 * The files one turn's view lists.
		 *
		 * `null` is the aggregate view: every changed file, compared at its
		 * newest turn. A turn number narrows the list to the files that turn
		 * changed — a file edited in three turns appears in all three, carrying
		 * that turn's own counts.
		 */
		function filesForTurn(files, viewTurn) {
			if (viewTurn === null || viewTurn === undefined) return files;
			return files.filter(function (file) {
				return turnSource(file, viewTurn) !== undefined;
			});
		}

		/**
		 * One file's record for one turn.
		 *
		 * The Host sends a `sources` entry per turn that changed a path; a path
		 * the change recorder never summarized (a log-derived entry) has a turn
		 * in `changedTurns` and no coordinate, which answers with a stand-in so
		 * callers can treat both shapes the same.
		 */
		function turnSource(file, turn) {
			var sources = Array.isArray(file.sources) ? file.sources : [];
			for (var at = 0; at < sources.length; at += 1) {
				if (sources[at].turn === turn) return sources[at];
			}
			var changed = Array.isArray(file.changedTurns) ? file.changedTurns : [];
			if (changed.indexOf(turn) === -1) return undefined;
			return { turn: turn, derived: true, status: file.status, added: 0, deleted: 0 };
		}

		/**
		 * The coordinate one file's comparison must be read at.
		 *
		 * The aggregate view uses the file's newest turn (`at`); a turn view uses
		 * that turn's own coordinate. `undefined` means the Host kept no
		 * comparison for this file in this turn.
		 */
		function coordinateFor(file, viewTurn) {
			if (viewTurn === null || viewTurn === undefined) return file.at;
			var source = turnSource(file, viewTurn);
			if (source === undefined || typeof source.seq !== 'number' || typeof source.index !== 'number') return undefined;
			return { turn: source.turn, seq: source.seq, index: source.index };
		}

		/** The status letter and counts one view shows for a file. */
		function factsFor(file, viewTurn) {
			var source = viewTurn === null || viewTurn === undefined ? undefined : turnSource(file, viewTurn);
			if (source === undefined) return { status: file.status, added: file.added, deleted: file.deleted };
			return { status: source.status, added: source.added, deleted: source.deleted };
		}

		/**
		 * One file's newest change at or before a turn.
		 *
		 * The Host sends a file's whole history in `sources` (oldest first), so this
		 * is the fold that turns a list of changes into a state: whatever happened
		 * last is what the file looks like now. A log-derived entry has turns but no
		 * coordinates, and answers with the same shape so callers need no special
		 * case.
		 *
		 * @param file - one listed file.
		 * @param turn - the inclusive bound.
		 * @returns the source, or undefined when the file had not changed yet.
		 */
		function lastSourceUpTo(file, turn) {
			var sources = Array.isArray(file.sources) ? file.sources : [];
			var found;
			for (var at = 0; at < sources.length; at += 1) {
				if (sources[at].turn <= turn) found = sources[at];
			}
			if (found !== undefined) return found;
			var changed = Array.isArray(file.changedTurns) ? file.changedTurns : [];
			var newest = changed.length === 0 ? undefined : changed[changed.length - 1];
			if (newest === undefined || newest > turn) return undefined;
			return { turn: newest, status: file.status, added: 0, deleted: 0, derived: true };
		}

		/**
		 * The files that exist once a turn is over, and how many were deleted by it.
		 *
		 * A file deleted at or before the bound is not part of the state — it is a
		 * change that happened, not a file that is there — so it leaves the list and
		 * is counted instead. A file deleted and later re-added comes back, because
		 * the fold only ever asks what happened LAST.
		 *
		 * @param files - every changed file the Host listed.
		 * @param turn - the inclusive bound.
		 * @returns `{ rows: [{ file, source }], deleted }`.
		 */
		function stateAt(files, turn) {
			var rows = [];
			var deleted = 0;
			files.forEach(function (file) {
				var last = lastSourceUpTo(file, turn);
				if (last === undefined) return;
				if (last.status === 'deleted') {
					deleted += 1;
					return;
				}
				rows.push({ file: file, source: last });
			});
			return { rows: rows, deleted: deleted };
		}

		/**
		 * The turn the current view is bounded by.
		 *
		 * A chosen turn is the bound; with none chosen the newest turn is, which is
		 * what makes the state view meaningful before a reader picks anything.
		 */
		function boundTurn(state) {
			if (state.viewTurn !== null && state.viewTurn !== undefined) return state.viewTurn;
			var turns = Array.isArray(state.turns) ? state.turns : [];
			return turns.length > 0 ? turns[0] : 0;
		}

		/** The files the current view lists. */
		function visibleFiles(files, state) {
			if (state.scope !== SESSION) return files;
			if (state.viewMode === STATE_MODE) {
				return stateAt(files, boundTurn(state)).rows.map(function (row) { return row.file; });
			}
			return filesForTurn(files, state.viewTurn);
		}

		/** The status letter and counts the current view shows for one file. */
		function factsForView(file, state) {
			if (state.scope === SESSION && state.viewMode === STATE_MODE) {
				var last = lastSourceUpTo(file, boundTurn(state));
				if (last !== undefined) return { status: last.status, added: last.added, deleted: last.deleted };
			}
			return factsFor(file, state.viewTurn);
		}

		/** The coordinate the current view must read one file's comparison at. */
		function coordinateForView(file, state) {
			if (state.scope !== SESSION) return undefined;
			if (state.viewMode === STATE_MODE) {
				var last = lastSourceUpTo(file, boundTurn(state));
				if (last === undefined || typeof last.seq !== 'number' || typeof last.index !== 'number') return undefined;
				return { turn: last.turn, seq: last.seq, index: last.index };
			}
			return state.viewTurn === null || state.viewTurn === undefined ? file.at : coordinateFor(file, state.viewTurn);
		}

		/** The turn whose change the current view shows for one file, when it has one. */
		function changeTurnFor(file, state) {
			if (state.scope !== SESSION) return undefined;
			if (state.viewMode === STATE_MODE) {
				var last = lastSourceUpTo(file, boundTurn(state));
				return last === undefined ? undefined : last.turn;
			}
			if (state.viewTurn !== null && state.viewTurn !== undefined) return state.viewTurn;
			return file.at === undefined ? undefined : file.at.turn;
		}

		/** Read one failure's message key from the route's error envelope. */
		function failureOf(status, body) {
			var code = body !== null && body !== undefined && body.error !== undefined ? body.error.code : undefined;
			if (code === 'diff/no-git') return 'error.noGit';
			if (code === 'diff/unknown-session') return 'error.unknownSession';
			if (code === 'diff/not-a-repository') return 'error.notRepository';
			if (code === 'diff/unavailable') return 'error.unavailable';
			if (code === 'diff/forbidden') return 'error.forbidden';
			if (status === 403) return 'error.forbidden';
			return 'error.generic';
		}

		/** Fetch one route and decode its envelope; a refusal is a value, not a throw. */
		async function readJson(url, signal) {
			var response = await fetch(url, { credentials: 'same-origin', signal: signal });
			var body = null;
			try {
				body = await response.json();
			} catch (error) {
				body = null;
			}
			if (!response.ok || body === null || body.ok !== true) {
				return { failed: failureOf(response.status, body), detail: body !== null && body.error !== undefined ? body.error.message : undefined };
			}
			return { value: body };
		}

		function filesUrl(scope, sessionId) {
			return FILES_URL + '?scope=' + encodeURIComponent(scope) + '&sessionId=' + encodeURIComponent(sessionId);
		}

		function fileUrl(scope, sessionId, path, at) {
			var url = FILE_URL + '?scope=' + encodeURIComponent(scope) + '&sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path);
			if (at !== undefined && at !== null) {
				url += '&at=' + encodeURIComponent(String(at.turn) + ':' + String(at.seq) + ':' + String(at.index));
			}
			return url;
		}

		function createController() {
			var listeners = new Set();
			var state = initialState();
			var generation = 0;
			var diffGeneration = 0;
			/**
			 * Mount epoch. `reset()` advances it, so a read that was in flight
			 * when the view unmounted cannot write its answer into the state a
			 * LATER mount is showing — the generation counter alone cannot see
			 * that case, because a remount of the same Session legitimately
			 * reuses this controller.
			 */
			var epoch = 0;

			function emit() {
				listeners.forEach(function (listener) {
					listener();
				});
			}

			/**
			 * Publish a state change — or publish nothing at all.
			 *
			 * Every patch wakes the view, so a patch that changes no value the view
			 * can see must not wake it: that is the difference between a refresh
			 * that costs one HTTP read and a refresh that additionally reconciles
			 * the whole panel. Arrays compare by length and element identity (the
			 * list fold keeps unchanged entries as the same objects), so an
			 * identical list is recognized as identical.
			 */
			function patch(next) {
				if (sameState(state, next)) return;
				state = Object.assign({}, state, next);
				emit();
			}

			/**
			 * Everything a list read owns.
			 *
			 * A failed read has to clear all of it, not just the rows: leaving a
			 * previous scope's totals or repository behind under an error banner is
			 * how a summary ends up describing a tree nobody is looking at.
			 */
			function emptyList() {
				return {
					files: [], selected: null, selectedPrint: undefined, diff: null, diffPath: undefined,
					diffPhase: 'idle', diffError: null,
					repo: null, cwd: null, turn: undefined, turns: [], totals: { added: 0, deleted: 0 },
				};
			}


			/**
			 * Fold a freshly read list into the one on screen.
			 *
			 * An entry that is identical to its predecessor keeps the PRECEDING
			 * object, so the rows a reader is looking at are not recreated by a
			 * refresh that found nothing new — React then re-renders the pane with
			 * the same elements, which is what makes a silent refresh actually
			 * silent instead of a repaint every few seconds.
			 *
			 * @param previous - the files currently held.
			 * @param incoming - the files the Host just answered with.
			 * @returns `{ files, changed }`.
			 */
			function mergeFiles(previous, incoming) {
				var byPath = new Map();
				for (var at = 0; at < previous.length; at += 1) byPath.set(previous[at].path, previous[at]);
				var files = [];
				var changed = previous.length !== incoming.length;
				for (var index = 0; index < incoming.length; index += 1) {
					var next = incoming[index];
					var before = byPath.get(next.path);
					if (before !== undefined && fingerprint(before) === fingerprint(next)) {
						/* Same entry, same numbers: keep the object the list already has. */
						files.push(before);
						if (previous[index] !== before) changed = true;
						continue;
					}
					files.push(next);
					changed = true;
				}
				return { files: files, changed: changed };
			}


			var controller = {
				getSnapshot: function () {
					return state;
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},

				/** Switch scope, drop the comparison, and read the new list. */
				setScope: function (scope, sessionId) {
					if (scope === state.scope) return;
					writePreference(SCOPE_KEY, scope);
					state = Object.assign({}, state, {
						scope: scope, selected: null, selectedPrint: undefined,
						diff: null, diffPath: undefined, diffPhase: 'idle', files: [], error: null,
						// Turns belong to the session scope; the git scope has none.
						viewTurn: null, turns: [],
					});
					emit();
					return controller.load(sessionId);
				},

				/**
				 * Narrow the session scope to one turn, or widen it back to all of them.
				 *
				 * The turn's files come from the list already in hand (each entry
				 * carries its own per-turn coordinates and counts), so switching is
				 * instant: one comparison read for the turn's first file, and nothing
				 * else. `null` restores the aggregate view.
				 */
				setTurn: function (sessionId, turn) {
					if (turn === state.viewTurn) return undefined;
					var next = Object.assign({}, state, { turns: state.turns, viewTurn: turn });
					var pool = visibleFiles(state.files, next);
					var selected = pool.length > 0 ? pool[0].path : null;
					patch({
						viewTurn: turn,
						selected: selected,
						selectedPrint: undefined,
						diff: null,
						diffPath: undefined,
						diffPhase: 'idle',
						diffError: null,
					});
					if (selected === null) return undefined;
					return controller.select(sessionId, selected);
				},

				/**
				 * Switch the session scope between "what this turn did" and "what exists
				 * after it".
				 *
				 * Both axes are computed from the same list, so the switch costs one
				 * comparison read for whatever becomes selected — and it must drop the
				 * held comparison, because the same file is now addressed at a different
				 * turn.
				 */
				setMode: function (sessionId, mode) {
					if (mode === state.viewMode) return undefined;
					writePreference(MODE_KEY, mode);
					var next = Object.assign({}, state, { viewMode: mode });
					var pool = visibleFiles(state.files, next);
					var selected = pool.length > 0 ? pool[0].path : null;
					patch({
						viewMode: mode,
						selected: selected,
						selectedPrint: undefined,
						diff: null,
						diffPath: undefined,
						diffPhase: 'idle',
						diffError: null,
					});
					if (selected === null) return undefined;
					return controller.select(sessionId, selected);
				},

				/**
				 * Read the list of the current scope, then the comparison of
				 * whatever file ends up selected.
				 *
				 * The two read modes differ in what the reader is allowed to see:
				 *
				 * - **interactive** (mount, scope switch, the refresh button) owns
				 *   the loading phase, so a remount never shows a stale tree;
				 * - **silent** (the auto-refresh tick) changes *nothing* until a
				 *   fresh answer is in hand. Its whole point is that the pane a
				 *   reader is looking at does not blink every few seconds, so the
				 *   rows are swapped only for the entries that actually differ and
				 *   the comparison is re-read only when the file's own numbers moved.
				 */
				load: async function (sessionId, options) {
					var silent = options !== undefined && options.silent === true;
					var current = (generation += 1);
					var started = epoch;
					var stale = function () { return current !== generation || started !== epoch; };
					var scope = state.scope;
					if (!silent) patch({ phase: 'loading', error: null, files: [], selected: null, diff: null, diffPhase: 'idle' });
					var result;
					try {
						result = await readJson(filesUrl(scope, sessionId), undefined);
					} catch (error) {
						if (stale()) return;
						patch({ phase: 'error', error: 'error.generic', ...emptyList() });
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch(Object.assign({ phase: 'error', error: result.failed }, emptyList()));
						return;
					}
					var incoming = mergeFiles(state.files, Array.isArray(result.value.files) ? result.value.files : []);
					var files = incoming.files;
					var turns = Array.isArray(result.value.turns) ? result.value.turns : [];
					/* A turn the answer no longer lists cannot stay selected: the
					 * Session may have been forked, or the recorder's record dropped.
					 * An answer with no turns at all (an error page, an empty scope)
					 * leaves the choice alone rather than discarding it. */
					var viewTurn = state.viewTurn !== null && turns.length > 0 && turns.indexOf(state.viewTurn) === -1
						? null
						: state.viewTurn;
					var pool = visibleFiles(files, { scope: state.scope, viewMode: state.viewMode, viewTurn: viewTurn, turns: turns });
					var keep = state.selected !== null && pool.some(function (file) { return file.path === state.selected; });
					var selected = keep ? state.selected : (pool.length > 0 ? pool[0].path : null);
					var sameFile = selected !== null && selected === state.selected;
					/* A comparison survives a refresh exactly while the file's own
					 * numbers — and the turn being viewed — do. Anything else means the
					 * comparison on screen describes a different content. */
					var currentPrint = selected === null ? undefined : fingerprint(files.find(function (file) { return file.path === selected; }));
					var holdsComparison = sameFile && currentPrint !== undefined && currentPrint === state.selectedPrint;
					/* A read is owed whenever the comparison on screen is not the one this
					 * list describes — including every interactive read, whose whole job
					 * is to present the current tree. */
					var mustRead = selected !== null && (!holdsComparison || !silent);
					var value = result.value;
					patch({
						phase: 'ready',
						error: null,
						files: files,
						repo: value.repo === undefined ? null : value.repo,
						cwd: value.cwd === undefined ? null : value.cwd,
						turn: value.turn,
						turns,
						viewTurn,
						totals: { added: value.added || 0, deleted: value.deleted || 0 },
						/* Selection belongs to `select`, which owns the comparison too:
						 * writing it here would make `select`'s own dedupe see the file as
						 * already chosen and skip the read it was called to perform. */
						diff: holdsComparison ? state.diff : null,
						diffPhase: holdsComparison ? state.diffPhase : 'idle',
					});
					if (mustRead) {
						await controller.select(sessionId, selected);
					} else if (!sameFile) {
						patch({ selected: selected, selectedPrint: currentPrint });
					}
				},

				/**
				 * Read one file's comparison. */
				select: async function (sessionId, path) {
					/* Idempotent for the cases where a read is pointless: the file is
					 * already chosen AND a comparison for it is held or on its way. It
					 * must NOT short-circuit when the held comparison was invalidated
					 * (idle) or failed (error) — those are exactly the re-reads. */
					if (state.selected === path
						&& (state.diffPhase === 'ready' || state.diffPhase === 'norecord' || state.diffPhase === 'loading')) return;
					var file = state.files.find(function (entry) { return entry.path === path; });
					if (file === undefined) return;
					var current = (diffGeneration += 1);
					var started = epoch;
					var stale = function () { return current !== diffGeneration || started !== epoch; };
					/* The comparison belongs to a TURN in the session scope: the newest
					 * turn in the aggregate view, the chosen one in a turn view, and the
					 * file's own last change up to the bound in the state view. A path
					 * with no coordinate (a log-derived entry, or a file no relevant turn
					 * changed) has no stored comparison: reading one would 404 and read as
					 * a failure, when the honest answer is that none was kept. */
					var coordinate = coordinateForView(file, state);
					if (state.scope === SESSION && coordinate === undefined) {
						patch({ selected: path, selectedPrint: fingerprint(file), diff: null, diffPath: undefined, diffPhase: 'norecord', diffError: null });
						return;
					}
					/* ONE patch for the whole selection: two would render the list and
					 * the comparison twice for a single click. The previously held
					 * comparison stays in state under its own path so the pane can keep
					 * drawing it (dimmed) instead of blanking between files. */
					patch({
						selected: path,
						selectedPrint: fingerprint(file),
						diffPhase: 'loading',
						diffError: null,
					});
					var result;
					try {
						result = await readJson(fileUrl(state.scope, sessionId, path, coordinate), undefined);
					} catch (error) {
						if (stale()) return;
						patch({ diffPhase: 'error', diffError: 'error.generic', diff: null, diffPath: undefined });
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch({ diffPhase: 'error', diffError: result.failed, diff: null, diffPath: undefined });
						return;
					}
					patch({ diffPhase: 'ready', diffPath: path, diff: result.value, diffError: null });
				},

				/**
				 * Re-read the list; re-read the comparison only when it moved.
				 *
				 * The silent load already decided that: it kept the comparison when
				 * the selected file's numbers were unchanged, and dropped it when they
				 * were not. Re-selecting unconditionally here would undo that decision
				 * and put the pane back to blinking once per tick.
				 */
				refresh: async function (sessionId) {
					await controller.load(sessionId, { silent: true });
					if (state.selected !== null && state.diffPhase === 'idle') {
						await controller.select(sessionId, state.selected);
					}
				},

				/** Arm the checkpoint button: the next press commits. */
				armCommit: function () {
					patch({ commitPhase: 'confirm', commitNote: null });
				},

				/** Disarm it — the reader moved on without pressing again. */
				cancelCommit: function () {
					if (state.commitPhase !== 'confirm') return;
					patch({ commitPhase: 'idle' });
				},

				/**
				 * Commit the working tree, then re-read the list.
				 *
				 * This is the plugin's only write, and the only place a scope can
				 * change because of something the view did: the working-tree scope is
				 * "diff against HEAD", and a commit moves HEAD. Re-reading afterwards
				 * is therefore part of the operation, not a courtesy — without it the
				 * pane would keep showing changes that are now committed.
				 */
				commit: async function (sessionId, turn) {
					if (state.commitPhase === 'busy') return;
					patch({ commitPhase: 'busy', commitNote: null });
					var payload = { sessionId: sessionId };
					if (typeof turn === 'number') payload.turn = turn;
					var answer;
					try {
						var response = await fetch(COMMIT_URL, {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(payload),
						});
						var body = null;
						try {
							body = await response.json();
						} catch (error) {
							body = null;
						}
						answer = { ok: response.ok && body !== null && body.ok === true, status: response.status, body: body };
					} catch (error) {
						answer = { ok: false, status: 0, body: null };
					}
					if (answer.ok !== true) {
						var detail = answer.body !== null && answer.body !== undefined && answer.body.error !== undefined
							? String(answer.body.error.message ?? '')
							: '';
						patch({ commitPhase: 'error', commitNote: { key: 'commit.failed', values: { detail: detail } } });
						return;
					}
					var result = answer.body;
					patch({
						commitPhase: 'done',
						commitNote: result.committed === true
							? { key: 'commit.done', values: { revision: String(result.revision ?? '') } }
							: { key: 'commit.clean', values: {} },
					});
					await controller.load(sessionId);
				},

				/** Forget the mounted session's data when the view unmounts. */
				reset: function () {
					generation += 1;
					diffGeneration += 1;
					epoch += 1;
					state = Object.assign({}, state, {
						files: [], selected: null, selectedPrint: undefined, diff: null, diffPath: undefined,
						phase: 'idle', diffPhase: 'idle', error: null, diffError: null,
						// An armed button must not survive a remount: the reader who armed
						// it is gone, and the next press would commit without a confirm.
						commitPhase: 'idle', commitNote: null,
					});
					emit();
				},
			};
			return controller;
		}

		/* ------------------------------------------------------------------ *
		 * The per-turn browser
		 *
		 * Same files, read as a conversation: one row per turn on the left, that
		 * turn's question and answer above its changed files on the right. The
		 * change half comes from the recorder (memory, gone on restart); the
		 * question and answer come from the Session log (durable), which is why a
		 * turn from days ago still shows what was asked even when its comparison
		 * is no longer available.
		 * ------------------------------------------------------------------ */

		/** The state the turn browser starts from. */
		function turnsState() {
			return {
				phase: 'idle',
				error: null,
				turns: [],
				/** The turn in view. */
				selected: null,
				open: false,
				prompt: null,
				answer: null,
				detailPhase: 'idle',
				detailError: null,
				files: [],
				added: 0,
				deleted: 0,
				/** The file whose comparison is held, and its print. */
				file: null,
				filePrint: undefined,
				diff: null,
				diffPath: undefined,
				diffPhase: 'idle',
				diffError: null,
			};
		}

		/**
		 * What one turn's held detail describes.
		 *
		 * The detail is re-read when the turn changes or when its own numbers move;
		 * identity alone would freeze the pane while a running turn keeps writing.
		 */
		function detailPrint(turn, files) {
			var counts = files.map(function (file) { return [file.path, file.status, file.added, file.deleted].join(':'); }).join(',');
			return [String(turn), counts].join('\u0000');
		}

		function createTurnsController(t) {
			var listeners = new Set();
			var state = turnsState();
			var generation = 0;
			var detailGeneration = 0;
			var diffGeneration = 0;
			/** Mount epoch: a remount must not inherit the previous mount's reads. */
			var epoch = 0;

			function emit() {
				listeners.forEach(function (listener) { listener(); });
			}

			/** Publish only what the view can see (see the diff view's own patch). */
			function patch(next) {
				if (sameState(state, next)) return;
				state = Object.assign({}, state, next);
				emit();
			}

			function emptyTurn() {
				return {
					selected: null, open: false, prompt: null, answer: null,
					files: [], added: 0, deleted: 0, detailPhase: 'idle', detailError: null,
					file: null, filePrint: undefined, diff: null, diffPath: undefined,
					diffPhase: 'idle', diffError: null,
				};
			}

			var controller = {
				getSnapshot: function () { return state; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},

				/**
				 * Read the turn list, then the turn it selects.
				 *
				 * A silent read (the auto-refresh tick) never touches the turn in
				 * view: its text is already on screen and a running turn's answer is
				 * only interesting once it settles.
				 */
				load: async function (sessionId, options) {
					var silent = options !== undefined && options.silent === true;
					var current = (generation += 1);
					var started = epoch;
					var stale = function () { return current !== generation || started !== epoch; };
					if (!silent) patch(Object.assign({ phase: 'loading', error: null, turns: [] }, emptyTurn()));
					var result;
					try {
						result = await readJson(TURN_LIST_URL(sessionId), undefined);
					} catch (error) {
						if (stale()) return;
						patch(Object.assign({ phase: 'error', error: 'error.generic', turns: [] }, emptyTurn()));
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch(Object.assign({ phase: 'error', error: result.failed, turns: [] }, emptyTurn()));
						return;
					}
					var rows = Array.isArray(result.value.turns) ? result.value.turns : [];
					var keep = state.selected !== null && rows.some(function (row) { return row.turn === state.selected; });
					/* The list reads oldest first, so "nothing chosen yet" means the
					 * LATEST turn — a reader opening the tab wants the turn that just
					 * happened, and the ones before it are above. */
					var newest = rows.length > 0 ? rows[rows.length - 1].turn : null;
					var selected = keep ? state.selected : newest;
					patch({ phase: 'ready', error: null, turns: rows });
					if (selected === null) {
						if (state.selected !== null) patch(emptyTurn());
						return;
					}
					if (selected !== state.selected) {
						await controller.selectTurn(sessionId, selected);
						return;
					}
					// Same turn: refresh its detail only when its own numbers moved, so
					// a running turn keeps up without re-reading an unchanged one.
					var row = rows.find(function (entry) { return entry.turn === selected; });
					var nextPrint = detailPrint(selected, row === undefined ? [] : [{ path: '', status: '', added: row.added, deleted: row.deleted }]);
					if (!silent || nextPrint !== state.filePrint) {
						await controller.selectTurn(sessionId, selected);
					}
				},

				/** Show one turn: its question and answer, and its changed files. */
				selectTurn: async function (sessionId, turn) {
					var current = (detailGeneration += 1);
					var started = epoch;
					var stale = function () { return current !== detailGeneration || started !== epoch; };
					patch({ selected: turn, detailPhase: 'loading', detailError: null, file: null, filePrint: undefined, diff: null, diffPath: undefined, diffPhase: 'idle', diffError: null });
					var result;
					try {
						result = await readJson(TURN_DETAIL_URL(sessionId, turn), undefined);
					} catch (error) {
						if (stale()) return;
						patch({ detailPhase: 'error', detailError: 'error.generic' });
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch({ detailPhase: 'error', detailError: result.failed });
						return;
					}
					var value = result.value;
					var files = Array.isArray(value.files) ? value.files : [];
					patch({
						detailPhase: 'ready',
						detailError: null,
						open: value.open === true,
						prompt: value.prompt === null || value.prompt === undefined ? null : value.prompt,
						answer: value.answer === null || value.answer === undefined ? null : value.answer,
						files: files,
						added: value.added || 0,
						deleted: value.deleted || 0,
						filePrint: detailPrint(turn, files),
					});
					var first = files.length > 0 ? files[0].path : null;
					if (first !== null) await controller.selectFile(sessionId, first);
				},

				/** Read one changed file's comparison for the turn in view. */
				selectFile: async function (sessionId, path) {
					if (state.file === path && (state.diffPhase === 'ready' || state.diffPhase === 'loading' || state.diffPhase === 'norecord')) return;
					var file = state.files.find(function (entry) { return entry.path === path; });
					if (file === undefined) return;
					var current = (diffGeneration += 1);
					var started = epoch;
					var stale = function () { return current !== diffGeneration || started !== epoch; };
					patch({ file: path, diffPhase: 'loading', diffError: null });
					if (file.at === null || file.at === undefined) {
						/* The recorder kept no comparison for this file-turn (a log-derived
						 * edit): reading one would 404, and none is the honest answer. */
						patch({ diff: null, diffPath: undefined, diffPhase: 'norecord' });
						return;
					}
					var result;
					try {
						result = await readJson(fileUrl(SESSION, sessionId, path, file.at), undefined);
					} catch (error) {
						if (stale()) return;
						patch({ diffPhase: 'error', diffError: 'error.generic', diff: null, diffPath: undefined });
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch({ diffPhase: 'error', diffError: result.failed, diff: null, diffPath: undefined });
						return;
					}
					patch({ diffPhase: 'ready', diffPath: path, diff: result.value, diffError: null });
				},

				/** Silent re-read for the auto-refresh tick. */
				refresh: function (sessionId) {
					return controller.load(sessionId, { silent: true });
				},

				reset: function () {
					generation += 1;
					detailGeneration += 1;
					diffGeneration += 1;
					epoch += 1;
					state = Object.assign(turnsState(), {});
					emit();
				},
			};
			return controller;
		}

		function TURN_LIST_URL(sessionId) {
			return TURNS_URL + '?sessionId=' + encodeURIComponent(sessionId);
		}

		function TURN_DETAIL_URL(sessionId, turn) {
			return TURN_URL + '?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + encodeURIComponent(String(turn));
		}

		/**
		 * The turn's question, drawn as the shell draws a user message.
		 *
		 * Chat renders a direct prompt as a right-aligned bubble on
		 * `--dsw-specific-bubble` with `--dsw-radius-xl`; a review pane that drew the
		 * same words as a plain paragraph would look like a different application.
		 * The bubble owns wrapping, so the text stays one run.
		 */
		function askBlock(said, emptyCopy, truncCopy, format, label) {
			if (said === null || said === undefined) {
				return h('div', { className: 'dshdv-tvSaidBlock', 'data-said': 'ask', role: 'group', 'aria-label': label },
					h('p', { className: 'dshdv-tvEmpty' }, emptyCopy));
			}
			return h('div', { className: 'dshdv-tvSaidBlock', 'data-said': 'ask', role: 'group', 'aria-label': label },
				h('div', { className: 'dshdv-tvAskRow' },
					h('div', { className: 'dshdv-tvBubble' },
						h('span', { className: 'dshdv-tvAskText' }, said.text)),
					said.human === false
						? h('span', { className: 'dshdv-tvInjected' }, said.source)
						: null),
				said.truncated === true
					? h('p', { className: 'dshdv-tvNote' }, format(truncCopy, { count: String(said.text.length) }))
					: null);
		}

		/**
		 * The turn's answer, rendered as Markdown.
		 *
		 * The shell's own `MarkdownText` is the right renderer and is used whenever
		 * the page exposes it — same typography, same fences, same footnotes, same
		 * math. An answer must not degrade to raw Markdown SOURCE when it is absent,
		 * though, so {@link plainMarkdown} takes over: a smaller renderer covering
		 * what an answer actually contains (headings, fences, lists, quotes, rules,
		 * and inline emphasis/code/links).
		 *
		 * There is no error boundary around the shell's renderer on purpose: it is
		 * the same component the chat view draws every assistant message with, so a
		 * page where it throws is a page whose chat is already broken — a second
		 * renderer would not be the fix.
		 */
		function answerBlock(said, emptyCopy, truncCopy, format, labels, label) {
			if (said === null || said === undefined) {
				return h('div', { className: 'dshdv-tvSaidBlock', 'data-said': 'answer', role: 'group', 'aria-label': label },
					h('p', { className: 'dshdv-tvEmpty' }, emptyCopy));
			}
			var body = h('div', { className: 'dshdv-tvMarkdown' },
				MarkdownText !== null
					? h(MarkdownText, { text: said.text, labels: labels })
					: plainMarkdown(said.text));
			return h('div', { className: 'dshdv-tvSaidBlock', 'data-said': 'answer', role: 'group', 'aria-label': label }, body,
				said.truncated === true
					? h('p', { className: 'dshdv-tvNote' }, format(truncCopy, { count: String(said.text.length) }))
					: null);
		}

		/** URL schemes an answer's links may use, mirroring the shell's own allowlist. */
		var SAFE_SCHEME = /^(?:https?:|mailto:)/iu;

		/**
		 * Render one line's inline Markdown as React children.
		 *
		 * Deliberately small: emphasis, inline code and links, which is what an
		 * answer's prose actually uses. Text outside those runs is passed through
		 * verbatim, so anything unrecognized stays readable instead of being eaten.
		 *
		 * @param line - one line of Markdown.
		 * @returns the children for a block element.
		 */
		function inlineMarkdown(line) {
			var out = [];
			var pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/gu;
			var at = 0;
			var match;
			var key = 0;
			while ((match = pattern.exec(line)) !== null) {
				if (match.index > at) out.push(line.slice(at, match.index));
				var token = match[0];
				key += 1;
				if (token.charAt(0) === '`') {
					out.push(h('code', { key: 'c' + key, className: 'dshdv-mdCode' }, token.slice(1, -1)));
				} else if (token.startsWith('**') || token.startsWith('__')) {
					out.push(h('strong', { key: 'b' + key }, token.slice(2, -2)));
				} else if (token.charAt(0) === '[') {
					var split = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token);
					var target = split === null ? '' : split[2];
					var safe = SAFE_SCHEME.test(target) ? target : null;
					out.push(safe === null
						? h('span', { key: 'l' + key }, split === null ? token : split[1])
						: h('a', { key: 'l' + key, className: 'dshdv-mdLink', href: safe, target: '_blank', rel: 'noreferrer noopener' }, split[1]));
				} else {
					out.push(h('em', { key: 'i' + key }, token.slice(1, -1)));
				}
				at = match.index + token.length;
			}
			if (at < line.length) out.push(line.slice(at));
			return out;
		}

		/**
		 * A Markdown answer, rendered without the shell's renderer.
		 *
		 * Block level: fenced code (drawn with the same card vocabulary the diff
		 * uses), ATX headings, unordered and ordered lists, blockquotes and rules.
		 * Everything else becomes a paragraph, and the whole document keeps its
		 * source line breaks, so an unparsed block reads as written.
		 *
		 * @param text - the Markdown source.
		 * @returns a React element.
		 */
		function plainMarkdown(text) {
			var lines = String(text === null || text === undefined ? '' : text).split('\n');
			var blocks = [];
			var index = 0;
			var key = 0;
			var pending = [];
			var flush = function () {
				if (pending.length === 0) return;
				key += 1;
				blocks.push(h('p', { key: 'p' + key, className: 'dshdv-mdP' }, inlineMarkdown(pending.join('\n'))));
				pending = [];
			};
			while (index < lines.length) {
				var line = lines[index];
				var fence = /^\s*(?:```|~~~)(.*)$/u.exec(line);
				if (fence !== null) {
					flush();
					var language = fence[1].trim();
					var code = [];
					index += 1;
					while (index < lines.length && /^\s*(?:```|~~~)\s*$/u.test(lines[index]) === false) {
						code.push(lines[index]);
						index += 1;
					}
					index += 1;
					key += 1;
					/* The fence is drawn as the shell draws a code block: a card on
					 * `--dsw-alias-markdown-code-block` whose banner names the
					 * language, with the body on the markdown code font. */
					blocks.push(h('div', { key: 'code' + key, className: 'dshdv-code dshdv-mdFence', 'data-code-wrap': 'true' },
						language === ''
							? null
							: h('div', { className: 'dshdv-mdFenceBanner' }, h('span', { className: 'dshdv-mdFenceLang' }, language)),
						code.length === 0
							? h('div', { className: 'dshdv-line', 'data-kind': 'context' }, h('span', { className: 'dshdv-text' }, ' '))
							: code.map(function (row, rowIndex) {
								return h('div', { key: rowIndex, className: 'dshdv-line', 'data-kind': 'context' }, h('span', { className: 'dshdv-text' }, row));
							})));
					continue;
				}
				var heading = /^(#{1,6})\s+(.*)$/u.exec(line);
				if (heading !== null) {
					flush();
					key += 1;
					blocks.push(h('div', { key: 'h' + key, className: 'dshdv-mdH', 'data-level': String(heading[1].length) }, inlineMarkdown(heading[2])));
					index += 1;
					continue;
				}
				if (/^\s*(?:---|\*\*\*|___)\s*$/u.test(line)) {
					flush();
					key += 1;
					blocks.push(h('hr', { key: 'hr' + key, className: 'dshdv-mdRule' }));
					index += 1;
					continue;
				}
				var bullet = /^\s*[-*+]\s+(.*)$/u.exec(line);
				var numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
				/* A GFM table starts with a row of pipes and continues while the
				 * delimiter row under it says so; anything else is prose. */
				if (/^\s*\|.*\|\s*$/u.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(lines[index + 1])) {
					flush();
					var cells = function (row) {
						return row.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(function (cell) { return cell.trim(); });
					};
					var head = cells(line);
					index += 2;
					var body = [];
					while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index])) {
						body.push(cells(lines[index]));
						index += 1;
					}
					key += 1;
					blocks.push(h('div', { key: 'tbl' + key, className: 'dshdv-mdTableScroll' },
						h('table', { className: 'dshdv-mdTable' },
							h('thead', null, h('tr', null, head.map(function (cell, cellIndex) {
								return h('th', { key: cellIndex }, inlineMarkdown(cell));
							}))),
							h('tbody', null, body.map(function (row, rowIndex) {
								return h('tr', { key: rowIndex }, row.map(function (cell, cellIndex) {
									return h('td', { key: cellIndex }, inlineMarkdown(cell));
								}));
							})))));
					continue;
				}
				if (bullet !== null || numbered !== null) {
					flush();
					var items = [];
					var ordered = numbered !== null;
					while (index < lines.length) {
						var nextBullet = /^\s*[-*+]\s+(.*)$/u.exec(lines[index]);
						var nextNumbered = /^\s*\d+[.)]\s+(.*)$/u.exec(lines[index]);
						var item = ordered ? nextNumbered : nextBullet;
						if (item === null) break;
						items.push(h('li', { key: items.length }, inlineMarkdown(item[1])));
						index += 1;
					}
					key += 1;
					blocks.push(ordered
						? h('ol', { key: 'ol' + key, className: 'dshdv-mdList' }, items)
						: h('ul', { key: 'ul' + key, className: 'dshdv-mdList' }, items));
					continue;
				}
				var quote = /^\s*>\s?(.*)$/u.exec(line);
				if (quote !== null) {
					flush();
					var quoted = [];
					while (index < lines.length) {
						var nextQuote = /^\s*>\s?(.*)$/u.exec(lines[index]);
						if (nextQuote === null) break;
						quoted.push(nextQuote[1]);
						index += 1;
					}
					key += 1;
					blocks.push(h('blockquote', { key: 'q' + key, className: 'dshdv-mdQuote' }, inlineMarkdown(quoted.join('\n'))));
					continue;
				}
				if (/^\s*$/u.test(line)) {
					flush();
					index += 1;
					continue;
				}
				pending.push(line);
				index += 1;
			}
			flush();
			return h('div', { className: 'dshdv-md', 'data-markdown': 'builtin' }, blocks);
		}

		/** The per-turn browser: turns on the left, that turn's work on the right. */
		function TurnsView(props) {
			var controller = props.controller;
			var sessionId = props.sessionId;
			var t = props.t;
			var state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			var wrapState = React.useState(function () { return readPreference(WRAP_KEY, 'wrap') !== 'nowrap'; });
			var wrap = wrapState[0];
			/* The bottom pane is a reading pane, not the diff tab: it follows the wrap
			 * preference and stays unified, because a side-by-side split in a third of
			 * the width is narrower than the code it is trying to show. */
			var split = false;
			var tickState = React.useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];
			var activeUntil = React.useRef(0);
			var markActive = function () { activeUntil.current = Date.now() + TURNS_ACTIVE_MS; };
			/* MarkdownText memoizes its vocabulary: a fresh labels object every render
			 * would discard its streaming/fence cache, so it is built once per locale
			 * seat the way the shell's own chat view builds it. */
			var markdownLabels = React.useMemo(function () {
				return {
					code: {
						copyLabel: t('turns.copy'),
						copiedLabel: t('turns.copied'),
						toolbarLabels: { codeLabel: t('turns.code'), wrapLabel: t('turns.wrap'), unwrapLabel: t('turns.unwrap') },
					},
					footnotes: t('turns.footnotes'),
				};
			}, [t]);

			React.useEffect(function () {
				void controller.load(sessionId);
				return function () { controller.reset(); };
			}, [controller, sessionId]);

			React.useEffect(function () { markActive(); }, [state.phase, state.selected, state.detailPhase]);

			React.useEffect(function () {
				/* Self-scheduling like the diff view's tick: a refresh that found
				 * nothing new changes no state, so the loop cannot depend on one. */
				var timer = window.setTimeout(function () {
					void controller.refresh(sessionId).then(function () {
						setTick(function (value) { return value + 1; });
					});
				}, Date.now() < activeUntil.current ? TURNS_REFRESH_MS : TURNS_REFRESH_IDLE_MS);
				return function () { window.clearTimeout(timer); };
			}, [controller, sessionId, tick]);

			var rows = state.turns;
			var selectedRow = state.selected === null ? undefined : rows.find(function (row) { return row.turn === state.selected; });

			var listBody;
			if (state.phase === 'loading') {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, t('turns.list.loading')));
			} else if (state.phase === 'error') {
				listBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(state.error === null ? 'error.generic' : state.error)),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { void controller.load(sessionId); } }, t('turns.retry')));
			} else if (rows.length === 0) {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, t('turns.list.empty')));
			} else {
				listBody = rows.map(function (row) {
					var when = shellTime(t, row.time);
					return h('button', {
						key: row.turn,
						type: 'button',
						role: 'option',
						className: 'dshdv-tvRow',
						'data-turn': String(row.turn),
						'aria-selected': row.turn === state.selected,
						title: row.prompt === null ? '' : row.prompt.text,
						onClick: function () {
							markActive();
							void controller.selectTurn(sessionId, row.turn);
						},
					},
						h('span', { className: 'dshdv-tvRowTurn' }, format(t('turns.turn'), { turn: String(row.turn) })),
						row.open === true
							? (Tag !== null
								? h(Tag, { tone: 'info' }, t('turns.open'))
								: h('span', { className: 'dshdv-tvTag' }, t('turns.open')))
							: null,
						h('span', { className: 'dshdv-tvRowMeta' },
							when === null ? null : h('span', { className: 'dshdv-tvRowTime' }, when),
							row.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + row.added) : null,
							row.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + row.deleted) : null,
							row.files === 0 ? null : h('span', { className: 'dshdv-tvRowFiles' }, format(t('turns.fileCount'), { count: String(row.files) }))));
				});
			}

			/* The right column: what was said, then what it changed. */
			var said;
			if (state.phase === 'error') {
				said = null;
			} else if (state.selected === null) {
				said = h('div', { className: 'dshdv-tvSaid' }, h('div', { className: 'dshdv-status' }, h('p', null, t('turns.list.empty'))));
			} else {
				said = h('div', { className: 'dshdv-tvSaid', 'data-dsh-diff-said': '' },
					askBlock(state.prompt, t('turns.noAsk'), t('turns.truncated'), format, t('turns.ask')),
					answerBlock(state.answer, t('turns.noAnswer'), t('turns.truncated'), format, markdownLabels, t('turns.answer')));
			}

			var filesBody;
			if (state.selected === null) {
				filesBody = null;
			} else if (state.detailPhase === 'loading') {
				filesBody = h('div', { className: 'dshdv-status' }, h('p', null, t('turns.detail.loading')));
			} else if (state.detailPhase === 'error') {
				filesBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(state.detailError === null ? 'error.generic' : state.detailError)),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { void controller.selectTurn(sessionId, state.selected); } }, t('turns.retry')));
			} else if (state.files.length === 0) {
				filesBody = h('div', { className: 'dshdv-status' }, h('p', null, t('turns.noFiles')));
			} else {
				filesBody = h('div', { className: 'dshdv-tvFilesBody' },
					h('div', { className: 'dshdv-tvFileList', role: 'listbox', 'aria-label': t('turns.files'), 'data-dsh-diff-turn-files': '' },
						state.files.map(function (file) {
							var parts = splitPath(file.display || file.path);
							var letter = STATUS_LETTER[file.status] === undefined ? 'M' : STATUS_LETTER[file.status];
							return h('button', {
								key: file.path,
								type: 'button',
								role: 'option',
								className: 'dshdv-tvFile',
								'data-path': file.path,
								'aria-selected': file.path === state.file,
								title: file.path,
								onClick: function () {
									markActive();
									void controller.selectFile(sessionId, file.path);
								},
							},
								h('span', { className: 'dshdv-chip', 'data-status': file.status, 'aria-hidden': 'true' }, letter),
								h('span', { className: 'dshdv-names' },
									h('span', { className: 'dshdv-name' }, parts.name),
									parts.dir === '' ? null : h('span', { className: 'dshdv-dirName' }, parts.dir)),
								h('span', { className: 'dshdv-counts' },
									file.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + file.added) : null,
									file.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + file.deleted) : null));
						})),
					h('div', { className: 'dshdv-tvDiff' }, h(DiffBody, {
						state: state,
						t: t,
						wrap: wrap,
						split: split,
						onRetry: function () { void controller.selectFile(sessionId, state.file); },
					})));
			}

			var head = h('div', { className: 'dshdv-tvFilesHead' },
				h('span', { className: 'dshdv-tvLabel' }, t('turns.files')),
				h('span', { className: 'dshdv-summary' },
					format(t('turns.fileCount'), { count: String(state.files.length) }),
					state.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + state.added) : null,
					state.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + state.deleted) : null),
				selectedRow !== undefined && selectedRow.open === true ? h('span', { className: 'dshdv-tvTag' }, t('turns.open')) : null);

			return h('div', { className: 'dshdv-root', 'data-dsh-diff-turns': '', 'data-conversation-composer-overlay': '' },
				h('div', { className: 'dshdv-tv' },
					h('div', { className: 'dshdv-tvList' },
						h('div', { className: 'dshdv-tvListBody', role: 'listbox', 'aria-label': t('turns.label.turn') }, listBody)),
					h('div', { className: 'dshdv-tvMain' },
						said,
						h('div', { className: 'dshdv-tvFiles' }, head, filesBody))));
		}

		/* ------------------------------------------------------------------ *
		 * Diff rows
		 * ------------------------------------------------------------------ */

		/** Number a hunk's lines: context counts on both sides, deletions and additions on one. */
		function hunkRows(hunk) {
			var oldNo = hunk.oldStart;
			var newNo = hunk.newStart;
			return (hunk.lines || []).map(function (line) {
				var text = line.slice(1);
				var sign = line[0];
				if (sign === '+') return { kind: 'add', old: undefined, next: newNo++, text: text };
				if (sign === '-') return { kind: 'del', old: oldNo++, next: undefined, text: text };
				return { kind: 'context', old: oldNo++, next: newNo++, text: text };
			});
		}

		/** Pair a hunk's deletions with the additions that follow, run by run. */
		function splitRows(hunk) {
			var rows = [];
			var dels = [];
			var adds = [];
			function flush() {
				var span = Math.max(dels.length, adds.length);
				for (var at = 0; at < span; at += 1) rows.push({ left: dels[at], right: adds[at] });
				dels = [];
				adds = [];
			}
			hunkRows(hunk).forEach(function (row) {
				if (row.kind === 'del') dels.push({ no: row.old, text: row.text, kind: 'del' });
				else if (row.kind === 'add') adds.push({ no: row.next, text: row.text, kind: 'add' });
				else {
					flush();
					rows.push({
						left: { no: row.old, text: row.text, kind: 'context' },
						right: { no: row.next, text: row.text, kind: 'context' },
					});
				}
			});
			flush();
			return rows;
		}

		/** Cut the hunks at the render budget, shortening the last one it keeps. */
		function budgetedHunks(hunks) {
			var budget = MAX_RENDERED_LINES;
			var kept = [];
			var truncated = false;
			for (var at = 0; at < hunks.length; at += 1) {
				var hunk = hunks[at];
				var lines = hunk.lines || [];
				if (budget <= 0) {
					truncated = true;
					break;
				}
				if (lines.length <= budget) {
					kept.push(hunk);
					budget -= lines.length;
					continue;
				}
				kept.push(Object.assign({}, hunk, { lines: lines.slice(0, budget) }));
				budget = 0;
				truncated = true;
			}
			return { hunks: kept, truncated: truncated };
		}

		function hunkHeaderText(hunk) {
			return '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@';
		}

		/* ------------------------------------------------------------------ *
		 * Components
		 * ------------------------------------------------------------------ */

		/**
		 * One row of the file list.
		 *
		 * Memoized, and the memo is load-bearing rather than a micro-optimization:
		 * a list of a few hundred changed files re-rendered on every state patch
		 * (selection, refresh tick, diff arrival) is what made clicking a file feel
		 * heavy. The parent hands each row a primitive path and stable callbacks,
		 * and the list fold keeps unchanged entries as the same objects, so an
		 * unrelated patch now re-renders exactly the two rows whose selection
		 * flipped.
		 */
		var FileRow = React.memo(function FileRow(props) {
			var file = props.file;
			var parts = splitPath(file.display || file.path);
			var letter = STATUS_LETTER[props.status] === undefined ? 'M' : STATUS_LETTER[props.status];
			var title = statusLabel(props.t, props.status)
				+ (file.originalPath === undefined ? '' : ' ← ' + file.originalPath)
				+ (Array.isArray(file.changedTurns) && file.changedTurns.length > 0 ? '  ·  T' + file.changedTurns.join(', T') : '');
			var path = file.path;
			return h('button', {
				type: 'button',
				role: 'option',
				className: 'dshdv-row',
				'data-path': path,
				'aria-selected': props.selected,
				title: title,
				onClick: function () { props.onSelect(path); },
			},
				h('span', { className: 'dshdv-chip', 'data-status': props.status, 'aria-hidden': 'true' }, letter),
				h('span', { className: 'dshdv-names' },
					h('span', { className: 'dshdv-name' }, parts.name),
					parts.dir === '' ? null : h('span', { className: 'dshdv-dirName' }, parts.dir)),
				props.turnTag === undefined ? null : h('span', { className: 'dshdv-turnTag' }, props.turnTag),
				h('span', { className: 'dshdv-counts' },
					props.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + props.added) : null,
					props.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + props.deleted) : null));
		}, function sameRow(previous, next) {
			/* `file` keeps its identity across a silent refresh (see mergeFiles), so
			 * this comparison is what makes an unchanged row cost nothing at all.
			 * The status, counts and turn tag are separate props because an axis
			 * shows a file's numbers FOR A TURN, not its newest ones. */
			return previous.file === next.file
				&& previous.selected === next.selected
				&& previous.status === next.status
				&& previous.added === next.added
				&& previous.deleted === next.deleted
				&& previous.turnTag === next.turnTag
				&& previous.t === next.t;
		});

		/**
		 * The comparison body: hunks, their notes, or the state that stands in for them.
		 *
		 * Memoized on the values it actually draws, not on the state object it is
		 * handed — every patch (a refresh tick, the copy acknowledgement, a filter
		 * keystroke) hands it a NEW object, and a diff is the largest subtree in
		 * this view. Without this the whole comparison is reconciled on every tick
		 * even when every value is identical, which is what a reader feels as
		 * stutter once a big file is on screen.
		 */
		var DiffBody = React.memo(function DiffBody(props) {
			var state = props.state;
			var t = props.t;
			/* Loading stands in only when there is nothing to stand in FOR. A
			 * comparison already held — the file being re-read after its numbers
			 * moved, or the previous file's while the next one is in flight — stays
			 * on screen, marked busy rather than blanked, so clicking a row never
			 * makes the pane flash through an empty state. */
			if (state.diffPhase === 'loading' && state.diff === null) {
				return h('div', { className: 'dshdv-status', role: 'status' }, h('p', null, t('diff.loading')));
			}
			if (state.diffPhase === 'norecord') {
				return h('div', { className: 'dshdv-status' }, h('p', null, t('diff.norecord')));
			}
			if (state.diffPhase === 'error') {
				return h('div', { className: 'dshdv-status' },
					h('p', null, t(state.diffError === null ? 'error.generic' : state.diffError)),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: props.onRetry }, t('error.retry')));
			}
			var diff = state.diff;
			if (diff === null) {
				return h('div', { className: 'dshdv-status' }, h('p', null, t('diff.empty')));
			}
			if (diff.kind === 'binary') return h('div', { className: 'dshdv-status' }, h('p', null, t('diff.binary')));
			if (diff.kind === 'oversized') return h('div', { className: 'dshdv-status' }, h('p', null, t('diff.oversized')));
			var hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
			var note = null;
			if (diff.before === false) note = 'diff.created';
			else if (diff.after === false) note = 'diff.deleted';
			else if (hunks.length === 0) note = 'diff.unchanged';
			var budget = budgetedHunks(hunks);
			if (hunks.length === 0) {
				return h('div', { className: 'dshdv-status' },
					h('p', null, note === null ? t('diff.none') : t(note)));
			}
			var single = isOneSided(hunks);
			var body = [];
			if (note !== null) body.push(h('p', { key: 'note', className: 'dshdv-note', 'data-diff-note': note }, t(note)));
			if (diff.coarse === true) body.push(h('p', { key: 'coarse', className: 'dshdv-note' }, t('diff.coarse')));
			if (budget.truncated) body.push(h('p', { key: 'cut', className: 'dshdv-note' }, format(t('diff.truncated'), { count: MAX_RENDERED_LINES })));
			budget.hunks.forEach(function (hunk, index) {
				body.push(props.split && !single
					? h(SplitHunk, { key: index, hunk: hunk, wrap: props.wrap })
					: h(UnifiedHunk, { key: index, hunk: hunk, wrap: props.wrap }));
			});
			var busy = state.diffPhase === 'loading';
			var scrollClass = 'dshdv-scroll' + (busy ? ' dshdv-busy' : '');
			return h('div', {
				className: scrollClass,
				'data-diff-view': props.split && !single ? 'split' : 'unified',
				'data-diff-busy': busy ? '' : undefined,
				'aria-busy': busy ? 'true' : undefined,
			}, h('div', {
				/* The shell's own wrap switch is an attribute on the card, not a class
				 * on every row: same vocabulary as `ui-primitives`' DiffBlock. */
				className: 'dshdv-code',
				'data-code-wrap': props.wrap ? 'true' : 'false',
			}, body));
		}, function sameComparison(previous, next) {
			/* Exactly the inputs DiffBody reads — and they live on `state`, which is
			 * a fresh object on every patch and must never take part in this
			 * comparison itself. Comparing a prop that does not exist (`diff`) once
			 * let this bail out forever: the pane kept showing the previous
			 * comparison whenever the new one arrived in the same phase. */
			return previous.state.diff === next.state.diff
				&& previous.state.diffPhase === next.state.diffPhase
				&& previous.state.diffError === next.state.diffError
				&& previous.wrap === next.wrap
				&& previous.split === next.split
				&& previous.t === next.t;
		});

		/** Whether a comparison only adds or only removes lines. */
		function isOneSided(hunks) {
			var adds = false;
			var dels = false;
			hunks.forEach(function (hunk) {
				(hunk.lines || []).forEach(function (line) {
					if (line[0] === '+') adds = true;
					else if (line[0] === '-') dels = true;
				});
			});
			return adds !== dels;
		}

		/**
		 * One hunk as the shell draws a diff.
		 *
		 * The line's kind becomes a row attribute and the sign becomes a `::before`
		 * prefix, exactly as `ui-primitives`' own `DiffBlock` does it — the change
		 * bar, the tinted background and the `- `/`+ ` text all come from that one
		 * attribute, so a row is a single element instead of a gutter of four.
		 *
		 * Memoized on the hunk object itself: the server's answer is kept whole
		 * across a refresh that changed nothing, so an unchanged hunk keeps its
		 * identity and the rows inside it are never rebuilt. This is what makes a
		 * comparison cost its size ONCE instead of once per tick.
		 */
		var UnifiedHunk = React.memo(function UnifiedHunk(props) {
			var rows = hunkRows(props.hunk);
			return h('section', { className: 'dshdv-hunk' },
				h('div', { className: 'dshdv-hunkHeader' }, hunkHeaderText(props.hunk)),
				rows.map(function (row, index) {
					return h('div', { key: index, className: 'dshdv-line', 'data-kind': row.kind },
						h('span', { className: 'dshdv-text' }, row.text));
				}));
		}, function sameHunk(previous, next) {
			return previous.hunk === next.hunk && previous.wrap === next.wrap;
		});

		/** One hunk as paired cells, memoized for the same reason as {@link UnifiedHunk}. */
		var SplitHunk = React.memo(function SplitHunk(props) {
			var rows = splitRows(props.hunk);
			return h('section', { className: 'dshdv-hunk' },
				h('div', { className: 'dshdv-hunkHeader' }, hunkHeaderText(props.hunk)),
				rows.map(function (row, index) {
					return h('div', { key: index, className: 'dshdv-line dshdv-split' },
						h('span', { className: 'dshdv-splitCell', 'data-kind': row.left === undefined ? undefined : row.left.kind, 'data-empty': row.left === undefined },
							h('span', { className: 'dshdv-text' }, row.left === undefined ? '' : row.left.text)),
						h('span', { className: 'dshdv-splitCell', 'data-kind': row.right === undefined ? undefined : row.right.kind, 'data-empty': row.right === undefined },
							h('span', { className: 'dshdv-text' }, row.right === undefined ? '' : row.right.text)));
				}));
		}, function sameHunk(previous, next) {
			return previous.hunk === next.hunk && previous.wrap === next.wrap;
		});

		/** The whole view: scope bar, file list, comparison. */
		function DiffView(props) {
			var controller = props.controller;
			var sessionId = props.sessionId;
			var t = props.t;
			var state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			var wrapState = React.useState(function () { return readPreference(WRAP_KEY, 'wrap') !== 'nowrap'; });
			var wrap = wrapState[0];
			var setWrap = wrapState[1];
			var splitState = React.useState(false);
			var split = splitState[0];
			var setSplit = splitState[1];
			var autoState = React.useState(true);
			var auto = autoState[0];
			var setAuto = autoState[1];
			var filterState = React.useState('');
			var filter = filterState[0];
			var setFilter = filterState[1];
			var copiedState = React.useState(false);
			var copied = copiedState[0];
			var setCopied = copiedState[1];

			/**
			 * When the reader last did something.
			 *
			 * A diff view is only "live" while someone is working in the tree, so
			 * the auto-refresh keeps the quick cadence for a while after any
			 * interaction or fresh answer and then backs off to a slow one. Nothing
			 * on screen changes at either cadence unless the answer differs.
			 */
			var activeUntil = React.useRef(0);
			var markActive = function () {
				activeUntil.current = Date.now() + AUTO_REFRESH_ACTIVE_MS;
			};

			React.useEffect(function () {
				void controller.load(sessionId);
				return function () {
					controller.reset();
				};
			}, [controller, sessionId]);

			React.useEffect(function () {
				// A fresh phase or a different number of files is a new picture.
				markActive();
			}, [state.phase, state.files.length]);

			/* An armed checkpoint disarms itself: a button that stays armed is a
			 * button that commits something the reader has stopped thinking about. */
			React.useEffect(function () {
				if (state.commitPhase !== 'confirm') return undefined;
				var timer = window.setTimeout(function () { controller.cancelCommit(); }, 4000);
				return function () { window.clearTimeout(timer); };
			}, [controller, state.commitPhase]);

			/* One counter per completed auto-refresh tick: the loop needs a state
			 * change to schedule its next read, and a refresh that found nothing
			 * new deliberately produces none. */
			var tickState = React.useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];

			React.useEffect(function () {
				if (!auto) return undefined;
				/* A hidden page does not need the active cadence: nothing is being
				 * looked at, and a background tab should not poll a tree. */
				var active = Date.now() < activeUntil.current;
				var delay = !active || document.hidden ? AUTO_REFRESH_IDLE_MS : AUTO_REFRESH_MS;
				var timer = window.setTimeout(function () {
					if (!document.hidden) void controller.refresh(sessionId);
					/* The next read is scheduled from the tick itself, and the tick is
					 * NOT activity: a reader who stops interacting, or a tree that
					 * stops moving, has to be able to fall back to the slow cadence. */
					setTick(tick + 1);
				}, delay);
				return function () {
					window.clearTimeout(timer);
				};
			}, [auto, controller, sessionId, tick]);

			React.useEffect(function () {
				if (!copied) return undefined;
				var timer = window.setTimeout(function () { setCopied(false); }, 1400);
				return function () { window.clearTimeout(timer); };
			}, [copied]);

			var files = state.files;
			/* The pool the turn axis leaves: this turn's files, or the files that
			 * exist as of the bound. The search box narrows it further, and the detail
			 * pane follows it — so a file the chosen axis excludes shows the empty
			 * state rather than another turn's comparison. */
			var pool = visibleFiles(files, state);
			var stateView = state.scope === SESSION && state.viewMode === STATE_MODE;
			var deletedCount = stateView ? stateAt(files, boundTurn(state)).deleted : 0;
			var needle = filter.trim().toLowerCase();
			var visible = needle === ''
				? pool
				: pool.filter(function (file) {
					return (file.display || file.path).toLowerCase().indexOf(needle) !== -1
						|| file.path.toLowerCase().indexOf(needle) !== -1;
				});
			var selectedFile = state.selected === null
				? undefined
				: pool.find(function (file) { return file.path === state.selected; });
			var selectedFacts = selectedFile === undefined ? undefined : factsForView(selectedFile, state);
			var selectedTurn = selectedFile === undefined ? undefined : changeTurnFor(selectedFile, state);
			var notice = noticeFor(state, t);

			/**
			 * Choose a file. Stable across renders (and takes the path as its
			 * argument) precisely so the memoized rows are not invalidated by a
			 * fresh closure on every patch.
			 */
			var onSelect = React.useCallback(function (path) {
				markActive();
				void controller.select(sessionId, path);
			}, [controller, sessionId]);

			/**
			 * One turn chip: how many files that turn accounts for, and whether it is
			 * the one being viewed. `null` is the aggregate view.
			 *
			 * The count follows the axis: the turn's own files in the delta view, every
			 * file changed up to it in the state view — so the strip reads as a
			 * timeline either way.
			 */
			function turnChip(turn, label, count) {
				return h('button', {
					key: turn === null ? 'all' : String(turn),
					type: 'button',
					className: 'dshdv-turn',
					'data-turn': turn === null ? 'all' : String(turn),
					'aria-pressed': state.viewTurn === turn,
					onClick: function () {
						markActive();
						void controller.setTurn(sessionId, turn);
					},
				}, label, h('span', { className: 'dshdv-turnCount' }, String(count)));
			}

			/** One axis chip: which question the turn strip's numbers answer. */
			function modeChip(mode, label, title) {
				return h('button', {
					key: mode,
					type: 'button',
					className: 'dshdv-turn',
					'data-mode': mode,
					title: title,
					'aria-pressed': state.viewMode === mode,
					onClick: function () {
						markActive();
						void controller.setMode(sessionId, mode);
					},
				}, label);
			}

			/** How many files one chip accounts for, under the axis in force. */
			function countFor(turn) {
				if (!stateView) return filesForTurn(files, turn).length;
				return turn === null ? stateAt(files, boundTurn(state)).rows.length : stateAt(files, turn).rows.length;
			}

			function selectScope(scope) {
				markActive();
				void controller.setScope(scope, sessionId);
			}

			function copyPath() {
				if (selectedFile === undefined) return;
				var text = selectedFile.path;
				try {
					if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
						void navigator.clipboard.writeText(text);
					}
					setCopied(true);
				} catch (error) {
					/* an unavailable clipboard costs the acknowledgement, not the view */
				}
			}

			/* The list pane: one state of four — reading, failed, empty, or rows. */
			var listBody;
			if (state.phase === 'loading') {
				listBody = h('div', { className: 'dshdv-status', role: 'status' }, h('p', null, t('list.loading')));
			} else if (state.phase === 'error') {
				listBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(state.error === null ? 'error.generic' : state.error)),
					h('button', {
						type: 'button', className: 'dshdv-btn',
						onClick: function () { void controller.load(sessionId); },
					}, t('error.retry')));
			} else if (visible.length === 0) {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, needle === '' ? t('list.empty') : t('list.emptyFiltered')));
			} else {
				listBody = visible.map(function (file) {
					var facts = factsForView(file, state);
					var changed = stateView ? changeTurnFor(file, state) : undefined;
					return h(FileRow, {
						key: file.path, file: file, t: t, selected: file.path === state.selected,
						status: facts.status, added: facts.added, deleted: facts.deleted,
						turnTag: changed === undefined ? undefined : format(t('turn.tag'), { turn: String(changed) }),
						onSelect: onSelect,
					});
				});
			}
			var listPane = h('div', { className: 'dshdv-list' },
				h('div', {
					className: 'dshdv-listBody', role: 'listbox', 'aria-label': t('view.label'), 'data-dsh-diff-list': '',
				}, listBody));

			/**
			 * The detail pane: the selected file's comparison behind its header.
			 *
			 * This wrapper is load-bearing, not decoration: `.dshdv-main` is the
			 * row that places the file list beside the comparison, so the header
			 * and the scrolling body have to arrive as ONE child or they become
			 * siblings of the list and fight it for width. A fragment here would
			 * splice them into that row — which is exactly the bug this replaced.
			 */
			var detailBody;
			if (selectedFile === undefined) {
				detailBody = h('div', { className: 'dshdv-status' },
					h('span', { 'aria-hidden': 'true' }, icon(ICON_EMPTY)),
					h('p', null, t('diff.empty')));
			} else {
				var counts = [
					statusLabel(t, selectedFacts.status),
					selectedFacts.added > 0 ? h('span', { key: 'add', className: 'dshdv-add' }, '+' + selectedFacts.added) : null,
					selectedFacts.deleted > 0 ? h('span', { key: 'del', className: 'dshdv-del' }, '−' + selectedFacts.deleted) : null,
				];
				var tools = h('span', { className: 'dshdv-headTools' },
					h('button', {
						type: 'button', className: 'dshdv-btn', 'aria-pressed': split,
						title: split ? t('action.unified') : t('action.split'), 'aria-label': t('action.split'),
						'data-dsh-diff-split': split ? 'on' : 'off',
						onClick: function () { setSplit(!split); },
					}, icon(ICON_SPLIT)),
					h('button', {
						type: 'button', className: 'dshdv-btn', 'aria-pressed': wrap,
						title: wrap ? t('action.nowrap') : t('action.wrap'), 'aria-label': t('action.wrap'),
						'data-dsh-diff-wrap': wrap ? 'on' : 'off',
						onClick: function () {
							var next = !wrap;
							setWrap(next);
							writePreference(WRAP_KEY, next ? 'wrap' : 'nowrap');
						},
					}, icon(ICON_WRAP)),
					h('button', {
						type: 'button', className: 'dshdv-btn', title: copied ? t('action.copied') : t('action.copy'),
						'aria-label': t('action.copy'), 'data-dsh-diff-copy': copied ? 'copied' : '',
						onClick: copyPath,
					}, icon(ICON_COPY)));
				detailBody = [
					h('div', { key: 'head', className: 'dshdv-head' },
						h('span', {
							className: 'dshdv-headPath', title: selectedFile.path, 'data-dsh-diff-path': selectedFile.path,
						}, selectedFile.display || selectedFile.path),
						h('span', { className: 'dshdv-summary' }, counts),
						stateView && selectedTurn !== undefined
							? h('span', { className: 'dshdv-turnTag' }, format(t('turn.lastChange'), { turn: String(selectedTurn) }))
							: null,
						state.diffPhase === 'loading' ? h('span', { className: 'dshdv-headBusy', role: 'status' }, t('diff.loading')) : null,
						tools),
					h(DiffBody, {
						key: 'body',
						state: state, t: t, wrap: wrap, split: split,
						onRetry: function () {
							if (state.selected !== null) void controller.select(sessionId, state.selected);
						},
					}),
				];
			}
			var detailPane = h('div', { className: 'dshdv-body' }, detailBody);

			return h('div', { className: 'dshdv-root', 'data-dsh-diff-view': state.scope, 'data-conversation-composer-overlay': '' },
				h('div', { className: 'dshdv-bar' },
					h('div', { className: 'dshdv-tabs', role: 'tablist', 'aria-label': t('view.label') },
						h('button', {
							type: 'button', role: 'tab', className: 'dshdv-tab', 'data-scope': GIT,
							'aria-selected': state.scope === GIT, title: t('scope.git.title'),
							onClick: function () { selectScope(GIT); },
						}, t('scope.git')),
						h('button', {
							type: 'button', role: 'tab', className: 'dshdv-tab', 'data-scope': SESSION,
							'aria-selected': state.scope === SESSION, title: t('scope.session.title'),
							onClick: function () { selectScope(SESSION); },
						}, t('scope.session'))),
					h('span', { className: 'dshdv-summary', 'data-dsh-diff-summary': '' },
						format(t('summary.files'), { count: pool.length }),
						stateView
							? (deletedCount > 0 ? h('span', { className: 'dshdv-del' }, format(t('summary.deletedFiles'), { count: deletedCount })) : null)
							: h(React.Fragment, null,
								h('span', { className: 'dshdv-add' }, format(t('summary.added'), { count: state.totals.added })),
								h('span', { className: 'dshdv-del' }, format(t('summary.deleted'), { count: state.totals.deleted })))),
					h('span', { className: 'dshdv-barSpacer' }),
					h('span', { className: 'dshdv-filter' },
						h('input', {
							type: 'search', value: filter, placeholder: t('filter.placeholder'),
							'aria-label': t('filter.placeholder'), 'data-dsh-diff-filter': '',
							onChange: function (event) { setFilter(event.target.value); },
						}),
						filter === '' ? null : h('button', {
							type: 'button', className: 'dshdv-filterClear', 'aria-label': t('filter.clear'),
							onClick: function () { setFilter(''); },
						}, '×')),
					h('button', {
						type: 'button', className: 'dshdv-btn', 'aria-pressed': auto,
						title: auto ? t('action.auto.on') : t('action.auto.off'), 'aria-label': t('action.auto'),
						'data-dsh-diff-auto': auto ? 'on' : 'off',
						onClick: function () { setAuto(!auto); },
					}, h('span', { 'aria-hidden': 'true' }, auto ? '●' : '○')),
					h('button', {
						type: 'button', className: 'dshdv-btn', title: t('action.refresh'), 'aria-label': t('action.refresh'),
						'data-dsh-diff-refresh': '',
						onClick: function () { void controller.refresh(sessionId); },
					}, icon(ICON_REFRESH)),
					/* The one write action. Two presses, because a commit is a
					 * decision about history: the first arms it and names what will
					 * happen, the second performs it — and it disarms itself when the
					 * reader moves on. */
					h('button', {
						type: 'button',
						className: 'dshdv-btn',
						'data-dsh-diff-commit': state.commitPhase,
						'data-phase': state.commitPhase,
						'aria-pressed': state.commitPhase === 'confirm',
						disabled: state.commitPhase === 'busy',
						title: t('commit.title'),
						'aria-label': t('commit.action'),
						onClick: function () {
							markActive();
							if (state.commitPhase === 'confirm') {
								void controller.commit(sessionId, state.viewTurn === null ? state.turn : state.viewTurn);
								return;
							}
							controller.armCommit();
						},
					},
						state.commitPhase === 'busy'
							? '…'
							: state.commitPhase === 'confirm'
								? t('commit.confirm')
								: icon(ICON_COMMIT))),

				state.scope === SESSION && state.turns.length > 0
					? h('div', {
						className: 'dshdv-turns', role: 'group', 'aria-label': t('turn.label'), 'data-dsh-diff-turns': '',
					},
						turnChip(null, t('turn.all'), countFor(null)),
						state.turns.map(function (turn) {
							return turnChip(turn, format(t('turn.chip'), { turn: String(turn) }), countFor(turn));
						}),
						h('span', { className: 'dshdv-turnsSpacer' }),
						h('span', { className: 'dshdv-modes', role: 'group', 'aria-label': t('mode.label'), 'data-dsh-diff-modes': '' },
							modeChip(DELTA_MODE, t('mode.delta'), t('mode.delta.title')),
							modeChip(STATE_MODE, t('mode.state'), t('mode.state.title'))))
					: null,

				notice === null ? null : h('p', { className: 'dshdv-note', 'data-dsh-diff-notice': notice }, t(notice)),

				state.commitNote === null
					? null
					: h('p', {
						className: 'dshdv-note',
						'data-dsh-diff-commit-note': state.commitNote.key,
						'data-phase': state.commitPhase,
						role: 'status',
					}, format(t(state.commitNote.key), state.commitNote.values)),

				h('div', { className: 'dshdv-main' }, listPane, detailPane));
		}

		/**
		 * The one standing explanation this state deserves, if any.
		 *
		 * Deliberately narrow: it covers the three shapes where the scope itself
		 * cannot answer (no repository, no git, nothing recorded), and stays out
		 * of the way otherwise. An ordinary error is the list's own state, not a
		 * banner.
		 */
		function noticeFor(state, t) {
			if (state.phase !== 'ready') return null;
			if (state.scope === GIT && state.repo === null) return 'notice.notRepo';
			if (state.scope === SESSION && state.files.length === 0) return 'notice.noSession';
			return null;
		}

		/* ------------------------------------------------------------------ *
		 * The shell's own primitives
		 * ------------------------------------------------------------------ */

		/**
		 * Load the shell's UI primitives, when the page exposes them.
		 *
		 * A plugin that re-implements the shell's markdown renderer, its badges or
		 * its relative-time wording cannot stay in step with it: a turn's answer IS
		 * Markdown, and the shell already renders Markdown — with the same
		 * typography, the same code fences, the same footnote chrome. So the
		 * primitives are used where they exist and the plain fallbacks below are
		 * used where they do not, which is also what keeps this bundle loadable in a
		 * page that predates them.
		 */
		function loadPrimitives() {
			try {
				var loaded = require('@deepseek-ai/dsh-client-ui-primitives');
				return loaded === null || loaded === undefined ? {} : loaded;
			} catch (error) {
				console.error('[dsh-diff-view] the shell UI primitives are unavailable:', error);
				return {};
			}
		}

		/**
		 * Whether a seed-word export is something React can render.
		 *
		 * A component is NOT always a function: `React.memo`, `forwardRef` and
		 * `lazy` all answer an OBJECT carrying `$$typeof`. Testing `typeof ===
		 * 'function'` therefore rejects the shell's real `MarkdownText` — which is
		 * `memo(...)` — while accepting a plain-function stand-in, so the guard
		 * silently mis-read production and passed every test written against a stub
		 * of the wrong shape. That mistake is why a page with the shell's renderer
		 * available still showed raw Markdown.
		 *
		 * @param value - a seed-word export.
		 * @returns true when `React.createElement` can render it.
		 */
		function isRenderable(value) {
			if (typeof value === 'function') return true;
			return typeof value === 'object' && value !== null && value.$$typeof !== undefined;
		}

		var PRIMITIVES = loadPrimitives();
		var MarkdownText = isRenderable(PRIMITIVES.MarkdownText) ? PRIMITIVES.MarkdownText : null;
		var Tag = isRenderable(PRIMITIVES.Tag) ? PRIMITIVES.Tag : null;
		var ShellrelativeTime = typeof PRIMITIVES.relativeTime === 'function' ? PRIMITIVES.relativeTime : null;

		/**
		 * One timestamp, worded the way the shell words it.
		 *
		 * `relativeTime` answers a bucket (`{ unit, n }`) rather than a string, so the
		 * wording stays with the caller — these are the same buckets and the same
		 * words the shell's own session rows use, which is what makes two surfaces
		 * naming the same moment agree. Without the primitive, the absolute clock is
		 * used rather than inventing a phrasing.
		 */
		function shellTime(t, time) {
			if (typeof time !== 'number' || time <= 0) return null;
			if (ShellrelativeTime !== null) {
				try {
					var said = ShellrelativeTime(time, Date.now());
					var unit = said === null || said === undefined ? undefined : said.unit;
					var count = said === null || said === undefined ? undefined : said.n;
					if (typeof unit === 'string' && typeof count === 'number') {
						if (unit === 'now') return t('time.now');
						var span = t('time.' + unit, { n: count });
						if (typeof span === 'string' && span !== 'time.' + unit) return t('time.ago', { t: span });
					}
				} catch (error) {
					/* a different primitives revision costs the wording, not the row */
				}
			}
			var at = new Date(time);
			var pad = function (part) { return part < 10 ? '0' + part : String(part); };
			return pad(at.getHours()) + ':' + pad(at.getMinutes());
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		/** Services this browser half needs before `apply` runs. */
		var inject = ['slots', 'locale'];

		/**
		 * Bind this plugin's copy, falling back to the built-in dictionary when
		 * the locale service is unavailable: a plugin must not take the shell
		 * down over a missing service.
		 */
		function createTranslator(ctx) {
			var fallback = STRINGS.zh;
			var bound;
			try {
				ctx.locale.register(NAMESPACE, STRINGS);
				bound = ctx.locale.bind(NAMESPACE);
			} catch (error) {
				console.error('[dsh-diff-view] locale unavailable:', error);
			}
			return function (key) {
				var value = bound === undefined ? undefined : bound(key);
				if (typeof value === 'string' && value !== '' && value !== key) return value;
				return Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
			};
		}

		function apply(ctx) {
			ensureStyles();
			var t = createTranslator(ctx);
			var controllers = new Map();
			var turnControllers = new Map();

			/**
			 * One controller per Session, so switching Sessions keeps each one's
			 * own list and comparison instead of re-reading on every switch.
			 */
			function controllerFor(sessionId) {
				var existing = controllers.get(sessionId);
				if (existing !== undefined) return existing;
				var created = createController();
				controllers.set(sessionId, created);
				return created;
			}

			/** The same, for the per-turn browser. */
			function turnsFor(sessionId) {
				var existing = turnControllers.get(sessionId);
				if (existing !== undefined) return existing;
				var created = createTurnsController(t);
				turnControllers.set(sessionId, created);
				return created;
			}

			ctx.effect(function () {
				try {
					return ctx.slots.inject('conversation.view', function () {
						return ctx.slots.register({
							name: 'conversation.view',
							id: VIEW_ID,
							/* After the shipped Chat (0) and Trajectory (10), so the
							 * strip reads conversation → trajectory → changes. */
							order: 20,
							locale: NAMESPACE,
							label: function () { return t('view.label'); },
							inject: function (sessionId) {
								return { controller: controllerFor(sessionId) };
							},
						}, DiffView);
					});
				} catch (error) {
					console.error('[dsh-diff-view] failed to register the diff view:', error);
					return undefined;
				}
			}, NAMESPACE + ': view tab');

			ctx.effect(function () {
				try {
					return ctx.slots.inject('conversation.view', function () {
						return ctx.slots.register({
							name: 'conversation.view',
							id: TURNS_ID,
							/* Right after the changes tab: the same Session, read as
							 * a conversation instead of as a tree. */
							order: 21,
							locale: NAMESPACE,
							label: function () { return t('turns.label'); },
							inject: function (sessionId) {
								return { controller: turnsFor(sessionId) };
							},
						}, TurnsView);
					});
				} catch (error) {
					console.error('[dsh-diff-view] failed to register the turn view:', error);
					return undefined;
				}
			}, NAMESPACE + ': turn tab');

			ctx.effect(function () {
				return function () {
					controllers.clear();
					turnControllers.clear();
				};
			}, NAMESPACE + ': controllers');
		}

		/* ------------------------------------------------------------------ *
		 * Module exports
		 *
		 * The module table materializes this factory through its CJS shim, so the
		 * plugin's face is what lands on `module.exports`.
		 * ------------------------------------------------------------------ */

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
