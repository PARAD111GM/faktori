import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const directory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react()],
  build: {
    outDir: resolve(directory, 'dist'),
    emptyOutDir: true,
  },
});
