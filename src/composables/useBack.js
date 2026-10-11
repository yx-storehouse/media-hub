import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'

/**
 * Back button handler for sub pages: go back if we came from inside the app,
 * otherwise (deep link / refresh) fall back to `fallback`, or the home tab the user was last on.
 */
export function useBack(fallback = null) {
  const router = useRouter()
  const store = useAppStore()
  return () => {
    if (window.history.state && window.history.state.back) router.back()
    else router.replace(fallback || `/home/${store.lastHomeTab}`)
  }
}
