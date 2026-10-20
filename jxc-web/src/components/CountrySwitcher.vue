<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useCountryStore } from '@/stores/country'
import { useSwitchCountry } from '@/composables/useSwitchCountry'

const { t } = useI18n()
const country = useCountryStore()
const onChange = useSwitchCountry()
</script>

<template>
  <el-select
    :model-value="country.currentId ?? undefined"
    :disabled="country.switching"
    :loading="country.switching"
    size="default"
    class="country-switcher"
    :placeholder="t('header.country')"
    @change="onChange"
  >
    <template #prefix>
      <el-icon><Location /></el-icon>
    </template>
    <el-option v-for="c in country.available" :key="c.id" :value="c.id" :label="`${c.name} · ${c.defaultCurrency}`">
      <span>{{ c.name }}</span>
      <span class="muted"> {{ c.code }} · {{ c.defaultCurrency }} · {{ c.timezone }}</span>
      <el-tag v-if="c.isTest" size="small" type="warning" class="ml">{{ t('header.testCountry') }}</el-tag>
      <el-tag v-if="c.status !== 'ACTIVE'" size="small" type="info" class="ml">{{ c.status }}</el-tag>
    </el-option>
  </el-select>
</template>

<style scoped>
.country-switcher {
  width: 190px;
}

.ml {
  margin-left: 6px;
}

@media (max-width: 768px) {
  .country-switcher {
    width: 130px;
  }
}
</style>
