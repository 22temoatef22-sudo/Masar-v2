/**
 * Masar v3 — Raster Export Orchestrator
 *
 * Coordinates the conversion of Map State into high-resolution raster exports.
 * Now uses direct raster tile URLs from themes.js instead of provider discovery.
 */

'use strict';

const crypto     = require('crypto');
const downloader = require('../tiles/tile-downloader');
const merger     = require('../tiles/tile-merger');
const themes     = require('../config/themes');

const DEBUG_EXPORT = false;

function dbg(msg) {
  if (DEBUG_EXPORT) {
    console.log('[raster-export] ' + msg);
  }
}

const VALID_FORMATS = { png: true, jpeg: true, webp: true };

function checkAbort(signal) {
  if (signal && signal.aborted) {
    throw new Error('[raster-export] Export cancelled');
  }
}

/**
 * Orchestrates the full raster export workflow.
 */
async function exportRaster(options) {
  var startTime = Date.now();
  checkAbort(options.signal);

  // ── Validate ────────────────────────────────────────────────────────────────

  if (!options.style || typeof options.style !== 'string') throw new Error('[raster-export] style is required');
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4) throw new Error('[raster-export] bbox must be [W, S, E, N]');
  if (typeof options.zoom !== 'number') throw new Error('[raster-export] zoom is required');
  if (typeof options.width !== 'number' || options.width <= 0) throw new Error('[raster-export] width must be > 0');
  if (typeof options.height !== 'number' || options.height <= 0) throw new Error('[raster-export] height must be > 0');

  var format = (options.format || 'png').toLowerCase();
  if (!VALID_FORMATS[format]) {
    throw new Error('[raster-export] Unsupported format: "' + format + '"');
  }

  // ── Resolve raster tile URL directly from theme ─────────────────────────────

  var rasterTileURL = themes.getRasterTileURL(options.style);
  var tileSize = themes.getRasterTileSize(options.style);
  dbg('Raster tile URL for "' + options.style + '": ' + rasterTileURL + ' (tileSize=' + tileSize + ')');

  // ── Compute required tiles ──────────────────────────────────────────────────

  checkAbort(options.signal);
  var tileList = downloader.tilesForBBox(options.bbox, options.zoom);
  dbg('Computed ' + tileList.length + ' required tiles');

  if (tileList.length === 0) {
    throw new Error('[raster-export] Bounding box at zoom ' + options.zoom + ' requires 0 tiles.');
  }

  // ── Download tiles using direct URL template ────────────────────────────────

  checkAbort(options.signal);
  var downloadStart = Date.now();

  // Use the direct raster tile URL template — bypass provider discovery
  var downloadResult = await downloader.downloadTiles({
    type: 'raster',
    ofmStyleId: options.style,           // used as cache key
    tiles: tileList,
    signal: options.signal,
    // Override: inject the direct URL template
    _directTileURL: rasterTileURL,
  });

  var downloadDuration = Date.now() - downloadStart;
  dbg('Download phase: ' + downloadDuration + 'ms');

  // ── Verify downloads ────────────────────────────────────────────────────────

  checkAbort(options.signal);
  var validTiles = [];
  for (var i = 0; i < downloadResult.tiles.length; i++) {
    var t = downloadResult.tiles[i];
    if (t.buffer && t.buffer.length > 0) {
      validTiles.push(t);
    }
  }

  if (validTiles.length === 0) {
    throw new Error('[raster-export] No valid raster tiles downloaded.');
  }

  // ── Merge tiles ─────────────────────────────────────────────────────────────

  checkAbort(options.signal);
  var mergeStart = Date.now();

  var mergeResult = await merger.mergeTiles({
    tiles: validTiles,
    bbox: options.bbox,
    zoom: options.zoom,
    width: options.width,
    height: options.height,
    tileSize: tileSize,
    outputFormat: format,
    backgroundColor: options.backgroundColor,
    provider: 'direct',
    style: options.style,
    signal: options.signal,
  });

  var mergeDuration = Date.now() - mergeStart;
  dbg('Merge phase: ' + mergeDuration + 'ms');

  // ── Validate & return ───────────────────────────────────────────────────────

  checkAbort(options.signal);

  if (!mergeResult.buffer || !Buffer.isBuffer(mergeResult.buffer) || mergeResult.buffer.length === 0) {
    throw new Error('[raster-export] Pipeline returned empty buffer.');
  }

  var totalDurationMs = Date.now() - startTime;
  var exportId = crypto.randomUUID();

  return {
    buffer: mergeResult.buffer,
    format: format,
    width: mergeResult.width,
    height: mergeResult.height,
    bbox: mergeResult.bounds,
    zoom: options.zoom,
    metadata: {
      exportId:      exportId,
      provider:      'direct-raster',
      style:         options.style,
      rasterTileURL: rasterTileURL,
      zoom:          options.zoom,
      bbox:          options.bbox,
      exportWidth:   mergeResult.width,
      exportHeight:  mergeResult.height,
      tileCount:     validTiles.length,
      generatedAt:   new Date().toISOString(),
    },
    stats: {
      download:        downloadResult.stats,
      merge:           mergeResult.stats,
      totalDurationMs: totalDurationMs,
    },
  };
}

module.exports = {
  exportRaster,
};
