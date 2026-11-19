import type { LipSyncEngineResult, LipSyncEngineOptions } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';
import packageJson from '../../package.json';

/**
 * Represents a worker in the pool
 */
interface PoolWorker {
  worker: Worker;
  busy: boolean;
  ready: boolean;
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

/**
 * Web Worker pool for non-blocking lip-sync-engine analysis
 * Manages multiple workers with automatic load balancing
 */
export class WorkerPool {
  private static instance: WorkerPool | null = null;

  private workers: PoolWorker[] = [];
  /** Workers that are starting but have not reported ready, with their failure handler */
  private pendingWorkers: Map<PoolWorker, (error: Error) => void> = new Map();
  /** Incremented by destroy() so workers started before it can never join the pool */
  private generation = 0;
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
  }): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Update paths if provided
    if (options) {
      if (options.wasmPath) this.wasmPaths.wasmPath = options.wasmPath;
      if (options.dataPath) this.wasmPaths.dataPath = options.dataPath;
      if (options.jsPath) this.wasmPaths.jsPath = options.jsPath;
      if (options.workerScriptUrl) this.workerScriptUrl = options.workerScriptUrl;
    }

    // Start with 1 worker for fast initialization
    // More workers will be created on-demand when needed
    await this.createWorker();

    this.initialized = true;
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

    const workersToCreate = this.maxWorkers - this.workers.length;

    if (workersToCreate <= 0) {
      return; // Already at max workers
    }

    // Create remaining workers in parallel. Wait for every worker to settle
    // so a failure never leaves other workers starting in the background.
    const promises: Promise<PoolWorker>[] = [];
    for (let i = 0; i < workersToCreate; i++) {
      promises.push(this.createWorker());
    }

    const results = await Promise.allSettled(promises);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) {
      throw failure.reason;
    }
  }

  /**
   * Resolve the URL used to start a worker.
   * Cross-origin (CDN) scripts are fetched and wrapped in a blob URL.
   */
  private async resolveWorkerUrl(): Promise<string> {
    const workerUrl = this.workerScriptUrl;
    if (workerUrl.startsWith('http://') || workerUrl.startsWith('https://')) {
      try {
        const response = await fetch(workerUrl);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      } catch (fetchError) {
        console.warn('Failed to fetch worker script, trying direct URL:', fetchError);
        // Fall back to direct URL (will fail with CORS but worth trying)
      }
    }
    return workerUrl;
  }

  /**
   * Create a new worker and initialize it.
   *
   * The returned promise always settles: it resolves when the worker reports
   * `ready`, and rejects (terminating the worker) on an init error, a load
   * error, or when the pool is destroyed before the worker is ready.
   */
  private async createWorker(): Promise<PoolWorker> {
    const generation = this.generation;
    const workerUrl = await this.resolveWorkerUrl();

    if (generation !== this.generation) {
      throw new Error('WorkerPool destroyed');
    }

    return new Promise<PoolWorker>((resolve, reject) => {
      const worker = new Worker(workerUrl);

      const poolWorker: PoolWorker = {
        worker,
        busy: false,
        ready: false
      };

      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pendingWorkers.delete(poolWorker);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        reject(error);
      };

      this.pendingWorkers.set(poolWorker, fail);

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (poolWorker.ready) {
          this.handleWorkerMessage(poolWorker, message);
          return;
        }

        if (message.type === 'ready') {
          if (generation !== this.generation) {
            fail(new Error('WorkerPool destroyed'));
            return;
          }
          settled = true;
          this.pendingWorkers.delete(poolWorker);
          poolWorker.ready = true;
          this.workers.push(poolWorker);
          resolve(poolWorker);
        } else if (message.type === 'error') {
          fail(new Error(message.error || 'Worker initialization failed'));
        }
      };

      worker.onerror = (event: ErrorEvent) => {
        if (!poolWorker.ready) {
          fail(new Error(`Worker failed to load: ${event.message || 'unknown error'}`));
          return;
        }
        console.error('Worker error:', event);
        this.removeWorker(poolWorker);
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

    // Invalidate workers that are still fetching their script or starting
    this.generation++;

    // Terminate workers that have not reported ready yet and reject their startup
    const pendingFailures = Array.from(this.pendingWorkers.values());
    this.pendingWorkers.clear();
    pendingFailures.forEach(fail => fail(new Error('WorkerPool destroyed')));

    // Terminate all ready workers
    this.workers.forEach(poolWorker => {
      poolWorker.worker.terminate();
    });
    this.workers = [];

    this.initialized = false;
    WorkerPool.instance = null;
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
      chunksCompleted: this.nextIndex,
      poolStats: this.pool.getStats()
    };
  }
}
