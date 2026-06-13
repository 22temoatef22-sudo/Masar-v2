/**
 * Masar v3 — Vector Export Orchestrator
 *
 * Coordinates the conversion of Mapbox Vector Tiles into processed pixel geometry.
 * Bridges the MVT decoder and the GeoJSON geometry engine.
 *
 * Does NOT contain decoding logic, projection math, or AE generation code.
 */

'use strict';

const crypto = require('crypto');
const mvtDecoder = require('./mvt-decoder');
const geojsonEngine = require('./geojson-engine');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_VECTOR_EXPORT = false;

function dbg(msg) {
  if (DEBUG_VECTOR_EXPORT) {
    console.log('[vector-export] ' + msg);
  }
}

// ── Constants & Configuration ──────────────────────────────────────────────────

const DEFAULT_LAYERS = ['water', 'boundary', 'waterway'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateExportId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback UUID v4 for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    throw new Error('[vector-export] Export cancelled');
  }
}

function countPoints(shapeArray) {
  let count = 0;
  for (let i = 0; i < shapeArray.length; i++) {
    count += shapeArray[i].length;
  }
  return count;
}

// ── Primary API ────────────────────────────────────────────────────────────────

/**
 * Orchestrates the full vector export workflow.
 *
 * @param {Object} options
 * @param {string} options.provider
 * @param {string} options.style
 * @param {number[]} options.bbox - [west, south, east, north]
 * @param {number} options.zoom
 * @param {number} options.width
 * @param {number} options.height
 * @param {Array<string>} [options.layers] - e.g., ['water', 'boundary', 'waterway']
 * @param {boolean} [options.simplify=true]
 * @param {boolean} [options.clip=true]
 * @param {Object} [options.limits] - { maxShapes, maxPointsPerShape }
 * @param {AbortSignal} [options.signal]
 */
async function exportVector(options) {
  const startTime = Date.now();
  checkAbort(options.signal);

  // ── Step 1: Validate Input ──────────────────────────────────────────────────

  if (!options.provider || typeof options.provider !== 'string') throw new Error('[vector-export] provider is required');
  if (!options.style || typeof options.style !== 'string') throw new Error('[vector-export] style is required');
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4) throw new Error('[vector-export] bbox must be [W, S, E, N]');
  if (typeof options.zoom !== 'number') throw new Error('[vector-export] zoom is required');
  if (typeof options.width !== 'number' || options.width <= 0) throw new Error('[vector-export] width must be > 0');
  if (typeof options.height !== 'number' || options.height <= 0) throw new Error('[vector-export] height must be > 0');

  const layerSet = Array.isArray(options.layers) ? options.layers : DEFAULT_LAYERS;
  const limits = options.limits || { maxShapes: 300, maxPointsPerShape: 150 };

  dbg(`Init: provider=${options.provider}, style=${options.style}, zoom=${options.zoom}`);

  // ── Step 2: Decode MVT ──────────────────────────────────────────────────────

  checkAbort(options.signal);
  
  const decodedResult = await mvtDecoder.decodeMVT({
    provider: options.provider,
    style: options.style,
    bbox: options.bbox,
    zoom: options.zoom,
    layers: layerSet,
    signal: options.signal
  });

  // ── Step 3: Validate GeoJSON Result ─────────────────────────────────────────

  checkAbort(options.signal);

  if (!decodedResult || !decodedResult.features || decodedResult.features.length === 0) {
    throw new Error('[vector-export] Export failed: No features found in the requested bounding box.');
  }

  dbg(`Decoded ${decodedResult.features.length} raw features`);

  // ── Step 4: Process GeoJSON ─────────────────────────────────────────────────

  checkAbort(options.signal);

  // TODO (Phase 2): Route Engine Extension Point
  // Integrate routes, flight paths, and animated paths here.
  const processedResult = geojsonEngine.processGeoJSON({
    geojson: decodedResult,
    bbox: options.bbox,
    width: options.width,
    height: options.height,
    simplify: options.simplify,
    clip: options.clip,
    limits: limits
  });

  // ── Step 5: Validate Processed Geometry ─────────────────────────────────────

  checkAbort(options.signal);

  const totalShapes = processedResult.waterRings.length + 
                      processedResult.borderRings.length + 
                      processedResult.riverLines.length;

  if (totalShapes === 0) {
    throw new Error('[vector-export] Export failed: 0 output shapes generated after clipping and filtering.');
  }

  // ── Step 6: Build Export Payload ────────────────────────────────────────────

  const totalPoints = countPoints(processedResult.waterRings) +
                      countPoints(processedResult.borderRings) +
                      countPoints(processedResult.riverLines);

  const totalDurationMs = Date.now() - startTime;
  const exportId = generateExportId();

  dbg(`Success: ID=${exportId}, Shapes=${totalShapes}, Points=${totalPoints}, Duration=${totalDurationMs}ms`);

  // Ensure references are passed cleanly without cloning
  const payload = {
    waterRings:  processedResult.waterRings,
    borderRings: processedResult.borderRings,
    riverLines:  processedResult.riverLines,
    // [EXTENSION POINT]: roads: [], buildings: [], labels: []
    metadata: {
      exportId:    exportId,
      provider:    options.provider,
      style:       options.style,
      zoom:        options.zoom,
      bbox:        options.bbox,
      width:       options.width,
      height:      options.height,
      layerSet:    layerSet,
      generatedAt: new Date().toISOString()
    },
    stats: {
      decoder:     decodedResult.stats,
      geometry:    processedResult.stats,
      featureCount: decodedResult.features.length,
      totalShapes: totalShapes,
      totalPoints: totalPoints,
      durationMs:  totalDurationMs
    }
  };

  if (processedResult.outputBounds) {
    payload.outputBounds = processedResult.outputBounds;
  }

  return payload;
}

module.exports = {
  exportVector
};