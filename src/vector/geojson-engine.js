/**
 * Masar v3 — GeoJSON Geometry Engine
 *
 * Core geometry processing pipeline. Transforms raw GeoJSON features into
 * clean, projected pixel arrays ready for After Effects Shape Layers.
 *
 * Pipeline: Filter -> Score -> Sort -> Clip -> Simplify -> Project -> Limit
 *
 * Pure geometry engine. No AE dependencies. No JSX. No MapLibre.
 */

'use strict';

const projection = require('./projection');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_GEOJSON = false;

function dbg(msg) {
  if (DEBUG_GEOJSON) {
    console.log('[geojson-engine] ' + msg);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SHAPES = 300;
const DEFAULT_MAX_POINTS_PER_SHAPE = 150;
const DEFAULT_SIMPLIFY_TOLERANCE = 0.0005; // Degrees (~50m)

// ── Math & Geometry Helpers ────────────────────────────────────────────────────

function isValidPoint(pt) {
  return Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]);
}

/**
 * Fast bounding box computation for a coordinate array.
 */
function computeBBox(coords) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Checks if two bounding boxes intersect.
 */
function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Computes rough geographic area for scoring/prioritization.
 */
function computeScoreArea(bbox) {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

/**
 * Computes rough geographic length for line scoring.
 */
function computeScoreLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/**
 * Perpendicular distance from a point to a line segment.
 */
function pointLineDistance(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) {
    const pdx = pt[0] - a[0];
    const pdy = pt[1] - a[1];
    return Math.sqrt(pdx * pdx + pdy * pdy);
  }
  let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  const pdx = pt[0] - projX;
  const pdy = pt[1] - projY;
  return Math.sqrt(pdx * pdx + pdy * pdy);
}

/**
 * Iterative Douglas-Peucker simplification.
 * Uses a stack to prevent Call Stack Exceeded on massive coastlines.
 */
function simplifyDP(coords, tolerance) {
  if (coords.length <= 2) return coords;

  const stack = [[0, coords.length - 1]];
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  while (stack.length > 0) {
    const range = stack.pop();
    const start = range[0];
    const end = range[1];

    let maxDist = 0;
    let maxIdx = start;

    for (let i = start + 1; i < end; i++) {
      const dist = pointLineDistance(coords[i], coords[start], coords[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const result = [];
  for (let i = 0; i < coords.length; i++) {
    if (keep[i]) result.push(coords[i]);
  }
  return result;
}

/**
 * Deterministic point decimation.
 * Subsamples points evenly to fit within the maximum limit.
 */
function decimatePoints(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords;
  const result = [];
  const stride = (coords.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.floor(i * stride), coords.length - 1);
    result.push(coords[idx]);
  }
  return result;
}

/**
 * Resolves the functional layer class of a feature.
 * Future-proofed to support diverse tagging schemas (class, subclass, boundary flags).
 */
function classifyFeature(feature) {
  if (!feature || !feature.properties) return 'unknown';
  
  const p = feature.properties;
  const layer = p.layer || p.class || p.subclass;
  
  if (layer === 'water') return 'water';
  if (layer === 'waterway') return 'waterway';
  if (layer === 'boundary' || p.boundary) return 'boundary';
  
  return 'unknown';
}

// ── Extraction Pipeline ────────────────────────────────────────────────────────

function extractPolygons(feature, targetClass) {
  const geom = feature.geometry;
  const items = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

  for (let i = 0; i < polys.length; i++) {
    const outerRing = polys[i][0]; // Phase 1: Ignore holes (polys[i][1..n])
    // TODO (Phase 2): Support interior rings (holes) for complex paths in After Effects
    
    if (!outerRing || outerRing.length < 3) continue;
    
    const bbox = computeBBox(outerRing);
    items.push({
      type: 'polygon',
      target: targetClass,
      coords: outerRing,
      bbox: bbox,
      score: computeScoreArea(bbox)
    });
  }
  return items;
}

function extractLines(feature, targetClass) {
  const geom = feature.geometry;
  const items = [];
  const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].length < 2) continue;
    const bbox = computeBBox(lines[i]);
    items.push({
      type: 'line',
      target: targetClass,
      coords: lines[i],
      bbox: bbox,
      score: computeScoreLength(lines[i])
    });
  }
  return items;
}

// ── Primary API ────────────────────────────────────────────────────────────────

/**
 * Transforms raw GeoJSON features into projected pixel arrays.
 * * @param {Object} options
 * @param {Object} options.geojson - GeoJSON FeatureCollection
 * @param {number[]} options.bbox - Map bounding box [W, S, E, N]
 * @param {number} options.width - Output canvas width
 * @param {number} options.height - Output canvas height
 * @param {boolean} [options.simplify=true] - Apply DP simplification
 * @param {boolean} [options.clip=true] - Remove out-of-bounds features
 * @param {Object} [options.limits] - { maxShapes, maxPointsPerShape }
 * @returns {Object} { waterRings, borderRings, riverLines, outputBounds, stats }
 */
function processGeoJSON(options) {
  const startTime = Date.now();
  
  if (!options || !options.geojson || !Array.isArray(options.geojson.features)) {
    throw new Error('[geojson-engine] Invalid input: geojson FeatureCollection required.');
  }

  const bbox = options.bbox;
  const width = options.width;
  const height = options.height;
  const doSimplify = options.simplify !== false;
  const doClip = options.clip !== false;
  
  const limits = options.limits || {};
  const maxShapes = limits.maxShapes || DEFAULT_MAX_SHAPES;
  const maxPoints = limits.maxPointsPerShape || DEFAULT_MAX_POINTS_PER_SHAPE;

  const stats = {
    inputFeatures: options.geojson.features.length,
    outputShapes: 0,
    waterShapes: 0,
    borderShapes: 0,
    riverShapes: 0,
    skippedFeatures: 0,
    simplifiedPointsRemoved: 0,
    clippedFeatures: 0,
    durationMs: 0
  };

  // Initialize projected output bounds
  let outMinX = Infinity, outMinY = Infinity, outMaxX = -Infinity, outMaxY = -Infinity;

  // 1. Classification & Extraction
  let extractedItems = [];

  for (let i = 0; i < options.geojson.features.length; i++) {
    const feature = options.geojson.features[i];
    if (!feature || !feature.geometry) continue;

    const layerClass = classifyFeature(feature);
    const type = feature.geometry.type;

    if (layerClass === 'water' && (type === 'Polygon' || type === 'MultiPolygon')) {
      extractedItems = extractedItems.concat(extractPolygons(feature, 'waterRings'));
    } 
    else if (layerClass === 'boundary' && (type === 'LineString' || type === 'MultiLineString')) {
      extractedItems = extractedItems.concat(extractLines(feature, 'borderRings'));
    } 
    else if (layerClass === 'waterway' && (type === 'LineString' || type === 'MultiLineString')) {
      extractedItems = extractedItems.concat(extractLines(feature, 'riverLines'));
    } 
    else {
      // [EXTENSION POINT]: Roads, Buildings, Labels
      stats.skippedFeatures++;
    }
  }

  // 2. Pre-filter by BBox Clipping
  // TODO (Phase 2): Implement true geometric clipping.
  // - Sutherland-Hodgman for polygon clipping
  // - Cohen-Sutherland for line clipping
  if (doClip && bbox) {
    const initialCount = extractedItems.length;
    extractedItems = extractedItems.filter(item => bboxIntersects(item.bbox, bbox));
    stats.clippedFeatures += (initialCount - extractedItems.length);
  }

  // 3. Prioritize & Limit Shapes (Largest/Longest first)
  extractedItems.sort((a, b) => b.score - a.score);
  if (extractedItems.length > maxShapes) {
    stats.skippedFeatures += (extractedItems.length - maxShapes);
    extractedItems = extractedItems.slice(0, maxShapes);
  }

  // 4. Transform Output Stores
  const output = {
    waterRings: [],
    borderRings: [],
    riverLines: []
  };

  // 5. Process (Simplify, Project, Limit Points)
  for (let i = 0; i < extractedItems.length; i++) {
    const item = extractedItems[i];
    let coords = item.coords;
    const initialPoints = coords.length;

    if (doSimplify) {
      coords = simplifyDP(coords, DEFAULT_SIMPLIFY_TOLERANCE);
    }

    if (coords.length > maxPoints) {
      coords = decimatePoints(coords, maxPoints);
    }

    stats.simplifiedPointsRemoved += (initialPoints - coords.length);

    // Future Architecture Note: Implement Batch projection API (e.g. projection.projectPoints(coords))
    // to reduce function call overhead on massive datasets.
    const projectedPoints = [];
    for (let j = 0; j < coords.length; j++) {
      if (!isValidPoint(coords[j])) continue;
      
      const px = projection.lonLatToPixel({
        lon: coords[j][0],
        lat: coords[j][1],
        bbox: bbox,
        width: width,
        height: height
      });
      projectedPoints.push([px.x, px.y]);
    }

    // Validation post-projection
    let keep = false;
    if (item.type === 'polygon' && projectedPoints.length >= 3) {
      output[item.target].push(projectedPoints);
      stats.waterShapes++;
      stats.outputShapes++;
      keep = true;
    } 
    else if (item.type === 'line' && projectedPoints.length >= 2) {
      output[item.target].push(projectedPoints);
      if (item.target === 'borderRings') stats.borderShapes++;
      if (item.target === 'riverLines') stats.riverShapes++;
      stats.outputShapes++;
      keep = true;
    }

    // Update global projected bounds ONLY for valid, kept geometries
    if (keep) {
      for (let j = 0; j < projectedPoints.length; j++) {
        const ptX = projectedPoints[j][0];
        const ptY = projectedPoints[j][1];
        if (ptX < outMinX) outMinX = ptX;
        if (ptX > outMaxX) outMaxX = ptX;
        if (ptY < outMinY) outMinY = ptY;
        if (ptY > outMaxY) outMaxY = ptY;
      }
    }
  }

  stats.durationMs = Date.now() - startTime;
  
  dbg(`Processed ${stats.inputFeatures} features -> ${stats.outputShapes} shapes in ${stats.durationMs}ms`);
  dbg(`Clipped: ${stats.clippedFeatures}, Points Removed: ${stats.simplifiedPointsRemoved}`);

  return {
    waterRings: output.waterRings,
    borderRings: output.borderRings,
    riverLines: output.riverLines,
    outputBounds: {
      minX: outMinX === Infinity ? 0 : outMinX,
      minY: outMinY === Infinity ? 0 : outMinY,
      maxX: outMaxX === -Infinity ? 0 : outMaxX,
      maxY: outMaxY === -Infinity ? 0 : outMaxY
    },
    stats: stats
  };
}

module.exports = {
  processGeoJSON,
  _classifyFeature: classifyFeature, // Exported for isolated testing
  _computeBBox: computeBBox,
  _bboxIntersects: bboxIntersects,
  _simplifyDP: simplifyDP,
  _decimatePoints: decimatePoints
};