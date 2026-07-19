import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force singleton copies of packages that game-ui also installs as devDeps.
    // Without this, Vite resolves firebase/react-router-dom from game-ui's local
    // node_modules (via the file: symlink) and bundles a second copy — breaking
    // React context. (Same fix eBay uses.)
    dedupe: ['react', 'react-dom', 'react-router-dom', 'firebase'],
  },
})
