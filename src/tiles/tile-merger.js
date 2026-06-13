/**
 * Masar v3 — Tile Merger
 *
 * Raster composition engine. Rebuilds a geographically-accurate map image
 * entirely from downloaded source tile buffers using Sharp.
 *
 * Pipeline:
 * 1. Validate tiles (skip null/empty buffers)
 * 2. Compute tile grid extent from tile coordinates
 * 3. Compute mosaic dimensions (grid width × tileSize, grid height × tileSize)
 * 4. Create RGBA base canvas via sharp {create}
 * 5. Composite all valid tiles at their exact pixel offsets
 * 6. Compute bbox pixel rect within mosaic via Web Mercator projection
 * 7. Extract (crop) mosaic to exact geographic bbox
 * 8. Resize cropped result to requested output dimensions (Lanczos3)
 * 9. Encode to requested format (png/jpeg/webp)
 * 10. Return { buffer, width, height, format, bounds, stats, metadata }
 *
 * Primary API:
 * merger.mergeTiles(options) → { buffer, width, height, format, bounds, stats, metadata }
 * merger.bboxToPixelRect(bbox, zoom, tileSize, xMin, yMin) → { left, top, width, height }
 * merger.lonLatToWorldPixel(lon, lat, zoom, tileSize) → { x, y }
 *
 * No browser, no canvas, no MapLibre, no screenshots.
 * Output is built entirely from source tile buffers.
 */

'use strict';

const sharp = require('sharp');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_MERGER = false;

function dbg(msg) {
  if (DEBUG_MERGER) {
    console.log('[tile-merger] ' + msg);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TILE_SIZE        = 256;
const DEFAULT_BACKGROUND       = { r: 0, g: 0, b: 0, alpha: 0 };  // transparent
const DEFAULT_OUTPUT_FORMAT    = 'png';
const DEFAULT_JPEG_QUALITY     = 90;
const DEFAULT_WEBP_QUALITY     = 90;
const DEFAULT_PNG_COMPRESSION  = 6;    // 0=fastest, 9=smallest
const RESIZE_KERNEL            = 'lanczos3'; // best quality for map downscaling

const MAX_EXPORT_DIMENSION     = 8192;
const MAX_EXPORT_PIXELS        = 67108864; // 8192 * 8192

// Output format whitelist
const VALID_FORMATS = { png: true, jpeg: true, jpg: true, webp: true };

// ── Helpers ────────────────────────────────────────────────────────────────────

function checkAbort(signal) {
  if (signal && signal.aborted) {
    dbg('Cancellation event detected. Aborting merge.');
    throw new Error('[tile-merger] Merge cancelled');
  }
}

// ── Web Mercator Projection ────────────────────────────────────────────────────

/**
 * Convert geographic coordinates to world pixel position in Web Mercator.
 */
function lonLatToWorldPixel(lon, lat, zoom, tileSize) {
  var z   = Math.floor(zoom);
  var dim = Math.pow(2, z) * tileSize;  // world size in pixels at this zoom

  var x = ((lon + 180) / 360) * dim;

  var latRad = lat * Math.PI / 180;
  var y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * dim;

  return { x: x, y: y };
}

/**
 * Convert tile coordinates to their top-left world pixel position.
 */
function tileXYToWorldPixel(tileX, tileY, tileSize) {
  return {
    x: tileX * tileSize,
    y: tileY * tileSize,
  };
}

/**
 * Compute the pixel rectangle within the mosaic that corresponds to the
 * requested bbox. All values are floored/ceiled to integer pixels.
 */
function bboxToPixelRect(bbox, zoom, tileSize, xMin, yMin) {
  var west  = bbox[0];
  var south = bbox[1];
  var east  = bbox[2];
  var north = bbox[3];

  var mosaicOriginX = xMin * tileSize;
  var mosaicOriginY = yMin * tileSize;

  var nwWorld = lonLatToWorldPixel(west,  north, zoom, tileSize);
  var seWorld = lonLatToWorldPixel(east,  south, zoom, tileSize);

  // Convert world pixels → mosaic-local pixels
  var left   = Math.floor(nwWorld.x - mosaicOriginX);
  var top    = Math.floor(nwWorld.y - mosaicOriginY);
  var right  = Math.ceil(seWorld.x  - mosaicOriginX);
  var bottom = Math.ceil(seWorld.y  - mosaicOriginY);

  return {
    left:   left,
    top:    top,
    width:  right - left,
    height: bottom - top,
  };
}

// ── Input Validation ───────────────────────────────────────────────────────────

/**
 * Validate a single tile object. Returns null if invalid.
 */
function validateTile(tile) {
  if (!tile || typeof tile !== 'object') return null;
  if (typeof tile.z !== 'number' || typeof tile.x !== 'number' || typeof tile.y !== 'number') return null;
  if (!Buffer.isBuffer(tile.buffer) || tile.buffer.length === 0) return null;
  return tile;
}

/**
 * Parse and normalise the mergeTiles options object.
 * Throws descriptive errors for required fields.
 */
function normaliseOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('[tile-merger] options is required');
  }
  if (!Array.isArray(options.tiles) || options.tiles.length === 0) {
    throw new Error('[tile-merger] options.tiles must be a non-empty array');
  }
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4) {
    throw new Error('[tile-merger] options.bbox must be [west, south, east, north]');
  }
  if (typeof options.zoom !== 'number') {
    throw new Error('[tile-merger] options.zoom is required');
  }
  
  var width = Math.round(options.width);
  var height = Math.round(options.height);

  if (typeof width !== 'number' || width <= 0) {
    throw new Error('[tile-merger] options.width must be a positive number');
  }
  if (typeof height !== 'number' || height <= 0) {
    throw new Error('[tile-merger] options.height must be a positive number');
  }

  // Dimension & Megapixel Protections
  if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) {
    throw new Error('[tile-merger] Export dimensions exceed maximum allowed (' + MAX_EXPORT_DIMENSION + 'px)');
  }
  if ((width * height) > MAX_EXPORT_PIXELS) {
    throw new Error('[tile-merger] Export pixel count exceeds maximum allowed (' + MAX_EXPORT_PIXELS + ' pixels)');
  }

  var tileSize     = (typeof options.tileSize === 'number' && options.tileSize > 0)
                     ? options.tileSize : undefined;
  var format       = options.outputFormat
                     ? options.outputFormat.toLowerCase().replace('jpg', 'jpeg')
                     : DEFAULT_OUTPUT_FORMAT;

  if (!VALID_FORMATS[format]) {
    throw new Error('[tile-merger] Unknown output format: "' + options.outputFormat +
                    '". Must be one of: ' + Object.keys(VALID_FORMATS).join(', '));
  }

  var background = options.backgroundColor || DEFAULT_BACKGROUND;

  return {
    tiles:            options.tiles,
    bbox:             options.bbox,
    zoom:             Math.floor(options.zoom),
    width:            width,
    height:           height,
    tileSize:         tileSize, // May be undefined, resolved in pipeline
    format:           format,
    background:       background,
    showMissingTiles: !!options.showMissingTiles,
    signal:           options.signal,
    layers:           Array.isArray(options.layers) ? options.layers : [],
    provider:         (options.provider && typeof options.provider === 'string') ? options.provider : 'unknown',
    style:            (options.style && typeof options.style === 'string') ? options.style : 'unknown',
  };
}

// ── Tile Grid Computation ──────────────────────────────────────────────────────

/**
 * Compute the bounding box of the tile grid from a set of valid tiles.
 */
function computeGridExtent(validTiles) {
  var xMin = Infinity;
  var yMin = Infinity;
  var xMax = -Infinity;
  var yMax = -Infinity;

  for (var i = 0; i < validTiles.length; i++) {
    var t = validTiles[i];
    if (t.x < xMin) xMin = t.x;
    if (t.x > xMax) xMax = t.x;
    if (t.y < yMin) yMin = t.y;
    if (t.y > yMax) yMax = t.y;
  }

  return {
    xMin:  xMin,
    yMin:  yMin,
    xMax:  xMax,
    yMax:  yMax,
    gridW: xMax - xMin + 1,  
    gridH: yMax - yMin + 1,  
  };
}

// ── Sharp Pipeline ─────────────────────────────────────────────────────────────

function buildCompositeInputs(validTiles, grid, tileSize) {
  var inputs = [];
  for (var i = 0; i < validTiles.length; i++) {
    var tile = validTiles[i];
    var left = (tile.x - grid.xMin) * tileSize;
    var top  = (tile.y - grid.yMin) * tileSize;
    inputs.push({
      input: tile.buffer,
      left:  left,
      top:   top,
      blend: 'over',
    });
  }
  return inputs;
}

function clampCropRect(rect, mosaicW, mosaicH) {
  var left   = Math.max(0, Math.min(rect.left, mosaicW - 1));
  var top    = Math.max(0, Math.min(rect.top,  mosaicH - 1));
  var right  = Math.max(left + 1, Math.min(rect.left + rect.width,  mosaicW));
  var bottom = Math.max(top  + 1, Math.min(rect.top  + rect.height, mosaicH));

  return {
    left:   left,
    top:    top,
    width:  right - left,
    height: bottom - top,
  };
}

function applyOutputFormat(pipeline, format, options) {
  if (format === 'jpeg') {
    return pipeline.jpeg({
      quality:       options.jpegQuality    || DEFAULT_JPEG_QUALITY,
      mozjpeg:       true,
      chromaSubsampling: '4:4:4',
    });
  }
  if (format === 'webp') {
    return pipeline.webp({
      quality:       options.webpQuality    || DEFAULT_WEBP_QUALITY,
      lossless:      false,
    });
  }
  return pipeline.png({
    compressionLevel: options.pngCompression != null
                      ? options.pngCompression
                      : DEFAULT_PNG_COMPRESSION,
    adaptiveFiltering: true,
  });
}

// ── Primary API ────────────────────────────────────────────────────────────────

async function mergeTiles(options) {
  var startTime = Date.now();
  var opts = normaliseOptions(options);

  checkAbort(opts.signal);

  // ── Step 1: Validate tiles & Extract Placeholders ───────────────────────────

  var validTiles   = [];
  var placeholderTargets = [];
  var tilesSkipped = 0;

  for (var i = 0; i < opts.tiles.length; i++) {
    var t = opts.tiles[i];
    if (validateTile(t)) {
      validTiles.push(t);
    } else {
      if (opts.showMissingTiles && t && typeof t.x === 'number' && typeof t.y === 'number') {
        placeholderTargets.push(t);
      } else {
        tilesSkipped++;
      }
    }
  }

  if (validTiles.length === 0) {
    throw new Error('[tile-merger] No valid tiles to merge (all ' + opts.tiles.length + ' tiles were invalid/missing)');
  }

  // ── Step 2: Auto Tile Size Detection & Metadata Diagnostics ─────────────────

  if (!opts.tileSize) {
    try {
      var meta = await sharp(validTiles[0].buffer).metadata();
      // Support flexible tile sizes (e.g., 256, 512, 1024, retina variants)
      if (meta.width && meta.width > 0) {
        opts.tileSize = meta.width;
      } else {
        opts.tileSize = DEFAULT_TILE_SIZE;
      }