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

describe.skipIf(!cxx)('the Unreal space world and Niagara layer, run as plain C++', () => {
  it('passes the maths tests and the actor harnesses of both (strict warnings, four stages)', () => {
    const run = spawnSync('sh', [path.join(unreal, 'tests/run.sh')], { env: { ...process.env, CXX: cxx! }, encoding: 'utf8', timeout: 280_000 })
    const out = `${run.stdout}${run.stderr}`
    expect(out.match(/\d+ checks, 0 failed/g)).toHaveLength(4)
    expect(out).not.toMatch(/FAIL /)
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

describe('the Unreal Niagara layer, wiring', () => {
  const cpp = read(path.join(plugin, 'Private/AetherFxActor.cpp'))
  const doc = read(path.join(unreal, '../docs/UNREAL-NIAGARA.md'))
  const python = read(path.join(unreal, 'AetherBrainViewer/Content/Python/init_unreal.py'))

  it('names the same five systems in the C++, the editor script and the recipes', () => {
    const inCpp = [...cpp.matchAll(/\/Game\/AetherFX\/(NS_\w+)\.\1/g)].map((m) => m[1]!)
    expect(inCpp).toEqual(['NS_AetherPulses', 'NS_AetherCorona', 'NS_AetherDust', 'NS_AetherShootingStars', 'NS_AetherRipple'])
    const listed = python.match(/FX_SYSTEMS = \[([^\]]*)\]/)![1]!
    expect([...listed.matchAll(/"(NS_\w+)"/g)].map((m) => m[1]).sort()).toEqual([...inCpp].sort())
    for (const name of inCpp) {
      expect(doc).toContain(`### \`${name}\``)
      expect(cpp).toContain(`TEXT("${name}")`)
    }
  })

  it('sets only User parameters the recipes document, with the types they name', () => {
    const params = new Set([...cpp.matchAll(/TEXT\("User\.(\w+)"\)/g)].map((m) => m[1]!))
    expect([...params].sort()).toEqual(['Color', 'Duration', 'End', 'Extent', 'Intensity', 'Radius', 'Size', 'SpawnRate', 'Start', 'Width'])
    for (const p of params) expect(doc).toMatch(new RegExp(`\`${p}\``))
    // Start and End are Positions (the default of the actor), Extent a size, always a Vector.
    expect(doc).toMatch(/`Start`, `End` \| \*\*Position\*\*/)
    expect(doc).toMatch(/`Extent` \| \*\*Vector\*\*/)
    expect(cpp).toContain('C->SetVariableVec3(P.Extent')
    expect(read(path.join(plugin, 'Public/AetherFxActor.h'))).toContain('bool bPositionParameters = true;')
  })

  it('has a key, a HUD line, a game mode spawn, the module and plugin dependencies, and the cook folder', () => {
    expect(read(path.join(plugin, 'Private/AetherBrainPlayerController.cpp'))).toContain('EKeys::N')
    expect(read(path.join(plugin, 'Private/AetherBrainHUD.cpp'))).toContain('Effects: on')
    expect(read(path.join(plugin, 'Private/AetherBrainGameMode.cpp'))).toContain('SpawnActor<AAetherFxActor>')
    expect(read(path.join(plugin, 'AetherBrain.Build.cs'))).toContain('"Niagara"')
    expect(read(path.join(plugin, '../../AetherBrain.uplugin'))).toContain('"Name": "Niagara"')
    expect(read(path.join(unreal, 'AetherBrainViewer/AetherBrainViewer.uproject'))).toContain('"Name": "Niagara"')
    expect(read(path.join(unreal, 'AetherBrainViewer/Config/DefaultGame.ini'))).toContain('/Game/AetherFX')
  })

  it('keeps the plugin and the app on one version', () => {
    const version = (JSON.parse(read(path.join(unreal, '../package.json'))) as { version: string }).version
    expect((JSON.parse(read(path.join(plugin, '../../AetherBrain.uplugin'))) as { VersionName: string }).VersionName).toBe(version)
  })
})

describe('the Windows packaging script', () => {
  const bat = read(path.join(unreal, 'PackageWindows.bat'))

  it('packages this project, and checks for what the editor makes on its first start', () => {
    expect(bat).toContain('AetherBrainViewer\\AetherBrainViewer.uproject')
    expect(bat).toContain('RunUAT.bat')
    const uat = bat.split(/\r\n/).find((l) => l.includes('BuildCookRun')) ?? ''
    for (const flag of ['-platform=Win64', '-build', '-cook', '-stage', '-pak', '-archive', '-archivedirectory=']) expect(uat).toContain(flag)
    // The map and the glow material named in the script are the ones the editor script and the config use.
    const python = read(path.join(unreal, 'AetherBrainViewer/Content/Python/init_unreal.py'))
    expect(python).toContain('MAP = FOLDER + "/Maps/Brain"')
    expect(bat).toContain('Content\\AetherBrain\\Maps\\Brain.umap')
    expect(python).toContain('FOLDER = "/Game/AetherBrain"')
    expect(python).toContain('"M_AetherNode"')
    expect(bat).toContain('Content\\AetherBrain\\M_AetherNode.uasset')
    expect(read(path.join(unreal, 'AetherBrainViewer/Config/DefaultEngine.ini'))).toContain('GameDefaultMap=/Game/AetherBrain/Maps/Brain.Brain')
    // The engine version of the project is the one the script looks for.
    expect(read(path.join(unreal, 'AetherBrainViewer/AetherBrainViewer.uproject'))).toContain('"EngineAssociation": "5.8"')
    expect(bat).toContain('UE_5.8')
  })

  it('is a Windows batch file: CRLF line endings, every goto has its label, nothing runs past its end', () => {
    expect(bat).toContain('\r\n')
    expect(bat.replace(/\r\n/g, '').includes('\n')).toBe(false)
    const labels = new Set([...bat.matchAll(/^:(\w+)\s*$/gm)].map((m) => m[1]))
    for (const m of bat.matchAll(/goto :(\w+)/g)) expect(labels.has(m[1]!)).toBe(true)
    // A parenthesis inside a block's echo would end the block early: the script uses no blocks.
    expect(bat).not.toMatch(/^\s*\(/m)
    // Every path through the script ends in exit /b.
    expect(bat.trimEnd().endsWith('exit /b 1')).toBe(true)
  })
})

describe('the Unreal version on the release page', () => {
  const app = path.resolve(unreal, '..')
  const workflow = read(path.join(app, '..', '.github/workflows/desktop.yml'))
  const start = read(path.join(unreal, 'START-HERE.txt'))

  it('has steps a person can follow, naming the files that are in the zip', () => {
    expect(start).toContain('unreal\\AetherBrainViewer\\AetherBrainViewer.uproject')
    expect(start).toContain('unreal\\PackageWindows.bat')
    expect(start).toContain('Unreal Engine 5.8')
    expect(start).toContain('Visual Studio 2022')
  })

  it('is zipped by the Windows job on every run and attached to the release', () => {
    for (const f of ['unreal/AetherBrainViewer', 'unreal/PackageWindows.bat', 'unreal/README.md', 'unreal/START-HERE.txt', 'docs/UNREAL.md', 'docs/UNREAL-NIAGARA.md', 'docs/img/unreal-*.png']) {
      expect(workflow).toContain(f)
    }
    // The zip step runs before the artifact upload and the release attach, which both list it.
    const zip = workflow.indexOf('Zip the Unreal version')
    const upload = workflow.indexOf('Upload run artifact')
    const attach = workflow.indexOf('Attach to release')
    expect(zip).toBeGreaterThan(0)
    expect(zip).toBeLessThan(upload)
    expect(upload).toBeLessThan(attach)
    expect(workflow.match(/AetherBrain-Unreal-\*\.zip/g)?.length).toBeGreaterThanOrEqual(2)
    // Every file it copies exists in the repository.
    for (const f of ['unreal/PackageWindows.bat', 'unreal/README.md', 'unreal/START-HERE.txt', 'docs/UNREAL.md', 'docs/UNREAL-NIAGARA.md']) expect(() => read(path.join(app, f))).not.toThrow()
  })
})

