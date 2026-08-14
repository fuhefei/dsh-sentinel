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
   edge a pattern waits for is placeholder → matching content. New sensor
   kinds must register their "target missing" snapshot in the placeholder set
   in `src/sensors.ts`.
3. **Firing is edge-triggered, never level-triggered.** A pattern fires on
   no-match → match; a pattern-less watch fires on any snapshot change after
   the baseline. Cooldown rate-limits fires; it is not the re-arm mechanism.
4. **Delivery is at-least-once.** A fire is logged to the sidecar before
   delivery; the `delivered` watermark lets a restart requeue fires that never
   reached the agent. Consumers must tolerate a duplicate wakeup.
5. **One duty owner per DSH_HOME.** Probing and delivery happen only under the
   lease; passive instances defer and take over when the lease expires.
6. **The sidecar log is the only carrier of truth.** Memory state is a fold of
   `sentinel.jsonl`; every mutation is an appended change, never an edit. A
   corrupt row fails the fold loudly.
7. **Watches outlive their session's agent.** The host has no session-deleted
   event, so watches of a deleted session keep probing until cancelled by
   hand. Manual cancel (`POST /plugins/dsh-sentinel/cancel`, the ✕ in every
   UI row) is the kill switch of last resort; never assume the agent is
   reachable. The state route exposes `pendingWakeups` per watch so queued
   wakeups are visible, not silent.
