/**
 * Masar v3 — Tile Downloader
 *
 * Downloads raster (PNG) and vector (PBF) tiles for a given bbox + zoom,
 * with concurrency control, per-attempt AbortController timeouts, exponential
 * backoff retry, and transparent cache integration.
 *
 * Depends on:
 *   providers/openfreemap.js  — resolves tile URL templates
 *   tiles/tile-cache.js       — singleton LRU cache (read-through + write-through)
 *
 * Primary API:
 *   downloader.downloadTiles(request)   → { tiles, stats }
 *   downloader.tilesForBBox(bbox, zoom)  → [{ z, x, y }, ...]
 *   downloader.getStats()               → lifetime counters
 *   downloader.getHealth()              → lightweight health snapshot
 *   downloader.resetStats()             → void
 *
 * Request shape:
 *   {
 *     type:        'raster' | 'vector'
 *     ofmStyleId:  string             — native OFM style (liberty | bright | positron)
 *     tiles:       [{ z, x, y }]      — explicit tile list, OR
 *     bbox:        [W, S, E, N]       — auto-calculate tiles (requires zoom)
 *     zoom:        number             — zoom level for bbox tile calculation
 *     concurrency: number             — parallel fetches (default 8, max 32)
 *     timeoutMs:   number             — per-attempt timeout ms (default 10000)
 *     retries:     number             — max retry attempts per tile (default 3)
 *     signal:      AbortSignal        — optional; cancels queued (not in-flight) tiles
 *   }
 *
 * Result tile shape:
 *   {
 *     z, x, y,
 *     buffer:    Buffer | null  — null on permanent failure
 *     fromCache: boolean
 *     attempts:  number
 *     durationMs: number
 *     error:     string | null  — set if buffer is null
 *   }
 */

'use strict';

const provider  = require('../providers/openfreemap');
const tileCache = require('./tile-cache');

// ── Runtime-agnostic globals ───────────────────────────────────────────────────

const fetchFn          = global.fetch           || require('node-fetch');
const AbortControllerFn = global.AbortController || require('abort-controller');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_DOWNLOADER = false;

function dbg(msg) {
  if (DEBUG_DOWNLOADER) {
    console.log('[tile-downloader] ' + msg);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PROVIDER_ID          = 'openfreemap';
const DEFAULT_CONCURRENCY  = 8;
const MAX_CONCURRENCY      = 32;   // hard cap — protects OFM, Railway, and dev environments
const DEFAULT_TIMEOUT_MS   = 10000;   // 10 s per attempt
const DEFAULT_RETRIES      = 3;       // up to 3 retry attempts (4 total tries)
const BACKOFF_BASE_MS      = 500;     // initial backoff delay
const BACKOFF_MAX_MS       = 8000;    // cap on backoff delay
const BACKOFF_JITTER_MS    = 250;     // max random jitter added per attempt
const MAX_TILES_PER_BATCH  = 256;     // hard safety cap on batch size

// HTTP status codes that are retryable (transient server/rate-limit errors).
// All other 4xx are permanent failures — do not retry.
const RETRYABLE_STATUS = { 429: true, 500: true, 502: true, 503: true, 504: true };

// ── Lifetime Statistics ────────────────────────────────────────────────────────

const _stats = {
  totalRequested:  0,   // tiles requested across all batches
  totalFetched:    0,   // successful network fetches
  totalCacheHits:  0,   // served from cache
  totalFailures:   0,   // permanent failures (null buffer returned)
  totalRetries:    0,   // individual retry attempts
  totalBytes:      0,   // bytes fetched from network
  totalDurationMs: 0,   // cumulative wall-clock time across all batches
  batches:         0,   // number of downloadTiles() calls
};

// ── Provider Validation State ──────────────────────────────────────────────────
//
// Validated once per process. Subsequent calls reuse the same promise so
// concurrent first-time downloads share a single validation round-trip.
// resetValidation() is exported for tests only — not part of the public API.

const _providerValidation = {
  promise: null,    // Promise<void> — set on first validation attempt
  done:    false,   // true once the promise resolved without error
};

/**
 * Ensure the provider has been validated before any tile work starts.
 * Calls provider.validateProvider() exactly once per process lifetime.
 * Subsequent calls await the same stored promise — no second network call.
 *
 * @returns {Promise<void>}
 * @throws if provider validation fails
 */
async function ensureProviderValidated() {
  if (_providerValidation.done) {
    dbg('provider already validated');
    return;
  }

  if (!_providerValidation.promise) {
    dbg('starting provider validation');
    _providerValidation.promise = provider.validateProvider().then(function(result) {
      if (!result.success) {
        var msg = '[tile-downloader] Provider validation failed: ' + result.errors.join('; ');
        dbg(msg);
        throw new Error(msg);
      }
      _providerValidation.done = true;
      dbg('provider validation passed');
    });
  }

  await _providerValidation.promise;
}

/**
 * Convert longitude to tile X coordinate at a given zoom.
 * @param {number} lon
 * @param {number} zoom
 * @returns {number}
 */
function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

/**
 * Convert latitude to tile Y coordinate at a given zoom (Web Mercator).
 * @param {number} lat
 * @param {number} zoom
 * @returns {number}
 */
function latToTileY(lat, zoom) {
  var latRad = lat * Math.PI / 180;
  var n      = Math.pow(2, zoom);
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

/**
 * Calculate all tile coordinates that cover a bbox at a given integer zoom.
 * Returns at most MAX_TILES_PER_BATCH tiles (truncated with a warning if exceeded).
 *
 * @param {number[]} bbox  — [west, south, east, north] in degrees
 * @param {number}   zoom
 * @returns {{ z: number, x: number, y: number }[]}
 */
function tilesForBBox(bbox, zoom) {
  var west  = bbox[0];
  var south = bbox[1];
  var east  = bbox[2];
  var north = bbox[3];
  var z     = Math.floor(zoom);
  var n     = Math.pow(2, z);

  var xMin = Math.max(0, lonToTileX(west,  z));
  var xMax = Math.min(n - 1, lonToTileX(east,  z));
  var yMin = Math.max(0, latToTileY(north, z));   // north → smaller y
  var yMax = Math.min(n - 1, latToTileY(south, z)); // south → larger y

  var tiles = [];
  for (var x = xMin; x <= xMax; x++) {
    for (var y = yMin; y <= yMax; y++) {
      tiles.push({ z: z, x: x, y: y });
      if (tiles.length >= MAX_TILES_PER_BATCH) {
        console.warn('[tile-downloader] bbox tile count exceeded ' + MAX_TILES_PER_BATCH + ' — truncated');
        return tiles;
      }
    }
  }

  return tiles;
}

// ── URL Template Resolution ────────────────────────────────────────────────────

/**
 * Resolve the tile URL template for a type + style from the provider.
 * Called once per batch — the provider caches results internally.
 *
 * @param {string} type        — 'raster' | 'vector'
 * @param {string} ofmStyleId
 * @returns {Promise<string>} URL template with {z}, {x}, {y} placeholders
 */
async function resolveTileURLTemplate(type, ofmStyleId) {
  var template;
  if (type === 'raster') {
    template = await provider.getRasterTileURL(ofmStyleId);
    if (!template) {
      throw new Error(
        '[tile-downloader] No raster tile URL for style "' + ofmStyleId +
        '". Style may be vector-only.'
      );
    }
  } else if (type === 'vector') {
    template = await provider.getVectorTileURL(ofmStyleId);
  } else {
    throw new Error('[tile-downloader] Unknown tile type: "' + type + '"');
  }

  if (typeof template !== 'string') {
    throw new Error(
      '[tile-downloader] URL template for style "' + ofmStyleId + '" is not a string: ' + typeof template
    );
  }

  var missing = [];
  if (template.indexOf('{z}') === -1) missing.push('{z}');
  if (template.indexOf('{x}') === -1) missing.push('{x}');
  if (template.indexOf('{y}') === -1) missing.push('{y}');

  if (missing.length > 0) {
    throw new Error(
      '[tile-downloader] URL template "' + template +
      '" is missing placeholders: ' + missing.join(', ') +
      ' (style: "' + ofmStyleId + '")'
    );
  }

  return template;
}

/**
 * Substitute {z}, {x}, {y} in a URL template.
 * @param {string} template
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
function buildTileURL(template, z, x, y) {
  return template
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);
}

// ── Retry + Fetch ──────────────────────────────────────────────────────────────

/**
 * Compute backoff delay for attempt N (zero-indexed), with jitter.
 * Caps at BACKOFF_MAX_MS.
 *
 * @param {number} attempt — 0-indexed attempt number (first retry = 1)
 * @returns {number} delay in ms
 */
function backoffDelay(attempt) {
  var base   = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
  var jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
  return base + jitter;
}

/**
 * Sleep for `ms` milliseconds. Returns a promise that resolves after the delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/**
 * Fetch a single tile URL with a per-attempt AbortController timeout.
 * Does NOT retry — retry logic lives in fetchTileWithRetry.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>} raw response body as a Buffer
 * @throws on network error, timeout, or non-2xx status
 */
async function fetchOnce(url, timeoutMs) {
  var controller = new AbortControllerFn();
  var timer      = setTimeout(function() {
    controller.abort();
  }, timeoutMs);

  try {
    var res = await fetchFn(url, { signal: controller.signal });

    if (!res.ok) {
      var err = new Error('[tile-downloader] HTTP ' + res.status + ' ' + res.statusText + ' — ' + url);
      err.status = res.status;
      throw err;
    }

    var arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
    // Do not call controller.abort() here — the fetch already resolved/rejected.
    // The timer abort path is the only one that needs it, and it fires automatically.
  }
}

/**
 * Fetch a single tile with exponential-backoff retry.
 * Returns { buffer, attempts } on success.
 * Returns { buffer: null, attempts, error } on permanent failure.
 *
 * Non-retryable errors (404, 400, 401, 403) fail immediately.
 * AbortError (timeout) is retryable.
 *
 * @param {string} url
 * @param {number} maxRetries  — number of *additional* attempts after the first
 * @param {number} timeoutMs
 * @returns {Promise<{ buffer: Buffer|null, attempts: number, error: string|null }>}
 */
async function fetchTileWithRetry(url, maxRetries, timeoutMs) {
  var lastError = null;
  var attempts  = 0;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;

    if (attempt > 0) {
      var delay = backoffDelay(attempt - 1);
      dbg('retry ' + attempt + '/' + maxRetries + ' in ' + delay + 'ms — ' + url);
      _stats.totalRetries++;
      await sleep(delay);
    }

    try {
      var buffer = await fetchOnce(url, timeoutMs);
      return { buffer: buffer, attempts: attempts, error: null };
    } catch (err) {
      lastError = err;

      // Permanent failure — do not retry
      if (err.status !== undefined && !RETRYABLE_STATUS[err.status]) {
        dbg('permanent failure ' + err.status + ' — ' + url);
        break;
      }

      // Check for abort (timeout) — retryable
      var isAbort = err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('abort'));
      if (attempt === maxRetries && !isAbort) {
        dbg('max retries reached — ' + url);
      }

      dbg('attempt ' + attempts + ' failed: ' + err.message);
    }
  }

  return {
    buffer:   null,
    attempts: attempts,
    error:    lastError ? lastError.message : 'unknown error',
  };
}

// ── Concurrency Semaphore ──────────────────────────────────────────────────────

/**
 * Run `tasks` (array of async functions) with at most `concurrency` running
 * simultaneously. Preserves order of results matching order of tasks.
 *
 * If `signal` is provided and becomes aborted, queued tasks that have not
 * yet started are skipped — their slots in `results` are left as undefined.
 * Already-running tasks complete normally.
 *
 * @param {Function[]} tasks       — each task returns a Promise
 * @param {number}     concurrency
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<any[]>} results in input order
 */
async function runWithConcurrency(tasks, concurrency, signal) {
  var results = new Array(tasks.length);
  var index   = 0;

  async function worker() {
    while (index < tasks.length) {
      // Check cancellation before claiming the next slot.
      if (signal && signal.aborted) {
        dbg('batch cancelled — skipping remaining ' + (tasks.length - index) + ' queued tiles');
        break;
      }
      var current = index++;
      results[current] = await tasks[current]();
    }
  }

  var slots = Math.min(concurrency, tasks.length);
  var workers = [];
  for (var i = 0; i < slots; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ── Core Download Pipeline ─────────────────────────────────────────────────────

/**
 * Download a batch of tiles, serving from cache where available.
 *
 * @param {Object} request
 * @param {string}      request.type        — 'raster' | 'vector'
 * @param {string}      request.ofmStyleId  — native OFM style ID
 * @param {Array}       [request.tiles]     — explicit [{z,x,y}] list
 * @param {number[]}    [request.bbox]      — [W,S,E,N] — used to auto-derive tiles if tiles not given
 * @param {number}      [request.zoom]      — required when using bbox
 * @param {number}      [request.concurrency=8]  — capped at MAX_CONCURRENCY (32)
 * @param {number}      [request.timeoutMs=10000]
 * @param {number}      [request.retries=3]
 * @param {AbortSignal} [request.signal]    — cancel queued tiles without aborting in-flight ones
 *
 * @returns {Promise<{
 *   tiles: Array<{ z,x,y, buffer:Buffer|null, fromCache:boolean, attempts:number, durationMs:number, error:string|null }>,
 *   stats: { requested, cacheHits, fetched, failures, retries, bytes, durationMs, cacheHitPct }
 * }>}
 */
async function downloadTiles(request) {
  var type        = request.type;
  var ofmStyleId  = request.ofmStyleId;
  var signal      = (request.signal && typeof request.signal.aborted === 'boolean')
                    ? request.signal : null;
  var concurrency = (typeof request.concurrency === 'number' && request.concurrency > 0)
                    ? Math.min(request.concurrency, MAX_CONCURRENCY)
                    : DEFAULT_CONCURRENCY;
  var timeoutMs   = (typeof request.timeoutMs === 'number' && request.timeoutMs > 0)
                    ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
  var retries     = (typeof request.retries === 'number' && request.retries >= 0)
                    ? request.retries : DEFAULT_RETRIES;

  // ── Input validation ──────────────────────────────────────────────────────

  if (type !== 'raster' && type !== 'vector') {
    throw new Error('[tile-downloader] type must be "raster" or "vector", got: "' + type + '"');
  }
  if (typeof ofmStyleId !== 'string' || !ofmStyleId) {
    throw new Error('[tile-downloader] ofmStyleId is required');
  }

  // ── Resolve tile list ─────────────────────────────────────────────────────
  //
  // tiles[] takes priority over bbox+zoom. An empty tiles[] is valid —
  // it returns immediately before any network or provider calls.

  var tileList;
  if (Array.isArray(request.tiles)) {
    tileList = request.tiles;
  } else if (Array.isArray(request.bbox) && request.bbox.length === 4 && typeof request.zoom === 'number') {
    tileList = tilesForBBox(request.bbox, request.zoom);
  } else {
    throw new Error('[tile-downloader] Provide either tiles:[{z,x,y}] or bbox:[W,S,E,N] + zoom');
  }

  if (tileList.length === 0) {
    return {
      tiles: [],
      stats: { requested: 0, cacheHits: 0, fetched: 0, failures: 0, retries: 0, bytes: 0, durationMs: 0, cacheHitPct: 0 },
    };
  }

  // ── Provider validation gate ──────────────────────────────────────────────
  // Runs once per process. Subsequent calls return instantly.
  // Positioned after the empty-list guard so zero-tile batches never validate.

  if (!request._directTileURL) { await ensureProviderValidated(); }

  // ── Resolve tile URL template (one async call, provider caches internally) ─

  var urlTemplate;
  if (request._directTileURL) {
    urlTemplate = request._directTileURL;
    dbg("using direct tile URL: " + urlTemplate);
  } else {
    await ensureProviderValidated();
    urlTemplate = await resolveTileURLTemplate(type, ofmStyleId);
  }
  dbg('template resolved: ' + urlTemplate + ' | tiles: ' + tileList.length + ' | concurrency: ' + concurrency);

  // ── Session statistics ────────────────────────────────────────────────────

  var session = {
    cacheHits:  0,
    fetched:    0,
    failures:   0,
    retries:    0,
    bytes:      0,
  };

  var batchStart = Date.now();

  // ── Build task queue ──────────────────────────────────────────────────────

  var tasks = tileList.map(function(coord) {
    return async function() {
      // If the batch signal has already fired, return a cancelled result
      // immediately without touching the cache or network.
      if (signal && signal.aborted) {
        return {
          z: coord.z, x: coord.x, y: coord.y,
          buffer:     null,
          fromCache:  false,
          attempts:   0,
          durationMs: 0,
          error:      'cancelled',
        };
      }

      var z = coord.z;
      var x = coord.x;
      var y = coord.y;
      var tileStart = Date.now();

      // Cache read
      var cached = tileCache.cache.get(type, PROVIDER_ID, ofmStyleId, z, x, y);
      if (cached !== null) {
        session.cacheHits++;
        _stats.totalCacheHits++;
        dbg('cache hit ' + type + ':' + z + '/' + x + '/' + y);
        return {
          z: z, x: x, y: y,
          buffer:     cached,
          fromCache:  true,
          attempts:   0,
          durationMs: Date.now() - tileStart,
          error:      null,
        };
      }

      // Network fetch with retry
      var url    = buildTileURL(urlTemplate, z, x, y);
      var result = await fetchTileWithRetry(url, retries, timeoutMs);
      var durationMs = Date.now() - tileStart;

      if (result.buffer !== null) {
        // Cache write
        tileCache.cache.set(type, PROVIDER_ID, ofmStyleId, z, x, y, result.buffer);
        session.fetched++;
        session.bytes  += result.buffer.length;
        session.retries += (result.attempts - 1);
        _stats.totalFetched++;
        _stats.totalBytes += result.buffer.length;
        _stats.totalRetries += (result.attempts - 1);
        dbg('fetched ' + type + ':' + z + '/' + x + '/' + y + ' ' + result.buffer.length + 'B in ' + durationMs + 'ms (' + result.attempts + ' attempt(s))');
      } else {
        session.failures++;
        session.retries += (result.attempts - 1);
        _stats.totalFailures++;
        _stats.totalRetries += (result.attempts - 1);
        dbg('FAILED ' + type + ':' + z + '/' + x + '/' + y + ' — ' + result.error);
      }

      return {
        z: z, x: x, y: y,
        buffer:     result.buffer,
        fromCache:  false,
        attempts:   result.attempts,
        durationMs: durationMs,
        error:      result.error,
      };
    };
  });

  // ── Run with concurrency control ──────────────────────────────────────────

  var tileResults = await runWithConcurrency(tasks, concurrency, signal);

  // Slots that were never filled (signal aborted before the worker reached them)
  // are undefined. Replace with a canonical cancelled result so callers always
  // receive an array of defined objects matching the input tile list length.
  for (var i = 0; i < tileResults.length; i++) {
    if (tileResults[i] === undefined) {
      tileResults[i] = {
        z: tileList[i].z, x: tileList[i].x, y: tileList[i].y,
        buffer:     null,
        fromCache:  false,
        attempts:   0,
        durationMs: 0,
        error:      'cancelled',
      };
    }
  }
  var batchDurationMs = Date.now() - batchStart;

  // ── Update lifetime stats ─────────────────────────────────────────────────

  _stats.totalRequested  += tileList.length;
  _stats.totalDurationMs += batchDurationMs;
  _stats.batches++;

  var cacheHitPct = tileList.length > 0
    ? Math.round((session.cacheHits / tileList.length) * 10000) / 100
    : 0;

  var sessionStats = {
    requested:    tileList.length,
    cacheHits:    session.cacheHits,
    fetched:      session.fetched,
    failures:     session.failures,
    retries:      session.retries,
    bytes:        session.bytes,
    durationMs:   batchDurationMs,
    cacheHitPct:  cacheHitPct,
  };

  dbg(
    'batch complete | ' + tileList.length + ' tiles | ' +
    session.cacheHits + ' from cache | ' +
    session.fetched + ' fetched | ' +
    session.failures + ' failed | ' +
    batchDurationMs + 'ms'
  );

  return { tiles: tileResults, stats: sessionStats };
}

// ── Lifetime Statistics ────────────────────────────────────────────────────────

/**
 * Return lifetime counters across all downloadTiles() calls since process start
 * or last resetStats().
 *
 * @returns {Object}
 */
function getStats() {
  var totalResolved  = _stats.totalFetched + _stats.totalCacheHits;
  var cacheHitPct    = totalResolved > 0
    ? Math.round((_stats.totalCacheHits / totalResolved) * 10000) / 100
    : 0;
  var avgBatchMs     = _stats.batches > 0
    ? Math.round(_stats.totalDurationMs / _stats.batches)
    : 0;
  var avgTileBytesKB = _stats.totalFetched > 0
    ? Math.round((_stats.totalBytes / _stats.totalFetched) / 1024 * 10) / 10
    : 0;

  return {
    batches:          _stats.batches,
    totalRequested:   _stats.totalRequested,
    totalFetched:     _stats.totalFetched,
    totalCacheHits:   _stats.totalCacheHits,
    totalFailures:    _stats.totalFailures,
    totalRetries:     _stats.totalRetries,
    totalBytes:       _stats.totalBytes,
    totalMB:          Math.round(_stats.totalBytes / (1024 * 1024) * 1000) / 1000,
    totalDurationMs:  _stats.totalDurationMs,
    cacheHitPct:      cacheHitPct,
    avgBatchMs:       avgBatchMs,
    avgTileBytesKB:   avgTileBytesKB,
  };
}

/**
 * Reset lifetime counters. Does not clear the tile cache.
 */
function resetStats() {
  _stats.totalRequested  = 0;
  _stats.totalFetched    = 0;
  _stats.totalCacheHits  = 0;
  _stats.totalFailures   = 0;
  _stats.totalRetries    = 0;
  _stats.totalBytes      = 0;
  _stats.totalDurationMs = 0;
  _stats.batches         = 0;
  dbg('stats reset');
}

/**
 * Return a lightweight health snapshot for the diagnostics panel.
 * Reads only module-level counters — no iteration, no provider calls.
 * For full statistics use getStats().
 *
 * status:
 *   'healthy'  — no permanent failures, or failure rate < 5%
 *   'degraded' — failure rate >= 5% of total resolved tiles
 *   'idle'     — no tiles have been requested yet
 *
 * @returns {Object}
 */
function getHealth() {
  var totalResolved = _stats.totalFetched + _stats.totalCacheHits;
  var failureRatePct = totalResolved > 0
    ? Math.round((_stats.totalFailures / (totalResolved + _stats.totalFailures)) * 10000) / 100
    : 0;
  var cacheHitPct = totalResolved > 0
    ? Math.round((_stats.totalCacheHits / totalResolved) * 10000) / 100
    : 0;
  var avgBatchMs = _stats.batches > 0
    ? Math.round(_stats.totalDurationMs / _stats.batches)
    : 0;

  var status;
  if (_stats.batches === 0) {
    status = 'idle';
  } else if (failureRatePct >= 5) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return {
    status:          status,
    batches:         _stats.batches,
    totalFetched:    _stats.totalFetched,
    totalFailures:   _stats.totalFailures,
    cacheHitPct:     cacheHitPct,
    avgBatchMs:      avgBatchMs,
  };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  downloadTiles,
  tilesForBBox,
  getStats,
  getHealth,
  resetStats,
  // Expose internals for testing
  _buildTileURL:           buildTileURL,
  _backoffDelay:           backoffDelay,
  _runWithConcurrency:     runWithConcurrency,
  _ensureProviderValidated: ensureProviderValidated,
  // Reset provider validation state between tests (not for production use)
  _resetValidation: function() {
    _providerValidation.promise = null;
    _providerValidation.done    = false;
  },
};
