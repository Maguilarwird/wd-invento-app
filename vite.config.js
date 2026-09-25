import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyPort = env.VITE_PROXY_PORT || env.PORT || '3001';
  const target = `http://127.0.0.1:${proxyPort}`;

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/proxy': target,
        '/login': target,
        '/models': target,
        '/delete': target,
        '/add': target,
        '/api': target,
      },
    },
    preview: {
      port: parseInt(process.env.PORT, 10) || 4173,
      host: true,
      strictPort: false,
      allowedHosts: [
        'https://levantamientos.wird.ai',
        'localhost',
        '127.0.0.1',
      ],
    },
  };
});
