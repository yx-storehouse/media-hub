<script setup>
import { ref, shallowRef } from 'vue'
import { getLiveTabs, getLives } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'LiveView' })

const tabs = shallowRef([])
const active = ref(0)
const lives = shallowRef([])
const scroller = ref(null)
useKeepScroll(scroller)

const failed = ref(false)

async function loadLives() {
  const tab = active.value
  try {
    const list = await getLives({ tab })
    if (tab !== active.value) return   // 用户已经切到别的 tab，丢弃这次结果
    lives.value = list
    failed.value = false
  } catch {
    if (tab === active.value) failed.value = true
  }
}

function selectTab(i) {
  if (i === active.value) return
  active.value = i
  loadLives()
}

getLiveTabs().then(list => { tabs.value = list }).catch(() => {})
loadLives()
</script>

<template>
  <div class="page live">
    <header class="bar-hd">
      <div class="ct-tabs" role="tablist">
        <button
          v-for="(name, i) in tabs"
          :key="name"
          class="ct-tab"
          :class="{ on: i === active }"
          role="tab"
          :aria-selected="i === active"
          @click="selectTab(i)"
        >
          {{ name }}
        </button>
      </div>
      <button class="ct-search round" aria-label="搜索" @click="toast('搜索功能即将上线')"><Icon name="search" /></button>
    </header>

    <div ref="scroller" class="scroll">
      <div v-if="failed" class="empty">
        加载失败，请稍后重试
        <button class="retry" @click="loadLives()">重试</button>
      </div>
      <div v-else class="lv-grid">
        <div v-for="item in lives" :key="item.id" v-press class="lv" @click="toast('主播暂未开播，敬请期待')">
          <Cover class="cv" v-bind="item.cover">
            <span class="badge"><i />LIVE</span>
            <span class="vw">{{ item.viewers }}</span>
          </Cover>
          <div class="bt">
            <b>{{ item.title }}</b>
            <span>{{ item.sub }}</span>
          </div>
        </div>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.ct-search.round { flex: 0 0 34px; justify-content: center; padding: 0; }

.lv-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 11px; padding: 12px 14px 0; }
.lv { position: relative; cursor: pointer; }
.lv .cv { aspect-ratio: 3 / 4; border-radius: 10px; }
/* darken top and bottom so the badges and the title stay readable on any cover */
.lv .cv::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, .28) 0%, rgba(0, 0, 0, 0) 28%, rgba(0, 0, 0, 0) 58%, rgba(0, 0, 0, .72) 100%);
}

.badge {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 7px 0 6px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .3px;
}
.badge i { width: 5px; height: 5px; border-radius: 50%; background: var(--on-accent); animation: blink 1.1s infinite; }
.vw {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 2;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  background: rgba(0, 0, 0, .42);
  font-size: 10.5px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

.bt { position: absolute; left: 9px; right: 9px; bottom: 8px; z-index: 2; }
.bt b { display: block; overflow: hidden; font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; }
.bt span { display: block; overflow: hidden; color: rgba(255, 255, 255, .72); font-size: 11px; line-height: 15px; white-space: nowrap; text-overflow: ellipsis; }
</style>
