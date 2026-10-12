import { watch, onScopeDispose, isRef } from 'vue'
import { useRouter } from 'vue-router'

/*
 * 弹层跟随返回键（安卓返回键 / 返回手势 / 浏览器后退）。
 *
 * 弹层打开时压一条地址不变的历史记录：按返回只关弹层，不离开页面；
 * 用遮罩、按钮、Esc 关掉时再悄悄把那条记录退掉，之后的返回键不会白按一次。
 * 任何路由跳转开始前都会先关掉所有弹层、退掉它们的记录，所以弹层不会留到下一个页面上，
 * 跳转也总是落在页面自己的那条记录上。
 *
 *   const open = ref(false)
 *   useBackDismiss(open)                                           // ref：返回键把它设成 false
 *   useBackDismiss(() => auth.loginOpen, () => auth.closeLogin())   // getter + 关闭函数
 *
 * 弹层可以叠（后开的在上面），返回一次只关最上面那层。必须在组件 setup 里调用。
 * 注意：弹层开着时代码里调 router.back() 只会关掉弹层（和按返回键一样）。
 *
 * router/index.js 在创建路由前导入本模块、创建后调 installBackDismiss(router)：
 * 我们的 popstate 监听必须比路由的先注册（浏览器按注册顺序派发，而且每个监听之间会跑完微任务，
 * 路由一旦先收到就会开始导航）。
 */

const KEY = 'reelLayer'   // history.state 里的标记：这条记录属于第几层弹层
const layers = []         // 打开着的弹层，从下到上：{ close, depth }；depth 0 = 记录还没压进去
let depth = 0             // 压进历史、还没退掉的弹层记录数
let baseHref = ''         // 压第一条弹层记录时的地址（弹层记录地址都一样）
let routerHistory = null
let chain = Promise.resolve()   // 历史操作排队：退记录是异步的，做完一步再做下一步
let busy = 0
let popDone = null              // 正在等自己发起的后退

function enqueue(task) {
  busy++
  chain = chain.then(task).catch(err => console.error(err)).finally(() => busy--)
  return chain
}

/*
 * 后退 n 条。quiet：路由暂停监听这一次 popstate（退的是自己刚压的记录，地址不变，不需要导航）；
 * 否则照常交给路由（退过一条旧的弹层记录，下面那条的地址不一定还是它的地址）。
 */
function back(n, quiet = true) {
  return new Promise(resolve => {
    let timer = 0
    const done = () => { clearTimeout(timer); popDone = null; resolve() }
    timer = setTimeout(done, 1000) // 万一没有触发 popstate，也不要卡住后面的跳转
    popDone = done
    if (routerHistory && quiet) routerHistory.go(-n, false)
    else window.history.go(-n)
  })
}

/* 让历史里的弹层记录和 layers 对齐：多出来的退掉，新开的压进去 */
function sync() {
  return enqueue(async () => {
    const keep = layers.reduce((m, l) => Math.max(m, l.depth), 0)
    if (depth > keep) {
      const n = depth - keep
      depth = keep
      await back(n)
    }
    for (const l of layers) {
      if (l.depth) continue
      if (!depth) baseHref = location.href
      l.depth = ++depth
      history.pushState({ ...history.state, [KEY]: depth }, '')
    }
  })
}

/** 关掉 from 这一层及它上面叠着的（不动历史，调用方负责 sync） */
function closeFrom(i) {
  const removed = layers.splice(i)
  for (let k = removed.length - 1; k >= 0; k--) removed[k].close()
  return removed
}

function onPop(e) {
  // 自己发起的后退：放行给路由（它暂停了这一次，只同步自己的状态），等这次派发结束再继续排队里的下一步
  if (popDone) { setTimeout(popDone); return }
  const d = (e.state && e.state[KEY]) || 0
  if (d < depth) {
    if (location.href === baseHref) {
      // 按了返回：只关掉记录已经退掉的那几层，页面不动，也不让路由处理这次 popstate
      e.stopImmediatePropagation()
      depth = d
      const i = layers.findIndex(l => !l.depth || l.depth > d)
      if (i >= 0) closeFrom(i)
      return
    }
    // 地址也变了（一次退了好几步，或浏览器跳过了弹层记录）：弹层全关，交给路由导航
    depth = 0
    closeFrom(0)
  }
  // 落在一条已经没有弹层的旧记录上（按了前进）：交给路由处理完这次，再退过它。
  // 下面那条记录可能已经被替换成别的地址（比如在弹层里选了分类），所以退的时候也交给路由导航
  if (d > depth) {
    const n = d - depth
    setTimeout(() => enqueue(() => back(n, false)))
  }
}

// 模块加载时就注册（早于路由创建），返回键只关弹层时可以在路由收到之前拦下它
window.addEventListener('popstate', onPop, true)

/** router/index.js 创建路由后立刻调用（组件里的 useBackDismiss 也会兜底调一次） */
export function installBackDismiss(router) {
  if (routerHistory || !router) return
  routerHistory = router.options.history
  // 任何跳转前先关掉弹层、退掉记录，跳转落在页面自己的记录上
  router.beforeEach(() => {
    if (layers.length) closeFrom(0)
    if (depth || busy) return sync().then(() => true)
  })
  // 启动时就停在旧的弹层记录上（开着弹层时刷新了页面）：退回页面自己的记录，返回键不会白按一次
  const stale = history.state && history.state[KEY]
  if (stale) router.isReady().then(() => enqueue(() => back(stale, false)))
}

/**
 * @param {import('vue').Ref<boolean> | (() => boolean)} source 弹层是否打开
 * @param {() => void} [close] 关闭弹层；source 是 ref 时可省略（设为 false）
 */
export function useBackDismiss(source, close) {
  installBackDismiss(useRouter())
  const layer = { depth: 0, close: close || (() => { source.value = false }) }
  const get = isRef(source) ? () => source.value : source

  function open() {
    if (layers.includes(layer)) return
    layer.depth = 0
    layers.push(layer)
    sync()
  }
  /** 弹层自己关掉了（遮罩、按钮、Esc、页面收起）：退掉它的记录 */
  function dismiss() {
    const i = layers.indexOf(layer)
    if (i < 0) return
    // 叠在它上面的也一起关；它自己已经关了，不再调 close
    const removed = layers.splice(i)
    for (let k = removed.length - 1; k >= 1; k--) removed[k].close()
    sync()
  }

  watch(() => !!get(), isOpen => (isOpen ? open() : dismiss()), { flush: 'sync', immediate: true })
  onScopeDispose(dismiss)
}
