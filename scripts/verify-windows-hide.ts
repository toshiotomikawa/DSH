/**
 * Fails when a child-process call in `scripts/` or a package's `src/` does not ask Windows to keep
 * the new console hidden. Without `windowsHide`, a parent with no visible console (an agent shell,
 * a gate runner, a scheduled task) makes Windows flash a console window for every child and steal
 * focus from the person using the machine.
 *
 * Allowed shapes: an options object literal with `windowsHide`, or an options identifier that
 * resolves to one in the same file. Anything else is a violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const FUNCTIONS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'])
const SOURCE = /\.(?:ts|mts|cts)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', '.dsh-test', 'coverage'])

type Violation = { file: string; line: number; name: string; reason: string }

function collect(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(full, into)
    else if (SOURCE.test(entry.name)) into.push(full)
  }
}

function packageSources(into: string[]): void {
  const packages = path.join(ROOT, 'packages')
  for (const group of readdirSync(packages, { withFileTypes: true })) {
    if (!group.isDirectory() || SKIP_DIRS.has(group.name)) continue
    const source = path.join(packages, group.name)
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const src = path.join(source, entry.name, 'src')
      try {
        if (statSync(src).isDirectory()) collect(src, into)
      } catch {
        // no src directory
      }
    }
  }
}

function childProcessLocals(source: ts.SourceFile) {
  const locals = new Map<string, string>()
  let namespace: string | null = null
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return
    if (!['node:child_process', 'child_process'].includes(node.moduleSpecifier.text)) return
    const clause = node.importClause
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        locals.set(element.name.text, (element.propertyName ?? element.name).text)
      }
    } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespace = clause.namedBindings.name.text
    }
  })
  return { locals, namespace }
}

function declaredOptions(source: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null
  function visit(node: ts.Node): void {
    if (found) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function hasWindowsHide(node: ts.Expression | null): boolean {
  let current = node
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression
  }
  if (!current || !ts.isObjectLiteralExpression(current)) return false
  return current.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'windowsHide') ||
        (ts.isStringLiteralLike(property.name) && property.name.text === 'windowsHide')),
  )
}

function check(file: string): Violation[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const { locals, namespace } = childProcessLocals(source)
  if (locals.size === 0 && !namespace) return []
  const violations: Violation[] = []
  const relative = path.relative(ROOT, file).replaceAll('\\', '/')

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      let name: string | null = null
      if (ts.isIdentifier(node.expression) && locals.has(node.expression.text)) {
        name = locals.get(node.expression.text) ?? null
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === namespace
      ) {
        name = node.expression.name.text
      }
      if (name && FUNCTIONS.has(name)) {
        const args = [...node.arguments]
        const last = args.at(-1)
        if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) args.pop()
        const options = [...args].reverse().find(argument => ts.isObjectLiteralExpression(argument)) ?? null
        const tail = args.at(-1)
        const identifier = !options && tail && ts.isIdentifier(tail) ? tail : null
        const resolved = identifier ? declaredOptions(source, identifier.text) : null
        const hidden = hasWindowsHide(options ?? resolved)
        if (!hidden) {
          violations.push({
            file: relative,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            name,
            reason: options || resolved || identifier ? 'options without windowsHide' : 'no options object',
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

const files: string[] = []
collect(path.join(ROOT, 'scripts'), files)
packageSources(files)

const violations = files.flatMap(check)
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.name} — ${violation.reason}`)
  }
  console.error(`verify-windows-hide: ${violations.length} child-process call(s) must set windowsHide: true`)
  process.exitCode = 1
} else {
  console.log(`verify-windows-hide: ${files.length} files clean.`)
}
