import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, DEFAULT_CONFIG, HOOK_PATH, STATE_PATH, storePath } from '../src/index.ts'

/** Minimal structural doubles for the host surfaces the plugin touches. */

function makeHarness(resumable: string[] = [], options: { headless?: boolean } = {}) {
  const followups: string[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
  const cleanups: Array<() => void> = []
  const live = new Map<string, ReturnType<typeof buildAgent>>()
  const resumeCalls: string[] = []

  function emit(event: string, arg: unknown): void {
    for (const callback of listeners.get(event) ?? []) callback(arg)
  }

  function makeCtx() {
    return {
      effect(body: () => () => void) {
        const cleanup = body()
        cleanups.push(cleanup)
        return cleanup
      },
      on(event: string, callback: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(callback)
        listeners.set(event, list)
        return () => {}
      },
      logger: { warn: (msg: string) => { console.warn(msg) } },
      tools: {
        register(definition: unknown) {
          tools.push(definition as (typeof tools)[number])
          return () => {}
        },
      },
    }
  }

  function buildAgent(id: string) {
    return {
      id,
      status: 'idle',
      followup(message: unknown) {
        const blocks = (message as { content?: Array<{ text?: string }> }).content ?? []
        followups.push(blocks.map(block => block.text ?? '').join(''))
      },
      ctx: makeCtx(),
    }
  }

  const agent = buildAgent('session-e2e')
  live.set(agent.id, agent)

  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = []
  const rootCtx: Record<string, unknown> = {
    ...makeCtx(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agents: {
      roots: () => [...live.values()],
      get: (id: string) => live.get(id),
      async resume({ resumeSessionId }: { resumeSessionId: string }) {
        resumeCalls.push(resumeSessionId)
        if (!resumable.includes(resumeSessionId)) throw new Error(`no persisted session "${resumeSessionId}"`)
        const resumed = buildAgent(resumeSessionId)
        live.set(resumeSessionId, resumed)
        emit('agent/created', { agent: resumed })
        return { agent: resumed, dispose: () => { live.delete(resumeSessionId) } }
      },
    },
  }
  if (options.headless !== true) {
    rootCtx['webServer'] = {
      port: 3080,
      register(route: { path: string; handler: (req: unknown, res: unknown) => void }) {
        routes.push(route)
        return () => {}
      },
    }
  }
  // Cordis dynamic-injection double: fires only when the service exists.
  rootCtx['inject'] = (_deps: string[], callback: (ctx: unknown) => void) => {
    if (options.headless !== true) callback(rootCtx)
    return () => {}
  }

  return { agent, followups, tools, routes, cleanups, rootCtx, live, resumeCalls, emit }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function storeLines(): Promise<Array<{ sessionId: string; change: { change: string } }>> {
  const text = await readFile(storePath(), 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { sessionId: string; change: { change: string } })
}

describe('sentinel end-to-end (in-process)', () => {
  const dirs: string[] = []
  const harnesses: Array<ReturnType<typeof makeHarness>> = []
  const originalHome = process.env['DSH_HOME']
  afterAll(async () => {
    for (const harness of harnesses) for (const cleanup of harness.cleanups.splice(0, harness.cleanups.length)) cleanup()
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
    if (originalHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = originalHome
  })

  async function freshHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-home-'))
    dirs.push(dir)
    process.env['DSH_HOME'] = dir
    return dir
  }

  it('registers the tools, records sidecar changes, probes, and wakes the agent', async () => {
    await freshHome()
    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    expect(harness.routes.some(route => route.path === STATE_PATH)).toBe(true)

    harness.emit('agent/created', { agent: harness.agent })
    const names = harness.tools.map(tool => (tool as { name: string }).name)
    expect(names).toContain('sentinel_watch')
    expect(names).toContain('sentinel_list')
    expect(names).toContain('sentinel_cancel')

    const dir = await mkdtemp(join(tmpdir(), 'sentinel-e2e-'))
    dirs.push(dir)
    const flag = join(dir, 'flag.txt')

    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    const created = await watchTool.execute({
      kind: 'file',
      target: flag,
      interval_seconds: 5,
      note: '触发后继续部署流程：build → env → systemd',
      max_fires: 1,
    }, {}) as { id: string }
    expect(created.id).toBe('watch-1')

    const createdRows = (await storeLines()).filter(row => row.change.change === 'created')
    expect(createdRows.length).toBe(1)
    expect(createdRows[0]?.sessionId).toBe('session-e2e')

    // Baseline probe happens within one heartbeat; then create the file and
    // wait past the probe interval for the transition to fire.
    await sleep(6500)
    await writeFile(flag, 'INSTALL-OK\n')
    await sleep(11_000)

    const fired = (await storeLines()).filter(row => row.change.change === 'fired')
    expect(fired.length).toBe(1)

    expect(harness.followups.length).toBe(1)
    const wakeup = harness.followups[0] ?? ''
    expect(wakeup).toContain('watch-1')
    expect(wakeup).toContain('触发后继续部署流程')
    expect(wakeup).toContain('最后一次触发')
  }, 30_000)

  it('folds durable subscriptions back to life across a server restart', async () => {
    await freshHome()
    const first = makeHarness()
    harnesses.push(first)
    apply(first.rootCtx as never)
    first.emit('agent/created', { agent: first.agent })
    const watchTool = first.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({
      kind: 'process',
      target: 'definitely-not-running-proc',
      note: 'restart resilience check',
      max_fires: 3,
    }, {})
    for (const cleanup of first.cleanups.splice(0, first.cleanups.length)) cleanup()

    // Same DSH_HOME, fresh process: the sidecar log is the only carrier.
    const second = makeHarness()
    harnesses.push(second)
    apply(second.rootCtx as never)
    await sleep(200)
    second.emit('agent/created', { agent: second.agent })
    const listTool = second.tools.find(tool => tool.name === 'sentinel_list')
    if (listTool === undefined) throw new Error('list tool missing')
    const listed = await listTool.execute({}, {}) as { subscriptions: Array<{ id: string }> }
    expect(listed.subscriptions.map(sub => sub.id)).toContain('watch-1')
  })

  it('compacts a history-heavy sidecar at boot without losing fire budget', async () => {
    await freshHome()
    const sid = 'session-e2e'
    const rows: string[] = []
    const push = (change: unknown): void => {
      rows.push(JSON.stringify({ v: 1, sessionId: sid, change }))
    }
    push({
      version: 1, change: 'created',
      subscription: {
        id: 'watch-9', spec: { kind: 'process', target: 'never-running-proc', intervalSeconds: 30 },
        note: 'compaction survivor', maxFires: 5, cooldownSeconds: 60, createdAt: '2026-08-13T00:00:00.000Z',
      },
    })
    push({ version: 1, change: 'fired', id: 'watch-9', at: '2026-08-13T01:00:00.000Z', fact: { fireNumber: 1, summary: 's', before: '', after: 'x', probeMs: 1 } })
    push({ version: 1, change: 'delivered', at: '2026-08-13T01:30:00.000Z' })
    push({ version: 1, change: 'fired', id: 'watch-9', at: '2026-08-13T02:00:00.000Z', fact: { fireNumber: 2, summary: 's', before: '', after: 'x', probeMs: 1 } })
    push({ version: 1, change: 'delivered', at: '2026-08-13T02:30:00.000Z' })
    for (let index = 0; index < 20; index += 1) {
      const id = `watch-c${String(index)}`
      push({
        version: 1, change: 'created',
        subscription: {
          id, spec: { kind: 'process', target: 'gone', intervalSeconds: 30 },
          note: 'cancelled history', maxFires: 1, cooldownSeconds: 60, createdAt: '2026-08-13T00:00:00.000Z',
        },
      })
      push({ version: 1, change: 'cancelled', id, at: '2026-08-13T03:00:00.000Z', reason: 'agent' })
    }
    await writeFile(storePath(), `${rows.join('\n')}\n`)

    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    await sleep(400)
    harness.emit('agent/created', { agent: harness.agent })

    const compacted = await storeLines()
    // The rewrite lands first; the survivor's first probe may append one baseline row.
    expect(compacted.length).toBeLessThanOrEqual(2)
    expect(compacted[0]?.change.change).toBe('compacted')
    const listTool = harness.tools.find(tool => tool.name === 'sentinel_list')
    if (listTool === undefined) throw new Error('list tool missing')
    const listed = await listTool.execute({}, {}) as { subscriptions: Array<{ id: string; fireCount: number }> }
    expect(listed.subscriptions.map(sub => sub.id)).toContain('watch-9')
    expect(listed.subscriptions.find(sub => sub.id === 'watch-9')?.fireCount).toBe(2)
  })

  it('watches a dormant session server-side and resumes it to deliver the fire', async () => {
    await freshHome()
    const first = makeHarness()
    harnesses.push(first)
    apply(first.rootCtx as never)
    first.emit('agent/created', { agent: first.agent })

    const dir = await mkdtemp(join(tmpdir(), 'sentinel-dormant-'))
    dirs.push(dir)
    const flag = join(dir, 'release.txt')

    const watchTool = first.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({
      kind: 'file',
      target: flag,
      pattern: 'READY',
      interval_seconds: 3600,
      note: '休眠期间的变化必须补触发',
      max_fires: 1,
    }, {})

    // Wait for the immediate first probe to persist the absent baseline.
    await sleep(300)
    expect((await storeLines()).filter(row => row.change.change === 'baseline').length).toBe(1)

    // Server restart with NO live agent: the session is fully dormant.
    for (const cleanup of first.cleanups.splice(0, first.cleanups.length)) cleanup()
    const second = makeHarness(['session-e2e'])
    harnesses.push(second)
    second.live.clear()
    apply(second.rootCtx as never)

    // Boot fold arms the file watch; the dormant-era write must late-fire.
    await sleep(400)
    await writeFile(flag, 'RELEASE READY\n')
    await sleep(1600)

    expect(second.resumeCalls).toEqual(['session-e2e'])
    const fired = (await storeLines()).filter(row => row.change.change === 'fired')
    expect(fired.length).toBe(1)
    const observed = (fired[0]?.change as { observed?: { state: string } }).observed
    expect(observed?.state).toContain('exists')

    expect(second.followups.length).toBe(1)
    const wakeup = second.followups[0] ?? ''
    expect(wakeup).toContain('watch-1')
    expect(wakeup).toContain('休眠期间的变化必须补触发')
    expect(wakeup).toContain('READY')
  }, 15_000)

  it('fires a file watch via inotify push far below the probe interval', async () => {
    await freshHome()
    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    harness.emit('agent/created', { agent: harness.agent })

    const dir = await mkdtemp(join(tmpdir(), 'sentinel-push-'))
    dirs.push(dir)
    const flag = join(dir, 'push.txt')

    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({
      kind: 'file',
      target: flag,
      pattern: 'DONE',
      interval_seconds: 3600,
      note: 'push 通道必须秒级反应',
      max_fires: 1,
    }, {})

    // Let the baseline probe land, then write and expect a sub-second push fire
    // even though the polling interval is one hour.
    await sleep(500)
    await writeFile(flag, 'DONE\n')
    await sleep(2000)

    expect((await storeLines()).filter(row => row.change.change === 'fired').length).toBe(1)
    expect(harness.followups.length).toBe(1)
  }, 10_000)

  it('fires a webhook watch through the hook route, honoring the pattern', async () => {
    await freshHome()
    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    harness.emit('agent/created', { agent: harness.agent })
    await sleep(400)

    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    const created = await watchTool.execute({
      kind: 'webhook',
      target: 'ci-pipeline',
      pattern: 'status=success',
      note: 'CI 成功后继续发布',
      max_fires: 2,
      cooldown_seconds: 0,
    }, {}) as { hookPath?: string }
    expect(created.hookPath).toBe(`http://localhost:3080${HOOK_PATH}?id=watch-1&s=session-e2e`)

    const hook = harness.routes.find(route => route.path === HOOK_PATH)
    if (hook === undefined) throw new Error('hook route missing')

    const call = async (payload: string, query = 'id=watch-1&s=session-e2e'): Promise<{ status: number; body: string }> => {
      return new Promise(resolve => {
        const dataListeners: Array<(chunk?: unknown) => void> = []
        const endListeners: Array<() => void> = []
        const req = {
          url: `${HOOK_PATH}?${query}`,
          method: 'POST',
          on(event: 'data' | 'end', callback: (chunk?: unknown) => void) {
            if (event === 'data') dataListeners.push(callback)
            else endListeners.push(callback as () => void)
          },
        }
        let status = 0
        const res = {
          writeHead(code: number) { status = code },
          end(body: string) { resolve({ status, body }) },
        }
        void hook.handler(req, res)
        for (const listener of dataListeners) listener(payload)
        for (const listener of endListeners) listener()
      })
    }

    const rejected = await call('status=failed')
    expect(rejected.status).toBe(202)

    const accepted = await call('status=success build=42')
    expect(accepted.status).toBe(200)
    await sleep(100)

    expect(harness.followups.length).toBe(1)
    expect(harness.followups[0]).toContain('status=success build=42')
  }, 10_000)

  it('scopes webhook hook URLs per session: identical watch ids never cross-fire', async () => {
    await freshHome()
    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    harness.emit('agent/created', { agent: harness.agent })
    await sleep(300)

    const toolA = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (toolA === undefined) throw new Error('watch tool missing')
    const createdA = await toolA.execute({
      kind: 'webhook',
      target: 'ci-a',
      note: 'A 的钩子',
      max_fires: 3,
      cooldown_seconds: 0,
    }, {}) as { id: string; hookPath?: string }
    expect(createdA.hookPath).toContain('s=session-e2e')

    // Second live session in the same runtime: its watch counter also starts at watch-1.
    const followupsB: string[] = []
    const agentB = {
      id: 'session-b',
      status: 'idle',
      followup(message: unknown) {
        const blocks = (message as { content?: Array<{ text?: string }> }).content ?? []
        followupsB.push(blocks.map(block => block.text ?? '').join(''))
      },
      ctx: {
        effect(body: () => () => void) {
          const cleanup = body()
          harness.cleanups.push(cleanup)
          return cleanup
        },
        on: () => () => {},
        tools: {
          register(definition: unknown) {
            ;(harness.tools as unknown[]).push(definition)
            return () => {}
          },
        },
      },
    }
    harness.live.set('session-b', agentB as never)
    harness.emit('agent/created', { agent: agentB })
    const watchTools = harness.tools.filter(tool => tool.name === 'sentinel_watch')
    const toolB = watchTools[watchTools.length - 1]
    if (toolB === undefined) throw new Error('second watch tool missing')
    const createdB = await toolB.execute({
      kind: 'webhook',
      target: 'ci-b',
      note: 'B 的钩子',
      max_fires: 3,
      cooldown_seconds: 0,
    }, {}) as { id: string; hookPath?: string }
    expect(createdB.id).toBe('watch-1')
    expect(createdB.hookPath).toContain('s=session-b')

    const hook = harness.routes.find(route => route.path === HOOK_PATH)
    if (hook === undefined) throw new Error('hook route missing')
    const post = async (query: string, payload: string): Promise<number> => {
      return new Promise(resolve => {
        const dataListeners: Array<(chunk?: unknown) => void> = []
        const endListeners: Array<() => void> = []
        const req = {
          url: `${HOOK_PATH}?${query}`,
          method: 'POST',
          on(event: 'data' | 'end', callback: (chunk?: unknown) => void) {
            if (event === 'data') dataListeners.push(callback)
            else endListeners.push(callback as () => void)
          },
        }
        let status = 0
        const res = {
          writeHead(code: number) { status = code },
          end() { resolve(status) },
        }
        void hook.handler(req, res)
        for (const listener of dataListeners) listener(payload)
        for (const listener of endListeners) listener()
      })
    }

    // Session-qualified push wakes only B, never A.
    expect(await post('id=watch-1&s=session-b', 'push for b')).toBe(200)
    await sleep(150)
    expect(harness.followups.length).toBe(0)
    expect(followupsB.length).toBe(1)
    expect(followupsB[0]).toContain('B 的钩子')

    // Qualifier-less URLs (baked into external systems before the fix) still
    // resolve deterministically to the first matching webhook watch: A.
    expect(await post('id=watch-1', 'legacy push for a')).toBe(200)
    await sleep(150)
    expect(harness.followups.length).toBe(1)
    expect(harness.followups[0]).toContain('A 的钩子')

    // A session qualifier that matches nothing must not leak across sessions.
    expect(await post('id=watch-1&s=session-nobody', 'stray push')).toBe(404)
  }, 10_000)

  it('activates in a headless profile: no routes, but runtime and tools work', async () => {
    await freshHome()
    const harness = makeHarness([], { headless: true })
    harnesses.push(harness)
    apply(harness.rootCtx as never)
    expect(harness.routes.length).toBe(0)

    harness.emit('agent/created', { agent: harness.agent })
    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    const created = await watchTool.execute({
      kind: 'process',
      target: 'definitely-not-running-proc',
      note: 'headless smoke',
      max_fires: 1,
    }, {}) as { id: string }
    expect(created.id).toBe('watch-1')

    const listTool = harness.tools.find(tool => tool.name === 'sentinel_list')
    if (listTool === undefined) throw new Error('list tool missing')
    const listed = await listTool.execute({}, {}) as { subscriptions: Array<{ id: string }> }
    expect(listed.subscriptions.map(sub => sub.id)).toContain('watch-1')
  })

  it('honors a tighter maxSubscriptionsPerSession from config', async () => {
    await freshHome()
    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never, { ...DEFAULT_CONFIG, maxSubscriptionsPerSession: 1 })
    harness.emit('agent/created', { agent: harness.agent })
    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({ kind: 'process', target: 'first-proc', note: 'config smoke', max_fires: 1 }, {})
    await expect(watchTool.execute({ kind: 'process', target: 'second-proc', note: 'over the cap', max_fires: 1 }, {}))
      .rejects.toThrow('subscription limit reached (1)')
  })

  it('requeues a fired-but-undelivered wakeup across a crash restart', async () => {
    await freshHome()
    // First process: register the watch, let it fire while the agent is busy
    // (delivery blocked), then "crash" — the sidecar has the fired row, the
    // in-memory wakeup queue is gone.
    const first = makeHarness()
    harnesses.push(first)
    apply(first.rootCtx as never)
    first.emit('agent/created', { agent: first.agent })
    first.agent.status = 'busy'

    const dir = await mkdtemp(join(tmpdir(), 'sentinel-crash-'))
    dirs.push(dir)
    const flag = join(dir, 'flag.txt')
    const watchTool = first.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({ kind: 'file', target: flag, interval_seconds: 5, note: 'crash window recovery', max_fires: 1 }, {})
    await sleep(1000)
    await writeFile(flag, 'deploy ready')
    await sleep(7000)
    expect(first.followups.length).toBe(0)
    for (const cleanup of first.cleanups.splice(0, first.cleanups.length)) cleanup()

    // Second process, same DSH_HOME: boot requeues the fire and delivers it.
    const second = makeHarness(['session-e2e'])
    harnesses.push(second)
    apply(second.rootCtx as never)
    second.emit('agent/created', { agent: second.agent })
    await sleep(7000)
    expect(second.followups.length).toBe(1)
    expect(second.followups[0]).toContain('[dsh-sentinel] 订阅 watch-1 触发')

    // Delivery wrote its watermark: no third delivery of the same fire.
    const lines = await storeLines()
    expect(lines.some(line => line.change.change === 'delivered')).toBe(true)
  }, 30_000)

  it('runs one duty owner per DSH_HOME: passive instance defers, then takes over', async () => {
    await freshHome()
    const cfg = { ...DEFAULT_CONFIG, heartbeatMs: 500, dutyLeaseTtlMs: 400 }

    // Owner claims the duty lease first.
    const owner = makeHarness()
    harnesses.push(owner)
    apply(owner.rootCtx as never, cfg)
    await sleep(700)

    // Second instance on the same DSH_HOME: passive — its tools work and
    // writes persist, but probing and delivery belong to the owner (which
    // adopts the new rows through the heartbeat store sync).
    const passive = makeHarness()
    harnesses.push(passive)
    apply(passive.rootCtx as never, cfg)
    passive.emit('agent/created', { agent: passive.agent })
    await sleep(300)
    const watchTool = passive.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    const leaseDir = await mkdtemp(join(tmpdir(), 'sentinel-lease-live-'))
    dirs.push(leaseDir)
    const leaseFlag = join(leaseDir, 'flag.txt')
    await watchTool.execute({ kind: 'file', target: leaseFlag, interval_seconds: 5, note: 'passive defers', max_fires: 1 }, {})
    await sleep(1500)
    await writeFile(leaseFlag, 'owner should deliver this')
    await sleep(2500)
    expect(passive.followups.length).toBe(0)
    expect(owner.followups.length).toBe(1)

    // Owner exits (lease released): the passive instance takes over within a
    // heartbeat and now probes and delivers itself.
    for (const cleanup of owner.cleanups.splice(0, owner.cleanups.length)) cleanup()
    await sleep(1000)
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-lease-'))
    dirs.push(dir)
    const flag = join(dir, 'flag.txt')
    await watchTool.execute({ kind: 'file', target: flag, interval_seconds: 5, note: 'takeover', max_fires: 1 }, {})
    await sleep(1200)
    await writeFile(flag, 'took over')
    await sleep(1500)
    expect(passive.followups.length).toBe(1)
    expect(passive.followups[0]).toContain('订阅 watch-2 触发')
  }, 25_000)

  it('fans fires out to the optional notify webhook', async () => {
    await freshHome()
    const received: Array<Record<string, unknown>> = []
    const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString() })
      req.on('end', () => {
        try { received.push(JSON.parse(data) as Record<string, unknown>) } catch { /* not for us */ }
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as { port: number }

    const harness = makeHarness()
    harnesses.push(harness)
    apply(harness.rootCtx as never, { ...DEFAULT_CONFIG, heartbeatMs: 500, notifyWebhookUrl: `http://127.0.0.1:${String(port)}/hook` })
    harness.emit('agent/created', { agent: harness.agent })
    await sleep(400)

    const dir = await mkdtemp(join(tmpdir(), 'sentinel-notify-'))
    dirs.push(dir)
    const flag = join(dir, 'flag.txt')
    const watchTool = harness.tools.find(tool => tool.name === 'sentinel_watch')
    if (watchTool === undefined) throw new Error('watch tool missing')
    await watchTool.execute({ kind: 'file', target: flag, interval_seconds: 5, note: 'notify fanout', max_fires: 1 }, {})
    await sleep(1200)
    await writeFile(flag, 'go')
    await sleep(2500)

    expect(received.length).toBe(1)
    expect(received[0]?.['event']).toBe('fired')
    expect(received[0]?.['id']).toBe('watch-1')
    expect(received[0]?.['summary']).toContain('快照')
    await new Promise<void>(resolve => server.close(() => resolve()))
  }, 20_000)
})
