/**
 * Masar v3 — Raster Export Orchestrator
 *
 * Coordinates the conversion of Map State into high-resolution raster exports.
 * Bridges providers, the downloader, and the Sharp-based merger.
 *
 * Does NOT contain tile math, cache logic, or projection math.
 */

'use strict';

const crypto     = require('crypto');
const downloader = require('../tiles/tile-downloader');
const merger     = require('../tiles/tile-merger');
const themes     = require('../config/themes');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_EXPORT = false;

function dbg(msg) {
  if (DEBUG_EXPORT) {
    console.log('[raster-export] ' + msg);
  }
}

// ── Constants & Configuration ──────────────────────────────────────────────────

const VALID_FORMATS = { png: true, jpeg: true, webp: true };

// Provider Registry (Architecture prepared for future providers)
const PROVIDERS = {
  openfreemap: require('../providers/openfreemap'),
  // maptiler: require('../providers/maptiler'),
  // osm: require('../providers/osm'),
};

const _providerValidationCache = {};

// ── Helpers ────────────────────────────────────────────────────────────────────

function checkAbort(signal) {
  if (signal && signal.aborted) {
    throw new Error('[raster-export] Export cancelled');
  }
}

// ── Primary API ────────────────────────────────────────────────────────────────

/**
 * Orchestrates the full raster export workflow.
 *
 * @param {Object} options
 * @param {string} options.provider
 * @param {string} options.style
 * @param {number[]} options.bbox - [west, south, east, north]
 * @param {number} options.zoom
 * @param {number} options.width
 * @param {number} options.height
 * @param {string} options.format - png, jpeg, webp
 * @param {Object} [options.backgroundColor]
 * @param {AbortSignal} [options.signal]
 */
async function exportRaster(options) {
  var startTime = Date.now();
  checkAbort(options.signal);

  // ── Step 1: Validate Input ──────────────────────────────────────────────────

  if (!options.provider || typeof options.provider !== 'string') throw new Error('[raster-export] provider is required');
  if (!options.style || typeof options.style !== 'string') throw new Error('[raster-export] style is required');
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4) throw new Error('[raster-export] bbox must be [W, S, E, N]');
  if (typeof options.zoom !== 'number') throw new Error('[raster-export] zoom is required');
  if (typeof options.width !== 'number' || options.width <= 0) throw new Error('[raster-export] width must be > 0');
  if (typeof options.height !== 'number' || options.height <= 0) throw new Error('[raster-export] height must be > 0');

  var format = (options.format || 'png').toLowerCase();
  if (!VALID_FORMATS[format]) {
    throw new Error('[raster-export] Unsupported format: "' + format + '". Must be png, jpeg, or webp.');
  }

  dbg(`Init: provider=${options.provider}, style=${options.style}, zoom=${options.zoom}`);
  dbg(`Target: ${options.width}x${options.height} format=${format}`);

  // ── Step 2: Resolve Provider & Style ────────────────────────────────────────

  if (!PROVIDERS[options.provider]) {
    throw new Error('[raster-export] Unknown provider: ' + options.provider);
  }

  let nativeStyleId;
  try {
    nativeStyleId = themes.resolveProviderStyle(options.provider, options.style);
  } catch (err) {
    // Fallback: If not a known Masar theme, assume it's a direct provider style ID
    nativeStyleId = options.style;
  }

  // Provider Validation Cache
  if (!_providerValidationCache[options.provider]) {
    checkAbort(options.signal);
    var validation = await PROVIDERS[options.provider].validateProvider();
    if (!validation.success) {
      throw new Error('[raster-export] Provider validation failed: ' + (validation.errors ? validation.errors.join(', ') : 'Unknown error'));
    }
    _providerValidationCache[options.provider] = true;
    dbg(`Provider ${options.provider} validated successfully`);
  }

  // ── Step 3: Compute Required Tiles ──────────────────────────────────────────

  checkAbort(options.signal);
  // TODO: Architecture Note - tilesForBBox() should eventually move into a dedicated tile-grid module.
  var tileList = downloader.tilesForBBox(options.bbox, options.zoom);
  dbg(`Computed ${tileList.length} required tiles for bbox`);

  if (tileList.length === 0) {
    throw new Error('[raster-export] Bounding box at zoom ' + options.zoom + ' requires 0 tiles. Export impossible.');
  }

  // ── Step 4: Download Tiles ──────────────────────────────────────────────────

  checkAbort(options.signal);
  var downloadStart = Date.now();
  
  var downloadResult = await downloader.downloadTiles({
  type: 'raster',
  ofmStyleId: nativeStyleId,
  tiles: tileList,
  signal: options.signal
});
  
  var downloadDuration = Date.now() - downloadStart;
  dbg(`Download phase complete in ${downloadDuration}ms`);

  // [EXTENSION POINT]: Future Hillshade / Terrain Tile Overlay Merging
  // e.g., mixinTerrain(downloadResult.tiles)

  // ── Step 5: Verify Download Results ─────────────────────────────────────────

  checkAbort(options.signal);
  var validTiles = [];
  for (var i = 0; i < downloadResult.tiles.length; i++) {
    var t = downloadResult.tiles[i];
    if (t.buffer && t.buffer.length > 0) {
      validTiles.push(t);
    }
  }

  if (validTiles.length === 0) {
    throw new Error('[raster-export] Export failed: No valid raster tiles could be downloaded.');
  }

  // ── Step 6: Merge Tiles ─────────────────────────────────────────────────────

  checkAbort(options.signal);
  var mergeStart = Date.now();

  var mergeOptions = {
    tiles: validTiles,
    bbox: options.bbox,
    zoom: options.zoom,
    width: options.width,
    height: options.height,
    outputFormat: format,
    backgroundColor: options.backgroundColor,
    provider: options.provider,
    style: options.style,
    signal: options.signal,
    // showMissingTiles: true // Could be exposed as an option later
  };

  var mergeResult = await merger.mergeTiles(mergeOptions);
  var mergeDuration = Date.now() - mergeStart;
  dbg(`Merge phase complete in ${mergeDuration}ms`);

  // [EXTENSION POINT]: Future Canvas Overlays / Vector Label Composition
  // e.g., applyLabelLayer(mergeResult.buffer, bounds)
  // [EXTENSION POINT]: Provider Watermarks
  // e.g., applyWatermark(mergeResult.buffer, PROVIDERS[options.provider].getProviderInfo().attribution)

  // ── Step 7 & 8: Final Validation & Return Compilation ───────────────────────

  checkAbort(options.signal);

  if (!mergeResult.buffer || !Buffer.isBuffer(mergeResult.buffer) || mergeResult.buffer.length === 0) {
    throw new Error('[raster-export] Export verification failed: Pipeline returned an empty buffer.');
  }
  if (mergeResult.width !== options.width || mergeResult.height !== options.height) {
    throw new Error('[raster-export] Export verification failed: Dimension mismatch.');
  }

  var totalDurationMs = Date.now() - startTime;
  var exportId = crypto.randomUUID();
  dbg(`Export finished successfully. ID: ${exportId} Total Duration: ${totalDurationMs}ms`);

  return {
    buffer: mergeResult.buffer,
    format: format,
    width: mergeResult.width,
    height: mergeResult.height,
    bbox: mergeResult.bounds, // Normalized bounds from merger
    zoom: options.zoom,
    metadata: {
      exportId:     exportId,
      provider:     options.provider,
      style:        options.style,
      nativeStyleId: nativeStyleId,
      zoom:         options.zoom,
      bbox:         options.bbox,
      exportWidth:  mergeResult.width,
      exportHeight: mergeResult.height,
      tileCount:    validTiles.length,
      generatedAt:  new Date().toISOString(),
    },
    stats: {
      download:        downloadResult.stats,
      merge:           mergeResult.stats,
      totalDurationMs: totalDurationMs
    }
  };
}

module.exports = {
  exportRaster
};
