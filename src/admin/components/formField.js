import { inject, computed, useId } from 'vue'

/*
 * FormField 与输入控件之间的约定：FormField provide 一个上下文，控件 inject 后
 * 用它的 id（label for 指向控件）、invalid（红框）和 describedBy（错误 / 提示文字）。
 * 控件不在 FormField 里时自己生成 id。
 */
export const FIELD_KEY = Symbol('a-form-field')

export function useFieldContext(props = {}) {
  const ctx = inject(FIELD_KEY, null)
  const own = useId()
  return {
    id: computed(() => props.id || ctx?.id || own),
    invalid: computed(() => !!(props.invalid || ctx?.invalid?.value)),
    describedBy: computed(() => ctx?.describedBy?.value || undefined)
  }
}
