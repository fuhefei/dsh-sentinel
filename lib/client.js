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
		const POLL_MS = 2e3;
		const NS = "sentinel";
		const zh = {
			"watching": "哨兵值守中",
			"count": "{count} 个监控",
			"fires": "触发 {n}/{max}",
			"next": "下次探测 {s}s",
			"probing": "探测中",
			"push": "即时推送",
			"open": "展开",
			"close": "收起",
			"history": "最近触发",
			"nofires": "尚未触发过",
			"branch": "👁 哨兵 · {count} 个监控",
			"dashboard": "全局总览 ↗",
			"dormant": "休眠",
			"live": "活跃",
			"tab": "哨兵监控",
			"tabempty": "当前没有活跃的监控。"
		};
		const en = {
			"watching": "Sentinel on duty",
			"count": "{count} watch(es)",
			"fires": "fired {n}/{max}",
			"next": "next probe {s}s",
			"probing": "probing",
			"push": "live push",
			"open": "Expand",
			"close": "Collapse",
			"history": "Recent fires",
			"nofires": "No fires yet",
			"branch": "👁 sentinel · {count} watch(es)",
			"dashboard": "All watches ↗",
			"dormant": "dormant",
			"live": "live",
			"tab": "Sentinel",
			"tabempty": "No active watches right now."
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
		const KIND_GLYPHS = {
			file: "▤",
			command: "❯",
			http: "⇄",
			process: "▶",
			webhook: "⚡"
		};
		function countdown(nextDueAt) {
			if (nextDueAt === void 0) return "…";
			return `${String(Math.max(0, Math.ceil((nextDueAt - Date.now()) / 1e3)))}`;
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
							width: 14,
							textAlign: "center",
							fontSize: 12,
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: KIND_GLYPHS[watch.kind] ?? "•"
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
							whiteSpace: "nowrap"
						},
						children: [
							watch.lastState ?? t("probing"),
							" · ",
							t("fires", {
								n: watch.fireCount,
								max: watch.maxFires
							}),
							" · ",
							cadence
						]
					})
				]
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
								gap: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: "ongoing",
								size: 10
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"aria-hidden": true,
								style: {
									fontSize: 13,
									lineHeight: "16px"
								},
								children: "👁"
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
								whiteSpace: "nowrap"
							},
							children: [
								t("count", { count: watches.length }),
								" · ",
								watches.map((watch) => watch.id).join(" ")
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: "none",
								fontSize: 12,
								color: "var(--dsw-alias-label-caption)"
							},
							children: open ? t("close") : t("open")
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						maxHeight: 220,
						overflowY: "auto",
						borderTop: "1px solid var(--dsw-alias-border-l1)",
						padding: "4px 0"
					},
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
						}) : recentFires.slice(0, 8).map((fire) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								padding: "1px 12px",
								fontSize: 12,
								color: "var(--dsw-alias-label-caption)"
							},
							children: [
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
						}, `${fire.id}-${fire.at}`))
					]
				})]
			});
		}
		/**
		* Row-below sidebar branch: one instance per session row, fed by the shared
		* global poller. Collapsed it is a single 👁 row with the watch count;
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
							"aria-hidden": true,
							style: { fontSize: 10 },
							children: open ? "▾" : "▸"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
							state: "ongoing",
							size: 8
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("branch", { count: mine.length }) }),
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
								width: 12,
								textAlign: "center",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: KIND_GLYPHS[watch.kind] ?? "•"
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
								whiteSpace: "nowrap"
							},
							children: [
								watch.lastState ?? t("probing"),
								" · ",
								t("fires", {
									n: watch.fireCount,
									max: watch.maxFires
								})
							]
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontWeight: 500,
									color: "var(--dsw-alias-label-primary)"
								},
								children: t("tab")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: 1,
									fontSize: 12,
									color: "var(--dsw-alias-label-caption)"
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
					watches.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "8px 12px",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)"
						},
						children: t("tabempty")
					}),
					watches.map((watch) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "4px 12px 0",
							fontSize: 11,
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: [
							watch.sessionId,
							" · ",
							watch.live ? t("live") : t("dormant")
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WatchRow, {
						watch,
						t
					})] }, `${watch.sessionId}-${watch.id}`)),
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
					}) : fires.slice(0, 12).map((fire) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							padding: "1px 12px",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)"
						},
						children: [
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
					}, `${fire.sessionId}-${fire.id}-${fire.at}`))
				]
			});
		}
		/** Required client services: slot registry and locale dictionaries. betterSidebar
		* is declared but optional — absent when better-sidebar is not installed. */
		const inject = [
			"slots",
			"locale",
			"betterSidebar"
		];
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
			if (ctx.betterSidebar !== void 0) {
				const sidebar = ctx.betterSidebar;
				ctx.effect(() => sidebar.registerTab({
					id: "dsh-sentinel:watches",
					title: () => (navigator.language.startsWith("zh") ? zh : en)["tab"],
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						style: {
							fontSize: Math.max(12, size - 2),
							lineHeight: 1
						},
						children: "👁"
					}),
					order: 60,
					single: true,
					component: () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SentinelTabView, {})
				}), "sentinel: better-sidebar tab");
			}
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