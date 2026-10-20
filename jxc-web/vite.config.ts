import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const demo = mode === 'demo' && env.VITE_USE_MOCK === 'true'
  return {
    plugins: [vue()],
    // The only public asset is the MSW worker; omit it from real deployments.
    build: { copyPublicDir: demo },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: demo
        ? undefined
        : {
            '/api': {
              target: env.VITE_API_TARGET || 'http://localhost:8080',
              changeOrigin: true,
            },
          },
    },
  }
})
