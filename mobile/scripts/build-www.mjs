#!/usr/bin/env node
/*
 * 生成启动页的 www/config.js（不入库）：默认服务器地址 + App 版本号。
 *
 * 默认服务器地址按顺序取：
 *   1. 环境变量 REEL_SERVER（GitHub Actions 里从仓库的 secret REEL_SERVER 传进来）
 *   2. mobile/.env.local 里的 REEL_SERVER=...（本机打包用，已被 .gitignore 忽略）
 *   3. 都没有：留空，App 第一次打开时让用户自己填
 *
 * 仓库是公开的，服务器地址只能放在这两个地方，不要写进代码。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 读 .env.local（KEY=VALUE，# 开头是注释，值两边的引号会去掉）。
 * Windows PowerShell 5 的 echo ... > 文件 会存成 UTF-16，记事本可能带 BOM，这两种也认。
 */
function readEnvLocal() {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return {}
  const buf = readFileSync(file)
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')
  const out = {}
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** 和启动页 normalize() 同样的规则：只接受 http / https，去掉末尾的 / */
function normalize(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s
  let u
  try { u = new URL(s) } catch { throw new Error(`REEL_SERVER 不是合法的地址：${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`REEL_SERVER 只能是 http:// 或 https:// 地址：${raw}`)
  if (u.username || u.password) throw new Error('REEL_SERVER 里不能带用户名和密码')
  return u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '')
}

const env = readEnvLocal()
const fromEnv = process.env.REEL_SERVER
const source = fromEnv != null && fromEnv !== '' ? '环境变量 REEL_SERVER' : env.REEL_SERVER ? 'mobile/.env.local' : ''
const server = normalize(source === 'mobile/.env.local' ? env.REEL_SERVER : fromEnv)

const config = { defaultServer: server, version: pkg.version }
writeFileSync(
  join(root, 'www', 'config.js'),
  '/* 由 scripts/build-www.mjs 生成，不要手改，也不要提交 */\n' +
  `window.REEL_CONFIG = ${JSON.stringify(config, null, 2)}\n`
)
// 公开仓库的 Actions 日志谁都能看，CI 里不打印地址
const where = process.env.CI ? '已设置' : server
console.log(server
  ? `启动页默认服务器：${where}（来自 ${source}），App ${pkg.version}`
  : `启动页没有默认服务器（没设置 REEL_SERVER），App 第一次打开时会让用户填写。App ${pkg.version}`)
