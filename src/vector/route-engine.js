/**
 * Masar v3 — Route Geometry Engine
 *
 * Generates continuous projected polyline geometries from geographic route points.
 * Supports great-circle interpolation, smoothing, and IDL-artifact prevention.
 *
 * Does NOT generate AE Shape Layers, expressions, or animation keyframes.
 * Pure geometry preparation only.
 */

'use strict';

const projection = require('./projection');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_ROUTE = false;

function dbg(msg) {
  if (DEBUG_ROUTE) {
    console.log('[route-engine] ' + msg);
  }
}

// ── Constants & Math Helpers ───────────────────────────────────────────────────

// Threshold for detecting International Date Line crosses (45% of canvas width)
// Reason: Using exactly 0.5 can occasionally fail if the projection introduces
// slight edge margins or rounding. 0.45 safely and reliably catches global wraps.
const IDL_THRESHOLD_FACTOR = 0.45;
const DEFAULT_SIMPLIFY_TOLERANCE = 0.5; // pixel tolerance for DP
const PI = Math.PI;

function deg2rad(deg) { return deg * (PI / 180); }
function rad2deg(rad) { return rad * (180 / PI); }

function isValidPoint(pt) {
  return pt && typeof pt.lon === 'number' && typeof pt.lat === 'number' &&
         Number.isFinite(pt.lon) && Number.isFinite(pt.lat);
}

function computeGeographicDistance(p1, p2) {
  const lat1 = deg2rad(p1.lat);
  const lon1 = deg2rad(p1.lon);
  const lat2 = deg2rad(p2.lat);
  const lon2 = deg2rad(p2.lon);

  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  const a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLon / 2), 2);
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

/**
 * Dynamically calculates segment count based on geographic distance.
 * Ensures short routes aren't over-interpolated and long routes remain smooth.
 */
function computeSegmentCount(distanceRads) {
  const ratio = distanceRads / PI;
  const segments = Math.round(16 + (128 - 16) * ratio);
  return Math.max(16, Math.min(128, segments));
}

// ── Great Circle Math ──────────────────────────────────────────────────────────

/**
 * Interpolates points along a great circle between two geographic coordinates.
 * Prevents undefined behavior for exact antipodal points.
 */
function interpolateGreatCircle(p1, p2, segments) {
  const lat1 = deg2rad(p1.lat);
  const lon1 = deg2rad(p1.lon);
  const lat2 = deg2rad(p2.lat);
  const lon2 = deg2rad(p2.lon);

  // Haversine formula for distance
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  const a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLon / 2), 2);
  let d = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));

  // Fallback for identical points
  if (d === 0) return [p1, p2];

  // Antipodal edge case (d ≈ PI)
  if (Math.abs(d - PI) < 0.001) {
    d = PI - 0.001; // Slight offset to force a deterministic path
  }

  const results = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);

    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);

    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lon = Math.atan2(y, x);

    results.push({ lon: rad2deg(lon), lat: rad2deg(lat) });
  }

  return results;
}

// ── Geometry Processing ────────────────────────────────────────────────────────

/**
 * Applies Chaikin's corner-cutting algorithm to a pixel array for smooth curves.
 */
function smoothPolyline(points, iterations = 3) {
  if (points.length < 3) return points;
  let current = points;
  
  for (let i = 0; i < iterations; i++) {
    const next = [];
    next.push(current[0]); // Keep start point exact
    for (let j = 0; j < current.length - 1; j++) {
      const p0 = current[j];
      const p1 = current[j + 1];
      // Cut at 25% and 75%
      next.push([
        0.75 * p0[0] + 0.25 * p1[0],
        0.75 * p0[1] + 0.25 * p1[1]
      ]);
      next.push([
        0.25 * p0[0] + 0.75 * p1[0],
        0.25 * p0[1] + 0.75 * p1[1]
      ]);
    }
    next.push(current[current.length - 1]); // Keep end point exact
    current = next;
  }
  return current;
}

function pointLineDist(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.sqrt(Math.pow(pt[0] - a[0], 2) + Math.pow(pt[1] - a[1], 2));
  
  let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(Math.pow(pt[0] - (a[0] + t * dx), 2) + Math.pow(pt[1] - (a[1] + t * dy), 2));
}

/**
 * Standard Douglas-Peucker simplification.
 */
function simplifyDP(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointLineDist(points[i], points[0], points[points.length - 1]);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyDP(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyDP(points.slice(maxIdx), tolerance);
    return left.slice(0, left.length - 1).concat(right);
  } else {
    return [points[0], points[points.length - 1]];
  }
}

// ── Primary API ────────────────────────────────────────────────────────────────

/**
 * Builds projected route geometry from geographic points.
 *
 * @param {Object} options
 * @param {Array<{lon, lat}>} options.points
 * @param {number[]} options.bbox - Map bounding box
 * @param {number} options.width - Canvas width
 * @param {number} options.height - Canvas height
 * @param {string} [options.routeType='greatcircle'] - 'straight' | 'greatcircle'
 * @param {boolean} [options.simplify=false]
 * @param {boolean} [options.smooth=false]
 */
function buildRoute(options) {
  const startTime = Date.now();

  // 1. Validation
  if (!options.points || !Array.isArray(options.points) || options.points.length < 2) {
    throw new Error('[route-engine] Routes require a minimum of 2 valid points.');
  }
  for (let i = 0; i < options.points.length; i++) {
    if (!isValidPoint(options.points[i])) {
      throw new Error(`[route-engine] Invalid coordinate at index ${i}: ${JSON.stringify(options.points[i])}`);
    }
  }

  const bbox = options.bbox;
  const width = options.width;
  const height = options.height;
  const routeType = options.routeType === 'straight' ? 'straight' : 'greatcircle';

  // [EXTENSION POINT]: Future route types
  // 'flightArc' (parabolic Z-curve projected to 2D)
  // 'shipping' (A* pathfinding avoiding landmasses)

  // 2. Generate Geographic Segments
  let geoPoints = [];
  let totalSegments = 0;
  
  if (routeType === 'straight') {
    geoPoints = options.points;
    totalSegments = options.points.length - 1;
  } else {
    // Great Circle
    for (let i = 0; i < options.points.length - 1; i++) {
      const d = computeGeographicDistance(options.points[i], options.points[i + 1]);
      const segCount = computeSegmentCount(d);
      totalSegments += segCount;

      const segment = interpolateGreatCircle(options.points[i], options.points[i + 1], segCount);
      if (i > 0) segment.shift(); // Avoid duplicating joining nodes
      geoPoints = geoPoints.concat(segment);
    }
  }

  // 3. Project to Pixels
  let pixelPoints = [];
  for (let i = 0; i < geoPoints.length; i++) {
    const px = projection.lonLatToPixel({
      lon: geoPoints[i].lon,
      lat: geoPoints[i].lat,
      bbox: bbox,
      width: width,
      height: height
    });
    pixelPoints.push([px.x, px.y]);
  }

  // 4. Unwrap IDL artifacts (Make coordinates infinite/continuous)
  let offsetX = 0;
  let crossesIDL = false;
  const threshold = width * IDL_THRESHOLD_FACTOR;
  
  for (let i = 1; i < pixelPoints.length; i++) {
    let currX = pixelPoints[i][0] + offsetX;
    const prevX = pixelPoints[i - 1][0];
    const dx = currX - prevX;

    // If segment jumps more than the threshold, it crossed the Date Line
    if (dx > threshold) {
      offsetX -= width;
      currX -= width;
      crossesIDL = true;
    } else if (dx < -threshold) {
      offsetX += width;
      currX += width;
      crossesIDL = true;
    }
    pixelPoints[i][0] = currX;
  }

  const initialPointCount = pixelPoints.length;

  // 5. Smooth & Simplify
  // Architecture Note: The order (Smooth -> Simplify) is intentional.
  // Chaikin smoothing generates a high density of structurally pleasing curves,
  // while Douglas-Peucker safely removes redundant collinear points afterward,
  // optimizing the final payload without losing the geometric curvature.
  if (options.smooth) {
    pixelPoints = smoothPolyline(pixelPoints, 3);
  }
  if (options.simplify) {
    pixelPoints = simplifyDP(pixelPoints, DEFAULT_SIMPLIFY_TOLERANCE);
  }

  // 6. Calculate Outputs
  let lengthPixels = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < pixelPoints.length; i++) {
    const pt = pixelPoints[i];
    if (pt[0] < minX) minX = pt[0];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[1] > maxY) maxY = pt[1];

    if (i > 0) {
      const prev = pixelPoints[i - 1];
      lengthPixels += Math.sqrt(Math.pow(pt[0] - prev[0], 2) + Math.pow(pt[1] - prev[1], 2));
    }
  }

  const durationMs = Date.now() - startTime;
  const stats = {
    inputPoints: options.points.length,
    outputPoints: pixelPoints.length,
    routeLengthPixels: Math.round(lengthPixels),
    simplifiedPointsRemoved: initialPointCount - pixelPoints.length,
    durationMs: durationMs
  };

  dbg(`Built ${routeType} route: ${stats.outputPoints} points, length: ${stats.routeLengthPixels}px in ${durationMs}ms`);

  return {
    routePoints: pixelPoints,
    routeBounds: {
      minX: minX === Infinity ? 0 : minX,
      minY: minY === Infinity ? 0 : minY,
      maxX: maxX === -Infinity ? 0 : maxX,
      maxY: maxY === -Infinity ? 0 : maxY
    },
    lengthPixels: lengthPixels,
    metadata: {
      routeType: routeType,
      segments: totalSegments,
      crossesIDL: crossesIDL
    },
    stats: stats
  };
}

module.exports = {
  buildRoute,
  // Exposed for testing only
  _interpolateGreatCircle: interpolateGreatCircle,
  _smoothPolyline: smoothPolyline
};