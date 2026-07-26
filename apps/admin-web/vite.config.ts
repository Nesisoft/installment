import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  preview: { port: 5175 },
  optimizeDeps: {
    exclude: ['@installment/ui', '@installment/web-kit', '@installment/api-types'],
  },
});
