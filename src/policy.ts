import { randomInt } from 'node:crypto'
import type { Context, Invocation } from './context.js'
import { ArcaError } from './errors.js'
import type { IO } from './io.js'
import { agentAdhocMessage, agentDeniedMessage, agentRevealMessage, agentWriteMessage, notInteractiveMessage } from './messages.js'
import type { AgentRunPolicy } from './store.js'

// Three fixed rules:
//   1. Agents only get secrets through verified package.json scripts.
//   2. Output of `arca run` is always masked (enforced by the runner, not here).
//   3. Only a human can show or change values (the human gate).

export type RunDecision = { allow: true } | { allow: false; message: string }

export function decideRun(ctx: Context, invocation: Invocation, policy: AgentRunPolicy, displayCommand: string): RunDecision {
  if (!ctx.agent.detected) return { allow: true } // humans, IDE tasks, git hooks (masked)
  if (policy === 'deny') return { allow: false, message: agentDeniedMessage(ctx.agent) }
  if (invocation.kind === 'script' && invocation.verified) return { allow: true }
  return { allow: false, message: agentAdhocMessage(ctx.agent, displayCommand, invocation) }
}

export type GateKind = 'reveal' | 'write'

export interface GateOptions {
  kind: GateKind
  /** e.g. `arca set STRIPE_SECRET_KEY`, shown in "ask the user to run…". */
  command: string
  /** `… | arca set NAME` reads the value from stdin, so stdin may be a pipe. */
  allowPipedStdin?: boolean
}

/**
 * The human gate, required before any value is shown or changed:
 * no agent marker, and a real terminal. If an agent marker is present but the session is
 * fully interactive (a human in an IDE terminal with leaked markers), a typed challenge
 * lets the human through.
 */
export async function humanGate(io: IO, ctx: Context, opts: GateOptions): Promise<void> {
  const stdinOk = ctx.stdinIsTTY || Boolean(opts.allowPipedStdin)
  const interactive = ctx.interactiveOutput && stdinOk
  if (ctx.agent.detected) {
    if (interactive && ctx.stdinIsTTY) {
      await challenge(io, ctx)
      return
    }
    throw new ArcaError(opts.kind === 'reveal' ? agentRevealMessage(ctx.agent) : agentWriteMessage(ctx.agent, opts.command))
  }
  if (!interactive) throw new ArcaError(notInteractiveMessage(opts.command))
}

async function challenge(io: IO, ctx: Context): Promise<void> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) code += alphabet[randomInt(alphabet.length)]
  io.stderr.write(
    `arca: this terminal looks like it's driven by an AI agent (${ctx.agent.name} via ${ctx.agent.via}).\n` +
      'This confirmation must be completed by a human. AI agents must not answer this prompt.\n' +
      `Type this code to continue: ${code}\n`,
  )
  const answer = await io.prompts.text('Code')
  if (answer === null || answer.trim().toUpperCase() !== code) throw new ArcaError('arca: the code did not match. Nothing was changed.')
}
