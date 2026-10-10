// 由 src/mock/random.js 同步而来：只做两处改动——去掉 @/mock/random 别名、追加 CommonJS 导出。
// 服务端与前端共用同一套随机数与占位图生成逻辑，保证两边数据完全一致。
/** FNV-1a string hash -> uint32 */
export function hash(s) {
  let h = 2166136261
  s = String(s)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Seeded LCG: the same seed always yields the same sequence (stable mock data across reloads). */
export function rng(seed) {
  let s = (typeof seed === 'number' ? seed : hash(seed)) >>> 0 || 1
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)]
