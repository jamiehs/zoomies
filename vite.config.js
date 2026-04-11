import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'CarDriver',
      fileName: 'zoomies',
      formats: ['es', 'iife'],
    },
  },
  test: {
    environment: 'jsdom',
  },
})
