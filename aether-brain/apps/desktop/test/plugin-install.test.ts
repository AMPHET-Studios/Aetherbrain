import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../src/mcp/server.js'
import { lf } from './lf'

/**
 * The Claude plugin as a person meets it: the commands that install it (in the AI link panel, in the docs, in the plugin's README),
 * the marketplace file that makes them true (at the root of the repository, outside aether-brain/), the plugin's manifest, the
 * server it starts and the skill that teaches Claude to use it. A name that differs in one place is an install that fails, or a
 * skill that sends Claude to a tool that does not exist.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '../../..')
const REPO = path.resolve(APP, '..')
const read = (...p: string[]): string => lf(readFileSync(path.join(...p), 'utf8'))
const readJson = (...p: string[]): any => JSON.parse(read(...p))

const marketplace = readJson(REPO, '.claude-plugin', 'marketplace.json')
const entry = marketplace.plugins[0]
const pluginDir = path.resolve(REPO, entry.source)
const manifest = readJson(pluginDir, '.claude-plugin', 'plugin.json')
const appPackage = readJson(APP, 'apps', 'desktop', 'package.json')
const ownerAndRepo = /github\.com\/([^/]+\/[^/.]+)/.exec(appPackage.repository.url)![1]!

describe('the marketplace and the plugin', () => {
  it('has one plugin, found where the marketplace says, under the name the install command uses', () => {
    expect(marketplace.plugins).toHaveLength(1)
    expect(entry.source).toBe('./aether-brain/plugin/aether-brain')
    expect(existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(manifest.name).toBe(entry.name)
    expect(entry.name).toBe('aether-brain')
    expect(marketplace.name).toBe('aether-brain')
  })

  it('has the app’s version, in the manifest and in the marketplace (bumped with the release)', () => {
    expect(manifest.version).toBe(appPackage.version)
    expect(entry.version).toBe(appPackage.version)
  })

  it('starts the bridge that is in it, with Node, from the plugin’s own folder', () => {
    const mcp = readJson(pluginDir, '.mcp.json')
    const server = mcp.mcpServers['aether-brain']
    expect(server.command).toBe('node')
    expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/bridge.mjs'])
    expect(existsSync(path.join(pluginDir, 'bin', 'bridge.mjs'))).toBe(true)
  })

  it('ships no dependencies and no build: the bridge imports Node’s own modules only', () => {
    const src = read(pluginDir, 'bin', 'bridge.mjs')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(3)
    for (const spec of imports) expect(spec, spec).toMatch(/^node:/)
    expect(existsSync(path.join(pluginDir, 'package.json'))).toBe(false)
    expect(existsSync(path.join(pluginDir, 'node_modules'))).toBe(false)
  })
})

describe('the install commands', () => {
  // In a terminal; inside an interactive Claude Code session the same two take a leading slash.
  const add = `claude plugin marketplace add ${ownerAndRepo}`
  const install = `claude plugin install ${entry.name}@${marketplace.name}`

  it('are the same in the app’s panel, the guide, the plugin’s README and the main README', () => {
    const panel = read(APP, 'apps', 'desktop', 'src', 'renderer', 'components', 'AiLinkPanel.tsx')
    expect(panel).toContain(`'${add}\\n${install}'`)
    for (const file of [[APP, 'docs', 'AI-LINK.md'], [pluginDir, 'README.md']] as const) {
      const text = read(...file)
      expect(text, file.join('/')).toContain(add)
      expect(text, file.join('/')).toContain(install)
      // The same two inside Claude Code.
      expect(text, file.join('/')).toContain(`/plugin marketplace add ${ownerAndRepo}`)
      expect(text, file.join('/')).toContain(`/plugin install ${entry.name}@${marketplace.name}`)
    }
    const readme = read(APP, 'README.md')
    expect(readme).toContain(add)
    expect(readme).toContain(install)
  })

  it('name the repository the app is built from', () => {
    expect(ownerAndRepo).toBe('YEASTINFECTIONCHEESE/desktop-tutorial')
  })
})

describe('the skill', () => {
  const skill = read(pluginDir, 'skills', 'aether-brain', 'SKILL.md')

  it('has a name and a description that says when to use it', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? ''
    expect(front).toMatch(/^name: aether-brain$/m)
    expect(front).toMatch(/^description: .*Use when/m)
  })

  it('names only tools that exist, with the arguments they take', () => {
    const named = new Set([...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!))
    const arguments_ = new Set(['max_px'])
    const real = new Set<string>([...Object.keys(TOOLS), 'aether_brain_status'])
    expect(named.size).toBeGreaterThan(10)
    for (const n of named) expect(real.has(n) || arguments_.has(n), `${n} is not a tool`).toBe(true)
    // The plugin's three, and the status tool, are the ones it is about.
    for (const n of ['find_pictures', 'get_image', 'show_in_brain', 'save_image', 'aether_brain_status']) expect(named.has(n), n).toBe(true)
  })

  it('keeps the companion’s promises: nothing diagnosed, no medication changes, ask before remembering', () => {
    expect(skill).toMatch(/never diagnose or advise changing medication/)
    expect(skill).toMatch(/ask before remembering anything personal/i)
  })
})
