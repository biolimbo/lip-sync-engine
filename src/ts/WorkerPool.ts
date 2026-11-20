import type { LipSyncEngineResult, LipSyncEngineOptions, RecognizerKind } from './types';
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
  /** Speech decoder already built (first analysis will not pay for it) */
  warm: boolean;
}

/**
 * When to build the speech decoder (the expensive part of worker start-up):
 * - true: every worker builds it during init()/warmup()
 * - 'first': only the init() worker does; warmup() workers build it on their
 *   first job (they are only used when the warm workers are busy)
 * - false: on each worker's first job
 */
export type PrewarmMode = boolean | 'first';

/** Compiled modules shared across pools, keyed by .wasm URL */
const compiledModules = new Map<string, WebAssembly.Module>();

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

  private prewarm: PrewarmMode = true;
  private shareAssets = true;
  private recognizer: RecognizerKind = 'pocketsphinx';
  private statsRequests: Map<number, (bytes: number) => void> = new Map();

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
    /**
     * When to build each worker's speech decoder. Default true (during
     * init/warmup, so no analysis pays for it). See PrewarmMode.
     */
    prewarm?: PrewarmMode;
    /**
     * Compile the .wasm once: the first worker sends its compiled module back
     * and later workers (and pools created later) reuse it instead of
     * compiling again. Default true. (The .data file is not shared: copying
     * it into each worker cost more memory than it saved time; workers fetch
     * it from the HTTP cache.)
     */
    shareAssets?: boolean;
    /**
     * Speech recognizer for all workers (default 'pocketsphinx').
     * See RecognizerKind.
     */
    recognizer?: RecognizerKind;
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
      if (options.prewarm !== undefined) this.prewarm = options.prewarm;
      if (options.shareAssets !== undefined) this.shareAssets = options.shareAssets;
      if (options.recognizer) this.recognizer = options.recognizer;
    }

    const signal = this.lifecycle.signal;
    const promise = this.createWorker(this.prewarm !== false).then(() => {
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      this.initialized = true;
    });
    this.trackStartup(promise, 'initPromise');
    return promise;
  }

  /** Compiled module from an earlier worker, if sharing is on */
  private sharedModule(): WebAssembly.Module | undefined {
    return this.shareAssets ? compiledModules.get(this.wasmPaths.wasmPath) : undefined;
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
      promises.push(this.createWorker(this.prewarm === true));
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
  private async createWorker(prewarm: boolean): Promise<PoolWorker> {
    const signal = this.lifecycle.signal;
    const isCurrent = () => signal === this.lifecycle.signal;
    this.startingWorkers++;

    let poolWorker: PoolWorker;
    try {
      const workerUrl = await this.getWorkerUrl(signal);
      if (signal.aborted) {
        throw new WorkerPoolDestroyedError();
      }
      poolWorker = await this.startWorker(workerUrl, signal, prewarm, this.sharedModule());
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
  private startWorker(
    workerUrl: string,
    signal: AbortSignal,
    prewarm: boolean,
    wasmModule: WebAssembly.Module | undefined
  ): Promise<PoolWorker> {
    return new Promise<PoolWorker>((resolve, reject) => {
      const worker = new Worker(workerUrl);

      const poolWorker: PoolWorker = {
        worker,
        busy: false,
        ready: false,
        jobId: null,
        warm: false
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
          const ready = message as { warm?: boolean; wasmModule?: WebAssembly.Module };
          poolWorker.warm = !!ready.warm;
          if (this.shareAssets && ready.wasmModule && !compiledModules.has(this.wasmPaths.wasmPath)) {
            compiledModules.set(this.wasmPaths.wasmPath, ready.wasmModule);
          }
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

      // Send init message. A compiled module is shared, not copied; without
      // one, ask the worker to send its compiled module back for reuse.
      const initMessage: WorkerRequest = {
        type: 'init',
        ...this.wasmPaths,
        prewarm,
        recognizer: this.recognizer,
        wasmModule,
        returnModule: this.shareAssets && !wasmModule
      };
      worker.postMessage(initMessage);
    });
  }

  /**
   * Handle messages from workers
   */
  private handleWorkerMessage(poolWorker: PoolWorker, message: WorkerResponse): void {
    if (message.type === 'stats') {
      const pending = this.statsRequests.get(message.id);
      if (pending) {
        this.statsRequests.delete(message.id);
        pending(message.wasmHeapBytes);
      }
      return;
    }
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
      poolWorker.warm = true;
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
      // Prefer workers whose decoder is already built
      const idleWorker =
        this.workers.find(w => w.ready && !w.busy && w.warm) ||
        this.workers.find(w => w.ready && !w.busy);

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
  createStreamAnalyzer(options: StreamAnalyzerOptions = {}): StreamAnalyzerController {
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
   * WebAssembly memory size of each worker, in bytes. This is most of a
   * worker's memory; the browser adds the JS heap and the model file copy
   * (about 39 MB per worker) on top.
   */
  async getMemoryStats(): Promise<{ workers: number[]; totalBytes: number }> {
    const workers = await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<number>((resolve) => {
            const id = this.nextJobId++;
            this.statsRequests.set(id, resolve);
            w.worker.postMessage({ type: 'stats', id } as WorkerRequest);
          })
      )
    );
    return { workers, totalBytes: workers.reduce((a, b) => a + b, 0) };
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
    this.statsRequests.forEach(resolve => resolve(0));
    this.statsRequests.clear();

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
 * Options for a streaming analyzer
 */
export interface StreamAnalyzerOptions extends LipSyncEngineOptions {
  /**
   * Milliseconds of earlier audio analysed together with each chunk
   * (default 0). Gives the recogniser context across chunk boundaries.
   * Recommended: 500.
   */
  contextMs?: number;
  /**
   * Milliseconds of later audio to wait for and analyse together with each
   * chunk (default 0). Short chunks analysed without the audio that follows
   * them lose most of their mouth shapes; see BENCHMARK.md. The controller
   * never waits past a chunk's estimated playback time (see
   * `deadlineMarginMs`), and never for the first chunk unless
   * `firstChunkLookahead` is set. Recommended: 500.
   */
  lookaheadMs?: number;
  /**
   * Also wait for lookahead before the first chunk (default false). Off by
   * default because nothing can play until the first chunk's cues are back.
   */
  firstChunkLookahead?: boolean;
  /**
   * Lookahead waiting assumes playback starts when the first chunk's result
   * is returned and runs in real time, and starts each analysis early enough
   * to finish this many milliseconds before its chunk plays (default 150).
   */
  deadlineMarginMs?: number;
  /**
   * Upper limit on how long any chunk waits for lookahead, in milliseconds
   * (default 2000).
   */
  maxWaitMs?: number;
  /**
   * Maximum analyses of this stream running at once (default 2; windowed mode
   * only). Chunks that become ready together are analysed in one window, so
   * a low number keeps CPU use down. Needs at least this many pool workers to
   * run in parallel.
   */
  maxConcurrent?: number;
  /** Maximum audio covered by one batched analysis, ms (default 3000) */
  maxBatchMs?: number;
}

interface StreamChunk {
  index: number;
  start: number; // sample offset in the stream
  length: number;
  promise: Promise<LipSyncEngineResult>;
  resolve: (r: LipSyncEngineResult) => void;
  reject: (e: Error) => void;
}

/**
 * Controller for dynamic streaming analysis
 * Allows adding chunks on-the-fly as they arrive from a stream
 *
 * Without `contextMs`/`lookaheadMs` every chunk is analysed on its own as soon
 * as it is added (1.0.x behaviour). With them, each chunk is analysed inside a
 * window of surrounding audio and only its own cues are returned, with times
 * relative to the chunk start.
 */
export class StreamAnalyzerController {
  private pool: WorkerPool;
  private options: LipSyncEngineOptions;
  private sampleRate: number;
  private windowed: boolean;
  private contextSamples: number;
  private lookaheadSamples: number;
  private firstChunkLookahead: boolean;
  private deadlineMarginMs: number;
  private maxWaitMs: number;
  private maxConcurrent: number;
  private maxBatchSamples: number;

  private chunks: StreamChunk[] = [];
  private audio: Int16Array[] = [];
  private totalSamples = 0;
  private nextToAnalyze = 0;
  private inFlight = 0;
  private ended = false;
  private firstResultAt: number | null = null;
  private addedAt: number[] = [];
  /** Estimated analysis time, ms per second of analysed audio */
  private msPerAudioSecond = 400;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private completed = 0;
  private finalized = false;

  constructor(pool: WorkerPool, options: StreamAnalyzerOptions) {
    const {
      contextMs = 0,
      lookaheadMs = 0,
      firstChunkLookahead = false,
      deadlineMarginMs = 150,
      maxWaitMs = 2000,
      maxConcurrent = 2,
      maxBatchMs = 3000,
      ...analyzeOptions
    } = options;
    this.pool = pool;
    this.options = analyzeOptions;
    this.sampleRate = analyzeOptions.sampleRate || 16000;
    const toSamples = (ms: number) => Math.max(0, Math.round((ms / 1000) * this.sampleRate));
    this.contextSamples = toSamples(contextMs);
    this.lookaheadSamples = toSamples(lookaheadMs);
    this.windowed = this.contextSamples > 0 || this.lookaheadSamples > 0;
    this.firstChunkLookahead = firstChunkLookahead;
    this.deadlineMarginMs = deadlineMarginMs;
    this.maxWaitMs = maxWaitMs;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxBatchSamples = Math.max(1, toSamples(maxBatchMs));
  }

  /**
   * Add a chunk to be analyzed
   * This immediately queues the chunk for processing - no main thread blocking
   *
   * @param chunk - Audio chunk to analyze
   * @returns The index of this chunk in the result array
   */
  addChunk(chunk: Int16Array): number {
    if (this.finalized || this.ended) {
      throw new Error('Cannot add chunks after finalize() has been called');
    }

    const index = this.chunks.length;
    let resolve!: (r: LipSyncEngineResult) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<LipSyncEngineResult>((res, rej) => { resolve = res; reject = rej; });
    promise.then(() => { this.completed++; }, () => { this.completed++; });
    const entry: StreamChunk = { index, start: this.totalSamples, length: chunk.length, promise, resolve, reject };
    this.chunks.push(entry);
    this.addedAt.push(now());

    if (!this.windowed) {
      // 1.0.x behaviour: analyse on its own, right away
      this.pool.analyze(chunk, this.options).then(resolve, reject);
      return index;
    }

    this.audio.push(chunk.slice());
    this.totalSamples += chunk.length;
    this.schedule();
    return index;
  }

  /**
   * Signal that no more chunks will be added. Chunks still waiting for
   * lookahead are analysed with whatever audio follows them.
   */
  end(): void {
    this.ended = true;
    this.schedule();
  }

  /**
   * Wait for one chunk's result
   *
   * @param index - Value returned by addChunk()
   */
  getResult(index: number): Promise<LipSyncEngineResult> {
    const entry = this.chunks[index];
    if (!entry) {
      return Promise.reject(new Error(`No chunk with index ${index}`));
    }
    return entry.promise;
  }

  /**
   * Wait for all chunks to complete and return results in insertion order.
   * Implies end().
   *
   * @returns Array of results in the same order chunks were added
   */
  async finalize(): Promise<LipSyncEngineResult[]> {
    this.finalized = true;
    this.end();
    return Promise.all(this.chunks.map(c => c.promise));
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
      chunksCompleted: this.completed,
      poolStats: this.pool.getStats()
    };
  }

  // ---- windowed mode ----

  private lookaheadAvailable(c: StreamChunk): number {
    return this.totalSamples - (c.start + c.length);
  }

  private hasFullLookahead(c: StreamChunk): boolean {
    return this.ended || this.lookaheadAvailable(c) >= this.lookaheadSamples;
  }

  /**
   * Time by which analysis of chunk `c` must start so its cues are back
   * before it plays, or null when unknown (first result not back yet).
   */
  private latestStart(c: StreamChunk): number | null {
    if (this.firstResultAt === null) return null;
    const playsAt = this.firstResultAt + (c.start / this.sampleRate) * 1000;
    const windowSeconds = (Math.min(c.start, this.contextSamples) + c.length + this.lookaheadAvailable(c)) / this.sampleRate;
    return playsAt - this.deadlineMarginMs - this.msPerAudioSecond * windowSeconds;
  }

  private isReady(c: StreamChunk, t: number): { ready: boolean; wakeAt?: number } {
    if (c.index === 0 && !this.firstChunkLookahead) return { ready: true };
    if (this.hasFullLookahead(c)) return { ready: true };
    const capAt = this.addedAt[c.index] + this.maxWaitMs;
    const latest = this.latestStart(c);
    const wakeAt = latest === null ? capAt : Math.min(capAt, latest);
    return t >= wakeAt ? { ready: true } : { ready: false, wakeAt };
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inFlight < this.maxConcurrent && this.nextToAnalyze < this.chunks.length) {
      const first = this.chunks[this.nextToAnalyze];
      const t = now();
      const r = this.isReady(first, t);
      if (!r.ready) {
        if (r.wakeAt !== undefined) {
          this.timer = setTimeout(() => this.schedule(), Math.max(0, r.wakeAt - t));
        }
        return;
      }
      // Batch following chunks that already have their lookahead, but only
      // as much audio as can be analysed before the first one plays.
      const batch = [first];
      let covered = first.length;
      const firstAlone = first.index === 0 && !this.firstChunkLookahead;
      const budget = this.batchBudgetSamples(first, t);
      // Not even `first` fits with full lookahead, but would with less:
      // analyse it alone with the lookahead that fits.
      const fitLookahead = this.lookaheadThatFits(first, t);
      while (!firstAlone && fitLookahead === null) {
        const next = this.chunks[this.nextToAnalyze + batch.length];
        if (!next || !this.hasFullLookahead(next)) break;
        if (covered + next.length > Math.min(this.maxBatchSamples, budget)) break;
        batch.push(next);
        covered += next.length;
      }
      this.nextToAnalyze += batch.length;
      this.run(batch, fitLookahead ?? undefined);
    }
  }

  /** Chunk audio a batch starting with `first` may cover and still finish before `first` plays */
  private batchBudgetSamples(first: StreamChunk, t: number): number {
    if (this.firstResultAt === null) return first.length;
    const playsAt = this.firstResultAt + (first.start / this.sampleRate) * 1000;
    const msLeft = playsAt - this.deadlineMarginMs - t;
    const windowSeconds = msLeft / this.msPerAudioSecond;
    const extra = (Math.min(first.start, this.contextSamples) + this.lookaheadSamples) / this.sampleRate;
    const budget = Math.floor((windowSeconds - extra) * this.sampleRate);
    // Already too late for `first`: batch as much as possible to catch up
    // (one window per tiny chunk would only fall further behind).
    if (budget < first.length) return this.maxBatchSamples;
    return budget;
  }

  /**
   * Lookahead (samples) that lets `first` finish before it plays when the
   * full lookahead would not; null when full lookahead fits or when nothing
   * fits (then it is late anyway and batching to catch up is better).
   */
  private lookaheadThatFits(first: StreamChunk, t: number): number | null {
    if (this.firstResultAt === null || this.lookaheadSamples === 0) return null;
    const playsAt = this.firstResultAt + (first.start / this.sampleRate) * 1000;
    const msLeft = playsAt - this.deadlineMarginMs - t;
    const fixed = (Math.min(first.start, this.contextSamples) + first.length) / this.sampleRate;
    const seconds = msLeft / this.msPerAudioSecond - fixed;
    const samples = Math.floor(seconds * this.sampleRate);
    if (samples >= this.lookaheadSamples) return null;
    if (samples <= 0) return null;
    return samples;
  }

  private run(batch: StreamChunk[], lookaheadOverride?: number): void {
    const first = batch[0];
    const last = batch[batch.length - 1];
    const lookahead = first.index === 0 && !this.firstChunkLookahead
      ? 0
      : (lookaheadOverride ?? this.lookaheadSamples);
    const from = Math.max(0, first.start - this.contextSamples);
    const to = Math.min(this.totalSamples, last.start + last.length + lookahead);
    const input = this.slice(from, to);
    this.inFlight++;
    const started = now();
    this.pool.analyze(input, this.options).then(
      (result) => {
        const elapsed = now() - started;
        const seconds = input.length / this.sampleRate;
        if (seconds > 0.2) {
          this.msPerAudioSecond = 0.7 * this.msPerAudioSecond + 0.3 * (elapsed / seconds);
        }
        if (this.firstResultAt === null) this.firstResultAt = now();
        for (const c of batch) {
          c.resolve(cropResult(result, (c.start - from) / this.sampleRate, c.length / this.sampleRate, this.restShape()));
        }
        this.inFlight--;
        this.releaseAudio();
        this.schedule();
      },
      (error) => {
        for (const c of batch) c.reject(error);
        this.inFlight--;
        this.releaseAudio();
        this.schedule();
      }
    );
  }

  /** Shape for a chunk with no cues: idle X when enabled (default), else closed A */
  private restShape(): string {
    return (this.options.extendedShapes ?? 'GHX').toUpperCase().includes('X') ? 'X' : 'A';
  }

  /** Copy samples [from, to) of the stream */
  private slice(from: number, to: number): Int16Array {
    const out = new Int16Array(Math.max(0, to - from));
    let pos = this.audioBase;
    for (const a of this.audio) {
      const aStart = pos;
      const aEnd = pos + a.length;
      pos = aEnd;
      if (aEnd <= from || aStart >= to) continue;
      const s0 = Math.max(from, aStart);
      const s1 = Math.min(to, aEnd);
      out.set(a.subarray(s0 - aStart, s1 - aStart), s0 - from);
    }
    return out;
  }

  /** Sample offset of this.audio[0] */
  private audioBase = 0;

  /** Drop audio no longer needed as context for unanalysed chunks */
  private releaseAudio(): void {
    const next = this.chunks[this.nextToAnalyze];
    const keepFrom = next ? next.start - this.contextSamples : this.totalSamples - this.contextSamples;
    while (this.audio.length > 0 && this.audioBase + this.audio[0].length <= keepFrom) {
      this.audioBase += this.audio[0].length;
      this.audio.shift();
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Keep the part of a result between offset and offset + duration (seconds)
 * and shift times so 0 is the start of the chunk.
 */
function cropResult(
  result: LipSyncEngineResult,
  offset: number,
  duration: number,
  restShape: string
): LipSyncEngineResult {
  const eps = 1e-6;
  const mouthCues = [];
  for (const cue of result.mouthCues) {
    const start = Math.max(0, cue.start - offset);
    const end = Math.min(duration, cue.end - offset);
    if (end - start <= eps) continue;
    mouthCues.push({ start: round2(start), end: round2(end), value: cue.value });
  }
  if (mouthCues.length > 0) {
    mouthCues[0].start = 0;
    mouthCues[mouthCues.length - 1].end = round2(duration);
  } else if (duration > 0) {
    mouthCues.push({ start: 0, end: round2(duration), value: restShape });
  }
  return { ...result, mouthCues };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
