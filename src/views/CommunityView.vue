<script setup>
import { ref, shallowRef } from 'vue'
import { getCommunityTabs, getPosts } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import { usePostStore } from '@/stores/posts'
import Icon from '@/components/Icon.vue'
import PostCard from '@/components/community/PostCard.vue'

defineOptions({ name: 'CommunityView' })

const tabs = shallowRef([])
const active = ref(0)
const posts = shallowRef([])
/* bumped on every load so the cards are re-created and fade in like a fresh feed */
const feedKey = ref(0)
const scroller = ref(null)
const { reset } = useKeepScroll(scroller)

const failed = ref(false)
const postStore = usePostStore()

async function load(tab) {
  const started = Date.now()
  try {
    const list = await getPosts(tab)
    if (tab !== active.value) return   // 用户已经切到别的 tab，丢弃这次结果
    posts.value = list
    // 新列表就是接口的最新数据：之前在详情页 / 卡片上记下的收藏、阅读数不再需要（加载期间新改的保留）
    postStore.prune(started)
    feedKey.value++
    failed.value = false
    reset()
  } catch {
    if (tab === active.value) failed.value = true
  }
}

function selectTab(i) {
  active.value = i
  load(i)
}

getCommunityTabs().then(list => { tabs.value = list }).catch(() => {})
load(active.value)
</script>

<template>
  <div class="page community">
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
      <button class="ct-search" @click="toast('搜索功能即将上线')"><Icon name="search" /><span>搜索社区与创作者</span></button>
    </header>

    <div ref="scroller" class="scroll">
      <div v-if="failed" class="empty">
        加载失败，请稍后重试
        <button class="retry" @click="load(active)">重试</button>
      </div>
      <PostCard v-for="post in posts" :key="`${feedKey}:${post.id}`" :post="post" />
      <div class="pad-b" />
    </div>
  </div>
</template>
