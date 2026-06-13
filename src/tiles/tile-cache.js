/**
 * Masar v3 — Tile Cache
 *
 * LRU cache for raster (PNG), vector (PBF), tilejson, and style buffers.
 * Capacity: 500 items (configurable). All operations O(1).
 * Entries expire after DEFAULT_TTL_MS. Memory eviction enforces maxMemoryMB.
 *
 * Key schema:
 *   {type}:{provider}:{style}:{z}/{x}/{y}
 *   e.g. "raster:openfreemap:liberty:4/9/6"
 *        "vector:openfreemap:liberty:4/9/6"
 *
 * Public API:
 *   cache.set(type, provider, style, z, x, y, buffer) → entry
 *   cache.get(type, provider, style, z, x, y)         → Buffer | null
 *   cache.has(type, provider, style, z, x, y)         → boolean
 *   cache.delete(type, provider, style, z, x, y)      → boolean
 *   cache.clear(type?)                                 → { removed, freedBytes }
 *   cache.getStats()                                   → full stats + TTL + tile size metrics
 *   cache.getHealth()                                  → lightweight health snapshot
 *   cache.resetMetrics()                               → void
 *   cache.buildKey(type, provider, style, z, x, y)    → string
 */

'use strict';

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_CACHE = false;

function dbg(msg) {
  if (DEBUG_CACHE) {
    console.log('[tile-cache] ' + msg);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_CAPACITY      = 500;
const DEFAULT_TTL_MS        = 60 * 60 * 1000;  // 1 hour
const DEFAULT_MAX_MEMORY_MB = 512;

const VALID_TYPES = { raster: true, vector: true, tilejson: true, style: true };

// ── LRU Node ──────────────────────────────────────────────────────────────────
//
// Each node is both a cache entry and a linked-list node.
// Stored directly in the Map to avoid separate data structures.
//
// Shape: { key, type, buffer, byteSize, hits, storedAt, lastAccessedAt, expiresAt, prev, next }

function createNode(key, type, buffer, ttlMs) {
  var now = Date.now();
  return {
    key:            key,
    type:           type,           // 'raster' | 'vector' | 'tilejson' | 'style'
    buffer:         buffer,         // Buffer
    byteSize:       buffer.length,
    hits:           0,
    storedAt:       now,
    lastAccessedAt: now,
    expiresAt:      now + ttlMs,
    prev:           null,           // more-recently-used
    next:           null,           // less-recently-used
  };
}

// ── LRU List ──────────────────────────────────────────────────────────────────
//
// head.next → most recently used
// tail.prev → least recently used (eviction candidate)
//
// Sentinel nodes simplify boundary conditions — no null checks on prev/next.

function createList() {
  var head = { key: '__head__', prev: null, next: null };
  var tail = { key: '__tail__', prev: null, next: null };
  head.next = tail;
  tail.prev = head;
  return { head: head, tail: tail };
}

function listRemove(node) {
  node.prev.next = node.next;
  node.next.prev = node.prev;
  node.prev = null;
  node.next = null;
}

function listInsertAfterHead(list, node) {
  node.next       = list.head.next;
  node.prev       = list.head;
  list.head.next.prev = node;
  list.head.next      = node;
}

function listLRUNode(list) {
  // The node just before tail is the least-recently-used.
  var candidate = list.tail.prev;
  if (candidate === list.head) return null; // list is empty
  return candidate;
}

// ── Validation ─────────────────────────────────────────────────────────────────

function assertType(type) {
  if (!VALID_TYPES[type]) {
    throw new Error('[tile-cache] Invalid tile type: "' + type + '". Must be one of: ' + Object.keys(VALID_TYPES).join(', ') + '.');
  }
}

function assertBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('[tile-cache] buffer must be a Node.js Buffer, got: ' + typeof buffer);
  }
  if (buffer.length === 0) {
    throw new Error('[tile-cache] buffer must not be empty');
  }
}

function assertCoords(z, x, y) {
  if (typeof z !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
    throw new Error('[tile-cache] z, x, y must be numbers');
  }
}

// ── TileCache Class ────────────────────────────────────────────────────────────

function TileCache(options) {
  options = options || {};

  this._capacity       = (typeof options.capacity === 'number' && options.capacity > 0)
                         ? options.capacity
                         : DEFAULT_CAPACITY;

  this._ttlMs          = (typeof options.ttlMs === 'number' && options.ttlMs > 0)
                         ? options.ttlMs
                         : DEFAULT_TTL_MS;

  this._maxMemoryMB    = (typeof options.maxMemoryMB === 'number' && options.maxMemoryMB > 0)
                         ? options.maxMemoryMB
                         : DEFAULT_MAX_MEMORY_MB;

  this._maxMemoryBytes = this._maxMemoryMB * 1024 * 1024;

  // Storage
  this._map        = new Map();   // key → node
  this._list       = createList();

  // Memory tracking (bytes)
  this._totalBytes = 0;

  // Lifetime metrics — never reset by cache operations
  this._metrics = {
    hits:      0,
    misses:    0,
    writes:    0,
    evictions: 0,
    deletes:   0,
    expirations: 0,
  };
}

// ── Key Builder ────────────────────────────────────────────────────────────────

/**
 * Build the canonical cache key for a tile.
 *
 * @param {string} type     — 'raster' | 'vector'
 * @param {string} provider — e.g. 'openfreemap'
 * @param {string} style    — e.g. 'liberty'
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
TileCache.prototype.buildKey = function(type, provider, style, z, x, y) {
  return type + ':' + provider + ':' + style + ':' + z + '/' + x + '/' + y;
};

// ── Private Node Removal ───────────────────────────────────────────────────────

/**
 * Remove a node from both the Map and the linked list, and update memory.
 * Single authoritative teardown path used by set (overwrite), set (eviction),
 * get (TTL expiry), has (TTL expiry), and delete.
 *
 * @param {Object} node — live node from this._map
 */
TileCache.prototype._removeNode = function(node) {
  this._totalBytes -= node.byteSize;
  listRemove(node);
  this._map.delete(node.key);
};

// ── Core Operations ────────────────────────────────────────────────────────────

/**
 * Store a tile buffer. Evicts LRU entries until both count and memory
 * limits are satisfied.
 *
 * @param {string} type
 * @param {string} provider
 * @param {string} style
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {Buffer} buffer
 * @returns {{ key: string, byteSize: number, evicted: string|null }}
 */
TileCache.prototype.set = function(type, provider, style, z, x, y, buffer) {
  assertType(type);
  assertBuffer(buffer);
  assertCoords(z, x, y);

  var key     = this.buildKey(type, provider, style, z, x, y);
  var evicted = null;

  // If key already exists, remove the old node cleanly before re-inserting.
  if (this._map.has(key)) {
    this._removeNode(this._map.get(key));
    dbg('overwrite ' + key);
  }

  // Evict LRU entries until both count and memory limits are satisfied.
  // Memory check uses lookahead: (currentBytes + incomingBytes) to account
  // for the new entry being about to join the total.
  while (this._map.size >= this._capacity || this._totalBytes + buffer.length > this._maxMemoryBytes) {
    var lru = listLRUNode(this._list);
    if (!lru) break;
    evicted = evicted || lru.key;
    dbg('evict ' + lru.key + ' (' + lru.byteSize + 'B)');
    this._removeNode(lru);
    this._metrics.evictions++;
  }

  // Insert new node at head (most recently used).
  var node = createNode(key, type, buffer, this._ttlMs);
  this._map.set(key, node);
  listInsertAfterHead(this._list, node);
  this._totalBytes += node.byteSize;
  this._metrics.writes++;

  dbg('set ' + key + ' ' + node.byteSize + 'B | size=' + this._map.size + ' mem=' + this._totalBytes + 'B');

  return {
    key:      key,
    byteSize: node.byteSize,
    evicted:  evicted,
  };
};

/**
 * Retrieve a tile buffer. Promotes the entry to MRU position on hit.
 * Returns null on miss or if the entry has expired — never throws.
 *
 * @param {string} type
 * @param {string} provider
 * @param {string} style
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Buffer|null}
 */
TileCache.prototype.get = function(type, provider, style, z, x, y) {
  assertType(type);
  assertCoords(z, x, y);

  var key  = this.buildKey(type, provider, style, z, x, y);
  var node = this._map.get(key);

  if (!node) {
    this._metrics.misses++;
    dbg('miss ' + key);
    return null;
  }

  // TTL check — expired entries are removed and treated as misses.
  if (Date.now() > node.expiresAt) {
    this._removeNode(node);
    this._metrics.expirations++;
    this._metrics.misses++;
    dbg('expired ' + key);
    return null;
  }

  // Promote to MRU.
  listRemove(node);
  listInsertAfterHead(this._list, node);
  node.hits++;
  node.lastAccessedAt = Date.now();

  this._metrics.hits++;
  dbg('hit ' + key + ' (hits=' + node.hits + ')');

  return node.buffer;
};

/**
 * Check whether a key is present and not expired, without promoting or
 * counting metrics. An expired entry returns false (and is removed).
 *
 * @param {string} type
 * @param {string} provider
 * @param {string} style
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
TileCache.prototype.has = function(type, provider, style, z, x, y) {
  assertType(type);
  assertCoords(z, x, y);
  var key  = this.buildKey(type, provider, style, z, x, y);
  var node = this._map.get(key);
  if (!node) return false;
  if (Date.now() > node.expiresAt) {
    this._removeNode(node);
    this._metrics.expirations++;
    dbg('expired (has) ' + key);
    return false;
  }
  return true;
};

/**
 * Remove a specific tile from the cache.
 *
 * @param {string} type
 * @param {string} provider
 * @param {string} style
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {boolean} true if the entry existed and was removed
 */
TileCache.prototype.delete = function(type, provider, style, z, x, y) {
  assertType(type);
  assertCoords(z, x, y);

  var key  = this.buildKey(type, provider, style, z, x, y);
  var node = this._map.get(key);

  if (!node) return false;

  this._removeNode(node);
  this._metrics.deletes++;
  dbg('delete ' + key);

  return true;
};

/**
 * Clear all entries, or only entries of a specific type.
 *
 * @param {string} [type] — 'raster' | 'vector' | undefined (all)
 * @returns {{ removed: number, freedBytes: number }}
 */
TileCache.prototype.clear = function(type) {
  if (type !== undefined) assertType(type);

  var removed    = 0;
  var freedBytes = 0;

  if (type === undefined) {
    // Fast path — wipe everything.
    removed    = this._map.size;
    freedBytes = this._totalBytes;

    this._map.clear();
    this._list       = createList();
    this._totalBytes = 0;

    dbg('clear all | removed=' + removed + ' freed=' + freedBytes + 'B');
  } else {
    // Walk the map and remove only matching type.
    // Collect keys first — safe iteration, no mid-loop mutation.
    var toDelete = [];
    this._map.forEach(function(node, key) {
      if (node.type === type) {
        toDelete.push(key);
      }
    });

    for (var i = 0; i < toDelete.length; i++) {
      var node = this._map.get(toDelete[i]);
      if (node) {
        this._totalBytes -= node.byteSize;
        listRemove(node);
        this._map.delete(toDelete[i]);
        removed++;
        freedBytes += node.byteSize;
      }
    }

    dbg('clear ' + type + ' | removed=' + removed + ' freed=' + freedBytes + 'B');
  }

  return { removed: removed, freedBytes: freedBytes };
};

// ── Statistics & Metrics ───────────────────────────────────────────────────────

/**
 * Return a complete snapshot of cache state and lifetime metrics.
 *
 * @returns {Object}
 */
TileCache.prototype.getStats = function() {
  var totalRequests = this._metrics.hits + this._metrics.misses;
  var hitRate       = totalRequests > 0
                      ? Math.round((this._metrics.hits / totalRequests) * 10000) / 100
                      : 0;

  // Single-pass scan over live entries — accumulate all per-type and size metrics.
  var typeMap = {};
  var keys    = Object.keys(VALID_TYPES);
  for (var t = 0; t < keys.length; t++) {
    typeMap[keys[t]] = { count: 0, bytes: 0 };
  }

  var largestTileBytes  = 0;
  var smallestTileBytes = Infinity;
  var totalEntries      = 0;

  this._map.forEach(function(node) {
    var bucket = typeMap[node.type];
    if (bucket) {
      bucket.count++;
      bucket.bytes += node.byteSize;
    }
    if (node.byteSize > largestTileBytes)  largestTileBytes  = node.byteSize;
    if (node.byteSize < smallestTileBytes) smallestTileBytes = node.byteSize;
    totalEntries++;
  });

  var averageTileBytes = totalEntries > 0
                         ? Math.round(this._totalBytes / totalEntries)
                         : 0;

  if (smallestTileBytes === Infinity) smallestTileBytes = 0;

  return {
    // Capacity
    capacity:       this._capacity,
    size:           this._map.size,
    available:      this._capacity - this._map.size,
    utilizationPct: Math.round((this._map.size / this._capacity) * 10000) / 100,

    // Memory
    memory: {
      totalBytes:   this._totalBytes,
      totalMB:      Math.round((this._totalBytes / (1024 * 1024)) * 1000) / 1000,
      maxBytes:     this._maxMemoryBytes,
      maxMB:        this._maxMemoryMB,
      rasterBytes:  typeMap.raster.bytes,
      rasterMB:     Math.round((typeMap.raster.bytes / (1024 * 1024)) * 1000) / 1000,
      vectorBytes:  typeMap.vector.bytes,
      vectorMB:     Math.round((typeMap.vector.bytes / (1024 * 1024)) * 1000) / 1000,
    },

    // Entry breakdown by type
    entries: {
      total:    this._map.size,
      raster:   typeMap.raster.count,
      vector:   typeMap.vector.count,
      tilejson: typeMap.tilejson.count,
      style:    typeMap.style.count,
    },

    // Tile size metrics across all live entries
    tileSizes: {
      largestBytes:  largestTileBytes,
      smallestBytes: smallestTileBytes,
      averageBytes:  averageTileBytes,
    },

    // TTL configuration
    ttl: {
      ttlMs:         this._ttlMs,
      ttlMinutes:    Math.round((this._ttlMs / 60000) * 10) / 10,
      expirations:   this._metrics.expirations,
    },

    // Lifetime metrics
    metrics: {
      hits:          this._metrics.hits,
      misses:        this._metrics.misses,
      writes:        this._metrics.writes,
      evictions:     this._metrics.evictions,
      deletes:       this._metrics.deletes,
      expirations:   this._metrics.expirations,
      totalRequests: totalRequests,
      hitRatePct:    hitRate,
    },

    // LRU introspection
    lru: {
      mostRecent:  this._mruKey(),
      leastRecent: this._lruKey(),
    },
  };
};

/**
 * Reset hit/miss/eviction/expiration counters without clearing cached data.
 * Useful after a warm-up phase before starting a timed export.
 */
TileCache.prototype.resetMetrics = function() {
  this._metrics = {
    hits:        0,
    misses:      0,
    writes:      0,
    evictions:   0,
    deletes:     0,
    expirations: 0,
  };
  dbg('metrics reset');
};

// ── Private Introspection Helpers ─────────────────────────────────────────────

TileCache.prototype._mruKey = function() {
  var node = this._list.head.next;
  return (node && node !== this._list.tail) ? node.key : null;
};

TileCache.prototype._lruKey = function() {
  var node = this._list.tail.prev;
  return (node && node !== this._list.head) ? node.key : null;
};

// ── Health Snapshot ────────────────────────────────────────────────────────────

/**
 * Return a lightweight health snapshot for the diagnostics panel.
 * Does not iterate the Map — all values derived from counters.
 * For full statistics use getStats().
 *
 * status:
 *   'healthy'  — utilisation < 80% and memory < 80%
 *   'degraded' — either utilisation or memory >= 80%
 *
 * @returns {Object}
 */
TileCache.prototype.getHealth = function() {
  var totalRequests   = this._metrics.hits + this._metrics.misses;
  var hitRatePct      = totalRequests > 0
                        ? Math.round((this._metrics.hits / totalRequests) * 10000) / 100
                        : 0;
  var capacityUsedPct = Math.round((this._map.size / this._capacity) * 10000) / 100;
  var memoryUsedPct   = this._maxMemoryBytes > 0
                        ? Math.round((this._totalBytes / this._maxMemoryBytes) * 10000) / 100
                        : 0;
  var status          = (capacityUsedPct < 80 && memoryUsedPct < 80) ? 'healthy' : 'degraded';

  return {
    status:          status,
    capacityUsedPct: capacityUsedPct,
    memoryUsedPct:   memoryUsedPct,
    hitRatePct:      hitRatePct,
    entries:         this._map.size,
    memoryMB:        Math.round((this._totalBytes / (1024 * 1024)) * 1000) / 1000,
  };
};

// ── Singleton Instance ─────────────────────────────────────────────────────────
//
// The tile engine imports this singleton so the entire server shares one
// cache — both for memory efficiency and accurate global metrics.
// Tests that need isolation can import TileCache and construct their own.

const defaultCache = new TileCache({ capacity: DEFAULT_CAPACITY });

module.exports = {
  // Singleton for production use
  cache: defaultCache,

  // Class for testing and custom instances
  TileCache: TileCache,

  // Convenience: expose buildKey statically (no instance needed)
  buildKey: function(type, provider, style, z, x, y) {
    return defaultCache.buildKey(type, provider, style, z, x, y);
  },
};
