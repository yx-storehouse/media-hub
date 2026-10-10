<script setup>
import { ref, shallowRef, onMounted } from 'vue'
import { getLibrary } from '@/api'
import BackHeader from '@/components/BackHeader.vue'
import Cover from '@/components/Cover.vue'

defineOptions({ name: 'LibraryView' })

const categories = shallowRef([])
const failed = ref(false)

async function load() {
  try {
    categories.value = await getLibrary()
    failed.value = false
  } catch {
    failed.value = true
  }
}

onMounted(load)
</script>

<template>
  <div class="page library">
    <BackHeader title="片库" />
    <div v-if="failed" class="empty">
      加载失败，请稍后重试
      <button class="retry" @click="load()">重试</button>
    </div>
    <div v-else class="scroll">
      <div class="cat-grid">
        <RouterLink v-for="c in categories" :key="c.id" :to="`/topic/${c.id}`">
          <Cover class="cat" v-bind="c.cover">
            <b>{{ c.name }}</b>
            <span>{{ c.count }}部</span>
          </Cover>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 14px; padding: 14px; }
.cat {
  display: flex;
  align-items: flex-end;
  aspect-ratio: 16 / 8;
  padding: 10px 12px;
  border-radius: 10px;
  filter: var(--media);
}
/* bottom shade for the label; z-index keeps it (and the text) above the lazily loaded photo */
.cat::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, .65));
}
.cat b { position: relative; z-index: 1; font-size: 14px; font-weight: 700; }
.cat span { position: relative; z-index: 1; margin-left: auto; font-size: 11px; opacity: .78; }
</style>
