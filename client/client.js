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
		/** The file view's id: the working tree, with an editor. */
		var FILES_ID = 'files';
		/** How often the turn browser re-reads its list while it is on screen. */
		var TURNS_REFRESH_MS = 15_000;
		/** Its idle cadence: a turn list changes at turn boundaries, not every second. */
		var TURNS_REFRESH_IDLE_MS = 30_000;
		/** How long the reader's activity keeps the faster cadence alive. */
		var TURNS_ACTIVE_MS = 30_000;
		/** How long a silent auto-refresh waits between reads while the reader is active. */
		var AUTO_REFRESH_MS = 15_000;
		/** The idle cadence: still fresh, but no longer every few seconds. */
		var AUTO_REFRESH_IDLE_MS = 60_000;
		/**
		 * How long the active cadence holds after the reader last did something.
		 *
		 * A diff view is only "live" while someone is working in the tree; once
		 * the reader has been looking at the same picture for half a minute, a
		 * four-second poll is churn, not freshness.
		 */
		var AUTO_REFRESH_ACTIVE_MS = 30000;
		/**
		 * Where the reader's standing choice about polling lives.
		 *
		 * The default is OFF, and that is a correction rather than a taste: the first
		 * version polled every four seconds AND re-armed its own "active" window
		 * whenever a read brought something new, so the intended back-off to the slow
		 * cadence could never happen — the pane refreshed itself forever. Nothing
		 * here needs a timer: a review pane wants a read when the reader returns to
		 * it, after an action, and when they ask for one.
		 */
		var AUTO_KEY = NAMESPACE + '.auto';
		/**
		 * Which end of the history the list starts from.
		 *
		 * The page itself is always READ newest-first, because that is what `git log`
		 * answers and what a reader usually wants; this choice reverses the page on
		 * screen. It is therefore "early to late WITHIN the loaded page", and the
		 * label says so rather than pretending the whole history was re-read.
		 */
		var ORDER_KEY = NAMESPACE + '.historyOrder';
		/** Largest number of diff lines drawn for one file. */
		var MAX_RENDERED_LINES = 4000;
		/** Where the wrap preference lives (per browser, like the shell's own). */
		var WRAP_KEY = NAMESPACE + '.wrap';
		/**
		 * Where the last scope lives, so reopening the tab lands where it left.
		 *
		 * The session scope is no longer reachable from the UI (see the README's
		 * known-leftovers note); the key stays while the controller's session-scope
		 * reads do.
		 */
		var SCOPE_KEY = NAMESPACE + '.scope';
		/** Where the two divider positions live, so a reader's layout survives a reload. */
		var LEFT_WIDTH_KEY = NAMESPACE + '.leftWidth';
		/** The share of the left column given to the commit list, as a percentage. */
		var LEFT_SPLIT_KEY = NAMESPACE + '.leftSplit';
		/** How narrow, and how wide, the left column may be dragged. */
		var LEFT_WIDTH_MIN = 180;
		var LEFT_WIDTH_MAX = 720;
		/** How much of the left column the commit list may keep, as a percentage. */
		var LEFT_SPLIT_MIN = 15;
		var LEFT_SPLIT_MAX = 85;

		/**
		 * Drag one divider, writing a CSS variable rather than React state.
		 *
		 * A drag emits a pointer move per frame; re-rendering the pane for each of
		 * them is exactly the cost this view was built to avoid. So the geometry goes
		 * to the container's own custom property during the gesture — a style write,
		 * no render — and the preference is persisted once, on release.
		 *
		 * @param options - `{ axis, container(), startValue(), clamp(value), onCommit(value) }`.
		 * @returns the pointer-down handler.
		 */
		function dividerDrag(options) {
			return function (event) {
				if (event.button !== undefined && event.button !== 0) return;
				event.preventDefault();
				var node = options.container();
				if (node === null || node === undefined) return;
				var start = options.startValue();
				var from = options.axis === 'x' ? event.clientX : event.clientY;
				var moved = null;
				var handle = event.currentTarget;
				if (handle !== null && handle !== undefined && typeof handle.setPointerCapture === 'function') {
					try { handle.setPointerCapture(event.pointerId); } catch (error) { /* capture is a nicety */ }
				}
				if (handle !== null && handle !== undefined && handle.setAttribute !== undefined) handle.setAttribute('data-dragging', 'true');
				var onMove = function (moveEvent) {
					var at = options.axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
					moved = options.clamp(start + (at - from));
					options.apply(node, moved);
				};
				var onUp = function () {
					window.removeEventListener('pointermove', onMove);
					window.removeEventListener('pointerup', onUp);
					if (handle !== null && handle !== undefined && handle.setAttribute !== undefined) handle.setAttribute('data-dragging', 'false');
					if (moved !== null) options.onCommit(moved);
				};
				window.addEventListener('pointermove', onMove);
				window.addEventListener('pointerup', onUp);
			};
		}
		/** Where the session scope's axis lives (this turn's changes vs the state after it). */
		var MODE_KEY = NAMESPACE + '.mode';

		var FILES_URL = '/api/dsh-diff/files';
		var FILE_URL = '/api/dsh-diff/file';
		var COMMIT_URL = '/api/dsh-diff/commit';
		var TURNS_URL = '/api/dsh-diff/turns';
		var TURN_URL = '/api/dsh-diff/turn';
		/** The file view's three routes: one directory level, one file, one save. */
		var ROUTES_TREE = '/api/dsh-diff/tree';
		var ROUTES_READ = '/api/dsh-diff/read';
		var WRITE_URL = '/api/dsh-diff/write';
		/** Raw bytes for a preview frame or a download. */
		var ROUTES_RAW = '/api/dsh-diff/raw';
		/** The history browser: the commit list, and one commit in full. */
		var ROUTES_COMMITS = '/api/dsh-diff/commits';
		var ROUTES_COMMIT_DETAIL = '/api/dsh-diff/commit-detail';
		/** How many commits one page of history holds. */
		var HISTORY_PAGE = 40;

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
				'files.label': '文件',
				'files.root': '工作目录',
				'files.loading': '正在读取…',
				'files.empty': '这个目录是空的',
				'files.truncated': '目录过大，只列出了前 {count} 项',
				'files.noTabs': '从左侧选择一个文件打开',
				'files.dirty': '未保存',
				'files.save': '保存',
				'files.saved': '已保存',
				'files.saving': '正在保存…',
				'files.saveFailed': '保存失败：{detail}',
				'files.conflict': '磁盘上的这个文件已经变了，没有覆盖',
				'files.overwrite': '仍然覆盖',
				'files.reload': '重新载入',
				'files.reloaded': '已重新载入',
				'files.binary': '二进制文件，不能在这里编辑',
				'files.oversized': '文件太大，不能在这里打开（上限 {count} 字节）',
				'files.unsavedConfirm': '{name} 有未保存的修改，确定关闭吗？',
				'files.highlight': '高亮',
				'files.edit': '编辑',
				'files.refresh': '刷新目录',
				'files.close': '关闭',
				'files.modified': '已修改',
				'files.fileCount': '{count} 个标签',
				'files.mode': '显示方式',
				'files.mode.preview': '预览',
				'files.mode.split': '并排',
				'files.mode.edit': '编辑',
				'files.openInShell': '用外壳预览器打开',
				'files.openFailed': '外壳的预览器现在不可用',
				'files.download': '下载',
				'files.foreign': '这个类型不能在这里编辑；浏览请用外壳的预览器',
				'history.label': '提交历史',
				'history.worktree': '工作区（未提交）',
				'history.clean': '干净',
				'history.empty': '这个仓库还没有提交',
				'history.noFiles': '这个提交没有可显示的文件',
				'history.filter': '搜索提交…',
				'history.newestFirst': '从晚到早',
				'history.oldestFirst': '从早到晚',
				'history.files': '{count} 个文件',
				'history.merge': '合并',
				'layout.leftWidth': '调整左栏宽度',
				'layout.leftSplit': '调整历史与文件的高度',
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
				'notice.notRepo': '当前会话目录不是 git 仓库，所以没有历史可看（逐轮页签仍可按轮次查看改动）',
				'notice.noGit': '这台机器上没有找到 git，所以没有历史和大小对比',
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
				'files.label': 'Files',
				'files.root': 'Working directory',
				'files.loading': 'Reading…',
				'files.empty': 'This directory is empty',
				'files.truncated': 'Directory too large: the first {count} entries are shown',
				'files.noTabs': 'Pick a file on the left to open it',
				'files.dirty': 'Unsaved',
				'files.save': 'Save',
				'files.saved': 'Saved',
				'files.saving': 'Saving…',
				'files.saveFailed': 'Save failed: {detail}',
				'files.conflict': 'This file changed on disk; nothing was overwritten',
				'files.overwrite': 'Overwrite anyway',
				'files.reload': 'Reload',
				'files.reloaded': 'Reloaded',
				'files.binary': 'Binary file: not editable here',
				'files.oversized': 'File too large to open here (limit {count} bytes)',
				'files.unsavedConfirm': '{name} has unsaved changes. Close it?',
				'files.highlight': 'Highlight',
				'files.edit': 'Edit',
				'files.refresh': 'Refresh directory',
				'files.close': 'Close',
				'files.modified': 'Modified',
				'files.fileCount': '{count} tabs',
				'files.mode': 'View',
				'files.mode.preview': 'Preview',
				'files.mode.split': 'Side by side',
				'files.mode.edit': 'Edit',
				'files.openInShell': 'Open in the shell previewer',
				'files.openFailed': 'The shell previewer is unavailable right now',
				'files.download': 'Download',
				'files.foreign': 'This type cannot be edited here; browse it in the shell previewer',
				'list.empty': 'No changes in this scope',
				'history.label': 'History',
				'history.worktree': 'Working tree (uncommitted)',
				'history.clean': 'Clean',
				'history.empty': 'This repository has no commits yet',
				'history.noFiles': 'This commit has no displayable file',
				'history.filter': 'Search commits…',
				'history.newestFirst': 'Newest first',
				'history.oldestFirst': 'Oldest first',
				'history.files': '{count} files',
				'history.merge': 'Merge',
				'layout.leftWidth': 'Resize the left column',
				'layout.leftSplit': 'Resize history against files',
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
				'notice.notRepo': 'This session’s directory is not a git repository, so there is no history to browse (the per-turn tab still lists each round’s changes)',
				'notice.noGit': 'git was not found on this machine, so there is no history and no size comparison',
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
			'.dshdv-tab:hover{color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-barSpacer{flex:1 1 auto;min-width:4px}',
			'.dshdv-filter{position:relative;display:flex;align-items:center;flex:0 1 220px;min-width:120px}',
			'.dshdv-filter input{width:100%;box-sizing:border-box;height:26px;padding:0 22px 0 8px;border:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}',
			'.dshdv-filter input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b6cf6)}',
			'.dshdv-filterClear{position:absolute;right:2px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b939e);cursor:pointer;font-size:14px;line-height:1;padding:2px 5px;border-radius:var(--dsw-radius-sm,6px)}',
			/* The strip's icon button, copied from ui-sidebar-files FilesBody `.tool`:
			 * a 28px box, `--dsw-radius-sm`, a 15px glyph, secondary ink that lifts to
			 * primary over the shared interactive fill. */
			/* One button shape for the whole plugin: at least a 28x28 tap target, and
			 * it GROWS to fit its label. A fixed `width:28px` here squeezed every text
			 * label into a one-character column — the label wrapped, the row grew, and
			 * a header that should be 32px tall turned into a ladder of letters. An
			 * icon button still measures 28px (16px glyph + 6px padding each side)
			 * while a text button can be as wide as the word it carries. */
			'.dshdv-btn{display:inline-flex;flex:none;align-items:center;justify-content:center;min-width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
			'.dshdv-btn:hover{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-btn[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-btn svg{display:block;width:15px;height:15px}',
			'.dshdv-summary{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;white-space:nowrap}',
			/* The per-turn filter strip: only the session scope has turns, so this
			 * row exists there and nowhere else. */
			'.dshdv-turn:hover{color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-turn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			/* The strip is a timeline on the left and an axis switch on the right; the
			 * spacer keeps them apart however many turns there are. */
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
			/* The file view: a tree on the left, a tabbed editor on the right.
			 * Metrics follow the shell's own files panel (`ui-sidebar-files`
			 * FilesBody.module.css): 18px per level, 28px tool boxes, the shared
			 * interactive fill for hover/selection, `scrollbar-gutter: stable` so the
			 * tree does not shift when a level grows a scrollbar. */
			'.dshdv-fvTree{display:flex;flex-direction:column;flex:0 0 236px;min-width:0;min-height:0;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			/* The tree header and rows are the shell's files-panel geometry, number
			 * for number (`ui-sidebar-files` FilesBody.module.css): a 38px header row
			 * with a hairline underneath, 18px of indent per level, rows that abut so
			 * the hover fill is the whole row, and `scrollbar-gutter: stable` so the
			 * tree keeps its inset whether or not a level overflows. */
			'.dshdv-fvHeader{display:flex;align-items:center;gap:4px;flex:0 0 auto;box-sizing:border-box;height:38px;padding:0 6px 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
			'.dshdv-fvHeaderPath{flex:1 1 auto;min-width:0;margin-right:12px;font-size:var(--dsh-content-font-size-secondary,13px)}',
			'.dshdv-fvTreeBody{flex:1 1 auto;min-height:0;overflow-y:auto;margin-right:2px;padding:8px 0 8px 8px;scrollbar-gutter:stable}',
			'.dshdv-fvRow{display:flex;align-items:center;gap:6px;width:100%;min-width:0;border:0;background:transparent;text-align:left;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary,#1b1f24);padding:5px 10px;border-radius:var(--dsw-radius-md,12px);cursor:pointer}',
			'.dshdv-fvRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-fvRow[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08)))}',
			'.dshdv-fvRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-fvRow[aria-disabled="true"]{cursor:default;color:var(--dsw-alias-label-tertiary,#8b939e)}',
			/* A folder glyph rides the tertiary ink and a file sheet keeps its own
			 * category colour — the same split the shell's panel makes. */
			'.dshdv-fvGlyph{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#8b939e)}',
			'.dshdv-fvName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshdv-fvBadge{flex:none;color:var(--dsw-alias-state-warn-primary,#c08a20);font-size:11px}',
			'.dshdv-fvNote{margin:4px 10px;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px;line-height:1.5}',
			'.dshdv-fvError{margin:4px 10px;color:var(--dsw-alias-state-error-primary,#c0392b);font-size:11px;line-height:1.5}',
			'.dshdv-fvMain{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
			/* The tab strip: the shell's own file-tab vocabulary — 34px tall, hairline
			 * separators, the selected tab filled with the native interactive token
			 * (`ui-sidebar-*` uses the same), and a horizontally scrolling list so any
			 * number of tabs stays reachable. */
			'.dshdv-fvTabs{display:flex;align-items:stretch;flex:none;height:34px;border-bottom:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:var(--dsw-alias-bg-layer-1,#fff)}',
			'.dshdv-fvTabList{display:flex;align-items:stretch;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}',
			'.dshdv-fvTabList::-webkit-scrollbar{display:none}',
			'.dshdv-fvTab{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:180px;min-width:64px;padding:0 8px 0 12px;border:0;border-right:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#5b636e);cursor:pointer}',
			'.dshdv-fvTab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08)));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-fvTabName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshdv-fvDot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#c08a20)}',
			'.dshdv-fvTabClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer}',
			'.dshdv-fvTabClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-fvHeadTools{display:inline-flex;align-items:center;gap:6px;flex:none;padding:0 8px;border-left:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
			'.dshdv-fvEditor{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#fafafa))}',
			'.dshdv-fvPane{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}',
			'.dshdv-fvPane[hidden]{display:none}',
			'.dshdv-fvEditorHead{display:flex;align-items:center;gap:6px;flex:none;min-height:32px;padding:0 12px;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px}',
			'.dshdv-fvPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,monospace)}',
			/* Nothing in the head may wrap: the path ellipsizes, the rest keeps its
			 * own width, and the row's height follows the tallest control. */
			'.dshdv-fvStatus{flex:none;white-space:nowrap}',
			/* The editing surface. An uncontrolled textarea: the draft lives in the
			 * DOM while typing, so a keystroke costs no render at all; the model only
			 * learns that the file BECAME dirty.
			 *
			 * METRIC CONTRACT — the textarea and the highlight layer behind it must
			 * agree to the pixel, or the colors drift away from the glyphs they belong
			 * to. Both therefore carry the SAME `font` shorthand (which fixes the line
			 * box at 19px), the same asymmetric padding, `white-space: pre`, the same
			 * `tab-size`, and `wrap="off"` so one source line is always one visual
			 * line. Nothing here may be changed for one layer alone. */
			'.dshdv-fvCode{position:relative;display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#fafafa))}',
			'.dshdv-fvText{position:absolute;inset:0;z-index:2;box-sizing:border-box;margin:0;padding:8px 22px 20px 56px;border:0;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary,#1b1f24);font:var(--dsw-font-markdown-code-block,12px/19px var(--ds-font-family-code,monospace));tab-size:2;white-space:pre;overflow:auto}',
			'.dshdv-fvText:focus-visible{outline:none}',
			/* Colors are painted behind, so the glyphs above must not paint twice. */
			'.dshdv-fvGhost{color:transparent;caret-color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-fvCodeLayer{position:absolute;top:0;left:0;z-index:1;box-sizing:border-box;min-width:100%;margin:0;padding:8px 22px 20px 56px;pointer-events:none;font:var(--dsw-font-markdown-code-block,12px/19px var(--ds-font-family-code,monospace));tab-size:2;white-space:pre;will-change:transform}',
			'.dshdv-fvCodeLine{white-space:pre}',
			/* The gutter is a window over a translated column: it clips, and it is
			 * opaque, because the code slides underneath it. */
			'.dshdv-fvGutter{position:absolute;top:0;bottom:0;left:0;z-index:3;width:44px;overflow:hidden;padding:0 8px 0 0;box-sizing:border-box;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#fafafa));color:var(--dsw-alias-label-tertiary,#8b939e);text-align:right;user-select:none;pointer-events:none}',
			'.dshdv-fvGutterInner{padding-top:8px;font:var(--dsw-font-markdown-code-block,12px/19px var(--ds-font-family-code,monospace));will-change:transform}',
			'.dshdv-fvCodeNum{white-space:pre}',
			/* Markdown side by side: the source on the left, the document on the right. */
			'.dshdv-fvSplit{display:flex;flex:1 1 auto;min-height:0;min-width:0}',
			'.dshdv-fvSplitSide{display:flex;flex:1 1 50%;min-width:0;border-right:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
			'.dshdv-fvSplitPreview{flex:1 1 50%;min-width:0;overflow:auto;padding:12px 16px;color:var(--dsw-alias-label-primary,#1b1f24)}',
			/* One segmented control for Markdown, using the native selected fill. */
			'.dshdv-fvModes{display:inline-flex;align-items:center;gap:2px;flex:none}',
			'.dshdv-fvModes .dshdv-btn{padding:0 8px;color:var(--dsw-alias-label-tertiary,#8b939e)}',
			'.dshdv-fvModes .dshdv-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08)));color:var(--dsw-alias-label-primary,#1b1f24)}',
			/* The two previews this pane owns: a Markdown document through the shell's
			 * renderer, and an HTML document in a frame that cannot run scripts. */
			'.dshdv-fvPreview{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px;color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-fvPreview>*:first-child{margin-top:0}',
			'.dshdv-fvConflict{display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-state-warn-primary,#c08a20);font-size:12px}',
			'.dshdv-add{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-del{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-main{display:flex;flex:1 1 auto;min-height:0}',
			'.dshdv-list{flex:0 0 272px;min-width:180px;max-width:45%;display:flex;flex-direction:column;border-right:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fafbfc);overflow:hidden}',
			/* The history browser is three panes around two draggable dividers: the
			 * commit list above the file list on the left, the comparison on the right.
			 * The two geometry values live in CSS variables on the container, so a drag
			 * writes one variable per move and nothing re-renders. */
			'.dshdv-gitLeft{display:flex;flex-direction:column;flex:0 0 auto;width:var(--dshdv-left-w,272px);min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-1,#fafbfc)}',
			'.dshdv-gitHistory{display:flex;flex-direction:column;flex:0 0 var(--dshdv-left-split,38%);min-height:0;overflow:hidden}',
			'.dshdv-gitFiles{display:flex;flex:1 1 auto;min-height:0;overflow:hidden}',
			/* A divider: 5px of hit area over a hairline, in the shell\'s separator ink.
			 * Neither pane may shrink past its own scroll, hence the clamps in the
			 * drag handler rather than here. */
			'.dshdv-grip{flex:0 0 5px;align-self:stretch;border:0;padding:0;background:transparent;position:relative;z-index:4}',
			'.dshdv-grip::after{content:"";position:absolute;background:var(--dsw-alias-border-l3,rgba(0,0,0,.08));transition:background .12s ease}',
			'.dshdv-gripV{cursor:col-resize}',
			'.dshdv-gripV::after{top:0;bottom:0;left:2px;width:1px}',
			'.dshdv-gripH{cursor:row-resize}',
			'.dshdv-gripH::after{left:0;right:0;top:2px;height:1px}',
			'.dshdv-grip:hover::after,.dshdv-grip:focus-visible::after{background:var(--dsw-alias-state-business-primary,#3b6cf6)}',
			'.dshdv-grip:focus-visible{outline:none}',
			'.dshdv-grip[data-dragging="true"]::after{background:var(--dsw-alias-state-business-primary,#3b6cf6)}',
			/* The history list spaces its rows; the file list below it abuts them, the way
			 * the shell's own tree does. Rows that carry two lines of text cannot touch:
			 * the hover and selected fills read as one continuous block otherwise. */
			'.dshdv-gitHistory .dshdv-listBody{display:flex;flex-direction:column;gap:3px}',
			/* A commit row: the subject takes the room, the id and the date stay put. */
			'.dshdv-commitRow{display:flex;flex-direction:column;gap:3px;width:100%;min-width:0;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;text-align:left;font:inherit;color:var(--dsw-alias-label-primary,#1b1f24);cursor:pointer}',
			'.dshdv-commitRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
			'.dshdv-commitRow[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08)))}',
			'.dshdv-commitRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-commitSubject{display:flex;align-items:center;gap:6px;width:100%;min-width:0;font-size:12px}',
			'.dshdv-commitTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			/* The decorations git prints for a commit: branch and tag names. */
			'.dshdv-refChip{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-brand-primary,var(--dsw-alias-link,#4d6bfe));font-size:10px;line-height:15px}',
			'.dshdv-mergeChip{flex:none;padding:0 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-tertiary,#8b939e);font-size:10px;line-height:15px}',
			'.dshdv-commitAuthor{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5b636e)}',
			'.dshdv-commitStats{display:inline-flex;gap:4px;white-space:nowrap}',
			'.dshdv-commitBin{color:var(--dsw-alias-label-tertiary,#8b939e)}',
			'.dshdv-commitMeta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary,#8b939e);font-size:11px}',
			'.dshdv-commitSha{font-family:var(--ds-font-family-code,monospace)}',
			'.dshdv-commitWhen{margin-left:auto;white-space:nowrap}',
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
			/* A pane with nothing to list is NOT a scroller: the status fills the pane
			 * and no scroll container is rendered at all, so there is neither a
			 * scrollbar nor a reserved gutter to look at. */
			'.dshdv-paneEmpty{display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden}',
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
			/* `border-box` is load-bearing where a status sits inside a scroller: with
			 * `height:100%` AND 24px of padding it measured 48px taller than its pane,
			 * so an EMPTY pane could be scrolled — a scrollbar over nothing. */
			'.dshdv-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;box-sizing:border-box;height:100%;min-height:0;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#5b636e);font-size:var(--dsh-content-font-size-secondary,13px)}',
			'.dshdv-status p{margin:0;max-width:44ch;line-height:1.6}',
			/* The same notice INSIDE a list: it must not claim the pane's whole height,
			 * or the rows above it would be pushed out of view. */
			'.dshdv-statusInline{height:auto;min-height:0;padding:12px 16px;gap:6px}',
			/* Every scrolling region a pane can hold ends above the floating composer:
			 * the shell's own trajectory ledger reserves the same band. */
			'.dshdv-listBody,.dshdv-scroll,.dshdv-tvListBody,.dshdv-tvSaid,.dshdv-tvFileList{padding-bottom:var(--dshdv-bottom-clearance)}',
			'.dshdv-note{padding:6px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;border-bottom:0.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.06))}',
			'.dshdv-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
			'@media (max-width: 720px){.dshdv-list{flex-basis:200px}}',
		];

		var STYLE_ID = NAMESPACE + '-styles';

		/**
		 * Insert this bundle's stylesheet once.
		 *
		 * The tag MUST carry `data-plugin` (and the module system's own stylesheet
		 * marker): the loader claims every untagged `<style>` for the next plugin
		 * that materializes and removes the ones tagged with that plugin's id when
		 * it unloads — so an untagged sheet belongs to nobody and is deleted by
		 * whoever comes next. Tagged, it lives and dies with this bundle.
		 */
		function ensureStyles() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(STYLE_ID) !== null) return;
			/* A tag already carrying this plugin's name belongs to this bundle (a
			 * remount after an HMR swap, say): adopt it instead of adding a second. */
			if (typeof document.querySelector === 'function') {
				var existing = document.querySelector('style[data-plugin="' + NAMESPACE + '"]');
				if (existing !== null && existing !== undefined) {
					existing.id = STYLE_ID;
					return;
				}
			}
			var tag = document.createElement('style');
			tag.id = STYLE_ID;
			tag.setAttribute('data-plugin', NAMESPACE);
			tag.setAttribute('data-plugin-css', NAMESPACE);
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
		/** Save: the classic floppy, so the action reads the same as everywhere else. */
		var ICON_SAVE = [['M3.5 3.5h7.2l1.8 1.8v7.2h-9z'], ['M5.8 3.5h4.4v3.1H5.8z'], ['M5.8 9.2h4.4v3.3H5.8z']];
		/** Hand a file to the shell's own previewer: a box with an arrow leaving it. */
		var ICON_EXTERNAL = [['M9.5 3.5h3v3'], ['M12.5 3.5 7.5 8.5'], ['M11 9.5v3h-7v-7h3']];
		/** Syntax colors on/off: the classic "A" over a brush stroke. */
		var ICON_HIGHLIGHT = [['M3.5 12.5h9'], ['M9.6 3.6 12.4 6.4'], ['M4.2 11.8 9.6 3.6l2.8 2.8-6.2 5.4-2 .6z']];
		/** Preview: an eye. */
		var ICON_PREVIEW = [['M1.8 8s2.6-3.8 6.2-3.8S14.2 8 14.2 8s-2.6 3.8-6.2 3.8S1.8 8 1.8 8z'], ['M6.4 8a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0']];
		/** Side by side: one frame divided down the middle. */
		var ICON_SPLIT = [['M2.5 3.5h11v9h-11z'], ['M8 3.5v9']];
		/** Edit: a pencil. */
		var ICON_PENCIL = [['M3.5 12.5h3l6.4-6.4-3-3-6.4 6.4z'], ['M10.4 2.6 12 1l3 3-1.6 1.6z']];
		/** Sort order: two arrows pointing opposite ways, whichever end is first. */
		var ICON_SORT = [['M4.5 3.5v9'], ['M2.2 10.3 4.5 12.5l2.3-2.2'], ['M11.5 12.5v-9'], ['M9.2 5.7 11.5 3.5l2.3 2.2']];

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
				/** The history axis: the commit list, and the commit being browsed. */
				history: [],
				historyPhase: 'idle',
				historyError: null,
				historyMore: false,
				/** The commit in view; `null` means the working tree. */
				selectedSha: null,
				/** The commit's own metadata, once read. */
				commitMeta: null,
				/** The files that commit touched — not the working tree's. */
				commitFiles: [],
				filesPhase: 'idle',
				filesError: null,
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

		/** The commit list, and one commit in full. */
		function historyUrl(sessionId) {
			return ROUTES_COMMITS + '?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + String(HISTORY_PAGE);
		}

		function commitUrl(sessionId, sha) {
			return ROUTES_COMMIT_DETAIL + '?sessionId=' + encodeURIComponent(sessionId) + '&sha=' + encodeURIComponent(sha);
		}

		function fileUrl(scope, sessionId, path, at) {
			var url = FILE_URL + '?scope=' + encodeURIComponent(scope) + '&sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path);
			if (at === undefined || at === null) return url;
			/* `at` means two different things, and they are not interchangeable: a
			 * session read addresses a TURN (`turn:seq:index`), while a commit read
			 * addresses a COMMIT and carries its id verbatim. Formatting a commit id
			 * as a turn produced `at=<sha>:undefined:undefined` — a read that could
			 * only fail. */
			var coordinate = scope === 'commit'
				? String(at)
				: String(at.turn) + ':' + String(at.seq) + ':' + String(at.index);
			return url + '&at=' + encodeURIComponent(coordinate);
		}

		function createController() {
			var listeners = new Set();
			var state = initialState();
			var generation = 0;
			var diffGeneration = 0;
			/** One generation per history axis: the commit list and one commit's files. */
			var historyGeneration = 0;
			var commitGeneration = 0;
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
					/* A file chosen while a COMMIT is selected is read in that commit's
					 * scope: the same path, a different content, and the commit id travels
					 * with the read. */
					var inCommit = state.selectedSha !== null;
					var file = (inCommit ? state.commitFiles : state.files).find(function (entry) { return entry.path === path; });
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
					if (!inCommit && state.scope === SESSION && coordinate === undefined) {
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
						result = await readJson(inCommit
							? fileUrl('commit', sessionId, path, state.selectedSha)
							: fileUrl(state.scope, sessionId, path, coordinate), undefined);
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
				 * Read the repository's history.
				 *
				 * History is a separate axis from the working tree: it moves only when
				 * something commits, so a silent tick reuses the entries already on
				 * screen unless their ids changed (an entry keeps its identity, which is
				 * what lets the list's rows stay the same elements).
				 */
				readHistory: async function (sessionId, options) {
					var silent = options !== undefined && options.silent === true;
					var current = (historyGeneration += 1);
					var started = epoch;
					if (!silent) patch({ historyPhase: 'loading', historyError: null });
					var result;
					try {
						result = await readJson(historyUrl(sessionId), undefined);
					} catch (error) {
						if (current !== historyGeneration || started !== epoch) return;
						patch({ historyPhase: 'error', historyError: 'error.generic' });
						return;
					}
					if (current !== historyGeneration || started !== epoch) return;
					if (result.failed !== undefined) {
						patch({ historyPhase: 'error', historyError: result.failed });
						return;
					}
					var incoming = Array.isArray(result.value.commits) ? result.value.commits : [];
					var previous = new Map();
					for (var at = 0; at < state.history.length; at += 1) previous.set(state.history[at].sha, state.history[at]);
					var commits = incoming.map(function (entry) {
						/* Tolerate a Host that answers the OLD shape: the browser half and the
						 * host half reload independently, so a row must not crash because the
						 * commit it describes arrived without its decorations or counts. */
						var shaped = {
							sha: String(entry.sha),
							short: String(entry.short ?? String(entry.sha).slice(0, 7)),
							author: String(entry.author ?? ''),
							email: entry.email === undefined ? '' : String(entry.email),
							at: String(entry.at ?? ''),
							subject: String(entry.subject ?? ''),
							parents: Number.isSafeInteger(entry.parents) ? entry.parents : 1,
							refs: Array.isArray(entry.refs) ? entry.refs.filter(ref => typeof ref === 'string' && ref !== '') : [],
							files: Number.isInteger(entry.files) ? entry.files : 0,
							added: Number.isInteger(entry.added) ? entry.added : 0,
							deleted: Number.isInteger(entry.deleted) ? entry.deleted : 0,
							binary: entry.binary === true,
						};
						var held = previous.get(shaped.sha);
						return held !== undefined && held.subject === shaped.subject && held.short === shaped.short
							&& held.files === shaped.files && held.refs.length === shaped.refs.length
							? held
							: shaped;
					});
					patch({ historyPhase: 'ready', historyError: null, history: commits, historyMore: result.value.more === true });
				},

				/** Show the working tree again: the uncommitted files, not a commit. */
				selectWorktree: function (sessionId) {
					if (state.selectedSha === null) return undefined;
					var pool = state.files;
					var selected = pool.length > 0 ? pool[0].path : null;
					patch({
						selectedSha: null, commitMeta: null, commitFiles: [], filesPhase: 'ready',
						selected: selected, selectedPrint: undefined, diff: null, diffPath: undefined,
						diffPhase: 'idle', diffError: null,
					});
					if (selected === null) return undefined;
					return controller.select(sessionId, selected);
				},

				/**
				 * Show one commit: its message, its files, and the first file's diff.
				 *
				 * The files come from the commit itself rather than from the working
				 * tree, because that is the whole point of browsing history — the tree
				 * on disk is a different content.
				 */
				selectCommit: async function (sessionId, sha) {
					if (sha === state.selectedSha) return;
					var current = (commitGeneration += 1);
					var started = epoch;
					patch({
						selectedSha: sha, commitMeta: null, commitFiles: [], filesPhase: 'loading',
						selected: null, selectedPrint: undefined, diff: null, diffPath: undefined,
						diffPhase: 'idle', diffError: null, filesError: null,
					});
					var result;
					try {
						result = await readJson(commitUrl(sessionId, sha), undefined);
					} catch (error) {
						if (current !== commitGeneration || started !== epoch) return;
						patch({ filesPhase: 'error', filesError: 'error.generic' });
						return;
					}
					if (current !== commitGeneration || started !== epoch) return;
					if (result.failed !== undefined) {
						patch({ filesPhase: 'error', filesError: result.failed });
						return;
					}
					var files = Array.isArray(result.value.files) ? result.value.files : [];
					patch({ filesPhase: 'ready', filesError: null, commitMeta: result.value.commit ?? null, commitFiles: files });
					if (files.length > 0) await controller.select(sessionId, files[0].path);
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
					/* The commit the reader just made is the newest entry of the history
					 * they were browsing, so that list is stale by construction. */
					await controller.readHistory(sessionId);
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

		/**
		 * What one list row shows — the fingerprint a silent refresh compares.
		 *
		 * A tick may only re-read a turn whose visible facts moved, and those facts
		 * are exactly these fields: its counts, whether it is still running, and the
		 * question and answer previews the row carries. Comparing anything else (a
		 * synthesized stand-in, say) compares nothing at all, which is how a silent
		 * refresh turns into a full re-read and re-render every few seconds.
		 */
		function rowPrint(row) {
			if (row === undefined) return '';
			return [
				row.turn, row.open === true ? 'open' : 'done', row.files, row.added, row.deleted,
				row.prompt === null || row.prompt === undefined ? '' : row.prompt.text,
				row.answer === null || row.answer === undefined ? '' : row.answer.text,
			].join('\u0000');
		}

		/**
		 * Fold a freshly read turn list into the one on screen.
		 *
		 * A row whose visible facts are unchanged keeps the PRECEDING object, so the
		 * list a reader is looking at is not rebuilt by a refresh that found nothing
		 * new. Same rule as the file list's own merge, for the same reason.
		 */
		function mergeRows(previous, incoming) {
			var byTurn = new Map();
			for (var at = 0; at < previous.length; at += 1) byTurn.set(previous[at].turn, previous[at]);
			return incoming.map(function (row) {
				var before = byTurn.get(row.turn);
				return before !== undefined && rowPrint(before) === rowPrint(row) ? before : row;
			});
		}

		/** Whether two question/answer records say the same thing. */
		function sameSaid(left, right) {
			if (left === right) return true;
			if (left === null || left === undefined || right === null || right === undefined) return false;
			return left.text === right.text && left.truncated === right.truncated
				&& left.human === right.human && left.source === right.source && left.seq === right.seq;
		}

		/** Whether two changed-file lists describe the same files the same way. */
		function sameFiles(left, right) {
			if (left.length !== right.length) return false;
			for (var at = 0; at < left.length; at += 1) {
				var one = left[at];
				var two = right[at];
				if (one.path !== two.path || one.status !== two.status || one.added !== two.added || one.deleted !== two.deleted) return false;
				if ((one.at === null || one.at === undefined) !== (two.at === null || two.at === undefined)) return false;
				if (one.at !== null && one.at !== undefined && one.at.seq !== two.at.seq) return false;
			}
			return true;
		}

		/** The state the turn browser starts from. */
		function turnsState() {
			return {
				phase: 'idle',
				error: null,
				turns: [],
				/** The turn in view. */
				selected: null,
				/** Fingerprint of the list row the held detail was read for. */
				rowPrint: '',
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
				 * A silent read (the auto-refresh tick) is a no-op unless the turn in
				 * view actually moved: the list merges by row fingerprint so unchanged
				 * rows keep their identity, and the detail is re-read only when the
				 * selected row's fingerprint differs from the one the held detail was
				 * read for. An older turn can never change, so a tick while one is in
				 * view costs one small list request and nothing else — no detail read,
				 * no comparison read, no re-render.
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
					var incoming = Array.isArray(result.value.turns) ? result.value.turns : [];
					var rows = mergeRows(state.turns, incoming);
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
					var row = rows.find(function (entry) { return entry.turn === selected; });
					if (selected !== state.selected) {
						await controller.selectTurn(sessionId, selected);
						return;
					}
					// Same turn: re-read only when what the reader can see moved.
					if (!silent || state.detailPhase !== 'ready' || rowPrint(row) !== state.rowPrint) {
						await controller.selectTurn(sessionId, selected, { refresh: true });
					}
				},

				/**
				 * Show one turn: its question and answer, and its changed files.
				 *
				 * `refresh` means the SAME turn is being re-read because something it
				 * shows moved (a running turn's answer grew, a file landed). Then
				 * nothing already on screen is dropped: the comparison and the file
				 * selection stay, every record whose content is unchanged keeps its
				 * object, and the comparison is only re-read if the selected path left
				 * the list. Blanking first is what made a tick cost a full rebuild of
				 * the answer and the diff.
				 */
				selectTurn: async function (sessionId, turn, options) {
					var refresh = options !== undefined && options.refresh === true && state.selected === turn;
					var current = (detailGeneration += 1);
					var started = epoch;
					var stale = function () { return current !== detailGeneration || started !== epoch; };
					if (refresh) {
						/* Keep the pane: only the busy marker moves. */
						patch({ detailPhase: state.detailPhase === 'ready' ? 'ready' : 'loading', detailError: null });
					} else {
						patch({ selected: turn, detailPhase: 'loading', detailError: null, file: null, filePrint: undefined, diff: null, diffPath: undefined, diffPhase: 'idle', diffError: null });
					}
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
					var incoming = Array.isArray(value.files) ? value.files : [];
					var files = refresh && sameFiles(state.files, incoming) ? state.files : incoming;
					var prompt = refresh && sameSaid(state.prompt, value.prompt === undefined ? null : value.prompt)
						? state.prompt
						: (value.prompt === null || value.prompt === undefined ? null : value.prompt);
					var answer = refresh && sameSaid(state.answer, value.answer === undefined ? null : value.answer)
						? state.answer
						: (value.answer === null || value.answer === undefined ? null : value.answer);
					var row = state.turns.find(function (entry) { return entry.turn === turn; });
					patch({
						detailPhase: 'ready',
						detailError: null,
						open: value.open === true,
						prompt: prompt,
						answer: answer,
						files: files,
						added: value.added || 0,
						deleted: value.deleted || 0,
						filePrint: detailPrint(turn, files),
						/* What the detail describes, so the next silent tick can tell
						 * whether it still agrees with the row the reader sees. */
						rowPrint: rowPrint(row),
					});
					/* The file in view stays in view across a refresh; only a selection
					 * that is no longer listed falls back to the first file. */
					var keepPath = state.file !== null && files.some(function (file) { return file.path === state.file; })
						? state.file
						: (files.length > 0 ? files[0].path : null);
					if (keepPath !== null) await controller.selectFile(sessionId, keepPath);
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

			/* No re-arm on a fresh answer: a read is not an interaction, and treating it
			 * as one is how the fast cadence became permanent. */

			/**
			 * The poll, and the event that replaces it.
			 *
			 * Polling is opt-in (the same `AUTO_KEY` switch the history tab carries) and
			 * the default is off. What runs either way is the re-read when the window
			 * comes back to the reader: a turn list changes at turn boundaries, and the
			 * moment someone returns to look is exactly when that matters.
			 */
			React.useEffect(function () {
				if (readPreference(AUTO_KEY, 'off') !== 'on') return undefined;
				/* Self-scheduling: a refresh that found nothing new changes no state, so
				 * the loop cannot depend on one. */
				var timer = window.setTimeout(function () {
					void controller.refresh(sessionId).then(function () {
						setTick(function (value) { return value + 1; });
					});
				}, Date.now() < activeUntil.current ? TURNS_REFRESH_MS : TURNS_REFRESH_IDLE_MS);
				return function () { window.clearTimeout(timer); };
			}, [controller, sessionId, tick]);

			React.useEffect(function () {
				var onReturn = function () {
					if (document.hidden) return;
					markActive();
					void controller.refresh(sessionId);
				};
				window.addEventListener('focus', onReturn);
				document.addEventListener('visibilitychange', onReturn);
				return function () {
					window.removeEventListener('focus', onReturn);
					document.removeEventListener('visibilitychange', onReturn);
				};
			}, [controller, sessionId]);

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
			/* This plugin's own translator, handed in by `inject`. The shell's `t` is
			 * bound to whatever dictionary that namespace was FIRST registered with, so
			 * a key added by a later bundle resolves to itself there; ours falls back to
			 * the copy that shipped with THIS bundle. */
			var t = props.tr === undefined ? props.t : props.tr;
			var state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			var wrapState = React.useState(function () { return readPreference(WRAP_KEY, 'wrap') !== 'nowrap'; });
			var wrap = wrapState[0];
			var setWrap = wrapState[1];
			var splitState = React.useState(false);
			var split = splitState[0];
			var setSplit = splitState[1];
			/* Off unless the reader turned it on — see AUTO_KEY. A review pane does not
			 * need a timer; it needs a read when the reader returns to it. */
			var autoState = React.useState(function () { return readPreference(AUTO_KEY, 'off') === 'on'; });
			var auto = autoState[0];
			var setAuto = autoState[1];
			var filterState = React.useState('');
			var filter = filterState[0];
			var setFilter = filterState[1];
			var copiedState = React.useState(false);
			var copied = copiedState[0];
			var setCopied = copiedState[1];
			/* The divider geometry: state for rendering, refs for the gesture (a drag
			 * must not wait for a render to know where it started). */
			var leftWidthState = React.useState(function () {
				var stored = Number(readPreference(LEFT_WIDTH_KEY, ''));
				return Number.isFinite(stored) && stored >= LEFT_WIDTH_MIN ? stored : 272;
			});
			var leftWidth = leftWidthState[0];
			var setLeftWidth = leftWidthState[1];
			var leftSplitState = React.useState(function () {
				var stored = Number(readPreference(LEFT_SPLIT_KEY, ''));
				return Number.isFinite(stored) && stored >= LEFT_SPLIT_MIN && stored <= LEFT_SPLIT_MAX ? stored : 38;
			});
			var leftSplit = leftSplitState[0];
			var setLeftSplit = leftSplitState[1];
			var orderState = React.useState(function () { return readPreference(ORDER_KEY, 'new') === 'old'; });
			var oldestFirst = orderState[0];
			var setOldestFirst = orderState[1];
			var mainRef = React.useRef(null);
			var leftRef = React.useRef(null);
			var leftWidthRef = React.useRef(leftWidth);
			var leftSplitRef = React.useRef(leftSplit);

			/**
			 * When the reader last did something.
			 *
			 * Only a real interaction counts. The first version also re-armed this on
			 * every fresh answer, which made the "active" window renew itself from the
			 * refresh it was scheduling: the fast cadence never expired, and the pane
			 * polled forever. A read is not an interaction.
			 */
			var activeUntil = React.useRef(0);
			var markActive = function () {
				activeUntil.current = Date.now() + AUTO_REFRESH_ACTIVE_MS;
			};

			React.useEffect(function () {
				void controller.load(sessionId);
				void controller.readHistory(sessionId);
				return function () {
					controller.reset();
				};
			}, [controller, sessionId]);

			/**
			 * Re-read when the reader comes back to the window.
			 *
			 * This is what replaces the timer for anyone who leaves polling off: an
			 * event that means "the picture may have moved since you last looked",
			 * rather than a question asked every few seconds forever.
			 */
			React.useEffect(function () {
				if (!auto) return undefined;
				var onReturn = function () {
					if (document.hidden) return;
					markActive();
					void controller.refresh(sessionId);
					void controller.readHistory(sessionId);
				};
				window.addEventListener('focus', onReturn);
				document.addEventListener('visibilitychange', onReturn);
				return function () {
					window.removeEventListener('focus', onReturn);
					document.removeEventListener('visibilitychange', onReturn);
				};
			}, [auto, controller, sessionId]);

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
			/* Which axis the pane is showing: a commit from the history, or the
			 * working tree — whose first row is the uncommitted changes. */
			var inCommit = state.selectedSha !== null;
			var listed = inCommit ? state.commitFiles : state.files;
			var listPhase = inCommit ? state.filesPhase : state.phase;
			var listError = inCommit ? state.filesError : state.error;
			var needle = filter.trim().toLowerCase();
			var matched = needle === ''
				? state.history
				: state.history.filter(function (entry) {
					return entry.subject.toLowerCase().indexOf(needle) !== -1
						|| entry.sha.indexOf(needle) === 0
						|| entry.short.indexOf(needle) === 0
						|| String(entry.author).toLowerCase().indexOf(needle) !== -1;
				});
			/* One page of history, shown from whichever end the reader chose. */
			var commits = oldestFirst ? matched.slice().reverse() : matched;
			var visible = needle === '' || inCommit
				? listed
				: listed.filter(function (file) {
					return (file.display || file.path).toLowerCase().indexOf(needle) !== -1
						|| file.path.toLowerCase().indexOf(needle) !== -1;
				});
			var selectedFile = state.selected === null
				? undefined
				: listed.find(function (file) { return file.path === state.selected; });
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

			/** Browse one commit, or come back to the working tree. */
			var selectCommit = function (sha) {
				markActive();
				void controller.selectCommit(sessionId, sha);
			};
			var selectWorktree = function () {
				markActive();
				void controller.selectWorktree(sessionId);
			};

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

			/**
			 * The history column: the working tree first, then every commit.
			 *
			 * The working-tree row is what keeps this tab useful in a workflow that
			 * commits per round: the tree is usually clean, and "nothing uncommitted"
			 * is a fact worth showing rather than an empty panel.
			 */
			var historyBody;
			if (state.historyPhase === 'loading') {
				historyBody = h('div', { className: 'dshdv-status', role: 'status' }, h('p', null, t('list.loading')));
			} else {
				/* The working-tree row is always there — it is the one axis that needs
				 * no repository to be true, and the way back from a failed history. A
				 * history that could not be read is a note UNDER it, never a page that
				 * replaces it. */
				var historyRows = [
					h('button', {
						key: 'worktree',
						type: 'button',
						className: 'dshdv-commitRow',
						'data-dsh-diff-worktree': inCommit ? 'off' : 'on',
						'aria-selected': !inCommit,
						title: t('history.worktree'),
						onClick: selectWorktree,
					},
						h('span', { className: 'dshdv-commitSubject' }, t('history.worktree')),
						h('span', { className: 'dshdv-commitMeta' },
							h('span', { className: 'dshdv-commitWhen' }, files.length === 0
								? t('history.clean')
								: format(t('summary.files'), { count: files.length })))),
				];
				if (state.historyPhase === 'error') {
					historyRows.push(h('div', { key: 'error', className: 'dshdv-status dshdv-statusInline' },
						h('p', null, t(state.historyError === null ? 'error.generic' : state.historyError)),
						h('button', {
							type: 'button', className: 'dshdv-btn',
							onClick: function () { void controller.readHistory(sessionId); },
						}, t('error.retry'))));
				} else if (commits.length === 0) {
					historyRows.push(h('p', { key: 'empty', className: 'dshdv-note' }, t(needle === '' ? 'history.empty' : 'list.emptyFiltered')));
				} else {
					historyRows = historyRows.concat(commits.map(function (entry) {
						/* What a commit row can honestly carry: what it says, who wrote it,
						 * when, which branches or tags point at it, whether it is a merge,
						 * and how much it changed. All of it comes from the one `git log`
						 * the list read — no extra process per row. */
						/* The hover text repeats nothing the row already shows: the subject
						 * is right there, and a tooltip that repeats it is a tooltip that
						 * covers the row below. What it adds is the address, the absolute
						 * time, and the decorations. */
						var hover = [
							entry.author + (entry.email === undefined || entry.email === '' ? '' : ' <' + entry.email + '>'),
							absoluteTime(entry.at),
							entry.refs.length === 0 ? '' : entry.refs.join(', '),
						].filter(part => part !== '').join('\n');
						return h('button', {
							key: entry.sha,
							type: 'button',
							className: 'dshdv-commitRow',
							'data-commit': entry.sha,
							'data-commit-short': entry.short,
							'aria-selected': entry.sha === state.selectedSha,
							title: hover,
							onClick: function () { selectCommit(entry.sha); },
						},
							h('span', { className: 'dshdv-commitSubject' },
								entry.refs.length === 0 ? null : entry.refs.map(function (ref) {
									return h('span', { key: ref, className: 'dshdv-refChip' }, ref);
								}),
								h('span', { className: 'dshdv-commitTitle' }, entry.subject)),
							h('span', { className: 'dshdv-commitMeta' },
								h('span', { className: 'dshdv-commitSha' }, entry.short),
								entry.parents > 1 ? h('span', { className: 'dshdv-mergeChip' }, t('history.merge')) : null,
								h('span', { className: 'dshdv-commitAuthor' }, entry.author),
								entry.files === 0 ? null : h('span', { className: 'dshdv-commitStats' },
									format(t('history.files'), { count: entry.files }),
									entry.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + String(entry.added)) : null,
									entry.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + String(entry.deleted)) : null,
									entry.binary === true ? h('span', { className: 'dshdv-commitBin' }, 'bin') : null),
								h('span', { className: 'dshdv-commitWhen' }, shellTime(t, entry.at))));
					}));
				}
				historyBody = historyRows;
			}
			/**
			 * One pane's body: a scrolling list when there are rows, and the status on
			 * its own when there are none.
			 *
			 * The distinction is not cosmetic. A scroll container around a status that
			 * fills it produces a scrollbar over nothing (and, with a stable gutter, a
			 * permanent strip down the edge), which reads as a broken pane. So the
			 * scroller only exists when there is something to scroll.
			 *
			 * @param options - `{ attribute, label, rows, status }`.
			 * @returns the pane body element.
			 */
			function paneBodyOf(options) {
				if (!options.rows) {
					return h('div', {
						className: 'dshdv-paneEmpty',
						role: 'listbox',
						'aria-label': options.label,
						[options.attribute]: '',
					}, options.status);
				}
				return h('div', {
					className: 'dshdv-listBody',
					role: 'listbox',
					'aria-label': options.label,
					[options.attribute]: '',
				}, options.status);
			}

			var historyPane = h('div', { className: 'dshdv-gitHistory' },
				paneBodyOf({
					attribute: 'data-dsh-diff-history',
					label: t('history.label'),
					/* The working-tree row needs no repository, so the history column has
					 * rows in every state except while it is still reading. */
					rows: state.historyPhase !== 'loading',
					status: historyBody,
				}));

			/* The files of whatever is selected: a commit's own files, or the working
			 * tree's changed files. */
			var filesBody;
			if (listPhase === 'loading') {
				filesBody = h('div', { className: 'dshdv-status', role: 'status' }, h('p', null, t('list.loading')));
			} else if (listPhase === 'error') {
				filesBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(listError === null ? 'error.generic' : listError)),
					h('button', {
						type: 'button', className: 'dshdv-btn',
						onClick: function () {
							if (inCommit) void controller.selectCommit(sessionId, state.selectedSha);
							else void controller.load(sessionId);
						},
					}, t('error.retry')));
			} else if (listed.length === 0) {
				filesBody = h('div', { className: 'dshdv-status' },
					h('p', null, inCommit ? t('history.noFiles') : t('list.empty')));
			} else {
				filesBody = visible.map(function (file) {
					var facts = factsForView(file, state);
					return h(FileRow, {
						key: file.path, file: file, t: t, selected: file.path === state.selected,
						status: facts.status, added: facts.added, deleted: facts.deleted,
						turnTag: undefined,
						onSelect: onSelect,
					});
				});
			}
			var filesPane = h('div', { className: 'dshdv-gitFiles' },
				paneBodyOf({
					attribute: 'data-dsh-diff-list',
					label: t('view.label'),
					rows: listPhase === 'ready' && listed.length > 0,
					status: filesBody,
				}));
			/**
			 * The detail pane: the selected file's comparison behind its header.
			 *
			 * This wrapper is load-bearing, not decoration: the two layers of the
			 * right column are flex children of it, so the header and the scrolling
			 * body have to arrive as ONE child or they become siblings of the file
			 * list and fight it for width. A fragment here would splice them into
			 * that row — which is exactly the bug this replaced.
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

			/**
			 * The three panes and their two dividers.
			 *
			 * Geometry lives on the container as CSS variables (`--dshdv-left-w`,
			 * `--dshdv-left-split`), seeded from this browser's last layout, so a drag
			 * writes one custom property per pointer move and React renders nothing
			 * until the gesture ends — when the new value is persisted.
			 */
			var gripV = h('div', {
				className: 'dshdv-grip dshdv-gripV',
				role: 'separator',
				'aria-orientation': 'vertical',
				'aria-label': t('layout.leftWidth'),
				'data-dsh-diff-grip': 'left',
				tabIndex: 0,
				'aria-valuenow': Math.round(leftWidth),
				onPointerDown: dividerDrag({
					axis: 'x',
					container: function () { return mainRef.current; },
					startValue: function () { return leftWidthRef.current; },
					clamp: function (value) {
						var room = mainRef.current === null ? undefined : mainRef.current.clientWidth;
						var widest = typeof room === 'number' && room > 0 ? Math.min(LEFT_WIDTH_MAX, room * 0.7) : LEFT_WIDTH_MAX;
						return Math.max(LEFT_WIDTH_MIN, Math.min(widest, value));
					},
					apply: function (node, value) { node.style.setProperty('--dshdv-left-w', String(Math.round(value)) + 'px'); },
					onCommit: function (value) {
						leftWidthRef.current = value;
						setLeftWidth(value);
						writePreference(LEFT_WIDTH_KEY, String(Math.round(value)));
					},
				}),
				onKeyDown: function (event) {
					var step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
					if (step === 0) return;
					event.preventDefault();
					var next = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, leftWidthRef.current + step));
					leftWidthRef.current = next;
					setLeftWidth(next);
					writePreference(LEFT_WIDTH_KEY, String(Math.round(next)));
				},
			});
			var gripH = h('div', {
				className: 'dshdv-grip dshdv-gripH',
				role: 'separator',
				'aria-orientation': 'horizontal',
				'aria-label': t('layout.leftSplit'),
				'data-dsh-diff-grip': 'history',
				tabIndex: 0,
				'aria-valuenow': Math.round(leftSplit),
				onPointerDown: dividerDrag({
					axis: 'y',
					container: function () { return leftRef.current; },
					/* The gesture is tracked in PIXELS and stored as a SHARE. Adding pixel
					 * deltas to a percentage — the first version — is what made this
					 * divider jump to nonsense values. */
					startValue: function () {
						var room = leftRef.current === null ? 0 : leftRef.current.clientHeight;
						return room > 0 ? (room * leftSplitRef.current) / 100 : 0;
					},
					clamp: function (value) {
						var room = leftRef.current === null ? 0 : leftRef.current.clientHeight;
						if (!(room > 0)) return value;
						return Math.max((room * LEFT_SPLIT_MIN) / 100, Math.min((room * LEFT_SPLIT_MAX) / 100, value));
					},
					apply: function (node, value) {
						var room = node.clientHeight;
						if (!(room > 0)) return;
						node.style.setProperty('--dshdv-left-split', ((value / room) * 100).toFixed(1) + '%');
					},
					onCommit: function (value) {
						var room = leftRef.current === null ? 0 : leftRef.current.clientHeight;
						if (!(room > 0)) return;
						var share = Math.max(LEFT_SPLIT_MIN, Math.min(LEFT_SPLIT_MAX, (value / room) * 100));
						leftSplitRef.current = share;
						setLeftSplit(share);
						writePreference(LEFT_SPLIT_KEY, share.toFixed(1));
					},
				}),
				onKeyDown: function (event) {
					var step = event.key === 'ArrowUp' ? -4 : event.key === 'ArrowDown' ? 4 : 0;
					if (step === 0) return;
					event.preventDefault();
					var next = Math.max(LEFT_SPLIT_MIN, Math.min(LEFT_SPLIT_MAX, leftSplitRef.current + step));
					leftSplitRef.current = next;
					setLeftSplit(next);
					writePreference(LEFT_SPLIT_KEY, next.toFixed(1));
				},
			});

			return h('div', {
				className: 'dshdv-root',
				'data-dsh-diff-view': state.scope,
				'data-conversation-composer-overlay': '',
				style: { '--dshdv-left-w': String(Math.round(leftWidth)) + 'px', '--dshdv-left-split': leftSplit.toFixed(1) + '%' },
			},
				h('div', { className: 'dshdv-bar' },
					h('span', { className: 'dshdv-headPath', title: state.repo === null ? '' : state.repo, 'data-dsh-diff-repo': '' },
						state.repo === null ? t('history.label') : baseName(state.repo)),
					h('span', { className: 'dshdv-summary', 'data-dsh-diff-summary': '' },
						inCommit && state.commitMeta !== null
							? h(React.Fragment, null,
								h('span', { className: 'dshdv-commitSha' }, state.commitMeta.short),
								h('span', null, state.commitMeta.author),
								h('span', null, shellTime(t, state.commitMeta.at)))
							: h(React.Fragment, null,
								h('span', null, format(t('summary.files'), { count: files.length })),
								h('span', { className: 'dshdv-add' }, format(t('summary.added'), { count: state.totals.added })),
								h('span', { className: 'dshdv-del' }, format(t('summary.deleted'), { count: state.totals.deleted })))),
					h('span', { className: 'dshdv-barSpacer' }),
					h('span', { className: 'dshdv-filter' },
						h('input', {
							type: 'search', value: filter, placeholder: t('history.filter'),
							'aria-label': t('history.filter'), 'data-dsh-diff-filter': '',
							onChange: function (event) { setFilter(event.target.value); },
						}),
						filter === '' ? null : h('button', {
							type: 'button', className: 'dshdv-filterClear', 'aria-label': t('filter.clear'),
							onClick: function () { setFilter(''); },
						}, '×')),
					h('button', {
						type: 'button', className: 'dshdv-btn',
						title: oldestFirst ? t('history.newestFirst') : t('history.oldestFirst'),
						'aria-label': t('history.label'),
						'aria-pressed': oldestFirst,
						'data-dsh-diff-order': oldestFirst ? 'old' : 'new',
						onClick: function () {
							markActive();
							setOldestFirst(!oldestFirst);
							writePreference(ORDER_KEY, !oldestFirst ? 'old' : 'new');
						},
					}, icon(ICON_SORT)),
					h('button', {
						type: 'button', className: 'dshdv-btn', 'aria-pressed': auto,
						title: auto ? t('action.auto.on') : t('action.auto.off'), 'aria-label': t('action.auto'),
						'data-dsh-diff-auto': auto ? 'on' : 'off',
						onClick: function () {
							setAuto(!auto);
							writePreference(AUTO_KEY, !auto ? 'on' : 'off');
						},
					}, h('span', { 'aria-hidden': 'true' }, auto ? '●' : '○')),
					h('button', {
						type: 'button', className: 'dshdv-btn', title: t('action.refresh'), 'aria-label': t('action.refresh'),
						'data-dsh-diff-refresh': '',
						onClick: function () {
							void controller.refresh(sessionId);
							void controller.readHistory(sessionId);
						},
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
								void controller.commit(sessionId, state.turn);
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

				notice === null ? null : h('p', { className: 'dshdv-note', 'data-dsh-diff-notice': notice }, t(notice)),

				state.commitNote === null
					? null
					: h('p', {
						className: 'dshdv-note',
						'data-dsh-diff-commit-note': state.commitNote.key,
						'data-phase': state.commitPhase,
						role: 'status',
					}, format(t(state.commitNote.key), state.commitNote.values)),

				h('div', { className: 'dshdv-main', ref: mainRef },
					h('div', { className: 'dshdv-gitLeft', ref: leftRef }, historyPane, gripH, filesPane),
					gripV,
					detailPane));
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
		/** The shell's own tree vocabulary.
		 *
		 * A file tree that draws its own folder shapes and category colours is a
		 * tree that drifts from the files panel beside it. These four are what
		 * `ui-sidebar-files` itself renders: a type-coloured sheet per file, an
		 * open/closed folder glyph (the icon IS the expansion state — no twist
		 * triangle in the shell's panel), and a path label that keeps the trailing
		 * name visible in a narrow column.
		 */
		var FileTypeIcon = isRenderable(PRIMITIVES.FileTypeIcon) ? PRIMITIVES.FileTypeIcon : null;
		var classifyFileType = typeof PRIMITIVES.classifyFileType === 'function' ? PRIMITIVES.classifyFileType : null;
		var IconFolderOpen = isRenderable(PRIMITIVES.IconFolderOpenRegular) ? PRIMITIVES.IconFolderOpenRegular : null;
		var IconFolderClosed = isRenderable(PRIMITIVES.IconFolderCloseRegular) ? PRIMITIVES.IconFolderCloseRegular : null;
		var PathLabel = isRenderable(PRIMITIVES.PathLabel) ? PRIMITIVES.PathLabel : null;
		/**
		 * The shell's own highlighter and language table: the same grammars the chat's
		 * code blocks use, one token list per line. Optional — without it the editor
		 * still edits, it simply shows no colors.
		 */
		var useHighlighter = typeof PRIMITIVES.useCodeHighlighter === 'function' ? PRIMITIVES.useCodeHighlighter : null;
		var languageForPath = typeof PRIMITIVES.languageForPath === 'function' ? PRIMITIVES.languageForPath : null;
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
		/** The absolute time a commit carries, for the row's hover text. */
		function absoluteTime(at) {
			var parsed = new Date(at);
			return Number.isNaN(parsed.getTime()) ? String(at) : parsed.toLocaleString();
		}

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
		 * The file view
		 *
		 * A tree on the left, a tabbed editor on the right — the shape
		 * `dsh-vscode` gives its files panel and the shape `dsh-better-sidebar`
		 * gives its workbench. What each taught this implementation:
		 *
		 *   - the tree lists one level per request, directories first, and never
		 *     waits for a change subscription before its first read;
		 *   - every open tab stays MOUNTED and merely hidden, so switching tabs
		 *     never tears down a draft;
		 *   - the editor is an uncontrolled surface: a keystroke updates the DOM
		 *     and, at most once, the "this file is dirty" bit;
		 *   - and the one thing neither reference could hand over: saving. The
		 *     shell's `workspaceFiles` exposes no write, so `lib/workspace.js`
		 *     serves read and write together and checks `(mtimeMs, bytes)` before
		 *     a save lands.
		 * ------------------------------------------------------------------ */

		/** Where the open tabs live, per Session (per browser, like this plugin's other prefs). */
		var TABS_KEY = NAMESPACE + '.tabs';
		/** How long tab changes settle before they are written. */
		var TABS_DEBOUNCE_MS = 250;
		/** How many entries one level renders before it says so. */
		var TREE_RENDER_CAP = 800;
		/**
		 * How long typing settles before the grammar is asked to re-tokenize.
		 *
		 * A keystroke must never wait for a parse, and a parse per keystroke is what
		 * makes an editor feel heavy: the draft is painted immediately (plain) and the
		 * colors arrive once the reader pauses.
		 */
		var HIGHLIGHT_DEBOUNCE_MS = 120;
		/** Above this many lines a file is edited without colors rather than slowly. */
		var HIGHLIGHT_LINE_CAP = 4000;

		/** Extensions drawn with the code glyph; anything else gets the plain sheet. */
		var CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'sh', 'ps1', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sql', 'vue', 'svelte']);
		/** Extensions drawn with the markdown glyph. */
		var MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
		/** Extensions drawn with the image glyph. */
		var IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

		/** The last path segment of a slash-separated path. */
		function baseName(path) {
			var at = path.lastIndexOf('/');
			return at === -1 ? path : path.slice(at + 1);
		}

		/** The lower-case extension of a name, without the dot. */
		function extensionOf(name) {
			var at = name.lastIndexOf('.');
			return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
		}

		/** Which glyph a name gets: `code`, `markdown`, `image`, or `plain`. */
		function glyphFor(name) {
			var extension = extensionOf(name);
			if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
			if (IMAGE_EXTENSIONS.has(extension)) return 'image';
			if (CODE_EXTENSIONS.has(extension)) return 'code';
			return 'plain';
		}

		/** Which preview a path gets, if it is not simply edited as text. */
		var MARKDOWN_VIEW = 'markdown';
		var TEXT_VIEW = 'text';
		var FOREIGN_VIEW = 'foreign';

		/**
		 * How one file should be shown.
		 *
		 * The split follows the reference implementation's own decision: the shell
		 * ships read-only previews for images, PDFs, office documents, spreadsheets
		 * and plain text (with zoom and auto-refresh), so a plugin that re-draws them
		 * is strictly worse — those are handed to the shell's previewer. What is left
		 * for this pane is the two surfaces a previewer is not: an EDITOR for text,
		 * and the two previews worth having inline (Markdown through the shell's own
		 * renderer, HTML through a sandboxed frame).
		 *
		 * @param path - workspace-relative path.
		 * @param doc - the loaded document, if any.
		 * @returns one of `markdown` / `html` / `text` / `foreign`.
		 */
		function viewerKindOf(path, doc) {
			var extension = extensionOf(path);
			if (MARKDOWN_EXTENSIONS.has(extension)) return MARKDOWN_VIEW;
			if (doc !== undefined && doc !== null && typeof doc.text === 'string' && doc.binary !== true && doc.oversized !== true) return TEXT_VIEW;
			return FOREIGN_VIEW;
		}

		/**
		 * Build a `dsh-resource://file/session/…` address for one file.
		 *
		 * The grammar's own helper lives in a package that is not in the module
		 * table, so the address is assembled here — component-encoding each segment
		 * and keeping `:` literal so a Windows drive letter reads as written.
		 *
		 * @param sessionId - the Session whose workspace resolves the path.
		 * @param path - workspace-relative path.
		 * @returns the address.
		 */
		function fileAddress(sessionId, path) {
			var segments = [encodeURIComponent(sessionId)];
			path.split('/').forEach(function (segment) {
				if (segment !== '') segments.push(encodeURIComponent(segment).split('%3A').join(':'));
			});
			return 'dsh-resource://file/session/' + segments.join('/');
		}

		/** The raw URL a preview frame or a download points at. */
		function rawUrl(sessionId, path, download) {
			return ROUTES_RAW + '?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path) + (download === true ? '&download=1' : '');
		}

		/** The state the file view starts from. */
		function filesState() {
			return {
				phase: 'idle',
				error: null,
				root: null,
				/** One entry per level already read: `''` is the root. */
				levels: {},
				expanded: [''],
				/** Open tabs, in strip order. */
				tabs: [],
				active: null,
				/** One document per open tab: how its read went, and what it held. */
				docs: {},
				/** Which tabs hold unsaved edits. */
				dirty: {},
				/** Tabs whose save was refused because the disk moved. */
				conflicts: {},
				/** Tabs whose save failed, with the reason. */
				failures: {},
				/** The tab showing the highlighted (read-only) view instead of the editor. */
				highlighting: null,
				/** Per-tab preview/edit choice; absent means "by kind". */
				modes: {},
				/** Whether the shell previewer refused the last hand-off. */
				openFailed: false,
			};
		}

		function createFilesController(t) {
			var listeners = new Set();
			var state = filesState();
			var epoch = 0;
			/** One generation per LEVEL: only the last read of a path may write it. */
			var levelGenerations = new Map();
			var docGeneration = 0;
			var saveGeneration = 0;
			var writeTimer = undefined;

			function emit() {
				listeners.forEach(function (listener) { listener(); });
			}

			function patch(next) {
				if (sameState(state, next)) return;
				state = Object.assign({}, state, next);
				emit();
			}

			/** Remember the open tabs for this Session, debounced. */
			function scheduleWrite(sessionId) {
				if (writeTimer !== undefined) window.clearTimeout(writeTimer);
				writeTimer = window.setTimeout(function () {
					writeTimer = undefined;
					writePreference(TABS_KEY + ':' + sessionId, JSON.stringify({ tabs: state.tabs, active: state.active }));
				}, TABS_DEBOUNCE_MS);
			}

			/** Read the tabs this browser last had open for the Session. */
			function rememberedTabs(sessionId) {
				var raw = readPreference(TABS_KEY + ':' + sessionId, '');
				if (raw === '') return { tabs: [], active: null };
				try {
					var parsed = JSON.parse(raw);
					var tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(function (path) { return typeof path === 'string' && path !== ''; }) : [];
					var active = typeof parsed.active === 'string' && tabs.indexOf(parsed.active) !== -1 ? parsed.active : (tabs.length > 0 ? tabs[tabs.length - 1] : null);
					return { tabs: tabs, active: active };
				} catch (error) {
					return { tabs: [], active: null };
				}
			}

			var controller = {
				getSnapshot: function () { return state; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},

				/** Read the root level and restore this browser's tabs. */
				load: async function (sessionId, options) {
					var silent = options !== undefined && options.silent === true;
					var current = (epoch += 1);
					var stale = function () { return current !== epoch; };
					if (!silent) patch({ phase: 'loading', error: null, levels: {}, expanded: [''] });
					var answer = await controller.readLevel(sessionId, '');
					if (stale()) return;
					if (answer === undefined) return;
					var remembered = rememberedTabs(sessionId);
					patch({ phase: 'ready', root: answer.cwd === undefined ? (state.root === null ? '' : state.root) : answer.cwd });
					for (var at = 0; at < remembered.tabs.length; at += 1) {
						if (stale()) return;
						await controller.open(sessionId, remembered.tabs[at], { silent: true, activate: false });
					}
					if (stale()) return;
					if (remembered.active !== null) patch({ active: remembered.active });
				},

				/**
				 * Read one level into the model.
				 *
				 * The generation guard is per level, not global: two directories can be
				 * read at once (the reader expands a second one while the first is in
				 * flight), and only the LAST read of a given path may write.
				 */
				readLevel: async function (sessionId, path) {
					var generation = (levelGenerations.get(path) ?? 0) + 1;
					levelGenerations.set(path, generation);
					var started = epoch;
					patch({ levels: Object.assign({}, state.levels, { [path]: { phase: 'loading', entries: [], truncated: false, error: null } }) });
					var result;
					try {
						result = await readJson(TREE_URL(sessionId, path), undefined);
					} catch (error) {
						result = { failed: 'error.generic' };
					}
					if (started !== epoch) return undefined;
					if (levelGenerations.get(path) !== generation) return undefined;
					if (result.failed !== undefined) {
						patch({ levels: Object.assign({}, state.levels, { [path]: { phase: 'failed', entries: [], truncated: false, error: result.failed } }) });
						return undefined;
					}
					var value = result.value;
					var entries = Array.isArray(value.entries) ? value.entries : [];
					patch({ levels: Object.assign({}, state.levels, { [path]: { phase: 'ready', entries: entries, truncated: value.truncated === true, error: null } }) });
					return { cwd: value.cwd, entries: entries };
				},

				/** Expand or collapse one directory, reading it the first time. */
				toggle: async function (sessionId, path) {
					var expanded = state.expanded.slice();
					var at = expanded.indexOf(path);
					if (at === -1) expanded.push(path);
					else expanded.splice(at, 1);
					patch({ expanded: expanded });
					if (at === -1 && state.levels[path] === undefined) await controller.readLevel(sessionId, path);
				},

				/** Re-read one directory (the refresh button, or a save that changed it). */
				refreshLevel: async function (sessionId, path) {
					await controller.readLevel(sessionId, path);
				},

				/** Open a tab: read the file unless it is already open. */
				open: async function (sessionId, path, options) {
					var activate = options === undefined || options.activate !== false;
					var silent = options !== undefined && options.silent === true;
					var known = state.tabs.indexOf(path) !== -1;
					var tabs = known ? state.tabs : state.tabs.concat([path]);
					patch({
						tabs: tabs,
						...(activate ? { active: path } : {}),
					});
					if (known && state.docs[path] !== undefined && state.docs[path].phase === 'ready') {
						scheduleWrite(sessionId);
						return;
					}
					var generation = (docGeneration += 1);
					var started = epoch;
					patch({ docs: Object.assign({}, state.docs, { [path]: Object.assign({}, state.docs[path], { phase: 'loading', error: null }) }) });
					var result;
					try {
						result = await readJson(READ_URL(sessionId, path), undefined);
					} catch (error) {
						result = { failed: 'error.generic' };
					}
					if (started !== epoch || generation !== docGeneration) return;
					if (result.failed !== undefined) {
						patch({ docs: Object.assign({}, state.docs, { [path]: { phase: 'failed', text: '', mtimeMs: 0, bytes: 0, error: result.failed } }) });
						return;
					}
					var value = result.value;
					patch({
						docs: Object.assign({}, state.docs, {
							[path]: {
								phase: 'ready',
								text: typeof value.text === 'string' ? value.text : '',
								mtimeMs: value.mtimeMs,
								bytes: value.bytes,
								binary: value.binary === true,
								oversized: value.oversized === true,
								error: null,
							},
						}),
						dirty: Object.assign({}, state.dirty, { [path]: false }),
						conflicts: Object.assign({}, state.conflicts, { [path]: false }),
						failures: Object.assign({}, state.failures, { [path]: null }),
					});
					if (!silent) scheduleWrite(sessionId);
				},

				/** Bring one tab to the front. */
				activate: function (sessionId, path) {
					if (state.active === path) return;
					patch({ active: path });
					scheduleWrite(sessionId);
				},

				/** Close a tab, asking first when it holds unsaved edits. */
				close: function (sessionId, path) {
					if (state.dirty[path] === true) {
						var question = t('files.unsavedConfirm', { name: baseName(path) });
						var confirmed = typeof window.confirm === 'function' ? window.confirm(question) : true;
						if (!confirmed) return;
					}
					var tabs = state.tabs.filter(function (entry) { return entry !== path; });
					var docs = Object.assign({}, state.docs);
					delete docs[path];
					var dirty = Object.assign({}, state.dirty);
					delete dirty[path];
					var active = state.active;
					if (active === path) active = tabs.length > 0 ? tabs[tabs.length - 1] : null;
					patch({ tabs: tabs, active: active, docs: docs, dirty: dirty });
					scheduleWrite(sessionId);
				},

				/**
				 * Note that a tab's draft differs from what was read.
				 *
				 * Called once per editing session, not once per keystroke: the caller
				 * compares the textarea against the loaded text and only reports the
				 * transition, so typing costs no render.
				 */
				setDirty: function (path, dirty) {
					if (state.dirty[path] === dirty) return;
					patch({ dirty: Object.assign({}, state.dirty, { [path]: dirty }) });
				},

				/** Show the highlighted (read-only) view for one tab, or go back to editing. */
				setHighlight: function (path, on) {
					patch({ highlighting: on ? path : (state.highlighting === path ? null : state.highlighting) });
				},
				/** Note that the shell previewer refused the last hand-off. */
				noteOpenFailed: function (failed) {
					if (state.openFailed === failed) return;
					patch({ openFailed: failed });
				},

				/** Choose preview, split or edit for one tab; the default comes from its kind. */
				setMode: function (path, mode) {
					patch({ modes: Object.assign({}, state.modes, { [path]: mode }) });
				},

				/**
				 * The mode one tab is in.
				 *
				 * Only Markdown has more than one: it is the one type whose source and
				 * whose rendering are both worth looking at, so it gets edit / preview /
				 * side-by-side. Everything else is edited, which is what an editor does
				 * with source — the mode controls are hidden for those.
				 */
				modeOf: function (path) {
					var chosen = state.modes[path];
					if (viewerKindOf(path, state.docs[path]) !== MARKDOWN_VIEW) return 'edit';
					if (chosen === 'preview' || chosen === 'edit' || chosen === 'split') return chosen;
					return 'preview';
				},

				/** Whether one path's editor paints syntax colors. */
				highlightsPath: function (path) {
					return state.highlighting !== path;
				},

				/** Turn the editor's syntax colors on or off for one tab. */
				setHighlighting: function (path, on) {
					patch({ highlighting: on ? null : path });
				},

				/**
				 * Save one tab.
				 *
				 * The freshness pair from the read travels with the save; the Host refuses
				 * a write whose pair no longer matches the disk, and that refusal is shown
				 * as a conflict with an explicit overwrite — never retried silently.
				 */
				save: async function (sessionId, path, text, force) {
					var doc = state.docs[path];
					if (doc === undefined) return;
					var generation = (saveGeneration += 1);
					var started = epoch;
					patch({ failures: Object.assign({}, state.failures, { [path]: null }) });
					var body = { sessionId: sessionId, path: path, content: text };
					if (force !== true) body.expected = { mtimeMs: doc.mtimeMs, bytes: doc.bytes };
					var answer;
					try {
						var response = await fetch(WRITE_URL, {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(body),
						});
						var payload = null;
						try { payload = await response.json(); } catch (error) { payload = null; }
						answer = { ok: response.ok && payload !== null && payload.ok === true, status: response.status, body: payload };
					} catch (error) {
						answer = { ok: false, status: 0, body: null };
					}
					if (started !== epoch || generation !== saveGeneration) return;
					if (answer.ok !== true) {
						var code = answer.body === null || answer.body === undefined || answer.body.error === undefined ? undefined : answer.body.error.code;
						if (code === 'diff/conflict') {
							patch({ conflicts: Object.assign({}, state.conflicts, { [path]: true }), dirty: Object.assign({}, state.dirty, { [path]: true }) });
							return;
						}
						var detail = answer.body !== null && answer.body !== undefined && answer.body.error !== undefined ? String(answer.body.error.message ?? '') : '';
						patch({ failures: Object.assign({}, state.failures, { [path]: detail === '' ? t('files.saveFailed', { detail: String(answer.status) }) : t('files.saveFailed', { detail: detail }) }) });
						return;
					}
					patch({
						docs: Object.assign({}, state.docs, {
							[path]: Object.assign({}, doc, { text: text, mtimeMs: answer.body.mtimeMs, bytes: answer.body.bytes }),
						}),
						dirty: Object.assign({}, state.dirty, { [path]: false }),
						conflicts: Object.assign({}, state.conflicts, { [path]: false }),
						failures: Object.assign({}, state.failures, { [path]: null }),
					});
					/* The file on disk moved, so the tree may have: a save can create a file
					 * or change nothing at all, and re-reading the parent is cheap. */
					var parent = path.indexOf('/') === -1 ? '' : path.slice(0, path.lastIndexOf('/'));
					if (state.expanded.indexOf(parent) !== -1) await controller.readLevel(sessionId, parent);
				},

				/** Forget a file's draft and read it again from disk. */
				reload: async function (sessionId, path) {
					var docs = Object.assign({}, state.docs);
					delete docs[path];
					patch({ docs: docs, dirty: Object.assign({}, state.dirty, { [path]: false }), conflicts: Object.assign({}, state.conflicts, { [path]: false }) });
					await controller.open(sessionId, path, { activate: false });
				},

				reset: function () {
					if (writeTimer !== undefined) window.clearTimeout(writeTimer);
					writeTimer = undefined;
					epoch += 1;
					state = filesState();
					emit();
				},
			};
			return controller;
		}

		function TREE_URL(sessionId, path) {
			return ROUTES_TREE + '?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path);
		}

		function READ_URL(sessionId, path) {
			return ROUTES_READ + '?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(path);
		}

		/** The folder / file sheet glyphs, in the shell's 16×16 1px-stroke language. */
		function fileGlyph(kind, isDirectory, open) {
			if (isDirectory) {
				return icon(open
					? [['M2.5 5.5h4l1-1.5h6v8.5h-11z'], ['M2.5 5.5v7h11']]
					: [['M2.5 4.5h4.2l1.1-1.6h5.7v9.6h-11z']]);
			}
			var sheet = [['M4 2.5h5.2L12 5.3v8.2H4z'], ['M9.2 2.5v2.8H12']];
			var mark = kind === 'code'
				? [['M6.6 8.2 5.4 9.6l1.2 1.4'], ['M9.4 8.2l1.2 1.4-1.2 1.4']]
				: kind === 'markdown'
					? [['M6 11.2V8l1.4 1.8L8.8 8v3.2'], ['M9.9 8v3.2l1.1-1.4']]
					: kind === 'image'
						? [['M6 8.4h4.2v3H6z'], ['M6.6 10.8l1-1.1.9.8']]
						: [];
			return icon(sheet.concat(mark));
		}

		/** One directory level, rendered as rows. */
		function TreeLevel(props) {
			var entries = props.entries;
			var depth = props.depth;
			return h('div', { className: 'dshdv-fvLevel', role: 'group' },
				entries.slice(0, TREE_RENDER_CAP).map(function (entry) {
					var path = props.prefix === '' ? entry.name : props.prefix + '/' + entry.name;
					var isDirectory = entry.type === 'directory';
					var open = isDirectory && props.expanded.indexOf(path) !== -1;
					var level = props.levels[path];
					var rows = [
						h('button', {
							key: 'row',
							type: 'button',
							role: 'treeitem',
							className: 'dshdv-fvRow',
							'data-path': path,
							'data-kind': entry.type,
							'aria-expanded': isDirectory ? open : undefined,
							'aria-selected': isDirectory ? undefined : path === props.active,
							'aria-disabled': entry.type === 'other' ? 'true' : undefined,
							title: path,
							style: { paddingLeft: String(10 + depth * 18) + 'px' },
							onClick: function () {
								props.markActive();
								if (isDirectory) { void props.onToggle(path); return; }
								if (entry.type === 'other') return;
								void props.onOpen(path);
							},
						},
							h('span', { className: 'dshdv-fvGlyph' + (isDirectory ? ' dshdv-fvGlyphDir' : '') },
								isDirectory
									? (open
										? (IconFolderOpen !== null ? h(IconFolderOpen, null) : fileGlyph('plain', true, true))
										: (IconFolderClosed !== null ? h(IconFolderClosed, null) : fileGlyph('plain', true, false)))
									: (FileTypeIcon !== null && classifyFileType !== null
										? h(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16 })
										: fileGlyph(glyphFor(entry.name), false, false))),
							h('span', { className: 'dshdv-fvName' }, entry.name),
							props.dirty.indexOf(path) === -1 ? null : h('span', { className: 'dshdv-fvBadge' }, '●')),
					];
					if (isDirectory && open && level !== undefined) {
						if (level.phase === 'loading') rows.push(h('p', { key: 'loading', className: 'dshdv-fvNote', style: { paddingLeft: String(10 + (depth + 1) * 18) + 'px' } }, props.t('files.loading')));
						else if (level.phase === 'failed') rows.push(h('p', { key: 'failed', className: 'dshdv-fvError', style: { paddingLeft: String(10 + (depth + 1) * 18) + 'px' } }, props.t(level.error === null ? 'error.generic' : level.error)));
						else if (level.entries.length === 0) rows.push(h('p', { key: 'empty', className: 'dshdv-fvNote', style: { paddingLeft: String(10 + (depth + 1) * 18) + 'px' } }, props.t('files.empty')));
						else {
							rows.push(h(TreeLevel, {
								key: 'level',
								prefix: path,
								entries: level.entries,
								levels: props.levels,
								expanded: props.expanded,
								dirty: props.dirty,
								active: props.active,
								depth: depth + 1,
								t: props.t,
								markActive: props.markActive,
								onToggle: props.onToggle,
								onOpen: props.onOpen,
							}));
							if (level.truncated) rows.push(h('p', { key: 'cut', className: 'dshdv-fvNote', style: { paddingLeft: String(10 + (depth + 1) * 18) + 'px' } }, props.t('files.truncated', { count: String(level.entries.length) })));
						}
					}
					return h(React.Fragment, { key: path }, rows);
				}));
		}

		/**
		 * A code editor with syntax highlighting, the way an editor does it.
		 *
		 * There is no editable highlighted control in the shell — its `CodeBlock` is
		 * read-only — and this bundle cannot ship CodeMirror. So the highlighting is a
		 * layer: the shell's own highlighter (`useCodeHighlighter`, the same grammar
		 * table the chat's code blocks use) paints an absolutely positioned column of
		 * lines BEHIND a textarea whose own glyphs are transparent but whose caret and
		 * selection are not. What makes the illusion hold is that the two layers get
		 * byte-identical metrics — the same `font` shorthand, the same padding, the
		 * same `white-space: pre`, the same `tab-size` — so a source line is a 19px
		 * line box in both no matter how many token spans it carries.
		 *
		 * Typing must never wait for a grammar: the input handler writes the plain
		 * draft straight into the layer through a ref (one string assignment, no
		 * React render, no highlighter), and the highlighted painting arrives on a
		 * debounce. The layer is filled imperatively for that reason — React owns the
		 * element, never its children.
		 */
		function CodeEditor(props) {
			var path = props.path;
			var text = props.text;
			var t = props.tr === undefined ? props.t : props.tr;
			var language = languageForPath === null ? undefined : languageForPath(path);
			/* A hook cannot be called conditionally, so the module-level binding is
			 * called either way: without the shell's highlighter it is a no-op that
			 * reports "no spans", which is the same fallback an unknown grammar gets. */
			var highlight = useHighlighter !== null ? useHighlighter(language) : noHighlight;
			var layerRef = React.useRef(null);
			var gutterRef = React.useRef(null);
			var boxRef = React.useRef(null);
			var textRef = React.useRef(null);
			var [painting, setPainting] = React.useState(text);
			var highlighting = props.highlighting !== false;

			React.useEffect(function () {
				var timer = window.setTimeout(function () { setPainting(text); }, HIGHLIGHT_DEBOUNCE_MS);
				return function () { window.clearTimeout(timer); };
			}, [text]);

			/* Paint the layer: plain text while typing, tokens once the grammar has
			 * caught up. Both paths produce the same line boxes. */
			React.useEffect(function () {
				var node = layerRef.current;
				if (node === null) return;
				var spans = highlighting ? highlight(painting) : undefined;
				var count = painting.split('\n').length;
				node.textContent = '';
				if (spans === undefined || count > HIGHLIGHT_LINE_CAP) {
					/* The zero-width character keeps the final empty line's box: a `<pre>`
					 * drops the newline that sits right before its end tag, and without
					 * that box the layer would be one line shorter than the textarea. */
					node.textContent = painting + '\u200b';
					return;
				}
				var fragment = document.createDocumentFragment();
				for (var at = 0; at < count; at += 1) {
					var line = document.createElement('div');
					line.className = 'dshdv-fvCodeLine';
					var tokens = at < spans.length ? spans[at] : [];
					for (var token = 0; token < tokens.length; token += 1) {
						var span = document.createElement('span');
						span.textContent = tokens[token].text;
						if (tokens[token].style !== undefined) span.setAttribute('style', 'color:' + String(tokens[token].style.color ?? ''));
						line.appendChild(span);
					}
					/* An empty line still needs its box, or every line below it shifts. */
					if (tokens.length === 0) line.appendChild(document.createTextNode('\u200b'));
					fragment.appendChild(line);
				}
				node.appendChild(fragment);
			}, [painting, highlighting, highlight]);

			/** Keep the two layers and the gutter on the textarea's scroll position. */
			var syncScroll = function () {
				var area = textRef.current;
				if (area === null) return;
				if (layerRef.current !== null) layerRef.current.style.transform = 'translate(' + String(-area.scrollLeft) + 'px,' + String(-area.scrollTop) + 'px)';
				if (gutterRef.current !== null) gutterRef.current.style.transform = 'translateY(' + String(-area.scrollTop) + 'px)';
			};

			var lineCount = text.split('\n').length;
			var numbers = [];
			for (var line = 1; line <= lineCount; line += 1) numbers.push(h('div', { key: line, className: 'dshdv-fvCodeNum' }, String(line)));

			return h('div', { className: 'dshdv-fvCode', ref: boxRef, 'data-dsh-diff-files-editor': path },
				h('div', { className: 'dshdv-fvGutter' },
					h('div', { className: 'dshdv-fvGutterInner', ref: gutterRef, 'data-dsh-diff-files-gutter': path }, numbers)),
				h('pre', { className: 'dshdv-fvCodeLayer', ref: layerRef, 'aria-hidden': 'true', 'data-dsh-diff-files-layer': path }),
				h('textarea', {
					/* Uncontrolled: the draft lives in the DOM, so typing costs no render
					 * and the model only hears the false→true transition. `wrap="off"`
					 * keeps one source line on one visual line, which is what lets the
					 * layer behind it stay aligned. */
					ref: function (node) { textRef.current = node; if (props.registry !== undefined) props.registry.current[path] = node; },
					className: highlighting ? 'dshdv-fvText dshdv-fvGhost' : 'dshdv-fvText',
					'data-dsh-diff-files-input': path,
					spellCheck: false,
					wrap: 'off',
					defaultValue: text,
					onScroll: syncScroll,
					onInput: function (event) {
						props.onTouch();
						var value = event.target.value;
						/* The reader must see their own keystrokes NOW: paint the plain
						 * draft directly, then let the debounce bring the colors. */
						if (layerRef.current !== null && highlighting) layerRef.current.textContent = value;
						props.onDirty(value !== text);
					},
					onKeyDown: function (event) {
						if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
							event.preventDefault();
							props.onSave(event.currentTarget.value);
						}
					},
				}),
				props.extra);
		}

		/** What a component without the shell's highlighter uses: no tokens, ever. */
		function noHighlight() {
			return undefined;
		}

		/** The file view: tree, tab strip, editor. */
		function FilesView(props) {
			var controller = props.controller;
			var sessionId = props.sessionId;
			/* This plugin's own translator, passed in by `inject`. The shell's `t` is
			 * bound to the dictionary registered when the namespace was FIRST loaded,
			 * so a key added by a later bundle resolves to itself there; ours falls
			 * back to the copy that shipped with THIS bundle. */
			var t = props.tr === undefined ? props.t : props.tr;
			var openInShell = props.openInShell === undefined ? function () { return false; } : props.openInShell;
			/** Ask the shell to preview a file, and say so when it cannot. */
			var handOver = function (path) {
				markActive();
				controller.noteOpenFailed(openInShell(path) !== true);
			};
			var state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			var activeUntil = React.useRef(0);
			var markActive = function () { activeUntil.current = Date.now() + TURNS_ACTIVE_MS; };
			/* MarkdownText memoizes its vocabulary; a fresh labels object each render
			 * would discard its cache — the same rule the shell's chat view follows. */
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

			var rootLevel = state.levels[''];
			var listBody;
			if (state.phase === 'loading' || (rootLevel !== undefined && rootLevel.phase === 'loading')) {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, t('files.loading')));
			} else if (state.phase === 'error') {
				listBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(state.error === null ? 'error.generic' : state.error)),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { void controller.load(sessionId); } }, t('error.retry')));
			} else if (rootLevel !== undefined && rootLevel.phase === 'failed') {
				listBody = h('div', { className: 'dshdv-status' },
					h('p', null, t(rootLevel.error === null ? 'error.generic' : rootLevel.error)),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { void controller.refreshLevel(sessionId, ''); } }, t('error.retry')));
			} else if (rootLevel !== undefined && rootLevel.phase === 'ready' && rootLevel.entries.length === 0) {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, t('files.empty')));
			} else if (rootLevel !== undefined && rootLevel.phase === 'ready') {
				listBody = h(TreeLevel, {
					prefix: '',
					entries: rootLevel.entries,
					levels: state.levels,
					expanded: state.expanded,
					dirty: Object.keys(state.dirty).filter(function (path) { return state.dirty[path] === true; }),
					active: state.active,
					depth: 0,
					t: t,
					markActive: markActive,
					onToggle: function (path) { return controller.toggle(sessionId, path); },
					onOpen: function (path) { return controller.open(sessionId, path); },
				});
			} else {
				listBody = h('div', { className: 'dshdv-status' }, h('p', null, t('files.loading')));
			}

			var dirtyPaths = state.tabs.filter(function (path) { return state.dirty[path] === true; });
			var tabStrip = h('div', { className: 'dshdv-fvTabs', role: 'tablist', 'data-dsh-diff-files-tabs': '' },
				h('div', { className: 'dshdv-fvTabList' }, state.tabs.map(function (path) {
					return h('span', {
						key: path,
						className: 'dshdv-fvTab',
						role: 'tab',
						'data-path': path,
						'aria-selected': path === state.active,
					},
						state.dirty[path] === true ? h('span', { className: 'dshdv-fvDot', 'aria-hidden': 'true' }) : null,
						h('button', {
							type: 'button',
							className: 'dshdv-fvTabName',
							title: path,
							style: { border: '0', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', padding: '0' },
							onClick: function () {
								markActive();
								controller.activate(sessionId, path);
							},
						}, baseName(path)),
						h('button', {
							type: 'button',
							className: 'dshdv-fvTabClose',
							'aria-label': t('files.close'),
							title: t('files.close'),
							onClick: function () {
								markActive();
								controller.close(sessionId, path);
							},
						}, '×'));
				})),
				null);

			var activePath = state.active;
			var activeDoc = activePath === null ? undefined : state.docs[activePath];
			var activeKind = activePath === null || activeDoc === undefined || activeDoc.phase !== 'ready' ? null : viewerKindOf(activePath, activeDoc);
			var activeMode = activePath === null ? 'edit' : controller.modeOf(activePath);

			/**
			 * One editing surface per OPEN tab, all of them mounted.
			 *
			 * Inactive panes are hidden, never unmounted: a draft lives in the
			 * textarea's DOM, so unmounting the pane the reader just left would throw
			 * the draft away — which is exactly the mistake the reference
			 * implementation documents avoiding ("Every tab stays MOUNTED (inactive
			 * ones hidden), so switching tabs never tears down the content").
			 */
			/** The live text of one tab: what the reader typed, or what was read. */
			function textFor(path) {
				var node = panes.current[path];
				if (node !== null && node !== undefined && typeof node.value === 'string') return node.value;
				var doc = state.docs[path];
				return doc === undefined ? '' : doc.text;
			}

			var panes = React.useRef({});

			/** The textarea of a Markdown tab in split mode lives here too. */
			var splitPanes = React.useRef({});

			function editorFor(path, doc, options) {
				return h(CodeEditor, {
					key: (options !== undefined && options.key !== undefined ? options.key : '') + path,
					path: path,
					text: doc.text,
					registry: options !== undefined && options.registry !== undefined ? options.registry : panes,
					highlighting: controller.highlightsPath(path),
					t: t,
					onDirty: function (dirty) { controller.setDirty(path, dirty); },
					onSave: function (text) { void controller.save(sessionId, path, text, false); },
					onTouch: markActive,
					extra: options !== undefined && options.extra !== undefined ? options.extra : null,
				});
			}

			function paneBody(path) {
				var doc = state.docs[path];
				var t2 = t;
				if (doc === undefined || doc.phase === 'loading') {
					return h('div', { className: 'dshdv-status' }, h('p', null, t2('files.loading')));
				}
				if (doc.phase === 'failed') {
					return h('div', { className: 'dshdv-status' },
						h('p', null, t2(doc.error === null ? 'error.generic' : doc.error)),
						h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { void controller.reload(sessionId, path); } }, t2('error.retry')));
				}
				var kind = viewerKindOf(path, doc);
				var mode = controller.modeOf(path);
				/* A type this pane cannot show at all — an image, a PDF, an office
				 * document, a binary — is handed to the shell's previewer, which has
				 * the renderer and the zoom controls already. */
				if (kind === FOREIGN_VIEW) {
					return h('div', { className: 'dshdv-status' },
						h('p', null, t2(doc.binary === true ? 'files.binary' : doc.oversized === true ? 'files.oversized' : 'files.foreign')),
						h('button', {
							type: 'button',
							className: 'dshdv-btn',
							'data-dsh-diff-files-open-shell': path,
							onClick: function () { handOver(path); },
						}, t2('files.openInShell')),
						h('a', {
							className: 'dshdv-btn',
							href: rawUrl(sessionId, path, true),
							download: baseName(path),
							'data-dsh-diff-files-download': path,
						}, t2('files.download')));
				}
				/* Only Markdown has anything to show besides its source: a rendered
				 * document. Code files are edited — highlighted — and that is the whole
				 * of their surface, which is what an editor like VS Code does too. */
				if (kind === MARKDOWN_VIEW && mode === 'preview') {
					return h('div', { className: 'dshdv-fvPreview', 'data-dsh-diff-files-preview': path },
						MarkdownText !== null
							? h(MarkdownText, { text: doc.text, labels: markdownLabels })
							: plainMarkdown(doc.text));
				}
				if (kind === MARKDOWN_VIEW && mode === 'split') {
					return h('div', { className: 'dshdv-fvSplit', 'data-dsh-diff-files-split': path },
						h('div', { className: 'dshdv-fvSplitSide' },
							editorFor(path, doc, { registry: splitPanes, key: 'split:' })),
						h('div', { className: 'dshdv-fvSplitPreview' },
							MarkdownText !== null
								? h(MarkdownText, { text: doc.text, labels: markdownLabels })
								: plainMarkdown(doc.text)));
				}
				return editorFor(path, doc, {});
			}

			var editorPanes = state.tabs.map(function (path) {
				var isActive = path === activePath;
				return h('div', {
					key: path,
					className: 'dshdv-fvPane',
					hidden: !isActive,
					'data-dsh-diff-files-pane': path,
					'data-active': isActive ? 'true' : undefined,
				}, paneBody(path));
			});

			var status = null;
			if (activePath !== null && activeDoc !== undefined && activeDoc.phase === 'ready') {
				if (state.conflicts[activePath] === true) status = t('files.conflict');
				else if (typeof state.failures[activePath] === 'string') status = state.failures[activePath];
				else if (state.dirty[activePath] === true) status = t('files.dirty');
				else status = t('files.saved');
			}

			var conflictBar = activePath !== null && state.conflicts[activePath] === true
				? h('div', { className: 'dshdv-fvConflict', role: 'status' },
					h('span', null, t('files.conflict')),
					h('button', {
						type: 'button',
						className: 'dshdv-btn',
						'data-dsh-diff-files-overwrite': '',
						onClick: function () { void controller.save(sessionId, activePath, textFor(activePath), true); },
					}, t('files.overwrite')),
					h('button', {
						type: 'button',
						className: 'dshdv-btn',
						'data-dsh-diff-files-reload': '',
						onClick: function () { void controller.reload(sessionId, activePath); },
					}, t('files.reload')))
				: null;

			var editorHead = activePath === null ? null : h('div', { className: 'dshdv-fvEditorHead' },
				h('span', { className: 'dshdv-fvPath' }, activePath),
				status === null ? null : h('span', { className: 'dshdv-fvStatus', 'data-dsh-diff-files-status': '' }, status),
				/* One segmented control, and only for Markdown: preview, side by side,
				 * edit. Code files have a single surface — the highlighted editor — so
				 * they get no switch to nowhere. Icon-only, like every other control in
				 * this head: the label lives in the tooltip and the accessible name. */
				activeKind === MARKDOWN_VIEW
					? h('span', { className: 'dshdv-fvModes', role: 'group', 'aria-label': t('files.mode') },
						[['preview', 'files.mode.preview', ICON_PREVIEW], ['split', 'files.mode.split', ICON_SPLIT], ['edit', 'files.mode.edit', ICON_PENCIL]].map(function (entry) {
							return h('button', {
								key: entry[0],
								type: 'button',
								className: 'dshdv-btn',
								'data-dsh-diff-files-mode': entry[0],
								'aria-pressed': activeMode === entry[0],
								title: t(entry[1]),
								'aria-label': t(entry[1]),
								onClick: function () { controller.setMode(activePath, entry[0]); },
							}, icon(entry[2]));
						}))
					: null,
				/* Colors in the editor are a preference, not a mode: code is edited
				 * with them on, and this is the way out if a grammar ever misbehaves. */
				activeKind !== null && activeKind !== FOREIGN_VIEW
					? h('button', {
						type: 'button',
						className: 'dshdv-btn',
						'data-dsh-diff-files-highlight-toggle': '',
						'aria-pressed': controller.highlightsPath(activePath),
						title: t('files.highlight'),
						'aria-label': t('files.highlight'),
						onClick: function () { controller.setHighlighting(activePath, !controller.highlightsPath(activePath)); },
					}, icon(ICON_HIGHLIGHT))
					: null,
				h('button', {
					type: 'button',
					className: 'dshdv-btn',
					'data-dsh-diff-files-open-shell-head': '',
					title: t('files.openInShell'),
					'aria-label': t('files.openInShell'),
					onClick: function () { handOver(activePath); },
				}, icon(ICON_EXTERNAL)),
				h('button', {
					type: 'button',
					className: 'dshdv-btn',
					'data-dsh-diff-files-save': '',
					title: t('files.save'),
					'aria-label': t('files.save'),
					disabled: activeDoc === undefined || activeDoc.phase !== 'ready' || activeKind === FOREIGN_VIEW,
					onClick: function () { void controller.save(sessionId, activePath, textFor(activePath), false); },
				}, icon(ICON_SAVE)));

			/* The container already draws the head and the conflict bar, so the body is
			 * only ever the panes — passing the head and the bar in here as well
			 * rendered both twice. */
			var editor = state.tabs.length === 0
				? h('div', { className: 'dshdv-status' }, h('p', null, t('files.noTabs')))
				: editorPanes;

			/* A hand-off the shell refused is news, and it is shown where the action
			 * was taken rather than in a console the reader never opens. */
			var openNotice = state.openFailed === true
				? h('div', { className: 'dshdv-fvConflict', role: 'status', 'data-dsh-diff-files-open-failed': '' },
					h('span', null, t('files.openFailed')),
					h('button', { type: 'button', className: 'dshdv-btn', onClick: function () { controller.noteOpenFailed(false); } }, t('turns.close')))
				: null;

			return h('div', { className: 'dshdv-root', 'data-dsh-diff-files': '', 'data-conversation-composer-overlay': '' },
				/* The header is the shell's own files-panel header: one 38px row holding
				 * the root path, then its tools. `PathLabel` keeps the trailing name
				 * visible when the column is narrow, which is the whole point of it. */
				h('div', { className: 'dshdv-fvHeader' },
					PathLabel !== null
						? h(PathLabel, { path: state.root === null ? t('files.root') : state.root, className: 'dshdv-fvHeaderPath', 'data-dsh-diff-files-path': '' })
						: h('span', { className: 'dshdv-fvHeaderPath', 'data-dsh-diff-files-path': '' }, state.root === null ? t('files.root') : state.root),
					h('button', {
						type: 'button',
						className: 'dshdv-btn',
						title: t('files.refresh'),
						'aria-label': t('files.refresh'),
						'data-dsh-diff-files-refresh': '',
						onClick: function () {
							markActive();
							void controller.refreshLevel(sessionId, '');
						},
					}, icon(ICON_REFRESH))),
				h('div', { className: 'dshdv-main' },
					h('div', { className: 'dshdv-fvTree' },
						h('div', { className: 'dshdv-fvTreeBody', role: 'tree', 'aria-label': t('files.label'), 'data-dsh-diff-files-tree': '' }, listBody)),
					h('div', { className: 'dshdv-fvMain' },
						tabStrip,
						h('div', { className: 'dshdv-fvEditor' }, editorHead, openNotice, conflictBar, editor))));
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
			/* Registering and binding are separate attempts on purpose. The locale
			 * service REFUSES a second registration of the same namespace+locale
			 * ("already has locale zh"), which is exactly what a plugin reload does —
			 * and it then keeps the dictionary from the FIRST load. Sharing one
			 * try-block would leave `bound` undefined after every reload, and worse,
			 * the shell's own copy would stay frozen at that first dictionary: a key
			 * added later resolves to itself. Binding anyway is what lets the fallback
			 * below carry the new copy. */
			try {
				ctx.locale.register(NAMESPACE, STRINGS);
			} catch (error) {
				console.warn('[dsh-diff-view] keeping the shell\'s existing dictionary:', error);
			}
			try {
				bound = ctx.locale.bind(NAMESPACE);
			} catch (error) {
				console.error('[dsh-diff-view] locale unavailable:', error);
			}
			return function (key, values) {
				var value = bound === undefined ? undefined : bound(key, values);
				if (typeof value === 'string' && value !== '' && value !== key) return value;
				/* The built-in dictionary is also the fallback's interpolator: without a
				 * locale service the shell cannot fill `{name}` in for us, and a raw
				 * placeholder in a confirmation question helps nobody. */
				var text = Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
				if (values !== undefined && values !== null && typeof text === 'string') {
					for (var name in values) text = text.split('{' + name + '}').join(String(values[name]));
				}
				return text;
			};
		}

		function apply(ctx) {
			ensureStyles();
			var t = createTranslator(ctx);
			var controllers = new Map();
			var turnControllers = new Map();
			var fileControllers = new Map();

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

			/**
			 * Hand one file to the shell's own previewer.
			 *
			 * The shell ships renderers this plugin should not re-draw (images, PDFs,
			 * office documents, spreadsheets, plain text, with zoom and auto-refresh),
			 * and the public way in is the sidebar-right controller's `openResource`
			 * with a `dsh-resource://file/session/…` address. A missing service or a
			 * refused address is a result, not a crash: the caller shows the notice.
			 */
			function openFileInShell(sessionId, path) {
				try {
					var service = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
					if (service === undefined || service === null || typeof service.openResource !== 'function') return false;
					service.openResource(fileAddress(sessionId, path));
					return true;
				} catch (error) {
					console.error('[dsh-diff-view] the shell previewer refused the file:', error);
					return false;
				}
			}

			/** The same, for the file view. */
			function filesFor(sessionId) {
				var existing = fileControllers.get(sessionId);
				if (existing !== undefined) return existing;
				var created = createFilesController(t);
				fileControllers.set(sessionId, created);
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
								return { controller: controllerFor(sessionId), tr: t };
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
								return { controller: turnsFor(sessionId), tr: t };
							},
						}, TurnsView);
					});
				} catch (error) {
					console.error('[dsh-diff-view] failed to register the turn view:', error);
					return undefined;
				}
			}, NAMESPACE + ': turn tab');

			ctx.effect(function () {
				try {
					return ctx.slots.inject('conversation.view', function () {
						return ctx.slots.register({
							name: 'conversation.view',
							id: FILES_ID,
							/* Third, after the changes tab: the same Session, opened as a
							 * working tree you can actually edit. */
							order: 22,
							locale: NAMESPACE,
							label: function () { return t('files.label'); },
							inject: function (sessionId) {
								return {
									controller: filesFor(sessionId),
									tr: t,
									openInShell: function (path) { return openFileInShell(sessionId, path); },
								};
							},
						}, FilesView);
					});
				} catch (error) {
					console.error('[dsh-diff-view] failed to register the file view:', error);
					return undefined;
				}
			}, NAMESPACE + ': files tab');

			ctx.effect(function () {
				return function () {
					controllers.clear();
					turnControllers.clear();
					fileControllers.clear();
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

