#!/usr/bin/env node
import { processIO } from './io.js'
import { main } from './main.js'

const code = await main(process.argv.slice(2), processIO())
process.exitCode = code
