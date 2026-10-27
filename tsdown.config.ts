/**
 * Standalone tsdown config for the dsh-sentinel external plugin: node half as
 * plain ESM for the host Loader, host browser half as one CJS closure bundle
 * whose externals are the platform seed modules, and the standalone dashboard
 * as a self-contained IIFE. HTML templates are imported as build-time text.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = 'dsh-sentinel'

/** The shell's platform seed table; kept in step with `dsh-client-web/platform.ts`. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Import checked-in HTML templates as build-time text; no template loader is needed at runtime. */
function htmlTemplates() {
  const prefix = '\0sentinel-html:'
  return {
    name: 'sentinel-html-templates',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.html?raw')) return null
      return prefix + resolvePath(importer === undefined ? process.cwd() : dirname(importer), source.slice(0, -4))
    },
    async load(this: { addWatchFile(path: string): void }, id: string) {
      if (!id.startsWith(prefix)) return null
      const path = id.slice(prefix.length)
      this.addWatchFile(path)
      return `export default ${JSON.stringify(await readFile(path, 'utf8'))};`
    },
  }
}

export default [
  {
    name: `${PLUGIN_ID}/node`,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Committed artifact keeps @deepseek-ai imports external (the dsh-loop
    // convention): `dsh plugin add` installs plugins where the host's own
    // packages resolve, so external users need zero npm installs.
    external: [/^@deepseek-ai\//, 'cordis'],
    plugins: [htmlTemplates()],
  },
  {
    name: `${PLUGIN_ID}/dashboard`,
    entry: { dashboard: 'src/dashboard-entry.ts' },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    plugins: [htmlTemplates()],
    outputOptions: { entryFileNames: 'dashboard.js' },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (EXTERNALS.includes(id) ? undefined : true),
    plugins: [{
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
