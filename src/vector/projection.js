/**
 * Masar v3 — Web Mercator Projection Engine (EPSG:3857)
 *
 * The single source of truth for all geographic to pixel transformations.
 * Pure functions. No side effects. Full floating-point precision.
 */

'use strict';

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_PROJECTION = false;

function dbg(funcName, input, output) {
  if (DEBUG_PROJECTION) {
    console.log(`[projection] ${funcName}()`, '\n  IN: ', input, '\n  OUT:', output);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_LATITUDE = 85.05112878;
const MIN_LATITUDE = -85.05112878;
const PI = Math.PI;

// ── Validation Helpers ─────────────────────────────────────────────────────────

function requireNum(val, name) {
  if (typeof val !== 'number' || Number.isNaN(val)) {
    throw new Error(`[projection] Invalid input: '${name}' must be a valid number. Got: ${val}`);
  }
  return val;
}

function requirePositive(val, name) {
  if (typeof val !== 'number' || Number.isNaN(val) || val <= 0) {
    throw new Error(`[projection] Invalid input: '${name}' must be > 0. Got: ${val}`);
  }
  return val;
}

function requireNonNegative(val, name) {
  if (typeof val !== 'number' || Number.isNaN(val) || val < 0) {
    throw new Error(`[projection] Invalid input: '${name}' must be >= 0. Got: ${val}`);
  }
  return val;
}

function clampLat(lat) {
  return Math.max(MIN_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

function validateBBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('[projection] Invalid input: bbox must be [west, south, east, north]');
  }
  for (let i = 0; i < 4; i++) {
    requireNum(bbox[i], `bbox[${i}]`);
  }
  if (bbox[1] >= bbox[3]) {
    throw new Error(`[projection] Invalid bbox: south (${bbox[1]}) must be less than north (${bbox[3]})`);
  }
  return bbox;
}

function normalizeLongitude(lon) {
  // Map to (-180, 180], preserving exact +180 edge.
  const trueMod = (n, m) => ((n % m) + m) % m;
  let res = trueMod(lon + 180, 360) - 180;
  if (res === -180 && lon > 0) return 180;
  return res;
}

// ── Core Projection API ────────────────────────────────────────────────────────

/**
 * Converts geographic coordinates to absolute world pixel coordinates.
 *
 * @param {Object} input - { lon, lat, zoom, tileSize }
 * @returns {Object} { x, y }
 */
function lonLatToWorldPixel(input) {
  const lon = normalizeLongitude(requireNum(input.lon, 'lon'));
  const lat = clampLat(requireNum(input.lat, 'lat'));
  const zoom = requireNonNegative(input.zoom, 'zoom');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const worldSize = Math.pow(2, zoom) * tileSize;

  const x = ((lon + 180) / 360) * worldSize;

  const latRad = (lat * PI) / 180;
  const y = (1 - Math.log(Math.tan(PI / 4 + latRad / 2)) / PI) / 2 * worldSize;

  const output = { x, y };
  dbg('lonLatToWorldPixel', input, output);
  return output;
}

/**
 * Converts absolute world pixel coordinates back to geographic coordinates.
 *
 * @param {Object} input - { x, y, zoom, tileSize }
 * @returns {Object} { lon, lat }
 */
function worldPixelToLonLat(input) {
  const x = requireNum(input.x, 'x');
  const y = requireNum(input.y, 'y');
  const zoom = requireNonNegative(input.zoom, 'zoom');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const worldSize = Math.pow(2, zoom) * tileSize;

  const lon = (x / worldSize) * 360 - 180;

  const n = PI - (2 * PI * y) / worldSize;
  const latRad = Math.atan(Math.sinh(n));
  const lat = (latRad * 180) / PI;

  const output = { lon: normalizeLongitude(lon), lat: clampLat(lat) };
  dbg('worldPixelToLonLat', input, output);
  return output;
}

/**
 * Projects geographic coordinates into a relative export canvas pixel space.
 * Completely resolution-independent. Supports IDL wrapping.
 *
 * @param {Object} input - { lon, lat, bbox, width, height }
 * @returns {Object} { x, y }
 */
function lonLatToPixel(input) {
  const lon = normalizeLongitude(requireNum(input.lon, 'lon'));
  const lat = clampLat(requireNum(input.lat, 'lat'));
  const bbox = validateBBox(input.bbox); // [west, south, east, north]
  const width = requirePositive(input.width, 'width');
  const height = requirePositive(input.height, 'height');

  // Use normalized world space (zoom 0, tileSize 1) for stable relative math
  const nw = lonLatToWorldPixel({ lon: bbox[0], lat: bbox[3], zoom: 0, tileSize: 1 });
  const se = lonLatToWorldPixel({ lon: bbox[2], lat: bbox[1], zoom: 0, tileSize: 1 });
  const pt = lonLatToWorldPixel({ lon: lon, lat: lat, zoom: 0, tileSize: 1 });

  let normWidth = se.x - nw.x;
  if (normWidth < 0) normWidth += 1; // IDL Wrap handling (worldSize = 1)

  const normHeight = se.y - nw.y;

  let ptDeltaX = pt.x - nw.x;
  if (bbox[0] > bbox[2] && ptDeltaX < 0) {
    // If bbox crosses IDL and point is wrapped
    ptDeltaX += 1;
  }

  const x = (ptDeltaX / normWidth) * width;
  const y = ((pt.y - nw.y) / normHeight) * height;

  const output = { x, y };
  dbg('lonLatToPixel', input, output);
  return output;
}

/**
 * Inverts relative export canvas pixels back into geographic coordinates.
 * Supports IDL wrapping inherently.
 *
 * @param {Object} input - { x, y, bbox, width, height }
 * @returns {Object} { lon, lat }
 */
function pixelToLonLat(input) {
  const x = requireNum(input.x, 'x');
  const y = requireNum(input.y, 'y');
  const bbox = validateBBox(input.bbox);
  const width = requirePositive(input.width, 'width');
  const height = requirePositive(input.height, 'height');

  const nw = lonLatToWorldPixel({ lon: bbox[0], lat: bbox[3], zoom: 0, tileSize: 1 });
  const se = lonLatToWorldPixel({ lon: bbox[2], lat: bbox[1], zoom: 0, tileSize: 1 });

  let normWidth = se.x - nw.x;
  if (normWidth < 0) normWidth += 1;

  const normHeight = se.y - nw.y;

  const ptX = nw.x + (x / width) * normWidth;
  const ptY = nw.y + (y / height) * normHeight;

  // worldPixelToLonLat normalizes out-of-bounds coordinates automatically
  const output = worldPixelToLonLat({ x: ptX, y: ptY, zoom: 0, tileSize: 1 });
  dbg('pixelToLonLat', input, output);
  return output;
}

/**
 * Converts tile grid coordinates to world pixel coordinates.
 * Note: Operates on tile-grid coordinates only. Intentionally independent of zoom.
 *
 * @param {Object} input - { x, y, tileSize }
 * @returns {Object} { pixelX, pixelY }
 */
function tileXYToWorldPixel(input) {
  const x = requireNum(input.x, 'x');
  const y = requireNum(input.y, 'y');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const output = {
    pixelX: x * tileSize,
    pixelY: y * tileSize
  };
  dbg('tileXYToWorldPixel', input, output);
  return output;
}

/**
 * Converts world pixel coordinates to tile grid coordinates.
 * Note: Operates on tile-grid coordinates only. Intentionally independent of zoom.
 *
 * @param {Object} input - { pixelX, pixelY, tileSize }
 * @returns {Object} { x, y }
 */
function worldPixelToTileXY(input) {
  const pixelX = requireNum(input.pixelX, 'pixelX');
  const pixelY = requireNum(input.pixelY, 'pixelY');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const output = {
    x: pixelX / tileSize,
    y: pixelY / tileSize
  };
  dbg('worldPixelToTileXY', input, output);
  return output;
}

/**
 * Converts a geographic bounding box into a raw floating-point pixel rectangle.
 * Safely handles bounding boxes spanning the International Date Line.
 *
 * @param {Object} input - { bbox, zoom, tileSize }
 * @returns {Object} { left, top, width, height }
 */
function bboxToPixelRect(input) {
  const bbox = validateBBox(input.bbox); // [west, south, east, north]
  const zoom = requireNonNegative(input.zoom, 'zoom');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const nw = lonLatToWorldPixel({ lon: bbox[0], lat: bbox[3], zoom, tileSize });
  const se = lonLatToWorldPixel({ lon: bbox[2], lat: bbox[1], zoom, tileSize });

  let width = se.x - nw.x;
  if (width < 0) {
    // Handle wrap across International Date Line
    width += Math.pow(2, zoom) * tileSize;
  }

  const output = {
    left: nw.x,
    top: nw.y,
    width: width,
    height: se.y - nw.y
  };
  dbg('bboxToPixelRect', input, output);
  return output;
}

/**
 * Converts a pixel rectangle back into a geographic bounding box.
 * Will naturally return IDL-crossing bounding boxes if width exceeds the wrap boundary.
 *
 * @param {Object} input - { left, top, width, height, zoom, tileSize }
 * @returns {number[]} [west, south, east, north]
 */
function pixelRectToBBox(input) {
  const left = requireNum(input.left, 'left');
  const top = requireNum(input.top, 'top');
  const width = requirePositive(input.width, 'width');
  const height = requirePositive(input.height, 'height');
  const zoom = requireNonNegative(input.zoom, 'zoom');
  const tileSize = requirePositive(input.tileSize, 'tileSize');

  const nw = worldPixelToLonLat({ x: left, y: top, zoom, tileSize });
  const se = worldPixelToLonLat({ x: left + width, y: top + height, zoom, tileSize });

  const output = [nw.lon, se.lat, se.lon, nw.lat];
  dbg('pixelRectToBBox', input, output);
  return output;
}

module.exports = {
  lonLatToWorldPixel,
  worldPixelToLonLat,
  lonLatToPixel,
  pixelToLonLat,
  tileXYToWorldPixel,
  worldPixelToTileXY,
  bboxToPixelRect,
  pixelRectToBBox,
  _normalizeLongitude: normalizeLongitude // Exported for isolated testing
};
