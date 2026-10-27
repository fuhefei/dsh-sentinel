import { describe, expect, it } from 'vitest'
import { joinHtml, renderTemplate } from '../src/dashboard-template.ts'

describe('dashboard fixed-slot templates', () => {
  it('escapes text and quoted ordinary attributes', () => {
    const value = '\"><script>alert(1)</script> & \'text\''
    expect(renderTemplate('<p title="{{value}}">{{value}}</p>', { value }))
      .toBe('<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;text&#39;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;text&#39;</p>')
  })

  it('inserts only previously rendered fragments and never evaluates inserted content again', () => {
    const text = '{{other}} <!-- sentinel:body --> $& <b>caller</b>'
    const child = renderTemplate('<span>{{text}}</span>', { text })
    const html = renderTemplate('<main><!-- sentinel:body --></main>', {}, { body: joinHtml([child, child]) })
    expect(html).toBe(`<main>${child}${child}</main>`)
    expect(html).toContain('{{other}} &lt;!-- sentinel:body --&gt; $&amp; &lt;b&gt;caller&lt;/b&gt;')
  })

  it('fails on missing slots instead of silently publishing broken templates', () => {
    expect(() => renderTemplate('{{title}}', {})).toThrow('Missing dashboard template slot: title')
    expect(() => renderTemplate('<!-- sentinel:rows -->', {})).toThrow('Missing dashboard template slot: rows')
    expect(() => renderTemplate('{{toString}}', {})).toThrow('Missing dashboard template slot: toString')
  })

  it('renders numeric zero and empty fragments without treating them as missing', () => {
    expect(renderTemplate('{{count}}<!-- sentinel:rows -->', { count: 0 }, { rows: joinHtml([]) })).toBe('0')
  })
})
