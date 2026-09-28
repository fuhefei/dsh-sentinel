/**
 * Standalone-build shims: the two runtime imports resolve inside an installed
 * profile (pnpm links them next to the dsh checkout); these declarations keep
 * `tsc -b` green when the plugin builds outside the dsh workspace.
 */
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: unknown): unknown
}

declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(init: {
    content: Array<{ type: 'text'; text: string }>
    // Session format v4 admits producer-owned kinds only: a plugin owns `plugin:<name>`.
    source: { kind: `plugin:${string}` }
  }): unknown
}
