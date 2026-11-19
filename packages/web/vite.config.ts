import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3210',
      '/health': 'http://127.0.0.1:3210',
      '/webhooks': 'http://127.0.0.1:3210',
      '/rpc': { target: 'ws://127.0.0.1:3210', ws: true },
      '/ws': { target: 'ws://127.0.0.1:3210', ws: true }
    }
  }
})
