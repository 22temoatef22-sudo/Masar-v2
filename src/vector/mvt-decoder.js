/**
 * Masar v3 — Mapbox Vector Tile (MVT) Decoder
 *
 * Decodes binary .pbf vector tiles into GeoJSON FeatureCollections.
 * Strictly limited to parsing. No projection, clipping, or AE logic.
 */

'use strict';

const Pbf = require('pbf');
const { VectorTile } = require('@mapbox/vector-tile');
const downloader = require('../tiles/tile-downloader');
const themes = require('../config/themes');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_MVT = false;

function dbg(msg) {
  if (DEBUG_MVT) {
    console.log('[mvt-decoder] ' + msg);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_TILES = 64;
const DEFAULT_CONCURRENCY = 8;
const MAX_FEATURES = 50000;

// ── Layer Classification ───────────────────────────────────────────────────────

const LAYER_ALIASES = {
  water: ['water', 'water_polygon', 'ocean', 'lake', 'water_area'],
  waterway: ['waterway', 'river', 'stream', 'canal', 'drain'],
  boundary: ['boundary', 'admin', 'administrative', 'border']
};

/**
 * Normalizes provider-specific layer names into Masar core layer classifications.
 * Protects the engine from underlying provider schema changes.
 *
 * @param {string} layerName
 * @returns {string} 'water' | 'waterway' | 'boundary' | 'unknown'
 */
function classifyLayer(layerName) {
  if (!layerName) return 'unknown';
  const name = layerName.toLowerCase();

  for (const [classification, aliases] of Object.entries(LAYER_ALIASES)) {
    if (aliases.includes(name)) return classification;
  }

  // [EXTENSION POINT]: Future layers (roads, buildings, labels, landuse)
  return 'unknown';
}

// ── Validation Helpers ─────────────────────────────────────────────────────────

function validateCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return false;
  for (let i = 0; i < coords.length; i++) {
    if (Array.isArray(coords[i])) {
      if (!validateCoordinates(coords[i])) return false;
    } else if (typeof coords[i] !== 'number' || !Number.isFinite(coords[i])) {
      return false; // Rejects NaN and Infinity
    }
  }
  return true;
}

function isValidGeometry(geom) {
  if (!geom || !geom.type || !geom.coordinates) return false;
  return validateCoordinates(geom.coordinates);
}

// ── Concurrency & Worker Pool ──────────────────────────────────────────────────

/**
 * Processes an array of async tasks using a limited concurrency pool.
 * Note: This uses cooperative async workers on the Node.js event loop.
 * It is NOT thread-based concurrency, but rather Promise-interleaving
 * to prevent blocking the main thread during heavy operations.
 */
async function processInPool(tasks, concurrency, signal) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      if (signal && signal.aborted) {
        throw new Error('[mvt-decoder] Cancelled');
      }
      const currentIndex = index++;
      const res = await tasks[currentIndex]();
      results.push(res);
    }
  }

  const workers = [];
  const poolSize = Math.min(concurrency, tasks.length);
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ── Primary API ────────────────────────────────────────────────────────────────

/**
 * Downloads and decodes MVT tiles into a GeoJSON FeatureCollection.
 *
 * @param {Object} options
 * @param {string} options.provider
 * @param {string} options.style
 * @param {number[]} options.bbox - [west, south, east, north]
 * @param {number} options.zoom
 * @param {number} [options.concurrency=8]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>} { type: "FeatureCollection", features: [], metadata, stats }
 */
async function decodeMVT(options) {
  const startTime = Date.now();

  if (!options.provider || !options.style || !options.bbox || typeof options.zoom !== 'number') {
    throw new Error('[mvt-decoder] Missing required options (provider, style, bbox, zoom).');
  }

  // 1. Tile Discovery
  // TODO (Future): move tilesForBBox() into dedicated geo/tile-grid.js
  const tileList = downloader.tilesForBBox(options.bbox, options.zoom);
  dbg(`Computed ${tileList.length} required tiles for bbox`);

  if (tileList.length > MAX_TILES) {
    throw new Error(`[mvt-decoder] Requested ${tileList.length} tiles, exceeding the safety limit of ${MAX_TILES}.`);
  }
  if (tileList.length === 0) {
    throw new Error('[mvt-decoder] Bounding box requested 0 tiles.');
  }

  // 2. Fetch Tiles (Uses tile-cache natively within downloader)
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  let nativeStyleId;
  try {
    nativeStyleId = themes.resolveProviderStyle(options.provider, options.style);
  } catch (err) {
    nativeStyleId = options.style;
  }

  const downloadResult = await downloader.downloadTiles({
    type: 'vector',
    ofmStyleId: nativeStyleId,
    tiles: tileList,
    concurrency: concurrency,
    signal: options.signal
  });

  // 3. Decoding Statistics Setup
  const stats = {
    tileCount: tileList.length,
    decodedTiles: 0,
    featureCount: 0,
    waterFeatures: 0,
    boundaryFeatures: 0,
    waterwayFeatures: 0,
    cacheHits: downloadResult.stats.cacheHits,
    cacheMisses: downloadResult.stats.fetched,
    durationMs: 0
  };

  const allFeatures = [];

  // 4. Build Decoding Tasks
  const decodingTasks = downloadResult.tiles.map((t) => async () => {
    if (!t.buffer || t.buffer.length === 0) return null;

    // Yield to the Node.js event loop before heavy CPU parsing
    await new Promise(resolve => setImmediate(resolve));

    if (options.signal && options.signal.aborted) {
      throw new Error('[mvt-decoder] Cancelled');
    }

    try {
      const pbf = new Pbf(t.buffer);
      const vTile = new VectorTile(pbf);
      let tileFeatureCount = 0;

      for (let layerName in vTile.layers) {
        const layerClass = classifyLayer(layerName);
        if (layerClass === 'unknown') continue;

        const layer = vTile.layers[layerName];

        for (let j = 0; j < layer.length; j++) {
          let feature;
          let geojson;

          try {
            feature = layer.feature(j);
            geojson = feature.toGeoJSON(t.x, t.y, t.z);
          } catch (err) {
            continue; // Skip corrupted individual features
          }

          if (!isValidGeometry(geojson.geometry)) continue;

          // Hydrate required metadata
          geojson.properties = geojson.properties || {};
          geojson.properties.layer = layerClass; // Standardized output layer
          geojson.properties._sourceLayer = layerName;
          geojson.properties._tileX = t.x;
          geojson.properties._tileY = t.y;
          geojson.properties._zoom = t.z;
          geojson.properties._provider = options.provider;
          geojson.properties._style = nativeStyleId;

          allFeatures.push(geojson);
          tileFeatureCount++;

          // Safety Memory Limit
          if (allFeatures.length > MAX_FEATURES) {
            throw new Error('[mvt-decoder] Feature limit exceeded');
          }

          // Update stats
          if (layerClass === 'water') stats.waterFeatures++;
          else if (layerClass === 'waterway') stats.waterwayFeatures++;
          else if (layerClass === 'boundary') stats.boundaryFeatures++;
        }
      }

      if (tileFeatureCount > 0) {
        stats.decodedTiles++;
        stats.featureCount += tileFeatureCount;
      }
    } catch (err) {
      dbg(`Failed to decode tile ${t.z}/${t.x}/${t.y}: ${err.message}`);
    }
  });

  // 5. Execute CPU-Bound Pool
  await processInPool(decodingTasks, concurrency, options.signal);

  stats.durationMs = Date.now() - startTime;
  dbg(`Decoded ${stats.decodedTiles} tiles -> ${stats.featureCount} features in ${stats.durationMs}ms`);
  dbg(`Hits: ${stats.cacheHits}, Misses: ${stats.cacheMisses}`);

  return {
    type: 'FeatureCollection',
    features: allFeatures,
    metadata: {
      provider: options.provider,
      style: options.style,
      zoom: options.zoom,
      bbox: options.bbox,
      generatedAt: new Date().toISOString()
    },
    stats: stats
  };
}

module.exports = {
  decodeMVT,
  _classifyLayer: classifyLayer,
  _isValidGeometry: isValidGeometry
};
