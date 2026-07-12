import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const bundledRuntimeDependencies = [
  '@onmyworkbuddy/contracts',
  '@onmyworkbuddy/core',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@modelcontextprotocol/sdk',
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledRuntimeDependencies })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'agent-host': resolve(__dirname, 'src/workers/agent-host.ts'),
          'tool-runner': resolve(__dirname, 'src/workers/tool-runner.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledRuntimeDependencies })],
    build: { outDir: 'dist/preload', rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
    build: { outDir: 'dist/renderer' },
  },
})
