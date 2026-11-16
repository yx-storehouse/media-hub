/*
 * 铺满内容区的网格页（观看历史、我的关注）的标题行和网格对齐：量出页面滚动区（.scroll）的滚动条有多宽，
 * 写在页面上的 --sbw，页面的桌面样式让标题行（BackHeader）右边多让出这么宽、居中时也扣掉它。
 *
 *   <div v-gutter class="scroll">…</div>        骨架、列表各自的 .scroll 上都挂（v-if 换掉的新滚动区自己再量）
 *
 * 为什么要量：网格在滚动区里，Windows 上常驻的滚动条（10px）占掉滚动区右边的位置，网格的右边缘跟着往左缩；
 * 标题行在滚动区外面、没有滚动条，右端的「清空」就会比网格多出去一截，网格到最宽居中时两边也差半个滚动条。
 * 不能给标题行加 scrollbar-gutter：那要 overflow: hidden，会把顶栏下面那道滚动阴影（.m-edge::after）切掉。
 * 手机、macOS 的浮动滚动条不占位置，量出来是 0，什么都不变。滚动条出现 / 消失、窗口缩放都会改滚动区的宽度，
 * ResizeObserver 跟得上。
 */
const measure = el => {
  const page = el.parentElement
  // 被 KeepAlive 收起来、还没排版：不量（重新放回去时尺寸变了会再量一次）
  if (!page || !el.isConnected || !el.offsetWidth) return
  const w = `${Math.max(0, el.offsetWidth - el.clientWidth)}px`
  const was = page.style.getPropertyValue('--sbw')
  // 没有滚动条、也没量出过：不写（样式里缺省就是 0；手机上滚动条是藏起来的，页面上什么都不加）
  if (w === was || (w === '0px' && !was)) return
  page.style.setProperty('--sbw', w)
}

const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(list => list.forEach(r => measure(r.target))) : null

export const vGutter = {
  mounted(el) {
    if (ro) ro.observe(el)
    else measure(el)
  },
  unmounted(el) {
    ro?.unobserve(el)
  }
}
