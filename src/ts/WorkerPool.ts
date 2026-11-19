import type { LipSyncEngineResult, LipSyncEngineOptions } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';
import packageJson from '../../package.json';

/**
 * Error used to reject startup and analysis promises when the pool is destroyed.
 * Check `error instanceof WorkerPoolDestroyedError` (or `error.name`) to ignore
 * it during cleanup, for example when a component unmounts mid-initialization.
 */
export class WorkerPoolDestroyedError extends Error {
  constructor(message = 'WorkerPool destroyed') {
    super(message);
    this.name = 'WorkerPoolDestroyedError';
  }
}

/**
 * Represents a worker in the pool
 */
interface PoolWorker {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  /** Id of the job this worker is running, if any */
  jobId: number | null;
}

/**
 * Represents a pending analysis job
 */
interface PendingJob {
  id: number;
  pcm16: Int16Array;
  options: LipSyncEngineOptions;
  resolve: (result: LipSyncEngineResult) => void;
  reject: (error: Error) => void;
}

const isRemoteUrl = (url: string) => url.startsWith('http://') || url.startsWith('https://');

/**
 * Stop a worker and drop its handlers so no late event reaches the pool
 */
function stopWorker(worker: Worker): void {
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
}

/**
 * Web Worker pool for non-blocking lip-sync-engine analysis
 * Manages multiple workers with automatic load balancing
 */
export class WorkerPool {
  private static instance: WorkerPool | null = null;

  private workers: PoolWorker[] = [];
  private queue: PendingJob[] = [];
  private inFlightJobs: Map<number, PendingJob> = new Map();
  private nextJobId = 0;
  private maxWorkers: number;
  private workerScriptUrl: string;
  private wasmPaths: {
    wasmPath: string;
    dataPath: string;
    jsPath: string;
  };
  private initialized = false;

  /**
   * Aborted and replaced by destroy(). Everything started before a destroy()
   * (script fetches and starting workers) listens to this signal and stops.
   */
  private lifecycle = new AbortController();
  /** Workers in the current lifecycle that are fetching their script or initializing */
  private startingWorkers = 0;
  private initPromise: Promise<void> | null = null;
  private warmupPromise: Promise<void> | null = null;
  /** Worker script fetched once per lifecycle and shared by all workers */
  private workerUrlCache: { scriptUrl: string; promise: Promise<string> } | null = null;
  /** Blob URLs created for the worker script, revoked by destroy() */
  private blobUrls: string[] = [];

  private constructor(
    maxWorkers: number = navigator.hardwareConcurrency || 4,
    workerScriptUrl?: string
  ) {
    this.maxWorkers = Math.max(1, maxWorkers);

    const version = packageJson.version;

    // Default worker script URL - uses CDN, can be overridden
    this.workerScriptUrl = workerScriptUrl || `https://unpkg.com/lip-sync-engine@${version}/dist/worker.js`;

    // Default WASM paths - uses CDN, can be configured via init()
    this.wasmPaths = {
      wasmPath: `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.wasm`,
      dataPath: `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.data`,
      jsPath: `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.js`
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(maxWorkers?: number, workerScriptUrl?: string): WorkerPool {
    if (!this.instance) {
      this.instance = new WorkerPool(maxWorkers, workerScriptUrl);
    }
    return this.instance;
  }

  /**
   * Initialize the worker pool
   * Must be called before using analyze()
   *
   * Starts a single worker for fast initialization. Use warmup() to start the
   * remaining workers up to maxWorkers. Concurrent calls share one startup,
   * and the options of the first call apply.
   *
   * Rejects with WorkerPoolDestroyedError if destroy() is called before startup finishes.
   */
  async init(options?: {
    wasmPath?: string;
    dataPath?: string;
    jsPath?: string;
    workerScriptUrl?: string;
  }): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    // Update paths if provided
    if (options) {
      if (options.wasmPath) this.wasmPaths.wasmPath = options.wasmPath;
      if (options.dataPath) this.wasmPaths.dataPath = options.dataPath;
      if (options.jsPath) this.wasmPaths.jsPath = options.jsPath;
      if (options.workerScriptUrl) this.workerScriptUrl = options.workerScriptUrl;
    }

    const signal = this.lifecycle.signal;
    const promise = this.createWorker().then(() => {
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      this.initialized = true;
    });
    this.trackStartup(promise, 'initPromise');
    return promise;
  }

  /**
   * Pre-create all workers up to maxWorkers
   * Call this during app initialization to eliminate worker creation overhead
   *
   * Rejects as soon as one worker fails to start. Workers that start
   * successfully stay in the pool. Concurrent calls share one warmup.
   *
   * @example
   * ```typescript
   * const pool = WorkerPool.getInstance();
   * await pool.init({ ... });
   * await pool.warmup(); // Pre-create all workers
   * // Now all workers are ready for chunked processing
   * ```
   */
  async warmup(): Promise<void> {
    if (!this.initialized) {
      throw new Error('WorkerPool not initialized. Call init() first.');
    }
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const workersToCreate = this.maxWorkers - this.workers.length - this.startingWorkers;

    if (workersToCreate <= 0) {
      return; // Already at max workers
    }

    // Create remaining workers in parallel
    const promises: Promise<PoolWorker>[] = [];
    for (let i = 0; i < workersToCreate; i++) {
      promises.push(this.createWorker());
    }

    const promise = Promise.all(promises).then(() => undefined);
    this.trackStartup(promise, 'warmupPromise');
    return promise;
  }

  /**
   * Remember an in-flight init() or warmup() so concurrent calls share it
   */
  private trackStartup(promise: Promise<void>, field: 'initPromise' | 'warmupPromise'): void {
    this[field] = promise;
    const clear = () => {
      if (this[field] === promise) this[field] = null;
    };
    promise.then(clear, clear);
  }

  /**
   * Resolve the URL used to start a worker.
   * Cross-origin (CDN) scripts are fetched once per lifecycle and wrapped in a blob URL.
   */
  private getWorkerUrl(signal: AbortSignal): Promise<string> {
    const scriptUrl = this.workerScriptUrl;
    if (!isRemoteUrl(scriptUrl)) {
      return Promise.resolve(scriptUrl);
    }

    if (this.workerUrlCache && this.workerUrlCache.scriptUrl === scriptUrl) {
      return this.workerUrlCache.promise;
    }

    const promise = this.fetchWorkerScript(scriptUrl, signal);
    const cache = { scriptUrl, promise };
    this.workerUrlCache = cache;

    // Only keep a successful blob URL, so a failed fetch is retried by the next worker
    const drop = () => {
      if (this.workerUrlCache === cache) this.workerUrlCache = null;
    };
    promise.then(url => {
      if (url === scriptUrl) drop();
    }, drop);

    return promise;
  }

  private async fetchWorkerScript(scriptUrl: string, signal: AbortSignal): Promise<string> {
    try {
      const response = await fetch(scriptUrl, { signal });
      const blob = await response.blob();
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      const blobUrl = URL.createObjectURL(blob);
      this.blobUrls.push(blobUrl);
      return blobUrl;
    } catch (fetchError) {
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      console.warn('Failed to fetch worker script, trying direct URL:', fetchError);
      // Fall back to direct URL (will fail with CORS but worth trying)
      return scriptUrl;
    }
  }

  /**
   * Create a new worker and initialize it.
   *
   * The returned promise always settles: it resolves when the worker reports
   * `ready`, and rejects (terminating the worker) on an init error, a load
   * error, or when the pool is destroyed first.
   */
  private async createWorker(): Promise<PoolWorker> {
    const signal = this.lifecycle.signal;
    const isCurrent = () => signal === this.lifecycle.signal;
    this.startingWorkers++;

    let poolWorker: PoolWorker;
    try {
      const workerUrl = await this.getWorkerUrl(signal);
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      poolWorker = await this.startWorker(workerUrl, signal);
    } catch (error) {
      if (isCurrent()) {
        this.startingWorkers--;
        this.failQueueIfNoWorkers();
      }
      throw error;
    }

    if (!isCurrent()) {
      // destroy() ran after the worker became ready and already terminated it
      throw new WorkerPoolDestroyedError();
    }
    this.startingWorkers--;

    // Give queued jobs to the new worker
    this.processQueue();
    return poolWorker;
  }

  /**
   * Start one worker and wait for it to report `ready`
   */
  private startWorker(workerUrl: string, signal: AbortSignal): Promise<PoolWorker> {
    return new Promise<PoolWorker>((resolve, reject) => {
      const worker = new Worker(workerUrl);

      const poolWorker: PoolWorker = {
        worker,
        busy: false,
        ready: false,
        jobId: null
      };

      let settled = false;

      const settle = () => {
        settled = true;
        signal.removeEventListener('abort', onAbort);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settle();
        stopWorker(worker);
        reject(error);
      };

      const onAbort = () => fail(new WorkerPoolDestroyedError());
      signal.addEventListener('abort', onAbort);

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (poolWorker.ready) {
          this.handleWorkerMessage(poolWorker, message);
          return;
        }
        if (settled) return;

        if (message.type === 'ready') {
          settle();
          poolWorker.ready = true;
          this.workers.push(poolWorker);
          resolve(poolWorker);
        } else if (message.type === 'error') {
          fail(new Error(message.error || 'Worker initialization failed'));
        }
      };

      // A script that fails to load fires a plain Event; runtime errors fire an ErrorEvent
      worker.onerror = (event: Event) => {
        const detail = (event as ErrorEvent).message || 'unknown error';

        if (!poolWorker.ready) {
          // Reported through the rejected startup instead of as an uncaught error
          event.preventDefault();
          fail(new Error(`Worker failed to load: ${detail}`));
          return;
        }

        console.error('Worker error:', event);
        this.removeWorker(poolWorker, new Error(`Worker crashed: ${detail}`));
      };

      // Send init message
      const initMessage: WorkerRequest = {
        type: 'init',
        ...this.wasmPaths
      };
      worker.postMessage(initMessage);
    });
  }

  /**
   * Handle messages from workers
   */
  private handleWorkerMessage(poolWorker: PoolWorker, message: WorkerResponse): void {
    if (message.type === 'result') {
      // Find and resolve the in-flight job
      const job = this.inFlightJobs.get(message.id);
      if (job) {
        this.inFlightJobs.delete(message.id);

        if (message.result) {
          job.resolve(message.result);
        } else {
          job.reject(new Error('No result returned from worker'));
        }
      }

      // Mark worker as available and process next job
      poolWorker.busy = false;
      poolWorker.jobId = null;
      this.processQueue();

    } else if (message.type === 'error') {
      // Check if this is an analyze error (has id) or init error (no id)
      if ('id' in message) {
        // Analyze error - find and reject the in-flight job
        const job = this.inFlightJobs.get(message.id);
        if (job) {
          this.inFlightJobs.delete(message.id);
          job.reject(new Error(message.error || 'Unknown worker error'));
        }

        // Mark worker as available and process next job
        poolWorker.busy = false;
        poolWorker.jobId = null;
        this.processQueue();
      }
      // Init errors are handled in startWorker()
    }
  }

  /**
   * Remove a crashed worker from the pool and reject the job it was running
   */
  private removeWorker(poolWorker: PoolWorker, error: Error): void {
    const index = this.workers.indexOf(poolWorker);
    if (index === -1) {
      return;
    }
    this.workers.splice(index, 1);
    stopWorker(poolWorker.worker);

    if (poolWorker.jobId !== null) {
      const job = this.inFlightJobs.get(poolWorker.jobId);
      if (job) {
        this.inFlightJobs.delete(job.id);
        job.reject(error);
      }
      poolWorker.jobId = null;
    }

    this.failQueueIfNoWorkers();
  }

  /**
   * When every worker has failed and none is starting, queued jobs can never run.
   * Reject them and mark the pool uninitialized so init() can restart it.
   */
  private failQueueIfNoWorkers(): void {
    if (!this.initialized || this.workers.length > 0 || this.startingWorkers > 0) {
      return;
    }

    this.initialized = false;
    const queued = this.queue;
    this.queue = [];
    queued.forEach(job => {
      job.reject(new Error('All WorkerPool workers failed. Call init() to restart the pool.'));
    });
  }

  /**
   * Process queued jobs
   * Simple algorithm: assign each queued job to the next available idle worker
   * Workers must be pre-created via init() or warmup()
   */
  private processQueue(): void {
    // Assign all pending jobs to available idle workers
    while (this.queue.length > 0) {
      const idleWorker = this.workers.find(w => w.ready && !w.busy);

      if (!idleWorker) {
        // No idle workers available - jobs will be processed when a worker becomes free
        break;
      }

      const job = this.queue.shift();
      if (!job) break;

      this.assignJobToWorker(job, idleWorker);
    }
  }

  /**
   * Assign a job to a worker
   */
  private assignJobToWorker(job: PendingJob, worker: PoolWorker): void {
    // Add to in-flight jobs
    this.inFlightJobs.set(job.id, job);

    // Mark worker as busy
    worker.busy = true;
    worker.jobId = job.id;

    // Send job to worker
    // Create a true copy with a new ArrayBuffer to avoid detaching the original
    const bufferCopy = new Int16Array(job.pcm16);

    const message: WorkerRequest = {
      type: 'analyze',
      id: job.id,
      pcm16: bufferCopy,
      options: job.options
    };

    // Use transferable objects for zero-copy transfer
    worker.worker.postMessage(message, [bufferCopy.buffer]);
  }

  /**
   * Analyze audio in a Web Worker (non-blocking)
   *
   * @param pcm16 - 16-bit PCM audio buffer
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync-engine result
   */
  async analyze(
    pcm16: Int16Array,
    options: LipSyncEngineOptions = {}
  ): Promise<LipSyncEngineResult> {
    if (!this.initialized) {
      throw new Error('WorkerPool not initialized. Call init() first.');
    }

    // Create a copy of the buffer since we'll transfer ownership to the worker
    const pcm16Copy = new Int16Array(pcm16);

    // Create job promise
    return new Promise<LipSyncEngineResult>((resolve, reject) => {
      const job: PendingJob = {
        id: this.nextJobId++,
        pcm16: pcm16Copy,
        options,
        resolve,
        reject
      };

      // Add to queue
      this.queue.push(job);

      // Try to process immediately
      this.processQueue();
    });
  }

  /**
   * Analyze multiple audio buffers in parallel using chunked processing
   *
   * @param chunks - Array of audio chunks to process
   * @param options - Optional configuration
   * @returns Promise resolving to array of results in same order as input
   */
  async analyzeChunks(
    chunks: Int16Array[],
    options: LipSyncEngineOptions = {}
  ): Promise<LipSyncEngineResult[]> {
    if (!this.initialized) {
      throw new Error('WorkerPool not initialized. Call init() first.');
    }

    // Analyze all chunks in parallel
    const promises = chunks.map(chunk => this.analyze(chunk, options));
    return Promise.all(promises);
  }

  /**
   * Create a dynamic streaming analyzer that allows adding chunks on-the-fly
   * Returns a controller that lets you add chunks as they arrive from a stream
   *
   * @param options - Optional configuration for all chunks
   * @returns StreamController with addChunk() and finalize() methods
   *
   * @example
   * ```typescript
   * const stream = pool.createStreamAnalyzer({ dialogText: "hello" });
   * await pool.warmup(); // Pre-create workers
   *
   * // Add chunks as they arrive from your audio stream
   * for await (const chunk of audioStream) {
   *   stream.addChunk(chunk); // Non-blocking, queues immediately
   * }
   *
   * // Wait for all chunks to complete and get results in order
   * const results = await stream.finalize();
   * ```
   */
  createStreamAnalyzer(options: LipSyncEngineOptions = {}): StreamAnalyzerController {
    if (!this.initialized) {
      throw new Error('WorkerPool not initialized. Call init() first.');
    }

    const controller = new StreamAnalyzerController(this, options);
    return controller;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    queuedJobs: number;
    maxWorkers: number;
  } {
    const busyWorkers = this.workers.filter(w => w.busy).length;
    return {
      totalWorkers: this.workers.length,
      busyWorkers,
      idleWorkers: this.workers.length - busyWorkers,
      queuedJobs: this.queue.length,
      maxWorkers: this.maxWorkers
    };
  }

  /**
   * Destroy the worker pool and terminate all workers.
   * Pending init(), warmup(), and analysis promises reject with WorkerPoolDestroyedError.
   */
  destroy(): void {
    // Reject all pending jobs in queue
    this.queue.forEach(job => {
      job.reject(new WorkerPoolDestroyedError());
    });
    this.queue = [];

    // Reject all in-flight jobs
    this.inFlightJobs.forEach(job => {
      job.reject(new WorkerPoolDestroyedError());
    });
    this.inFlightJobs.clear();

    // Start a new lifecycle, then abort the old one. This cancels worker script
    // fetches and terminates workers that are still starting, rejecting their startup.
    const lifecycle = this.lifecycle;
    this.lifecycle = new AbortController();
    this.startingWorkers = 0;
    this.initPromise = null;
    this.warmupPromise = null;
    this.workerUrlCache = null;
    lifecycle.abort();

    // Terminate all ready workers
    this.workers.forEach(poolWorker => {
      stopWorker(poolWorker.worker);
    });
    this.workers = [];

    // Every worker is stopped, so the worker script blob URLs can be released
    this.blobUrls.forEach(url => URL.revokeObjectURL(url));
    this.blobUrls = [];

    this.initialized = false;

    // A stale instance must not clear a newer singleton
    if (WorkerPool.instance === this) {
      WorkerPool.instance = null;
    }
  }
}

/**
 * Controller for dynamic streaming analysis
 * Allows adding chunks on-the-fly as they arrive from a stream
 */
export class StreamAnalyzerController {
  private pool: WorkerPool;
  private options: LipSyncEngineOptions;
  private chunks: Array<{ index: number; promise: Promise<LipSyncEngineResult> }> = [];
  private nextIndex = 0;
  private completedChunks = 0;
  private finalized = false;

  constructor(pool: WorkerPool, options: LipSyncEngineOptions) {
    this.pool = pool;
    this.options = options;
  }

  /**
   * Add a chunk to be analyzed
   * This immediately queues the chunk for processing - no main thread blocking
   *
   * @param chunk - Audio chunk to analyze
   * @returns The index of this chunk in the result array
   */
  addChunk(chunk: Int16Array): number {
    if (this.finalized) {
      throw new Error('Cannot add chunks after finalize() has been called');
    }

    const index = this.nextIndex++;
    const promise = this.pool.analyze(chunk, this.options);

    // Count settled chunks. This also handles a rejection that happens before
    // finalize() is called, so it is not reported as unhandled; finalize() still
    // receives the original promise and rejects with that error.
    const markCompleted = () => {
      this.completedChunks++;
    };
    promise.then(markCompleted, markCompleted);

    this.chunks.push({ index, promise });

    return index;
  }

  /**
   * Wait for all chunks to complete and return results in insertion order
   *
   * @returns Array of results in the same order chunks were added
   */
  async finalize(): Promise<LipSyncEngineResult[]> {
    this.finalized = true;

    // Wait for all chunks to complete
    const results = await Promise.all(this.chunks.map(c => c.promise));

    // Results are already in order since we preserved insertion order
    return results;
  }

  /**
   * Get current streaming statistics
   */
  getStats(): {
    chunksAdded: number;
    chunksCompleted: number;
    poolStats: ReturnType<WorkerPool['getStats']>;
  } {
    return {
      chunksAdded: this.chunks.length,
      chunksCompleted: this.completedChunks,
      poolStats: this.pool.getStats()
    };
  }
}
