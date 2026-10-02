/**
 * Installed games and programs: folders a brain of notes and pictures has no
 * use for (a game's thousands of textures and icons would flood it with
 * moons). Pure, shared by the scan, the watcher and the MCP server.
 *
 * A folder is left out when its name is a game library's (`SteamLibrary`,
 * `Epic Games`, …) or when what sits directly in it shows an install: a
 * store's or engine's marker file, an uninstaller, or a program's `.exe`
 * with its DLLs. The user can keep any of them (FsVault `keep`).
 */

/** Lowercased folder names of game libraries and launchers, and Windows leftovers on data drives. */
export const GAME_DIRS: ReadonlySet<string> = new Set([
  'steamlibrary',
  'steam library',
  'steam',
  'epic games',
  'epicgames',
  'xboxgames',
  'xbox games',
  'gog games',
  'gog galaxy',
  'riot games',
  'ea games',
  'origin games',
  'rockstar games',
  'ubisoft',
  'ubisoft game launcher',
  'battle.net',
  'blizzard games',
  'amazon games',
  'windows.old',
  'wpsystem',
  'modifiablewindowsapps',
  'onedrivetemp',
  'msdownld.tmp',
  'found.000',
])

/** What sits directly in an installed game or program, and what that says it is. */
const MARKERS: ReadonlyMap<string, string> = new Map([
  ['steamapps', 'Steam library'],
  ['libraryfolder.vdf', 'Steam library'],
  ['steam_api.dll', 'Steam game'],
  ['steam_api64.dll', 'Steam game'],
  ['steam_appid.txt', 'Steam game'],
  ['.egstore', 'Epic game'],
  ['unityplayer.dll', 'Unity game'],
  ['unitycrashhandler64.exe', 'Unity game'],
  ['unitycrashhandler32.exe', 'Unity game'],
  ['uplay_install.state', 'Ubisoft game'],
  ['__installer', 'EA game'],
  ['.build.info', 'Battle.net game'],
  ['microsoftgame.config', 'Xbox game'],
  ['appxmanifest.xml', 'Store app'],
  ['unins000.exe', 'installed program'],
  ['unins000.dat', 'installed program'],
])

const GOG = /^goggame-\d+\.(info|ico|dll|hashdb)$/
/** A program's own DLLs next to its `.exe`: this many make an install folder. */
const PROGRAM_DLLS = 3

/** Windows drops trailing dots and spaces from names; compare without them, lowercased. */
const nameKey = (name: string): string => name.replace(/[. ]+$/, '').toLowerCase()

/** True for a folder name of GAME_DIRS. */
export function isGameDirName(name: string): boolean {
  return GAME_DIRS.has(nameKey(name))
}

/**
 * What an install folder is (`Steam game`, `installed program`, …) from the
 * names directly inside it, or null when it does not look like one. A
 * shipped Unreal game is an `Engine` folder next to an `.exe`.
 */
export function installKind(names: Iterable<string>): string | null {
  let exe = false
  let dlls = 0
  let engine = false
  for (const raw of names) {
    const name = raw.toLowerCase()
    const marker = MARKERS.get(name)
    if (marker) return marker
    if (GOG.test(name)) return 'GOG game'
    if (name.endsWith('.exe')) exe = true
    else if (name.endsWith('.dll')) dlls++
    else if (name === 'engine') engine = true
  }
  if (exe && engine) return 'Unreal game'
  if (exe && dlls >= PROGRAM_DLLS) return 'installed program'
  return null
}

/** True for a file whose arrival can turn its folder into an install (the watcher looks at the folder again). */
export function isInstallMarker(name: string): boolean {
  const lower = name.toLowerCase()
  return MARKERS.has(lower) || GOG.test(lower) || lower.endsWith('.exe') || lower.endsWith('.dll')
}
