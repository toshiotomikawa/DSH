import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCommand } from '../src/command.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'acp-command-'))
  roots.push(root)
  return root
}

async function fakeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'stub')
}

describe('ACP command resolution', () => {
  it('leaves non-Windows hosts, explicit executables and paths unchanged', () => {
    expect(resolveCommand('opencode', 'linux', '')).toBe('opencode')
    expect(resolveCommand('C:\\tools\\agent.exe', 'win32', '')).toBe('C:\\tools\\agent.exe')
    expect(resolveCommand('C:\\tools\\agent.com', 'win32', '')).toBe('C:\\tools\\agent.com')
    expect(resolveCommand('C:\\tools\\agent', 'win32', '')).toBe('C:\\tools\\agent')
  })

  it('refuses .cmd and .bat shims outright', () => {
    expect(() => resolveCommand('opencode.cmd', 'win32', '')).toThrow('real .exe or .com')
    expect(() => resolveCommand('C:\\tools\\opencode.bat', 'win32', '')).toThrow('real .exe or .com')
  })

  it('prefers a real executable next to the bare name', async () => {
    const first = await directory()
    const second = await directory()
    await writeFile(join(second, 'opencode.exe'), 'stub')
    expect(resolveCommand('opencode', 'win32', `${first};${second}`)).toBe(join(second, 'opencode.exe'))
  })

  it('resolves an npm .cmd shim to the real executable it names', async () => {
    const root = await directory()
    await mkdir(join(root, 'node_modules', '@opencode', 'cli', 'bin'), { recursive: true })
    const executable = join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    await writeFile(executable, 'stub')
    await writeFile(
      join(root, 'opencode.cmd'),
      '@ECHO off\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n',
    )
    expect(resolveCommand('opencode', 'win32', root)).toBe(executable)
  })

  it('keeps the bare name when no shim reaches an existing executable', async () => {
    const root = await directory()
    await writeFile(join(root, 'opencode.cmd'), '@ECHO off\r\n"%dp0%\\missing.exe" %*\r\n')
    expect(resolveCommand('opencode', 'win32', root)).toBe('opencode')
    const empty = await directory()
    expect(resolveCommand('opencode', 'win32', empty)).toBe('opencode')
  })

  it('skips a wrapper shim that only points at another shim', async () => {
    const wrapper = await directory()
    const real = await directory()
    await fakeExecutable(join(real, 'bin', 'opencode.exe'))
    await writeFile(join(wrapper, 'opencode.cmd'), '@ECHO off\r\n"%APPDATA%\\npm\\opencode.cmd" %*\r\n')
    await writeFile(join(real, 'opencode.cmd'), '@ECHO off\r\n"%dp0%\\bin\\opencode.exe" %*\r\n')
    expect(resolveCommand('opencode', 'win32', `${wrapper};${real}`)).toBe(join(real, 'bin', 'opencode.exe'))
  })

  it('ignores an unreadable shim and resolves a relative target from the shim directory', async () => {
    const broken = await directory()
    await mkdir(join(broken, 'opencode.cmd'))
    expect(resolveCommand('opencode', 'win32', broken)).toBe('opencode')
    const relative = await directory()
    await fakeExecutable(join(relative, 'bin', 'opencode.exe'))
    await writeFile(join(relative, 'opencode.cmd'), '@ECHO off\r\n"bin\\opencode.exe" %*\r\n')
    expect(resolveCommand('opencode', 'win32', relative)).toBe(join(relative, 'bin', 'opencode.exe'))
  })
})
