// 把 icon-master.jpg 缩放出 PWA 标准图标：192/512 PNG + apple-touch-icon(180)
import { Jimp } from 'jimp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pub = path.resolve(__dirname, '../public')
const src = path.join(pub, 'icon-master.jpg')

const img = await Jimp.read(src)
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]
for (const [name, size] of targets) {
  const resized = img.clone().resize({ w: size, h: size })
  await resized.write(path.join(pub, name))
  console.log('wrote', name, size)
}
