/** Resolve a configured ACP command to a real Windows executable, never a `.cmd` shim. */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

const REAL_EXTENSIONS = ['.exe', '.com'] as const

/** Find the existing `.exe`/`.com` named inside an npm `.cmd` shim. */
function shimTarget(shim: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  const directory = dirname(shim)
  for (const match of text.matchAll(/"([^"]+\.(?:exe|com))"/giu)) {
    const expanded = (match[1] as string).replace(/%~?dp0%?/giu, directory)
    const candidate = isAbsolute(expanded) ? expanded : resolve(directory, expanded)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve a configured command before the subprocess starts.
 *
 * On Windows only `.exe` and `.com` can start without a shell, so a `.cmd` or
 * `.bat` configuration is refused and a bare npm-installed name is resolved
 * through its shim to the real executable. A name that cannot be resolved is
 * left unchanged: the subprocess reports the usual startup failure.
 * @param command - configured command or path.
 * @param platform - host platform, injectable for tests.
 * @param path - PATH value used for the lookup, injectable for tests.
 * @returns the command to spawn.
 * @throws when the configured command is a `.cmd` or `.bat` shim.
 */
export function resolveCommand(command: string, platform: NodeJS.Platform = process.platform, path = String(process.env.PATH)): string {
  if (platform !== 'win32') return command
  const extension = extname(command).toLowerCase()
  if (extension === '.cmd' || extension === '.bat') {
    throw new Error(`ACP command "${command}" is a ${extension} shim; configure a real .exe or .com executable`)
  }
  if (extension === '.exe' || extension === '.com') return command
  if (/[\\/]/u.test(command)) return command
  const directories = path.split(delimiter).filter(entry => entry !== '')
  for (const directory of directories) {
    for (const suffix of REAL_EXTENSIONS) {
      const candidate = join(directory, `${command}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const directory of directories) {
    const shim = join(directory, `${command}.cmd`)
    if (!existsSync(shim)) continue
    const target = shimTarget(shim)
    if (target !== undefined) return target
  }
  return command
}
