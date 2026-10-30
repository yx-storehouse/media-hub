import { defineComponent, h, ref, watch, onUpdated, onBeforeUnmount, Transition, cloneVNode, Comment } from 'vue'
import { reducedMotion } from '@/utils/motion'
import { dur, ease } from './motion'

/*
 * 换内容：骨架 → 内容、换筛选 / 排序 / 关键词、换一批。所有内容页共用这一个，换起来是同一种样子。
 *
 *   <ContentSwap :pending="feed.total === null">
 *     <SkeletonGrid v-if="feed.total === null" :count="10" />
 *     <div v-else-if="!feed.list.length" v-rise.self class="empty">…</div>
 *     <div v-else :key="batch"><div v-rise class="grid">…</div><ListFoot :feed="feed" /></div>
 *   </ContentSwap>
 *
 * pending：在等内容（这时插槽里是骨架）。hold：false 时不留旧内容（整页换了，比如换了一个创作者）。
 *
 * 从「有内容」变成 pending 时（点了筛选、排序、换一批）：
 *   - 旧内容原样留在原处、还占着位置（不跳、不变暗），但已经不接手指（.m-held）；
 *   - 新内容 250ms 内回来：旧的直接换成新的。新卡片照常错峰浮现（v-rise），旧卡片在它下面一格一格跟着淡掉，
 *     每一格都是「新的盖上来、旧的才退」，中间不会露出黑底，也不会先闪一下骨架；
 *   - 超过 250ms（和播放页换视频、缓冲转圈同一个规矩）：骨架淡入盖住旧内容，之后骨架 → 新内容照常交叉。
 * 离开的那块绝对定位垫在新内容下面（.m-out），不再占位、不接手指；离开的是网格时标题 / 时长角标在这一格轮到时就藏起来
 * （文字交叉淡化会叠成一团看不清），封面照常淡出。
 * 系统开了「减少动态效果」时一样等 250ms，只是换的那一下不做动画。
 *
 * 动画由脚本做（:css="false"），所以只用这里的 .m-held / .m-out 两个类（common.css 末尾）；.m-skel-* 是只做首次加载、
 * 或要整块直接撤掉旧内容的地方（帖子详情、社区换标签、收藏、片库、推荐页的分区骨架）还在用的 CSS 过渡，两者互不影响。
 * 新内容每次 pending 之后都换一个 key 重新挂上（v-rise 才会再播），页面自己不用为换内容管 key。
 */

/* 旧内容最多留多久：本地接口一般几十毫秒就回来，这时什么加载提示都不出 */
export const HOLD_MS = 250
/* 一格一格淡掉的最多这么多格（一屏多一点），再往后的在屏幕外，直接藏起来 */
const WAVE_MAX = 12
/* 离开的网格里，轮到这一格时先藏起来的文字 */
const TEXT = '.tt, .dur, .sk-tt'

/* 离开 / 进来的那块里的网格（自己就是 .grid，或者第一层里的 .grid）；没有返回 null */
function gridOf(el) {
  if (!(el instanceof Element)) return null
  if (el.classList.contains('grid')) return el
  for (const c of el.children) if (c.classList.contains('grid')) return c
  return null
}

/*
 * 旧内容（留着的 .m-held、正在退的 .m-out）上的点击一律拦下：手指本来就点不到（pointer-events: none），
 * 但键盘在链接上按回车也会触发 click——iOS 14 / 安卓 WebView 87 没有 inert，焦点还能落进去，不拦就会打开旧列表里的视频
 */
function stale(e) {
  if (e.target instanceof Element && e.target.closest('.m-held, .m-out')) {
    e.preventDefault()
    e.stopPropagation()
  }
}

const fade = (el, from, to, opts) => el.animate([{ opacity: from }, { opacity: to }], { fill: 'both', ...opts })

/*
 * 文字在 delay 毫秒之后藏起来。动 visibility 不动 opacity：一下子藏掉不需要过渡，也不会给每行字各起一个合成层
 * （visibility 的动画在终点之前都算 visible，fill 让它停在 hidden）
 */
const hideText = (root, delay = 0) =>
  [...root.querySelectorAll(TEXT)].map(t => t.animate([{ visibility: 'visible' }, { visibility: 'hidden' }], { duration: 1, delay, fill: 'both' }))

/*
 * 同一个视频换完还在同一格（换筛选前后排在最前面的往往是同几条）：这一格什么也不动。
 * 新的那格不浮现、先藏着，旧的这格原样垫在下面；新卡片的封面图好了（缓存里的图很快）再露出来，正好盖住一模一样的旧格子。
 * 不直接露出新格子：封面图还没好的那一两帧显示的是占位图，同一格会闪一下。
 * 返回新格子露出来时 resolve 的 Promise：旧的那块要等它露出来再撤（全是没变的格子时也不会空一下）。
 */
function keepTwin(twin) {
  // 新卡片的浮现停在终点。放到这一轮渲染结束（仍在绘制之前）再停：进来的那块自己就是网格时（推荐分区的 .grid 带 v-rise），
  // Transition 的 enter 比这个元素自己的指令 mounted 先跑，这时浮现动画还没建，当场停什么也停不到，之后照样从 0 浮现一遍
  queueMicrotask(() => {
    for (const a of twin.getAnimations ? twin.getAnimations() : []) a.finish()
  })
  const img = twin.querySelector('.cover > img')
  // 看 Cover 自己有没有把图亮出来（.on）：缓存里的图 complete 当场就是 true，但 Cover 要等 load 事件才显示它
  if (!img || img.classList.contains('on')) return null
  twin.style.visibility = 'hidden'
  return new Promise(resolve => {
    let timer = 0
    const show = () => {
      clearTimeout(timer)
      img.removeEventListener('load', show)
      img.removeEventListener('error', show)
      twin.style.visibility = ''
      // 图片 load 之后的下一帧才画上去：多等一帧再撤旧格子
      requestAnimationFrame(() => resolve())
    }
    img.addEventListener('load', show)
    img.addEventListener('error', show)
    // 兜底：图迟迟不来就照常露出来（这时显示占位图，和普通新卡片一样）
    timer = setTimeout(show, dur('--dur-3'))
  })
}

/*
 * 网格一格一格淡掉：第 i 格和新内容的第 i 格（v-rise：间隔 --stagger、前 8 格错峰、--dur-3）同时开始，
 * 新的那格在上面从 0 浮到 1，旧的这格用 ease-in 慢慢起步、在新的那格到位时正好退完，中间不会露底。
 * next：进来的网格（找同一格里没变的视频）。返回要等的动画 / Promise。
 */
function waveOut(el, grid, next) {
  const step = dur('--stagger')
  const duration = dur('--dur-3')
  const easing = ease('--ease-in')
  const fresh = next ? next.children : []
  const anims = []
  // 网格以外的东西（底部的「没有更多了」）先走
  if (el !== grid) for (const c of el.children) if (c !== grid) anims.push(fade(c, 1, 0, { duration: dur('--dur-1'), easing: ease('--ease-out') }))
  ;[...grid.children].forEach((cell, i) => {
    if (i >= WAVE_MAX) {
      cell.style.visibility = 'hidden'
      return
    }
    // 换得太快、这一格自己还没浮现完（上一次换进来的新卡片，v-rise 的延迟可能还没到）：从它此刻的不透明度退，
    // 不先跳回不透明再淡出；还完全没露出来的直接藏起来。只在它有动画时读一次样式（不排版），一次换内容最多 12 格
    const from = cell.getAnimations && cell.getAnimations().length ? +getComputedStyle(cell).opacity : 1
    if (!(from >= 0.02)) {
      cell.style.visibility = 'hidden'
      return
    }
    const twin = fresh[i]
    // 没变的格子原样不动——只限旧格子已经完整显示的时候（还在浮现的话，新格子照常浮现，不一下子跳满）
    if (from > 0.98 && twin && cell.dataset.vid && twin.dataset.vid === cell.dataset.vid) {
      const shown = keepTwin(twin)
      if (shown) anims.push(shown)
      return
    }
    const delay = Math.min(i, 7) * step
    anims.push(fade(cell, from, 0, { duration, delay, easing }), ...hideText(cell, delay))
  })
  return anims
}

export default defineComponent({
  name: 'ContentSwap',
  props: {
    pending: Boolean,
    hold: { type: Boolean, default: true }
  },
  setup(props, { slots }) {
    /* 正在留着旧内容等新的 */
    const holding = ref(false)
    let timer = 0
    /* 每进一次 pending +1：之后的内容换 key 重新挂上 */
    let gen = 0
    /* 上一次 / 这一次渲染放进去的是什么：'none'（留着旧的时什么也不放）| 'skel' | 'content' */
    let last = 'none'
    let showing = 'none'
    /* 离开中、还没开始动的（留着的旧内容；或者刚离开、等进来的那块挂上再决定怎么退） */
    const queue = []

    watch(() => props.pending, p => {
      clearTimeout(timer)
      if (!p) {
        holding.value = false
        return
      }
      gen++
      if (showing === 'content' && props.hold) {
        holding.value = true
        timer = setTimeout(() => { holding.value = false }, HOLD_MS)
      }
    })
    onBeforeUnmount(() => clearTimeout(timer))
    /* 留着的旧内容等到了头，插槽却什么也没给（没有匹配的分支）：照样退掉，不能一直占着位置 */
    onUpdated(() => {
      if (!holding.value && showing === 'none' && queue.length) release(null)
    })

    /* 离开的那块开始退：怎么退看进来的是什么（incoming：刚挂上的元素，没有为 null） */
    function release(incoming) {
      const items = queue.splice(0)
      if (!items.length) return
      const calm = reducedMotion()
      const toSkel = showing === 'skel'
      const inGrid = !toSkel && gridOf(incoming)
      for (const { el, done, kind } of items) {
        el.classList.remove('m-held')
        el.classList.add('m-out')
        if (calm) {
          done()
          continue
        }
        let anims
        const grid = inGrid && gridOf(el)
        if (grid) anims = waveOut(el, grid, inGrid)
        else if (kind === 'skel' || toSkel) {
          // 骨架退场：整块 ease-in 淡出，新内容盖上来之前一直垫着。
          // 慢了骨架盖上来：旧内容和骨架同时 ease-out 交叉（骨架比旧列表短时，露在骨架下面的旧卡片不会拖着不走）；
          // 骨架缝里不透出旧标题：标题 / 角标更快地淡掉（不是一下子没了，骨架还没出来时不空一下）
          const out = kind === 'skel' ? '--ease-in' : '--ease-out'
          anims = [fade(el, 1, 0, { duration: dur('--dur-2'), easing: ease(out) })]
          if (kind !== 'skel') for (const t of el.querySelectorAll(TEXT)) anims.push(fade(t, 1, 0, { duration: dur('--dur-1'), easing: ease('--ease-out') }))
        } else {
          // 旧内容换成不成网格的东西（空状态、帖子列表）：很快淡掉，不和新的文字叠在一起
          anims = [fade(el, 1, 0, { duration: dur('--dur-1'), easing: ease('--ease-out') }), ...hideText(el)]
        }
        Promise.all(anims.map(a => a.finished || a)).then(done, done)
      }
      // 慢了：骨架淡入，盖住下面还在退的旧内容
      if (toSkel && incoming && !calm && items.some(x => x.kind !== 'skel')) {
        fade(incoming, 0, 1, { duration: dur('--dur-2'), easing: ease('--ease-out'), fill: 'none' })
      }
    }

    const hooks = {
      css: false,
      onLeave(el, done) {
        el.setAttribute('aria-hidden', 'true')
        // 键盘也够不着：Tab 不再落进留着 / 正在退的旧内容（读屏也跳过）。没有 inert 的老浏览器靠下面 m-swap 上的点击拦截
        el.inert = true
        queue.push({ el, done, kind: last })
        if (holding.value) {
          // 留在原处等新内容：还占着位置、不接手指
          el.classList.add('m-held')
          return
        }
        // 进来的那块（同一轮里挂上）会接着 release；什么也没进来时在这一轮结束后自己退
        Promise.resolve().then(() => release(null))
      },
      onEnter(el) {
        release(el)
      }
    }

    return () => {
      let child = null
      if (!holding.value) {
        const nodes = slots.default ? slots.default() : []
        child = nodes.find(n => n.type !== Comment) || null
        if (child && !props.pending) child = cloneVNode(child, { key: `${String(child.key ?? '')}~${gen}` })
      }
      last = showing
      showing = !child ? 'none' : props.pending ? 'skel' : 'content'
      return h('div', { class: 'm-swap', onClickCapture: stale }, [h(Transition, hooks, () => (child ? [child] : []))])
    }
  }
})
