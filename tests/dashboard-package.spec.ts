import { execFile } from 'node:child_process'
import { access, appendFile, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import Mustache from 'mustache'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const fixturePrefix = 'sentinel-dashboard-package-'
const marker = '/* extracted dashboard package asset */'
const assets = [
  { name: 'script', path: '/plugins/dsh-sentinel/dashboard.js', file: 'lib/dashboard.js', mime: 'text/javascript; charset=utf-8', marker },
  { name: 'stylesheet', path: '/plugins/dsh-sentinel/dashboard.css', file: 'lib/dashboard.css', mime: 'text/css; charset=utf-8', marker: '/* extracted dashboard package stylesheet */' },
  { name: 'icon', path: '/plugins/dsh-sentinel/icon.svg', file: 'icon.svg', mime: 'image/svg+xml; charset=utf-8', marker: '<!-- extracted dashboard package icon -->' },
] as const

type Plugin = typeof import('../src/index.ts')
type Host = Parameters<Plugin['apply']>[0]
type WebServer = NonNullable<Host['webServer']>
type Route = Parameters<WebServer['register']>[0]
type Request = Parameters<Route['handler']>[0]

interface PackResult {
  filename: string
  files: Array<{ path: string }>
}

/** Exercise only the package's public entry and HTTP route, with host dependencies supplied. */
function mountPlugin(plugin: Plugin) {
  const routes = new Map<string, Route>()
  const disposers: Array<() => void | Promise<void>> = []
  const host: Host = {
    effect(body) {
      const dispose = body()
      if (dispose instanceof Promise) throw new Error('Unexpected asynchronous host effect setup')
      disposers.push(dispose)
      return dispose
    },
    on() { return () => {} },
    inject(_dependencies, activate) { activate(host); return () => {} },
    logger: { warn() {} },
    agents: {
      roots: () => [],
      get: () => undefined,
      async resume() { throw new Error('Package asset checks must not resume agents') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    tools: { register: () => () => {} },
    webServer: {
      port: 3080,
      register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } },
    },
  }
  plugin.apply(host)
  return {
    routes,
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) await dispose()
    },
  }
}

async function request(route: Route, method = 'GET', headers: Request['headers'] = {}) {
  let status = 0
  let responseHeaders: Record<string, string> = {}
  let body = ''
  await route.handler({ method, url: route.path, headers, on() {} }, {
    writeHead(code, values) { status = code; responseHeaders = values },
    end(value) { body = value },
  })
  return { status, headers: responseHeaders, body }
}

describe('dashboard distribution assets', () => {
  let fixture: string | undefined
  let packedRoot: string
  let packedFiles: string[]
  let asset: string
  const assetBodies = new Map<string, string>()
  let plugin: Plugin
  let runtime: ReturnType<typeof mountPlugin> | undefined
  const oldHome = process.env['DSH_HOME']

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), fixturePrefix))
    const { stdout } = await execFileAsync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', fixture,
      '--cache', join(packageRoot, '.cache', 'npm-package-tests'),
    ], { cwd: packageRoot, timeout: 30_000, env: { ...process.env, npm_config_update_notifier: 'false' } })
    const [packed] = JSON.parse(stdout) as PackResult[]
    if (packed === undefined) throw new Error('npm pack did not report a package')
    const archive = resolve(fixture, packed.filename)
    if (dirname(archive) !== resolve(fixture)) throw new Error('Unexpected npm package archive path')
    packedFiles = packed.files.map(file => file.path)
    await execFileAsync('tar', ['-xzf', archive, '-C', fixture], { timeout: 30_000 })
    packedRoot = join(fixture, 'package')
    // The plugin intentionally resolves host-provided peer modules at runtime.
    await symlink(join(packageRoot, 'node_modules'), join(packedRoot, 'node_modules'), 'dir')
    for (const entry of assets) {
      const path = join(packedRoot, entry.file)
      const body = await readFile(path, 'utf8')
      await appendFile(path, `\n${entry.marker}\n`, 'utf8')
      assetBodies.set(entry.path, body + `\n${entry.marker}\n`)
    }
    asset = assetBodies.get('/plugins/dsh-sentinel/dashboard.js')!
    plugin = await import(pathToFileURL(join(packedRoot, 'lib', 'index.js')).href) as Plugin
    process.env['DSH_HOME'] = join(fixture, 'isolated-home')
    runtime = mountPlugin(plugin)
  }, 30_000)

  afterAll(async () => {
    try {
      await runtime?.dispose()
    } finally {
      if (oldHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = oldHome
      if (fixture !== undefined) {
        const target = resolve(fixture)
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(fixturePrefix)) {
          throw new Error('Refusing to remove an unexpected package fixture path')
        }
        await rm(target, { recursive: true, force: true })
      }
    }
  })

  it('ships the standalone script and physical HTML templates without requiring source files', async () => {
    expect(packedFiles).toContain('lib/index.js')
    expect(packedFiles).toContain('lib/dashboard.js')
    expect(packedFiles).toContain('lib/dashboard.css')
    expect(packedFiles.filter(path => path.startsWith('templates/') && path.endsWith('.html')).sort()).toEqual([
      'templates/dashboard.html', 'templates/dashboard/fires.html', 'templates/dashboard/watches.html', 'templates/layouts/document.html',
    ])
    expect(packedFiles.some(path => path.startsWith('src/'))).toBe(false)
    await expect(access(join(packedRoot, 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bundles Mustache without requiring a host module and ships its license notice', async () => {
    const nodeEntry = await readFile(join(packedRoot, 'lib', 'index.js'), 'utf8')
    expect(nodeEntry).not.toMatch(/\bfrom\s*['"]mustache['"]/)
    expect(packedFiles).toContain('THIRD_PARTY_NOTICES.md')
    expect(await readFile(join(packedRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain('Copyright (c) 2010-2015 The mustache.js community')
  })

  it('renders packaged server HTML with an external deferred script and escaped data', () => {
    const html = plugin.dashboardHtml([], [{
      sessionId: 'package-session', id: 'watch-1', at: '2026-01-01T00:00:00Z',
      summary: '</script><img src=x onerror=alert(1)> {{title}} <!-- sentinel:rows -->',
    }])
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Sentinel overview</title>')
    expect(html).toContain(`<script src="${Mustache.escape('/plugins/dsh-sentinel/dashboard.js')}" defer></script>`)
    expect(html).toMatch(/<script\b[^>]*\bdefer(?:\s|>|=)/)
    expect(html).toContain(`<link rel="stylesheet" href="${Mustache.escape('/plugins/dsh-sentinel/dashboard.css')}">`)
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${Mustache.escape('/plugins/dsh-sentinel/icon.svg')}">`)
    expect(html).not.toContain('<style')
    expect(html).not.toMatch(/<script\b[^>]*>\s*\S[\s\S]*?<\/script>/)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain(Mustache.escape('</script><img src=x onerror=alert(1)> {{title}} <!-- sentinel:rows -->'))
  })

  it.each(['en', 'zh'] as const)('runs the packed standalone IIFE in %s without host boot globals', async locale => {
    const watch: Parameters<Plugin['dashboardHtml']>[0][number] = {
      sessionId: 'package-session', live: true, id: 'watch-1', kind: 'webhook',
      target: '<target> {{title}} <!-- sentinel:watches -->', note: '\" onclick=\"alert(1)',
      intervalSeconds: 30, fireCount: 1, maxFires: 2, createdAt: '2026-01-01T00:00:00Z',
      pendingWakeups: 2, lastState: 'absent',
    }
    const fire = {
      sessionId: watch.sessionId, id: watch.id, at: '2026-01-01T00:00:00Z', summary: 'unused fallback',
      trigger: { kind: 'pattern' as const, pattern: 'READY', match: '</script><img src=x> $& {{title}}' }, state: 'absent',
    }
    const element = () => ({
      innerHTML: '', textContent: '', contains: () => false,
      addEventListener() {}, removeEventListener() {},
    })
    const nodes = { rows: element(), fires: element(), meta: element() }
    const lifecycle = new Map<string, () => void>()
    const timers = new Map<number, () => void>()
    let ordinal = 0
    const calls: string[] = []
    // No window.__ModuleLoader__, __DSH_BOOT__, require or module is supplied.
    runInNewContext(asset, {
      document: {
        documentElement: { lang: locale === 'zh' ? 'zh-CN' : 'en' },
        getElementById: (id: keyof typeof nodes) => nodes[id],
        defaultView: {
          addEventListener(type: string, listener: () => void) { lifecycle.set(type, listener) },
          removeEventListener(type: string) { lifecycle.delete(type) },
        },
      },
      navigator: { language: locale === 'en' ? 'zh-CN' : 'en-US' },
      AbortController,
      fetch: async (url: string) => {
        calls.push(url)
        return { ok: true, json: async () => ({
          watches: [watch], recentFires: [fire], droppedWakeups: { [watch.sessionId]: 3 },
          duty: { ageMs: 12_000, stale: true },
        }) }
      },
      setTimeout(callback: () => void) { timers.set(++ordinal, callback); return ordinal },
      clearTimeout(id: number) { timers.delete(id) },
    }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } })
    // All mocked I/O resolves immediately; yield once to drain the real Promise chain.
    await new Promise<void>(done => setImmediate(done))
    expect(calls).toEqual(['/plugins/dsh-sentinel/state'])
    expect(nodes.rows.innerHTML).toContain(locale === 'en' ? '<td>absent</td>' : '<td>不存在</td>')
    expect(nodes.rows.innerHTML).toContain(locale === 'en' ? '2 pending' : '待投递 2')
    expect(nodes.rows.innerHTML).toContain('&lt;target&gt; {{title}} &lt;!-- sentinel:watches --&gt;')
    expect(nodes.fires.innerHTML).toContain(Mustache.escape(locale === 'en' ? 'Pattern /READY/ started matching:' : '模式 /READY/ 开始匹配:'))
    expect(nodes.fires.innerHTML).toContain(Mustache.escape('</script><img src=x> $& {{title}}'))
    expect(nodes.fires.innerHTML).not.toContain('<img src=x>')
    expect(nodes.meta.textContent).toContain(locale === 'en' ? 'duty heartbeat stale (12s ago)' : '值守心跳 12s 前（疑似停摆）')
    const html = plugin.dashboardHtml([watch], [fire], { [watch.sessionId]: 3 }, locale)
    expect(html).toContain(nodes.rows.innerHTML)
    expect(html).toContain(nodes.fires.innerHTML)
    expect(timers.size).toBe(1)
    expect(lifecycle.has('pagehide')).toBe(true)
    lifecycle.get('pagehide')!()
    expect(timers.size).toBe(0)
  })

  it.each(assets)('serves $name from the installed package rather than the workspace', async entry => {
    const route = runtime!.routes.get(entry.path)
    expect(route).toBeDefined()
    const result = await request(route!, 'GET', { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe(entry.mime)
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.headers['cache-control']).toBe('no-cache')
    expect(result.body).toBe(assetBodies.get(entry.path))
    expect(result.body).toContain(entry.marker)
  })

  it('serves the external stylesheet with its own MIME type and no inline fallback', async () => {
    const route = runtime!.routes.get('/plugins/dsh-sentinel/dashboard.css')
    expect(route).toBeDefined()
    const result = await request(route!, 'GET', { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(result.body).toContain('.table-scroll')
    expect(plugin.dashboardHtml([])).not.toContain('<style')
  })

  it.each(assets)('supports HEAD without a body and rejects non-read methods for $name', async entry => {
    const route = runtime!.routes.get(entry.path)!
    const head = await request(route, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-type']).toBe(entry.mime)
    expect(head.body).toBe('')
    const post = await request(route, 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
    expect(post.body).not.toContain(entry.marker)
  })

  it.each(assets)('retains the browser-trust fence for $name GET and HEAD', async entry => {
    const route = runtime!.routes.get(entry.path)!
    for (const headers of [
      { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      { host: 'rebound.example:3080', origin: 'http://rebound.example:3080', 'sec-fetch-site': 'same-origin' },
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const result = await request(route, method, headers)
        expect(result.status).toBe(403)
        expect(result.body).not.toContain(entry.marker)
        if (method === 'HEAD') expect(result.body).toBe('')
      }
    }
  })

  it.each(assets)('reports missing $name files as 500 without a HEAD body or HTML fallback', async entry => {
    const root = resolve(packedRoot)
    const file = resolve(root, entry.file)
    const parked = file + '.unavailable'
    if (root !== resolve(fixture!, 'package') || !file.startsWith(root + sep) || dirname(parked) !== dirname(file)) {
      throw new Error('Refusing to rename an unexpected package asset')
    }
    const route = runtime!.routes.get(entry.path)!
    await rename(file, parked)
    try {
      for (const method of ['GET', 'HEAD']) {
        const result = await request(route, method)
        expect(result.status).toBe(500)
        expect(result.headers['content-type']).toBe('text/plain; charset=utf-8')
        expect(result.body).not.toContain(entry.marker)
        expect(result.body).not.toContain('<!doctype html>')
        if (method === 'HEAD') expect(result.body).toBe('')
      }
      const forbidden = await request(route, 'HEAD', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
      expect(forbidden.status).toBe(403)
      expect(forbidden.body).toBe('')
    } finally {
      await rename(parked, file)
    }
  })
})
