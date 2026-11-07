// A small JSONC reader that keeps offsets, so arca can add to a config file (wrangler.jsonc) without
// rewriting it: comments, trailing commas and formatting stay as the user wrote them.

export type JsoncNode =
  | { type: 'object'; start: number; end: number; members: { key: string; keyStart: number; value: JsoncNode }[] }
  | { type: 'array'; start: number; end: number; items: JsoncNode[] }
  | { type: 'value'; start: number; end: number; value: unknown }

/** The parsed tree (`end` is exclusive), or null when the text isn't valid JSONC. */
export function parseJsonc(text: string): JsoncNode | null {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        i = nl === -1 ? text.length : nl
      } else if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2)
        if (close === -1) throw new SyntaxError('unclosed comment')
        i = close + 2
      } else return
    }
  }
  const string = (): string => {
    const m = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i))
    if (!m) throw new SyntaxError('bad string')
    i += m[0].length
    return JSON.parse(m[0]) as string
  }
  const value = (): JsoncNode => {
    skip()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const members: { key: string; keyStart: number; value: JsoncNode }[] = []
      for (;;) {
        skip()
        if (text[i] === '}') break
        const keyStart = i
        const key = string()
        skip()
        if (text[i++] !== ':') throw new SyntaxError('expected :')
        members.push({ key, keyStart, value: value() })
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== '}') throw new SyntaxError('expected , or }')
      }
      i++
      return { type: 'object', start, end: i, members }
    }
    if (c === '[') {
      i++
      const items: JsoncNode[] = []
      for (;;) {
        skip()
        if (text[i] === ']') break
        items.push(value())
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== ']') throw new SyntaxError('expected , or ]')
      }
      i++
      return { type: 'array', start, end: i, items }
    }
    if (c === '"') return { type: 'value', start, end: (string(), i), value: JSON.parse(text.slice(start, i)) }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!m) throw new SyntaxError('unexpected token')
    i += m[0].length
    return { type: 'value', start, end: i, value: JSON.parse(m[0]) }
  }
  try {
    const root = value()
    skip()
    return i === text.length ? root : null
  } catch {
    return null
  }
}

export function member(node: JsoncNode | undefined, key: string): JsoncNode | undefined {
  return node?.type === 'object' ? node.members.find((m) => m.key === key)?.value : undefined
}

export interface Edit {
  at: number
  /** Characters to remove from `at`. */
  remove?: number
  insert: string
}

export function applyEdits(text: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.insert + text.slice(e.at + (e.remove ?? 0))
  return text
}

/** Adds `"key": valueText` as the last member of `obj`. */
export function addMember(text: string, obj: Extract<JsoncNode, { type: 'object' }>, key: string, valueText: string): Edit[] {
  const entry = `${JSON.stringify(key)}: ${valueText}`
  const last = obj.members.at(-1)
  if (!last) {
    const indent = lineIndent(text, obj.start)
    const inner = text.slice(obj.start + 1, obj.end - 1)
    if (!inner.includes('\n')) return [{ at: obj.start, remove: obj.end - obj.start, insert: `{ ${entry} }` }]
    const eol = eolOf(text)
    return [{ at: obj.start, remove: obj.end - obj.start, insert: `{${eol}${indent}${indentUnit(text)}${entry}${eol}${indent}}` }]
  }
  return after(text, last.value.end, obj.end - 1, lineIndent(text, last.keyStart), entry)
}

/** Appends `items` (already JSON text) to the end of `arr`. */
export function addItems(text: string, arr: Extract<JsoncNode, { type: 'array' }>, items: string[]): Edit[] {
  const last = arr.items.at(-1)
  if (!last) return [{ at: arr.start, remove: arr.end - arr.start, insert: `[${items.join(', ')}]` }]
  const multiline = text.slice(arr.start, arr.items[0]!.start).includes('\n')
  if (!multiline) return [{ at: last.end, insert: items.map((t) => `, ${t}`).join('') }]
  const indent = lineIndent(text, last.start)
  return after(text, last.end, arr.end - 1, indent, items.join(`,${eolOf(text)}${indent}`))
}

/**
 * Puts `entry` after the node that ends at `end`, on a line of its own when the node ends its line
 * (after a trailing comment, so the comment stays with its line). `close` is the closing bracket.
 */
function after(text: string, end: number, close: number, indent: string, entry: string): Edit[] {
  const rest = text.slice(end, close)
  const nl = rest.indexOf('\n')
  const line = (nl === -1 ? rest : rest.slice(0, nl)).replace(/\r$/, '')
  const comma = /^\s*,/.exec(line)
  // A trailing comma stays where it is: the new entry gets one too.
  if (nl === -1 || !/^\s*,?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/.test(line)) {
    return [{ at: comma ? end + comma[0].length : end, insert: comma ? ` ${entry},` : `, ${entry}` }]
  }
  const edits: Edit[] = [{ at: end + line.length, insert: `${eolOf(text)}${indent}${entry}${comma ? ',' : ''}` }]
  if (!comma) edits.push({ at: end, insert: ',' })
  return edits
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  '
}
