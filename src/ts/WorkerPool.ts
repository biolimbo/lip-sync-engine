import type { LipSyncEngineResult, LipSyncEngineOptions, RecognizerKind } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';
import packageJson from '../../package.json';

/**
 * Represents a worker in the pool
 */
interface PoolWorker {
  worker: Worker;
  busy: boolean;
  ready: boolean;
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
const compiledModules = new Map<string, Promise<WebAssembly.Module>>();

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
  private prewarm: PrewarmMode = true;
  private shareAssets = true;
  private recognizer: RecognizerKind = 'pocketsphinx';
  private sharedModule: Promise<WebAssembly.Module | undefined> | null = null;
  private workerUrlPromise: Promise<string> | null = null;
  private statsRequests: Map<number, (bytes: number) => void> = new Map();
  private warmupPromise: Promise<void> | null = null;
  private initPromise: Promise<void> | null = null;
  private blobUrl: string | null = null;

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
   * Strategy: Start with 1 worker for fast initialization
   * - Use warmup() to create all workers upfront if needed
   * - Workers scale on-demand automatically
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
     * Download and compile the .wasm once on the main thread and give the
     * compiled module to every worker, instead of each worker compiling it.
     * Default true. Also reused by pools created later. (The .data file is
     * not shared: copying it into each worker cost more memory than it saved
     * time; workers fetch it from the HTTP cache.)
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
    // Concurrent calls share one initialization
    if (!this.initPromise) {
      this.initPromise = this.doInit(options).finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  private async doInit(options?: Parameters<WorkerPool['init']>[0]): Promise<void> {
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

    if (this.shareAssets) this.startSharedAssets();

    // Start with 1 worker for fast initialization
    // More workers will be created on-demand when needed
    try {
      await this.createWorker(this.prewarm !== false);
    } finally {
      if (this.maxWorkers <= 1) this.releaseSharedAssets();
    }

    this.initialized = true;
  }

  /**
   * Compile the .wasm once for all workers. Failures fall back to each
   * worker loading it itself.
   */
  private startSharedAssets(): void {
    const { wasmPath } = this.wasmPaths;
    if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') return;
    let compiled = compiledModules.get(wasmPath);
    if (!compiled) {
      compiled = (typeof WebAssembly.compileStreaming === 'function'
        ? WebAssembly.compileStreaming(fetch(wasmPath))
        : fetch(wasmPath).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)));
      compiledModules.set(wasmPath, compiled);
      compiled.catch(() => compiledModules.delete(wasmPath));
    }
    this.sharedModule = compiled.catch(() => undefined);
  }

  private releaseSharedAssets(): void {
    this.sharedModule = null;
  }

  /** Worker script URL; cross-origin scripts are fetched once into a blob URL */
  private getWorkerUrl(): Promise<string> {
    if (!this.workerUrlPromise) {
      const url = this.workerScriptUrl;
      this.workerUrlPromise = (async () => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            this.blobUrl = URL.createObjectURL(blob);
            return this.blobUrl;
          } catch (fetchError) {
            console.warn('Failed to fetch worker script, trying direct URL:', fetchError);
            // Fall back to direct URL (will fail with CORS but worth trying)
          }
        }
        return url;
      })();
    }
    return this.workerUrlPromise;
  }

  /**
   * Pre-create all workers up to maxWorkers
   * Call this during app initialization to eliminate worker creation overhead
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
    // Concurrent calls share one warmup instead of each creating workers
    if (!this.warmupPromise) {
      this.warmupPromise = this.doWarmup().finally(() => { this.warmupPromise = null; });
    }
    return this.warmupPromise;
  }

  private async doWarmup(): Promise<void> {
    const workersToCreate = this.maxWorkers - this.workers.length;

    if (workersToCreate <= 0) {
      return; // Already at max workers
    }

    if (this.shareAssets && !this.sharedModule) this.startSharedAssets();

    // Create remaining workers in parallel
    const promises: Promise<PoolWorker>[] = [];
    for (let i = 0; i < workersToCreate; i++) {
      promises.push(this.createWorker(this.prewarm === true));
    }

    try {
      await Promise.all(promises);
    } finally {
      this.releaseSharedAssets();
    }
  }

  /**
   * Create a new worker and initialize it
   */
  private async createWorker(prewarm: boolean): Promise<PoolWorker> {
    const workerUrl = await this.getWorkerUrl();
    const wasmModule = await (this.sharedModule ?? Promise.resolve(undefined));

    return new Promise((resolve, reject) => {
      try {
        const worker = new Worker(workerUrl);

        const poolWorker: PoolWorker = {
          worker,
          busy: false,
          ready: false,
          warm: false
        };

        // Set up message handler
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          this.handleWorkerMessage(poolWorker, event.data);
        };

        worker.onerror = (error) => {
          console.error('Worker error:', error);
          this.removeWorker(poolWorker);
        };

        // Wait for worker to be ready
        const initHandler = (event: MessageEvent<WorkerResponse>) => {
          if (event.data.type === 'ready') {
            poolWorker.ready = true;
            poolWorker.warm = !!(event.data as { warm?: boolean }).warm;
            this.workers.push(poolWorker);
            worker.removeEventListener('message', initHandler);
            resolve(poolWorker);
            // Jobs may have been queued while this worker was starting
            this.processQueue();
          } else if (event.data.type === 'error') {
            worker.removeEventListener('message', initHandler);
            worker.terminate();
            reject(new Error(event.data.error || 'Worker initialization failed'));
          }
        };

        worker.addEventListener('message', initHandler);

        // Send init message (the compiled module is shared, not copied)
        const initMessage: WorkerRequest = {
          type: 'init',
          ...this.wasmPaths,
          prewarm,
          recognizer: this.recognizer,
          wasmModule
        };
        worker.postMessage(initMessage);

      } catch (error) {
        reject(error);
      }
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
        this.processQueue();
      }
      // Init errors are handled in createWorker()
    }
  }

  /**
   * Remove a worker from the pool
   */
  private removeWorker(poolWorker: PoolWorker): void {
    const index = this.workers.indexOf(poolWorker);
    if (index !== -1) {
      this.workers.splice(index, 1);
      poolWorker.worker.terminate();
    }
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
   * (about 38 MB per worker) on top.
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
   * Destroy the worker pool and terminate all workers
   */
  destroy(): void {
    // Reject all pending jobs in queue
    this.queue.forEach(job => {
      job.reject(new Error('WorkerPool destroyed'));
    });
    this.queue = [];

    // Reject all in-flight jobs
    this.inFlightJobs.forEach(job => {
      job.reject(new Error('WorkerPool destroyed'));
    });
    this.inFlightJobs.clear();
    this.statsRequests.forEach(resolve => resolve(0));
    this.statsRequests.clear();

    // Terminate all workers
    this.workers.forEach(poolWorker => {
      poolWorker.worker.terminate();
    });
    this.workers = [];

    this.releaseSharedAssets();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.workerUrlPromise = null;

    this.initialized = false;
    WorkerPool.instance = null;
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
          c.resolve(cropResult(result, (c.start - from) / this.sampleRate, c.length / this.sampleRate));
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
function cropResult(result: LipSyncEngineResult, offset: number, duration: number): LipSyncEngineResult {
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
    mouthCues.push({ start: 0, end: round2(duration), value: 'A' });
  }
  return { ...result, mouthCues };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
