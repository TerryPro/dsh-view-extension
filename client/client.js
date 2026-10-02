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
		/** The view tab's id in the conversation's roster. */
		var VIEW_ID = 'diff';
		/** How long a silent auto-refresh waits between reads. */
		var AUTO_REFRESH_MS = 4000;
		/** Largest number of diff lines drawn for one file. */
		var MAX_RENDERED_LINES = 4000;
		/** Where the wrap preference lives (per browser, like the shell's own). */
		var WRAP_KEY = NAMESPACE + '.wrap';
		/** Where the last scope lives, so reopening the tab lands where it left. */
		var SCOPE_KEY = NAMESPACE + '.scope';

		var FILES_URL = '/api/dsh-diff/files';
		var FILE_URL = '/api/dsh-diff/file';

		var GIT = 'git';
		var SESSION = 'session';

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
			'.dshdv-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1b1f24);background:var(--dsw-alias-bg-base,#fff);font-size:13px}',
			'.dshdv-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));flex:none;min-height:40px}',
			'.dshdv-tabs{display:inline-flex;padding:2px;gap:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}',
			'.dshdv-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer}',
			'.dshdv-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1f24);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
			'.dshdv-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-barSpacer{flex:1 1 auto;min-width:4px}',
			'.dshdv-filter{position:relative;display:flex;align-items:center;flex:0 1 220px;min-width:120px}',
			'.dshdv-filter input{width:100%;box-sizing:border-box;height:26px;padding:0 22px 0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}',
			'.dshdv-filter input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b6cf6)}',
			'.dshdv-filterClear{position:absolute;right:2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);cursor:pointer;font-size:14px;line-height:1;padding:2px 5px;border-radius:4px}',
			'.dshdv-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;min-width:26px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b636e);font:inherit;font-size:12px;cursor:pointer}',
			'.dshdv-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1f24)}',
			'.dshdv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:1px}',
			'.dshdv-btn svg{display:block;width:14px;height:14px}',
			'.dshdv-summary{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;white-space:nowrap}',
			'.dshdv-add{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-del{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-main{display:flex;flex:1 1 auto;min-height:0}',
			'.dshdv-list{flex:0 0 272px;min-width:180px;max-width:45%;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fafbfc);overflow:hidden}',
			'.dshdv-listBody{flex:1 1 auto;overflow:auto;padding:4px;scrollbar-gutter:stable}',
			'.dshdv-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
			'.dshdv-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}',
			'.dshdv-row[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08))}',
			'.dshdv-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf6);outline-offset:-2px}',
			'.dshdv-chip{flex:none;width:14px;text-align:center;font-size:11px;font-weight:600;line-height:16px;border-radius:4px}',
			'.dshdv-chip[data-status="added"],.dshdv-chip[data-status="untracked"]{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
			'.dshdv-chip[data-status="deleted"]{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-chip[data-status="modified"],.dshdv-chip[data-status="renamed"],.dshdv-chip[data-status="copied"]{color:var(--dsw-alias-state-warn-primary,#9a6700)}',
			'.dshdv-chip[data-status="conflicted"]{color:var(--dsw-alias-state-error-primary,#c0392b)}',
			'.dshdv-chip[data-status="binary"],.dshdv-chip[data-status="oversized"],.dshdv-chip[data-status="directory"]{color:var(--dsw-alias-label-secondary,#5b636e)}',
			'.dshdv-names{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
			'.dshdv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}',
			'.dshdv-dirName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#5b636e)}',
			'.dshdv-counts{flex:none;display:inline-flex;gap:4px;font-size:11px;font-variant-numeric:tabular-nums}',
			'.dshdv-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
			'.dshdv-head{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));min-height:36px}',
			'.dshdv-headPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
			'.dshdv-headTools{flex:none;display:inline-flex;gap:2px}',
			'.dshdv-scroll{flex:1 1 auto;overflow:auto;background:var(--dsw-alias-bg-base,#fff)}',
			'.dshdv-hunk{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
			'.dshdv-hunkHeader{padding:3px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#5b636e);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;position:sticky;top:0}',
			'.dshdv-line{display:flex;align-items:flex-start;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:19px;white-space:pre}',
			'.dshdv-line[data-kind="add"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 10%,transparent)}',
			'.dshdv-line[data-kind="del"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent)}',
			'.dshdv-no{flex:none;width:48px;padding:0 8px;text-align:right;color:var(--dsw-alias-label-secondary,#8b939e);user-select:none;font-variant-numeric:tabular-nums}',
			'.dshdv-sign{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-secondary,#8b939e);user-select:none}',
			'.dshdv-text{flex:1 1 auto;min-width:0;padding-right:16px}',
			'.dshdv-wrap .dshdv-line{white-space:pre-wrap;word-break:break-word}',
			'.dshdv-wrap .dshdv-text{white-space:pre-wrap}',
			'.dshdv-split{display:flex;align-items:flex-start}',
			'.dshdv-splitCell{flex:1 1 50%;min-width:0;display:flex;align-items:flex-start;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
			'.dshdv-splitCell[data-kind="add"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 10%,transparent)}',
			'.dshdv-splitCell[data-kind="del"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent)}',
			'.dshdv-splitCell[data-empty="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
			'.dshdv-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#5b636e);font-size:12.5px}',
			'.dshdv-status p{margin:0;max-width:44ch;line-height:1.6}',
			'.dshdv-note{padding:8px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#5b636e);font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
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

		/** The state one Session's view starts from. */
		function initialState() {
			return {
				scope: readPreference(SCOPE_KEY, GIT) === SESSION ? SESSION : GIT,
				files: [],
				repo: null,
				cwd: null,
				turn: undefined,
				turns: [],
				totals: { added: 0, deleted: 0 },
				phase: 'idle',
				error: null,
				selected: null,
				diff: null,
				diffPhase: 'idle',
				diffError: null,
			};
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

			function patch(next) {
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
					files: [], selected: null, diff: null, diffPhase: 'idle', diffError: null,
					repo: null, cwd: null, turn: undefined, turns: [], totals: { added: 0, deleted: 0 },
				};
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
					state = Object.assign({}, state, { scope: scope, selected: null, diff: null, diffPhase: 'idle', files: [], error: null });
					emit();
					return controller.load(sessionId);
				},

				/** Read the file list of the current scope. */
				/**
				 * Read the list of the current scope, then the comparison of
				 * whatever file ends up selected.
				 *
				 * A silent read leaves the current phase alone (the auto-refresh
				 * tick must not flash a spinner over a list already on screen); an
				 * interactive one takes the loading phase, which is also what makes
				 * a remount honest: the view never renders a stale list while a
				 * fresh answer is in flight.
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
					var value = result.value;
					var files = Array.isArray(value.files) ? value.files : [];
					var keep = state.selected !== null && files.some(function (file) { return file.path === state.selected; });
					var selected = keep ? state.selected : (files.length > 0 ? files[0].path : null);
					var sameFile = selected !== null && selected === state.selected;
					patch({
						phase: 'ready',
						error: null,
						files: files,
						repo: value.repo === undefined ? null : value.repo,
						cwd: value.cwd === undefined ? null : value.cwd,
						turn: value.turn,
						turns: Array.isArray(value.turns) ? value.turns : [],
						totals: { added: value.added || 0, deleted: value.deleted || 0 },
						selected: selected,
						/* A live comparison of the same file is kept; anything else is
						 * dropped and re-read, because a diff is a snapshot of a moving
						 * tree and the list just said it moved. */
						diff: sameFile ? state.diff : null,
						diffPhase: sameFile ? state.diffPhase : 'loading',
					});
					if (selected !== null && !silent) await controller.select(sessionId, selected);
				},

				/** Read one file's comparison. */
				select: async function (sessionId, path) {
					var file = state.files.find(function (entry) { return entry.path === path; });
					if (file === undefined) return;
					var current = (diffGeneration += 1);
					var started = epoch;
					var stale = function () { return current !== diffGeneration || started !== epoch; };
					/* A path the Session's log names but no summary covers has no
					 * stored comparison: reading one would 404 and read as a
					 * failure, when the honest answer is that the Host kept none. */
					if (state.scope === SESSION && file.at === undefined) {
						patch({ selected: path, diff: null, diffPhase: 'norecord', diffError: null });
						return;
					}
					patch({ selected: path, diff: null, diffPhase: 'loading', diffError: null });
					var at = state.scope === SESSION ? file.at : undefined;
					var result;
					try {
						result = await readJson(fileUrl(state.scope, sessionId, path, at), undefined);
					} catch (error) {
						if (stale()) return;
						patch({ diffPhase: 'error', diffError: 'error.generic' });
						return;
					}
					if (stale()) return;
					if (result.failed !== undefined) {
						patch({ diffPhase: 'error', diffError: result.failed });
						return;
					}
					patch({ diffPhase: 'ready', diff: result.value, diffError: null });
				},

				/** Re-read list and comparison together. */
				refresh: async function (sessionId) {
					await controller.load(sessionId, { silent: true });
					if (state.selected !== null && state.diffPhase !== 'error') await controller.select(sessionId, state.selected);
				},
				/** Forget the mounted session's data when the view unmounts. */
				reset: function () {
					generation += 1;
					diffGeneration += 1;
					epoch += 1;
					state = Object.assign({}, state, { files: [], selected: null, diff: null, phase: 'idle', diffPhase: 'idle', error: null, diffError: null });
					emit();
				},
			};
			return controller;
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

		/** One row of the file list. */
		function FileRow(props) {
			var file = props.file;
			var parts = splitPath(file.display || file.path);
			var letter = STATUS_LETTER[file.status] === undefined ? 'M' : STATUS_LETTER[file.status];
			var title = statusLabel(props.t, file.status)
				+ (file.originalPath === undefined ? '' : ' ← ' + file.originalPath)
				+ (Array.isArray(file.changedTurns) && file.changedTurns.length > 0 ? '  ·  T' + file.changedTurns.join(', T') : '');
			return h('button', {
				type: 'button',
				role: 'option',
				className: 'dshdv-row',
				'data-path': file.path,
				'aria-selected': props.selected,
				title: title,
				onClick: props.onSelect,
			},
				h('span', { className: 'dshdv-chip', 'data-status': file.status, 'aria-hidden': 'true' }, letter),
				h('span', { className: 'dshdv-names' },
					h('span', { className: 'dshdv-name' }, parts.name),
					parts.dir === '' ? null : h('span', { className: 'dshdv-dirName' }, parts.dir)),
				h('span', { className: 'dshdv-counts' },
					file.added > 0 ? h('span', { className: 'dshdv-add' }, '+' + file.added) : null,
					file.deleted > 0 ? h('span', { className: 'dshdv-del' }, '−' + file.deleted) : null));
		}

		/** The comparison body: hunks, their notes, or the state that stands in for them. */
		function DiffBody(props) {
			var state = props.state;
			var t = props.t;
			if (state.diffPhase === 'loading') {
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
			var rows = [];
			if (note !== null) rows.push(h('p', { key: 'note', className: 'dshdv-note', 'data-diff-note': note }, t(note)));
			if (diff.coarse === true) rows.push(h('p', { key: 'coarse', className: 'dshdv-note' }, t('diff.coarse')));
			if (budget.truncated) rows.push(h('p', { key: 'cut', className: 'dshdv-note' }, format(t('diff.truncated'), { count: MAX_RENDERED_LINES })));
			budget.hunks.forEach(function (hunk, index) {
				rows.push(props.split && !single
					? h(SplitHunk, { key: index, hunk: hunk, wrap: props.wrap })
					: h(UnifiedHunk, { key: index, hunk: hunk, wrap: props.wrap }));
			});
			return h('div', { className: 'dshdv-scroll' + (props.wrap ? ' dshdv-wrap' : ''), 'data-diff-view': props.split && !single ? 'split' : 'unified' }, rows);
		}

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

		/** One hunk as numbered rows. */
		function UnifiedHunk(props) {
			var rows = hunkRows(props.hunk);
			return h('section', { className: 'dshdv-hunk' },
				h('div', { className: 'dshdv-hunkHeader' }, hunkHeaderText(props.hunk)),
				rows.map(function (row, index) {
					return h('div', { key: index, className: 'dshdv-line', 'data-kind': row.kind },
						h('span', { className: 'dshdv-no' }, row.old === undefined ? '' : row.old),
						h('span', { className: 'dshdv-no' }, row.next === undefined ? '' : row.next),
						h('span', { className: 'dshdv-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
						h('span', { className: 'dshdv-text' }, row.text));
				}));
		}

		/** One hunk as paired cells. */
		function SplitHunk(props) {
			var rows = splitRows(props.hunk);
			return h('section', { className: 'dshdv-hunk' },
				h('div', { className: 'dshdv-hunkHeader' }, hunkHeaderText(props.hunk)),
				rows.map(function (row, index) {
					return h('div', { key: index, className: 'dshdv-line dshdv-split' },
						h('span', { className: 'dshdv-splitCell', 'data-kind': row.left === undefined ? undefined : row.left.kind, 'data-empty': row.left === undefined },
							h('span', { className: 'dshdv-no' }, row.left === undefined ? '' : row.left.no),
							h('span', { className: 'dshdv-text' }, row.left === undefined ? '' : row.left.text)),
						h('span', { className: 'dshdv-splitCell', 'data-kind': row.right === undefined ? undefined : row.right.kind, 'data-empty': row.right === undefined },
							h('span', { className: 'dshdv-no' }, row.right === undefined ? '' : row.right.no),
							h('span', { className: 'dshdv-text' }, row.right === undefined ? '' : row.right.text)));
				}));
		}

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

			React.useEffect(function () {
				void controller.load(sessionId);
				return function () {
					controller.reset();
				};
			}, [controller, sessionId]);

			React.useEffect(function () {
				if (!auto) return undefined;
				var timer = window.setInterval(function () {
					if (document.hidden) return;
					void controller.refresh(sessionId);
				}, AUTO_REFRESH_MS);
				return function () {
					window.clearInterval(timer);
				};
			}, [auto, controller, sessionId]);

			React.useEffect(function () {
				if (!copied) return undefined;
				var timer = window.setTimeout(function () { setCopied(false); }, 1400);
				return function () { window.clearTimeout(timer); };
			}, [copied]);

			var files = state.files;
			var needle = filter.trim().toLowerCase();
			var visible = needle === ''
				? files
				: files.filter(function (file) {
					return (file.display || file.path).toLowerCase().indexOf(needle) !== -1
						|| file.path.toLowerCase().indexOf(needle) !== -1;
				});
			var selectedFile = state.selected === null
				? undefined
				: files.find(function (file) { return file.path === state.selected; });
			var notice = noticeFor(state, t);

			function selectScope(scope) {
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
					return h(FileRow, {
						key: file.path, file: file, t: t, selected: file.path === state.selected,
						onSelect: function () { void controller.select(sessionId, file.path); },
					});
				});
			}
			var listPane = h('div', { className: 'dshdv-list' },
				h('div', {
					className: 'dshdv-listBody', role: 'listbox', 'aria-label': t('view.label'), 'data-dsh-diff-list': '',
				}, listBody));

			/* The detail pane: the selected file's comparison behind its header. */
			var detailPane;
			if (selectedFile === undefined) {
				detailPane = h('div', { className: 'dshdv-status' },
					h('span', { 'aria-hidden': 'true' }, icon(ICON_EMPTY)),
					h('p', null, t('diff.empty')));
			} else {
				var counts = [
					statusLabel(t, selectedFile.status),
					selectedFile.added > 0 ? h('span', { key: 'add', className: 'dshdv-add' }, '+' + selectedFile.added) : null,
					selectedFile.deleted > 0 ? h('span', { key: 'del', className: 'dshdv-del' }, '−' + selectedFile.deleted) : null,
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
				detailPane = h(React.Fragment, null,
					h('div', { className: 'dshdv-head' },
						h('span', {
							className: 'dshdv-headPath', title: selectedFile.path, 'data-dsh-diff-path': selectedFile.path,
						}, selectedFile.display || selectedFile.path),
						h('span', { className: 'dshdv-summary' }, counts),
						tools),
					h(DiffBody, {
						state: state, t: t, wrap: wrap, split: split,
						onRetry: function () {
							if (state.selected !== null) void controller.select(sessionId, state.selected);
						},
					}));
			}

			return h('div', { className: 'dshdv-root', 'data-dsh-diff-view': state.scope },
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
						format(t('summary.files'), { count: files.length }),
						h('span', { className: 'dshdv-add' }, format(t('summary.added'), { count: state.totals.added })),
						h('span', { className: 'dshdv-del' }, format(t('summary.deleted'), { count: state.totals.deleted }))),
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
					}, icon(ICON_REFRESH))),

				notice === null ? null : h('p', { className: 'dshdv-note', 'data-dsh-diff-notice': notice }, t(notice)),

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
				return function () {
					controllers.clear();
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
