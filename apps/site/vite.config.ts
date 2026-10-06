import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

/**
 * Promo site for the console: hero, screenshots, the feature picker, the theme
 * gallery, the replayed demo and the build form.
 *
 * `base: './'` is deliberate. GitHub Pages serves a project repository under
 * `/<repo>/`, so every asset, the demo iframe and the Service Worker scope are
 * resolved relative to whatever prefix the site is mounted at.
 */
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'es2023',
    rollupOptions: {
      // `themes.html` is the preview document the theme gallery frames: it is a
      // separate entry because the theme tokens are scoped to `:root`, so each
      // theme needs its own document to paint into.
      input: ['index.html', 'themes.html'],
    },
  },
})
