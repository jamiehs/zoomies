import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'CarDriver',
      fileName: (format) => `zoomies.${format}.js`,
      formats: ['es', 'iife'],
    },
  },
  test: {
    environment: 'jsdom',
  },
})
