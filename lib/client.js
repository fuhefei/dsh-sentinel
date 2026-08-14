window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-sentinel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* dsh-sentinel, browser half: the transparency surface. A dock card above the
		* composer (official conversation.input.dock family, same visual language as
		* Goal / To-dos / task-status / loop) showing every active watch of the
		* current session: sensor, target, live probe state, fire budget, next probe
		* countdown — plus the recent fire history when expanded. A sidebar branch
		* under each watched session row (sidebar.workspaces.sessionRow.branch) makes
		* the server-global watch set visible from the workspace tree, with a link to
		* the node half's dashboard table. Polls the node half's read-only state
		* route; renders nothing when the session has no watches.
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
			"branch": "哨兵 · {count} 个监控",
			"noteLabel": "便签",
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
			"branch": "sentinel · {count} watch(es)",
			"noteLabel": "note",
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
				let alive = true;
				const poll = async () => {
					try {
						const res = await fetch(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (alive && Array.isArray(data.watches)) setState({
							watches: data.watches,
							recentFires: Array.isArray(data.recentFires) ? data.recentFires : []
						});
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId]);
			return state;
		}
		let globalWatches = [];
		let globalFires = [];
		const globalListeners = /* @__PURE__ */ new Set();
		let globalTimer;
		async function pollGlobal() {
			try {
				const res = await fetch(STATE_PATH, { headers: { accept: "application/json" } });
				if (!res.ok) return;
				const data = await res.json();
				if (Array.isArray(data.watches)) {
					globalWatches = data.watches;
					globalFires = Array.isArray(data.recentFires) ? data.recentFires : [];
					for (const listener of globalListeners) listener();
				}
			} catch {}
		}
		function subscribeGlobal(listener) {
			globalListeners.add(listener);
			if (globalTimer === void 0) {
				pollGlobal();
				globalTimer = setInterval(() => {
					pollGlobal();
				}, POLL_MS);
			}
			return () => {
				globalListeners.delete(listener);
				if (globalListeners.size === 0 && globalTimer !== void 0) {
					clearInterval(globalTimer);
					globalTimer = void 0;
				}
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
			const { watch, t } = props;
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
							watch.lastState ?? t("probing"),
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
			const { fire, t } = props;
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
							children: new Date(fire.at).toLocaleTimeString()
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
							children: fire.summary
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
							"：",
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
			const { t, session } = props;
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
							href: DASHBOARD_PATH,
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
								t
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
								t
							}, `${fire.id}-${fire.at}`))
						]
					})
				})]
			});
		}
		/**
		* Row-below sidebar branch: one instance per session row, fed by the shared
		* global poller. Collapsed it is a single eye-iconed row with the watch count;
		* expanded it lists this session's watches and links to the dashboard table.
		* Renders nothing when the session has no watches, so unwatched rows are
		* untouched.
		*/
		function SentinelBranch(props) {
			const { sessionId, t } = props;
			const watches = useGlobalWatches();
			const [open, setOpen] = (0, react.useState)(false);
			const mine = watches.filter((watch) => watch.sessionId === sessionId);
			if (mine.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-sentinel-branch": "",
				style: {
					margin: "0 0 2px 26px",
					borderLeft: "2px solid var(--dsw-alias-border-l1)",
					paddingLeft: 10,
					fontSize: 12,
					fontFamily: "system-ui",
					color: "var(--dsw-alias-label-caption)"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "2px 0",
						cursor: "pointer"
					},
					onClick: (e) => {
						e.stopPropagation();
						setOpen((value) => !value);
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
								size: 10
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
							state: "ongoing",
							size: 8
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								display: "inline-flex",
								alignItems: "center",
								gap: 4
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "eye",
								size: 11
							}), t("branch", { count: mine.length })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: DASHBOARD_PATH,
							target: "_blank",
							rel: "noreferrer",
							onClick: (e) => {
								e.stopPropagation();
							},
							style: {
								marginLeft: "auto",
								fontSize: 11,
								color: "var(--dsw-alias-label-caption)",
								textDecoration: "none"
							},
							children: t("dashboard")
						})
					]
				}), open && mine.map((watch) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					title: watch.pattern !== void 0 ? `${watch.target}  /${watch.pattern}/\n${watch.note}` : `${watch.target}\n${watch.note}`,
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "1px 0 1px 16px",
						minWidth: 0
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								width: 16,
								display: "inline-flex",
								justifyContent: "center",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: KIND_ICONS[watch.kind] ?? "file",
								size: 11
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { flex: "none" },
							children: watch.id
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: 1,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: watch.target
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								flex: "none",
								whiteSpace: "nowrap",
								fontVariantNumeric: "tabular-nums"
							},
							children: [
								watch.lastState ?? t("probing"),
								" · ",
								t("fires", {
									n: watch.fireCount,
									max: watch.maxFires
								}),
								pendingSuffix(watch, t)
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CancelButton, {
							watch,
							t
						})
					]
				}, watch.id))]
			});
		}
		/**
		* better-sidebar tab view: the server-global watch table inside the sidebar
		* workbench. better-sidebar's tab contract passes no locale props, so copy
		* falls back to the browser language (their documented guidance for consumer
		* tabs is plain strings / () => string).
		*/
		function SentinelTabView() {
			const watches = useGlobalWatches();
			const fires = useGlobalFires();
			const t = (key, values) => {
				const template = (navigator.language.startsWith("zh") ? zh : en)[key];
				if (values === void 0) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => values[name] !== void 0 ? String(values[name]) : match);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-sentinel-tab": "",
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
								href: DASHBOARD_PATH,
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
						t
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
						t
					}, `${fire.sessionId}-${fire.id}-${fire.at}`))
				]
			});
		}
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
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "sentinel",
				order: 24,
				locale: NS
			}, SentinelDock));
			ctx.slots.inject("sidebar.workspaces.sessionRow.branch", () => ctx.slots.register({
				name: "sidebar.workspaces.sessionRow.branch",
				id: "sentinel",
				locale: NS
			}, SentinelBranch));
			ctx.plugin({
				inject: ["betterSidebar"],
				apply(sidebarCtx) {
					const sidebar = sidebarCtx.betterSidebar;
					ctx.effect(() => sidebar.registerTab({
						id: "dsh-sentinel:watches",
						title: () => (navigator.language.startsWith("zh") ? zh : en)["tab"],
						icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "eye",
							size: Math.max(12, size - 2)
						}),
						order: 60,
						single: true,
						component: () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelTabView, {})
					}), "sentinel: better-sidebar tab");
				}
			});
		}
		//#endregion
		exports.SentinelBranch = SentinelBranch;
		exports.SentinelDock = SentinelDock;
		exports.SentinelTabView = SentinelTabView;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map