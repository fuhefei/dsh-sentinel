# dsh-sentinel

Condition-driven wakeup for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent registers a watch, goes to sleep — even closes the session — and the sentinel wakes it when the condition happens. Every subscription and every fire is a user-visible session event, and the browser dock shows what is on duty.

![Sentinel dock panel, expanded](docs/preview/sentinel-panel.png)

## How it works

The node half owns one server-lifetime runtime that folds a plugin-owned sidecar log (`$DSH_HOME/sentinel.jsonl`) into live subscriptions, probes every sensor on a shared 5s heartbeat, and delivers wakeups through the official followup channel — resuming a dormant session's agent first when needed. Subscriptions therefore survive process restarts, and conditions that become true while the server is down late-fire on the next probe.

The browser half is a dock card above the composer (the `conversation.input.dock` family) listing the session's active watches — sensor, target, live probe state, fire budget, next-probe countdown — plus recent fire history when expanded. It polls the read-only state route and renders nothing when the session has no watches.

Two surfaces make the server-global watch set visible. A sidebar branch grows under every session row that has active watches (`sidebar.workspaces.sessionRow.branch`, one shared poller for all rows) — collapsed it is a `👁` count, expanded it lists the session's watches and links to the dashboard. The dashboard is a standalone table of every watch across every session: session (active/dormant), sensor, target, pattern, fire budget, last probe state, next probe.

| Sidebar branch | Global dashboard |
| --- | --- |
| ![Sidebar branch](docs/preview/sentinel-sidebar-branch.png) | ![Dashboard](docs/preview/sentinel-dashboard.png) |

## Sensors

| Kind | Engine | Fires on |
| --- | --- | --- |
| `file` | path snapshot + inotify push | snapshot change (sub-second); accelerated by fs events |
| `command` | read-only shell line, probed on an interval | output/exit-code change |
| `http` | URL probed on an interval | status/body change |
| `process` | `pgrep -f` pattern, probed on an interval | match-set change |
| `webhook` | pure push | any POST to the returned hook URL |

With `pattern`, probe kinds fire on the no-match→match edge of that regex and webhooks accept only matching payloads; without it, probe kinds fire on any change after the baseline.

## Tools

- `sentinel_watch` — register a watch: `kind`, `target`, optional `pattern`, `interval` (1–3600s, default 30), `note` (delivered verbatim with every wakeup), `maxFires` (default 1: one-shot), `cooldown` (default 60s), optional `ttl`.
- `sentinel_list` — active watches with live probe state.
- `sentinel_cancel` — cancel one watch by id.

## Routes

- `GET /plugins/dsh-sentinel/state?sessionId=…` — read-only state for the dock and the sidebar branch (omit `sessionId` for every session).
- `GET /plugins/dsh-sentinel/dashboard` — the server-global watch table.
- `POST /plugins/dsh-sentinel/hook?id=watch-N` — webhook entry; put a `curl` into a CI job, git hook, or another machine's script to wake the agent.

## Install

One line through the official bundle channel (build artifacts are committed, so the git-source install runs no build):

```sh
dsh plugin --profile web add "github:fuhefei/dsh-sentinel#main"
```

Alternatively, add the node half manually through a patch-list configuration over the shipped base:

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-sentinel
      name: '@dsh-external/dsh-sentinel'
```

The browser half ships in the same package (`./client`) and is injected by the Web UI's plugin loader.

### Sidebar branch prerequisite

The dock and the dashboard work on a stock host. The sidebar branch needs the session-row extension holes, which the official tree does not declare yet; apply the bundled patch to your DSH source checkout and rebuild `ui-workspace`:

```sh
git apply /path/to/dsh-sentinel/patches/session-row-holes.patch
```

The patch declares `sidebar.workspaces.sessionRow` and `sidebar.workspaces.sessionRow.branch` as **list** holes (every registrant renders, in order) at **root** scope (sidebar rows render outside any session binding; the row passes its `sessionId` through owner props). [dsh-subagent-tree](https://github.com/dsh-external/dsh-subagent-tree) ships a patch for the same hole names with different semantics (keyed/session); apply one or the other, not both.

### better-sidebar integration (optional)

When [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed in the same profile, sentinel registers its global watch table as a sidebar tab (`dsh-sentinel:watches`, in the **+** menu) through better-sidebar's documented `ctx.betterSidebar.registerTab` extension surface: every watch server-wide with live probe state, fire budgets and recent fire history, fed by one shared poller. No configuration needed; without better-sidebar the registration is silently skipped and the dock / branch / dashboard keep working as before.

## Develop

```sh
npm install
npm run build     # tsc -b + tsdown (lib/index.js, lib/client.js)
npm test          # vitest: domain fold/normalize, sensors, dashboard escaping, e2e wakeup flow
```

## License

BSD 3-Clause. See [LICENSE](LICENSE).
