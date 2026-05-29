import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4318,
    proxy: {
      '/api': 'http://localhost:3001',
      '/agent-terminal': {
        target: 'ws://localhost:3001',
        ws: true,
      },
      '/task-events': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
