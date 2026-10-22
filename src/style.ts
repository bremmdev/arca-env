import type { OutStream } from './io.js'

const codes = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const

export type Style = keyof typeof codes

export function colorEnabled(s: OutStream, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  return s.isTTY
}

export type Paint = (style: Style, text: string) => string

export function painter(s: OutStream, env: NodeJS.ProcessEnv): Paint {
  const on = colorEnabled(s, env)
  return (style, text) => {
    if (!on) return text
    const [open, close] = codes[style]
    return `\u001b[${open}m${text}\u001b[${close}m`
  }
}

/** Pads a string to a visible width (ignores ANSI escapes). */
export function pad(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\u001b\[[0-9;]*m/g, '').length
  return visible >= width ? text : text + ' '.repeat(width - visible)
}
