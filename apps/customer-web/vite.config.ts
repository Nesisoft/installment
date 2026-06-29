import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API has CORS configured for the dev ports (see apps/api/src/main.ts), so
// the browser talks to it cross-origin via VITE_API_BASE_URL. Workspace source
// packages are excluded from dep pre-bundling so Vite transpiles their TS/TSX.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 5173 },
  optimizeDeps: {
    exclude: ['@installment/ui', '@installment/web-kit', '@installment/api-types'],
  },
});
