/** Only template-rendered markup may fill an HTML fragment slot. */
export type RenderedHtml = string & { readonly __renderedHtml: unique symbol }

export function escapeHtml(value: string | number): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Join already escaped fragments without opening a raw-HTML path for caller data. */
export function joinHtml(parts: readonly RenderedHtml[]): RenderedHtml {
  return parts.join('') as RenderedHtml
}

/**
 * Fixed slots only: {{name}} escapes text/quoted attributes; <!-- sentinel:name -->
 * accepts trusted rendered fragments. One pass preserves placeholder-like user data.
 * This deliberately has no expressions, nested evaluation or executable helpers.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
  fragments: Readonly<Record<string, RenderedHtml>> = {},
): RenderedHtml {
  return template.replace(/\{\{(\w+)\}\}|<!-- sentinel:([\w-]+) -->/g, (_token, valueKey: string | undefined, fragmentKey: string | undefined) => {
    const key = valueKey ?? fragmentKey!
    const source = valueKey !== undefined ? values : fragments
    if (!Object.hasOwn(source, key)) throw new Error(`Missing dashboard template slot: ${key}`)
    return valueKey !== undefined ? escapeHtml(values[key]!) : fragments[key]!
  }) as RenderedHtml
}
