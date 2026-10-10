<template>
  <!-- monochrome mascot: film-reel "ears" + round face + play badge -->
  <svg class="logo" viewBox="0 0 100 70" role="img" aria-label="Reel">
    <g v-for="cx in [20, 80]" :key="cx" :transform="`translate(${cx} 25)`">
      <circle r="19" fill="#fff" stroke="#0a0a0a" stroke-width="3.2" />
      <circle r="5" fill="#0a0a0a" />
      <circle v-for="(p, i) in holes" :key="i" :cx="p[0]" :cy="p[1]" r="3.6" fill="#0a0a0a" />
    </g>
    <ellipse cx="50" cy="38" rx="27" ry="26" fill="#fff" stroke="#0a0a0a" stroke-width="3.2" />
    <path d="M36 33q4-4 8 0M56 33q4-4 8 0M44 47q6 4 12 0" stroke="#0a0a0a" stroke-width="2.8" fill="none" stroke-linecap="round" />
    <circle cx="63" cy="56" r="10.5" fill="#0a0a0a" stroke="#fff" stroke-width="2.2" />
    <path d="M60.4 51.8v8.4l7.2-4.2z" fill="#fff" />
  </svg>
</template>

<script setup>
/* five sprocket holes on a 11.6 radius, starting at 12 o'clock */
const holes = [0, 72, 144, 216, 288].map(a => {
  const t = (a - 90) * Math.PI / 180
  return [(Math.cos(t) * 11.6).toFixed(1), (Math.sin(t) * 11.6).toFixed(1)]
})
</script>
