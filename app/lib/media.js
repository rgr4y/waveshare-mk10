// Media conversion via system ffmpeg (Homebrew). Targets match the stock theme assets
// (docs/theme-format.md, Device verification): keys 128x128 PNG; bg video h264 Main@4.1
// 640x256 yuv420p 25 fps, no audio.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
export const KEY_PX = 128
export const VIDEO = { w: 640, h: 256, fps: 25 }

async function viaFfmpeg(args, ext) {
  const dir = await mkdtemp(join(tmpdir(), 'mk10studio-'))
  const out = join(dir, `out.${ext}`)
  try {
    await run(FFMPEG, ['-y', '-loglevel', 'error', ...args, out], { timeout: 600_000 })
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// cover-crop to a square, then scale; first frame only (GIF animation is a later phase)
export const toKeyPng = (input) => viaFfmpeg([
  '-i', input, '-frames:v', '1',
  '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${KEY_PX}:${KEY_PX}:flags=lanczos`,
], 'png')

// any audio ffmpeg reads -> 48 kHz stereo 16-bit WAV: the codec's native rate, so the stock firmware's
// tinyplay (no resampling) plays it at the right speed too
export const toDeviceWav = (input, channels = 2) => viaFfmpeg(['-i', input, '-vn', '-ac', String(channels), '-ar', '48000', '-c:a', 'pcm_s16le'], 'wav')

// cover-crop to 640x256, re-encode to what videoplayerinterfaceAPP played in testing
export const toDeviceMp4 = (input) => viaFfmpeg([
  '-i', input, '-an',
  '-vf', `scale=${VIDEO.w}:${VIDEO.h}:force_original_aspect_ratio=increase,crop=${VIDEO.w}:${VIDEO.h},fps=${VIDEO.fps},format=yuv420p`,
  '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.1', '-movflags', '+faststart',
], 'mp4')
