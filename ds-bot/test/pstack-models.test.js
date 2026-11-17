import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { parsePstackModelDefaults, parsePstackModelSettings, readPstackModelSettings } from '../src/host/pstack-models.js'

const rule = [
  '---',
  'description: Test settings format',
  'alwaysApply: true',
  '---',
  '# budget: large (xhigh)',
  'feature, refactoring: fixture-code-xhigh-fast',
  'how explorer: fixture-search-high',
  'how explainer: fixture-prose-xhigh',
  'reflect judgment, divergent, synthesizer: fixture-judge-max',
  'arena runners: fixture-first-high, fixture-second-high',
  'arena cross-judge pool: fixture-second-high, fixture-first-high',
  'architect runners: fixture-first-high, fixture-second-high',
  'interrogate reviewers: fixture-first-high, fixture-second-high',
  '',
].join('\n')
const skill = `---\nname: setup-pstack\n---\n# Setup fixture\n\n### 4. Validate\n\n\`\`\`\nnot the rule\n\`\`\`\n\n### 5. Write the rule\n\nUse this rule shape.\n\n\`\`\`\n${rule}\`\`\`\n\n### 6. Confirm\n\n\`\`\`\nnot the rule either\n\`\`\`\n`
const hash = value => createHash('sha256').update(value).digest('hex')
const defaults = () => parsePstackModelDefaults(skill)
const rowOf = (result, role) => result.rows.find(row => row.role === role)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-pstack-models-'))
  assert.ok(isAbsolute(root))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceFile = join(root, 'skills', 'setup-pstack', 'SKILL.md')
  const settingsFile = join(root, 'project-models.md')
  await mkdir(join(root, 'skills', 'setup-pstack'), { recursive: true })
  await writeFile(sourceFile, skill)
  return { root, sourceFile, settingsFile }
}

test('source defaults come only from the step 5 rule block and retain role labels', () => {
  const result = defaults()
  assert.equal(result.rows.length, 8)
  assert.equal(result.budget, 'large (xhigh)')
  assert.equal(result.defaultsHash, hash(rule))
  assert.deepEqual(rowOf(result, 'feature, refactoring'), { role: 'feature, refactoring', kind: 'single', origin: 'skill-default', values: ['fixture-code-xhigh-fast'] })
  assert.deepEqual(rowOf(result, 'reflect judgment, divergent, synthesizer').values, ['fixture-judge-max'])
  assert.equal(rowOf(result, 'arena runners').kind, 'panel')
  assert.equal(rowOf(result, 'interrogate reviewers').kind, 'panel')
  assert.equal(rowOf(result, 'arena cross-judge pool').kind, 'pool')
  assert.ok(!result.rows.some(row => ['description', 'alwaysApply'].includes(row.role)))
  assert.deepEqual(rowOf(parsePstackModelDefaults(skill.replaceAll('fixture-search-high', 'new-source-default')), 'how explorer').values, ['new-source-default'])
})

test('configuration preserves aliases, native route colons, panel duplicates and pool order', () => {
  const result = parsePstackModelSettings([
    '---', 'description: An optional Cursor header', 'alwaysApply: true', '---',
    '# budget: small (medium)',
    'feature, refactoring: provider/model:variant-medium-fast',
    'how explorer: auto',
    'how explainer: inherit-parent',
    'arena runners: auto, provider/model:variant, auto, inherit-parent',
    'arena cross-judge pool: inherit-parent, provider/judge:stable, provider/judge:stable',
    'architect runners: provider/only:one',
    'retired critics: do-not-return-this-value',
  ].join('\n'), defaults())
  assert.equal(result.budget, 'small (medium)')
  assert.deepEqual(rowOf(result, 'feature, refactoring').values, ['provider/model:variant-medium-fast'])
  assert.deepEqual(rowOf(result, 'how explorer').values, ['auto'])
  assert.deepEqual(rowOf(result, 'how explainer').values, ['inherit-parent'])
  assert.deepEqual(rowOf(result, 'arena runners').values, ['auto', 'provider/model:variant', 'auto', 'inherit-parent'])
  assert.deepEqual(rowOf(result, 'arena cross-judge pool').values, ['inherit-parent', 'provider/judge:stable', 'provider/judge:stable'])
  assert.equal(rowOf(result, 'arena cross-judge pool').kind, 'pool')
  assert.equal(rowOf(result, 'architect runners').kind, 'panel')
  assert.deepEqual(result.ignoredRoles, ['retired critics'])
  assert.ok(!JSON.stringify(result).includes('do-not-return-this-value'))
  assert.equal(rowOf(result, 'how explorer').origin, 'config')
  assert.equal(rowOf(result, 'interrogate reviewers').origin, 'skill-default')
})

test('missing role lines and budget retain defaults without mutating the defaults object', () => {
  const original = defaults()
  const result = parsePstackModelSettings('how explorer: custom-high', original)
  assert.equal(result.budget, original.budget)
  assert.equal(rowOf(result, 'how explorer').origin, 'config')
  assert.deepEqual(rowOf(result, 'how explainer'), rowOf(original, 'how explainer'))
  result.rows[0].values.push('changed')
  assert.equal(original.rows[0].values.length, 1)
  assert.deepEqual(parsePstackModelSettings('# All role lines removed.\n', original).rows, original.rows)
})

test('malformed known entries fail without exposing their values', () => {
  const cases = [
    'how explorer:',
    'how explorer: first\nhow explorer: sensitive-second',
    'how explorer: first, sensitive-second',
    'arena runners: first,',
    'arena runners: ,first',
    'arena runners: first,,second',
    'how explorer sensitive-value',
    '---\ndescription: sensitive-value',
    '# budget:',
    '# budget: large\n# budget: sensitive-value',
    'how explorer: sensitive\0value',
  ]
  for (const text of cases) {
    assert.throws(() => parsePstackModelSettings(text, defaults()), error => {
      assert.equal(error.code, 'bot/pstack-settings-invalid')
      assert.ok(!error.message.includes('sensitive'))
      return true
    })
  }
})

test('malformed source rules fail rather than using an embedded default table', () => {
  for (const text of [
    '# No step 5',
    '### 5. Write the rule\nNo fence',
    '### 5. Write the rule\n```\n# No roles\n```\n',
    skill.replace('how explorer: fixture-search-high', 'how explorer:'),
    skill.replace('how explorer: fixture-search-high', 'how explorer: one\nhow explorer: two'),
  ]) assert.throws(() => parsePstackModelDefaults(text), { code: 'bot/pstack-settings-invalid' })
})

test('CRLF source and leading BOM settings are supported', () => {
  const result = parsePstackModelDefaults(skill.replaceAll('\n', '\r\n'))
  assert.deepEqual(result.rows, defaults().rows)
  assert.equal(result.defaultsHash, hash(rule.replaceAll('\n', '\r\n')))
  assert.deepEqual(rowOf(parsePstackModelSettings('\uFEFF---\r\ndescription: header\r\n---\r\nhow explorer: auto\r\n', result), 'how explorer').values, ['auto'])
})

test('loader returns explicit missing settings with source provenance and never writes', async t => {
  const { root, sourceFile, settingsFile } = await fixture(t)
  const result = await readPstackModelSettings({ sourceRoot: root, settingsFile })
  assert.deepEqual(result.rows, defaults().rows)
  assert.deepEqual(result.ignoredRoles, [])
  assert.equal(result.settingsStatus, 'missing')
  assert.equal(result.settingsFile, settingsFile)
  assert.equal(result.settingsHash, null)
  assert.equal(result.sourceRoot, root)
  assert.equal(result.sourceFile, sourceFile)
  assert.equal(result.sourceHash, hash(skill))
  assert.equal(result.defaultsHash, hash(rule))
  await assert.rejects(readFile(settingsFile), { code: 'ENOENT' })
  const absentPath = await readPstackModelSettings({ sourceRoot: root })
  assert.equal(absentPath.settingsFile, null)
  assert.equal(absentPath.settingsStatus, 'missing')
  assert.deepEqual(absentPath.rows, defaults().rows)
})

test('loader hashes exact original files and reports unknown role names only', async t => {
  const { root, settingsFile, sourceFile } = await fixture(t)
  const text = '\uFEFF# budget: medium (high)\r\nhow explorer: provider/changed:fast\r\nold critics: sensitive-retired-value\r\n'
  await writeFile(settingsFile, text)
  const result = await readPstackModelSettings({ sourceRoot: root, settingsFile })
  assert.equal(result.settingsStatus, 'loaded')
  assert.equal(result.settingsHash, hash(text))
  assert.equal(result.budget, 'medium (high)')
  assert.deepEqual(result.ignoredRoles, ['old critics'])
  assert.ok(!JSON.stringify(result).includes('sensitive-retired-value'))
  assert.deepEqual(rowOf(result, 'how explorer').values, ['provider/changed:fast'])
  assert.equal(await readFile(settingsFile, 'utf8'), text)
  assert.equal(await readFile(sourceFile, 'utf8'), skill)
})

test('loader rejects relative paths, missing source and non-missing filesystem failures', async t => {
  const { root } = await fixture(t)
  await assert.rejects(readPstackModelSettings({ sourceRoot: 'relative-root' }), { code: 'bot/pstack-settings-invalid' })
  await assert.rejects(readPstackModelSettings({ sourceRoot: root, settingsFile: 'relative-settings' }), { code: 'bot/pstack-settings-invalid' })
  await assert.rejects(readPstackModelSettings({ sourceRoot: join(root, 'missing-source') }), { code: 'ENOENT' })
  await assert.rejects(readPstackModelSettings({ sourceRoot: root, settingsFile: root }), error => error.code !== 'ENOENT' && error.code !== 'bot/pstack-settings-invalid')
})

test('loader refuses malformed and invalid UTF-8 settings or source files', async t => {
  const { root, sourceFile, settingsFile } = await fixture(t)
  await writeFile(settingsFile, 'how explorer:')
  await assert.rejects(readPstackModelSettings({ sourceRoot: root, settingsFile }), { code: 'bot/pstack-settings-invalid' })
  await writeFile(settingsFile, Buffer.from([0xff]))
  await assert.rejects(readPstackModelSettings({ sourceRoot: root, settingsFile }), { code: 'bot/pstack-settings-invalid' })
  await writeFile(sourceFile, Buffer.from([0xff]))
  await assert.rejects(readPstackModelSettings({ sourceRoot: root }), { code: 'bot/pstack-settings-invalid' })
})
