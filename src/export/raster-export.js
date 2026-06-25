/**
 * Masar v3 — Raster Export Orchestrator  [v3.3 — Camera Snapshot Pipeline]
 *
 * v3.3 — New primary API: Camera Snapshot
 *
 * Accepts:
 *   {
 *     camera:            { center, zoom, bearing, pitch }
 *     referenceViewport: { width, height }   ← panel DOM dimensions
 *     renderTarget:      { width, height }   ← output (e.g. 1920x1080)
 *     tileSize:          512
 *   }
 *
 * Algorithm:
 *   1. Project center → world pixels (at referenceViewport size)
 *   2. Compute pixel edges: left/top/right/bottom in world space
 *   3. Compute tile range: floor((right-1)/tileSize) — no missing tiles
 *   4. Download all tiles
 *   5. Stitch mosaic
 *   6. Crop using pixel offsets (NOT geographic bbox — avoids precision loss)
 *   7. Resize crop → renderTarget dimensions
 *
 * Result: same geographic content as the panel, at higher pixel density.
 * NOT upscaling — same bbox, more tiles/pixels = genuine higher quality.
 */

'use strict';

const crypto     = require('crypto');
const downloader = require('../tiles/tile-downloader');
const merger     = require('../tiles/tile-merger');
const themes     = require('../config/themes');

const DEBUG_EXPORT = false;
function dbg(msg) { if (DEBUG_EXPORT) console.log('[raster-export] ' + msg); }

const VALID_FORMATS = { png: true, jpeg: true, webp: true };
function checkAbort(s) { if (s && s.aborted) throw new Error('[raster-export] Cancelled'); }

// ── Web Mercator helpers ──────────────────────────────────────────────────────

function projectCenter(lon, lat, zoom, tileSize) {
  var worldSize = tileSize * Math.pow(2, zoom);
  var cx = ((lon + 180) / 360) * worldSize;
  var latRad = lat * Math.PI / 180;
  var cy = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2 * worldSize;
  return { cx, cy, worldSize };
}

/**
 * Compute the pixel viewport from a camera + reference viewport.
 * Returns world-space pixel edges (left, top, right, bottom).
 */
function cameraToViewportPixels(camera, refViewport, tileSize) {
  var zoom      = Math.floor(camera.zoom);
  var { cx, cy } = projectCenter(camera.center[0], camera.center[1], zoom, tileSize);

  return {
    zoom:   zoom,
    left:   cx - refViewport.width  / 2,
    top:    cy - refViewport.height / 2,
    right:  cx + refViewport.width  / 2,
    bottom: cy + refViewport.height / 2,
  };
}

/**
 * Compute tile range from viewport pixel edges.
 * Uses floor((right-1)/tileSize) to guarantee last tile is included.
 */
function viewportToTileRange(vp, tileSize, zoom) {
  var n    = Math.pow(2, zoom);
  var xMin = Math.max(0,     Math.floor(vp.left              / tileSize));
  var yMin = Math.max(0,     Math.floor(vp.top               / tileSize));
  var xMax = Math.min(n - 1, Math.floor((vp.right  - 1)      / tileSize));
  var yMax = Math.min(n - 1, Math.floor((vp.bottom - 1)      / tileSize));

  var tileList = [];
  for (var tx = xMin; tx <= xMax; tx++) {
    for (var ty = yMin; ty <= yMax; ty++) {
      tileList.push({ z: zoom, x: tx, y: ty });
    }
  }
  return { xMin, yMin, xMax, yMax, tileList };
}

/**
 * Compute crop rect within the stitched mosaic.
 * Uses pixel offsets — NOT geographic bbox re-derivation.
 */
function viewportToCropRect(vp, tileRange, tileSize) {
  var originX = tileRange.xMin * tileSize;
  var originY = tileRange.yMin * tileSize;
  return {
    left:   Math.round(vp.left   - originX),
    top:    Math.round(vp.top    - originY),
    width:  Math.round(vp.right  - vp.left),
    height: Math.round(vp.bottom - vp.top),
  };
}

// ── Main export function ──────────────────────────────────────────────────────

async function exportRaster(options) {
  var startTime = Date.now();
  checkAbort(options.signal);

  if (!options.style) throw new Error('[raster-export] style is required');

  var format = (options.format || 'png').toLowerCase();
  if (!VALID_FORMATS[format]) throw new Error('[raster-export] Unsupported format: ' + format);

  var rasterTileURL = themes.getRasterTileURL(options.style);
  var tileSize      = options.tileSize || themes.getRasterTileSize(options.style);
  var bgColor       = themes.getBackgroundColor(options.style);

  // ── Determine pipeline mode ─────────────────────────────────────────────────

  var useCamera = options.camera &&
                  Array.isArray(options.camera.center) &&
                  typeof options.camera.zoom === 'number' &&
                  options.referenceViewport &&
                  options.renderTarget;

  var tileList, cropRect, outW, outH;

  if (useCamera) {
    // ── CAMERA SNAPSHOT PIPELINE (v3.3) ──────────────────────────────────────
    //
    // Step 1: Compute viewport pixel rect from camera + reference viewport
    var vp = cameraToViewportPixels(options.camera, options.referenceViewport, tileSize);

    outW = options.renderTarget.width;
    outH = options.renderTarget.height;

    dbg('CAMERA mode: center=[' + options.camera.center + '] zoom=' + vp.zoom +
        ' ref=' + options.referenceViewport.width + 'x' + options.referenceViewport.height +
        ' output=' + outW + 'x' + outH);
    dbg('Viewport pixels: L=' + vp.left.toFixed(1) + ' T=' + vp.top.toFixed(1) +
        ' R=' + vp.right.toFixed(1) + ' B=' + vp.bottom.toFixed(1));

    // Step 2: Tile range (floor((right-1)/tileSize) — no missing tiles)
    var tr = viewportToTileRange(vp, tileSize, vp.zoom);
    tileList = tr.tileList;

    dbg('Tiles: x[' + tr.xMin + '..' + tr.xMax + '] y[' + tr.yMin + '..' + tr.yMax + '] = ' + tileList.length);

    // Step 3: Crop rect in mosaic-local pixels
    cropRect = viewportToCropRect(vp, tr, tileSize);

    dbg('Crop: left=' + cropRect.left + ' top=' + cropRect.top +
        ' ' + cropRect.width + 'x' + cropRect.height + ' → resize to ' + outW + 'x' + outH);

  } else if (Array.isArray(options.center) && typeof options.zoom === 'number') {
    // ── CENTER+ZOOM LEGACY ────────────────────────────────────────────────────
    outW = options.width;
    outH = options.height;
    var legacyVtr = merger.viewportToTileRange(
      options.center[0], options.center[1],
      Math.floor(options.zoom), outW, outH, tileSize
    );
    tileList = legacyVtr.tileList;
    cropRect  = null; // merger handles crop internally
    dbg('CENTER legacy mode: ' + tileList.length + ' tiles');

  } else if (Array.isArray(options.bbox)) {
    // ── BBOX LEGACY ───────────────────────────────────────────────────────────
    outW = options.width;
    outH = options.height;
    tileList = downloader.tilesForBBox(options.bbox, options.zoom);
    cropRect  = null;
    dbg('BBOX legacy mode: ' + tileList.length + ' tiles');

  } else {
    throw new Error('[raster-export] Requires camera snapshot, center+zoom, or bbox');
  }

  if (!tileList || tileList.length === 0)
    throw new Error('[raster-export] No tiles required for this viewport');

  // ── Download tiles ──────────────────────────────────────────────────────────

  checkAbort(options.signal);

  var dlResult = await downloader.downloadTiles({
    type: 'raster', ofmStyleId: options.style,
    tiles: tileList, signal: options.signal,
    _directTileURL: rasterTileURL,
  });

  var validTiles = dlResult.tiles.filter(function(t) { return t.buffer && t.buffer.length > 0; });
  if (validTiles.length === 0) throw new Error('[raster-export] No valid tiles downloaded');

  dbg('Downloaded ' + validTiles.length + '/' + tileList.length + ' tiles');

  // ── Merge + crop + resize ───────────────────────────────────────────────────

  checkAbort(options.signal);

  var mergeOpts = {
    tiles:           validTiles,
    zoom:            tileList[0].z,
    width:           outW,
    height:          outH,
    tileSize:        tileSize,
    outputFormat:    format,
    backgroundColor: options.backgroundColor || bgColor,
    provider:        'direct',
    style:           options.style,
    signal:          options.signal,
  };

  if (cropRect) {
    // Camera snapshot: inject pre-computed crop rect
    mergeOpts._cropRect = cropRect;
    mergeOpts.bbox      = [-180, -85, 180, 85]; // placeholder for normaliseOptions
  } else if (options.center) {
    mergeOpts._viewportCenter = options.center;
    mergeOpts.bbox            = [-180, -85, 180, 85];
  } else {
    mergeOpts.bbox = options.bbox;
  }

  var mergeResult = await merger.mergeTiles(mergeOpts);

  checkAbort(options.signal);

  if (!mergeResult.buffer || mergeResult.buffer.length === 0)
    throw new Error('[raster-export] Empty buffer from merger');

  var totalMs  = Date.now() - startTime;
  var exportId = crypto.randomUUID();

  return {
    buffer: mergeResult.buffer,
    format: format,
    width:  mergeResult.width,
    height: mergeResult.height,
    bbox:   mergeResult.bounds,
    zoom:   tileList[0].z,
    metadata: {
      exportId, style: options.style, rasterTileURL,
      zoom: tileList[0].z, generatedAt: new Date().toISOString(),
      pipeline: useCamera ? 'camera-snapshot' : (options.center ? 'center' : 'bbox'),
    },
    stats: {
      download: dlResult.stats,
      merge:    mergeResult.stats,
      totalDurationMs: totalMs,
    },
  };
}

module.exports = { exportRaster };
