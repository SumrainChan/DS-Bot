import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const invalid = message => Object.assign(new Error(`Invalid pstack model settings: ${message}`), { code: 'bot/pstack-settings-invalid' })
const kindOf = role => role.endsWith(' pool') ? 'pool' : / (runners|reviewers)$/.test(role) ? 'panel' : 'single'

function entriesOf(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw invalid('expected UTF-8 text without null characters.')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let start = lines.findIndex(line => line.trim() !== '')
  if (start === -1) return { entries: [], budget: undefined }
  if (lines[start].trim() === '---') {
    const end = lines.findIndex((line, index) => index > start && line.trim() === '---')
    if (end === -1) throw invalid('unclosed leading frontmatter.')
    start = end + 1
  }
  const entries = []
  let budget
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      const match = /^#\s*budget\s*:(.*)$/.exec(line)
      if (match) {
        if (budget !== undefined || match[1].trim() === '') throw invalid(`invalid budget at line ${index + 1}.`)
        budget = match[1].trim()
      }
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) throw invalid(`expected a role entry at line ${index + 1}.`)
    entries.push({ role: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), line: index + 1 })
  }
  return { entries, budget }
}

function valuesOf(entry, kind) {
  const values = entry.value.split(',').map(value => value.trim())
  if (values.some(value => value === '') || (kind === 'single' && values.length !== 1)) {
    throw invalid(`invalid role value at line ${entry.line}.`)
  }
  return values
}

export function parsePstackModelDefaults(sourceText) {
  if (typeof sourceText !== 'string') throw invalid('expected setup Skill text.')
  const step = /^###\s+5\.\s+[^\r\n]*\r?\n([\s\S]*?)(?=^###\s|$(?![\s\S]))/m.exec(sourceText)
  if (!step) throw invalid('setup Skill is missing step 5.')
  const fence = /^(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^\1[ \t]*\r?$/m.exec(step[1])
  if (!fence) throw invalid('setup step 5 is missing its rule code block.')
  const { entries, budget } = entriesOf(fence[2])
  if (entries.length === 0) throw invalid('source rule contains no roles.')
  const seen = new Set()
  const rows = entries.map(entry => {
    if (seen.has(entry.role)) throw invalid(`duplicate source role at line ${entry.line}.`)
    seen.add(entry.role)
    const kind = kindOf(entry.role)
    return { role: entry.role, kind, origin: 'skill-default', values: valuesOf(entry, kind) }
  })
  return { rows, budget, defaultsHash: hash(fence[2]) }
}

export function parsePstackModelSettings(text, defaults) {
  const { entries, budget } = entriesOf(text)
  const known = new Map(defaults.rows.map(row => [row.role, row]))
  const overrides = new Map()
  const ignoredRoles = new Set()
  for (const entry of entries) {
    const row = known.get(entry.role)
    if (row === undefined) {
      ignoredRoles.add(entry.role)
      continue
    }
    if (overrides.has(entry.role)) throw invalid(`duplicate known role at line ${entry.line}.`)
    overrides.set(entry.role, valuesOf(entry, row.kind))
  }
  return {
    rows: defaults.rows.map(row => ({ ...row, values: [...(overrides.get(row.role) ?? row.values)], origin: overrides.has(row.role) ? 'config' : 'skill-default' })),
    budget: budget ?? defaults.budget,
    ignoredRoles: [...ignoredRoles],
  }
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw invalid('file is not valid UTF-8.') }
}

export async function readPstackModelSettings({ sourceRoot, settingsFile } = {}) {
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)) throw invalid('sourceRoot must be an explicit absolute path.')
  if (settingsFile !== undefined && (typeof settingsFile !== 'string' || !isAbsolute(settingsFile))) throw invalid('settingsFile must be an explicit absolute path.')
  const sourceFile = join(sourceRoot, 'skills', 'setup-pstack', 'SKILL.md')
  const source = await readFile(sourceFile)
  const defaults = parsePstackModelDefaults(decode(source))
  let settings
  if (settingsFile !== undefined) {
    try { settings = await readFile(settingsFile) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const parsed = settings === undefined
    ? { rows: defaults.rows, budget: defaults.budget, ignoredRoles: [] }
    : parsePstackModelSettings(decode(settings), defaults)
  return {
    ...parsed,
    sourceRoot,
    sourceFile,
    sourceHash: hash(source),
    defaultsHash: defaults.defaultsHash,
    settingsFile: settingsFile ?? null,
    settingsStatus: settings === undefined ? 'missing' : 'loaded',
    settingsHash: settings === undefined ? null : hash(settings),
  }
}
