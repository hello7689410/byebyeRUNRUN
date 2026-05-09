import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());

  return {
    plugins: [tailwindcss(), vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    optimizeDeps: {
      include: ['leaflet'],
    },
    server: {
      hot: true,
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: 'all',
      cors: true,
      proxy: {
        '/devproxy': {
          target: 'https://run-lb.tanmasports.com/v1',
          secure: false,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/devproxy/, ''),
        },
        '/autorunserver': {
          target: env.VITE_AUTORUN_SERVER_BASE,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/autorunserver/, ''),
        },
        /** 社团云端定时：与 backend-club-sign-scheduler.md 中 server 一致，开发时同源走代理可免 CORS */
        '/api/club-schedules': {
          target: env.VITE_SCHEDULER_PROXY_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
