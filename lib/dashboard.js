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
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-watches.html
	var dashboard_watches_default = "{{#watches}}{{> watch}}{{/watches}}{{^watches}}{{#emptyWatches}}{{> empty}}{{/emptyWatches}}{{/watches}}";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-fires.html
	var dashboard_fires_default = "{{#fires}}{{> fire}}{{/fires}}{{^fires}}{{#emptyFires}}{{> empty}}{{/emptyFires}}{{/fires}}";
	//#endregion
	//#region \0sentinel-html:/home/dmitry-vasiliev/Documents/deepseek-harness/default-workspace/dsh-sentinel/templates/dashboard-watch.html
	var dashboard_watch_default = "<tr>\n  <td>{{session}}… <small>{{live}}</small>{{#dropped}}{{> badge}}{{/dropped}}</td>\n  <td>{{id}}</td>\n  <td>{{kind}}</td>\n  <td class=\"target\" title=\"{{note}}\">{{target}}</td>\n  <td>{{#patternView}}{{> pattern}}{{/patternView}}{{^patternView}}—{{/patternView}}</td>\n  <td>{{fireCount}}/{{maxFires}}{{#pending}}{{> badge}}{{/pending}}</td>\n  <td>{{state}}</td>\n  <td>{{next}}</td>\n  <td><button type=\"button\" class=\"cancel\" data-session=\"{{sessionId}}\" data-id=\"{{id}}\" title=\"{{cancel}}\" aria-label=\"{{cancel}} {{id}}\">×</button></td>\n</tr>\n";
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
	/** Static, checked-in partials only; caller data is never interpreted as a template. */
	const dashboardPartials = {
		watchRows: dashboard_watches_default,
		fireRows: dashboard_fires_default,
		watch: dashboard_watch_default,
		fire: dashboard_fire_default,
		empty: dashboard_empty_default,
		heading: dashboard_heading_default,
		badge: dashboard_badge_default,
		pattern: dashboard_pattern_default
	};
	/** Share plain presentation models and Mustache templates between SSR and the browser. */
	function createDashboardRenderer(locale) {
		const copy = dashboardCopy[locale];
		const presentation = createPresentation(locale, messages[locale]);
		const fill = (template, values) => template.replace(/\{(\w+)\}/g, (token, key) => values[key] === void 0 ? token : String(values[key]));
		const time = (value) => (value === void 0 ? /* @__PURE__ */ new Date() : new Date(value)).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en");
		const badge = (kind, count) => count > 0 ? {
			kind,
			label: fill(copy[kind], { n: count })
		} : null;
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
			emptyWatches: {
				columns: 9,
				message: copy.empty
			}
		});
		const fireModel = (facts) => ({
			fires: facts.map((fire) => ({
				time: time(fire.at),
				id: fire.id,
				session: fire.sessionId.slice(0, 16),
				summary: presentation.formatFireSummary(fire)
			})),
			emptyFires: {
				columns: 4,
				message: copy.firesEmpty
			}
		});
		const rows = (watches, dropped = {}) => mustache.render(dashboard_watches_default, watchModel(watches, dropped), dashboardPartials);
		const fires = (facts) => mustache.render(dashboard_fires_default, fireModel(facts), dashboardPartials);
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
