#!/usr/bin/env node
/*
 * 生成 App 图标 / 启动图的源图（mobile/assets/*.png），再交给 @capacitor/assets 生成各尺寸（npm run assets）。
 *
 * 图案就是网页版左上角的吉祥物（src/components/AppLogo.vue），黑底白图，和 public/icon-512.png 一致：
 *   icon-only.png        1024² 不透明，iOS 图标和安卓旧版图标
 *   icon-foreground.png  1024² 透明底，安卓自适应图标的前景（图案在中间安全区内）
 *   icon-background.png  1024² 纯 #0a0a0a，安卓自适应图标的背景
 *   splash.png / splash-dark.png  2732² 启动图（安卓 12 以前的启动画面、iOS 启动图）
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
// sharp 是 @capacitor/assets 带进来的依赖
let sharp
try { sharp = require('sharp') } catch { sharp = createRequire(require.resolve('@capacitor/assets'))('sharp') }

const BG = '#0a0a0a'

/* 和 AppLogo.vue 一样的图形（viewBox 0 0 100 70）：两只胶片「耳朵」+ 笑脸 + 播放角标 */
const holes = [0, 72, 144, 216, 288].map(a => {
  const t = (a - 90) * Math.PI / 180
  return [(Math.cos(t) * 11.6).toFixed(1), (Math.sin(t) * 11.6).toFixed(1)]
})
const ear = cx => `<g transform="translate(${cx} 25)">
  <circle r="19" fill="#fff" stroke="${BG}" stroke-width="3.2"/>
  <circle r="5" fill="${BG}"/>
  ${holes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6" fill="${BG}"/>`).join('')}
</g>`
const MASCOT = `${ear(20)}${ear(80)}
<ellipse cx="50" cy="38" rx="27" ry="26" fill="#fff" stroke="${BG}" stroke-width="3.2"/>
<path d="M36 33q4-4 8 0M56 33q4-4 8 0M44 47q6 4 12 0" stroke="${BG}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
<circle cx="63" cy="56" r="10.5" fill="${BG}" stroke="#fff" stroke-width="2.2"/>
<path d="M60.4 51.8v8.4l7.2-4.2z" fill="#fff"/>`

/** size² 的画布，图案宽 = size × widthRatio，居中 */
function svg(size, widthRatio, { background = true } = {}) {
  const w = size * widthRatio
  const s = w / 100
  const x = (size - w) / 2
  const y = (size - 70 * s) / 2
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${background ? `<rect width="${size}" height="${size}" fill="${BG}"/>` : ''}
<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">${MASCOT}</g>
</svg>`)
}

const out = join(root, 'assets')
mkdirSync(out, { recursive: true })
const write = (name, buf) => sharp(buf).png({ compressionLevel: 9 }).toFile(join(out, name)).then(() => console.log('  ' + name))

console.log('生成图标源图 → mobile/assets/')
await Promise.all([
  // 方形图标：图案占 70% 宽（和 public/icon-512.png 差不多）
  write('icon-only.png', svg(1024, 0.70)),
  // 自适应图标前景：@capacitor/assets 会把整张图缩进中间 72/108 的可见区（inset 16.7%），
  // 各家桌面再裁成圆 / 方圆；图案占 72% 宽时最远的点离中心 0.38，在 66dp 安全圆（0.46）以内
  write('icon-foreground.png', svg(1024, 0.72, { background: false })),
  write('icon-background.png', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${BG}"/></svg>`)),
  // 启动图：小一点放在正中
  write('splash.png', svg(2732, 0.22)),
  write('splash-dark.png', svg(2732, 0.22))
])
