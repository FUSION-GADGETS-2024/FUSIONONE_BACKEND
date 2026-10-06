/**
 * Uploads the test store logo + signature to the store_assets bucket
 * (public URLs are referenced by the seeded store row).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
function loadEnv() {
  const raw = readFileSync(join(HERE, '.env'), 'utf8')
  return Object.fromEntries(raw.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
}
const env = loadEnv()

async function upload(name: string, bytes: Uint8Array, contentType: string) {
  const res = await fetch(`${env.TEST_SUPABASE_URL}/storage/v1/object/store_assets/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.TEST_SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.TEST_SUPABASE_SECRET_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: bytes,
  })
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`)
  console.log(`uploaded ${name} (${bytes.length} bytes)`)
}

// Logo: the compressed 256px FUSION ONE logo
const logo = new Uint8Array(readFileSync('/home/z/my-project/public/Logo_Rounded.png'))
await upload('test-store-logo.png', logo, 'image/png')

// Signature: a handwritten-style signature rendered with the backend canvas
const { createRequire } = await import('node:module')
const require = createRequire('/home/z/my-project/backend/node_modules/')
const { createCanvas } = require('/home/z/my-project/backend/node_modules/@napi-rs/canvas')
const canvas = createCanvas(300, 80)
const ctx = canvas.getContext('2d')
ctx.fillStyle = 'rgba(0,0,0,0)'
ctx.clearRect(0, 0, 300, 80)
ctx.strokeStyle = '#111111'
ctx.lineWidth = 2.4
ctx.lineCap = 'round'
// A simple flowing signature stroke
ctx.beginPath()
ctx.moveTo(18, 55)
ctx.bezierCurveTo(45, 12, 70, 12, 78, 42)
ctx.bezierCurveTo(84, 62, 96, 60, 112, 38)
ctx.bezierCurveTo(126, 20, 142, 22, 148, 40)
ctx.bezierCurveTo(154, 58, 168, 56, 184, 34)
ctx.bezierCurveTo(198, 18, 212, 24, 214, 40)
ctx.bezierCurveTo(216, 54, 232, 50, 248, 30)
ctx.bezierCurveTo(258, 22, 270, 28, 278, 36)
ctx.stroke()
ctx.lineWidth = 1.6
ctx.beginPath()
ctx.moveTo(96, 66)
ctx.quadraticCurveTo(180, 74, 262, 60)
ctx.stroke()
const sigPng = canvas.toBuffer('image/png')
await upload('test-store-signature.png', new Uint8Array(sigPng), 'image/png')
console.log('done')
