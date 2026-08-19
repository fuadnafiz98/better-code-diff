import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// The renderer displays code and review text from arbitrary repositories, so it
// declares a policy instead of relying on the default that Electron warns about.
// Production reaches the main process over IPC only and needs no network at all;
// the dev server needs its HMR socket.
//
// Verified enforced on the packaged file:// build, not just declared: an injected
// inline script does not execute, a securitypolicyviolation fires for
// script-src-elem, and Electron's "Insecure Content-Security-Policy" warning
// stops being emitted. Highlighting workers, bundled fonts and the agent stream
// all keep working under it.
function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'horus:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        const development = context.server != null
        const policy = [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' data:",
          "worker-src 'self' blob:",
          development ? "connect-src 'self' ws: wss: http://localhost:*" : "connect-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'"
        ].join('; ')
        return [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend'
        }]
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // electron-vite ships minification off by default; every byte here is
      // parsed on every cold start, so all three targets opt in explicitly.
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), contentSecurityPolicyPlugin()],
    build: {
      minify: 'esbuild',
      cssMinify: 'esbuild'
    },
    worker: {
      format: 'es'
    }
  }
})
