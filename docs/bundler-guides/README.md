# Bundler Integration Guides

Framework-specific guides for integrating lip-sync-engine Web Workers.

## Available Guides

### [Vite](./vite.md)
Complete guide for Vite projects (React, Vue, Svelte).

**Features:**
- ✅ Built-in Web Worker support
- ✅ Minimal configuration
- ✅ Hot module replacement
- ✅ Fast development server

**Best for:** Modern frameworks, fast development

---

### [Webpack](./webpack.md)
Complete guide for Webpack 5 projects.

**Features:**
- ✅ Asset module support
- ✅ Worker loader integration
- ✅ Production optimization
- ✅ Create React App (CRA) support

**Best for:** Enterprise projects, custom configuration

---

### [Next.js](./nextjs.md)
Complete guide for Next.js projects (App Router & Pages Router).

**Features:**
- ✅ SSR-safe implementation
- ✅ Dynamic imports
- ✅ Vercel deployment
- ✅ Custom server support

**Best for:** Server-side rendered React apps

---

## Quick Comparison

| Feature | Vite | Webpack | Next.js |
|---------|------|---------|---------|
| **Setup Complexity** | Easy | Medium | Medium |
| **Config Required** | Minimal | Moderate | Moderate |
| **Dev Server Speed** | ⚡ Very Fast | 🐢 Slower | 🚀 Fast |
| **Build Speed** | ⚡ Very Fast | 🐢 Slower | 🚀 Fast |
| **Worker Support** | Native | Requires loader | SSR-aware |
| **WASM Support** | Native | Native | Requires config |
| **Best For** | New projects | Legacy projects | SSR apps |

---

## General Setup Steps

All bundlers follow similar patterns:

### 1. Install Package

```bash
npm install lip-sync-engine
```

### 2. Copy WASM Files

Files need to be accessible at runtime:

```bash
mkdir -p public/wasm
cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/
cp node_modules/lip-sync-engine/dist/worker.js public/
```

### 3. Configure Paths

```typescript
await pool.init({
  wasmPath: '/wasm/lip-sync-engine.wasm',
  dataPath: '/wasm/lip-sync-engine.data',
  jsPath: '/wasm/lip-sync-engine.js',
  workerScriptUrl: '/worker.js'
});
```

---

## Common Issues

### Worker Not Found

**Symptom:** `Failed to construct 'Worker'`

**Solution:** Ensure worker.js is in public directory and accessible

### WASM Not Loading

**Symptom:** `Failed to load WASM module`

**Solution:** Check file paths and MIME types

### SSR Errors (Next.js)

**Symptom:** `window is not defined`

**Solution:** Use dynamic imports with `ssr: false`

---

## Need Help?

- [Worker Usage Guide](../worker-usage.md) - Detailed worker documentation
- [API Reference](../api-reference.md) - Complete API docs
- [GitHub Issues](https://github.com/biolimbo/lip-sync-engine/issues) - Report problems

---

## Contributing

Found a bug or have a suggestion? Please [open an issue](https://github.com/biolimbo/lip-sync-engine/issues)!
