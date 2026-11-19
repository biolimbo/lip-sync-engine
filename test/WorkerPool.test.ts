import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool } from '../src/ts/WorkerPool';

/**
 * Minimal Worker stand-in. Tests drive each worker by calling the helpers
 * below. Like a real worker, a terminated stub delivers no further events.
 */
class StubWorker {
  static instances: StubWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  private listeners = new Set<(event: MessageEvent) => void>();

  constructor(public url: string) {
    StubWorker.instances.push(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  protected dispatch(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    this.listeners.forEach(listener => listener(event));
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    if (this.terminated) return;
    this.dispatch(data);
  }

  emitError(message: string): void {
    if (this.terminated) return;
    this.onerror?.({ message } as ErrorEvent);
  }
}

/** Ignores terminate(), to prove late messages cannot revive a worker. */
class UnstoppableStubWorker extends StubWorker {
  emitMessage(data: unknown): void {
    this.dispatch(data);
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitForWorkers(count: number): Promise<void> {
  for (let i = 0; i < 20 && StubWorker.instances.length < count; i++) {
    await flush();
  }
  expect(StubWorker.instances.length).toBe(count);
}

describe('WorkerPool startup', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    StubWorker.instances = [];
    vi.stubGlobal('Worker', StubWorker);
    pool = WorkerPool.getInstance(3, 'stub-worker.js');
  });

  afterEach(() => {
    pool.destroy();
    vi.unstubAllGlobals();
  });

  async function initPool(): Promise<void> {
    const init = pool.init();
    await waitForWorkers(1);
    StubWorker.instances[0].emitMessage({ type: 'ready' });
    await init;
  }

  it('terminates every worker when destroyed after a failed warmup', async () => {
    vi.stubGlobal('Worker', UnstoppableStubWorker);
    await initPool();

    const warmup = pool.warmup();
    await waitForWorkers(3);
    const [, second, third] = StubWorker.instances;

    second.emitMessage({ type: 'error', error: 'boom' });
    pool.destroy();
    await expect(warmup).rejects.toThrow();

    // Late ready from a worker started before destroy()
    third.emitMessage({ type: 'ready' });
    await flush();

    expect(pool.getStats().totalWorkers).toBe(0);
    expect(StubWorker.instances.map(w => w.terminated)).toEqual([true, true, true]);
  });

  it('terminates a worker that reports an init error', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    StubWorker.instances[0].emitMessage({ type: 'error', error: 'model load failed' });

    await expect(init).rejects.toThrow('model load failed');
    expect(StubWorker.instances[0].terminated).toBe(true);
    expect(pool.getStats().totalWorkers).toBe(0);
  });

  it('rejects init() when the worker fails to load', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    StubWorker.instances[0].emitError('script not found');

    await expect(init).rejects.toThrow('Worker failed to load: script not found');
    expect(StubWorker.instances[0].terminated).toBe(true);
  });

  it('rejects warmup() when a worker fails to load, keeping the ready ones', async () => {
    await initPool();

    const warmup = pool.warmup();
    await waitForWorkers(3);
    const [, second, third] = StubWorker.instances;

    second.emitError('script not found');
    third.emitMessage({ type: 'ready' });

    await expect(warmup).rejects.toThrow('Worker failed to load');
    expect(second.terminated).toBe(true);
    expect(pool.getStats().totalWorkers).toBe(2);
  });

  it('rejects a pending init() when the pool is destroyed', async () => {
    const init = pool.init();
    await waitForWorkers(1);

    pool.destroy();

    await expect(init).rejects.toThrow('WorkerPool destroyed');
    expect(StubWorker.instances[0].terminated).toBe(true);
  });

  it('does not start a worker whose script was still being fetched at destroy()', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', () => new Promise(resolve => { resolveFetch = resolve; }));

    pool.destroy();
    pool = WorkerPool.getInstance(1, 'https://cdn.example/worker.js');

    const init = pool.init();
    await flush();
    pool.destroy();
    resolveFetch({ blob: async () => new Blob() });

    await expect(init).rejects.toThrow('WorkerPool destroyed');
    expect(StubWorker.instances).toHaveLength(0);
  });

  it('still routes analysis results after startup', async () => {
    await initPool();
    const worker = StubWorker.instances[0];

    const result = pool.analyze(new Int16Array(4));
    const job = worker.posted.find(
      (m): m is { type: string; id: number } => (m as { type: string }).type === 'analyze'
    );
    expect(job).toBeDefined();

    const payload = { mouthCues: [], metadata: { duration: 0 } };
    worker.emitMessage({ type: 'result', id: job!.id, result: payload });

    await expect(result).resolves.toEqual(payload);
  });
});
