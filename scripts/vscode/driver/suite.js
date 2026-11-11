// Runs inside VS Code's extension host (@vscode/test-electron's extensionTestsPath), started by
// scripts/vscode.mjs. Drives one scenario through VS Code's own commands and writes what VS Code
// shows to a JSON report: test messages (proposed testObserver API), the Problems panel, Debug
// Console output (a debug adapter tracker), integrated terminal text (proposed
// terminalDataWriteEvent API), plus screenshots of this window only (Windows).
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

const scenario = process.env.ARCA_SCENARIO
const outDir = process.env.ARCA_OUT
const report = { scenario, log: [], tests: [], outputs: [], diagnostics: [], debugOutput: [], terminalData: null, shots: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => report.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`)

function shot(name) {
  if (!process.env.ARCA_SHOT) return
  const file = path.join(outDir, `${scenario}-${name}.png`)
  try {
    cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', process.env.ARCA_SHOT, file])
    report.shots.push(file)
  } catch (e) {
    log(`screenshot failed: ${e.message}`)
  }
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const text = (m) => (typeof m === 'string' ? m : (m?.value ?? String(m)))

function collect(snapshots, into) {
  for (const s of snapshots) {
    into.push({
      label: s.label,
      states: s.taskStates.map((t) => ({
        state: t.state,
        messages: t.messages.map((m) => ({ message: text(m.message), expected: m.expectedOutput, actual: m.actualOutput })),
      })),
    })
    collect(s.children, into)
  }
}

function countItems(items) {
  let n = 0
  const walk = (it) => {
    n++
    it.children.forEach(walk)
  }
  items.forEach(walk)
  return n
}

/** Everything written to integrated terminals, when this VS Code still has the proposed API. */
function captureTerminals() {
  if (typeof vscode.window.onDidWriteTerminalData !== 'function') {
    log('terminal text not captured: no onDidWriteTerminalData in this VS Code')
    return
  }
  report.terminalData = ''
  vscode.window.onDidWriteTerminalData((e) => (report.terminalData += e.data))
}

async function testScenario() {
  const observer = vscode.tests.createTestObserver()
  await waitFor(() => countItems(observer.tests) > 0, 120_000, 'test discovery')
  await sleep(3000) // let discovery settle
  log(`discovered ${countItems(observer.tests)} items`)
  const before = vscode.tests.testResults.length
  await vscode.commands.executeCommand('testing.runAll')
  await waitFor(() => vscode.tests.testResults.length > before && vscode.tests.testResults[0].completedAt, 240_000, 'the test run')
  // Some extensions report in several steps: wait until nothing changes for 8 s.
  let changed = Date.now()
  const sub = vscode.tests.onDidChangeTestResults(() => (changed = Date.now()))
  await waitFor(() => Date.now() - changed > 8000, 120_000, 'results to settle')
  sub.dispose()
  const runs = vscode.tests.testResults.slice(0, vscode.tests.testResults.length - before)
  log(`run finished: ${runs.length} result set(s)`)
  for (const result of runs) {
    report.outputs.push(result.output ?? '')
    collect(result.results, report.tests)
  }
  // The Problems panel: the Jest extension puts failure messages there.
  report.diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.map((d) => ({ file: path.basename(uri.fsPath), source: d.source, message: d.message })))

  // What a person looks at: the Test Results terminal, then the failure peek in the editor.
  await vscode.commands.executeCommand('workbench.view.testing.focus')
  await vscode.commands.executeCommand('testing.showMostRecentOutput')
  await sleep(2500)
  shot('results')
  const file = (await vscode.workspace.findFiles('tests/**/*.{ts,js}'))[0]
  if (file) {
    const doc = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(doc)
    const line = doc.getText().split('\n').findIndex((l) => l.includes("toBe('wrong')"))
    editor.selection = new vscode.Selection(line, 0, line, 0)
    await vscode.commands.executeCommand('testing.openOutputPeek').then(undefined, (e) => log(`peek: ${e.message}`))
    await sleep(2500)
    shot('peek')
  }
}

async function debugScenario() {
  vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: (session) => ({
      onDidSendMessage: (m) => {
        if (m.type === 'event' && m.event === 'output') {
          // Child sessions (the app, child processes) are named after their script: report the launch config.
          let top = session
          while (top.parentSession) top = top.parentSession
          report.debugOutput.push({ config: top.configuration.name, session: session.name, category: m.body.category, output: m.body.output, source: m.body.source?.path ?? m.body.source?.name, line: m.body.line })
        }
      },
    }),
  })
  const folder = vscode.workspace.workspaceFolders[0]
  const configs = vscode.workspace.getConfiguration('launch', folder).get('configurations').map((c) => c.name)
  for (const name of configs) {
    const ended = new Promise((resolve) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (!s.parentSession) {
          d.dispose()
          resolve()
        }
      })
    })
    log(`start ${name}`)
    if (!(await vscode.debug.startDebugging(folder, name))) throw new Error(`${name} didn't start`)
    await Promise.race([ended, sleep(60_000)])
    await sleep(1500)
    const integrated = vscode.workspace.getConfiguration('launch', folder).get('configurations').find((c) => c.name === name)?.console === 'integratedTerminal'
    await vscode.commands.executeCommand(integrated ? 'workbench.action.terminal.focus' : 'workbench.debug.action.focusRepl')
    await sleep(1500)
    shot(name)
  }
}

exports.run = async function run() {
  try {
    captureTerminals()
    await sleep(4000) // let the extensions activate
    if (scenario === 'debug') await debugScenario()
    else await testScenario()
  } catch (e) {
    log(`error: ${e.stack}`)
    shot('error')
  } finally {
    fs.writeFileSync(path.join(outDir, `${scenario}.json`), JSON.stringify(report, null, 2))
  }
}
