import type { FormItemRule } from 'element-plus'
import type { OptionItem } from '@/stores/options'

export type OptionSource =
  | OptionItem[]
  | { dict: string }
  | { remote: string; label?: string; value?: string; params?: object }

export interface FieldDef {
  prop: string
  label: string
  type?: 'input' | 'textarea' | 'number' | 'select' | 'multi-select' | 'switch' | 'date' | 'password'
  options?: OptionSource
  required?: boolean
  placeholder?: string
  /** 栅格宽度，24 为整行 */
  span?: number
  /** 创建后不可修改，例如编码 */
  editDisabled?: boolean
  /** 只在新建时显示 */
  createOnly?: boolean
  min?: number
  precision?: number
  default?: unknown
  rules?: FormItemRule[]
  tip?: string
}

/** CrudPage 通过 defineExpose 暴露的方法（组件带泛型，不能直接用 InstanceType） */
export interface CrudPageExpose<T = Record<string, unknown>> {
  reload: () => Promise<void>
  search: () => void
  openCreate: () => void
  openEdit: (row: T) => void
  selection: T[]
  query: Record<string, unknown>
}

export interface ColumnDef {
  prop: string
  label: string
  width?: number
  minWidth?: number
  type?: 'status' | 'money' | 'qty' | 'datetime' | 'date' | 'bool' | 'option' | 'tags'
  /** money 列取币种的字段 */
  currencyProp?: string
  options?: OptionSource
  fixed?: 'left' | 'right'
  /** status 列的状态叫法，见 utils/status 的 DOMAIN_STATUS */
  statusDomain?: string
}
