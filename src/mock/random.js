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
