import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const configDir = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(resolve(configDir, '../config.json'), 'utf8'))
const mobileBase = `${config.routes.mobile.replace(/\/$/, '')}/`

export default defineConfig({
  base: mobileBase,
  define: {
    __API_BASE__: JSON.stringify(config.routes.api.replace(/\/$/, ''))
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '企业台账',
        short_name: '台账',
        description: '库存与财务一体化移动端（PWA）',
        lang: 'zh-CN',
        theme_color: '#1989fa',
        background_color: '#f7f8fa',
        display: 'standalone',
        start_url: mobileBase,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: `${mobileBase}index.html`
      }
    })
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      [config.routes.api]: { target: config.api_target, changeOrigin: true }
    }
  },
  build: { outDir: 'dist' }
})
