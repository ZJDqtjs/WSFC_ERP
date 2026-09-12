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
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,jpeg,ico,woff,woff2,ttf,eot}'],
        // SPA 深链接（/mobile/products、/mobile/ogroup/xxx 等）回退到 index.html
        navigateFallback: `${mobileBase}index.html`,
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        // 台账数据实时性要求高：接口与上传资源一律不缓存，避免看到旧库存/旧报表
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/'),
            handler: 'NetworkOnly'
          }
        ]
      }
    })
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      [config.routes.api]: { target: config.api_target, changeOrigin: true },
      [config.routes.uploads]: { target: config.api_target, changeOrigin: true }
    }
  },
  // 预览「生产构建产物」时同样把 /api、/uploads 反代到后端，便于本地校验 dist
  preview: {
    host: true,
    port: 4173,
    proxy: {
      [config.routes.api]: { target: config.api_target, changeOrigin: true },
      [config.routes.uploads]: { target: config.api_target, changeOrigin: true }
    }
  },
  build: { outDir: 'dist' }
})
