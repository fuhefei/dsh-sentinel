window.__ModuleLoader__.load({
	id: "dsh-sentinel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		* Combine the owner's signal with a per-request timeout.
		* @param outer - owner signal; aborting it aborts the request.
		* @param timeoutMs - per-request ceiling.
		* @returns the request signal plus a disposer that clears the timer and listener.
		*/
		function requestSignal(outer, timeoutMs) {
			const controller = new AbortController();
			const forward = () => {
				controller.abort();
			};
			if (outer.aborted) controller.abort();
			else outer.addEventListener("abort", forward, { once: true });
			const timer = setTimeout(() => {
				controller.abort();
			}, timeoutMs);
			return {
				signal: controller.signal,
				done: () => {
					clearTimeout(timer);
					outer.removeEventListener("abort", forward);
				}
			};
		}
		/**
		* Create a self-scheduling poller. All state is per-instance, so several
		* pollers (one per session view, one shared page-wide) never interfere.
		* @param options - interval, timeout, the request body, and an error hook.
		* @returns the poller handle.
		*/
		function createPoller(options) {
			const { intervalMs, run, onError } = options;
			const timeoutMs = options.timeoutMs ?? 1e4;
			let owner;
			let timer;
			let inFlight = 0;
			const tick = async () => {
				const signal = owner?.signal;
				if (signal === void 0 || signal.aborted) return;
				const request = requestSignal(signal, timeoutMs);
				inFlight += 1;
				try {
					await run(request.signal);
				} catch (error) {
					if (!request.signal.aborted) onError?.(error);
				} finally {
					inFlight -= 1;
					request.done();
				}
				if (signal.aborted || owner === void 0) return;
				timer = setTimeout(() => {
					tick();
				}, intervalMs);
			};
			return {
				start() {
					if (owner !== void 0) return;
					owner = new AbortController();
					tick();
				},
				stop() {
					const current = owner;
					owner = void 0;
					current?.abort();
					if (timer !== void 0) {
						clearTimeout(timer);
						timer = void 0;
					}
				},
				get running() {
					return owner !== void 0;
				},
				get inFlight() {
					return inFlight;
				}
			};
		}
		//#endregion
		//#region src/client/locale.ts
		/** Stable React subscription boundary for the host's active locale and revisions. */
		function createClientLocaleSource(runtime) {
			return {
				getSnapshot: () => runtime.getSnapshot(),
				subscribe: (listener) => runtime.subscribe(listener)
			};
		}
		/** Match the host's dictionary fallback chain, not the active language tag's prefix. */
		function resolveClientLocale(snapshot) {
			const definitionFor = (id) => snapshot.locales.find((definition) => definition.id.toLowerCase() === id.toLowerCase());
			let current = definitionFor(snapshot.active);
			const visited = /* @__PURE__ */ new Set();
			while (current !== void 0 && !visited.has(current.id.toLowerCase())) {
				const id = current.id.toLowerCase();
				if (id === "en" || id === "zh") return id;
				visited.add(id);
				current = current.fallback === void 0 ? void 0 : definitionFor(current.fallback);
			}
			return "en";
		}
		/** The better-sidebar contract has no locale seat; subscribe to the host instead. */
		function useClientLocale(source) {
			return resolveClientLocale((0, react.useSyncExternalStore)(source.subscribe, source.getSnapshot, source.getSnapshot));
		}
		const messages = {
			en: {
				snapshotChanged: "Snapshot changed",
				patternMatched: "Pattern /{pattern}/ started matching: {match}",
				webhookReceived: "External push received (webhook)",
				withState: "{summary} (state: {state})",
				stateAbsent: "absent",
				stateExists: "exists",
				stateExistsBytes: "exists ({bytes} bytes)",
				stateExit: "exit {code}",
				stateUnreachable: "unreachable",
				stateNoProcess: "no process",
				stateProcesses: "{count} process(es)",
				stateOpen: "open {address}",
				stateClosed: "closed {address}",
				stateTimeout: "timeout {address}",
				stateAwaitingPush: "awaiting push",
				registered: "Sentinel watch {id} registered: {kind} · {target}",
				hookAddress: "Push URL: POST {url}",
				hookHost: " (localhost refers to the dsh host; use its reachable address from another machine)",
				hookResident: " — a resident dsh process must listen on this URL; a one-shot headless process cannot receive pushes after it exits",
				probeCadence: " (probe every {interval}s{filePush}; server-side monitoring continues while the session sleeps; probing and wakeup delivery require a resident process such as dsh web after a one-shot headless process exits)",
				filePush: ", file changes also trigger immediate probes",
				noWatches: "No active sentinel watches.",
				notProbed: "not probed",
				listRow: "{id}: {kind} · {target} [{state}] fired {count}/{max}",
				cancelled: "Watch {id} cancelled.",
				notFound: "No active watch named {id}.",
				wakeupTitle: "[dsh-sentinel] Watch {id} fired ({count}/{max})",
				wakeupTarget: "Watching: {kind} · {target}",
				wakeupPattern: "Pattern: /{pattern}/",
				wakeupChange: "Change: {summary}",
				wakeupBefore: "Before:\n{before}",
				wakeupAfter: "Now:\n{after}",
				wakeupNote: "The note you left when registering:\n{note}",
				wakeupInstruction: "This is a sentinel condition wakeup: handle this fire according to the note, then stop. Unless the user or note asks, do not re-register the watch or start unrelated investigations.",
				wakeupLast: "This was the final fire; the watch has ended automatically.",
				wakeupRemaining: "Remaining fires: {remaining}; if no longer needed, cancel with sentinel_cancel (id: \"{id}\")."
			},
			zh: {
				snapshotChanged: "快照发生变化",
				patternMatched: "模式 /{pattern}/ 开始匹配: {match}",
				webhookReceived: "外部推送到达（webhook）",
				withState: "{summary}（状态: {state}）",
				stateAbsent: "不存在",
				stateExists: "存在",
				stateExistsBytes: "存在（{bytes} 字节）",
				stateExit: "退出码 {code}",
				stateUnreachable: "不可达",
				stateNoProcess: "无进程",
				stateProcesses: "{count} 个进程",
				stateOpen: "端口可达 {address}",
				stateClosed: "端口不通 {address}",
				stateTimeout: "探测超时 {address}",
				stateAwaitingPush: "等待推送",
				registered: "哨兵订阅 {id} 已注册: {kind} · {target}",
				hookAddress: "推送地址: POST {url}",
				hookHost: "（localhost 指 dsh 所在主机，跨机器调用请换成该主机的可达地址）",
				hookResident: "——需常驻 dsh 进程监听该地址，一次性 headless 进程退出后无法接收推送",
				probeCadence: "（每 {interval}s 探测{filePush}；会话休眠时由服务端值守；探测与触发投递由常驻 dsh 进程承担——一次性 headless 进程退出后，需有常驻进程（如 dsh web）运行才会生效）",
				filePush: "，文件变化即时推送",
				noWatches: "没有活跃的哨兵订阅。",
				notProbed: "未探测",
				listRow: "{id}: {kind} · {target} [{state}] 触发 {count}/{max}",
				cancelled: "订阅 {id} 已取消。",
				notFound: "没有名为 {id} 的活跃订阅。",
				wakeupTitle: "[dsh-sentinel] 订阅 {id} 触发（第 {count}/{max} 次）",
				wakeupTarget: "监控对象: {kind} · {target}",
				wakeupPattern: "匹配模式: /{pattern}/",
				wakeupChange: "变化: {summary}",
				wakeupBefore: "之前:\n{before}",
				wakeupAfter: "现在:\n{after}",
				wakeupNote: "你注册时留给自己的便签:\n{note}",
				wakeupInstruction: "以上是哨兵条件唤醒：按便签处理完本次触发即停；除非用户或便签要求，不要重新注册监控、不要展开无关调查。",
				wakeupLast: "这是最后一次触发，该订阅已自动结束。",
				wakeupRemaining: "剩余 {remaining} 次触发额度；如果不再需要，用 sentinel_cancel 工具取消（id: \"{id}\"）。"
			}
		};
		/** Shared typed formatters, imported normally by the server, React client and standalone dashboard. */
		function createPresentation(locale, dictionary) {
			/** Callback replacement preserves literal dollar signs and does not re-interpolate values. */
			function translate(key, values = {}) {
				return dictionary[key].replace(/\{(\w+)\}/g, (token, name) => values[name] === void 0 ? token : String(values[name]));
			}
			/** State is presentation-only: the canonical state and snapshot remain unchanged. */
			function localizeState(state) {
				if (locale !== "zh") return state;
				if (state === "absent") return translate("stateAbsent");
				if (state === "exists") return translate("stateExists");
				const bytes = /^exists \((\d+) bytes\)$/.exec(state);
				if (bytes !== null) return translate("stateExistsBytes", { bytes: bytes[1] });
				const exit = /^exit (-?\d+)$/.exec(state);
				if (exit !== null) return translate("stateExit", { code: exit[1] });
				if (state === "unreachable") return translate("stateUnreachable");
				if (state === "no process") return translate("stateNoProcess");
				const processes = /^(\d+) process\(es\)$/.exec(state);
				if (processes !== null) return translate("stateProcesses", { count: processes[1] });
				const port = /^(open|closed|timeout) (\([\s\S]*\))$/.exec(state);
				if (port !== null) return translate(port[1] === "open" ? "stateOpen" : port[1] === "closed" ? "stateClosed" : "stateTimeout", { address: port[2] });
				if (state === "awaiting push") return translate("stateAwaitingPush");
				return state;
			}
			/** Recognize only plugin-owned legacy templates; unknown summaries stay verbatim. */
			function legacyFireMessage(summary) {
				const suffix = /^(.*)（状态: ([\s\S]*)）$/s.exec(summary) ?? /^(.*) \(state: ([\s\S]*)\)$/s.exec(summary);
				const text = suffix?.[1] ?? summary;
				const state = suffix?.[2];
				let trigger;
				if (text === "快照发生变化" || text === "Snapshot changed") trigger = { kind: "change" };
				else if (text === "外部推送到达（webhook）" || text === "External push received (webhook)") trigger = { kind: "webhook" };
				else {
					const prefix = text.startsWith("模式 /") ? "模式 /" : text.startsWith("Pattern /") ? "Pattern /" : void 0;
					if (prefix !== void 0) {
						const delimiter = prefix === "模式 /" ? "/ 开始匹配: " : "/ started matching: ";
						const body = text.slice(prefix.length);
						const boundary = body.indexOf(delimiter);
						if (boundary >= 0 && body.indexOf(delimiter, boundary + delimiter.length) < 0) trigger = {
							kind: "pattern",
							pattern: body.slice(0, boundary),
							match: body.slice(boundary + delimiter.length)
						};
					}
				}
				return {
					summary,
					...trigger !== void 0 ? {
						trigger,
						...state !== void 0 ? { state } : {}
					} : {}
				};
			}
			function formatFireSummary(fact) {
				const message = fact.trigger === void 0 ? legacyFireMessage(fact.summary) : fact;
				const trigger = message.trigger;
				if (trigger === void 0) return fact.summary;
				const summary = trigger.kind === "change" ? translate("snapshotChanged") : trigger.kind === "webhook" ? translate("webhookReceived") : translate("patternMatched", {
					pattern: trigger.pattern,
					match: trigger.match
				});
				return message.state === void 0 ? summary : translate("withState", {
					summary,
					state: localizeState(message.state)
				});
			}
			return {
				translate,
				localizeState,
				legacyFireMessage,
				formatFireSummary
			};
		}
		function localizeState(state, locale) {
			return createPresentation(locale, messages[locale]).localizeState(state);
		}
		function formatFireSummary(fact, locale) {
			return createPresentation(locale, messages[locale]).formatFireSummary(fact);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-sentinel, browser half: the transparency surface. A dock card above the
		* composer (official conversation.input.dock family, same visual language as
		* Goal / To-dos / task-status / loop) showing every active watch of the
		* current session: sensor, target, live probe state, fire budget, next probe
		* countdown — plus the recent fire history when expanded. A sidebar entry
		* (sidebar.panellist, selecting this panel's key in the layout's `main` slot)
		* opens the server-global watch table in the central column, with a link to
		* the node half's dashboard table. Polls the node half's read-only state
		* route; the dock renders nothing when the session has no watches.
		*/
		const STATE_PATH = "/plugins/dsh-sentinel/state";
		const DASHBOARD_PATH = "/plugins/dsh-sentinel/dashboard";
		const CANCEL_PATH = "/plugins/dsh-sentinel/cancel";
		const POLL_MS = 2e3;
		const NS = "sentinel";
		const zh = {
			"watching": "哨兵值守中",
			"count": "{count} 个监控",
			"fires": "触发 {n}/{max}",
			"next": "下次探测 {s}s",
			"probing": "探测中",
			"push": "即时推送",
			"history": "最近触发",
			"nofires": "尚未触发过",
			"panel": "哨兵监控",
			"noteLabel": "便签",
			"noteSeparator": "：",
			"before": "之前",
			"after": "现在",
			"emptyHint": "让 agent 用 sentinel_watch 注册第一个监控。",
			"dashboard": "全局总览 ↗",
			"dormant": "休眠",
			"live": "活跃",
			"tab": "哨兵监控",
			"tabempty": "当前没有活跃的监控。",
			"cancel": "取消这个监控",
			"pending": "{n} 个唤醒待投递"
		};
		const en = {
			"watching": "Sentinel on duty",
			"count": "{count} watch(es)",
			"fires": "fired {n}/{max}",
			"next": "next probe {s}s",
			"probing": "probing",
			"push": "live push",
			"history": "Recent fires",
			"nofires": "No fires yet",
			"panel": "Sentinel",
			"noteLabel": "note",
			"noteSeparator": ": ",
			"before": "before",
			"after": "after",
			"emptyHint": "Ask the agent to register a watch with sentinel_watch.",
			"dashboard": "All watches ↗",
			"dormant": "dormant",
			"live": "live",
			"tab": "Sentinel",
			"tabempty": "No active watches right now.",
			"cancel": "Cancel this watch",
			"pending": "{n} wakeup(s) pending"
		};
		const SIDE_CLEARANCE = "var(--dsh-composer-side-clearance, 16px)";
		const DOCK_INSET = "var(--dsh-composer-dock-inset, 8px)";
		const CARD_MAX = "var(--dsh-composer-card-max-width, 780px)";
		function useSentinelState(sessionId) {
			const [state, setState] = (0, react.useState)({
				watches: [],
				recentFires: []
			});
			(0, react.useEffect)(() => {
				const poller = createPoller({
					intervalMs: POLL_MS,
					run: async (signal) => {
						const res = await fetch(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
							headers: { accept: "application/json" },
							signal
						});
						if (!res.ok) return;
						const data = await res.json();
						if (Array.isArray(data.watches)) setState({
							watches: data.watches,
							recentFires: Array.isArray(data.recentFires) ? data.recentFires : []
						});
					},
					onError: () => {}
				});
				poller.start();
				return () => {
					poller.stop();
				};
			}, [sessionId]);
			return state;
		}
		let globalWatches = [];
		let globalFires = [];
		const globalListeners = /* @__PURE__ */ new Set();
		const globalPoller = createPoller({
			intervalMs: POLL_MS,
			run: async (signal) => {
				const res = await fetch(STATE_PATH, {
					headers: { accept: "application/json" },
					signal
				});
				if (!res.ok) return;
				const data = await res.json();
				if (Array.isArray(data.watches)) {
					globalWatches = data.watches;
					globalFires = Array.isArray(data.recentFires) ? data.recentFires : [];
					for (const listener of globalListeners) listener();
				}
			},
			onError: () => {}
		});
		function subscribeGlobal(listener) {
			globalListeners.add(listener);
			if (!globalPoller.running) globalPoller.start();
			return () => {
				globalListeners.delete(listener);
				if (globalListeners.size === 0) globalPoller.stop();
			};
		}
		/** Subscribe to the server-global watch set (one shared poller per page). */
		function useGlobalWatches() {
			const [, force] = (0, react.useState)(0);
			(0, react.useEffect)(() => subscribeGlobal(() => {
				force((n) => n + 1);
			}), []);
			return globalWatches;
		}
		/** Subscribe to the server-global recent-fire list (same shared poller). */
		function useGlobalFires() {
			const [, force] = (0, react.useState)(0);
			(0, react.useEffect)(() => subscribeGlobal(() => {
				force((n) => n + 1);
			}), []);
			return globalFires;
		}
		/** Single-color inline icons (currentColor): one visual language across the
		* dock, branch, tab and every platform — no emoji rendering drift. */
		const ICON_PATHS = {
			eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
			file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6"],
			command: ["M4 17l6-6-6-6", "M12 19h8"],
			http: [
				"M8 3 4 7l4 4",
				"M4 7h16",
				"M16 21l4-4-4-4",
				"M20 17H4"
			],
			process: ["M6 4l14 8-14 8Z"],
			port: [
				"M9 2v6",
				"M15 2v6",
				"M6 8h12v4a6 6 0 0 1-12 0Z",
				"M12 18v4"
			],
			webhook: ["M13 2 3 14h7l-1 8 10-12h-7Z"],
			chevron: ["M6 9l6 6 6-6"]
		};
		function Icon(props) {
			const { name, size = 14 } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				"aria-hidden": true,
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				style: {
					flex: "none",
					display: "block"
				},
				children: ICON_PATHS[name].map((path) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: path }, path))
			});
		}
		const KIND_ICONS = {
			file: "file",
			command: "command",
			http: "http",
			process: "process",
			port: "port",
			webhook: "webhook"
		};
		function countdown(nextDueAt) {
			if (nextDueAt === void 0) return "…";
			return `${String(Math.max(0, Math.ceil((nextDueAt - Date.now()) / 1e3)))}`;
		}
		/** Manual cancel, fire-and-forget; the next poll tick removes the row. */
		function cancelWatch(watch) {
			fetch(`${CANCEL_PATH}?sessionId=${encodeURIComponent(watch.sessionId)}&id=${encodeURIComponent(watch.id)}`, { method: "POST" });
		}
		function pendingSuffix(watch, t) {
			return watch.pendingWakeups !== void 0 && watch.pendingWakeups > 0 ? ` · ${t("pending", { n: watch.pendingWakeups })}` : "";
		}
		function CancelButton(props) {
			const { watch, t } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title: t("cancel"),
				"aria-label": `${t("cancel")} ${watch.id}`,
				onClick: (e) => {
					e.stopPropagation();
					cancelWatch(watch);
				},
				style: {
					flex: "none",
					border: "none",
					background: "transparent",
					padding: "0 4px",
					fontSize: 13,
					lineHeight: "16px",
					color: "var(--dsw-alias-label-caption)",
					cursor: "pointer"
				},
				children: "×"
			});
		}
		/** One watch row: glyph, id, target, live state, budget, cadence. */
		function WatchRow(props) {
			const { watch, t, locale } = props;
			const cadence = watch.kind === "webhook" ? t("push") : `${t("next", { s: countdown(watch.nextDueAt) })}${watch.kind === "file" ? ` · ${t("push")}` : ""}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "2px 12px",
					minHeight: 24
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							flex: "none",
							display: "inline-flex",
							width: 16,
							justifyContent: "center",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: KIND_ICONS[watch.kind] ?? "file",
							size: 13
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							flex: "none",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)",
							whiteSpace: "nowrap"
						},
						children: watch.id
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						title: watch.pattern !== void 0 ? `${watch.target}  /${watch.pattern}/\n${watch.note}` : `${watch.target}\n${watch.note}`,
						style: {
							flex: 1,
							minWidth: 0,
							overflow: "hidden",
							fontSize: 13,
							lineHeight: "20px",
							color: "var(--dsw-alias-label-primary-dimmed)",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						},
						children: watch.target
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							flex: "none",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)",
							whiteSpace: "nowrap",
							fontVariantNumeric: "tabular-nums"
						},
						children: [
							watch.lastState === void 0 ? t("probing") : localizeState(watch.lastState, locale),
							" · ",
							t("fires", {
								n: watch.fireCount,
								max: watch.maxFires
							}),
							pendingSuffix(watch, t),
							" · ",
							cadence
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CancelButton, {
						watch,
						t
					})
				]
			});
		}
		/**
		* One fire in the history list: a single receipt line, expandable into the
		* full wakeup context — the note the user left for themselves plus the
		* before → after snapshot transition (the transparency this plugin promises).
		*/
		function FireRow(props) {
			const { fire, t, locale } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [hover, setHover] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { borderRadius: 6 },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					onClick: () => {
						setOpen((value) => !value);
					},
					onMouseEnter: () => {
						setHover(true);
					},
					onMouseLeave: () => {
						setHover(false);
					},
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "2px 12px",
						fontSize: 12,
						color: "var(--dsw-alias-label-caption)",
						cursor: "pointer",
						borderRadius: 6,
						background: hover ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))" : "transparent",
						fontVariantNumeric: "tabular-nums"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								display: "inline-flex",
								color: "var(--dsw-alias-label-tertiary)",
								transition: "transform .15s ease",
								transform: open ? "rotate(90deg)" : "rotate(0deg)"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "chevron",
								size: 11
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								whiteSpace: "nowrap"
							},
							children: new Date(fire.at).toLocaleTimeString(locale)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { flex: "none" },
							children: fire.id
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: 1,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: formatFireSummary(fire, locale)
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "2px 12px 6px 30px",
						fontSize: 12,
						color: "var(--dsw-alias-label-caption)"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginBottom: 4 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { fontWeight: 500 },
								children: t("noteLabel")
							}),
							t("noteSeparator"),
							fire.note
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "stretch",
							gap: 8
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("pre", {
								style: {
									flex: 1,
									margin: 0,
									padding: "4px 6px",
									borderRadius: 6,
									overflow: "auto",
									maxHeight: 120,
									fontSize: 11,
									lineHeight: "16px",
									whiteSpace: "pre-wrap",
									wordBreak: "break-all",
									background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))"
								},
								children: [
									t("before"),
									"\n",
									fire.before === "" ? "—" : fire.before
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: "none",
									alignSelf: "center",
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "chevron",
									size: 12
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("pre", {
								style: {
									flex: 1,
									margin: 0,
									padding: "4px 6px",
									borderRadius: 6,
									overflow: "auto",
									maxHeight: 120,
									fontSize: 11,
									lineHeight: "16px",
									whiteSpace: "pre-wrap",
									wordBreak: "break-all",
									background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))"
								},
								children: [
									t("after"),
									"\n",
									fire.after
								]
							})
						]
					})]
				})]
			});
		}
		/** The dock card: header always, rows + fire history when expanded. */
		function SentinelDock(props) {
			const { t, session, localeSource } = props;
			const locale = useClientLocale(localeSource);
			const { watches, recentFires } = useSentinelState(session.sessionId);
			const [inChat, setInChat] = (0, react.useState)(false);
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const check = () => {
					setInChat(document.querySelector("[data-chat-flow=\"\"]") !== null);
				};
				check();
				const observer = new MutationObserver(check);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					observer.disconnect();
				};
			}, []);
			if (!inChat || watches.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-sentinel-dock": "",
				style: {
					boxSizing: "border-box",
					width: `calc(100% - 2 * ${SIDE_CLEARANCE} - 4 * ${DOCK_INSET})`,
					maxWidth: `calc(${CARD_MAX} - 4 * ${DOCK_INSET})`,
					margin: "0 auto",
					border: "1px solid var(--dsw-alias-border-l1)",
					borderRadius: 12,
					background: "var(--dsw-specific-tip)",
					overflow: "hidden",
					fontSize: 13,
					fontFamily: "system-ui"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "6px 12px",
						cursor: "pointer"
					},
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								display: "inline-flex",
								flex: "none",
								alignItems: "center",
								gap: 8,
								color: "var(--dsw-alias-label-primary)"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: "ongoing",
								size: 10
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "eye",
								size: 14
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								fontSize: 13,
								lineHeight: "24px",
								fontWeight: 500,
								color: "var(--dsw-alias-label-primary)"
							},
							children: t("watching")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								flex: 1,
								minWidth: 0,
								overflow: "hidden",
								fontSize: 12,
								color: "var(--dsw-alias-label-caption)",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								fontVariantNumeric: "tabular-nums"
							},
							children: [
								t("count", { count: watches.length }),
								" · ",
								watches.map((watch) => watch.id).join(" ")
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: `${DASHBOARD_PATH}?lang=${locale}`,
							target: "_blank",
							rel: "noreferrer",
							onClick: (e) => {
								e.stopPropagation();
							},
							style: {
								flex: "none",
								fontSize: 11,
								color: "var(--dsw-alias-label-caption)",
								textDecoration: "none"
							},
							children: t("dashboard")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								display: "inline-flex",
								color: "var(--dsw-alias-label-caption)",
								transition: "transform .2s ease",
								transform: open ? "rotate(90deg)" : "rotate(0deg)"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "chevron",
								size: 13
							})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						maxHeight: open ? 260 : 0,
						opacity: open ? 1 : 0,
						overflowY: open ? "auto" : "hidden",
						overflowX: "hidden",
						borderTop: open ? "1px solid var(--dsw-alias-border-l1)" : "1px solid transparent",
						transition: "max-height .2s ease, opacity .15s ease"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { padding: "4px 0" },
						children: [
							watches.map((watch) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WatchRow, {
								watch,
								t,
								locale
							}, watch.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									padding: "4px 12px 2px",
									fontSize: 11,
									fontWeight: 500,
									color: "var(--dsw-alias-label-caption)"
								},
								children: t("history")
							}),
							recentFires.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									padding: "0 12px 4px",
									fontSize: 12,
									color: "var(--dsw-alias-label-caption)"
								},
								children: t("nofires")
							}) : recentFires.slice(0, 8).map((fire) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FireRow, {
								fire,
								t,
								locale
							}, `${fire.id}-${fire.at}`))
						]
					})
				})]
			});
		}
		/**
		* Sidebar global-panel glyph: the icon row the sidebar shell draws for this
		* plugin (label, hit target, active state and selection belong to the shell).
		* A dot marks a non-empty watch set so the entry reads as state, not just a
		* destination.
		*/
		function SentinelPanelIcon({ size, active }) {
			const watches = useGlobalWatches();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					position: "relative",
					display: "inline-flex",
					color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "eye",
					size
				}), watches.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						position: "absolute",
						right: -3,
						top: -3,
						display: "inline-flex"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "ongoing",
						size: 6
					})
				})]
			});
		}
		/**
		* Central-panel body: the server-global watch table behind the sidebar's
		* Sentinel entry. Replaces the pre-0.1.5 per-session-row branch — 0.1.5
		* declares no branch hole under session rows, so the cross-session view lives
		* in the panel its sidebar entry selects.
		*/
		function SentinelPanel({ t, localeSource }) {
			const locale = useClientLocale(localeSource);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelWatchTable, {
				t,
				locale
			});
		}
		/** better-sidebar has no locale props; use the host translator and subscription. */
		function SentinelTabView({ t, localeSource }) {
			const locale = useClientLocale(localeSource);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelWatchTable, {
				t,
				locale
			});
		}
		/** The global watch table itself, shared by the panel and the better-sidebar tab. */
		function SentinelWatchTable({ t, locale }) {
			const watches = useGlobalWatches();
			const fires = useGlobalFires();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-sentinel-panel": "",
				style: {
					height: "100%",
					overflowY: "auto",
					padding: "8px 0",
					fontSize: 13,
					fontFamily: "system-ui",
					color: "var(--dsw-alias-label-primary-dimmed)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "2px 12px 6px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: "ongoing",
								size: 10
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									display: "inline-flex",
									alignItems: "center",
									gap: 6,
									fontWeight: 500,
									color: "var(--dsw-alias-label-primary)"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "eye",
									size: 13
								}), t("tab")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: 1,
									fontSize: 12,
									color: "var(--dsw-alias-label-caption)",
									fontVariantNumeric: "tabular-nums"
								},
								children: t("count", { count: watches.length })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: `${DASHBOARD_PATH}?lang=${locale}`,
								target: "_blank",
								rel: "noreferrer",
								style: {
									flex: "none",
									fontSize: 11,
									color: "var(--dsw-alias-label-caption)",
									textDecoration: "none"
								},
								children: t("dashboard")
							})
						]
					}),
					watches.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "8px 12px",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)"
						},
						children: [t("tabempty"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 4,
								fontSize: 11,
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: t("emptyHint")
						})]
					}),
					[...watches.reduce((groups, watch) => {
						const list = groups.get(watch.sessionId) ?? [];
						list.push(watch);
						groups.set(watch.sessionId, list);
						return groups;
					}, /* @__PURE__ */ new Map()).entries()].map(([sessionId, group]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "6px 12px 0",
							fontSize: 11,
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: [
							sessionId,
							" · ",
							group[0]?.live === true ? t("live") : t("dormant")
						]
					}), group.map((watch) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WatchRow, {
						watch,
						t,
						locale
					}, watch.id))] }, sessionId)),
					watches.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "8px 12px 2px",
							fontSize: 11,
							fontWeight: 500,
							color: "var(--dsw-alias-label-caption)"
						},
						children: t("history")
					}),
					fires.length === 0 ? watches.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "0 12px 4px",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)"
						},
						children: t("nofires")
					}) : fires.slice(0, 12).map((fire) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FireRow, {
						fire,
						t,
						locale
					}, `${fire.sessionId}-${fire.id}-${fire.at}`))
				]
			});
		}
		/** Identity shared by the sidebar entry and the main panel it selects. */
		const SENTINEL_PANEL = "sentinel";
		/** Required client services: slot registry and locale dictionaries. betterSidebar
		* stays out of the static inject — on hosts without better-sidebar a missing
		* service would leave this plugin pending and take the whole web boot down.
		* The tab mounts via an eager check plus the service-landing event instead. */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "sentinel: dictionaries");
			const t = ctx.locale.bind(NS);
			const localeSource = createClientLocaleSource(ctx.locale);
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "sentinel",
				order: 24,
				locale: NS
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelDock, {
				...props,
				localeSource
			})));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: SENTINEL_PANEL,
				order: 24,
				label: () => t("panel"),
				locale: NS
			}, SentinelPanelIcon));
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: SENTINEL_PANEL,
				locale: NS
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelPanel, {
				...props,
				localeSource
			})));
			ctx.plugin({
				inject: ["betterSidebar"],
				apply(sidebarCtx) {
					const sidebar = sidebarCtx.betterSidebar;
					ctx.effect(() => sidebar.registerTab({
						id: "dsh-sentinel:watches",
						title: () => t("tab"),
						icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "eye",
							size: Math.max(12, size - 2)
						}),
						order: 60,
						single: true,
						component: () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelTabView, {
							t,
							localeSource
						})
					}), "sentinel: better-sidebar tab");
				}
			});
		}
		//#endregion
		exports.SentinelDock = SentinelDock;
		exports.SentinelPanel = SentinelPanel;
		exports.SentinelPanelIcon = SentinelPanelIcon;
		exports.SentinelTabView = SentinelTabView;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map