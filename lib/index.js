import { watch } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { exec, execFile } from "node:child_process";
import { connect } from "node:net";
//#region src/locale.ts
/** Normalize an explicit language tag; unknown tags use the English dictionary. */
function resolveLocale(value) {
	return /^zh(?:-|$)/i.test(value ?? "") ? "zh" : "en";
}
/** Negotiate the dashboard's two supported languages without treating unsupported tags as English. */
function negotiateLocale(acceptLanguage, fallback = "en") {
	if (acceptLanguage === void 0 || acceptLanguage.trim() === "") return fallback;
	const preferences = [];
	for (const [order, entry] of acceptLanguage.split(",").entries()) {
		const [rawRange = "", ...parameters] = entry.trim().split(/\s*;\s*/);
		if (!/^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/i.test(rawRange)) continue;
		let quality = 1;
		if (parameters.length > 0) {
			const weight = parameters.length === 1 ? /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameters[0]) : null;
			if (weight === null) continue;
			quality = Number(weight[1]);
		}
		preferences.push({
			range: rawRange.toLowerCase().split("-")[0],
			quality,
			order
		});
	}
	preferences.sort((a, b) => b.quality - a.quality || a.order - b.order);
	const wildcard = preferences.find((preference) => preference.range === "*");
	const candidates = [fallback, fallback === "en" ? "zh" : "en"].map((locale) => {
		const preference = preferences.find((preference) => preference.range === locale) ?? wildcard;
		return {
			locale,
			quality: preference?.quality ?? 0,
			order: preference?.order ?? Infinity
		};
	});
	candidates.sort((a, b) => b.quality - a.quality || a.order - b.order);
	return candidates[0].quality > 0 ? candidates[0].locale : "en";
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
function translate(locale, key, values = {}) {
	return createPresentation(locale, messages[locale]).translate(key, values);
}
function localizeState$1(state, locale) {
	return createPresentation(locale, messages[locale]).localizeState(state);
}
function formatFireSummary(fact, locale) {
	return createPresentation(locale, messages[locale]).formatFireSummary(fact);
}
//#endregion
//#region src/domain.ts
/**
* Sentinel domain: subscription records, the sentinel/change event codec, and
* the pure fold that rebuilds live subscriptions from a session's event log.
*
* Follows the tool-schedule pattern: every mutation is one appended
* `sentinel/change` session event; runtime state is always a fold over the
* log, so subscriptions survive restarts and stay fully auditable.
*/
const SENTINEL_CHANGE_TYPE = "sentinel/change";
var SentinelLogError = class extends Error {
	name = "SentinelLogError";
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Validate a persisted probe observation ({@link KnownSnapshot}). */
function decodeObserved(value) {
	if (!isRecord(value) || typeof value["state"] !== "string" || typeof value["snapshot"] !== "string") throw new SentinelLogError("observed snapshot must carry string state and snapshot");
	return {
		state: value["state"],
		snapshot: value["snapshot"]
	};
}
const SENSOR_KINDS = [
	"file",
	"command",
	"http",
	"process",
	"port",
	"webhook"
];
const MAX_INTERVAL_SECONDS = 86400;
const MAX_NOTE_LENGTH = 2e3;
/** Validate and normalize an agent-provided sensor spec; throws on nonsense. */
function normalizeSpec(value) {
	if (!isRecord(value)) throw new SentinelLogError("sensor spec must be an object");
	const kind = value["kind"];
	if (typeof kind !== "string" || !SENSOR_KINDS.includes(kind)) throw new SentinelLogError(`sensor kind must be one of ${SENSOR_KINDS.join(", ")}`);
	const target = value["target"];
	if (typeof target !== "string" || target.trim() === "") throw new SentinelLogError("sensor target must be a non-empty string");
	if (kind === "port") {
		const match = /^(?:([^:\s]+):)?(\d{1,5})$/.exec(target.trim());
		const port = match === null ? NaN : Number(match[2]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SentinelLogError("port target must be \"[host:]port\" with a port in 1-65535");
	}
	const pattern = value["pattern"];
	if (pattern !== void 0) {
		if (typeof pattern !== "string" || pattern === "") throw new SentinelLogError("pattern must be a non-empty string when present");
		try {
			new RegExp(pattern);
		} catch {
			throw new SentinelLogError(`pattern is not a valid regular expression: ${pattern}`);
		}
	}
	const rawInterval = value["intervalSeconds"];
	const clamped = Math.min(MAX_INTERVAL_SECONDS, Math.max(5, typeof rawInterval === "number" && Number.isFinite(rawInterval) ? Math.round(rawInterval) : 30));
	return {
		kind,
		target: target.trim(),
		...pattern !== void 0 ? { pattern } : {},
		intervalSeconds: clamped
	};
}
/** Decode one sentinel/change payload; throws SentinelLogError on corrupt rows. */
function decodeSentinelChange(value) {
	if (!isRecord(value)) throw new SentinelLogError("sentinel/change payload must be an object");
	const version = value["version"];
	if (version !== 1) throw new SentinelLogError(`unsupported sentinel/change version: ${String(version)}`);
	const change = value["change"];
	if (change === "created") {
		const sub = value["subscription"];
		if (!isRecord(sub)) throw new SentinelLogError("created change must carry a subscription object");
		const id = sub["id"];
		const note = sub["note"];
		const createdAt = sub["createdAt"];
		if (typeof id !== "string" || id === "") throw new SentinelLogError("subscription id must be a non-empty string");
		if (typeof note !== "string" || note === "") throw new SentinelLogError("subscription note must be a non-empty string");
		if (typeof createdAt !== "string") throw new SentinelLogError("subscription createdAt must be a string");
		const maxFires = sub["maxFires"];
		const cooldown = sub["cooldownSeconds"];
		if (typeof maxFires !== "number" || !Number.isInteger(maxFires) || maxFires < 1) throw new SentinelLogError("maxFires must be a positive integer");
		if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 0) throw new SentinelLogError("cooldownSeconds must be a non-negative integer");
		const expiresAt = sub["expiresAt"];
		if (expiresAt !== void 0 && typeof expiresAt !== "string") throw new SentinelLogError("expiresAt must be a string when present");
		return {
			version: 1,
			change: "created",
			subscription: {
				id,
				spec: normalizeSpec(sub["spec"]),
				note,
				maxFires,
				cooldownSeconds: cooldown,
				...expiresAt !== void 0 ? { expiresAt } : {},
				createdAt
			}
		};
	}
	if (change === "baseline") {
		const id = value["id"];
		const at = value["at"];
		if (typeof id !== "string" || typeof at !== "string") throw new SentinelLogError("baseline change must carry id and at");
		return {
			version: 1,
			change: "baseline",
			id,
			at,
			observed: decodeObserved(value["observed"])
		};
	}
	if (change === "fired") {
		const id = value["id"];
		const at = value["at"];
		const fact = value["fact"];
		if (typeof id !== "string" || typeof at !== "string" || !isRecord(fact)) throw new SentinelLogError("fired change must carry id, at, and fact");
		const fireNumber = fact["fireNumber"];
		const summary = fact["summary"];
		const before = fact["before"];
		const after = fact["after"];
		const probeMs = fact["probeMs"];
		if (typeof fireNumber !== "number" || !Number.isFinite(fireNumber) || !Number.isInteger(fireNumber) || fireNumber < 1) throw new SentinelLogError("fire number must be a positive finite integer");
		if (typeof summary !== "string" || typeof before !== "string" || typeof after !== "string") throw new SentinelLogError("fire fact must carry string summary, before, and after");
		if (typeof probeMs !== "number" || !Number.isFinite(probeMs)) throw new SentinelLogError("fire probeMs must be a finite number");
		const rawTrigger = fact["trigger"];
		let trigger;
		if (rawTrigger !== void 0) {
			if (isRecord(rawTrigger) && (rawTrigger["kind"] === "change" || rawTrigger["kind"] === "webhook")) trigger = {
				...rawTrigger,
				kind: rawTrigger["kind"]
			};
			else if (isRecord(rawTrigger) && rawTrigger["kind"] === "pattern" && typeof rawTrigger["pattern"] === "string" && typeof rawTrigger["match"] === "string") trigger = {
				...rawTrigger,
				kind: "pattern",
				pattern: rawTrigger["pattern"],
				match: rawTrigger["match"]
			};
			else throw new SentinelLogError("fire trigger must be change, webhook, or pattern with string pattern and match");
		}
		const state = fact["state"];
		if (state !== void 0 && typeof state !== "string") throw new SentinelLogError("fire state must be a string when present");
		const observed = value["observed"];
		return {
			version: 1,
			change: "fired",
			id,
			at,
			fact: {
				...fact,
				fireNumber,
				summary,
				before,
				after,
				probeMs,
				...trigger !== void 0 ? { trigger } : {},
				...state !== void 0 ? { state } : {}
			},
			...observed !== void 0 ? { observed: decodeObserved(observed) } : {}
		};
	}
	if (change === "cancelled") {
		const id = value["id"];
		const at = value["at"];
		const reason = value["reason"];
		if (typeof id !== "string" || typeof at !== "string" || reason !== "agent" && reason !== "user" && reason !== "expired" && reason !== "exhausted") throw new SentinelLogError("cancelled change must carry id, at, and a known reason");
		return {
			version: 1,
			change: "cancelled",
			id,
			at,
			reason
		};
	}
	if (change === "delivered") {
		const at = value["at"];
		if (typeof at !== "string") throw new SentinelLogError("delivered change must carry at");
		return {
			version: 1,
			change: "delivered",
			at
		};
	}
	if (change === "compacted") {
		const sub = value["subscription"];
		if (!isRecord(sub)) throw new SentinelLogError("compacted change must carry a subscription object");
		const id = sub["id"];
		const note = sub["note"];
		const createdAt = sub["createdAt"];
		if (typeof id !== "string" || id === "") throw new SentinelLogError("subscription id must be a non-empty string");
		if (typeof note !== "string" || note === "") throw new SentinelLogError("subscription note must be a non-empty string");
		if (typeof createdAt !== "string") throw new SentinelLogError("subscription createdAt must be a string");
		const maxFires = sub["maxFires"];
		const cooldown = sub["cooldownSeconds"];
		const fireCount = sub["fireCount"];
		if (typeof maxFires !== "number" || !Number.isInteger(maxFires) || maxFires < 1) throw new SentinelLogError("maxFires must be a positive integer");
		if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 0) throw new SentinelLogError("cooldownSeconds must be a non-negative integer");
		if (typeof fireCount !== "number" || !Number.isInteger(fireCount) || fireCount < 0) throw new SentinelLogError("compacted fireCount must be a non-negative integer");
		const expiresAt = sub["expiresAt"];
		if (expiresAt !== void 0 && typeof expiresAt !== "string") throw new SentinelLogError("expiresAt must be a string when present");
		const lastFiredAt = sub["lastFiredAt"];
		if (lastFiredAt !== void 0 && typeof lastFiredAt !== "string") throw new SentinelLogError("lastFiredAt must be a string when present");
		const lastKnown = sub["lastKnown"];
		return {
			version: 1,
			change: "compacted",
			subscription: {
				id,
				spec: normalizeSpec(sub["spec"]),
				note,
				maxFires,
				cooldownSeconds: cooldown,
				...expiresAt !== void 0 ? { expiresAt } : {},
				createdAt,
				fireCount,
				...lastFiredAt !== void 0 ? { lastFiredAt } : {},
				...lastKnown !== void 0 ? { lastKnown: decodeObserved(lastKnown) } : {}
			}
		};
	}
	throw new SentinelLogError(`unknown sentinel change: ${String(change)}`);
}
/**
* Rebuild live subscriptions from a session event log. Corrupt rows fail the
* fold loudly (SentinelLogError) — a durable log this plugin wrote itself is
* a contract, not a suggestion.
*/
function foldSentinelEvents(events) {
	const active = /* @__PURE__ */ new Map();
	let lastOrdinal = 0;
	let undelivered = [];
	for (const event of events) {
		if (event.type !== "sentinel/change") continue;
		const change = decodeSentinelChange(event.payload);
		if (change.change === "created") {
			const sub = change.subscription;
			active.set(sub.id, {
				...sub,
				fireCount: 0
			});
			const match = /^watch-(\d+)$/.exec(sub.id);
			if (match !== null) lastOrdinal = Math.max(lastOrdinal, Number(match[1]));
			continue;
		}
		if (change.change === "compacted") {
			const sub = change.subscription;
			active.set(sub.id, { ...sub });
			const match = /^watch-(\d+)$/.exec(sub.id);
			if (match !== null) lastOrdinal = Math.max(lastOrdinal, Number(match[1]));
			continue;
		}
		if (change.change === "baseline") {
			const sub = active.get(change.id);
			if (sub === void 0) continue;
			active.set(change.id, {
				...sub,
				lastKnown: change.observed
			});
			continue;
		}
		if (change.change === "fired") {
			const sub = active.get(change.id);
			if (sub === void 0) continue;
			const fired = {
				...sub,
				fireCount: sub.fireCount + 1,
				lastFiredAt: change.at,
				...change.observed !== void 0 ? { lastKnown: change.observed } : {}
			};
			undelivered.push({
				id: change.id,
				at: change.at,
				sub: fired,
				fact: change.fact
			});
			if (fired.fireCount >= fired.maxFires) active.delete(change.id);
			else active.set(change.id, fired);
			continue;
		}
		if (change.change === "delivered") {
			undelivered = undelivered.filter((entry) => entry.at > change.at);
			continue;
		}
		if (change.change === "cancelled") undelivered = undelivered.filter((entry) => entry.id !== change.id);
		active.delete(change.id);
	}
	return {
		active,
		lastOrdinal,
		undeliveredFires: undelivered
	};
}
/** Allocate the next watch id given the folded picture. */
function allocateWatchId(folded) {
	return `watch-${folded.lastOrdinal + 1}`;
}
/** Clip a probe snapshot into an excerpt safe to log and deliver. */
function clipExcerpt(text) {
	if (text.length <= 640) return text;
	return `${text.slice(0, 640)}… (${String(text.length - 640)} more chars)`;
}
/**
* Render the wakeup message body: receipt, note, fact, history — everything
* future-self needs without re-probing.
*/
function renderWakeup(sub, fact, locale = "en") {
	return [
		translate(locale, "wakeupTitle", {
			id: sub.id,
			count: fact.fireNumber,
			max: sub.maxFires
		}),
		translate(locale, "wakeupTarget", {
			kind: sub.spec.kind,
			target: sub.spec.target
		}),
		sub.spec.pattern !== void 0 ? translate(locale, "wakeupPattern", { pattern: sub.spec.pattern }) : void 0,
		translate(locale, "wakeupChange", { summary: formatFireSummary(fact, locale) }),
		fact.before !== "" ? translate(locale, "wakeupBefore", { before: fact.before }) : void 0,
		translate(locale, "wakeupAfter", { after: fact.after }),
		"",
		translate(locale, "wakeupNote", { note: sub.note }),
		"",
		translate(locale, "wakeupInstruction"),
		fact.fireNumber >= sub.maxFires ? translate(locale, "wakeupLast") : translate(locale, "wakeupRemaining", {
			remaining: sub.maxFires - fact.fireNumber,
			id: sub.id
		})
	].filter((line) => line !== void 0).join("\n");
}
//#endregion
//#region src/sensors.ts
/**
* Sensor probes: one async function per SensorKind that captures a text
* snapshot of the watched thing. The runtime diffs consecutive snapshots (and
* applies the optional pattern) to decide whether a subscription fires.
*
* All probes are read-only by construction: file stat/read, HTTP GET, process
* listing, and — the one deliberate power tool — a shell command the agent
* already had permission to run interactively when it registered the watch.
*/
const PROBE_TIMEOUT_MS = 1e4;
const SNAPSHOT_TAIL_BYTES = 8192;
/**
* Placeholder snapshots mean "the target itself is missing/unreachable", not
* content. Patterns must never match them: an any-content regex like [\s\S]+
* would otherwise fire on the very first probe of an absent file.
*/
const PLACEHOLDER_ABSENT = "<absent>";
const PLACEHOLDER_UNREACHABLE = "<unreachable>";
const PLACEHOLDER_NONE = "<none>";
const PLACEHOLDER_PUSH_ONLY = "<push-only>";
function isPlaceholderSnapshot(snapshot) {
	return snapshot === PLACEHOLDER_ABSENT || snapshot === PLACEHOLDER_UNREACHABLE || snapshot === PLACEHOLDER_NONE || snapshot === PLACEHOLDER_PUSH_ONLY;
}
/** Read the tail of a file plus its identity line; missing file is a state, not an error. Only the trailing bytes are read, so huge files cost a bounded buffer. */
async function probeFile(target) {
	try {
		const info = await stat(target);
		let tail = "";
		if (info.isFile() && info.size > 0) {
			const length = Math.min(Number(info.size), SNAPSHOT_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			const handle = await open(target, "r");
			try {
				await handle.read(buffer, 0, length, Number(info.size) - length);
			} finally {
				await handle.close();
			}
			tail = buffer.toString("utf8");
		}
		return {
			snapshot: `size=${String(info.size)} mtime=${info.mtimeMs.toFixed(0)}\n${tail}`,
			state: `exists (${String(info.size)} bytes)`
		};
	} catch {
		return {
			snapshot: PLACEHOLDER_ABSENT,
			state: "absent"
		};
	}
}
/** Run a read-only command line; snapshot = exit code + combined output tail. */
function probeCommand(target) {
	return new Promise((resolve) => {
		exec(target, {
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: 1048576
		}, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
			const text = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trim();
			const tail = text.length > SNAPSHOT_TAIL_BYTES ? text.slice(-8192) : text;
			resolve({
				snapshot: `exit=${String(code)}\n${tail}`,
				state: `exit ${String(code)}`
			});
		});
	});
}
/** GET the URL; snapshot = status + body head, streamed so a huge body never lands whole in memory. Network failure is a state. */
async function probeHttp(target) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(target, {
			signal: controller.signal,
			redirect: "manual"
		});
		let head = "";
		const reader = response.body?.getReader();
		if (reader !== void 0) {
			const decoder = new TextDecoder();
			while (head.length < SNAPSHOT_TAIL_BYTES) {
				const { done, value } = await reader.read();
				if (done) break;
				head += decoder.decode(value, { stream: true });
			}
			reader.cancel().catch(() => {});
		} else head = await response.text();
		if (head.length > SNAPSHOT_TAIL_BYTES) head = head.slice(0, SNAPSHOT_TAIL_BYTES);
		return {
			snapshot: `status=${String(response.status)}\n${head}`,
			state: `HTTP ${String(response.status)}`
		};
	} catch {
		return {
			snapshot: PLACEHOLDER_UNREACHABLE,
			state: "unreachable"
		};
	} finally {
		clearTimeout(timer);
	}
}
/** List matching processes via pgrep; snapshot = sorted pid/cmd lines. */
function probeProcess(target) {
	return new Promise((resolve) => {
		execFile("pgrep", ["-af", target], {
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: 1048576
		}, (_error, stdout) => {
			const lines = stdout.split("\n").filter((line) => line.trim() !== "").sort();
			if (lines.length === 0) {
				resolve({
					snapshot: PLACEHOLDER_NONE,
					state: "no process"
				});
				return;
			}
			resolve({
				snapshot: lines.join("\n"),
				state: `${String(lines.length)} process(es)`
			});
		});
	});
}
/** TCP-connect to host:port; the snapshot is the open/closed/timeout word, so the generic diff fires on any reachability change. */
function probePort(target) {
	const match = /^(?:([^:\s]+):)?(\d{1,5})$/.exec(target.trim());
	const host = match?.[1] ?? "localhost";
	const port = Number(match?.[2]);
	return new Promise((resolve) => {
		let settled = false;
		const socket = connect({
			host,
			port
		});
		const settle = (word) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({
				snapshot: word,
				state: `${word} (${host}:${String(port)})`
			});
		};
		socket.setTimeout(PROBE_TIMEOUT_MS, () => {
			settle("timeout");
		});
		socket.on("connect", () => {
			settle("open");
		});
		socket.on("error", () => {
			settle("closed");
		});
	});
}
/** Dispatch one probe for a spec. Never throws: every failure mode is a state. */
function probe(spec) {
	switch (spec.kind) {
		case "file": return probeFile(spec.target);
		case "command": return probeCommand(spec.target);
		case "http": return probeHttp(spec.target);
		case "process": return probeProcess(spec.target);
		case "port": return probePort(spec.target);
		case "webhook": return Promise.resolve({
			snapshot: PLACEHOLDER_PUSH_ONLY,
			state: "awaiting push"
		});
	}
}
/**
* Transition decision: given the optional pattern and two consecutive
* snapshots, decide whether the watched condition newly holds.
*
* - With a pattern: fire on the no-match → match edge (level-triggered would
*   re-fire forever; the cooldown alone should not have to carry that).
*   Placeholder snapshots never match, so the edge a content pattern waits
*   for is placeholder → real matching content.
* - Without a pattern: fire on any snapshot change after the baseline.
*/
function shouldFire(pattern, previous, current) {
	if (pattern !== void 0) {
		const regex = new RegExp(pattern, "m");
		const was = previous !== void 0 && !isPlaceholderSnapshot(previous) && regex.test(previous);
		const is = !isPlaceholderSnapshot(current) && regex.test(current);
		if (!was && is) {
			const trigger = {
				kind: "pattern",
				pattern,
				match: regex.exec(current)?.[0] ?? ""
			};
			return {
				fire: true,
				summary: formatFireSummary({
					summary: "",
					trigger
				}, "en"),
				trigger
			};
		}
		return {
			fire: false,
			summary: ""
		};
	}
	if (previous === void 0) return {
		fire: false,
		summary: ""
	};
	if (previous !== current) {
		const trigger = { kind: "change" };
		return {
			fire: true,
			summary: formatFireSummary({
				summary: "",
				trigger
			}, "en"),
			trigger
		};
	}
	return {
		fire: false,
		summary: ""
	};
}
//#endregion
//#region src/store.ts
/**
* Plugin-owned durable log. The host's session log REFUSES foreign event
* types on the cold read path (`KNOWN_SESSION_EVENT_TYPES` in
* `dsh-session/known-event-types`: "a registration surface for plugin events
* is deferred until such a consumer exists"), so sentinel state lives in a
* sidecar JSONL under the harness home instead: one line per change, grouped
* by session, folded on load — the same event-sourcing discipline, our own
* file.
*/
/**
* Append-only JSONL store. Writes are chained so rows land in order; reads
* tolerate a torn final line (crash mid-append) by dropping it.
*/
var SentinelStore = class {
	path;
	chain = Promise.resolve();
	constructor(path) {
		this.path = path;
	}
	/** Load and group every persisted change; corrupt full lines throw, a torn tail is dropped. */
	async load() {
		let text;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return /* @__PURE__ */ new Map();
			throw error;
		}
		const rows = /* @__PURE__ */ new Map();
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			if (line.trim() === "") continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				if (index >= lines.length - 2) break;
				throw error;
			}
			if (typeof parsed.sessionId !== "string") continue;
			const change = decodeSentinelChange(parsed.change);
			const list = rows.get(parsed.sessionId) ?? [];
			list.push({
				type: SENTINEL_CHANGE_TYPE,
				payload: change
			});
			rows.set(parsed.sessionId, list);
		}
		return rows;
	}
	/** Durably append one change; resolves after the write lands. */
	append(sessionId, change) {
		const line = `${JSON.stringify({
			v: 1,
			sessionId,
			change
		})}\n`;
		const next = this.chain.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			await appendFile(this.path, line, "utf8");
		});
		this.chain = next.catch(() => {});
		return next;
	}
	/** Atomically rewrite the whole log (boot-time compaction); rides the append chain. */
	replaceAll(lines) {
		const text = lines.map((line) => `${line}\n`).join("");
		const next = this.chain.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.compacting`;
			await writeFile(tmp, text, "utf8");
			await rename(tmp, this.path);
		});
		this.chain = next.catch(() => {});
		return next;
	}
};
//#endregion
//#region node_modules/.pnpm/mustache@4.2.0/node_modules/mustache/mustache.mjs
/*!
* mustache.js - Logic-less {{mustache}} templates with JavaScript
* http://github.com/janl/mustache.js
*/
var objectToString = Object.prototype.toString;
var isArray = Array.isArray || function isArrayPolyfill(object) {
	return objectToString.call(object) === "[object Array]";
};
function isFunction(object) {
	return typeof object === "function";
}
/**
* More correct typeof string handling array
* which normally returns typeof 'object'
*/
function typeStr(obj) {
	return isArray(obj) ? "array" : typeof obj;
}
function escapeRegExp(string) {
	return string.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
}
/**
* Null safe way of checking whether or not an object,
* including its prototype, has a given property
*/
function hasProperty(obj, propName) {
	return obj != null && typeof obj === "object" && propName in obj;
}
/**
* Safe way of detecting whether or not the given thing is a primitive and
* whether it has the given property
*/
function primitiveHasOwnProperty(primitive, propName) {
	return primitive != null && typeof primitive !== "object" && primitive.hasOwnProperty && primitive.hasOwnProperty(propName);
}
var regExpTest = RegExp.prototype.test;
function testRegExp(re, string) {
	return regExpTest.call(re, string);
}
var nonSpaceRe = /\S/;
function isWhitespace(string) {
	return !testRegExp(nonSpaceRe, string);
}
var entityMap = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;",
	"'": "&#39;",
	"/": "&#x2F;",
	"`": "&#x60;",
	"=": "&#x3D;"
};
function escapeHtml(string) {
	return String(string).replace(/[&<>"'`=\/]/g, function fromEntityMap(s) {
		return entityMap[s];
	});
}
var whiteRe = /\s*/;
var spaceRe = /\s+/;
var equalsRe = /\s*=/;
var curlyRe = /\s*\}/;
var tagRe = /#|\^|\/|>|\{|&|=|!/;
/**
* Breaks up the given `template` string into a tree of tokens. If the `tags`
* argument is given here it must be an array with two string values: the
* opening and closing tags used in the template (e.g. [ "<%", "%>" ]). Of
* course, the default is to use mustaches (i.e. mustache.tags).
*
* A token is an array with at least 4 elements. The first element is the
* mustache symbol that was used inside the tag, e.g. "#" or "&". If the tag
* did not contain a symbol (i.e. {{myValue}}) this element is "name". For
* all text that appears outside a symbol this element is "text".
*
* The second element of a token is its "value". For mustache tags this is
* whatever else was inside the tag besides the opening symbol. For text tokens
* this is the text itself.
*
* The third and fourth elements of the token are the start and end indices,
* respectively, of the token in the original template.
*
* Tokens that are the root node of a subtree contain two more elements: 1) an
* array of tokens in the subtree and 2) the index in the original template at
* which the closing tag for that section begins.
*
* Tokens for partials also contain two more elements: 1) a string value of
* indendation prior to that tag and 2) the index of that tag on that line -
* eg a value of 2 indicates the partial is the third tag on this line.
*/
function parseTemplate(template, tags) {
	if (!template) return [];
	var lineHasNonSpace = false;
	var sections = [];
	var tokens = [];
	var spaces = [];
	var hasTag = false;
	var nonSpace = false;
	var indentation = "";
	var tagIndex = 0;
	function stripSpace() {
		if (hasTag && !nonSpace) while (spaces.length) delete tokens[spaces.pop()];
		else spaces = [];
		hasTag = false;
		nonSpace = false;
	}
	var openingTagRe, closingTagRe, closingCurlyRe;
	function compileTags(tagsToCompile) {
		if (typeof tagsToCompile === "string") tagsToCompile = tagsToCompile.split(spaceRe, 2);
		if (!isArray(tagsToCompile) || tagsToCompile.length !== 2) throw new Error("Invalid tags: " + tagsToCompile);
		openingTagRe = new RegExp(escapeRegExp(tagsToCompile[0]) + "\\s*");
		closingTagRe = new RegExp("\\s*" + escapeRegExp(tagsToCompile[1]));
		closingCurlyRe = new RegExp("\\s*" + escapeRegExp("}" + tagsToCompile[1]));
	}
	compileTags(tags || mustache.tags);
	var scanner = new Scanner(template);
	var start, type, value, chr, token, openSection;
	while (!scanner.eos()) {
		start = scanner.pos;
		value = scanner.scanUntil(openingTagRe);
		if (value) for (var i = 0, valueLength = value.length; i < valueLength; ++i) {
			chr = value.charAt(i);
			if (isWhitespace(chr)) {
				spaces.push(tokens.length);
				indentation += chr;
			} else {
				nonSpace = true;
				lineHasNonSpace = true;
				indentation += " ";
			}
			tokens.push([
				"text",
				chr,
				start,
				start + 1
			]);
			start += 1;
			if (chr === "\n") {
				stripSpace();
				indentation = "";
				tagIndex = 0;
				lineHasNonSpace = false;
			}
		}
		if (!scanner.scan(openingTagRe)) break;
		hasTag = true;
		type = scanner.scan(tagRe) || "name";
		scanner.scan(whiteRe);
		if (type === "=") {
			value = scanner.scanUntil(equalsRe);
			scanner.scan(equalsRe);
			scanner.scanUntil(closingTagRe);
		} else if (type === "{") {
			value = scanner.scanUntil(closingCurlyRe);
			scanner.scan(curlyRe);
			scanner.scanUntil(closingTagRe);
			type = "&";
		} else value = scanner.scanUntil(closingTagRe);
		if (!scanner.scan(closingTagRe)) throw new Error("Unclosed tag at " + scanner.pos);
		if (type == ">") token = [
			type,
			value,
			start,
			scanner.pos,
			indentation,
			tagIndex,
			lineHasNonSpace
		];
		else token = [
			type,
			value,
			start,
			scanner.pos
		];
		tagIndex++;
		tokens.push(token);
		if (type === "#" || type === "^") sections.push(token);
		else if (type === "/") {
			openSection = sections.pop();
			if (!openSection) throw new Error("Unopened section \"" + value + "\" at " + start);
			if (openSection[1] !== value) throw new Error("Unclosed section \"" + openSection[1] + "\" at " + start);
		} else if (type === "name" || type === "{" || type === "&") nonSpace = true;
		else if (type === "=") compileTags(value);
	}
	stripSpace();
	openSection = sections.pop();
	if (openSection) throw new Error("Unclosed section \"" + openSection[1] + "\" at " + scanner.pos);
	return nestTokens(squashTokens(tokens));
}
/**
* Combines the values of consecutive text tokens in the given `tokens` array
* to a single token.
*/
function squashTokens(tokens) {
	var squashedTokens = [];
	var token, lastToken;
	for (var i = 0, numTokens = tokens.length; i < numTokens; ++i) {
		token = tokens[i];
		if (token) {
			if (token[0] === "text" && lastToken && lastToken[0] === "text") {
				lastToken[1] += token[1];
				lastToken[3] = token[3];
			} else {
				squashedTokens.push(token);
				lastToken = token;
			}
		}
	}
	return squashedTokens;
}
/**
* Forms the given array of `tokens` into a nested tree structure where
* tokens that represent a section have two additional items: 1) an array of
* all tokens that appear in that section and 2) the index in the original
* template that represents the end of that section.
*/
function nestTokens(tokens) {
	var nestedTokens = [];
	var collector = nestedTokens;
	var sections = [];
	var token, section;
	for (var i = 0, numTokens = tokens.length; i < numTokens; ++i) {
		token = tokens[i];
		switch (token[0]) {
			case "#":
			case "^":
				collector.push(token);
				sections.push(token);
				collector = token[4] = [];
				break;
			case "/":
				section = sections.pop();
				section[5] = token[2];
				collector = sections.length > 0 ? sections[sections.length - 1][4] : nestedTokens;
				break;
			default: collector.push(token);
		}
	}
	return nestedTokens;
}
/**
* A simple string scanner that is used by the template parser to find
* tokens in template strings.
*/
function Scanner(string) {
	this.string = string;
	this.tail = string;
	this.pos = 0;
}
/**
* Returns `true` if the tail is empty (end of string).
*/
Scanner.prototype.eos = function eos() {
	return this.tail === "";
};
/**
* Tries to match the given regular expression at the current position.
* Returns the matched text if it can match, the empty string otherwise.
*/
Scanner.prototype.scan = function scan(re) {
	var match = this.tail.match(re);
	if (!match || match.index !== 0) return "";
	var string = match[0];
	this.tail = this.tail.substring(string.length);
	this.pos += string.length;
	return string;
};
/**
* Skips all text until the given regular expression can be matched. Returns
* the skipped string, which is the entire tail if no match can be made.
*/
Scanner.prototype.scanUntil = function scanUntil(re) {
	var index = this.tail.search(re), match;
	switch (index) {
		case -1:
			match = this.tail;
			this.tail = "";
			break;
		case 0:
			match = "";
			break;
		default:
			match = this.tail.substring(0, index);
			this.tail = this.tail.substring(index);
	}
	this.pos += match.length;
	return match;
};
/**
* Represents a rendering context by wrapping a view object and
* maintaining a reference to the parent context.
*/
function Context(view, parentContext) {
	this.view = view;
	this.cache = { ".": this.view };
	this.parent = parentContext;
}
/**
* Creates a new context using the given view with this context
* as the parent.
*/
Context.prototype.push = function push(view) {
	return new Context(view, this);
};
/**
* Returns the value of the given name in this context, traversing
* up the context hierarchy if the value is absent in this context's view.
*/
Context.prototype.lookup = function lookup(name) {
	var cache = this.cache;
	var value;
	if (cache.hasOwnProperty(name)) value = cache[name];
	else {
		var context = this, intermediateValue, names, index, lookupHit = false;
		while (context) {
			if (name.indexOf(".") > 0) {
				intermediateValue = context.view;
				names = name.split(".");
				index = 0;
				/**
				* Using the dot notion path in `name`, we descend through the
				* nested objects.
				*
				* To be certain that the lookup has been successful, we have to
				* check if the last object in the path actually has the property
				* we are looking for. We store the result in `lookupHit`.
				*
				* This is specially necessary for when the value has been set to
				* `undefined` and we want to avoid looking up parent contexts.
				*
				* In the case where dot notation is used, we consider the lookup
				* to be successful even if the last "object" in the path is
				* not actually an object but a primitive (e.g., a string, or an
				* integer), because it is sometimes useful to access a property
				* of an autoboxed primitive, such as the length of a string.
				**/
				while (intermediateValue != null && index < names.length) {
					if (index === names.length - 1) lookupHit = hasProperty(intermediateValue, names[index]) || primitiveHasOwnProperty(intermediateValue, names[index]);
					intermediateValue = intermediateValue[names[index++]];
				}
			} else {
				intermediateValue = context.view[name];
				/**
				* Only checking against `hasProperty`, which always returns `false` if
				* `context.view` is not an object. Deliberately omitting the check
				* against `primitiveHasOwnProperty` if dot notation is not used.
				*
				* Consider this example:
				* ```
				* Mustache.render("The length of a football field is {{#length}}{{length}}{{/length}}.", {length: "100 yards"})
				* ```
				*
				* If we were to check also against `primitiveHasOwnProperty`, as we do
				* in the dot notation case, then render call would return:
				*
				* "The length of a football field is 9."
				*
				* rather than the expected:
				*
				* "The length of a football field is 100 yards."
				**/
				lookupHit = hasProperty(context.view, name);
			}
			if (lookupHit) {
				value = intermediateValue;
				break;
			}
			context = context.parent;
		}
		cache[name] = value;
	}
	if (isFunction(value)) value = value.call(this.view);
	return value;
};
/**
* A Writer knows how to take a stream of tokens and render them to a
* string, given a context. It also maintains a cache of templates to
* avoid the need to parse the same template twice.
*/
function Writer() {
	this.templateCache = {
		_cache: {},
		set: function set(key, value) {
			this._cache[key] = value;
		},
		get: function get(key) {
			return this._cache[key];
		},
		clear: function clear() {
			this._cache = {};
		}
	};
}
/**
* Clears all cached templates in this writer.
*/
Writer.prototype.clearCache = function clearCache() {
	if (typeof this.templateCache !== "undefined") this.templateCache.clear();
};
/**
* Parses and caches the given `template` according to the given `tags` or
* `mustache.tags` if `tags` is omitted,  and returns the array of tokens
* that is generated from the parse.
*/
Writer.prototype.parse = function parse(template, tags) {
	var cache = this.templateCache;
	var cacheKey = template + ":" + (tags || mustache.tags).join(":");
	var isCacheEnabled = typeof cache !== "undefined";
	var tokens = isCacheEnabled ? cache.get(cacheKey) : void 0;
	if (tokens == void 0) {
		tokens = parseTemplate(template, tags);
		isCacheEnabled && cache.set(cacheKey, tokens);
	}
	return tokens;
};
/**
* High-level method that is used to render the given `template` with
* the given `view`.
*
* The optional `partials` argument may be an object that contains the
* names and templates of partials that are used in the template. It may
* also be a function that is used to load partial templates on the fly
* that takes a single argument: the name of the partial.
*
* If the optional `config` argument is given here, then it should be an
* object with a `tags` attribute or an `escape` attribute or both.
* If an array is passed, then it will be interpreted the same way as
* a `tags` attribute on a `config` object.
*
* The `tags` attribute of a `config` object must be an array with two
* string values: the opening and closing tags used in the template (e.g.
* [ "<%", "%>" ]). The default is to mustache.tags.
*
* The `escape` attribute of a `config` object must be a function which
* accepts a string as input and outputs a safely escaped string.
* If an `escape` function is not provided, then an HTML-safe string
* escaping function is used as the default.
*/
Writer.prototype.render = function render(template, view, partials, config) {
	var tags = this.getConfigTags(config);
	var tokens = this.parse(template, tags);
	var context = view instanceof Context ? view : new Context(view, void 0);
	return this.renderTokens(tokens, context, partials, template, config);
};
/**
* Low-level method that renders the given array of `tokens` using
* the given `context` and `partials`.
*
* Note: The `originalTemplate` is only ever used to extract the portion
* of the original template that was contained in a higher-order section.
* If the template doesn't use higher-order sections, this argument may
* be omitted.
*/
Writer.prototype.renderTokens = function renderTokens(tokens, context, partials, originalTemplate, config) {
	var buffer = "";
	var token, symbol, value;
	for (var i = 0, numTokens = tokens.length; i < numTokens; ++i) {
		value = void 0;
		token = tokens[i];
		symbol = token[0];
		if (symbol === "#") value = this.renderSection(token, context, partials, originalTemplate, config);
		else if (symbol === "^") value = this.renderInverted(token, context, partials, originalTemplate, config);
		else if (symbol === ">") value = this.renderPartial(token, context, partials, config);
		else if (symbol === "&") value = this.unescapedValue(token, context);
		else if (symbol === "name") value = this.escapedValue(token, context, config);
		else if (symbol === "text") value = this.rawValue(token);
		if (value !== void 0) buffer += value;
	}
	return buffer;
};
Writer.prototype.renderSection = function renderSection(token, context, partials, originalTemplate, config) {
	var self = this;
	var buffer = "";
	var value = context.lookup(token[1]);
	function subRender(template) {
		return self.render(template, context, partials, config);
	}
	if (!value) return;
	if (isArray(value)) for (var j = 0, valueLength = value.length; j < valueLength; ++j) buffer += this.renderTokens(token[4], context.push(value[j]), partials, originalTemplate, config);
	else if (typeof value === "object" || typeof value === "string" || typeof value === "number") buffer += this.renderTokens(token[4], context.push(value), partials, originalTemplate, config);
	else if (isFunction(value)) {
		if (typeof originalTemplate !== "string") throw new Error("Cannot use higher-order sections without the original template");
		value = value.call(context.view, originalTemplate.slice(token[3], token[5]), subRender);
		if (value != null) buffer += value;
	} else buffer += this.renderTokens(token[4], context, partials, originalTemplate, config);
	return buffer;
};
Writer.prototype.renderInverted = function renderInverted(token, context, partials, originalTemplate, config) {
	var value = context.lookup(token[1]);
	if (!value || isArray(value) && value.length === 0) return this.renderTokens(token[4], context, partials, originalTemplate, config);
};
Writer.prototype.indentPartial = function indentPartial(partial, indentation, lineHasNonSpace) {
	var filteredIndentation = indentation.replace(/[^ \t]/g, "");
	var partialByNl = partial.split("\n");
	for (var i = 0; i < partialByNl.length; i++) if (partialByNl[i].length && (i > 0 || !lineHasNonSpace)) partialByNl[i] = filteredIndentation + partialByNl[i];
	return partialByNl.join("\n");
};
Writer.prototype.renderPartial = function renderPartial(token, context, partials, config) {
	if (!partials) return;
	var tags = this.getConfigTags(config);
	var value = isFunction(partials) ? partials(token[1]) : partials[token[1]];
	if (value != null) {
		var lineHasNonSpace = token[6];
		var tagIndex = token[5];
		var indentation = token[4];
		var indentedValue = value;
		if (tagIndex == 0 && indentation) indentedValue = this.indentPartial(value, indentation, lineHasNonSpace);
		var tokens = this.parse(indentedValue, tags);
		return this.renderTokens(tokens, context, partials, indentedValue, config);
	}
};
Writer.prototype.unescapedValue = function unescapedValue(token, context) {
	var value = context.lookup(token[1]);
	if (value != null) return value;
};
Writer.prototype.escapedValue = function escapedValue(token, context, config) {
	var escape = this.getConfigEscape(config) || mustache.escape;
	var value = context.lookup(token[1]);
	if (value != null) return typeof value === "number" && escape === mustache.escape ? String(value) : escape(value);
};
Writer.prototype.rawValue = function rawValue(token) {
	return token[1];
};
Writer.prototype.getConfigTags = function getConfigTags(config) {
	if (isArray(config)) return config;
	else if (config && typeof config === "object") return config.tags;
	else return;
};
Writer.prototype.getConfigEscape = function getConfigEscape(config) {
	if (config && typeof config === "object" && !isArray(config)) return config.escape;
	else return;
};
var mustache = {
	name: "mustache.js",
	version: "4.2.0",
	tags: ["{{", "}}"],
	clearCache: void 0,
	escape: void 0,
	parse: void 0,
	render: void 0,
	Scanner: void 0,
	Context: void 0,
	Writer: void 0,
	/**
	* Allows a user to override the default caching strategy, by providing an
	* object with set, get and clear methods. This can also be used to disable
	* the cache by setting it to the literal `undefined`.
	*/
	set templateCache(cache) {
		defaultWriter.templateCache = cache;
	},
	/**
	* Gets the default or overridden caching object from the default writer.
	*/
	get templateCache() {
		return defaultWriter.templateCache;
	}
};
var defaultWriter = new Writer();
/**
* Clears all cached templates in the default writer.
*/
mustache.clearCache = function clearCache() {
	return defaultWriter.clearCache();
};
/**
* Parses and caches the given template in the default writer and returns the
* array of tokens it contains. Doing this ahead of time avoids the need to
* parse templates on the fly as they are rendered.
*/
mustache.parse = function parse(template, tags) {
	return defaultWriter.parse(template, tags);
};
/**
* Renders the `template` with the given `view`, `partials`, and `config`
* using the default writer.
*/
mustache.render = function render(template, view, partials, config) {
	if (typeof template !== "string") throw new TypeError("Invalid template! Template should be a \"string\" but \"" + typeStr(template) + "\" was given as the first argument for mustache#render(template, view, partials)");
	return defaultWriter.render(template, view, partials, config);
};
mustache.escape = escapeHtml;
mustache.Scanner = Scanner;
mustache.Context = Context;
mustache.Writer = Writer;
//#endregion
//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard/watches.html
var watches_default = "{{#watches}}\n<tr>\n  <td>{{session}}… <small>{{live}}</small>{{#dropped}} <small class=\"dropped\">{{label}}</small>{{/dropped}}</td>\n  <td>{{id}}</td>\n  <td>{{kind}}</td>\n  <td class=\"target\" title=\"{{note}}\">{{target}}</td>\n  <td>{{#patternView}}<code>/{{pattern}}/</code>{{/patternView}}{{^patternView}}—{{/patternView}}</td>\n  <td>{{fireCount}}/{{maxFires}}{{#pending}} <small class=\"pending\">{{label}}</small>{{/pending}}</td>\n  <td>{{state}}</td>\n  <td>{{next}}</td>\n  <td><button type=\"button\" class=\"cancel\" data-session=\"{{sessionId}}\" data-id=\"{{id}}\" title=\"{{cancel}}\" aria-label=\"{{cancel}} {{id}}\">×</button></td>\n</tr>\n{{/watches}}\n{{^watches}}\n<tr><td colspan=\"9\" class=\"empty\">{{emptyWatches}}</td></tr>\n{{/watches}}\n";
//#endregion
//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard/fires.html
var fires_default = "{{#fires}}\n<tr>\n  <td>{{time}}</td>\n  <td>{{id}}</td>\n  <td>{{session}}…</td>\n  <td class=\"target\">{{summary}}</td>\n</tr>\n{{/fires}}\n{{^fires}}\n<tr><td colspan=\"4\" class=\"empty\">{{emptyFires}}</td></tr>\n{{/fires}}\n";
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
/** Static, checked-in partials only; caller data is never interpreted as a template. */
const dashboardPartials = {
	watchRows: watches_default,
	fireRows: fires_default
};
/** Share plain presentation models and Mustache templates between SSR and the browser. */
function createDashboardRenderer(locale) {
	const copy = dashboardCopy[locale];
	const presentation = createPresentation(locale, messages[locale]);
	const fill = (template, values) => template.replace(/\{(\w+)\}/g, (token, key) => values[key] === void 0 ? token : String(values[key]));
	const time = (value) => (value === void 0 ? /* @__PURE__ */ new Date() : new Date(value)).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en");
	const badge = (kind, count) => count > 0 ? { label: fill(copy[kind], { n: count }) } : null;
	const watchModel = (watches, dropped = {}) => ({
		watches: watches.map((row) => ({
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
			cancel: copy.cancel,
			dropped: badge("dropped", dropped[row.sessionId] ?? 0),
			pending: badge("pending", row.pendingWakeups),
			patternView: row.pattern === void 0 ? null : { pattern: row.pattern }
		})),
		emptyWatches: copy.empty
	});
	const fireModel = (facts) => ({
		fires: facts.map((fire) => ({
			time: time(fire.at),
			id: fire.id,
			session: fire.sessionId.slice(0, 16),
			summary: presentation.formatFireSummary(fire)
		})),
		emptyFires: copy.firesEmpty
	});
	const rows = (watches, dropped = {}) => mustache.render(watches_default, watchModel(watches, dropped), dashboardPartials);
	const fires = (facts) => mustache.render(fires_default, fireModel(facts), dashboardPartials);
	const meta = (count, duty) => {
		const dutyText = duty == null ? copy.dutyNone : fill(duty.stale ? copy.dutyStale : copy.duty, { age: Math.max(0, Math.round(duty.ageMs / 1e3)) });
		return `· ${fill(copy.count, { n: count })} · ${dutyText} · ${time()}`;
	};
	return {
		rows,
		fires,
		meta,
		watchModel,
		fireModel
	};
}
//#endregion
//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/layouts/document.html
var document_default = "<!doctype html>\n<html lang=\"{{lang}}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{{title}}</title>\n<link rel=\"icon\" type=\"image/svg+xml\" href=\"{{iconPath}}\">\n<link rel=\"stylesheet\" href=\"{{stylePath}}\">\n<script src=\"{{scriptPath}}\" defer><\/script>\n</head>\n<body>\n<main>\n{{> dashboard}}\n</main>\n</body>\n</html>\n";
//#endregion
//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard.html
var dashboard_default = "<h1><span id=\"title\">👁 {{title}}</span> <small id=\"meta\"></small></h1>\n<div class=\"table-scroll\" role=\"region\" aria-label=\"{{watchesTitle}}\" tabindex=\"0\">\n<table>\n<thead><tr>{{#watchHeadings}}<th>{{label}}</th>{{/watchHeadings}}</tr></thead>\n<tbody id=\"rows\">\n{{> watchRows}}\n</tbody>\n</table>\n</div>\n<h2 id=\"firesTitle\">{{firesTitle}}</h2>\n<div class=\"table-scroll\" role=\"region\" aria-label=\"{{firesTitle}}\" tabindex=\"0\">\n<table>\n<thead><tr>{{#fireHeadings}}<th>{{label}}</th>{{/fireHeadings}}</tr></thead>\n<tbody id=\"fires\">\n{{> fireRows}}\n</tbody>\n</table>\n</div>\n";
//#endregion
//#region src/dashboard.ts
const DASHBOARD_SCRIPT_PATH = "/plugins/dsh-sentinel/dashboard.js";
const DASHBOARD_STYLE_PATH = "/plugins/dsh-sentinel/dashboard.css";
const DASHBOARD_ICON_PATH = "/plugins/dsh-sentinel/icon.svg";
/** Fixed package-relative assets work from source and installed lib without a workspace fallback. */
const dashboardAssets = [
	{
		path: DASHBOARD_SCRIPT_PATH,
		contentType: "text/javascript; charset=utf-8",
		file: new URL("../lib/dashboard.js", import.meta.url)
	},
	{
		path: DASHBOARD_STYLE_PATH,
		contentType: "text/css; charset=utf-8",
		file: new URL("../lib/dashboard.css", import.meta.url)
	},
	{
		path: DASHBOARD_ICON_PATH,
		contentType: "image/svg+xml; charset=utf-8",
		file: new URL("../icon.svg", import.meta.url)
	}
];
/** Retain the original public boolean helper while using shared presentation rules. */
function localizeState(state, zh) {
	return localizeState$1(state, zh ? "zh" : "en");
}
/** Render the external HTML template; no executable JavaScript or event handlers are interpolated. */
function dashboardHtml(rows, fires = [], dropped = {}, locale = "en") {
	const copy = dashboardCopy[locale];
	const render = createDashboardRenderer(locale);
	return mustache.render(document_default, {
		lang: locale === "zh" ? "zh-CN" : "en",
		title: copy.title,
		firesTitle: copy.firesTitle,
		watchesTitle: copy.watchesTitle,
		scriptPath: DASHBOARD_SCRIPT_PATH,
		stylePath: DASHBOARD_STYLE_PATH,
		iconPath: DASHBOARD_ICON_PATH,
		watchHeadings: copy.heads.map((label) => ({ label })),
		fireHeadings: copy.fireHeads.map((label) => ({ label })),
		...render.watchModel(rows, dropped),
		...render.fireModel(fires)
	}, {
		dashboard: dashboard_default,
		...dashboardPartials
	});
}
//#endregion
//#region src/index.ts
/**
* dsh-sentinel, node half.
*
* Lifecycle: watching is a SERVER-lifetime concern. One SentinelRuntime owns
* every session's subscriptions, probes all sensors on a shared heartbeat,
* and delivers wakeups through the official followup channel — resuming the
* session's agent via `ctx.agents.resume()` first when it is dormant.
*
* Durability: sentinel state lives in a plugin-owned sidecar JSONL under the
* harness home (see ./store.ts — the host session log rejects foreign event
* types on its cold read path, so it must stay untouched). State is always a
* fold over that log; the fold seeds probe baselines, so changes that happen
* while a session sleeps (or the server is down) late-fire on the next probe.
*
* Registered tools: sentinel_watch / sentinel_list / sentinel_cancel.
* Read-only routes: /plugins/dsh-sentinel/state (browser dock and sidebar
* branch render it) and /plugins/dsh-sentinel/dashboard (server-global watch
* table). Push route: POST /plugins/dsh-sentinel/hook?id=watch-N (webhooks).
* The routes mount through dynamic `ctx.inject(['webServer'])`, so headless
* profiles without a webServer service still load the runtime and tools.
*
* Durability: a duty lease (`$DSH_HOME/sentinel.lease`) keeps one probing
* owner per harness home — a second process stays passive, adopts nothing,
* and takes over within one lease TTL of the owner dying; the owner re-reads
* the sidecar each heartbeat so passive-created watches join the fold.
* Delivery is at-least-once: fires carry a `delivered` watermark, and a boot
* requeues everything logged past it. Fires optionally fan out to an external
* notify webhook (at-most-once, never blocks wakeup delivery).
*/
const name = "dsh-sentinel";
const inject = [
	"agents",
	"agentDefaultModel",
	"tools"
];
const DEFAULT_CONFIG = {
	locale: "en",
	heartbeatMs: 5e3,
	probeConcurrency: 8,
	maxSubscriptionsPerSession: 16,
	maxPendingWakeups: 8,
	defaultIntervalSeconds: 30,
	defaultCooldownSeconds: 60,
	dutyLeaseTtlMs: 3e4
};
const Config = Schema.object({
	locale: Schema.union(["en", "zh"]).default("en").description("Language for server-generated tool receipts, wakeups and notifications. Browser UI follows the host locale independently."),
	heartbeatMs: Schema.number().default(DEFAULT_CONFIG.heartbeatMs).description("Heartbeat interval driving all probe rounds (ms)."),
	probeConcurrency: Schema.number().default(DEFAULT_CONFIG.probeConcurrency).description("Upper bound on concurrently in-flight probes per heartbeat round."),
	maxSubscriptionsPerSession: Schema.number().default(DEFAULT_CONFIG.maxSubscriptionsPerSession).description("Active watches allowed per session."),
	maxPendingWakeups: Schema.number().default(DEFAULT_CONFIG.maxPendingWakeups).description("Queued wakeups kept per session before the oldest drop (with a warning)."),
	defaultIntervalSeconds: Schema.number().default(DEFAULT_CONFIG.defaultIntervalSeconds).description(`Probe interval used when a watch does not specify one (seconds, clamped to ${String(5)}–${String(MAX_INTERVAL_SECONDS)}).`),
	defaultCooldownSeconds: Schema.number().default(DEFAULT_CONFIG.defaultCooldownSeconds).description("Cooldown used when a watch does not specify one (seconds)."),
	dutyLeaseTtlMs: Schema.number().default(DEFAULT_CONFIG.dutyLeaseTtlMs).description("Sentinel-duty lease TTL in ms: a second dsh process stays passive while a fresh lease exists; takeover happens this long after the owner dies."),
	notifyWebhookUrl: Schema.string().description("Optional external notify webhook: every fire is POSTed there as JSON (at-most-once; failures never block wakeup delivery).")
});
const PLUGIN_ID = "dsh-sentinel";
const STATE_PATH = `/plugins/${PLUGIN_ID}/state`;
const HOOK_PATH = `/plugins/${PLUGIN_ID}/hook`;
const CANCEL_PATH = `/plugins/${PLUGIN_ID}/cancel`;
const DASHBOARD_PATH = `/plugins/${PLUGIN_ID}/dashboard`;
const PUSH_DEBOUNCE_MS = 250;
/** fsWatch arm failures back off this long before retrying (heartbeat polling covers the gap). */
const FILE_WATCH_RETRY_MS = 6e4;
/** Compact the sidecar at boot when rows exceed active subscriptions by this margin. */
const COMPACTION_MARGIN = 32;
/** Sidecar log location: `$DSH_HOME/sentinel.jsonl` (the settings-file convention). */
function storePath() {
	const home = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
	return join(home, "sentinel.jsonl");
}
/** Sentinel-duty lease location: `$DSH_HOME/sentinel.lease`. */
function leasePath() {
	const home = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
	return join(home, "sentinel.lease");
}
/**
* Browser-trust fence for this plugin's routes. The host fences its own /api
* channels against cross-site POSTs and DNS rebinding, but plugin routes live
* under /plugins/* outside that fence — and the hook route can wake a
* full-access agent. Mirror the essentials: reject browser-marked cross-site
* requests, and reject browser-marked requests whose Host/Origin authority is
* a DNS name (rebinding cannot forge Host, and IP/localhost literals cannot
* be rebound). Headerless clients (curl, CI jobs) pass untouched.
*/
function isLocalAuthority(hostname) {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
	if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
	if (h.includes(":") && /^[0-9a-f:.]+$/.test(h)) return true;
	return false;
}
function requestAllowed(req) {
	const headers = req.headers;
	if (headers === void 0) return true;
	const read = (name) => {
		const value = headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const site = read("sec-fetch-site");
	if (site === "cross-site") return false;
	const origin = read("origin");
	const host = read("host");
	if (!(site !== void 0 || origin !== void 0 && origin !== "null")) return true;
	let authority = host ?? "";
	if (origin !== void 0 && origin !== "null") {
		let parsed;
		try {
			parsed = new URL(origin);
		} catch {
			return false;
		}
		if (host !== void 0 && parsed.host.toLowerCase() !== host.toLowerCase()) return false;
		authority = parsed.host;
	}
	return isLocalAuthority(authority.replace(/:\d+$/, ""));
}
/** All sentinel state for one session; lives as long as the server, not the agent. */
var SessionWatch = class {
	sessionId;
	folded = {
		active: /* @__PURE__ */ new Map(),
		lastOrdinal: 0,
		undeliveredFires: []
	};
	rows = [];
	probes = /* @__PURE__ */ new Map();
	watchers = /* @__PURE__ */ new Map();
	/** Last fsWatch arm failure per subscription; arms back off for FILE_WATCH_RETRY_MS. */
	watchFailures = /* @__PURE__ */ new Map();
	pushTimers = /* @__PURE__ */ new Map();
	recentFires = [];
	pendingWakeups = [];
	/** Cumulative wakeups dropped by the pending-queue cap (visible, not silent). */
	droppedWakeups = 0;
	constructor(sessionId) {
		this.sessionId = sessionId;
	}
	closeSensors() {
		for (const entry of this.watchers.values()) entry.watcher.close();
		this.watchers.clear();
		for (const timer of this.pushTimers.values()) clearTimeout(timer);
		this.pushTimers.clear();
	}
};
/**
* The server-lifetime watcher runtime: owns every SessionWatch, one shared
* heartbeat, the durable sidecar log, and the wakeup channel (resuming
* dormant sessions on fire).
*/
var SentinelRuntime = class {
	ctx;
	store;
	config;
	watches = /* @__PURE__ */ new Map();
	resumes = /* @__PURE__ */ new Map();
	handles = [];
	timer;
	dutyLeasePath = leasePath();
	pendingRounds = /* @__PURE__ */ new Set();
	ready = false;
	activeDrive;
	disposed = false;
	/** This process owns probing/delivery. False while another instance's lease is fresh. */
	duty = false;
	constructor(ctx, store, config) {
		this.ctx = ctx;
		this.store = store;
		this.config = config;
	}
	start() {
		this.trackRound((async () => {
			await this.claimDuty();
			this.ready = true;
			await this.loadPersisted();
			if (this.disposed) return;
			this.timer = setInterval(() => {
				if (this.pendingRounds.size === 0) this.trackRound(this.drive());
			}, this.config.heartbeatMs);
			this.timer.unref();
		})());
	}
	/** Keep startup and heartbeat file operations owned until teardown completes. */
	trackRound(round) {
		const settled = round.finally(() => {
			this.pendingRounds.delete(settled);
		});
		this.pendingRounds.add(settled);
	}
	/**
	* Sentinel duty lease: one probing/delivering owner per DSH_HOME. A fresh
	* lease held by a live pid keeps this instance passive (tools still work,
	* writes still persist); the passive side re-checks every heartbeat and
	* takes over once the owner's lease goes stale. The claim race window is
	* one heartbeat at worst — the TTL self-heals a double claim.
	*/
	async claimDuty() {
		const lease = await this.readLease();
		if (lease !== void 0 && Date.now() - lease.at < this.config.dutyLeaseTtlMs && this.pidAlive(lease.pid)) {
			this.duty = false;
			this.warn(`another dsh process (pid ${String(lease.pid)}) owns sentinel duty; staying passive until its lease goes stale`);
			return;
		}
		try {
			await this.writeLease();
			await sleep(150);
			const reread = await this.readLease();
			this.duty = reread?.pid === process.pid;
			if (!this.duty) this.warn(`lost the sentinel-duty claim to pid ${String(reread?.pid ?? "unknown")}; staying passive`);
		} catch (error) {
			this.duty = false;
			this.warn(`sentinel-duty lease write failed: ${describe(error)}; staying passive`);
		}
	}
	async renewLease() {
		try {
			await this.writeLease();
		} catch (error) {
			this.warn(`sentinel-duty lease renewal failed: ${describe(error)}`);
		}
	}
	async readLease() {
		try {
			const parsed = JSON.parse(await readFile(this.dutyLeasePath, "utf8"));
			if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return void 0;
			return {
				pid: parsed.pid,
				at: parsed.at
			};
		} catch {
			return;
		}
	}
	async writeLease() {
		const path = this.dutyLeasePath;
		const tmp = `${path}.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify({
			pid: process.pid,
			at: Date.now()
		}), "utf8");
		await rename(tmp, path);
	}
	pidAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	}
	/** Absolute webhook URL when the web server port is known; bare path in
	* headless (no webServer), where nothing listens anyway. The session
	* qualifier disambiguates watch ids, which are allocated per session. */
	hookUrl(sessionId, id) {
		const port = this.ctx.webServer?.port;
		const path = `${HOOK_PATH}?id=${id}&s=${encodeURIComponent(sessionId)}`;
		return port === void 0 ? path : `http://localhost:${String(port)}${path}`;
	}
	async dispose() {
		this.disposed = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		for (const watch of this.watches.values()) watch.closeSensors();
		await Promise.all(this.pendingRounds);
		await this.activeDrive;
		if (this.duty) await unlink(this.dutyLeasePath).catch(() => {});
		this.watches.clear();
		for (const handle of this.handles.splice(0, this.handles.length)) await Promise.resolve().then(() => handle.dispose()).catch(() => {});
	}
	/** Boot: fold the sidecar log and arm every session that still has active watches. */
	async loadPersisted() {
		let grouped;
		try {
			grouped = await this.store.load();
		} catch (error) {
			this.warn(`sidecar log load failed: ${describe(error)}`);
			return;
		}
		if (this.disposed) return;
		let totalRows = 0;
		for (const [sessionId, rows] of grouped) {
			totalRows += rows.length;
			const watch = this.watchOf(sessionId);
			watch.rows = rows;
			this.refold(watch);
			this.requeueUndelivered(watch);
			if (watch.folded.active.size === 0 && watch.pendingWakeups.length === 0) {
				watch.closeSensors();
				this.watches.delete(sessionId);
			}
		}
		this.compact(totalRows);
		await this.drive();
	}
	/** Crash-window recovery: fires logged after the latest delivered watermark
	* requeue now (oldest first, capped like any batch) so a crash between
	* logging and delivering cannot lose the wakeup. */
	requeueUndelivered(watch) {
		const pending = watch.folded.undeliveredFires;
		if (pending.length === 0) return;
		const capped = pending.slice(-this.config.maxPendingWakeups);
		watch.pendingWakeups.push(...capped.map((entry) => renderWakeup(entry.sub, entry.fact, this.config.locale ?? "en")));
		const dropped = pending.length - capped.length;
		if (dropped > 0) {
			watch.droppedWakeups += dropped;
			this.warn(`requeue for "${watch.sessionId}": dropped ${String(dropped)} oldest undelivered wakeup(s) over the cap`);
		}
		this.warn(`requeued ${String(pending.length)} undelivered wakeup(s) for "${watch.sessionId}"`);
	}
	/**
	* Adopt rows another process appended: with the duty lease, a passive
	* instance still serves tools and writes the shared sidecar, so the duty
	* owner re-reads the log each heartbeat and folds anything past its
	* in-memory picture. The file only ever grows past our rows (our own
	* appends push rows first), so a length comparison is the adoption test.
	*/
	async syncFromStore() {
		let grouped;
		try {
			grouped = await this.store.load();
		} catch {
			return;
		}
		if (this.disposed) return;
		for (const [sessionId, rows] of grouped) {
			const watch = this.watchOf(sessionId);
			if (rows.length <= watch.rows.length) continue;
			watch.rows = rows;
			this.refold(watch);
			this.requeueUndelivered(watch);
		}
	}
	/**
	* Rewrite a history-heavy sidecar as one 'compacted' row per active
	* subscription (fire budget and last observation intact). Fire-and-forget:
	* later appends ride the store chain, so they land after the rewrite.
	*/
	compact(totalRows) {
		let activeCount = 0;
		for (const watch of this.watches.values()) {
			activeCount += watch.folded.active.size;
			if (watch.folded.undeliveredFires.length > 0) return;
		}
		if (totalRows <= activeCount * 4 + COMPACTION_MARGIN) return;
		const lines = [];
		for (const watch of this.watches.values()) for (const sub of watch.folded.active.values()) lines.push(JSON.stringify({
			v: 1,
			sessionId: watch.sessionId,
			change: {
				version: 1,
				change: "compacted",
				subscription: sub
			}
		}));
		this.store.replaceAll(lines).then(() => {
			this.warn(`sidecar compacted: ${String(totalRows)} rows -> ${String(lines.length)}`);
			for (const watch of this.watches.values()) {
				watch.rows = [...watch.folded.active.values()].map((sub) => ({
					type: SENTINEL_CHANGE_TYPE,
					payload: {
						version: 1,
						change: "compacted",
						subscription: sub
					}
				}));
				this.refold(watch);
			}
		}, (error) => {
			this.warn(`sidecar compaction failed (will retry next boot): ${describe(error)}`);
		});
	}
	/** The session's watch bucket, created on demand. */
	watchOf(sessionId) {
		let watch = this.watches.get(sessionId);
		if (watch === void 0) {
			watch = new SessionWatch(sessionId);
			this.watches.set(sessionId, watch);
		}
		return watch;
	}
	/** All watches, for the state route. */
	view() {
		return this.watches;
	}
	/** Duty-lease liveness for the transparency routes: who owns duty and how fresh its heartbeat is. */
	async dutyStatus() {
		const lease = await this.readLease();
		if (lease === void 0) return void 0;
		const ageMs = Date.now() - lease.at;
		return {
			pid: lease.pid,
			at: lease.at,
			ageMs,
			stale: ageMs >= this.config.dutyLeaseTtlMs || !this.pidAlive(lease.pid)
		};
	}
	/** Resolve the session for an inbound webhook push. Watch ids are only
	* unique per session, so the URL's session qualifier decides; URLs baked
	* into external systems before the qualifier existed fall back to the
	* first matching webhook watch. */
	resolveWebhookTarget(sessionId, id) {
		if (sessionId !== null && sessionId !== "") {
			const watch = this.watches.get(sessionId);
			return watch !== void 0 && watch.folded.active.has(id) ? watch : void 0;
		}
		for (const watch of this.watches.values()) {
			const sub = watch.folded.active.get(id);
			if (sub !== void 0 && sub.spec.kind === "webhook") return watch;
		}
	}
	warn(message) {
		this.ctx.logger.warn(`${PLUGIN_ID}: ${message}`);
	}
	/** Durably append one change, then refold that session's picture. */
	async commit(watch, change) {
		await this.store.append(watch.sessionId, change);
		watch.rows.push({
			type: SENTINEL_CHANGE_TYPE,
			payload: change
		});
		this.refold(watch);
	}
	refold(watch) {
		try {
			watch.folded = foldSentinelEvents(watch.rows);
		} catch (error) {
			this.warn(`fold failed for session "${watch.sessionId}": ${describe(error)}`);
			watch.folded = {
				active: /* @__PURE__ */ new Map(),
				lastOrdinal: 0,
				undeliveredFires: []
			};
		}
		for (const id of [...watch.probes.keys()]) if (!watch.folded.active.has(id)) watch.probes.delete(id);
		for (const id of [...watch.watchFailures.keys()]) if (!watch.folded.active.has(id)) watch.watchFailures.delete(id);
		for (const [id, entry] of [...watch.watchers]) if (!watch.folded.active.has(id)) {
			entry.watcher.close();
			watch.watchers.delete(id);
		}
		for (const sub of watch.folded.active.values()) {
			if (!watch.probes.has(sub.id)) watch.probes.set(sub.id, {
				nextDueAt: Date.now(),
				probing: false,
				...sub.lastKnown !== void 0 ? {
					lastSnapshot: sub.lastKnown.snapshot,
					lastState: sub.lastKnown.state
				} : {}
			});
			if (sub.spec.kind === "file") this.armFileWatch(watch, sub.id, sub.spec.target);
			if (sub.spec.kind === "webhook") {
				const state = watch.probes.get(sub.id);
				if (state !== void 0 && state.lastState === void 0) state.lastState = "awaiting push";
			}
		}
	}
	/**
	* The session's live agent, resuming it when dormant. Concurrent callers
	* share one resume (the api-remotes agent-lookup dedupe pattern).
	*/
	async ensureAgent(sessionId) {
		const live = this.ctx.agents.get(sessionId);
		if (live !== void 0) return live;
		let pending = this.resumes.get(sessionId);
		if (pending === void 0) {
			pending = (async () => {
				try {
					const selection = this.ctx.agentDefaultModel.currentSelection();
					const handle = await this.ctx.agents.resume({
						resumeSessionId: sessionId,
						agentOptions: { ...selection },
						setup: async (agentCtx, agent) => {
							const presets = this.ctx.get?.("agentPresets");
							if (presets === void 0) return;
							const projections = this.ctx.get?.("sessionProjections");
							if (projections === void 0) throw new Error("dsh-sentinel: agentPresets requires sessionProjections to restore the saved preset");
							const presetId = projections.stateOf(agent.session, "agentPreset") ?? void 0;
							await presets.mount(agentCtx, presetId);
						}
					});
					this.handles.push(handle);
					return handle.agent;
				} finally {
					this.resumes.delete(sessionId);
				}
			})();
			this.resumes.set(sessionId, pending);
		}
		return pending;
	}
	async create(sessionId, spec, note, maxFires, cooldownSeconds, expiresInSeconds) {
		const normalized = normalizeSpec(spec);
		const watch = this.watchOf(sessionId);
		if (watch.folded.active.size >= this.config.maxSubscriptionsPerSession) throw new SentinelLogError(`subscription limit reached (${String(this.config.maxSubscriptionsPerSession)}); cancel one first`);
		const id = allocateWatchId(watch.folded);
		const createdAt = (/* @__PURE__ */ new Date()).toISOString();
		const subscription = {
			id,
			spec: normalized,
			note,
			maxFires,
			cooldownSeconds,
			...expiresInSeconds !== void 0 ? { expiresAt: new Date(Date.now() + expiresInSeconds * 1e3).toISOString() } : {},
			createdAt
		};
		await this.commit(watch, {
			version: 1,
			change: "created",
			subscription
		});
		this.drive();
		return {
			...subscription,
			fireCount: 0
		};
	}
	/** Cancel durably — a sidecar write, no session involvement. */
	async cancel(sessionId, id, reason) {
		const watch = this.watches.get(sessionId);
		if (watch === void 0 || !watch.folded.active.has(id)) return false;
		await this.commit(watch, {
			version: 1,
			change: "cancelled",
			id,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			reason
		});
		return true;
	}
	/**
	* One heartbeat round: collect every due probe (and expiry cancel) across all
	* sessions, then run them in bounded-concurrency batches. The `probing` flag
	* keeps a re-entered round (push probe, create, previous round still in
	* flight) from double-probing the same subscription; deliveries flush once
	* after the batches settle.
	*/
	async drive() {
		if (this.disposed || !this.ready) return;
		if (this.activeDrive !== void 0) return this.activeDrive;
		const round = this.driveRound();
		this.activeDrive = round;
		try {
			await round;
		} finally {
			this.activeDrive = void 0;
		}
	}
	async driveRound() {
		if (this.disposed) return;
		if (this.duty) await this.renewLease();
		else {
			await this.claimDuty();
			if (!this.duty) return;
		}
		await this.syncFromStore();
		const tasks = [];
		const now = Date.now();
		for (const watch of [...this.watches.values()]) for (const sub of [...watch.folded.active.values()]) {
			if (sub.expiresAt !== void 0 && Date.parse(sub.expiresAt) <= now) {
				tasks.push(async () => {
					try {
						await this.cancel(watch.sessionId, sub.id, "expired");
					} catch (error) {
						this.warn(`expiry cancel failed for ${sub.id}: ${describe(error)}`);
					}
				});
				continue;
			}
			if (sub.spec.kind === "webhook") continue;
			const state = watch.probes.get(sub.id);
			if (state === void 0 || state.probing || state.nextDueAt > now) continue;
			if (sub.lastFiredAt !== void 0 && now - Date.parse(sub.lastFiredAt) < sub.cooldownSeconds * 1e3) continue;
			state.probing = true;
			tasks.push(async () => {
				try {
					await this.probeOne(watch, sub, state);
				} finally {
					state.probing = false;
					state.lastProbeAt = Date.now();
					state.nextDueAt = Date.now() + sub.spec.intervalSeconds * 1e3;
				}
			});
		}
		for (let index = 0; index < tasks.length; index += this.config.probeConcurrency) await Promise.allSettled(tasks.slice(index, index + this.config.probeConcurrency).map((task) => task()));
		if (this.disposed) return;
		for (const watch of [...this.watches.values()]) this.flushWakeups(watch);
	}
	/**
	* Push channel for file watches: inotify on the file itself, or on its
	* parent directory while the file does not exist yet. Watch events only
	* accelerate the probe — the fire decision still runs through the same
	* snapshot diff, so duplicate or spurious events cannot double-fire.
	*/
	armFileWatch(watch$1, id, target) {
		if (watch$1.watchers.has(id) || this.disposed) return;
		const failedAt = watch$1.watchFailures.get(id);
		if (failedAt !== void 0 && Date.now() - failedAt < FILE_WATCH_RETRY_MS) return;
		const arm = (path, mode) => {
			try {
				const watcher = watch(path, { persistent: false }, (_event, fileName) => {
					if (mode === "parent" && fileName !== null && fileName !== basename(target)) return;
					this.schedulePushProbe(watch$1, id);
				});
				watcher.on("error", () => {
					watcher.close();
					watch$1.watchers.delete(id);
					watch$1.watchFailures.set(id, Date.now());
				});
				watch$1.watchers.set(id, {
					watcher,
					mode
				});
				watch$1.watchFailures.delete(id);
			} catch {
				watch$1.watchFailures.set(id, Date.now());
			}
		};
		stat(target).then(() => {
			arm(target, "direct");
		}, () => {
			arm(dirname(target), "parent");
		});
	}
	/** Debounced fast-path probe for one subscription (bursty fs events collapse to one). */
	schedulePushProbe(watch, id) {
		if (this.disposed) return;
		const existing = watch.pushTimers.get(id);
		if (existing !== void 0) clearTimeout(existing);
		watch.pushTimers.set(id, setTimeout(() => {
			watch.pushTimers.delete(id);
			const state = watch.probes.get(id);
			if (state !== void 0) state.nextDueAt = 0;
			this.drive().then(() => {
				const entry = watch.watchers.get(id);
				const sub = watch.folded.active.get(id);
				if (entry?.mode === "parent" && sub !== void 0) stat(sub.spec.target).then(() => {
					entry.watcher.close();
					watch.watchers.delete(id);
					this.armFileWatch(watch, id, sub.spec.target);
				}, () => {});
			});
		}, PUSH_DEBOUNCE_MS));
	}
	/**
	* External push entry: fire the webhook subscription with the posted
	* payload, honoring pattern and cooldown exactly like a probe transition.
	*/
	async handleWebhook(watch, id, payload) {
		const sub = watch.folded.active.get(id);
		if (sub === void 0 || sub.spec.kind !== "webhook") return {
			status: 404,
			body: {
				fired: false,
				reason: "no such webhook watch"
			}
		};
		if (sub.spec.pattern !== void 0 && !new RegExp(sub.spec.pattern, "m").test(payload)) return {
			status: 202,
			body: {
				fired: false,
				reason: "payload does not match pattern"
			}
		};
		if (sub.lastFiredAt !== void 0 && Date.now() - Date.parse(sub.lastFiredAt) < sub.cooldownSeconds * 1e3) return {
			status: 202,
			body: {
				fired: false,
				reason: "cooldown"
			}
		};
		try {
			await this.fireSubscription(watch, sub, {
				fireNumber: sub.fireCount + 1,
				summary: formatFireSummary({
					summary: "",
					trigger: { kind: "webhook" }
				}, this.config.locale ?? "en"),
				trigger: { kind: "webhook" },
				before: "",
				after: clipExcerpt(payload === "" ? "<empty payload>" : payload),
				probeMs: 0
			});
		} catch (error) {
			this.warn(`webhook fire failed for ${id}: ${describe(error)}`);
			return {
				status: 503,
				body: {
					fired: false,
					reason: "delivery failed, retry"
				}
			};
		}
		this.deliver(watch);
		return {
			status: 200,
			body: {
				fired: true,
				id
			}
		};
	}
	/** The single durable fire path: log the change, remember it, queue the wakeup. */
	async fireSubscription(watch, sub, fact, observed) {
		const at = (/* @__PURE__ */ new Date()).toISOString();
		await this.commit(watch, {
			version: 1,
			change: "fired",
			id: sub.id,
			at,
			fact,
			...observed !== void 0 ? { observed } : {}
		});
		watch.recentFires.unshift({
			id: sub.id,
			at,
			summary: fact.summary,
			trigger: fact.trigger,
			state: fact.state,
			note: sub.note,
			before: fact.before,
			after: fact.after
		});
		if (watch.recentFires.length > 20) watch.recentFires.pop();
		this.notifyFire(watch, sub, fact);
		if (!this.duty) return;
		watch.pendingWakeups.push(renderWakeup(sub, fact, this.config.locale ?? "en"));
		if (watch.pendingWakeups.length > this.config.maxPendingWakeups) {
			const dropped = watch.pendingWakeups.length - this.config.maxPendingWakeups;
			watch.pendingWakeups.splice(0, dropped);
			watch.droppedWakeups += dropped;
			this.warn(`pending wakeup overflow for "${watch.sessionId}": dropped ${String(dropped)} oldest (agent busy?)`);
		}
	}
	/** Fan one fire out to the optional external notify webhook. At-most-once:
	* a failed POST warns and never blocks the wakeup pipeline. */
	async notifyFire(watch, sub, fact) {
		const url = this.config.notifyWebhookUrl;
		if (url === void 0 || url === "") return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, 5e3);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					plugin: PLUGIN_ID,
					event: "fired",
					sessionId: watch.sessionId,
					id: sub.id,
					kind: sub.spec.kind,
					target: sub.spec.target,
					note: sub.note,
					fireNumber: fact.fireNumber,
					maxFires: sub.maxFires,
					summary: formatFireSummary(fact, this.config.locale ?? "en"),
					trigger: fact.trigger,
					state: fact.state,
					after: fact.after
				})
			});
			if (!response.ok) this.warn(`notify webhook returned HTTP ${String(response.status)}`);
		} catch (error) {
			this.warn(`notify webhook failed: ${describe(error)}`);
		} finally {
			clearTimeout(timer);
		}
	}
	async probeOne(watch, sub, state) {
		const startedAt = performance.now();
		const result = await probe(sub.spec);
		if (this.disposed || !watch.folded.active.has(sub.id)) return;
		const decision = shouldFire(sub.spec.pattern, state.lastSnapshot, result.snapshot);
		const previousSnapshot = state.lastSnapshot;
		state.lastSnapshot = result.snapshot;
		state.lastState = result.state;
		if (!decision.fire) {
			if (previousSnapshot === void 0 && sub.lastKnown === void 0) try {
				await this.commit(watch, {
					version: 1,
					change: "baseline",
					id: sub.id,
					at: (/* @__PURE__ */ new Date()).toISOString(),
					observed: {
						state: result.state,
						snapshot: result.snapshot
					}
				});
			} catch (error) {
				this.warn(`baseline write failed for ${sub.id}: ${describe(error)}`);
			}
			return;
		}
		try {
			await this.fireSubscription(watch, sub, {
				fireNumber: sub.fireCount + 1,
				summary: formatFireSummary({
					summary: decision.summary,
					trigger: decision.trigger,
					state: result.state
				}, this.config.locale ?? "en"),
				trigger: decision.trigger,
				state: result.state,
				before: clipExcerpt(previousSnapshot ?? ""),
				after: clipExcerpt(result.snapshot),
				probeMs: performance.now() - startedAt
			}, {
				state: result.state,
				snapshot: result.snapshot
			});
		} catch (error) {
			state.lastSnapshot = previousSnapshot;
			this.warn(`fire failed for ${sub.id} (will retry): ${describe(error)}`);
		}
	}
	/**
	* Deliver queued wakeups. A live idle agent gets them immediately; a
	* dormant session is resumed first — that resurrection is the plugin's
	* whole reason to exist.
	*/
	async deliver(watch) {
		if (!this.duty || watch.pendingWakeups.length === 0) return;
		let agent;
		try {
			agent = await this.ensureAgent(watch.sessionId);
		} catch (error) {
			this.warn(`could not resume session "${watch.sessionId}" for wakeup (will retry): ${describe(error)}`);
			return;
		}
		if (agent.status !== "idle" || watch.pendingWakeups.length === 0) return;
		const batch = watch.pendingWakeups.splice(0, watch.pendingWakeups.length);
		try {
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: batch.join("\n\n---\n\n")
				}],
				source: { kind: "sentinel" }
			}));
		} catch (error) {
			this.warn(`wakeup delivery failed for session "${watch.sessionId}": ${describe(error)}`);
			watch.pendingWakeups.unshift(...batch);
			return;
		}
		try {
			await this.commit(watch, {
				version: 1,
				change: "delivered",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch (error) {
			this.warn(`delivered watermark write failed for "${watch.sessionId}": ${describe(error)}`);
		}
	}
	/** Idle-edge and heartbeat entry: fire-and-forget delivery. */
	flushWakeups(watch) {
		if (watch.pendingWakeups.length === 0) return;
		this.deliver(watch);
	}
};
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
const WATCH_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		kind: {
			type: "string",
			required: true
		},
		target: {
			type: "string",
			required: true
		},
		intervalSeconds: {
			type: "integer",
			required: true
		},
		maxFires: {
			type: "integer",
			required: true
		},
		note: {
			type: "string",
			required: true
		},
		hookPath: { type: "string" }
	}
};
const LIST_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { subscriptions: {
		type: "array",
		required: true,
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				id: {
					type: "string",
					required: true
				},
				kind: {
					type: "string",
					required: true
				},
				target: {
					type: "string",
					required: true
				},
				pattern: { type: "string" },
				intervalSeconds: {
					type: "integer",
					required: true
				},
				fireCount: {
					type: "integer",
					required: true
				},
				maxFires: {
					type: "integer",
					required: true
				},
				note: {
					type: "string",
					required: true
				},
				lastState: { type: "string" }
			}
		}
	} }
};
const CANCEL_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		cancelled: {
			type: "boolean",
			required: true
		},
		id: {
			type: "string",
			required: true
		}
	}
};
function textBlock(text) {
	return [{
		type: "text",
		text
	}];
}
function registerSentinelTools(runtime, toolCtx, agent) {
	const disposers = [];
	const locale = runtime.config.locale ?? "en";
	disposers.push(toolCtx.tools.register(defineTool({
		name: "sentinel_watch",
		description: [
			"Register a durable condition watch. The sentinel watches on the server side — even while this session",
			" is closed or the agent is asleep — and wakes you with a structured report when the condition",
			" transitions (a dormant session is resumed automatically), so do NOT poll or sleep for it yourself.",
			" Watches survive process restarts. Probing and fire delivery happen in a long-running dsh process:",
			" if this run is one-shot (headless), the watch is still persisted, but tell the user it only becomes",
			" active once a resident process (e.g. \"dsh web\") is running. Kinds: \"file\" (path snapshot; inotify push, reacts in under a",
			" second), \"command\" (read-only shell line probed on an interval; fires on output/exit change),",
			" \"http\" (URL status+body probed on an interval), \"process\" (pgrep pattern probed on an interval),",
			" \"port\" (TCP connect to \"[host:]port\" probed on an interval; fires on open/closed changes —",
			" good for \"database is up\", \"dev server died\"),",
			" \"webhook\" (pure push: returns a hook URL, any external system can POST to it to wake you —",
			" put a curl into a CI job, git hook, or another machine's script). With \"pattern\", probe kinds fire",
			" on the no-match→match edge of that regex and webhooks fire only when the payload matches;",
			" without it, probe kinds fire on any snapshot change after the baseline and webhooks fire on any POST."
		].join(""),
		parameters: {
			kind: {
				type: "string",
				required: true,
				enum: [
					"file",
					"command",
					"http",
					"process",
					"port",
					"webhook"
				],
				description: "Sensor engine: probing (file/command/http/process/port) or pure push (webhook)."
			},
			target: {
				type: "string",
				required: true,
				description: "file: absolute path; command: read-only shell line; http: URL; process: pgrep -f pattern; port: \"[host:]port\"; webhook: short label naming the expected caller."
			},
			pattern: {
				type: "string",
				description: "Optional regex in JavaScript RegExp syntax (compiled with the m flag; RE2 inline flags like (?s) are invalid — write [\\s\\S]+ instead). Probe kinds fire on its no-match→match transition over real probe content; placeholder states (missing file, unreachable URL, no matching process) never match. Webhooks only accept payloads it matches."
			},
			interval_seconds: {
				type: "number",
				description: `Probe interval in seconds (${String(5)}–${String(MAX_INTERVAL_SECONDS)}, default 30; ignored for webhook and accelerated by push for file).`
			},
			note: {
				type: "string",
				required: true,
				description: "Message to your future self: why this watch exists and what to do when it fires. Delivered verbatim with every wakeup."
			},
			max_fires: {
				type: "number",
				description: "Auto-cancel after this many fires (default 1: one-shot)."
			},
			cooldown_seconds: {
				type: "number",
				description: "Silence window after each fire (default 60)."
			},
			expires_in_seconds: {
				type: "number",
				description: "Optional lifetime; the watch cancels itself when this elapses without firing."
			}
		},
		output: {
			schema: WATCH_OUTPUT_SCHEMA,
			render: (_args, value) => textBlock(translate(locale, "registered", {
				id: value.id,
				kind: value.kind,
				target: value.target
			}) + (value.hookPath !== void 0 ? "\n" + translate(locale, "hookAddress", { url: value.hookPath }) + (value.hookPath.startsWith("http") ? translate(locale, "hookHost") : "") + translate(locale, "hookResident") : translate(locale, "probeCadence", {
				interval: value.intervalSeconds,
				filePush: value.kind === "file" ? translate(locale, "filePush") : ""
			})))
		},
		async execute(args) {
			const note = args.note.trim();
			if (note === "") throw new SentinelLogError("note must not be empty — tell your future self why this watch exists");
			if (note.length > 2e3) throw new SentinelLogError(`note too long (${String(note.length)} > ${String(MAX_NOTE_LENGTH)})`);
			const maxFires = args.max_fires !== void 0 ? Math.max(1, Math.round(args.max_fires)) : 1;
			const cooldown = args.cooldown_seconds !== void 0 ? Math.max(0, Math.round(args.cooldown_seconds)) : runtime.config.defaultCooldownSeconds;
			const expires = args.expires_in_seconds !== void 0 ? Math.max(runtime.config.heartbeatMs / 1e3, Math.round(args.expires_in_seconds)) : void 0;
			const subscription = await runtime.create(agent.id, {
				kind: args.kind,
				target: args.target,
				...args.pattern !== void 0 ? { pattern: args.pattern } : {},
				intervalSeconds: args.interval_seconds ?? runtime.config.defaultIntervalSeconds
			}, note, maxFires, cooldown, expires);
			return {
				id: subscription.id,
				kind: subscription.spec.kind,
				target: subscription.spec.target,
				intervalSeconds: subscription.spec.intervalSeconds,
				maxFires: subscription.maxFires,
				note: subscription.note,
				...subscription.spec.kind === "webhook" ? { hookPath: runtime.hookUrl(agent.id, subscription.id) } : {}
			};
		}
	})));
	disposers.push(toolCtx.tools.register(defineTool({
		name: "sentinel_list",
		description: "List this session's active sentinel watches with their live probe state.",
		parameters: {},
		output: {
			schema: LIST_OUTPUT_SCHEMA,
			render: (_args, value) => textBlock(value.subscriptions.length === 0 ? translate(locale, "noWatches") : value.subscriptions.map((row) => translate(locale, "listRow", {
				id: row.id,
				kind: row.kind,
				target: row.target,
				state: row.lastState === void 0 ? translate(locale, "notProbed") : localizeState$1(row.lastState, locale),
				count: row.fireCount,
				max: row.maxFires
			})).join("\n"))
		},
		async execute() {
			const watch = runtime.watchOf(agent.id);
			return { subscriptions: [...watch.folded.active.values()].map((sub) => ({
				id: sub.id,
				kind: sub.spec.kind,
				target: sub.spec.target,
				...sub.spec.pattern !== void 0 ? { pattern: sub.spec.pattern } : {},
				intervalSeconds: sub.spec.intervalSeconds,
				fireCount: sub.fireCount,
				maxFires: sub.maxFires,
				note: sub.note,
				...watch.probes.get(sub.id)?.lastState !== void 0 ? { lastState: watch.probes.get(sub.id)?.lastState } : {}
			})) };
		}
	})));
	disposers.push(toolCtx.tools.register(defineTool({
		name: "sentinel_cancel",
		description: "Cancel one sentinel watch by id.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "The watch id (e.g. \"watch-3\")."
		} },
		output: {
			schema: CANCEL_OUTPUT_SCHEMA,
			render: (_args, value) => textBlock(translate(locale, value.cancelled ? "cancelled" : "notFound", { id: value.id }))
		},
		async execute(args) {
			return {
				cancelled: await runtime.cancel(agent.id, args.id, "agent"),
				id: args.id
			};
		}
	})));
	return disposers;
}
/**
* Flatten the runtime's active subscriptions into wire rows.
* @param runtime - the server-lifetime sentinel runtime.
* @param ctx - host surface (agent liveness lookup).
* @param sessionId - empty for every session, or one session id to filter.
* @returns the watch rows (fires stay with the state route's own collection).
*/
function collectWatchRows(runtime, ctx, sessionId) {
	const rows = [];
	for (const [id, watch] of runtime.view()) {
		if (sessionId !== "" && id !== sessionId) continue;
		const live = ctx.agents.get(id) !== void 0;
		for (const sub of watch.folded.active.values()) {
			const probeState = watch.probes.get(sub.id);
			rows.push({
				sessionId: id,
				live,
				id: sub.id,
				kind: sub.spec.kind,
				target: sub.spec.target,
				pattern: sub.spec.pattern,
				intervalSeconds: sub.spec.intervalSeconds,
				note: sub.note,
				fireCount: sub.fireCount,
				maxFires: sub.maxFires,
				createdAt: sub.createdAt,
				expiresAt: sub.expiresAt,
				lastState: probeState?.lastState,
				lastProbeAt: probeState?.lastProbeAt,
				nextDueAt: probeState?.nextDueAt,
				pendingWakeups: watch.pendingWakeups.length
			});
		}
	}
	return rows;
}
/**
* HTTP surface: state JSON (dock / branch / tab poll it), dashboard table,
* webhook push. Mounted only when the host publishes webServer; headless
* profiles run the runtime and tools without it.
*/
function registerRoutes(runtime, ctx, webServer) {
	const stopRoute = webServer.register({
		kind: "exact",
		path: STATE_PATH,
		handler: async (req, res) => {
			try {
				if (!requestAllowed(req)) {
					res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "forbidden" }));
					return;
				}
				const sessionId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId") ?? "";
				const rows = collectWatchRows(runtime, ctx, sessionId);
				const fires = [];
				const dropped = {};
				for (const [id, watch] of runtime.view()) {
					if (sessionId !== "" && id !== sessionId) continue;
					fires.push(...watch.recentFires.map((fire) => ({
						sessionId: id,
						...fire
					})));
					if (watch.droppedWakeups > 0) dropped[id] = watch.droppedWakeups;
				}
				const duty = await runtime.dutyStatus();
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					watches: rows,
					recentFires: fires,
					droppedWakeups: dropped,
					duty
				}));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: describe(error) }));
			}
		}
	});
	const stopDashboard = webServer.register({
		kind: "exact",
		path: DASHBOARD_PATH,
		handler: (req, res) => {
			try {
				if (!requestAllowed(req)) {
					res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
					res.end("forbidden");
					return;
				}
				const rows = collectWatchRows(runtime, ctx, "");
				const fires = [];
				const dropped = {};
				for (const [id, watch] of runtime.view()) {
					fires.push(...watch.recentFires.map((fire) => ({
						sessionId: id,
						...fire
					})));
					if (watch.droppedWakeups > 0) dropped[id] = watch.droppedWakeups;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				const language = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("lang");
				const accept = req.headers?.["accept-language"];
				const locale = language !== null ? resolveLocale(language) : negotiateLocale(Array.isArray(accept) ? accept.join(",") : accept, runtime.config.locale ?? "en");
				res.end(dashboardHtml(rows, fires, dropped, locale));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(describe(error));
			}
		}
	});
	const stopAssets = dashboardAssets.map((asset) => webServer.register({
		kind: "exact",
		path: asset.path,
		handler: async (req, res) => {
			const method = req.method ?? "GET";
			if (!requestAllowed(req)) {
				res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				res.end(method === "HEAD" ? "" : "forbidden");
				return;
			}
			if (method !== "GET" && method !== "HEAD") {
				res.writeHead(405, {
					"content-type": "text/plain; charset=utf-8",
					allow: "GET, HEAD"
				});
				res.end("GET or HEAD only");
				return;
			}
			try {
				const body = await readFile(asset.file, "utf8");
				res.writeHead(200, {
					"content-type": asset.contentType,
					"x-content-type-options": "nosniff",
					"cache-control": "no-cache"
				});
				res.end(method === "HEAD" ? "" : body);
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(method === "HEAD" ? "" : describe(error));
			}
		}
	}));
	const stopHook = webServer.register({
		kind: "exact",
		path: HOOK_PATH,
		handler: (req, res) => {
			const respond = (status, body) => {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			if (!requestAllowed(req)) {
				respond(403, {
					fired: false,
					reason: "forbidden"
				});
				return;
			}
			if ((req.method ?? "GET") !== "POST") {
				respond(405, {
					fired: false,
					reason: "POST only"
				});
				return;
			}
			const url = new URL(req.url ?? "/", "http://dsh.internal");
			const id = url.searchParams.get("id") ?? "";
			let payload = "";
			req.on("data", (chunk) => {
				if (payload.length < 65536) payload += String(chunk);
			});
			req.on("end", () => {
				const watch = runtime.resolveWebhookTarget(url.searchParams.get("s"), id);
				if (watch === void 0) {
					respond(404, {
						fired: false,
						reason: "no such webhook watch"
					});
					return;
				}
				runtime.handleWebhook(watch, id, payload).then((outcome) => {
					respond(outcome.status, outcome.body);
				}, (error) => {
					respond(500, {
						fired: false,
						reason: describe(error)
					});
				});
			});
		}
	});
	const stopCancel = webServer.register({
		kind: "exact",
		path: CANCEL_PATH,
		handler: (req, res) => {
			const respond = (status, body) => {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			if (!requestAllowed(req)) {
				respond(403, {
					cancelled: false,
					reason: "forbidden"
				});
				return;
			}
			if ((req.method ?? "GET") !== "POST") {
				respond(405, {
					cancelled: false,
					reason: "POST only"
				});
				return;
			}
			const url = new URL(req.url ?? "/", "http://dsh.internal");
			const sessionId = url.searchParams.get("sessionId") ?? "";
			const id = url.searchParams.get("id") ?? "";
			if (sessionId === "" || id === "") {
				respond(400, {
					cancelled: false,
					reason: "sessionId and id are required"
				});
				return;
			}
			runtime.cancel(sessionId, id, "user").then((ok) => respond(ok ? 200 : 404, ok ? {
				cancelled: true,
				sessionId,
				id
			} : {
				cancelled: false,
				reason: "no such watch"
			}), (error) => respond(500, {
				cancelled: false,
				reason: describe(error)
			}));
		}
	});
	return () => {
		stopRoute();
		stopDashboard();
		for (const stopAsset of stopAssets) stopAsset();
		stopHook();
		stopCancel();
	};
}
function apply(ctx, config = DEFAULT_CONFIG) {
	ctx.effect(() => {
		const runtime = new SentinelRuntime(ctx, new SentinelStore(storePath()), config);
		let stopping = false;
		const stopRoutes = ctx.inject(["webServer"], (sctx) => {
			sctx.effect(() => {
				const webServer = sctx.webServer;
				return webServer === void 0 ? () => {} : registerRoutes(runtime, ctx, webServer);
			}, `${PLUGIN_ID}.routes()`);
		});
		const attached = /* @__PURE__ */ new WeakSet();
		const stopCreated = ctx.on("agent/created", (...args) => {
			const { agent } = args[0];
			if (stopping || attached.has(agent) || !ctx.agents.roots().includes(agent)) return;
			attached.add(agent);
			const watch = runtime.watchOf(agent.id);
			agent.ctx.effect(() => {
				const disposers = registerSentinelTools(runtime, agent.ctx, agent);
				const stopStatus = agent.ctx.on("agent/status", (...statusArgs) => {
					const { status } = statusArgs[0];
					if (status === "idle") runtime.flushWakeups(watch);
				});
				return () => {
					stopStatus();
					for (const dispose of disposers) dispose();
				};
			}, `${PLUGIN_ID}.channel()`);
		});
		runtime.start();
		return async () => {
			stopping = true;
			if (typeof stopRoutes === "function") stopRoutes();
			stopCreated();
			await runtime.dispose();
		};
	}, `${PLUGIN_ID}.lifecycle()`);
}
//#endregion
export { CANCEL_PATH, Config, DASHBOARD_ICON_PATH, DASHBOARD_PATH, DASHBOARD_SCRIPT_PATH, DASHBOARD_STYLE_PATH, DEFAULT_CONFIG, HOOK_PATH, STATE_PATH, apply, dashboardHtml, inject, leasePath, localizeState, name, storePath };
