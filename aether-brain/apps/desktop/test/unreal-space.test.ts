import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const unreal = path.resolve(here, '../../../unreal')
const plugin = path.join(unreal, 'AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain')
const read = (p: string) => readFileSync(p, 'utf8')

/** A C++ compiler on this computer (the Unreal world's maths and actor run as ordinary C++ here), or null. */
function compiler(): string | null {
  for (const c of [process.env['CXX'], 'c++', 'g++', 'clang++']) {
    if (c && spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) return c
  }
  return null
}
const cxx = process.platform === 'win32' ? null : compiler()

describe.skipIf(!cxx)('the Unreal space world, run as plain C++', () => {
  it('passes its maths tests and the actor harness (strict warnings, two stages)', () => {
    const run = spawnSync('sh', [path.join(unreal, 'tests/run.sh')], { env: { ...process.env, CXX: cxx! }, encoding: 'utf8', timeout: 280_000 })
    const out = `${run.stdout}${run.stderr}`
    expect(out).toMatch(/\d+ checks, 0 failed[\s\S]*\d+ checks, 0 failed/)
    expect(run.status).toBe(0)
  }, 300_000)
})

describe('the Unreal space world, wiring', () => {
  const python = read(path.join(unreal, 'AetherBrainViewer/Content/Python/init_unreal.py'))

  it('has a material for everything the C++ loads by name, made by the editor script', () => {
    const cpp = read(path.join(plugin, 'Private/AetherSpaceActor.cpp')) + read(path.join(plugin, 'Private/AetherBrainActor.cpp'))
    const loaded = new Set([...cpp.matchAll(/\/Game\/AetherBrain\/(M_\w+)\.\1/g)].map((m) => m[1]))
    expect([...loaded].sort()).toEqual(['M_AetherNode', 'M_AetherRock', 'M_AetherSprite'])
    for (const name of loaded) {
      expect(python).toContain(`"${name}"`)
    }
    // Packaged builds cook the folder they live in.
    expect(read(path.join(unreal, 'AetherBrainViewer/Config/DefaultGame.ini'))).toContain('/Game/AetherBrain')
  })

  it('names the material parameter the sprites set (Tex) the same in C++ and Python', () => {
    expect(read(path.join(plugin, 'Private/AetherSpaceActor.cpp'))).toContain('SetTextureParameterValue(TEXT("Tex")')
    expect(python).toContain('set_editor_property("parameter_name", "Tex")')
  })

  it('reads four floats of per-instance data, like the materials', () => {
    expect(read(path.join(plugin, 'Private/AetherSpaceActor.cpp'))).toContain('SetNumCustomDataFloats(4)')
    // Indexes 0-3 read once each in the sky material and in the rock material (the node material has its own helper).
    expect([...python.matchAll(/_custom_data\(mel, material, [0-3],/g)]).toHaveLength(8)
  })

  it('has a key and a HUD line for the space', () => {
    expect(read(path.join(plugin, 'Private/AetherBrainPlayerController.cpp'))).toContain('EKeys::B')
    expect(read(path.join(plugin, 'Private/AetherBrainHUD.cpp'))).toContain('Space: %s')
  })
})
