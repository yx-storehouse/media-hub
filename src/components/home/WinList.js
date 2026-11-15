import { defineComponent, h, Fragment, Comment, cloneVNode, shallowRef, onMounted, onUpdated, onActivated, onDeactivated, onBeforeUnmount } from 'vue'

/*
 * 长列表窗口化（首页分类 / 最新、社区、专题、搜索、创作者主页的无限滚动列表）：
 * 列表很长时只把视口上下几屏以内的项渲染成真卡片，其余的收起来：滚到两三千条也只挂着几十张卡片，
 * DOM、内存不再跟着条数一直涨，下一页也不越来越慢。
 *
 *   <div v-rise class="grid g16">
 *     <WinList ref="win" :items="feed.list" :min="600" v-slot="{ item: v, index: i, revived }">
 *       <VideoCard :video="v" />
 *     </WinList>
 *   </div>
 *
 * 渲染出来就是一项一个元素（没有外包的一层）：网格、v-rise、ContentSwap、按 data-vid 找卡片（hero、返回时的焦点）都照旧。
 * - 不到 min 条时什么也不做，全部照常渲染（几百条以内的列表一直挂着更顺：滚动时不用现挂卡片）；超过以后才开始收。
 * - 列表按 CHUNK 条分成一段一段（WinChunk，各自是一个小组件）。整段都在窗口外的收成一个占位（.wl-ph.wl-sp，网格里占满整行），
 *   窗口边上那一段里窗口外的项各自换成一个同高的占位（.wl-ph）；挪窗口、补挂卡片时只重新渲染动到的那一两段，
 *   浏览器也只排这几十个元素（不是几千个格子）。占位的高度都是这一项上次真的渲染出来时量的（含外边距、行距，不取整），
 *   收起 / 放回时排版不动，滚动位置、KeepAlive 切回来的位置、返回恢复的位置都准。
 * - 窗口：视口上下各 KEEP 屏。视口上下 NEED 屏以内不全在窗口里了才挪窗口。窗口挪过去时，视口附近（上下各 VIEW 屏）
 *   的马上挂成真卡片；其余的每帧挂几张（fill：视频卡片 FILL 张，帖子卡片重、一帧只挂一张），朝着滚动的方向、
 *   离视口近的先挂。滚动中一帧里不会一下挂好几张卡片（快速往回甩时帧更匀）。
 * - 键盘焦点所在的那一项不收。
 * - 窗口宽度变了（转屏、拉窗口）：已渲染的重新量，没渲染的按同样的比例估，滚到它们时再按真实的高度改。
 * - revived：这一项收起过、现在又放回来（往回滚）：帖子卡片据此不再播入场。
 * - 返回恢复（专题、搜索、创作者主页不常驻）：离开前 snapshot() 存一份（每项的高度 + 当时的窗口），
 *   回来时传给 restore，第一次渲染就只挂窗口里的那一段，不会先把几千张卡片全挂上再收。
 * 滚动区是离列表最近的 .scroll。只读排版、不改样式；读都在 requestAnimationFrame 里（一帧最多一次）。
 */

/* 默认不到这么多条不窗口化（视频卡片）；帖子卡片（一张几十个元素、带图）重得多，帖子列表用 POST_WIN */
const MIN = 600
export const POST_WIN = 150
/* 窗口：视口上下各 KEEP 屏；视口上下 NEED 屏以内有不在窗口里的就挪窗口 */
const NEED = 2
const KEEP = 3
/* 视口上下各这么多屏以内的：窗口挪过去时马上挂成真卡片 */
const VIEW = 0.25
/* 其余的每帧挂这么多张（视频卡片；帖子卡片 min 用 POST_WIN 的，默认一帧一张） */
const FILL = 3
/* 一段多少条：1–6 列的网格都能整行切开（整段收起时占满整行，不会把一行切成两半） */
const CHUNK = 60
const MEMO = Object.freeze([])
const NONE = new Set()

/* 一段：渲染第 c 段的那些项（怎么渲染由 WinList 决定）；v 变了才重新渲染 */
const WinChunk = defineComponent({
  name: 'WinChunk',
  props: { c: { type: Number, required: true }, v: { type: Number, default: 0 }, ctx: { type: Object, required: true } },
  setup(props) {
    return () => h(Fragment, props.ctx.renderChunk(props.c))
  }
})

/* 带 memo 的 vnode（和 v-memo 一样）：Vue 不会因为它已经挂上过就复制一份，下次渲染还是同一个对象，patch 直接跳过 */
function still(vn) {
  vn.memo = MEMO
  return vn
}

export default defineComponent({
  name: 'WinList',
  inheritAttrs: false,
  props: {
    /** 列表数据（整个数组，按顺序） */
    items: { type: Array, default: () => [] },
    /** 每一项的唯一键 */
    itemKey: { type: Function, default: x => x?.id },
    /** 超过这么多条才窗口化 */
    min: { type: Number, default: MIN },
    /** 返回恢复：上次 snapshot() 的结果 */
    restore: { type: Object, default: null },
    /** 窗口里没挂上的每帧补挂几张；不传时视频卡片 FILL 张，帖子卡片（min ≤ POST_WIN）一张 */
    fill: { type: Number, default: null }
  },
  setup(props, { slots, expose }) {
    const itemKey = props.itemKey
    const keyOf = item => String(itemKey(item))
    /* 当前的列表（渲染时记下；段里读它，不经过响应式） */
    let list = []
    let keys = []
    /* 窗口（下标，含两端）；null = 全部渲染 */
    let range = null
    /* 窗口里已经挂成真卡片的 key */
    const shown = new Set()
    /* 每一段的版本号：要重新渲染哪一段就给它 +1，再让 ver +1（WinList 重新渲染，把新的版本号传下去） */
    const chunkV = []
    const ver = shallowRef(0)
    /* key → 外框高度（含上下外边距）、上外边距、下外边距 */
    const hs = new Map()
    const mts = new Map()
    const mbs = new Map()
    /* 收起过的 key（再放回来时 revived） */
    const far = new Set()
    /* 和 items 对齐：每一项（边框）在滚动区内容里的上沿，收起成整段占位的那些保留上次量的（跟着占位一起挪） */
    let tops = []
    /* 每一项最近一次渲染出来的 vnode（整段收起的为 null）；每一段的整段占位 { H, vn }；每一段里渲染成真卡片的 key */
    const nodes = []
    const spv = []
    const realBy = []
    /* 网格的列数、行距（量出来的；一列的列表行距是 0，间距在外边距里） */
    let cols = 0
    let rowGap = 0
    /* 上一次渲染里有没有还没量过高度的真卡片（新的一页）：有才需要重新量；有没有段因为位置还没量过没能整段收起 */
    let unmeasured = true
    let blocked = false
    /* 占位的 vnode：key → { h, vn }，高度没变就原样复用 */
    const phs = new Map()
    let box = null
    let boxW = 0
    let scroller = null
    let raf = 0
    let dirty = true
    let live = true
    /* 最近一次滚动的方向（1 往下、-1 往上、0 还没滚过）：补挂时先挂前进方向上的 */
    let lastTop = -1
    let dir = 0

    const chunkOf = i => Math.floor(i / CHUNK)
    const touch = i => { chunkV[chunkOf(i)] = (chunkV[chunkOf(i)] || 0) + 1 }
    const touchAll = () => { for (let c = 0; c < chunkV.length; c++) chunkV[c] = (chunkV[c] || 0) + 1 }
    const windowed = () => !!range && list.length > props.min
    const hOf = i => hs.get(keys[i]) ?? 0
    const mtOf = i => mts.get(keys[i]) || 0

    // 返回恢复：键对得上（同一份列表）才用
    const r0 = props.restore
    if (r0 && Array.isArray(r0.keys) && r0.keys.length === props.items.length && r0.keys.every((k, i) => k === keyOf(props.items[i]))) {
      r0.keys.forEach((k, i) => {
        if (r0.hs[i] != null) hs.set(k, r0.hs[i])
        if (r0.mts?.[i]) mts.set(k, r0.mts[i])
        if (r0.mbs?.[i]) mbs.set(k, r0.mbs[i])
      })
      for (const k of r0.far || []) far.add(k)
      boxW = r0.w || 0
      cols = r0.cols || 0
      rowGap = r0.gap || 0
      if (Array.isArray(r0.tops) && r0.tops.length === r0.keys.length) tops = r0.tops.slice()
      if (r0.lo != null && props.items.length > props.min) {
        range = { lo: r0.lo, hi: r0.hi }
        for (let i = r0.lo; i <= r0.hi && i < r0.keys.length; i++) shown.add(r0.keys[i])
      }
    }

    /* 列表换了（翻页、刷新、原地更新）：哪一段里的东西变了就重新渲染哪一段 */
    function setList(next) {
      const old = list
      const oldKeys = keys
      list = next
      keys = next.map(keyOf)
      if (!next.length) {
        // 清空（换筛选、刷新）：之前量的都作废
        hs.clear()
        mts.clear()
        mbs.clear()
        far.clear()
        phs.clear()
        shown.clear()
        spv.length = 0
        range = null
        tops = []
      } else {
        // 不只是接在后面（中间有项删掉 / 换了）：从变的地方往后的位置作废，下一帧重新量
        let same = 0
        while (same < oldKeys.length && same < keys.length && oldKeys[same] === keys[same]) same++
        if (same < oldKeys.length) {
          tops.length = Math.min(tops.length, same)
          dirty = true
        }
      }
      const count = Math.ceil(next.length / CHUNK)
      for (let c = 0; c < count; c++) {
        const s = c * CHUNK
        const e = Math.min(s + CHUNK, next.length)
        let same = Math.min(s + CHUNK, old.length) === e
        for (let i = s; same && i < e; i++) if (old[i] !== next[i]) same = false
        if (!same) chunkV[c] = (chunkV[c] || 0) + 1
      }
      chunkV.length = count
      spv.length = Math.min(spv.length, count)
      realBy.length = count
      nodes.length = next.length
      if (tops.length > next.length) tops.length = next.length
    }

    /* 整段收起时占位多高：从这一段第一项的外边距上沿，到下一段第一项的外边距上沿（再减去网格的行距：占位自己占一行，行距照常有）。
       位置还没量全、或者列数切不整齐时返回 null（这一段就一项一个占位） */
    function spacerH(s, e) {
      const n = list.length
      if (!(cols > 0) || CHUNK % cols !== 0) return null
      for (let i = s; i < e; i++) if (tops[i] == null || !hs.has(keys[i])) return null
      const start = tops[s] - mtOf(s)
      let end
      if (e < n) {
        if (tops[e] == null) return null
        end = tops[e] - mtOf(e) - rowGap
      } else {
        end = -Infinity
        for (let i = s; i < e; i++) end = Math.max(end, tops[i] - mtOf(i) + hOf(i))
      }
      const H = Math.round((end - start) * 1000) / 1000
      return H > 0 ? H : null
    }

    /* 渲染第 c 段 */
    function renderChunk(c) {
      const s = c * CHUNK
      const e = Math.min(s + CHUNK, list.length)
      const r = windowed() ? range : null
      // 整段都在窗口外：收成一个占位
      if (r && (e - 1 < r.lo || s > r.hi)) {
        const H = spacerH(s, e)
        if (H != null) {
          let p = spv[c]
          if (!p || p.H !== H) p = spv[c] = { H, vn: still(h('div', { key: 'sp', class: 'wl-ph wl-sp', 'aria-hidden': 'true', style: `grid-column:1/-1;height:${H}px` })) }
          for (let i = s; i < e; i++) nodes[i] = null
          realBy[c] = NONE
          return [p.vn]
        }
        blocked = true
      }
      spv[c] = null
      const out = []
      const real = new Set()
      for (let i = s; i < e; i++) {
        const item = list[i]
        const k = keys[i]
        const ht = r && !(i >= r.lo && i <= r.hi && shown.has(k)) ? hs.get(k) : undefined
        if (ht != null) {
          let p = phs.get(k)
          if (!p || p.h !== ht) {
            p = { h: ht, vn: still(h('div', { key: `ph:${k}`, class: 'wl-ph', 'aria-hidden': 'true', style: `height:${ht}px` })) }
            phs.set(k, p)
          }
          nodes[i] = p.vn
          out.push(p.vn)
          continue
        }
        phs.delete(k)
        real.add(k)
        if (!hs.has(k)) unmeasured = true
        const vn = (slots.default ? slots.default({ item, index: i, revived: far.has(k) }) : []).find(n => n.type !== Comment)
        const node = !vn ? h('div', { key: `ph:${k}`, class: 'wl-ph' }) : vn.key != null ? vn : cloneVNode(vn, { key: `it:${k}` })
        nodes[i] = node
        out.push(node)
      }
      realBy[c] = real
      return out
    }
    const ctx = { renderChunk }

    function onScroll() {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { dirty = true; onScroll() }) : null

    function observe() {
      if (!ro) return
      ro.disconnect()
      if (scroller) ro.observe(scroller)
      if (box) ro.observe(box)
    }

    function frame() {
      raf = 0
      if (!live) return
      if (scroller) {
        const st = scroller.scrollTop
        if (lastTop >= 0 && Math.abs(st - lastTop) > 1) dir = st > lastTop ? 1 : -1
        lastTop = st
      }
      if (dirty && measure()) dirty = false
      let more = false
      if (update()) more = fill()
      if (more && !raf) raf = requestAnimationFrame(frame)
    }

    const ready = () => !!scroller && !!box && box.isConnected && !!scroller.clientHeight && !!box.clientWidth && tops.length === list.length

    /* 第一个挂着的元素（找容器、滚动区用） */
    function firstEl() {
      for (const n of nodes) if (n && n.el instanceof Element) return n.el
      for (const p of spv) if (p && p.vn.el instanceof Element) return p.vn.el
      return null
    }

    /* 量：每一项的位置，渲染着的那些的高度。返回 false 表示现在量不了（页面收起、这一栏藏着） */
    function measure() {
      const n = list.length
      if (!n) {
        tops = []
        return true
      }
      const first = firstEl()
      if (!first || !first.isConnected) return false
      if (first.parentElement !== box) {
        box = first.parentElement
        observe()
      }
      const sc = box.closest('.scroll')
      if (sc !== scroller) {
        scroller?.removeEventListener('scroll', onScroll)
        scroller = sc
        scroller?.addEventListener('scroll', onScroll, { passive: true })
        observe()
      }
      if (!scroller || !scroller.clientHeight || !box.clientWidth) return false
      const w = box.clientWidth
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop
      const cs = getComputedStyle(box)
      rowGap = cs.display.includes('grid') ? parseFloat(cs.rowGap) || 0 : 0
      const resized = boxW && Math.abs(w - boxW) > 0.5
      if (resized) {
        mts.clear()
        mbs.clear()
      }
      let oldSum = 0
      let newSum = 0
      let stale = false
      const real = new Set()
      const next = tops.slice(0, n)
      next.length = n
      for (let c = 0; c * CHUNK < n; c++) {
        const s = c * CHUNK
        const e = Math.min(s + CHUNK, n)
        const p = spv[c]
        if (p) {
          // 整段占位：这一段里各项的位置跟着占位一起挪（宽度变了就作废，下一轮一项一个占位重新量）
          const el = p.vn.el
          let gap = resized || !(el instanceof Element)
          for (let i = s; !gap && i < e; i++) if (next[i] == null) gap = true
          if (gap) {
            // 位置作废了：这一段先一项一个占位重新渲染，下一轮量
            for (let i = s; i < e; i++) next[i] = null
            spv[c] = null
            chunkV[c] = (chunkV[c] || 0) + 1
            stale = true
            continue
          }
          const delta = el.getBoundingClientRect().top - base - (next[s] - mtOf(s))
          if (Math.abs(delta) > 0.001) for (let i = s; i < e; i++) if (next[i] != null) next[i] += delta
          continue
        }
        for (let i = s; i < e; i++) {
          const el = nodes[i]?.el
          if (!(el instanceof Element)) continue
          const rect = el.getBoundingClientRect()
          next[i] = rect.top - base
          if (el.classList.contains('wl-ph')) continue
          const k = keys[i]
          real.add(k)
          if (!mts.has(k)) {
            const ecs = getComputedStyle(el)
            mts.set(k, parseFloat(ecs.marginTop) || 0)
            mbs.set(k, parseFloat(ecs.marginBottom) || 0)
          }
          const hNew = rect.height + mts.get(k) + mbs.get(k)
          if (resized && hs.has(k)) {
            oldSum += hs.get(k)
            newSum += hNew
          }
          hs.set(k, hNew)
        }
      }
      // 列数：第一行有几项（和第一项一样高的）
      let k0 = 0
      while (k0 < n && next[k0] != null && Math.abs(next[k0] - next[0]) < 1) k0++
      if (next[0] != null) cols = k0
      // 宽度变了：没渲染的按渲染着的那些新旧高度的比例估（滚到它们时会按真实高度重新量）；整段占位作废，下一轮一项一个占位
      if (resized) {
        if (oldSum > 0) {
          const ratio = newSum / oldSum
          for (const [key, v] of hs) if (!real.has(key)) hs.set(key, v * ratio)
        }
        phs.clear()
        spv.length = 0
        touchAll()
        ver.value++
      }
      boxW = w
      tops = next
      unmeasured = false
      // 有段的位置作废了：它们重新渲染（一项一个占位）以后会再量一次（onUpdated 看到 dirty）
      if (stale) {
        ver.value++
        return false
      }
      if (tops.some(t => t == null)) return false
      // 之前有段因为位置没量全没能整段收起：现在量全了，重新渲染一遍
      if (blocked) {
        blocked = false
        touchAll()
        ver.value++
      }
      return true
    }

    /* 下标范围：底边在 a 之下、顶边在 b 之上的那些项 */
    function span(a, b) {
      const n = list.length
      let lo = 0
      while (lo < n && tops[lo] != null && tops[lo] + hOf(lo) < a) lo++
      let hi = lo
      while (hi < n - 1 && (tops[hi + 1] == null || tops[hi + 1] < b)) hi++
      return [lo, hi]
    }

    /* 窗口要不要挪；视口附近的马上挂成真卡片。返回 false 表示现在没在窗口化（或量不了） */
    function update() {
      const n = list.length
      if (n <= props.min) {
        if (range) {
          range = null
          shown.clear()
          touchAll()
          ver.value++
        }
        return false
      }
      if (!ready() || tops.some(t => t == null)) return false
      const st = scroller.scrollTop
      const ch = scroller.clientHeight
      let changed = false
      const [needLo, needHi] = span(st - ch * NEED, st + ch * (1 + NEED))
      if (!range || needLo < range.lo || needHi > range.hi) {
        let [lo, hi] = span(st - ch * KEEP, st + ch * (1 + KEEP))
        // 键盘焦点在某一项里：这一项不收
        const ae = document.activeElement
        if (ae && ae !== document.body && box.contains(ae)) {
          const i = nodes.findIndex(v => v?.el instanceof Element && v.el.contains(ae))
          if (i >= 0) {
            lo = Math.min(lo, i)
            hi = Math.max(hi, i)
          }
        }
        const old = range || { lo: 0, hi: n - 1 }
        // 新窗口里现在已经是真卡片的（第一次开始窗口化时的全部、刚取回来的下一页）留着，不先收起再挂
        for (let i = lo; i <= hi; i++) {
          const rb = realBy[chunkOf(i)]
          if (rb && rb.has(keys[i])) shown.add(keys[i])
        }
        // 出了窗口的：收起（记下它收起过）
        for (let i = old.lo; i <= Math.min(old.hi, n - 1); i++) {
          if (i >= lo && i <= hi) continue
          shown.delete(keys[i])
          if (hs.has(keys[i])) far.add(keys[i])
          touch(i)
        }
        // 进了窗口的段也要重新渲染（整段占位要拆开）
        for (let c = chunkOf(lo); c <= chunkOf(hi); c++) if (spv[c] || !range) chunkV[c] = (chunkV[c] || 0) + 1
        if (!range) touchAll()
        range = { lo, hi }
        changed = true
      }
      const [vLo, vHi] = span(st - ch * VIEW, st + ch * (1 + VIEW))
      for (let i = Math.max(vLo, range.lo); i <= Math.min(vHi, range.hi); i++) {
        if (!shown.has(keys[i])) {
          shown.add(keys[i])
          touch(i)
          changed = true
        }
      }
      if (changed) ver.value++
      return true
    }

    /* 窗口里还没挂上的，挑几张挂上：滚动方向上的先挂（背后那一侧的往后排），同一侧离视口近的先挂；返回 true 表示还有没挂完的 */
    function fill() {
      if (!range || !ready()) return false
      const st = scroller.scrollTop
      const ch = scroller.clientHeight
      const mid = st + ch / 2
      const todo = []
      for (let i = range.lo; i <= range.hi && i < list.length; i++) if (!shown.has(keys[i])) todo.push(i)
      if (!todo.length) return false
      const cost = i => {
        const t = tops[i] ?? 0
        const behind = dir > 0 ? t < st : dir < 0 ? t > st + ch : false
        return Math.abs(t - mid) + (behind ? ch * (KEEP + 1) : 0)
      }
      todo.sort((a, b) => cost(a) - cost(b))
      const n = props.fill ?? (props.min <= POST_WIN ? 1 : FILL)
      for (const i of todo.slice(0, n)) {
        shown.add(keys[i])
        touch(i)
      }
      ver.value++
      return todo.length > n
    }

    function schedule() {
      dirty = true
      onScroll()
    }
    onMounted(schedule)
    // 新挂上了还没量过的真卡片（下一页）、列表中间变了才重新量；收起 / 放回不改排版（同样高），不用量。尺寸变了由 ResizeObserver 通知
    onUpdated(() => {
      if (unmeasured || dirty) schedule()
    })
    onActivated(() => {
      live = true
      schedule()
    })
    onDeactivated(() => {
      live = false
      cancelAnimationFrame(raf)
      raf = 0
    })
    onBeforeUnmount(() => {
      live = false
      cancelAnimationFrame(raf)
      scroller?.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    })

    expose({
      /** 返回恢复用：每项的高度、位置和现在的窗口（没在窗口化时为 null） */
      snapshot() {
        if (!windowed()) return null
        return {
          keys: keys.slice(),
          hs: keys.map(k => hs.get(k) ?? null),
          mts: keys.map(k => mts.get(k) || 0),
          mbs: keys.map(k => mbs.get(k) || 0),
          tops: tops.slice(),
          lo: range.lo,
          hi: range.hi,
          w: boxW,
          cols,
          gap: rowGap,
          far: [...far]
        }
      }
    })

    return () => {
      void ver.value
      const next = props.items || []
      if (next !== list) setList(next)
      const out = []
      for (let c = 0; c < chunkV.length; c++) out.push(h(WinChunk, { key: c, c, v: chunkV[c] || 0, ctx }))
      return h(Fragment, out)
    }
  }
})
