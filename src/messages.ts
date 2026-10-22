import type { AgentInfo, Invocation } from './context.js'

// Agents follow instructions in error output very reliably, so every refusal says what
// to do instead. These texts double as onboarding.

function detected(agent: AgentInfo): string {
  return `detected: ${agent.name} via ${agent.via}`
}

export function agentRevealMessage(agent: AgentInfo): string {
  return [
    `arca: secret values cannot be shown to AI agents (${detected(agent)}).`,
    'You don\'t need the values. Secrets are injected automatically when you run package',
    'scripts, for example `npm run dev` or `npm test`. Their output is masked as [arca:NAME].',
    '  • See which variables exist:   npx arca list',
    '  • Check that they are set:     npx arca check',
    '  • A value is missing or wrong: ask the user to run `npx arca set NAME`',
    '  • Need a new random secret:    ask the user to run `npx arca set NAME --generate`',
  ].join('\n')
}

export function agentWriteMessage(agent: AgentInfo, command: string): string {
  return [
    `arca: only a human can change secret values (${detected(agent)}).`,
    'Ask the user to run this in their own terminal:',
    `    ${command}`,
    'If this is a new variable, you can declare it in arca.json under "vars" first,',
    'so `npx arca check` and `npx arca setup` know about it.',
  ].join('\n')
}

export function agentAdhocMessage(agent: AgentInfo, command: string, invocation: Invocation): string {
  const why =
    invocation.kind === 'script' && !invocation.verified && invocation.reason ? `\n(Not accepted as a package script: ${invocation.reason}.)` : ''
  return [
    `arca: AI agents can only use secrets through package.json scripts (${detected(agent)}).${why}`,
    `Refused: arca run -- ${command}`,
    'Run the command through a package.json script that uses `arca run`, e.g. `npm run dev`.',
    'If no script exists for what you need, ask the user to add one.',
  ].join('\n')
}

export function agentDeniedMessage(agent: AgentInfo): string {
  return [
    `arca: the user has turned off secrets for AI agents in this project (${detected(agent)}).`,
    'Ask the user to run the command themselves.',
  ].join('\n')
}

export function notInteractiveMessage(command: string): string {
  return [
    'arca: this needs a person at an interactive terminal (stdin and stdout must be a terminal).',
    `Run it yourself in a terminal:  ${command}`,
  ].join('\n')
}

export function agentsSnippet(): string {
  return `## Secrets (arca)

Secrets are stored outside the repo with arca and injected when commands run.
\`.env\` files in this project contain only non-sensitive config, which you may read and edit.

- Run the app, tests and tools through package scripts (\`npm run dev\`, \`npm test\`, …),
  which wrap commands in \`arca run\`. Ad-hoc \`arca run -- <cmd>\` is refused for agents.
  Output is always masked: secrets appear as \`[arca:NAME]\`.
- \`npx arca list\` shows which variables exist. \`npx arca check\` verifies required ones are set.
- A project can have several profiles (sets of values). A run that doesn't use the default
  profile starts with an \`arca ▸ profile …\` line. Don't switch profiles with \`npx arca use\`
  unless the user asks: it also changes what the user's own terminals use.
- Do not try to read secret values (\`npx arca reveal\`, printing \`process.env\`, reading the
  arca store).
- Only the user can set or change values. If a value is missing or wrong, ask the user
  to run \`npx arca set NAME\` (or \`npx arca set NAME --generate\` for a random secret).
- To add a secret: declare it in \`arca.json\` under \`vars\`, then ask the user to set it.
  To add non-sensitive config: put it in \`.env\` and declare it with \`"sensitive": false\`.
- Never put secrets (keys, tokens, passwords, connection strings with credentials) in
  \`.env\` files. Don't change URLs that receive credentials. Those are declared sensitive
  and live in arca.
- Don't work around arca: don't unset or change agent environment variables (such as
  \`CLAUDECODE\` or \`AI_AGENT\`), don't add scripts that print \`process.env\`, and don't read
  the arca store or the OS keychain. If arca blocks you, ask the user.
`
}
