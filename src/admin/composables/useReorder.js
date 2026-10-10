/*
 * 调整顺序（专题列表、首页分区列表、分区里每一批的视频）：上移 / 下移按钮 + HTML5 拖动。
 *
 * ① 有「原始顺序」的列表（服务端返回的行）：本地先调，点「保存排序」再提交
 *   const r = useReorder(() => rows.value, { key: 'id', onReset: hadChanges => hadChanges && toast('列表已变化，未保存的排序已还原') })
 *   r.list        当前顺序的行（没动过时就是原列表）——表格 / 列表渲染它
 *   r.dirty       顺序和原列表不同（配合 useLeaveGuard(() => r.dirty) 做离开确认）
 *   r.move(from, to) / r.moveBy(rowOrKey, ±1) / r.indexOf(rowOrKey) / r.keys() / r.reset()
 *   原列表的成员变了（删了一行、换了页）：调整到一半的顺序自动作废（onReset(有没有未保存的改动)）
 *
 * ② 数据由调用方自己改，只要拖动交互：
 *   const drag = useDragSort({ axis: 'x', onMove: (from, to) => moveItem(from, to) })
 *
 * 拖动（r.drag 就是 ②，onMove = r.move）：
 *   把手：  draggable="true" @dragstart="r.drag.start(i, $event)" @dragend="r.drag.end"
 *   每一项：@dragover="r.drag.over($event, i)" @drop="r.drag.drop" :class="r.drag.itemClass(i)"
 *   容器：  @dragleave="r.drag.leave"
 *   表格（DataTable 的行上挂不了事件）：容器上写 @dragover="r.drag.over" @drop="r.drag.drop"，
 *           按鼠标下的 <tr>（或带 data-drag-index 的元素）算落点
 *   axis：'y'（默认，按行的上半 / 下半决定插到前面还是后面）| 'x'（网格卡片，按左半 / 右半）
 *   r.drag.dragIndex：正在拖的下标（-1 = 没在拖）；拖到别处（比如别的批次标签）时自己处理后调用 r.drag.end()
 *   itemClass(i) → { dragging, 'drop-before', 'drop-after' }，样式由页面自己写。
 * 返回的都是 reactive 对象：模板里直接写 r.dirty / r.drag.dragIndex。
 */
import { ref, reactive, computed, watch, toValue } from 'vue'

export function useDragSort({ axis = 'y', onMove } = {}) {
  const dragIndex = ref(-1)
  const dropAt = ref(null) // { index, after }

  function start(i, e) {
    dragIndex.value = i
    if (!e?.dataTransfer) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
    // 拖的是把手：拖动时的影子用整行 / 整张卡片
    const item = e.target instanceof Element ? e.target.closest('tr, li, [data-drag-index]') : null
    if (item && item !== e.target && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(item, 20, item.offsetHeight / 2)
  }

  function over(e, i) {
    if (dragIndex.value < 0) return
    let target = e.currentTarget
    let index = i
    if (index === undefined || index === null) {
      const el = e.target instanceof Element ? e.target.closest('[data-drag-index], tbody tr') : null
      if (!el || el.classList.contains('sk')) return
      index = el.dataset.dragIndex !== undefined ? Number(el.dataset.dragIndex) : el.sectionRowIndex
      target = el
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = target.getBoundingClientRect()
    const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2
    if (dropAt.value?.index !== index || dropAt.value?.after !== after) dropAt.value = { index, after }
  }

  function drop(e) {
    if (dragIndex.value < 0 || !dropAt.value) return
    e.preventDefault()
    const from = dragIndex.value
    let to = dropAt.value.index + (dropAt.value.after ? 1 : 0)
    if (from < to) to--
    end()
    if (from !== to) onMove?.(from, to)
  }

  function end() { dragIndex.value = -1; dropAt.value = null }
  /* 离开整个容器（不是在子元素之间移动）才清掉落点提示 */
  function leave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropAt.value = null }

  const itemClass = i => {
    const d = dropAt.value
    return {
      dragging: i === dragIndex.value,
      'drop-before': !!d && d.index === i && !d.after,
      'drop-after': !!d && d.index === i && d.after
    }
  }

  return reactive({ dragIndex, dropAt, dragging: computed(() => dragIndex.value >= 0), start, over, drop, end, leave, itemClass })
}

export function useReorder(source, { key = 'id', axis = 'y', onReset } = {}) {
  const keyOf = typeof key === 'function' ? key : item => item?.[key]
  const items = computed(() => toValue(source) || [])
  /** 调整中的 key 顺序；null = 没动过 */
  const order = ref(null)
  const byKey = computed(() => new Map(items.value.map(it => [keyOf(it), it])))
  const list = computed(() => (order.value ? order.value.map(k => byKey.value.get(k)).filter(it => it !== undefined) : items.value))
  const differs = (ks, arr) => ks.some((k, i) => k !== keyOf(arr[i]))
  const dirty = computed(() => !!order.value && differs(order.value, items.value))

  /* 原列表成员变了：调整到一半的顺序作废 */
  watch(items, (next, prev) => {
    if (!order.value) return
    const ks = new Set(next.map(keyOf))
    if (order.value.length !== ks.size || order.value.some(k => !ks.has(k))) {
      const had = differs(order.value, prev || [])
      order.value = null
      onReset?.(had)
    }
  })

  function move(from, to) {
    const ks = (order.value || items.value.map(keyOf)).slice()
    if (from === to || from < 0 || to < 0 || from >= ks.length || to >= ks.length) return
    const [k] = ks.splice(from, 1)
    ks.splice(to, 0, k)
    order.value = ks
  }
  const keyArg = x => (x !== null && typeof x === 'object' ? keyOf(x) : x)
  const indexOf = x => { const k = keyArg(x); return list.value.findIndex(it => keyOf(it) === k) }
  const moveBy = (x, d) => { const i = indexOf(x); if (i >= 0) move(i, i + d) }
  const reset = () => { order.value = null }
  const keys = () => list.value.map(keyOf)

  const drag = useDragSort({ axis, onMove: move })
  return reactive({ order, list, dirty, move, moveBy, indexOf, keys, reset, drag })
}
