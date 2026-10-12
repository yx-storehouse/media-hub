/*
 * 「我的」几个列表页（观看历史、我的收藏、我的关注）的返回恢复。
 *
 * 这几页不常驻（不在 KeepAlive 里），点进视频 / 主页再按返回时，用离开前存下的状态
 * （已加载的列表、标签、滚动位置）原样放回，不用从头加载、也不会回到顶部。
 * 只在「返回到这条历史记录」时恢复（history.state.forward 有值）；重新点进来是全新的一页。
 * 和 CreatorView 的做法一样，按「页面名 + 这条历史记录的位置 + 当前账号」区分。
 *
 *   const snap = useSnapshot('favorites', () => auth.user?.id)   // 在 setup 里调用
 *   const saved = snap.take()            // 返回恢复时是上次 keep 的数据，否则 null
 *   onBeforeUnmount(() => snap.keep({ ... }))
 */
const snapshots = new Map()
const TTL = 10 * 60 * 1000
const MAX = 6

export function useSnapshot(name, owner) {
  // 进入页面那一刻的历史记录（setup 时地址已经切到这一页）
  const key = `${name}:${window.history.state?.position ?? ''}`

  function take() {
    const s = window.history.state?.forward ? snapshots.get(key) : null
    snapshots.delete(key)
    if (!s || Date.now() - s.at > TTL || s.owner !== owner()) return null
    return s.data
  }

  function keep(data) {
    snapshots.delete(key)
    if (!data) return
    snapshots.set(key, { at: Date.now(), owner: owner(), data })
    while (snapshots.size > MAX) snapshots.delete(snapshots.keys().next().value)
  }

  return { take, keep }
}
