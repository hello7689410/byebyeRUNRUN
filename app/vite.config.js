import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  const autorunBase = String(env.VITE_AUTORUN_SERVER_BASE || '').trim();

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
        /** 未配置 VITE_AUTORUN_SERVER_BASE 时不要注册代理：空 target 会导致 Vite/http-proxy 崩溃，浏览器表现为 ERR_CONNECTION_REFUSED */
        ...(autorunBase
          ? {
              '/autorunserver': {
                target: autorunBase,
                changeOrigin: true,
                secure: false,
                rewrite: (path) => path.replace(/^\/autorunserver/, ''),
              },
            }
          : {}),
        /** 社团云端定时：与 backend-club-sign-scheduler.md 中 server 一致，开发时同源走代理可免 CORS */
        '/api/club-schedules': {
          target: env.VITE_SCHEDULER_PROXY_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
        '/api/club-auto-join': {
          target: env.VITE_SCHEDULER_PROXY_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
        '/api/daily-run': {
          target: env.VITE_SCHEDULER_PROXY_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
