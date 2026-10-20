<script setup lang="ts">
import type { FieldDef } from './types'
import { useOptions } from './useOptions'

const props = defineProps<{ field: FieldDef; disabled?: boolean; clearable?: boolean }>()
const model = defineModel<unknown>()
const options = useOptions(() => props.field.options)
</script>

<template>
  <el-select
    v-if="field.type === 'select' || field.type === 'multi-select'"
    v-model="model"
    :multiple="field.type === 'multi-select'"
    :disabled="disabled"
    :clearable="clearable"
    :placeholder="field.placeholder ?? `请选择${field.label}`"
    filterable
    style="width: 100%"
  >
    <el-option v-for="o in options" :key="String(o.value)" :label="o.label" :value="o.value" />
  </el-select>
  <el-input-number
    v-else-if="field.type === 'number'"
    v-model="model as number"
    :disabled="disabled"
    :min="field.min"
    :precision="field.precision"
    controls-position="right"
    style="width: 100%"
  />
  <el-switch v-else-if="field.type === 'switch'" v-model="model" :disabled="disabled" />
  <el-date-picker
    v-else-if="field.type === 'date'"
    v-model="model"
    type="date"
    value-format="YYYY-MM-DD"
    :disabled="disabled"
    :clearable="clearable"
    style="width: 100%"
  />
  <el-input
    v-else
    v-model="model as string"
    :type="field.type === 'textarea' ? 'textarea' : field.type === 'password' ? 'password' : 'text'"
    :show-password="field.type === 'password'"
    :disabled="disabled"
    :clearable="clearable"
    :placeholder="field.placeholder ?? `请输入${field.label}`"
  />
</template>
