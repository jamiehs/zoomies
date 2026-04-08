import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'CarDriver',
      fileName: 'car-driver',
      formats: ['es', 'iife'],
    },
  },
})
