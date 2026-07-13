import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromDesktop = createRequire(join(repositoryRoot, 'apps', 'desktop', 'package.json'))
let packageRoot = dirname(requireFromDesktop.resolve('better-sqlite3'))

while (!existsSync(join(packageRoot, 'package.json'))) {
  const parent = dirname(packageRoot)
  if (parent === packageRoot) throw new Error('无法定位 better-sqlite3 package.json')
  packageRoot = parent
}

const result = spawnSync('npm', ['run', 'build-release'], {
  cwd: packageRoot,
  env: {
    ...process.env,
    npm_config_runtime: 'node',
    npm_config_target: process.versions.node,
    npm_config_arch: process.arch,
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
