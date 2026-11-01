# Core invariants

Every change to the runtime must keep these. They exist because each one was
either broken once or is one edit away from breaking.

1. **Watch ids are session-scoped.** Allocation restarts at `watch-1` per
   session. Any consumer that crosses sessions — the webhook hook URL, any
   global lookup — must carry the session qualifier (`&s=<sessionId>`). A bare
   id only ever resolves inside one session's fold.
2. **Snapshots come in two domains: placeholder and content.** A placeholder
   (`<absent>`, `<unreachable>`, `<none>`, `<push-only>`) means "the target
   itself is missing", not data. Patterns are tested against content only; the
   edge a pattern waits for is placeholder → matching content. New probe
   kinds must register their "target missing" snapshot in the placeholder set
   in `src/sensors.ts`; push-only kinds (`webhook`, `session`) use the
   push-only placeholder and are skipped by the heartbeat.
3. **Firing is edge-triggered, never level-triggered.** A probe pattern fires
   on no-match → match; a pattern-less probe watch fires on any snapshot change
   after the baseline. Session watches are discrete host events rather than a
   state diff: every committed `turn/end` is one edge, and their optional
   pattern is a filter on the turn-end reason kind, not a transition matcher.
   Cooldown rate-limits fires; it is not the re-arm mechanism.
4. **Delivery is at-least-once.** A fire is logged to the sidecar before
   delivery; the `delivered` watermark lets a restart requeue fires that never
   reached the agent. Consumers must tolerate a duplicate wakeup.
5. **One duty owner per DSH_HOME.** Probing and delivery happen only under the
   lease; passive instances defer and take over when the lease expires.
6. **The sidecar log is the only carrier of truth.** Memory state is a fold of
   `sentinel.jsonl`; every mutation is an appended change, never an edit. A
   corrupt row fails the fold loudly.
7. **Watches outlive their session's agent.** A live session leaving the store
   emits `session/disposed`, but sentinel does not treat it as a cancel: orphan
   watches keep probing (and `session` watches stay armed on a disposed target)
   until cancelled by hand. Manual cancel
   (`POST /plugins/dsh-sentinel/cancel`, the ✕ in every UI row) is the kill
   switch of last resort; never assume the agent is reachable. The state route
   exposes `pendingWakeups` per watch so queued wakeups are visible, not
   silent.
8. **Session watches consume host events, never re-derive them.** A `session`
   watch fires from the root-scope `session/event` feed on a durable
   `turn/end`; it must not poll agents/status, rescan session logs, or invent
   a baseline. Malformed or unrelated events are ignored. Fires run through the
   same durable fire path (log, budget, cooldown, wakeup delivery) as every
   other sensor kind.
9. **Localization is presentation, not sensor data.** Browser surfaces follow
   the host locale; standalone dashboard links carry that locale explicitly.
   Server messages use the configured `locale` (English by default). Persist
   neutral trigger data alongside the readable summary so viewers can render
   their own language. Never translate snapshot bytes, placeholder tokens,
   notes, regexes, matches or protocol fields. Legacy summaries remain readable;
   unknown or ambiguous text must pass through rather than being guessed or
   rewritten. Follow the host's registered fallback chain for custom languages.
   Dashboard markup belongs in a Mustache document layout, page content and
   meaningful watch/fire partials; keep trivial tags in their owning template.
   Use standard partial composition, not a custom inheritance engine. Keep the
   default HTML escaping for text/quoted attributes and compose static partials
   with plain presentation models, never raw-HTML slots, template functions or
   caller-provided template source. Never re-evaluate inserted caller data. Browser
   behavior is a separately built, self-contained TypeScript entry, not inline
   JavaScript or serialized functions. Styles belong in a separately linked CSS
   asset, never an inline style block. Fixed JS/CSS/icon routes retain the same
   browser-trust fence, MIME/nosniff/cache rules and bodyless HEAD responses.
   Test initial HTML, actual assets and packed-package routes independently of
   the source checkout.
