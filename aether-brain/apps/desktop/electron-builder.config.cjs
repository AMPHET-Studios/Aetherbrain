// electron-builder configuration for Aether Brain.
// Produces: Windows NSIS installer + single-file portable .exe, macOS dmg/zip,
// Linux AppImage/deb. Run from apps/desktop: `pnpm dist:win` (or dist / pack).
const isWin = process.platform === 'win32'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.aetherbrain.desktop',
  productName: 'Aether Brain',
  copyright: 'Aether Brain contributors',
  asar: true,
  npmRebuild: false,
  // No cloud publish: artifacts land in ./release only.
  publish: null,
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  // Everything the app needs at runtime is in dist/ (tsc main + preload, Vite renderer)
  // plus the one production dependency (chokidar), which electron-builder adds itself.
  files: ['dist/**/*', 'package.json', '!dist/**/*.map', '!dist/*-unpacked/**'],
  extraMetadata: {
    // Electron reads `main` from the packaged package.json.
    main: 'dist/main/main.js',
  },
  artifactName: 'AetherBrain-${version}-${os}-${arch}.${ext}',
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.png',
    // Editing the exe's icon/version resources needs rcedit, which needs wine
    // off-Windows. Skip it there so Linux/macOS hosts can still produce a
    // working (generic-icon) Windows build; CI builds on Windows get the icon.
    signAndEditExecutable: isWin,
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Aether Brain',
    artifactName: 'AetherBrain-Setup-${version}-${arch}.${ext}',
  },
  portable: {
    artifactName: 'AetherBrain-Portable-${version}-${arch}.${ext}',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    icon: 'build/icon.png',
    hardenedRuntime: false,
    identity: null,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    category: 'Office',
    icon: 'build/icon.png',
    maintainer: 'Aether Brain contributors',
    // Default would be the sanitized package name ('@aetherdesktop').
    executableName: 'aether-brain',
  },
}
