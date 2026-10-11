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

describe.skipIf(!cxx)('the Unreal space world, Niagara layer and brain viewer maths, run as plain C++', () => {
  it('passes the maths tests and the actor harnesses (strict warnings, twelve stages)', () => {
    const run = spawnSync('sh', [path.join(unreal, 'tests/run.sh')], { env: { ...process.env, CXX: cxx! }, encoding: 'utf8', timeout: 560_000 })
    const out = `${run.stdout}${run.stderr}`
    expect(out.match(/\d+ checks, 0 failed/g)).toHaveLength(12)
    expect(out).not.toMatch(/FAIL /)
    expect(run.status).toBe(0)
  }, 600_000)
})

/**
 * What the anonymous namespaces of a .cpp declare at their top level, and the namespace aliases it makes. Unreal's unity build
 * joins .cpp files into one translation unit, where two anonymous namespaces are one: a type or constant with the same name in
 * two files, or a function with the same name AND parameter types, is an error there that a one-file build never shows
 * (overloads are fine).
 */
export function topLevelNames(src: string): { names: Set<string>; aliases: Map<string, string> } {
  const names = new Set<string>()
  const aliases = new Map<string, string>()
  for (const m of src.matchAll(/^namespace\s+(\w+)\s*=\s*([\w:]+);/gm)) aliases.set(m[1]!, m[2]!)
  const keywords = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'static_cast', 'const_cast', 'reinterpret_cast', 'TEXT', 'noexcept', 'alignof', 'decltype'])
  const open = /^namespace\s*\r?\n?\{/gm
  let m: RegExpExecArray | null
  while ((m = open.exec(src))) {
    let depth = 1
    let i = m.index + m[0].length
    let top = ''
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]!
      if (c === '{') {
        depth++
        if (depth === 2) top += '{'
      } else if (c === '}') {
        depth--
      } else if (depth === 1) {
        top += c
      }
    }
    const code = top.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
    for (const k of code.matchAll(/\b(?:struct|class|enum(?:\s+class)?)\s+(\w+)/g)) names.add(`type ${k[1]!}`)
    // A function: its name and the types (not the names) of its parameters.
    for (const k of code.matchAll(/\b(\w+)\s*\(([^()]*)\)\s*(?:const\s*)?(?:noexcept\s*)?[{;]/g)) {
      if (keywords.has(k[1]!)) continue
      const params = k[2]!
        .split(',')
        .map((p) => p.replace(/=.*$/, '').trim().split(/\s+/).slice(0, -1).join(' ').replace(/\s*([*&])\s*/g, '$1'))
        .join(',')
      names.add(`fn ${k[1]!}(${params})`)
    }
    for (const k of code.matchAll(/\b(\w+)\s*=\s*[^=]/g)) names.add(`var ${k[1]!}`)
  }
  return { names, aliases }
}

describe('the Unreal actors in one unity build', () => {
  it('finds a helper two files both declare (the check works)', () => {
    const a = 'namespace\n{\n\tvoid Helper(int X)\n\t{\n\t}\n\tconstexpr int Limit = 3;\n}\n'
    const b = 'namespace Sp = AetherSpace;\nnamespace\n{\n\tdouble Helper(double Y) { return Y; }\n\tstruct Thing { int A; };\n}\n'
    const na = topLevelNames(a)
    const nb = topLevelNames(b)
    expect([...na.names].sort()).toEqual(['fn Helper(int)', 'var Limit'])
    // The same name with other parameter types is an overload, not a clash.
    expect([...nb.names].sort()).toEqual(['fn Helper(double)', 'type Thing'])
    const c = topLevelNames('namespace\n{\n\tvoid Helper(int Z)\n\t{\n\t}\n}\n')
    expect([...c.names]).toEqual(['fn Helper(int)'])
    expect([...na.names].filter((n) => c.names.has(n))).toEqual(['fn Helper(int)'])
    expect(nb.aliases.get('Sp')).toBe('AetherSpace')
  })

  it('has no helper name in two of the actors\' .cpp files, and no namespace alias that means two things', () => {
    const files = ['AetherBrainActor.cpp', 'AetherScene.cpp', 'AetherSpaceActor.cpp', 'AetherFxActor.cpp', 'AetherVoyageActor.cpp', 'AetherBrainPlayerController.cpp', 'AetherBrainHUD.cpp', 'AetherBrainGameMode.cpp']
    const seen = new Map<string, string>()
    const aliasOf = new Map<string, { target: string; file: string }>()
    for (const f of files) {
      const { names, aliases } = topLevelNames(read(path.join(plugin, 'Private', f)))
      for (const n of names) {
        const other = seen.get(n)
        expect(other === undefined || other === f, `${n} is declared in ${other} and in ${f}`).toBe(true)
        seen.set(n, f)
      }
      for (const [a, target] of aliases) {
        const old = aliasOf.get(a)
        expect(old === undefined || old.target === target, `namespace ${a} is ${old?.target} in ${old?.file} and ${target} in ${f}`).toBe(true)
        aliasOf.set(a, { target, file: f })
      }
    }
    expect(seen.size).toBeGreaterThan(20)
  })
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

describe('the Unreal voyage, wiring', () => {
  const cpp = read(path.join(plugin, 'Private/AetherVoyageActor.cpp'))
  const python = read(path.join(unreal, 'AetherBrainViewer/Content/Python/init_unreal.py'))

  it('has a material for everything the voyage loads by name, made by the editor script', () => {
    const loaded = new Set([...cpp.matchAll(/\/Game\/AetherBrain\/(M_\w+)\.\1/g)].map((m) => m[1]!))
    expect([...loaded].sort()).toEqual(['M_AetherCard', 'M_AetherCorona', 'M_AetherGlass', 'M_AetherHull', 'M_AetherLight', 'M_AetherNode', 'M_AetherRock', 'M_AetherRockPBR', 'M_AetherSky', 'M_AetherSun'])
    for (const name of loaded) expect(python).toContain(`"${name}"`)
    // Every one of the eight new ones has its own maker that the start-up calls.
    for (const maker of ['make_sky_material', 'make_sun_material', 'make_corona_material', 'make_hull_material', 'make_rock_pbr_material', 'make_glass_material', 'make_light_material', 'make_card_material']) {
      expect(python.match(new RegExp(`def ${maker}\\(`))).not.toBeNull()
      expect(python).toContain(`make_${maker.slice(5)}`.replace('make_make_', 'make_'))
      expect(python.split(maker).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('sets only material parameters the editor script makes, under the same names', () => {
    const textures = new Set([...cpp.matchAll(/SetTextureParameterValue\(TEXT\("(\w+)"\)/g)].map((m) => m[1]!))
    expect([...textures].sort()).toEqual(['BaseColor', 'Normal', 'ORM', 'Sky', 'Sun', 'Tex'])
    for (const t of textures) expect(python).toContain(`"${t}"`)
    const scalars = new Set([...cpp.matchAll(/SetScalarParameterValue\(TEXT\("(\w+)"\)/g)].map((m) => m[1]!))
    expect([...scalars].sort()).toEqual(['Glow', 'Gain', 'Intensity'].sort())
    for (const sc of scalars) expect(python).toContain(`"${sc}"`)
    // The light colour is turned into a vertex colour by this divisor, and the material multiplies it back by its default Intensity.
    expect(cpp).toContain('constexpr double VoyLightMax = 9.0;')
    expect(python).toMatch(/_scalar\(mel, material, "Intensity", 9\.0/)
  })

  it('needs the procedural mesh and image modules and plugin, and is spawned and flown by the usual actors', () => {
    expect(read(path.join(plugin, 'AetherBrain.Build.cs'))).toContain('"ProceduralMeshComponent"')
    expect(read(path.join(plugin, 'AetherBrain.Build.cs'))).toContain('"ImageWrapper"')
    expect(read(path.join(plugin, '../../AetherBrain.uplugin'))).toContain('"Name": "ProceduralMeshComponent"')
    expect(read(path.join(unreal, 'AetherBrainViewer/AetherBrainViewer.uproject'))).toContain('"Name": "ProceduralMeshComponent"')
    expect(read(path.join(plugin, 'Private/AetherBrainGameMode.cpp'))).toContain('SpawnActor<AAetherVoyageActor>')
    expect(read(path.join(plugin, 'Private/AetherBrainPlayerController.cpp'))).toContain('EKeys::V')
    expect(read(path.join(plugin, 'Private/AetherBrainPlayerController.cpp'))).toContain('StepVoyage')
    expect(read(path.join(plugin, 'Private/AetherBrainHUD.cpp'))).toContain('Voyage to %s')
  })

  it('asks the desktop app for a folder\'s picture at the address the companion link serves', () => {
    expect(cpp).toContain('/v1/thumb?id=%s&size=%d')
    expect(read(path.join(here, '../src/main/companion.ts'))).toContain("'/v1/thumb': 'GET'")
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

