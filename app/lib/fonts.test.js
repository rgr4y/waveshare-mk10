import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fontInfo, fontInfoFile } from './fonts.js'

// macOS system fonts: one plain TrueType, one collection
const ARIAL_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
const HELVETICA = '/System/Library/Fonts/Helvetica.ttc'

test('fontInfo reads family, weight and italic from a .ttf', { skip: !existsSync(ARIAL_BOLD) && 'no macOS Arial' }, () => {
  const f = fontInfo(readFileSync(ARIAL_BOLD))
  assert.ok(f.families.includes('Arial'), f.families.join())
  assert.equal(f.weight, 700)
  assert.equal(f.italic, false)
})

test('fontInfo reads the first face of a .ttc', { skip: !existsSync(HELVETICA) && 'no macOS Helvetica' }, () => {
  assert.ok(fontInfo(readFileSync(HELVETICA)).families.includes('Helvetica'))
})

test('fontInfoFile (ranged reads) matches fontInfo (whole file)', { skip: !existsSync(HELVETICA) && 'no macOS fonts' }, async () => {
  for (const f of [ARIAL_BOLD, HELVETICA]) assert.deepEqual(await fontInfoFile(f), fontInfo(readFileSync(f)))
})
