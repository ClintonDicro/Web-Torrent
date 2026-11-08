import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    // parse-torrent uses path.join/path.sep; give it the POSIX browser implementation.
    alias: { path: 'path-browserify' }
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0, // no data: URIs; everything is a file covered by the CSP
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: id => (id.includes('node_modules/webtorrent') ? 'webtorrent' : undefined)
      }
    }
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true }
})
