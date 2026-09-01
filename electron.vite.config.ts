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

// @pierre/diffs only reaches for shiki's WASM oniguruma engine when
// preferredHighlighter is 'shiki-wasm' (highlighter/shared_highlighter.js:15,
// worker/worker.js:1764); it defaults to 'shiki-js' and nothing here overrides
// it, so the base64-inlined wasm chunk — 622,336 bytes in the last build — is
// shipped and never fetched. The stub throws instead of resolving empty so a
// future engine switch fails loudly at the import rather than deep inside shiki.
// Keep in lockstep with EDITOR_THEMES in src/renderer/src/preferences.ts.
// The preferences test fails CI if a selectable theme is missing here.
const SHIKI_THEME_ALLOWLIST = new Set([
  'pierre-dark',
  'pierre-dark-soft',
  'github-dark',
  'vitesse-dark',
  'pierre-light',
  'github-light',
  'vitesse-light',
  'light-plus'
])

function trimShikiThemesPlugin(): Plugin {
  return {
    name: 'horus:trim-shiki-themes',
    enforce: 'pre',
    transform(_code, id) {
      const normalized = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      // @pierre/diffs createHighlighter() reads shiki's bundledThemes map
      // (shiki/dist/themes.mjs). Pierre collections are a second registry.
      if (normalized.endsWith('/shiki/dist/themes.mjs') || normalized.endsWith('/shiki/dist/themes.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => !name.startsWith('pierre-'))
        const info = names.map((name) => {
          const type = name.includes('light') || name === 'light-plus' ? 'light' : 'dark'
          return `{id:${JSON.stringify(name)},displayName:${JSON.stringify(name)},type:${JSON.stringify(type)},import:()=>import(${JSON.stringify(`@shikijs/themes/${name}`)})}`
        })
        return [
          `const bundledThemesInfo=[${info.join(',')}];`,
          'const bundledThemes=Object.fromEntries(bundledThemesInfo.map((i)=>[i.id,i.import]));',
          'export{bundledThemes,bundledThemesInfo};'
        ].join('\n')
      }
      if (normalized.endsWith('/collections/shiki.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => !name.startsWith('pierre-'))
        const light = names.filter((name) => name.includes('light') || name === 'light-plus')
        const lightNames = new Set(light)
        const dark = names.filter((name) => !lightNames.has(name))
        const imports = names.map((name) =>
          `${JSON.stringify(name)}: () => import(${JSON.stringify(`@shikijs/themes/${name}`)})`
        )
        return [
          'import { createThemeCollection } from "../modules/createThemeCollection.js";',
          'import { createTheme } from "../modules/createTheme.js";',
          'const SHIKI_COLLECTION = "shiki";',
          `const LIGHT_SHIKI_THEMES = ${JSON.stringify(light)};`,
          `const DARK_SHIKI_THEMES = ${JSON.stringify(dark)};`,
          'const LIGHT_SHIKI_THEME_NAMES = new Set(LIGHT_SHIKI_THEMES);',
          'function shikiColorScheme(name) { return LIGHT_SHIKI_THEME_NAMES.has(name) ? "light" : "dark"; }',
          `const SHIKI_THEME_IMPORTS = { ${imports.join(',')} };`,
          'function createShikiTheme(name) { return createTheme({ name, collection: SHIKI_COLLECTION, colorScheme: shikiColorScheme(name), load: SHIKI_THEME_IMPORTS[name] }); }',
          'export const shikiThemes = createThemeCollection({ themes: [...LIGHT_SHIKI_THEMES, ...DARK_SHIKI_THEMES].map(createShikiTheme) });'
        ].join('\n')
      }
      if (normalized.endsWith('/collections/pierre.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => name.startsWith('pierre-'))
        const light = names.filter((name) => name.includes('light'))
        const lightNames = new Set(light)
        const dark = names.filter((name) => !lightNames.has(name))
        const imports = names.map((name) =>
          `${JSON.stringify(name)}: () => import(${JSON.stringify(`@pierre/theme/${name}`)})`
        )
        const labels = Object.fromEntries(names.map((name) => [name, name]))
        return [
          'import { createThemeCollection } from "../modules/createThemeCollection.js";',
          'import { createTheme } from "../modules/createTheme.js";',
          'const PIERRE_COLLECTION = "pierre";',
          `const DARK_PIERRE_THEMES = ${JSON.stringify(dark)};`,
          `const LIGHT_PIERRE_THEMES = ${JSON.stringify(light)};`,
          'const PIERRE_THEMES = [...LIGHT_PIERRE_THEMES, ...DARK_PIERRE_THEMES];',
          'const LIGHT_PIERRE_THEME_NAMES = new Set(LIGHT_PIERRE_THEMES);',
          'function pierreColorScheme(name) { return LIGHT_PIERRE_THEME_NAMES.has(name) ? "light" : "dark"; }',
          `const PIERRE_THEME_DISPLAY_NAMES = ${JSON.stringify(labels)};`,
          `const PIERRE_THEME_IMPORTS = { ${imports.join(',')} };`,
          'function createPierreTheme(name) { return createTheme({ name, collection: PIERRE_COLLECTION, colorScheme: pierreColorScheme(name), displayName: PIERRE_THEME_DISPLAY_NAMES[name], load: PIERRE_THEME_IMPORTS[name] }); }',
          'export const pierreThemes = createThemeCollection({ themes: PIERRE_THEMES.map(createPierreTheme) });'
        ].join('\n')
      }
      return null
    }
  }
}

function dropShikiWasmPlugin(): Plugin {
  const stubId = '\0horus:shiki-wasm-stub'
  return {
    name: 'horus:drop-shiki-wasm',
    // Vite's own resolver is a core plugin and wins over unenforced user
    // plugins, so without 'pre' the specifier is already resolved by the time
    // this runs and the chunk ships anyway.
    enforce: 'pre',
    resolveId(source) {
      return source === 'shiki/wasm' ? stubId : null
    },
    load(id) {
      if (id !== stubId) return null
      return "throw new Error('shiki/wasm is stubbed out of this build; the highlighter uses the JS regex engine. Remove the horus:drop-shiki-wasm plugin to ship the oniguruma engine.')\n"
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
    resolve: {
      // @pierre/trees still nests theme 1.1.0. Dedupe onto the root 2.0.0 so
      // Explorer and the highlighter share one pierre-light chunk.
      dedupe: ['@pierre/theme']
    },
    plugins: [
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler', { target: '19' }]]
        }
      }),
      contentSecurityPolicyPlugin(),
      dropShikiWasmPlugin(),
      trimShikiThemesPlugin()
    ],
    build: {
      minify: 'esbuild',
      cssMinify: 'esbuild',
      sourcemap: 'hidden'
    },
    worker: {
      format: 'es',
      plugins: () => [dropShikiWasmPlugin(), trimShikiThemesPlugin()]
    }
  }
})
