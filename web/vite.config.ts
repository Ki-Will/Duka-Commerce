import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serves the source-code archive with an attachment header so browsers
 * download it as a file instead of trying to render it inline.
 */
function sourceZipDownload(): Plugin {
  return {
    name: 'source-zip-download',
    configureServer(server) {
      server.middlewares.use('/duka-commerce-source.zip', (_req, res, next) => {
        res.setHeader('Content-Disposition', 'attachment; filename="duka-commerce-source.zip"');
        res.setHeader('Content-Type', 'application/zip');
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sourceZipDownload()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/health': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
