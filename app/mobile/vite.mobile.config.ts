import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const mobileRoot = fileURLToPath(new URL('.', import.meta.url));
const outputRoot = resolve(mobileRoot, '../dist-mobile');

function mobileShellServiceWorker(): Plugin {
  return {
    name: 'mobile-shell-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const builtAssets = Object.keys(bundle)
        .filter(path => path.startsWith('assets/') && /\.(?:js|css)$/.test(path))
        .map(path => `/mobile/${path}`);
      const shell = [
        '/mobile/',
        '/mobile/index.html',
        '/mobile/manifest.webmanifest',
        '/mobile/icon.svg',
        '/mobile/icon-192.png',
        '/mobile/icon-512.png',
        ...builtAssets,
      ];
      const html = Object.values(bundle).find(item => item.type === 'asset' && item.fileName === 'index.html');
      const indexHtmlAsset = html?.type === 'asset' ? html : undefined;
      const releaseMaterial = [
        ...builtAssets,
        indexHtmlAsset && typeof indexHtmlAsset.source === 'string' ? indexHtmlAsset.source : '',
      ].join('\n');
      const cacheVersion = createHash('sha256').update(releaseMaterial).digest('hex').slice(0, 16);
      const template = readFileSync(resolve(mobileRoot, 'sw.template.js'), 'utf8');
      const source = template
        .replace('__APLOT_MOBILE_SHELL_ASSETS__', JSON.stringify(shell))
        .replace('__APLOT_MOBILE_CACHE_VERSION__', cacheVersion);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: mobileRoot,
  base: '/mobile/',
  plugins: [react(), mobileShellServiceWorker()],
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    modulePreload: { polyfill: false },
  },
});
