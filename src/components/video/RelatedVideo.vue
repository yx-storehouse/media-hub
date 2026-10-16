<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { formatCount } from '@/utils/format'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'
import { heroRelated } from '@/components/motion/hero'
import { rememberVideo } from './preview'

/*
 * 播放页「相似推荐」的一行：左封面，右标题 + 标签 + 播放 / 收藏数；点进去时先记下封面和标题，新页面加载时先显示。
 * 点下去缩略图飞进上面的播放器（components/motion/hero.js 的 heroRelated）。
 */
const props = defineProps({
  /** Video + { tags, playCount, favCount } */
  video: { type: Object, required: true }
})

const router = useRouter()
const to = computed(() => `/video/${encodeURIComponent(props.video.id)}`)
const tags = computed(() => (props.video.tags || []).slice(0, 3).map(t => String(t).replace(/^#/, '')))

/* RouterLink 自己的点击处理先跑（真的跳了才会 preventDefault） */
function onClick(e) {
  rememberVideo(props.video)
  heroRelated(e, e.currentTarget?.querySelector(':scope > .rv-cv'), props.video, router, to.value)
}
</script>

<template>
  <RouterLink :to="to" class="rv" @click="onClick">
    <Cover class="rv-cv" v-bind="video.cover"><span class="dur">{{ video.dur }}</span></Cover>
    <div class="rv-bd">
      <div class="rv-tt">{{ video.title }}</div>
      <div v-if="tags.length" class="rv-tags"><span v-for="t in tags" :key="t">{{ t }}</span></div>
      <div class="rv-st">
        <span><Icon name="play" />{{ formatCount(video.playCount) }}</span>
        <span><Icon name="heart" />{{ formatCount(video.favCount) }}</span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.rv { display: flex; gap: 11px; padding: 0 14px; }
.rv:active { opacity: .82; }
.rv-cv { flex: none; width: 142px; aspect-ratio: 16 / 10; border-radius: 7px; filter: var(--media); }
.rv-bd { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 1px 0; }
.rv-tt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--t1);
  font-size: 14px;
  line-height: 20px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.rv-tags { display: flex; gap: 5px; margin-top: 6px; overflow: hidden; }
.rv-tags span { flex: none; height: 19px; padding: 0 7px; border-radius: 4px; background: var(--chip); color: var(--t2); font-size: 11px; line-height: 19px; }
.rv-st { display: flex; gap: 22px; margin-top: auto; color: var(--t2); font-size: 12px; font-variant-numeric: tabular-nums; }
.rv-st span { display: flex; align-items: center; gap: 4px; }
.rv-st svg { width: 11px; height: 11px; }
</style>
