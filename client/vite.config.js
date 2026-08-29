import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API runs on its own port in development. Proxying rather than pointing the
 * client at http://localhost:3040 keeps the browser on one origin, so the session
 * cookie is first-party and SameSite=Lax does not drop it.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3040', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
