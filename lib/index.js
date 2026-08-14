import { watch } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { exec, execFile } from "node:child_process";
import { connect } from "node:net";
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
		const observed = value["observed"];
		return {
			version: 1,
			change: "fired",
			id,
			at,
			fact,
			...observed !== void 0 ? { observed: decodeObserved(observed) } : {}
		};
	}
	if (change === "cancelled") {
		const id = value["id"];
		const at = value["at"];
		const reason = value["reason"];
		if (typeof id !== "string" || typeof at !== "string" || reason !== "agent" && reason !== "expired" && reason !== "exhausted") throw new SentinelLogError("cancelled change must carry id, at, and a known reason");
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
function renderWakeup(sub, fact) {
	return [
		`[dsh-sentinel] 订阅 ${sub.id} 触发（第 ${String(fact.fireNumber)}/${String(sub.maxFires)} 次）`,
		`监控对象: ${sub.spec.kind} · ${sub.spec.target}`,
		sub.spec.pattern !== void 0 ? `匹配模式: /${sub.spec.pattern}/` : void 0,
		`变化: ${fact.summary}`,
		fact.before !== "" ? `之前:\n${fact.before}` : void 0,
		`现在:\n${fact.after}`,
		"",
		`你注册时留给自己的便签:\n${sub.note}`,
		"",
		fact.fireNumber >= sub.maxFires ? "这是最后一次触发，该订阅已自动结束。" : `剩余 ${String(sub.maxFires - fact.fireNumber)} 次触发额度；如果不再需要，用 sentinel_cancel 工具取消（id: "${sub.id}"）。`
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
			snapshot: "<absent>",
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
			snapshot: "<unreachable>",
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
					snapshot: "<none>",
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
			snapshot: "<push-only>",
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
* - Without a pattern: fire on any snapshot change after the baseline.
*/
function shouldFire(pattern, previous, current) {
	if (pattern !== void 0) {
		const regex = new RegExp(pattern, "m");
		const was = previous !== void 0 && regex.test(previous);
		const is = regex.test(current);
		if (!was && is) return {
			fire: true,
			summary: `模式 /${pattern}/ 开始匹配: ${regex.exec(current)?.[0] ?? ""}`
		};
		return {
			fire: false,
			summary: ""
		};
	}
	if (previous === void 0) return {
		fire: false,
		summary: ""
	};
	if (previous !== current) return {
		fire: true,
		summary: "快照发生变化"
	};
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
*/
const name = "dsh-sentinel";
const inject = [
	"agents",
	"agentDefaultModel",
	"tools"
];
const DEFAULT_CONFIG = {
	heartbeatMs: 5e3,
	probeConcurrency: 8,
	maxSubscriptionsPerSession: 16,
	maxPendingWakeups: 8,
	defaultIntervalSeconds: 30,
	defaultCooldownSeconds: 60,
	dutyLeaseTtlMs: 3e4
};
const Config = Schema.object({
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
	disposed = false;
	/** This process owns probing/delivery. False while another instance's lease is fresh. */
	duty = false;
	constructor(ctx, store, config) {
		this.ctx = ctx;
		this.store = store;
		this.config = config;
	}
	start() {
		this.timer = setInterval(() => {
			this.drive();
		}, this.config.heartbeatMs);
		this.timer.unref();
		this.claimDuty().then(() => {
			this.loadPersisted();
		});
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
			const parsed = JSON.parse(await readFile(leasePath(), "utf8"));
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
		const path = leasePath();
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
	* headless (no webServer), where nothing listens anyway. */
	hookUrl(id) {
		const port = this.ctx.webServer?.port;
		const path = `${HOOK_PATH}?id=${id}`;
		return port === void 0 ? path : `http://localhost:${String(port)}${path}`;
	}
	dispose() {
		this.disposed = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		if (this.duty) unlink(leasePath()).catch(() => {});
		for (const watch of this.watches.values()) watch.closeSensors();
		this.watches.clear();
		for (const handle of this.handles.splice(0, this.handles.length)) Promise.resolve().then(() => handle.dispose()).catch(() => {});
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
		this.drive();
	}
	/** Crash-window recovery: fires logged after the latest delivered watermark
	* requeue now (oldest first, capped like any batch) so a crash between
	* logging and delivering cannot lose the wakeup. */
	requeueUndelivered(watch) {
		const pending = watch.folded.undeliveredFires;
		if (pending.length === 0) return;
		watch.pendingWakeups.push(...pending.slice(-this.config.maxPendingWakeups).map((entry) => renderWakeup(entry.sub, entry.fact)));
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
	findByWatchId(id) {
		for (const watch of this.watches.values()) if (watch.folded.active.has(id)) return watch;
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
					const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
					const handle = await this.ctx.agents.resume({
						resumeSessionId: sessionId,
						agentOptions: {
							provider,
							model
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
				summary: "外部推送到达（webhook）",
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
			summary: fact.summary
		});
		if (watch.recentFires.length > 20) watch.recentFires.pop();
		this.notifyFire(watch, sub, fact);
		watch.pendingWakeups.push(renderWakeup(sub, fact));
		if (watch.pendingWakeups.length > this.config.maxPendingWakeups) {
			const dropped = watch.pendingWakeups.length - this.config.maxPendingWakeups;
			watch.pendingWakeups.splice(0, dropped);
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
					summary: fact.summary,
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
		const startedAt = Date.now();
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
				summary: `${decision.summary}（状态: ${result.state}）`,
				before: clipExcerpt(previousSnapshot ?? ""),
				after: clipExcerpt(result.snapshot),
				probeMs: Date.now() - startedAt
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
				source: {
					kind: "plugin",
					plugin: PLUGIN_ID
				}
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
				description: "Optional regex; probe kinds fire on its no-match→match transition, webhooks only accept matching payloads."
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
			render: (_args, value) => textBlock(value.hookPath !== void 0 ? `哨兵订阅 ${value.id} 已注册: webhook · ${value.target}\n推送地址: POST ${value.hookPath}${value.hookPath.startsWith("http") ? "（localhost 指 dsh 所在主机，跨机器调用请换成该主机的可达地址）" : ""}——需常驻 dsh 进程监听该地址，一次性 headless 进程退出后无法接收推送` : `哨兵订阅 ${value.id} 已注册: ${value.kind} · ${value.target}（每 ${String(value.intervalSeconds)}s 探测${value.kind === "file" ? "，文件变化即时推送" : ""}；会话休眠时由服务端值守；探测与触发投递由常驻 dsh 进程承担——一次性 headless 进程退出后，需有常驻进程（如 dsh web）运行才会生效）`)
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
				...subscription.spec.kind === "webhook" ? { hookPath: runtime.hookUrl(subscription.id) } : {}
			};
		}
	})));
	disposers.push(toolCtx.tools.register(defineTool({
		name: "sentinel_list",
		description: "List this session's active sentinel watches with their live probe state.",
		parameters: {},
		output: {
			schema: LIST_OUTPUT_SCHEMA,
			render: (_args, value) => textBlock(value.subscriptions.length === 0 ? "没有活跃的哨兵订阅。" : value.subscriptions.map((row) => `${row.id}: ${row.kind} · ${row.target} [${row.lastState ?? "未探测"}] 触发 ${String(row.fireCount)}/${String(row.maxFires)}`).join("\n"))
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
			render: (_args, value) => textBlock(value.cancelled ? `订阅 ${value.id} 已取消。` : `没有名为 ${value.id} 的活跃订阅。`)
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
				nextDueAt: probeState?.nextDueAt
			});
		}
	}
	return rows;
}
/** Escape a user-controlled string for the dashboard HTML. */
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
/** One dashboard table row (server render and the client refresh share it). */
/** Localize a raw sensor state word for the dashboard (zh falls back to the original). Exported for tests. */
function localizeState(state, zh) {
	if (!zh) return state;
	if (state === "absent") return "不存在";
	if (state.startsWith("exists")) return `存在${state.slice(6)}`;
	if (state.startsWith("exit")) return `退出码${state.slice(4)}`;
	if (state === "unreachable") return "不可达";
	if (state === "no process") return "无进程";
	if (state.endsWith("process(es)")) return `${state.slice(0, -11).trim()} 个进程`;
	if (state.startsWith("open ")) return `端口可达${state.slice(4)}`;
	if (state.startsWith("closed ")) return `端口不通${state.slice(6)}`;
	if (state.startsWith("timeout ")) return `探测超时${state.slice(7)}`;
	if (state === "awaiting push") return "等待推送";
	return state;
}
/** One dashboard row; shared by the server-side initial render (zh) and the page script (browser language). */
function watchRowHtml(row, zh = true) {
	const session = `${escapeHtml(row.sessionId.slice(0, 16))}… <small>${row.live ? zh ? "活跃" : "live" : zh ? "休眠" : "dormant"}</small>`;
	const pattern = row.pattern !== void 0 ? `<code>/${escapeHtml(row.pattern)}/</code>` : "—";
	const lastState = row.lastState !== void 0 ? escapeHtml(localizeState(row.lastState, zh)) : zh ? "探测中" : "probing";
	const next = row.kind === "webhook" ? zh ? "即时推送" : "live push" : row.nextDueAt !== void 0 ? `${String(Math.max(0, Math.ceil((row.nextDueAt - Date.now()) / 1e3)))}s` : "…";
	return `<tr><td>${session}</td><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.kind)}</td><td class="target" title="${escapeHtml(row.note)}">${escapeHtml(row.target)}</td><td>${pattern}</td><td>${String(row.fireCount)}/${String(row.maxFires)}</td><td>${lastState}</td><td>${next}</td></tr>`;
}
/**
* The server-global watch table page; the client script re-renders it from
* the state route. Exported for the escaping tests.
* @param rows - the watch rows to server-render into the initial table body.
* @returns the complete HTML document.
*/
function dashboardHtml(rows) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel 全局总览</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2329; }
  h1 { font-size: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e6eb; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { color: #86909c; font-weight: 500; white-space: nowrap; }
  td.target { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.empty { color: #86909c; text-align: center; padding: 24px; }
  code { background: #f2f3f5; padding: 1px 4px; border-radius: 4px; }
  small { color: #86909c; }
</style>
</head>
<body>
<h1><span id="title">👁 Sentinel 全局总览</span> <small id="meta"></small></h1>
<table>
<thead><tr><th>会话</th><th>监控</th><th>传感器</th><th>目标</th><th>模式</th><th>触发</th><th>最近状态</th><th>下次探测</th></tr></thead>
<tbody id="rows">${rows.length === 0 ? "<tr><td colspan=\"8\" class=\"empty\">当前没有活跃的监控。</td></tr>" : rows.map((row) => watchRowHtml(row)).join("")}</tbody>
</table>
<script>
const ROWS = document.getElementById('rows')
const META = document.getElementById('meta')
const isZh = navigator.language.startsWith('zh')
document.documentElement.lang = isZh ? 'zh-CN' : 'en'
const DICT = isZh ? {} : {
  title: 'Sentinel overview',
  heads: ['Session', 'Watch', 'Sensor', 'Target', 'Pattern', 'Fires', 'Last state', 'Next probe'],
  empty: 'No active watches right now.',
  count: 'watch(es)',
}
if (!isZh) {
  document.getElementById('title').textContent = '👁 ' + DICT.title
  document.querySelectorAll('thead th').forEach((th, i) => { th.textContent = DICT.heads[i] })
}
const localizeState = ${localizeState.toString()}
const render = (row) => (${watchRowHtml.toString()})(row, isZh)
const escapeHtml = ${escapeHtml.toString()}
// watchRowHtml's body references Date.now through the next-probe cell; keep it.
const refresh = async () => {
  try {
    const res = await fetch(${JSON.stringify(STATE_PATH)}, { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const data = await res.json()
    const watches = Array.isArray(data.watches) ? data.watches : []
    ROWS.innerHTML = watches.length === 0
      ? '<tr><td colspan="8" class="empty">' + (isZh ? '当前没有活跃的监控。' : DICT.empty) + '</td></tr>'
      : watches.map(render).join('')
    META.textContent = '· ' + String(watches.length) + ' ' + (isZh ? '个监控' : DICT.count) + ' · ' + new Date().toLocaleTimeString()
  } catch {}
}
refresh()
setInterval(refresh, 3000)
<\/script>
</body>
</html>
`;
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
		handler: (req, res) => {
			try {
				const sessionId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId") ?? "";
				const rows = collectWatchRows(runtime, ctx, sessionId);
				const fires = [];
				for (const [id, watch] of runtime.view()) {
					if (sessionId !== "" && id !== sessionId) continue;
					fires.push(...watch.recentFires.map((fire) => ({
						sessionId: id,
						...fire
					})));
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					watches: rows,
					recentFires: fires
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
		handler: (_req, res) => {
			try {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(dashboardHtml(collectWatchRows(runtime, ctx, "")));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(describe(error));
			}
		}
	});
	const stopHook = webServer.register({
		kind: "exact",
		path: HOOK_PATH,
		handler: (req, res) => {
			const respond = (status, body) => {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			if ((req.method ?? "GET") !== "POST") {
				respond(405, {
					fired: false,
					reason: "POST only"
				});
				return;
			}
			const id = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("id") ?? "";
			let payload = "";
			req.on("data", (chunk) => {
				if (payload.length < 65536) payload += String(chunk);
			});
			req.on("end", () => {
				const watch = runtime.findByWatchId(id);
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
	return () => {
		stopRoute();
		stopDashboard();
		stopHook();
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
		return () => {
			stopping = true;
			stopRoutes();
			stopCreated();
			runtime.dispose();
		};
	}, `${PLUGIN_ID}.lifecycle()`);
}
//#endregion
export { Config, DASHBOARD_PATH, DEFAULT_CONFIG, HOOK_PATH, STATE_PATH, apply, dashboardHtml, inject, leasePath, localizeState, name, storePath };
