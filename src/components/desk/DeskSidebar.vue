<script setup>
import { computed } from 'vue'
import { DESK_NAV } from '@/config/nav'
import { deskSide } from '@/composables/useDeskSide'
import { useDeskNav } from './deskNav'
import Icon from '@/components/Icon.vue'

/*
 * 桌面布局的左侧导航（只在桌面布局时由 App.vue 渲染；在顶栏下面，宽度 = --desk-side）。
 *   展开（232px）：三组（主导航 / 我的 / 片库），之间一道细线；图标 + 文字一行
 *   图标栏（72px）：只有主导航五项和「我的」，图标下面一行小字
 * 选中的一项：白字、实心图标（主导航和「我的」）、一块浅一点的底；鼠标移上去底色淡淡亮一下。
 * 点主导航 = 点底部导航（历史记录规则、再点一次回顶 / 刷新），见 deskNav.js。
 * 链接都是真的 <a href>：中键、Ctrl / ⌘ + 点击在新标签页打开。
 * 图标栏里没有的项（观看历史、我的收藏、我的关注）是当前页时，高亮它所在那一组在图标栏里的那一项（「我的」）。
 */
const { activeId, hrefOf, open } = useDeskNav()
const shownId = computed(() => {
  const id = activeId.value
  if (!id || !deskSide.rail) return id
  const group = DESK_NAV.find(g => g.some(i => i.id === id))
  if (!group || group.find(i => i.id === id).rail) return id
  return group.find(i => i.rail)?.id || ''
})
const iconOf = item => (shownId.value === item.id && item.iconOn ? item.iconOn : item.icon)
</script>

<template>
  <nav id="desk-side" class="dside" :class="{ rail: deskSide.rail }" aria-label="主导航">
    <template v-for="(group, gi) in DESK_NAV" :key="gi">
      <div v-if="gi && !deskSide.rail" class="ds-sep" role="separator" />
      <template v-for="item in group" :key="item.id">
        <a
          v-if="!deskSide.rail || item.rail"
          :href="hrefOf(item)"
          class="ds-i"
          :class="{ on: shownId === item.id }"
          :aria-current="activeId === item.id ? 'page' : shownId === item.id ? 'true' : undefined"
          draggable="false"
          @click="open(item, $event)"
        >
          <Icon :name="iconOf(item)" />
          <span class="ds-l">{{ item.label }}</span>
        </a>
      </template>
    </template>
  </nav>
</template>

<style scoped>
.dside {
  position: absolute;
  top: var(--desk-top);
  left: 0;
  bottom: 0;
  z-index: 43;
  width: var(--desk-side);
  padding: 8px 12px 16px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg);
  scrollbar-width: none;
  -webkit-user-select: none;
  user-select: none;
}
.dside::-webkit-scrollbar { display: none; }
.dside:hover { scrollbar-width: thin; scrollbar-color: #2e2e2e transparent; }

/* ---- 展开：图标 + 文字一行 ---- */
.ds-i {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 40px;
  margin-bottom: 2px;
  padding: 0 13px;
  border-radius: 10px;
  color: var(--t2);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
  -webkit-touch-callout: none;
}
.ds-i svg { width: 22px; height: 22px; }
.ds-i .ds-l { overflow: hidden; text-overflow: ellipsis; }
.ds-i.on { background: var(--field); color: var(--t1); font-weight: 600; }
.ds-sep { height: 1px; margin: 12px 12px; background: var(--line); }

/* ---- 图标栏：图标在上、一行小字在下 ---- */
.dside.rail { padding: 4px 4px 16px; }
.rail .ds-i {
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  height: 66px;
  margin-bottom: 2px;
  padding: 0;
  font-size: 10px;
  line-height: 14px;
  font-weight: 500;
}
.rail .ds-i svg { width: 22px; height: 22px; }
.rail .ds-i.on { font-weight: 600; }

/* 键盘焦点：收在格子里（全局的外描边会被裁掉） */
.ds-i:focus-visible { outline-offset: -2px; }

@media (hover: hover) {
  .ds-i:not(.on):hover { background: var(--chip); color: var(--t3); }
}
</style>
