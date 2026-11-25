import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: resolve(import.meta.dirname, 'ui/pet.html'),
        settings: resolve(import.meta.dirname, 'ui/settings.html'),
      },
    },
  },
});
