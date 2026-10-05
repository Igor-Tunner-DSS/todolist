import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Dev: /api é redirecionado para o backend (evita CORS). Em produção, defina VITE_API_BASE_URL.
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { '/api': process.env.API_BASE_URL || 'http://localhost:3333' } } });
