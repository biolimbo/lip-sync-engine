import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool, WorkerPoolDestroyedError } from '../src/ts/WorkerPool';

/**
 * Minimal Worker stand-in. Tests drive each worker by calling the helpers
 * below. Like a real worker, a terminated stub delivers no further events.
 */
class StubWorker {
  static instances: StubWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
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

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  protected dispatch(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    this.listeners.forEach(listener => listener(event));
  }

  emitMessage(data: unknown): void {
    if (this.terminated) return;
    this.dispatch(data);
  }

  /** Runtime error, delivered as an ErrorEvent with a message */
  emitError(message: string): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { type: 'error', message, preventDefault: vi.fn() };
    if (!this.terminated) this.onerror?.(event as unknown as Event);
    return event;
  }

  /** Script load failure, delivered as a plain Event without a message */
  emitLoadFailure(): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { type: 'error', preventDefault: vi.fn() };
    if (!this.terminated) this.onerror?.(event as unknown as Event);
    return event;
  }

  analyzeJobs(): Array<{ type: 'analyze'; id: number }> {
    return this.posted.filter(
      (m): m is { type: 'analyze'; id: number } => (m as { type: string }).type === 'analyze'
    );
  }
}

/** Ignores terminate(), to prove late messages cannot revive a worker. */
class UnstoppableStubWorker extends StubWorker {
  emitMessage(data: unknown): void {
    this.dispatch(data);
  }
}

interface FetchCall {
  url: string;
  signal?: AbortSignal;
  succeed: () => void;
  fail: () => void;
}

/** Controllable fetch that honors AbortSignal like the real one */
function stubFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      calls.push({
        url,
        signal,
        succeed: () => resolve({ blob: async () => new Blob(['// worker']) }),
        fail: () => reject(new TypeError('Failed to fetch'))
      });
    })
  );
  return calls;
}

const RESULT = { mouthCues: [], metadata: { duration: 0 } };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !condition(); i++) {
    await flush();
  }
  expect(condition()).toBe(true);
}

const waitForWorkers = (count: number) => waitFor(() => StubWorker.instances.length >= count);

/** Settle state of a promise without awaiting it */
function track<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { status: 'pending' };
  promise.then(
    () => { state.status = 'resolved'; },
    error => { state.status = 'rejected'; state.error = error; }
  );
  return state;
}

let pool: WorkerPool;

beforeEach(() => {
  StubWorker.instances = [];
  vi.stubGlobal('Worker', StubWorker);
  pool = WorkerPool.getInstance(3, 'stub-worker.js');
});

afterEach(() => {
  pool.destroy();
  // Pass a size so Node versions without a global navigator work
  WorkerPool.getInstance(1).destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function initPool(target: WorkerPool = pool): Promise<StubWorker> {
  const before = StubWorker.instances.length;
  const init = target.init();
  await waitForWorkers(before + 1);
  const worker = StubWorker.instances[before];
  worker.emitMessage({ type: 'ready' });
  await init;
  return worker;
}

async function warmPool(): Promise<StubWorker[]> {
  await initPool();
  const warmup = pool.warmup();
  await waitForWorkers(3);
  StubWorker.instances.slice(1).forEach(w => w.emitMessage({ type: 'ready' }));
  await warmup;
  return StubWorker.instances;
}

describe('WorkerPool startup', () => {
  it('terminates every worker when destroyed after a failed warmup', async () => {
    vi.stubGlobal('Worker', UnstoppableStubWorker);
    await initPool();

    const warmup = pool.warmup();
    await waitForWorkers(3);
    const [, second, third] = StubWorker.instances;

    second.emitMessage({ type: 'error', error: 'boom' });
    await expect(warmup).rejects.toThrow('boom');
    pool.destroy();

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

  it('rejects init() when the worker throws while loading', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    const event = StubWorker.instances[0].emitError('SyntaxError in worker.js');

    await expect(init).rejects.toThrow('Worker failed to load: SyntaxError in worker.js');
    expect(StubWorker.instances[0].terminated).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('rejects init() when the worker script fails to load (plain Event)', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    StubWorker.instances[0].emitLoadFailure();

    await expect(init).rejects.toThrow('Worker failed to load: unknown error');
    expect(StubWorker.instances[0].terminated).toBe(true);
  });

  it('rejects warmup() as soon as one worker fails, while another is still starting', async () => {
    await initPool();

    const warmup = track(pool.warmup());
    await waitForWorkers(3);
    const [, second, third] = StubWorker.instances;

    second.emitLoadFailure();
    await flush();

    // Third worker has not answered yet, warmup() must not wait for it
    expect(warmup.status).toBe('rejected');
    expect(String(warmup.error)).toContain('Worker failed to load');
    expect(second.terminated).toBe(true);

    // A worker that starts later still joins the live pool
    third.emitMessage({ type: 'ready' });
    await flush();
    expect(pool.getStats().totalWorkers).toBe(2);
  });

  it('rejects a pending init() with WorkerPoolDestroyedError when destroyed', async () => {
    const init = pool.init();
    await waitForWorkers(1);

    pool.destroy();

    await expect(init).rejects.toBeInstanceOf(WorkerPoolDestroyedError);
    expect(StubWorker.instances[0].terminated).toBe(true);
  });

  it('can be initialized again after destroy()', async () => {
    const staleInit = pool.init();
    await waitForWorkers(1);
    pool.destroy();
    await expect(staleInit).rejects.toBeInstanceOf(WorkerPoolDestroyedError);

    const worker = await initPool();
    expect(worker).toBe(StubWorker.instances[1]);
    expect(pool.getStats().totalWorkers).toBe(1);

    const result = pool.analyze(new Int16Array(4));
    worker.emitMessage({ type: 'result', id: worker.analyzeJobs()[0].id, result: RESULT });
    await expect(result).resolves.toEqual(RESULT);
  });

  it('shares one startup between concurrent init() calls', async () => {
    const first = pool.init();
    const second = pool.init();
    await waitForWorkers(1);
    await flush();
    expect(StubWorker.instances).toHaveLength(1);

    StubWorker.instances[0].emitMessage({ type: 'ready' });
    await Promise.all([first, second]);
    expect(pool.getStats().totalWorkers).toBe(1);
  });

  it('never starts more than maxWorkers with concurrent warmup() calls', async () => {
    await initPool();

    const first = pool.warmup();
    const second = track(pool.warmup());
    await waitForWorkers(3);
    await flush();
    expect(StubWorker.instances).toHaveLength(3);
    // The second call waits for the shared warmup instead of returning early
    expect(second.status).toBe('pending');

    StubWorker.instances.slice(1).forEach(w => w.emitMessage({ type: 'ready' }));
    await first;
    await flush();
    expect(second.status).toBe('resolved');
    expect(pool.getStats().totalWorkers).toBe(3);
  });

  it('counts workers that are still starting when warmup() is retried after a failure', async () => {
    await initPool();

    const failed = pool.warmup();
    await waitForWorkers(3);
    StubWorker.instances[1].emitLoadFailure();
    await expect(failed).rejects.toThrow('Worker failed to load');

    // Worker 3 is still starting, so the retry only replaces worker 2
    const retry = pool.warmup();
    await waitForWorkers(4);
    await flush();
    expect(StubWorker.instances).toHaveLength(4);

    StubWorker.instances[2].emitMessage({ type: 'ready' });
    StubWorker.instances[3].emitMessage({ type: 'ready' });
    await retry;
    expect(pool.getStats().totalWorkers).toBe(3);
  });
});

describe('WorkerPool startup failures', () => {
  const DATA_ERROR = 'Worker initialization failed: Failed to load model data from /lip-sync-engine.data: network error';

  it('rejects warmup() when a worker cannot load the .data file, and retries only the missing workers', async () => {
    await initPool();

    const warmup = pool.warmup();
    await waitForWorkers(3);
    const [, second, third] = StubWorker.instances;
    third.emitMessage({ type: 'ready' });
    second.emitMessage({ type: 'error', error: DATA_ERROR });

    await expect(warmup).rejects.toThrow(DATA_ERROR);
    expect(second.terminated).toBe(true);
    expect(pool.getStats().totalWorkers).toBe(2);

    const retry = pool.warmup();
    await waitForWorkers(4);
    expect(StubWorker.instances).toHaveLength(4);
    StubWorker.instances[3].emitMessage({ type: 'ready' });
    await expect(retry).resolves.toBeUndefined();
    expect(pool.getStats().totalWorkers).toBe(3);
  });

  it('rejects init() with the data error and starts a new worker on the next init()', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    StubWorker.instances[0].emitMessage({ type: 'error', error: DATA_ERROR });
    await expect(init).rejects.toThrow(DATA_ERROR);

    const worker = await initPool();
    expect(worker).toBe(StubWorker.instances[1]);
    expect(pool.getStats().totalWorkers).toBe(1);
  });

  it('rejects init() when the worker\'s reply cannot be read', async () => {
    const init = pool.init();
    await waitForWorkers(1);
    const worker = StubWorker.instances[0] as unknown as { onmessageerror: (() => void) | null };
    worker.onmessageerror?.();

    await expect(init).rejects.toThrow('could not read the worker\'s reply');
    expect(StubWorker.instances[0].terminated).toBe(true);
  });
});

describe('WorkerPool CDN worker script', () => {
  const CDN_URL = 'https://cdn.example/worker.js';

  beforeEach(() => {
    pool.destroy();
    pool = WorkerPool.getInstance(3, CDN_URL);
  });

  it('rejects init() right away when destroyed during a stalled script fetch', async () => {
    const calls = stubFetch();

    const init = track(pool.init());
    await waitFor(() => calls.length === 1);

    pool.destroy();
    await flush();

    expect(calls[0].signal?.aborted).toBe(true);
    expect(init.status).toBe('rejected');
    expect(init.error).toBeInstanceOf(WorkerPoolDestroyedError);
    expect(StubWorker.instances).toHaveLength(0);
  });

  it('fetches the script once for all workers and revokes the blob URL on destroy', async () => {
    const calls = stubFetch();
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    const init = pool.init();
    await waitFor(() => calls.length === 1);
    calls[0].succeed();
    await waitForWorkers(1);
    StubWorker.instances[0].emitMessage({ type: 'ready' });
    await init;

    const warmup = pool.warmup();
    await waitForWorkers(3);
    StubWorker.instances.slice(1).forEach(w => w.emitMessage({ type: 'ready' }));
    await warmup;

    expect(calls).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    const blobUrl = create.mock.results[0].value as string;
    expect(StubWorker.instances.map(w => w.url)).toEqual([blobUrl, blobUrl, blobUrl]);

    pool.destroy();
    expect(revoke).toHaveBeenCalledWith(blobUrl);
  });

  it('falls back to the direct URL when the fetch fails, and retries the fetch next time', async () => {
    const calls = stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const init = pool.init();
    await waitFor(() => calls.length === 1);
    calls[0].fail();
    await waitForWorkers(1);
    expect(StubWorker.instances[0].url).toBe(CDN_URL);
    StubWorker.instances[0].emitMessage({ type: 'ready' });
    await init;

    pool.warmup().catch(() => {});
    await waitFor(() => calls.length === 2);
  });
});

describe('WorkerPool singleton', () => {
  it('does not clear a newer singleton when a stale instance is destroyed again', async () => {
    const stale = pool;
    stale.destroy();

    const current = WorkerPool.getInstance(1, 'stub-worker.js');
    pool = current;
    const worker = await initPool(current);

    stale.destroy();

    expect(WorkerPool.getInstance()).toBe(current);
    expect(worker.terminated).toBe(false);
  });
});

describe('WorkerPool analysis', () => {
  it('routes analysis results after startup', async () => {
    const worker = await initPool();

    const result = pool.analyze(new Int16Array(4));
    const [job] = worker.analyzeJobs();
    worker.emitMessage({ type: 'result', id: job.id, result: RESULT });

    await expect(result).resolves.toEqual(RESULT);
  });

  it('gives a job queued during warmup to the next worker that becomes ready', async () => {
    const first = await initPool();
    const busy = pool.analyze(new Int16Array(4));
    busy.catch(() => {});

    const warmup = pool.warmup();
    await waitForWorkers(3);
    const queued = pool.analyze(new Int16Array(4));
    expect(pool.getStats().queuedJobs).toBe(1);

    const second = StubWorker.instances[1];
    second.emitMessage({ type: 'ready' });
    await flush();

    expect(pool.getStats().queuedJobs).toBe(0);
    expect(second.analyzeJobs()).toHaveLength(1);
    second.emitMessage({ type: 'result', id: second.analyzeJobs()[0].id, result: RESULT });
    await expect(queued).resolves.toEqual(RESULT);

    StubWorker.instances[2].emitMessage({ type: 'ready' });
    await warmup;
    expect(first.analyzeJobs()).toHaveLength(1);
  });

  it('rejects the running and queued jobs when the last worker crashes, then can restart', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = await initPool();

    const running = pool.analyze(new Int16Array(4));
    const queued = pool.analyze(new Int16Array(4));
    expect(pool.getStats().queuedJobs).toBe(1);

    worker.emitError('RuntimeError: memory access out of bounds');

    await expect(running).rejects.toThrow('Worker crashed: RuntimeError: memory access out of bounds');
    await expect(queued).rejects.toThrow('All WorkerPool workers failed');
    expect(worker.terminated).toBe(true);
    await expect(pool.analyze(new Int16Array(4))).rejects.toThrow('not initialized');

    const replacement = await initPool();
    const result = pool.analyze(new Int16Array(4));
    replacement.emitMessage({ type: 'result', id: replacement.analyzeJobs()[0].id, result: RESULT });
    await expect(result).resolves.toEqual(RESULT);
  });

  it('keeps queued jobs for the remaining workers when one of several crashes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [first, second, third] = await warmPool();

    const jobs = [0, 1, 2].map(() => pool.analyze(new Int16Array(4)));
    const queued = pool.analyze(new Int16Array(4));

    first.emitError('crash');
    await expect(jobs[0]).rejects.toThrow('Worker crashed');
    expect(pool.getStats().queuedJobs).toBe(1);

    second.emitMessage({ type: 'result', id: second.analyzeJobs()[0].id, result: RESULT });
    await expect(jobs[1]).resolves.toEqual(RESULT);
    const [, next] = second.analyzeJobs();
    second.emitMessage({ type: 'result', id: next.id, result: RESULT });
    await expect(queued).resolves.toEqual(RESULT);

    third.emitMessage({ type: 'result', id: third.analyzeJobs()[0].id, result: RESULT });
    await expect(jobs[2]).resolves.toEqual(RESULT);
  });
});

describe('WorkerPool.getMemoryStats', () => {
  const statsRequests = (worker: StubWorker) =>
    worker.posted.filter((m): m is { type: 'stats'; id: number } => (m as { type: string }).type === 'stats');

  it('reports each running worker', async () => {
    const worker = await initPool();
    const stats = pool.getMemoryStats();
    worker.emitMessage({ type: 'stats', id: statsRequests(worker)[0].id, wasmHeapBytes: 1024 });

    await expect(stats).resolves.toEqual({ workers: [1024], totalBytes: 1024 });
  });

  it('counts a worker that crashes before it answers as 0 bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [first, second] = await warmPool();
    const stats = pool.getMemoryStats();

    second.emitMessage({ type: 'stats', id: statsRequests(second)[0].id, wasmHeapBytes: 2048 });
    first.emitError('RuntimeError: unreachable');
    const third = StubWorker.instances[2];
    third.emitMessage({ type: 'stats', id: statsRequests(third)[0].id, wasmHeapBytes: 4096 });

    await expect(stats).resolves.toEqual({ workers: [0, 2048, 4096], totalBytes: 6144 });
  });
});

describe('StreamAnalyzerController', () => {
  it('counts completed chunks', async () => {
    const worker = await initPool();
    const stream = pool.createStreamAnalyzer();

    stream.addChunk(new Int16Array(4));
    stream.addChunk(new Int16Array(4));
    expect(stream.getStats().chunksCompleted).toBe(0);

    const [firstJob] = worker.analyzeJobs();
    worker.emitMessage({ type: 'result', id: firstJob.id, result: RESULT });
    await flush();
    expect(stream.getStats()).toMatchObject({ chunksAdded: 2, chunksCompleted: 1 });

    const [, secondJob] = worker.analyzeJobs();
    worker.emitMessage({ type: 'result', id: secondJob.id, result: RESULT });
    await expect(stream.finalize()).resolves.toEqual([RESULT, RESULT]);
    expect(stream.getStats().chunksCompleted).toBe(2);
  });

  it('names end() or finalize() when a chunk is added afterwards', async () => {
    await initPool();
    const ended = pool.createStreamAnalyzer();
    ended.end();
    expect(() => ended.addChunk(new Int16Array(4))).toThrow('Cannot add chunks after end() has been called');

    const finalized = pool.createStreamAnalyzer();
    void finalized.finalize();
    expect(() => finalized.addChunk(new Int16Array(4))).toThrow('Cannot add chunks after finalize() has been called');
  });

  it('does not report unhandled rejections when destroyed before finalize()', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      await initPool();
      const stream = pool.createStreamAnalyzer();
      stream.addChunk(new Int16Array(4));
      stream.addChunk(new Int16Array(4));

      pool.destroy();
      await flush();
      await flush();

      expect(unhandled).toEqual([]);
      await expect(stream.finalize()).rejects.toBeInstanceOf(WorkerPoolDestroyedError);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
