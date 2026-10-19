import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // Load environment variables based on the current mode (development/production)
    const env = loadEnv(mode, process.cwd(), '');
    const targetUrl = env.VITE_API_BASE_URL || 'http://localhost:3000';

    return {
        plugins: [react()],
        server: {
        port: 5173,
        proxy: {
            '/api': {
            target: targetUrl,
            changeOrigin: true, // Needed for virtual hosted sites
            secure: false,
            },
        },
        },
    };
});