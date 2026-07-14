import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pollManagedProcess, startManagedProcess, stopManagedProcess } from './tool-runner'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function waitForTerminal(runId: string, processId: string): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = pollManagedProcess(runId, processId, 0) as any
    if (result.status !== 'running') return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('process did not finish')
}

describe('managed process runner', () => {
  it('streams cursor-based output and retains a terminal transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owb-process-')); directories.push(directory)
    const started = startManagedProcess('run-1', "printf 'start'; sleep 0.05; printf 'end'", directory, 5_000) as any
    const terminal = await waitForTerminal('run-1', started.processId)
    expect(terminal).toMatchObject({ status: 'succeeded', exitCode: 0 })
    expect(terminal.fullOutput).toContain('start')
    expect(terminal.fullOutput).toContain('end')
    const tail = pollManagedProcess('run-1', started.processId, terminal.nextCursor) as any
    expect(tail.output).toBe('')
    expect(() => pollManagedProcess('other-run', started.processId, 0)).toThrow(/不属于当前任务/)
  })

  it('stops an active process without replaying it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owb-process-')); directories.push(directory)
    const started = startManagedProcess('run-stop', 'sleep 10', directory, 20_000) as any
    expect(stopManagedProcess('run-stop', started.processId)).toMatchObject({ status: 'stopped' })
    expect(pollManagedProcess('run-stop', started.processId, 0)).toMatchObject({ status: 'stopped' })
  })
})
