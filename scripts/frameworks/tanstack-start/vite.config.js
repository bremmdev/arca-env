import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// devtools() turns on console piping: server console calls are POSTed to the dev server and
// shown in the browser console, a route that never passes through arca's stdout masking.
export default defineConfig({
  plugins: [devtools(), tanstackStart(), viteReact()],
})
