# Using lip-sync-engine with Webpack

Complete guide for integrating lip-sync-engine Web Workers in Webpack projects.

## Quick Setup

Webpack 5 has improved Web Worker support with asset modules.

### 1. Install Package

```bash
npm install lip-sync-engine
```

### 2. Configure Webpack

**`webpack.config.js`:**

```javascript
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  // ... other config

  module: {
    rules: [
      // Worker handling
      {
        test: /\.worker\.js$/,
        use: { loader: 'worker-loader' },
      },
      // WASM handling
      {
        test: /\.wasm$/,
        type: 'asset/resource',
      },
    ],
  },

  plugins: [
    // Copy WASM files and worker to output
    new CopyPlugin({
      patterns: [
        {
          from: 'node_modules/lip-sync-engine/dist/wasm',
          to: 'wasm',
        },
        {
          from: 'node_modules/lip-sync-engine/dist/worker.js',
          to: 'worker.js',
        },
      ],
    }),
  ],

  // Experiments for WASM
  experiments: {
    asyncWebAssembly: true,
  },
};
```

### 3. Install Required Loaders

```bash
npm install --save-dev copy-webpack-plugin worker-loader
```

---

## Usage in React + Webpack

### Basic Example

```typescript
// src/App.tsx
import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect } from 'react';

function App() {
  const [pool] = useState(() => WorkerPool.getInstance());
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Initialize worker pool
    pool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    }).catch(console.error);

    return () => pool.destroy();
  }, [pool]);

  const handleAnalyze = async (pcm16: Int16Array) => {
    setLoading(true);
    try {
      const result = await pool.analyze(pcm16, {
        dialogText: "Hello world"
      });
      setResult(result);
    } catch (error) {
      console.error('Analysis failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Lip Sync Engine - Webpack + React</h1>
      {loading && <p>Analyzing...</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

export default App;
```

---

## Create React App (CRA) Setup

If using Create React App, you'll need to either eject or use CRACO for custom Webpack config.

### Option 1: Using CRACO

```bash
npm install @craco/craco copy-webpack-plugin
```

**`craco.config.js`:**

```javascript
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  webpack: {
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: 'node_modules/lip-sync-engine/dist/wasm',
            to: 'wasm',
          },
          {
            from: 'node_modules/lip-sync-engine/dist/worker.js',
            to: 'worker.js',
          },
        ],
      }),
    ],
    configure: (webpackConfig) => {
      // Enable WASM experiments
      webpackConfig.experiments = {
        ...webpackConfig.experiments,
        asyncWebAssembly: true,
      };
      return webpackConfig;
    },
  },
};
```

**Update `package.json` scripts:**

```json
{
  "scripts": {
    "start": "craco start",
    "build": "craco build",
    "test": "craco test"
  }
}
```

### Option 2: Copy to Public Directory

Simpler alternative without modifying Webpack config:

```bash
# Copy files to public directory
mkdir -p public/wasm
cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/
cp node_modules/lip-sync-engine/dist/worker.js public/
```

Add postinstall script to `package.json`:

```json
{
  "scripts": {
    "postinstall": "mkdir -p public/wasm && cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/ && cp node_modules/lip-sync-engine/dist/worker.js public/"
  }
}
```

---

## Production Configuration

### Optimized Webpack Config

```javascript
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    mode: isProduction ? 'production' : 'development',

    module: {
      rules: [
        {
          test: /\.wasm$/,
          type: 'asset/resource',
        },
      ],
    },

    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: 'node_modules/lip-sync-engine/dist/wasm',
            to: 'wasm',
          },
          {
            from: 'node_modules/lip-sync-engine/dist/worker.js',
            to: 'worker.js',
          },
        ],
      }),
    ],

    experiments: {
      asyncWebAssembly: true,
    },

    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          // Don't minify WASM
          exclude: /\.wasm$/,
        }),
      ],
    },

    // Output configuration
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProduction ? '[name].[contenthash].js' : '[name].js',
      clean: true,
    },
  };
};
```

---

## Troubleshooting

### Module Not Found Errors

**Error:** `Module not found: Error: Can't resolve 'lip-sync-engine'`

**Solution:** Ensure package is installed

```bash
npm install lip-sync-engine
```

### Worker Script Not Loading

**Error:** `Failed to construct 'Worker'`

**Solution:** Check CopyPlugin configuration and verify files are copied

```bash
# Verify files exist after build
ls dist/wasm/
ls dist/worker.js
```

### WASM MIME Type Error

**Error:** `Incorrect response MIME type`

**Solution:** Configure webpack-dev-server

```javascript
devServer: {
  headers: {
    'Content-Type': 'application/wasm',
  },
  static: {
    directory: path.join(__dirname, 'public'),
  },
},
```

### Path Resolution Issues

**Error:** `404 Not Found` for WASM files

**Solution:** Use publicPath configuration

```javascript
output: {
  path: path.resolve(__dirname, 'dist'),
  publicPath: '/', // Adjust based on deployment
},
```

---

## Server Configuration

### Webpack Dev Server

```javascript
devServer: {
  port: 3000,
  hot: true,
  headers: {
    'Content-Type': 'application/wasm',
  },
  static: {
    directory: path.join(__dirname, 'public'),
  },
},
```

### Production Server (Express)

```javascript
const express = require('express');
const app = express();

// Serve static files
app.use(express.static('dist'));

// WASM MIME type
app.use((req, res, next) => {
  if (req.url.endsWith('.wasm')) {
    res.type('application/wasm');
  }
  next();
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

---

## Next Steps

- [Worker Usage Guide](../worker-usage.md) - Complete worker documentation
- [API Reference](../api-reference.md) - Full API docs
- [Vite Guide](./vite.md) - Alternative bundler setup

---

**Need help?** [Open an issue](https://github.com/biolimbo/lip-sync-engine/issues)
