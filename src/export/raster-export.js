/**
 * Masar v3 — Raster Export Orchestrator  [v3.2 — Viewport-based pipeline]
 *
 * v3.2 changes:
 *   - New primary path: center + zoom + outputW + outputH
 *   - Tile range computed from viewport pixel rect (floor((right-1)/tileSize))
 *   - Crop computed from viewport pixel rect (no geographic bbox re-derivation)
 *   - bbox path kept as fallback for backwards compatibility
 *
 * This eliminates the dark strip on right/bottom caused by missing the last
 * tile column/row, and ensures the output exactly matches MapLibre's viewport.
 */

'use strict';

const crypto     = require('crypto');
const downloader = require('../tiles/tile-downloader');
const merger     = require('../tiles/tile-merger');
const themes     = require('../config/themes');

const DEBUG_EXPORT = false;

function dbg(msg) {
  if (DEBUG_EXPORT) console.log('[raster-export] ' + msg);
}

const VALID_FORMATS = { png: true, jpeg: true, webp: true };

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Error('[raster-export] Export cancelled');
}

/**
 * Orchestrates the full raster export workflow.
 *
 * Accepts either:
 *   A) options.center + options.zoom + options.width + options.height  ← preferred
 *   B) options.bbox + options.zoom + options.width + options.height    ← legacy fallback
 */
async function exportRaster(options) {
  var startTime = Date.now();
  checkAbort(options.signal);

  // ── Validate ────────────────────────────────────────────────────────────────

  if (!options.style || typeof options.style !== 'string')
    throw new Error('[raster-export] style is required');
  if (typeof options.zoom !== 'number')
    throw new Error('[raster-export] zoom is required');
  if (typeof options.width  !== 'number' || options.width  <= 0)
    throw new Error('[raster-export] width must be > 0');
  if (typeof options.height !== 'number' || options.height <= 0)
    throw new Error('[raster-export] height must be > 0');

  var format = (options.format || 'png').toLowerCase();
  if (!VALID_FORMATS[format])
    throw new Error('[raster-export] Unsupported format: "' + format + '"');

  // Determine pipeline mode
  var useViewport = Array.isArray(options.center) &&
                    typeof options.center[0] === 'number' &&
                    typeof options.center[1] === 'number';

  var useBbox = !useViewport &&
                Array.isArray(options.bbox) &&
                options.bbox.length === 4;

  if (!useViewport && !useBbox)
    throw new Error('[raster-export] Either options.center [lon,lat] or options.bbox [W,S,E,N] is required');

  // ── Theme ───────────────────────────────────────────────────────────────────

  var rasterTileURL = themes.getRasterTileURL(options.style);
  var tileSize      = themes.getRasterTileSize(options.style);
  var bgColor       = themes.getBackgroundColor(options.style);

  dbg('style="' + options.style + '" tileSize=' + tileSize + ' zoom=' + options.zoom);

  // ── Compute tile list ───────────────────────────────────────────────────────

  var tileList;
  var intZoom = Math.floor(options.zoom);

  if (useViewport) {
    // ── VIEWPORT PATH (preferred) ─────────────────────────────────────────────
    // Compute tile range directly from camera state.
    // floor((right-1)/tileSize) ensures the last tile column/row is included.

    var vtr = merger.viewportToTileRange(
      options.center[0], options.center[1],
      intZoom,
      options.width, options.height,
      tileSize
    );
    tileList = vtr.tileList;

    dbg('VIEWPORT path: center=[' + options.center[0].toFixed(4) + ',' + options.center[1].toFixed(4) +
        '] zoom=' + intZoom + ' tiles=' + tileList.length +
        ' xRange=[' + vtr.xMin + '..' + vtr.xMax + '] yRange=[' + vtr.yMin + '..' + vtr.yMax + ']');

  } else {
    // ── BBOX PATH (legacy fallback) ───────────────────────────────────────────
    tileList = downloader.tilesForBBox(options.bbox, options.zoom);
    dbg('BBOX path: zoom=' + intZoom + ' tiles=' + tileList.length);
  }

  if (tileList.length === 0)
    throw new Error('[raster-export] Viewport at zoom ' + intZoom + ' requires 0 tiles.');

  // ── Download tiles ──────────────────────────────────────────────────────────

  checkAbort(options.signal);

  var downloadResult = await downloader.downloadTiles({
    type:         'raster',
    ofmStyleId:   options.style,
    tiles:        tileList,
    signal:       options.signal,
    _directTileURL: rasterTileURL,
  });

  checkAbort(options.signal);

  var validTiles = downloadResult.tiles.filter(function(t) {
    return t.buffer && t.buffer.length > 0;
  });

  if (validTiles.length === 0)
    throw new Error('[raster-export] No valid raster tiles downloaded.');

  dbg('Downloaded: ' + validTiles.length + '/' + tileList.length + ' tiles valid');

  // ── Merge tiles ─────────────────────────────────────────────────────────────

  checkAbort(options.signal);

  // For viewport path: pass center/zoom so merger can compute crop from pixels.
  // For bbox path: pass bbox as before.
  var mergeOptions = {
    tiles:           validTiles,
    zoom:            intZoom,
    width:           options.width,
    height:          options.height,
    tileSize:        tileSize,
    outputFormat:    format,
    backgroundColor: options.backgroundColor || bgColor,
    provider:        'direct',
    style:           options.style,
    signal:          options.signal,
  };

  if (useViewport) {
    mergeOptions.center = options.center;   // [lon, lat]
    mergeOptions.bbox   = null;             // not used in viewport mode
  } else {
    mergeOptions.bbox   = options.bbox;
    mergeOptions.center = null;
  }

  var mergeResult = await mergeTilesWithViewport(mergeOptions);

  // ── Validate & return ───────────────────────────────────────────────────────

  checkAbort(options.signal);

  if (!mergeResult.buffer || !Buffer.isBuffer(mergeResult.buffer) || mergeResult.buffer.length === 0)
    throw new Error('[raster-export] Pipeline returned empty buffer.');

  var totalDurationMs = Date.now() - startTime;
  var exportId = crypto.randomUUID();

  dbg('Export complete: ' + mergeResult.width + 'x' + mergeResult.height +
      ' in ' + totalDurationMs + 'ms');

  return {
    buffer:  mergeResult.buffer,
    format:  format,
    width:   mergeResult.width,
    height:  mergeResult.height,
    bbox:    mergeResult.bounds,
    zoom:    intZoom,
    metadata: {
      exportId:      exportId,
      provider:      'direct-raster',
      style:         options.style,
      rasterTileURL: rasterTileURL,
      zoom:          intZoom,
      center:        options.center || null,
      bbox:          options.bbox   || null,
      exportWidth:   mergeResult.width,
      exportHeight:  mergeResult.height,
      tileCount:     validTiles.length,
      generatedAt:   new Date().toISOString(),
      pipeline:      useViewport ? 'viewport' : 'bbox',
    },
    stats: {
      download:        downloadResult.stats,
      merge:           mergeResult.stats,
      totalDurationMs: totalDurationMs,
    },
  };
}

/**
 * Extended mergeTiles wrapper that supports viewport-based cropping.
 * When center is provided, uses merger.viewportToPixelRect() for the crop.
 * Falls back to standard bbox-based crop when center is null.
 */
async function mergeTilesWithViewport(options) {
  if (options.center) {
    // Viewport mode: inject center into merger options
    // The merger will use viewportToPixelRect() instead of bboxToPixelRect()
    return await merger.mergeTiles(Object.assign({}, options, {
      // Pass a synthetic bbox so normaliseOptions doesn't throw
      // The actual crop will use center + zoom via viewportToPixelRect
      bbox:          [-180, -85, 180, 85],  // placeholder — not used for crop
      _viewportCenter: options.center,       // actual crop source
    }));
  }
  return await merger.mergeTiles(options);
}

module.exports = { exportRaster };
