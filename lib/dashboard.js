(function() {
	//#region src/client/poller.ts
	/**
	* A self-scheduling poller for the sentinel client.
	*
	* The previous implementation armed a `setInterval` and fired a request on
	* every tick without looking at the previous one, so a slow server made
	* requests pile up, and teardown only cleared the timer — work already in
	* flight kept running into a dead component. This poller fixes both:
	*
	*   - the next tick is armed only after the previous request settles, so at
	*     most one request is ever in flight per poller;
	*   - every request carries an abort signal, so `stop()` cancels work in
	*     flight rather than leaving it to resolve later.
	*
	* A per-request timeout is not optional here: because the loop re-arms itself
	* *after* the request settles, one request that never settles would otherwise
	* stall the poller forever. The timeout bounds that.
	*
	* Deliberately free of React and DOM APIs so the scheduling contract can be
	* unit-tested directly.
	* @module dsh-sentinel/client/poller
	*/
	/** Per-request ceiling. A poll may not outlive this. */
	const DEFAULT_POLL_TIMEOUT_MS = 1e4;
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
	//#region src/locale.ts
	/** Normalize an explicit language tag; unknown tags use the English dictionary. */
	function resolveLocale(value) {
		return /^zh(?:-|$)/i.test(value ?? "") ? "zh" : "en";
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
	//#endregion
	//#region src/dashboard-template.ts
	function escapeHtml(value) {
		return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
	}
	/** Join already escaped fragments without opening a raw-HTML path for caller data. */
	function joinHtml(parts) {
		return parts.join("");
	}
	/**
	* Fixed slots only: {{name}} escapes text/quoted attributes; <!-- sentinel:name -->
	* accepts trusted rendered fragments. One pass preserves placeholder-like user data.
	* This deliberately has no expressions, nested evaluation or executable helpers.
	*/
	function renderTemplate(template, values, fragments = {}) {
		return template.replace(/\{\{(\w+)\}\}|<!-- sentinel:([\w-]+) -->/g, (_token, valueKey, fragmentKey) => {
			const key = valueKey ?? fragmentKey;
			const source = valueKey !== void 0 ? values : fragments;
			if (!Object.hasOwn(source, key)) throw new Error(`Missing dashboard template slot: ${key}`);
			return valueKey !== void 0 ? escapeHtml(values[key]) : fragments[key];
		});
	}
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-watch.html
	var dashboard_watch_default = "<tr>\n  <td>{{session}}… <small>{{live}}</small><!-- sentinel:dropped --></td>\n  <td>{{id}}</td>\n  <td>{{kind}}</td>\n  <td class=\"target\" title=\"{{note}}\">{{target}}</td>\n  <td><!-- sentinel:pattern --></td>\n  <td>{{fireCount}}/{{maxFires}}<!-- sentinel:pending --></td>\n  <td>{{state}}</td>\n  <td>{{next}}</td>\n  <td><button type=\"button\" class=\"cancel\" data-session=\"{{sessionId}}\" data-id=\"{{id}}\" title=\"{{cancel}}\" aria-label=\"{{cancel}} {{id}}\">×</button></td>\n</tr>\n";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-fire.html
	var dashboard_fire_default = "<tr>\n  <td>{{time}}</td>\n  <td>{{id}}</td>\n  <td>{{session}}…</td>\n  <td class=\"target\">{{summary}}</td>\n</tr>\n";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-empty.html
	var dashboard_empty_default = "<tr><td colspan=\"{{columns}}\" class=\"empty\">{{message}}</td></tr>";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-heading.html
	var dashboard_heading_default = "<th>{{label}}</th>";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-badge.html
	var dashboard_badge_default = " <small class=\"{{kind}}\">{{label}}</small>";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-pattern.html
	var dashboard_pattern_default = "<code>/{{pattern}}/</code>";
	const dashboardCopy = {
		en: {
			title: "Sentinel overview",
			watchesTitle: "Active watches",
			heads: [
				"Session",
				"Watch",
				"Sensor",
				"Target",
				"Pattern",
				"Fires",
				"Last state",
				"Next probe",
				""
			],
			fireHeads: [
				"Time",
				"Watch",
				"Session",
				"Summary"
			],
			empty: "No active watches right now.",
			firesTitle: "Recent fires",
			firesEmpty: "No fires yet.",
			live: "live",
			dormant: "dormant",
			probing: "probing",
			push: "live push",
			cancel: "Cancel this watch",
			pending: "{n} pending",
			dropped: "{n} dropped",
			count: "{n} watch(es)",
			duty: "duty heartbeat {age}s ago",
			dutyStale: "duty heartbeat stale ({age}s ago)",
			dutyNone: "no resident duty process"
		},
		zh: {
			title: "Sentinel 全局总览",
			watchesTitle: "活跃监控",
			heads: [
				"会话",
				"监控",
				"传感器",
				"目标",
				"模式",
				"触发",
				"最近状态",
				"下次探测",
				""
			],
			fireHeads: [
				"时间",
				"监控",
				"会话",
				"摘要"
			],
			empty: "当前没有活跃的监控。",
			firesTitle: "最近触发",
			firesEmpty: "尚未触发过。",
			live: "活跃",
			dormant: "休眠",
			probing: "探测中",
			push: "即时推送",
			cancel: "取消这个监控",
			pending: "待投递 {n}",
			dropped: "已丢弃 {n} 唤醒",
			count: "{n} 个监控",
			duty: "值守心跳 {age}s 前",
			dutyStale: "值守心跳 {age}s 前（疑似停摆）",
			dutyNone: "无常驻值守进程"
		}
	};
	/** Normal typed imports share the same templates and formatting between SSR and the browser. */
	function createDashboardRenderer(locale) {
		const copy = dashboardCopy[locale];
		const presentation = createPresentation(locale, messages[locale]);
		const fill = (template, values) => template.replace(/\{(\w+)\}/g, (token, key) => values[key] === void 0 ? token : String(values[key]));
		const time = (value) => (value === void 0 ? /* @__PURE__ */ new Date() : new Date(value)).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en");
		const badge = (kind, count) => count > 0 ? renderTemplate(dashboard_badge_default, {
			kind,
			label: fill(copy[kind], { n: count })
		}) : joinHtml([]);
		const rows = (watches, dropped = {}) => {
			if (watches.length === 0) return renderTemplate(dashboard_empty_default, {
				columns: 9,
				message: copy.empty
			});
			return joinHtml(watches.map((row) => renderTemplate(dashboard_watch_default, {
				session: row.sessionId.slice(0, 16),
				sessionId: row.sessionId,
				live: row.live ? copy.live : copy.dormant,
				id: row.id,
				kind: row.kind,
				note: row.note,
				target: row.target,
				fireCount: row.fireCount,
				maxFires: row.maxFires,
				state: row.lastState === void 0 ? copy.probing : presentation.localizeState(row.lastState),
				next: row.kind === "webhook" ? copy.push : row.nextDueAt !== void 0 ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1e3)))}s` : "…",
				cancel: copy.cancel
			}, {
				dropped: badge("dropped", dropped[row.sessionId] ?? 0),
				pending: badge("pending", row.pendingWakeups),
				pattern: row.pattern === void 0 ? renderTemplate("—", {}) : renderTemplate(dashboard_pattern_default, { pattern: row.pattern })
			})));
		};
		const fires = (facts) => facts.length === 0 ? renderTemplate(dashboard_empty_default, {
			columns: 4,
			message: copy.firesEmpty
		}) : joinHtml(facts.map((fire) => renderTemplate(dashboard_fire_default, {
			time: time(fire.at),
			id: fire.id,
			session: fire.sessionId.slice(0, 16),
			summary: presentation.formatFireSummary(fire)
		})));
		const meta = (count, duty) => {
			const dutyText = duty == null ? copy.dutyNone : fill(duty.stale ? copy.dutyStale : copy.duty, { age: Math.max(0, Math.round(duty.ageMs / 1e3)) });
			return `· ${fill(copy.count, { n: count })} · ${dutyText} · ${time()}`;
		};
		const headings = (labels) => joinHtml(labels.map((label) => renderTemplate(dashboard_heading_default, { label })));
		return {
			rows,
			fires,
			meta,
			headings
		};
	}
	//#endregion
	//#region src/dashboard-client.ts
	const STATE_PATH = "/plugins/dsh-sentinel/state";
	const CANCEL_PATH = "/plugins/dsh-sentinel/cancel";
	const POLL_MS = 3e3;
	/** Start the standalone page after its deferred script loads; the server owns its language. */
	function startDashboard() {
		const rows = document.getElementById("rows");
		const fires = document.getElementById("fires");
		const meta = document.getElementById("meta");
		if (rows === null || fires === null || meta === null) return () => {};
		const renderer = createDashboardRenderer(resolveLocale(document.documentElement.lang));
		const lifecycle = document.defaultView;
		const cancellations = /* @__PURE__ */ new Map();
		let disposed = false;
		let paused = false;
		const poller = createPoller({
			intervalMs: POLL_MS,
			run: async (signal) => {
				const response = await fetch(STATE_PATH, {
					headers: { accept: "application/json" },
					signal
				});
				if (!response.ok || signal.aborted || disposed || paused) return;
				const data = await response.json();
				if (signal.aborted || disposed || paused) return;
				const watches = Array.isArray(data.watches) ? data.watches : [];
				const nextRows = renderer.rows(watches, data.droppedWakeups ?? {});
				const nextFires = renderer.fires(Array.isArray(data.recentFires) ? data.recentFires : []);
				const nextMeta = renderer.meta(watches.length, data.duty);
				rows.innerHTML = nextRows;
				fires.innerHTML = nextFires;
				meta.textContent = nextMeta;
			},
			onError: () => {}
		});
		const cancel = async (button, sessionId, id) => {
			const controller = new AbortController();
			const timer = setTimeout(() => {
				controller.abort();
			}, DEFAULT_POLL_TIMEOUT_MS);
			cancellations.set(button, {
				controller,
				timer
			});
			button.disabled = true;
			let succeeded = false;
			try {
				succeeded = (await fetch(`${CANCEL_PATH}?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, {
					method: "POST",
					signal: controller.signal
				})).ok && !controller.signal.aborted && !disposed && !paused;
			} catch {} finally {
				clearTimeout(timer);
				if (cancellations.get(button)?.controller === controller) {
					cancellations.delete(button);
					if (!succeeded) button.disabled = false;
				}
			}
		};
		const onClick = (event) => {
			const target = event.target;
			if (disposed || paused || typeof target?.closest !== "function") return;
			const button = target.closest("button.cancel");
			if (button === null || !rows.contains(button) || button.disabled) return;
			const sessionId = button.getAttribute("data-session");
			const id = button.getAttribute("data-id");
			if (sessionId === null || id === null || sessionId === "" || id === "") return;
			cancel(button, sessionId, id);
		};
		const pause = () => {
			paused = true;
			poller.stop();
			for (const [button, request] of cancellations) {
				clearTimeout(request.timer);
				request.controller.abort();
				button.disabled = false;
			}
			cancellations.clear();
		};
		const resume = () => {
			if (disposed) return;
			paused = false;
			poller.start();
		};
		const dispose = () => {
			if (disposed) return;
			disposed = true;
			pause();
			rows.removeEventListener("click", onClick);
			lifecycle?.removeEventListener("pagehide", pause);
			lifecycle?.removeEventListener("pageshow", resume);
		};
		rows.addEventListener("click", onClick);
		lifecycle?.addEventListener("pagehide", pause);
		lifecycle?.addEventListener("pageshow", resume);
		poller.start();
		return dispose;
	}
	if (typeof document !== "undefined") startDashboard();
	//#endregion
})();
