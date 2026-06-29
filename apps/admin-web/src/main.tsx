import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, createQueryClient } from '@installment/web-kit';
import '@installment/ui/globals.css';
import { App } from './App';

const queryClient = createQueryClient();
const baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider baseURL={baseURL} storageKey="installment.admin.session">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
