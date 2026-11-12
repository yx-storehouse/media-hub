/*
 * 没有图（或者图还没来、来不了）时垫在下面的占位图：深灰的斜向渐变 + 一团淡淡的光，只有黑白灰。
 * 同一个 seed 每次都是同一张（角度、光斑位置由它决定），返回 CSS background-image 的值（Cover 的 fallback 就是这个）。
 *
 *   quietArt(creator.id)   // 创作者头图：还没有作品图时
 *   quietArt(url)          // 图集里的图：接口不给生成的占位图，加载前 / 外链在内网打不开时格子里不是一块死黑
 */
export function quietArt(seed) {
  let h = 2166136261
  for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const angle = 115 + (h % 60)
  const x = 12 + ((h >>> 6) % 72)
  const y = 18 + ((h >>> 13) % 46)
  return `radial-gradient(circle at ${x}% ${y}%, rgba(255, 255, 255, .13), rgba(255, 255, 255, 0) 58%), linear-gradient(${angle}deg, #2b2b2b, #151515 72%)`
}
