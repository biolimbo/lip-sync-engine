# Using lip-sync-engine with Next.js

Complete guide for integrating lip-sync-engine Web Workers in Next.js projects.

## Quick Setup

Next.js requires special handling for Web Workers and WASM files due to SSR.

### 1. Install Package

```bash
npm install lip-sync-engine
```

### 2. Copy WASM Files

Copy WASM files to the `public` directory:

```bash
mkdir -p public/wasm
cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/
cp node_modules/lip-sync-engine/dist/worker.js public/
```

Add to `package.json`:

```json
{
  "scripts": {
    "postinstall": "mkdir -p public/wasm && cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/ && cp node_modules/lip-sync-engine/dist/worker.js public/"
  }
}
```

### 3. Configure Next.js

**`next.config.js`:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable webpack 5
  webpack: (config, { isServer }) => {
    // Don't run on server
    if (!isServer) {
      config.experiments = {
        ...config.experiments,
        asyncWebAssembly: true,
      };
    }

    // WASM file handling
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });

    return config;
  },

  // Headers for WASM
  async headers() {
    return [
      {
        source: '/wasm/:path*',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/wasm',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

---

## Usage Patterns

### Client-Only Component

**Important:** Workers only work in the browser, not during SSR.

```typescript
// components/LipSyncAnalyzer.tsx
'use client'; // Next.js 13+ App Router

import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect } from 'react';
import type { LipSyncEngineResult } from 'lip-sync-engine';

export default function LipSyncAnalyzer() {
  const [pool, setPool] = useState<WorkerPool | null>(null);
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only initialize on client
    if (typeof window === 'undefined') return;

    const workerPool = WorkerPool.getInstance();

    workerPool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    })
      .then(() => setPool(workerPool))
      .catch((err) => setError(err.message));

    return () => {
      workerPool.destroy();
    };
  }, []);

  const handleAnalyze = async (pcm16: Int16Array) => {
    if (!pool) {
      setError('Worker pool not initialized');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await pool.analyze(pcm16, {
        dialogText: "Hello world"
      });
      setResult(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (typeof window === 'undefined') {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>Lip Sync Analyzer</h1>
      {loading && <p>Analyzing...</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {result && (
        <pre>{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}
```

### Dynamic Import (Recommended)

Prevents SSR issues by loading only on client:

```typescript
// pages/index.tsx (Pages Router)
import dynamic from 'next/dynamic';

const LipSyncAnalyzer = dynamic(
  () => import('../components/LipSyncAnalyzer'),
  {
    ssr: false,
    loading: () => <p>Loading analyzer...</p>
  }
);

export default function Home() {
  return (
    <div>
      <h1>Next.js + Lip Sync Engine</h1>
      <LipSyncAnalyzer />
    </div>
  );
}
```

### Custom Hook

```typescript
// hooks/useLipSyncEngine.ts
import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect, useCallback } from 'react';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

export function useLipSyncEngine() {
  const [pool, setPool] = useState<WorkerPool | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Skip on server
    if (typeof window === 'undefined') return;

    const workerPool = WorkerPool.getInstance();

    workerPool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    })
      .then(() => setPool(workerPool))
      .catch(setError);

    return () => {
      workerPool.destroy();
    };
  }, []);

  const analyze = useCallback(async (
    pcm16: Int16Array,
    options?: LipSyncEngineOptions
  ): Promise<LipSyncEngineResult | null> => {
    if (!pool) {
      throw new Error('Worker pool not initialized');
    }

    setLoading(true);
    setError(null);

    try {
      const result = await pool.analyze(pcm16, options);
      return result;
    } catch (err) {
      setError(err as Error);
      return null;
    } finally {
      setLoading(false);
    }
  }, [pool]);

  const stats = useCallback(() => {
    return pool?.getStats() || null;
  }, [pool]);

  return {
    analyze,
    stats,
    loading,
    error,
    ready: pool !== null,
  };
}
```

**Usage:**

```typescript
'use client';

import { useLipSyncEngine } from '@/hooks/useLipSyncEngine';

export default function MyComponent() {
  const { analyze, ready, loading, error } = useLipSyncEngine();

  const handleClick = async () => {
    if (!ready) return;

    const result = await analyze(pcm16, {
      dialogText: "Hello world"
    });
    console.log(result);
  };

  if (!ready) return <div>Initializing...</div>;

  return (
    <div>
      <button onClick={handleClick} disabled={loading}>
        Analyze
      </button>
      {error && <p>Error: {error.message}</p>}
    </div>
  );
}
```

---

## App Router (Next.js 13+)

### Page Component

```typescript
// app/analyzer/page.tsx
'use client';

import { useLipSyncEngine } from '@/hooks/useLipSyncEngine';

export default function AnalyzerPage() {
  const { analyze, ready, loading } = useLipSyncEngine();

  return (
    <main>
      <h1>Lip Sync Analyzer</h1>
      {!ready && <p>Initializing worker pool...</p>}
      {ready && (
        <button onClick={() => analyze(pcm16)}>
          Analyze Audio
        </button>
      )}
    </main>
  );
}
```

### Server Component + Client Component

```typescript
// app/page.tsx (Server Component)
import AnalyzerClient from './AnalyzerClient';

export default function Page() {
  return (
    <div>
      <h1>Server-rendered content</h1>
      <AnalyzerClient />
    </div>
  );
}
```

```typescript
// app/AnalyzerClient.tsx (Client Component)
'use client';

import { useLipSyncEngine } from '@/hooks/useLipSyncEngine';

export default function AnalyzerClient() {
  const { analyze, ready } = useLipSyncEngine();

  // Client-only logic here
  return (
    <div>
      {ready ? <button onClick={() => analyze(pcm16)}>Analyze</button> : 'Loading...'}
    </div>
  );
}
```

---

## Pages Router (Next.js 12 and below)

### Page with Dynamic Import

```typescript
// pages/analyzer.tsx
import dynamic from 'next/dynamic';
import { NextPage } from 'next';

const LipSyncAnalyzer = dynamic(
  () => import('../components/LipSyncAnalyzer'),
  {
    ssr: false,
    loading: () => <p>Loading analyzer...</p>
  }
);

const AnalyzerPage: NextPage = () => {
  return (
    <div>
      <h1>Audio Analyzer</h1>
      <LipSyncAnalyzer />
    </div>
  );
};

export default AnalyzerPage;
```

### API Route (Server-side)

**Note:** Workers don't work in API routes (server-side). Use main thread analysis if needed:

```typescript
// pages/api/analyze.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { analyze } from 'lip-sync-engine';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { pcm16, dialogText } = req.body;

    // Use main thread analysis (workers not available server-side)
    const result = await analyze(
      new Int16Array(pcm16),
      { dialogText }
    );

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
```

---

## Deployment

### Vercel

Files in `public/` are automatically served. No additional configuration needed!

```bash
# Deploy
vercel deploy
```

### Custom Server

If using a custom server, ensure WASM files are served with correct MIME type:

```javascript
// server.js
const express = require('express');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = express();

  // Serve WASM files with correct MIME type
  server.use((req, res, next) => {
    if (req.url.endsWith('.wasm')) {
      res.type('application/wasm');
    }
    next();
  });

  server.all('*', (req, res) => {
    return handle(req, res);
  });

  server.listen(3000, (err) => {
    if (err) throw err;
    console.log('> Ready on http://localhost:3000');
  });
});
```

---

## Troubleshooting

### SSR Errors

**Error:** `ReferenceError: Worker is not defined`

**Solution:** Use dynamic import with `ssr: false`

```typescript
const Component = dynamic(() => import('./Component'), {
  ssr: false
});
```

### Window is Undefined

**Error:** `window is not defined`

**Solution:** Check for browser environment

```typescript
useEffect(() => {
  if (typeof window === 'undefined') return;
  // Browser-only code
}, []);
```

### WASM Not Loading

**Error:** `Failed to load WASM module`

**Solution:** Verify files are in `public/` directory

```bash
ls public/wasm/
# Should show: lip-sync-engine.wasm, lip-sync-engine.data, lip-sync-engine.js

ls public/
# Should show: worker.js
```

### Build Errors

**Error:** `Module not found`

**Solution:** Ensure proper Webpack config in `next.config.js`

```javascript
webpack: (config, { isServer }) => {
  if (!isServer) {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
  }
  return config;
},
```

### Vercel Deployment Issues

**Issue:** Works locally, fails on Vercel

**Checklist:**
1. ✅ Files in `public/` directory?
2. ✅ `postinstall` script in package.json?
3. ✅ Dynamic import with `ssr: false`?
4. ✅ Check Vercel build logs for errors

---

## Best Practices

### 1. Always Use Client Components

```typescript
'use client'; // Add this directive

import { WorkerPool } from 'lip-sync-engine';
```

### 2. Check Browser Environment

```typescript
if (typeof window !== 'undefined') {
  // Browser-only code
}
```

### 3. Dynamic Imports for Heavy Components

```typescript
const HeavyComponent = dynamic(() => import('./Heavy'), {
  ssr: false,
  loading: () => <Spinner />
});
```

### 4. Error Boundaries

```typescript
// components/ErrorBoundary.tsx
'use client';

import { Component, ReactNode } from 'react';

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <h1>Something went wrong.</h1>;
    }

    return this.props.children;
  }
}
```

**Usage:**

```typescript
<ErrorBoundary>
  <LipSyncAnalyzer />
</ErrorBoundary>
```

---

## Next Steps

- [Worker Usage Guide](../worker-usage.md) - Complete worker documentation
- [API Reference](../api-reference.md) - Full API docs
- [Vite Guide](./vite.md) - Alternative setup

---

**Need help?** [Open an issue](https://github.com/biolimbo/lip-sync-engine/issues)
