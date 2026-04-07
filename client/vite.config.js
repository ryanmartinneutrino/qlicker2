import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveAppVersion(env) {
  if (typeof env.VITE_APP_VERSION === 'string' && env.VITE_APP_VERSION.trim()) {
    return env.VITE_APP_VERSION.trim();
  }

  try {
    // Local development can read ../VERSION from the repository root.
    const fileVersion = readFileSync(resolve(process.cwd(), '../VERSION'), 'utf8').trim();
    if (fileVersion) return fileVersion;
  } catch {
    // Docker client builds use ./client as the context, so ../VERSION does not exist there.
  }

  const packageVersion = (process.env.npm_package_version || '').trim();
  if (packageVersion) {
    return packageVersion.startsWith('v') ? packageVersion : `v${packageVersion}`;
  }

  return 'dev';
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || 'http://localhost:3001';
  const wsTarget = env.VITE_WS_URL || 'ws://localhost:3001';
  const devPort = parseInt(env.VITE_DEV_PORT || '3000', 10);
  const appVersion = resolveAppVersion(env);

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    oxc: {
      jsx: {
        runtime: 'automatic',
        importSource: 'react',
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@mui/') || id.includes('@emotion/')) {
              return 'vendor-mui';
            }
            if (id.includes('@tiptap/') || id.includes('katex')) {
              return 'vendor-editor';
            }
            if (id.includes('html2pdf.js') || id.includes('html2canvas') || id.includes('jspdf')) {
              return 'vendor-pdf';
            }
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'vendor-i18n';
            }
            if (id.includes('react-router-dom')) {
              return 'vendor-router';
            }
            if (id.includes('axios')) {
              return 'vendor-network';
            }
            return 'vendor-core';
          },
        },
      },
    },
    server: {
      port: devPort,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './test/setup.js',
      exclude: [
        ...configDefaults.exclude,
        'e2e/**',
        'e2e-sso/**',
        'playwright.config.js',
        'playwright.sso.config.js',
      ],
    },
  };
});
