// Programmatic API. Most projects only need the CLI (`arca run -- <cmd>`).
export { main, VERSION } from './main.js'
export { processIO, type IO, type Prompts, type OutStream } from './io.js'
export { Redactor, needlesFor, createMaskedWriter, type Needle, type Secret } from './redact.js'
export { parseEnv, parseEnvEntries, type EnvEntry } from './envfiles.js'
export { detectAgent, detectCI, type AgentInfo } from './context.js'
export type { ArcaConfig, VarDecl } from './config.js'
