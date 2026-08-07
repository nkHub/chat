import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const akmProxy = {
  target: 'http://127.0.0.1:8800',
  changeOrigin: false,
  rewrite: (requestPath: string) => requestPath.replace(/^\/akm-api/, ''),
}

export default defineConfig({
  // 构建产物可挂载到子路径（如 AKM 插件的 /chat）：base 用环境变量控制，
  // 打包插件时传 VITE_BASE='./'，本地 dev 保持默认 '/'。
  base: process.env.VITE_BASE || '/',
  plugins: [
    // React 与 Tailwind 插件均为 Figma Make 必需配置
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // 将 @ 映射到 src，保持与 Make 源码一致
      '@': path.resolve(__dirname, './src'),
    },
  },
  assetsInclude: ['**/*.svg', '**/*.csv'],
  server: {
    proxy: {
      '/akm-api': akmProxy,
    },
    // port: 8805,
  },
  preview: {
    proxy: {
      '/akm-api': akmProxy,
    },
    // port: 8805,
  },
})
