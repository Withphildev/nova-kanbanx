import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.KANBAN_API_TARGET || 'http://localhost:3001',
    },
  },
})
