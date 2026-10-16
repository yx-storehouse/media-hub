import { onMounted, onActivated, onBeforeUnmount } from 'vue'

/*
 * 跟着滚动变化的顶栏：内容从顶栏下面滚过去时，给顶栏加上 .m-scrolled（样式在 styles/motion.css 的 .m-edge：
 * 底边细线变亮、下面一道很淡的阴影）。回到顶部再去掉。
 *
 * 不挂 scroll 监听：在每个滚动容器的最上面放一个 1px 的「哨兵」（不占位置），用 IntersectionObserver
 * 看它还在不在容器的可视区里——不在了就是往上滚过了。只在跨过顶部的那一下回调一次，滚动时没有任何开销。
 * 观察的根是滚动容器本身，所以页面转场时整页平移也不会误判。
 *
 *   const hd = ref(null)                                   // <header ref="hd" class="m-edge">（要有定位）
 *   const edge = useScrollEdge(hd, () => [scrollerEl])     // 返回现在要看的滚动容器（一个或几个）
 *   edge.refresh()                                         // 换了滚动容器（切分类等）后调一次
 *   useScrollEdge(hd, fn, { watchParent: true })           // 顶栏的兄弟节点增删时（v-if 换了列表）自动 refresh
 *
 * 几个容器用 v-show 轮流显示时，隐藏的不算；显示 / 隐藏切换时重新取一次状态。KeepAlive 切回来时也重新取。
 */

const SENTINEL = 'm-edge-sentinel'

function sentinelOf(scroller) {
  const first = scroller.firstElementChild
  if (first && first.classList.contains(SENTINEL)) return first
  const s = document.createElement('div')
  s.className = SENTINEL
  s.setAttribute('aria-hidden', 'true')
  scroller.prepend(s)
  return s
}

/**
 * @param {import('vue').Ref<HTMLElement|null>} header 顶栏
 * @param {() => (Element|null|undefined|Array<Element|null|undefined>)} scrollers 现在要看的滚动容器
 * @param {{ watchParent?: boolean }} [opts]
 */
export function useScrollEdge(header, scrollers, { watchParent = false } = {}) {
  const watched = new Map() // 滚动容器 → { io, mo, sentinel, scrolled }
  let parentMo = null
  let on = false

  function update() {
    const el = header.value
    if (!el) return
    let any = false
    for (const s of watched.values()) if (s.scrolled) { any = true; break }
    if (any !== on) {
      on = any
      el.classList.toggle('m-scrolled', any)
    }
  }

  function attach(scroller) {
    const sentinel = sentinelOf(scroller)
    const state = { sentinel, scrolled: false, io: null, mo: null }
    state.io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1]
      // 容器被隐藏（v-show、页面收起）时 rootBounds 为空或是 0：不算滚过；哨兵被挪出容器（极少见）也不算
      const shown = !!e.rootBounds && e.rootBounds.height > 0
      state.scrolled = shown && !e.isIntersecting && sentinel.parentNode === scroller
      update()
    }, { root: scroller, threshold: 0 })
    state.io.observe(sentinel)
    // v-show 切换显示：状态没有跨过阈值就不会回调，这时主动重新取一次
    state.mo = new MutationObserver(() => reobserve(state))
    state.mo.observe(scroller, { attributes: true, attributeFilter: ['style', 'class'] })
    watched.set(scroller, state)
  }

  function detach(scroller) {
    const s = watched.get(scroller)
    if (!s) return
    s.io.disconnect()
    s.mo.disconnect()
    watched.delete(scroller)
  }

  /* 重新观察：IntersectionObserver 开始观察时一定会先回调一次当前状态 */
  function reobserve(s) {
    s.io.unobserve(s.sentinel)
    s.io.observe(s.sentinel)
  }

  function refresh() {
    if (typeof IntersectionObserver !== 'function' || !header.value) return
    let list = scrollers()
    list = (Array.isArray(list) ? list : [list]).filter(el => el instanceof Element)
    for (const el of [...watched.keys()]) if (!list.includes(el)) detach(el)
    for (const el of list) {
      if (!watched.has(el)) attach(el)
      // 哨兵被页面重新渲染挤到了后面（极少见）：挪回最上面
      else if (el.firstElementChild !== watched.get(el).sentinel) {
        el.prepend(watched.get(el).sentinel)
        reobserve(watched.get(el))
      }
    }
    if (!list.length) update()
  }

  onMounted(() => {
    refresh()
    const parent = watchParent && header.value?.parentElement
    if (parent && typeof MutationObserver === 'function') {
      parentMo = new MutationObserver(refresh)
      parentMo.observe(parent, { childList: true })
    }
  })
  // KeepAlive 切回来：收起期间的回调不可信，全部重新取
  onActivated(() => {
    refresh()
    for (const s of watched.values()) reobserve(s)
  })
  onBeforeUnmount(() => {
    parentMo?.disconnect()
    for (const el of [...watched.keys()]) detach(el)
  })

  return { refresh }
}
