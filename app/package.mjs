// Build "MK10 Studio.app" (arm64) into dist/. `npm run package`.
// Signing: APP_IDENTITY (codesign identity name or SHA-1, a Developer ID Application cert) signs it with
// the hardened runtime. Notarizing: also set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
// Without APP_IDENTITY the app is unsigned. `set -a; source ../.env` (or the exports in it) first.
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const env = process.env
const sign = env.APP_IDENTITY
const notarize = sign && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID

console.log('compiling native/build/hidtap (swiftc)…')
mkdirSync('native/build', { recursive: true })
execFileSync('swiftc', ['-O', 'native/hidtap.swift', '-o', 'native/build/hidtap'], { stdio: 'inherit', timeout: 120_000 })

console.log(`packaging: ${sign ? 'signed' : 'UNSIGNED'}${notarize ? ' + notarized (takes a few minutes)' : ''}`)
const [dir] = await packager({
  dir: '.',
  out: 'dist',
  overwrite: true,
  platform: 'darwin',
  arch: 'arm64',
  name: 'MK10 Studio',
  appBundleId: 'com.robvella.mk10studio',
  appCategoryType: 'public.app-category.developer-tools',
  asar: { unpack: '**/{*.node,native/build/hidtap}' },
  ignore: [/^\/dist($|\/)/, /^\/\.env/, /\.test\.js$/, /^\/eslint\.config\.js$/, /^\/package\.mjs$/, /\/prebuilds\/(?!darwin)/, /^\/node_modules\/monaco-editor\/(esm|dev|min-maps)($|\/)/],
  extendInfo: { NSAppleEventsUsageDescription: 'MK10 Studio runs AppleScripts and controls other apps when you press keys set up to do that.' },
  osxSign: sign ? { identity: sign, optionsForFile: () => ({ hardenedRuntime: true, entitlements: 'entitlements.plist' }) } : undefined,
  osxNotarize: notarize ? { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID } : undefined,
})
console.log(`built ${dir}/MK10 Studio.app`)
