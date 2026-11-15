<script setup>
import BottomSheet from '@/components/BottomSheet.vue'
import { inApp, appVersion, isAndroid } from '@/utils/shell'
// 只取版本号这一个字段（打包时只留下这一个字符串）
import { version } from '../../../package.json'

/*
 * 「我的 → 关于 Reel」：版本号、在用的服务器地址（内网部署，出问题时告诉管理员是哪台）。
 *
 *   <AboutSheet v-model:open="aboutOpen" />
 *
 * 和别的弹层一样底部升起（桌面上是窗口正中的对话框）：返回键、点遮罩、下拉、「知道了」都只是关掉。
 */
const open = defineModel('open', { type: Boolean, default: false })

const rows = [
  { label: '网页版', value: version },
  inApp ? { label: isAndroid ? '安卓 App' : 'iOS App', value: appVersion || '—' } : null,
  { label: '服务器', value: location.host || location.origin }
].filter(Boolean)
</script>

<template>
  <BottomSheet v-model:open="open" title="关于 Reel">
    <p class="ab-text">内网视频应用：视频、短视频、社区和账号都存放在下面这台服务器上。</p>
    <dl class="ab-list">
      <div v-for="r in rows" :key="r.label" class="ab-row">
        <dt>{{ r.label }}</dt>
        <dd>{{ r.value }}</dd>
      </div>
    </dl>
    <button type="button" class="ab-ok" @click="open = false">知道了</button>
  </BottomSheet>
</template>

<style scoped>
.ab-text { margin: -4px 0 14px; color: var(--t2); font-size: 13px; line-height: 20px; }
.ab-list { margin: 0 0 16px; border-radius: 10px; background: #1c1c1c; }
.ab-row { display: flex; align-items: center; gap: 16px; min-height: 44px; padding: 0 14px; border-bottom: 1px solid #242424; font-size: 14px; }
.ab-row:last-child { border-bottom: 0; }
.ab-row dt { flex: none; color: var(--t2); }
/* 地址可能很长（IPv6、带端口的域名）：右对齐，太长就折行，不顶出弹层 */
.ab-row dd { min-width: 0; margin-left: auto; color: var(--t1); text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
@supports not (overflow-wrap: anywhere) {
  .ab-row dd { word-break: break-all; }
}
/* 弹层底色（#151515）上的次要按钮：和弹层里的选项同一种灰底（--opt）+ 很淡的描边 */
.ab-ok { width: 100%; height: 46px; border-radius: 10px; background: var(--opt); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); color: var(--t1); font-size: 15px; }
.ab-ok:active { filter: brightness(.9); }

/* 桌面布局（≥ 1024px）：窗口正中的对话框，按钮按桌面对话框的习惯靠右（同 ConfirmSheet） */
@media (min-width: 1024px) {
  .ab-text { margin: -8px 0 20px; font-size: 14px; line-height: 22px; }
  .ab-list { margin-bottom: 24px; border-radius: 12px; }
  .ab-row { padding: 0 16px; }
  .ab-ok { display: block; width: auto; min-width: 96px; height: 40px; margin-left: auto; padding: 0 20px; border-radius: 20px; background: #222; box-shadow: none; font-size: 14px; }
}
@media (min-width: 1024px) and (hover: hover) {
  .ab-ok { transition: background-color var(--dur-2) var(--ease-out); }
  .ab-ok:hover { background: #2a2a2a; }
}
</style>
