// A small XML well-formedness check (the test environment has no DOMParser).
// Returns the problem, or null when the document is well formed.

const NAME = /^[A-Za-z_][\w.:-]*$/

export function xmlProblem(src: string): string | null {
  const stack: string[] = []
  let i = 0
  let roots = 0
  const text = (s: string, at: number): string | null => {
    const bad = s.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/)
    if (bad) return `bad entity at ${at + (bad.index ?? 0)}`
    if (s.includes('>') && stack.length === 0 && s.trim()) return `text outside the root at ${at}`
    return null
  }
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const chunk = lt < 0 ? src.slice(i) : src.slice(i, lt)
    const problem = text(chunk, i)
    if (problem) return problem
    if (chunk.trim() && stack.length === 0) return `text outside the root at ${i}`
    if (lt < 0) break
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      if (end < 0) return 'unclosed comment'
      i = end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt)
      if (end < 0) return 'unclosed processing instruction'
      i = end + 2
      continue
    }
    // find the tag's end, skipping quoted attribute values
    let j = lt + 1
    let quote = ''
    for (; j < src.length; j++) {
      const ch = src[j]!
      if (quote) {
        if (ch === quote) quote = ''
        else if (ch === '<') return `"<" inside an attribute at ${j}`
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      else if (ch === '<') return `"<" inside a tag at ${j}`
    }
    if (j >= src.length) return `unclosed tag at ${lt}`
    const inner = src.slice(lt + 1, j)
    i = j + 1
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      const open = stack.pop()
      if (open !== name) return `</${name}> closes <${open ?? 'nothing'}> at ${lt}`
      continue
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const m = body.match(/^([^\s/]+)([\s\S]*)$/)
    if (!m || !NAME.test(m[1]!)) return `bad tag name at ${lt}`
    const attrs = m[2]!
    const seen = new Set<string>()
    const re = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g
    let rest = attrs
    let a: RegExpExecArray | null
    while ((a = re.exec(attrs))) {
      if (seen.has(a[1]!)) return `duplicate attribute ${a[1]} at ${lt}`
      seen.add(a[1]!)
      const v = a[2]!.slice(1, -1)
      const p = text(v, lt)
      if (p) return p
      rest = rest.replace(a[0], '')
    }
    if (rest.trim()) return `bad attributes "${rest.trim().slice(0, 30)}" at ${lt}`
    if (stack.length === 0) {
      roots++
      if (roots > 1) return 'more than one root element'
    }
    if (!selfClosing) stack.push(m[1]!)
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`
  if (roots !== 1) return 'no root element'
  return null
}
