#!/usr/bin/env node
/*
 * 生成 iOS 的 App 图标和启动图（写进 ios/App/App/Assets.xcassets），源图是 scripts/make-icon-sources.mjs 生成的 assets/*.png。
 * npm run assets 会先生成源图、安卓的图标，再跑这个脚本。
 *
 *   AppIcon-512@2x.png  1024² 图标。App Store 不接受带透明通道的图标，这里铺上底色、去掉 alpha
 *   Splash.imageset     2732² 启动图（LaunchScreen.storyboard 按「填满屏幕」显示）。
 *                       吉祥物的大小、位置和启动页（www/）第一屏的图标对齐（按 iPhone 15/16 算），
 *                       从系统启动画面切到启动页时图标不跳
 *
 * 不用 @capacitor/assets 生成 iOS：它的图标保留透明通道，启动图的图案大小也对不上启动页。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
// sharp 是 @capacitor/assets 带进来的依赖
let sharp
try { sharp = require('sharp') } catch { sharp = createRequire(require.resolve('@capacitor/assets'))('sharp') }

const BG = { r: 10, g: 10, b: 10 }   // #0a0a0a，和网页版、启动页一样
const catalog = join(root, 'ios', 'App', 'App', 'Assets.xcassets')
const src = name => join(root, 'assets', name)

/*
 * 启动页第一屏（www/launcher.css）：图标宽 112pt，「图标 + Reel + 状态文字」一起在安全区里居中。
 * 在 393×852pt 的 iPhone 上图标中心比屏幕中心高约 30pt。启动图按屏幕高度缩放（2732 → 852），换算成启动图上的像素：
 */
const SIZE = 2732
const PHONE_H = 852
const MARK_W = Math.round(112 / PHONE_H * SIZE)      // ≈ 359px
const MARK_UP = Math.round(30 / PHONE_H * SIZE)      // ≈ 96px
// icon-foreground.png 是 1024² 透明底，图案占 72% 宽、在正中
const FG_SCALE = MARK_W / (1024 * 0.72)
const FG = Math.round(1024 * FG_SCALE)

async function main() {
  console.log('生成 iOS 图标、启动图 → ios/App/App/Assets.xcassets/')

  const iconDir = join(catalog, 'AppIcon.appiconset')
  mkdirSync(iconDir, { recursive: true })
  await sharp(src('icon-only.png')).resize(1024, 1024).flatten({ background: BG }).removeAlpha()
    .png({ compressionLevel: 9 }).toFile(join(iconDir, 'AppIcon-512@2x.png'))
  writeFileSync(join(iconDir, 'Contents.json'), JSON.stringify({
    images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 }
  }, null, 2) + '\n')
  console.log('  AppIcon.appiconset/AppIcon-512@2x.png')

  const splashDir = join(catalog, 'Splash.imageset')
  mkdirSync(splashDir, { recursive: true })
  const mark = await sharp(src('icon-foreground.png')).resize(FG, FG).png().toBuffer()
  const splash = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: BG } })
    .composite([{ input: mark, left: Math.round((SIZE - FG) / 2), top: Math.round((SIZE - FG) / 2) - MARK_UP }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer()
  // 和 Capacitor 模板一样：1x / 2x / 3x 都是同一张 2732² 的图
  const files = ['splash-2732x2732-2.png', 'splash-2732x2732-1.png', 'splash-2732x2732.png']
  for (const f of files) writeFileSync(join(splashDir, f), splash)
  writeFileSync(join(splashDir, 'Contents.json'), JSON.stringify({
    images: files.map((filename, i) => ({ idiom: 'universal', filename, scale: `${i + 1}x` })),
    info: { author: 'xcode', version: 1 }
  }, null, 2) + '\n')
  console.log('  Splash.imageset/' + files.join(', '))
}

main().catch(e => { console.error(e); process.exit(1) })
