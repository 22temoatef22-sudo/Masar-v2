/**
 * Masar v2 — Geometry Processor
 * 
 * Takes raw GeoJSON from MVT decoder, clips to viewport bbox,
 * simplifies geometry, projects to pixel coordinates, and
 * separates features into rendering categories.
 * 
 * Input:  GeoJSON FeatureCollection, bbox, width, height
 * Output: { waterRings, landRings, borderRings, riverLines, stats }
 */

// ── Web Mercator Projection ────────────────────────────────────────────────────

/**
 * Project a single [lon, lat] to pixel [x, y] given the bbox and output dimensions.
 */
function lonLatToPixel(lon, lat, bbox, width, height) {
  const [west, south, east, north] = bbox;

  // Web Mercator: lon → x is linear, lat → y uses mercator formula
  const mercY = (latDeg) => {
    const latRad = (latDeg * Math.PI) / 180;
    return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  };

  const xFrac = (lon - west) / (east - west);
  const yTop = mercY(north);
  const yBot = mercY(south);
  const yFrac = (yTop - mercY(lat)) / (yTop - yBot);

  return [
    Math.round(xFrac * width * 100) / 100,
    Math.round(yFrac * height * 100) / 100,
  ];
}

/**
 * Project an entire ring (array of [lon, lat]) to pixel coordinates.
 */
function projectRing(ring, bbox, width, height) {
  return ring.map(([lon, lat]) => lonLatToPixel(lon, lat, bbox, width, height));
}

// ── Douglas-Peucker Simplification ─────────────────────────────────────────────

/**
 * Perpendicular distance from point P to line segment AB (all in [x, y]).
 */
function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  const ex = p[0] - cx;
  const ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Douglas-Peucker simplification (iterative to avoid stack overflow on large rings).
 * Works on pixel-space coordinates.
 */
function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;

  // Iterative DP using a stack
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let maxIdx = start;

    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      if (maxIdx - start > 1) stack.push([start, maxIdx]);
      if (end - maxIdx > 1) stack.push([maxIdx, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a ring to at most maxPoints using adaptive epsilon.
 */
function simplifyRing(ring, maxPoints) {
  if (ring.length <= maxPoints) return ring;

  // Start with a small epsilon, double until we're under the limit
  let epsilon = 0.5;
  let result = douglasPeucker(ring, epsilon);

  while (result.length > maxPoints && epsilon < 1000) {
    epsilon *= 2;
    result = douglasPeucker(ring, epsilon);
  }

  return result;
}

// ── BBox Clipping (Cohen-Sutherland style for polygons) ────────────────────────

/**
 * Check if a point is inside the bbox.
 */
function pointInBBox(lon, lat, bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/**
 * Check if a ring (array of [lon, lat]) intersects the bbox.
 * Quick check: any point inside, or ring bbox overlaps viewport bbox.
 */
function ringIntersectsBBox(ring, bbox) {
  if (ring.length === 0) return false;

  // Compute ring bounding box
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // BBox overlap test
  return !(maxLon < bbox[0] || minLon > bbox[2] || maxLat < bbox[1] || minLat > bbox[3]);
}

/**
 * Clip a polygon ring to the bbox using Sutherland-Hodgman algorithm.
 * Returns clipped ring or null if completely outside.
 */
function clipRingToBBox(ring, bbox) {
  if (!ringIntersectsBBox(ring, bbox)) return null;

  const [xmin, ymin, xmax, ymax] = bbox;

  // Sutherland-Hodgman against 4 edges
  const edges = [
    { inside: (p) => p[0] >= xmin, intersect: (a, b) => clipEdge(a, b, xmin, true, false) },
    { inside: (p) => p[0] <= xmax, intersect: (a, b) => clipEdge(a, b, xmax, true, true) },
    { inside: (p) => p[1] >= ymin, intersect: (a, b) => clipEdge(a, b, ymin, false, false) },
    { inside: (p) => p[1] <= ymax, intersect: (a, b) => clipEdge(a, b, ymax, false, true) },
  ];

  let output = ring.slice();

  for (const edge of edges) {
    if (output.length === 0) return null;
    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const currInside = edge.inside(current);
      const prevInside = edge.inside(prev);

      if (currInside) {
        if (!prevInside) {
          const inter = edge.intersect(prev, current);
          if (inter) output.push(inter);
        }
        output.push(current);
      } else if (prevInside) {
        const inter = edge.intersect(prev, current);
        if (inter) output.push(inter);
      }
    }
  }

  return output.length >= 3 ? output : null;
}

function clipEdge(a, b, val, isX, isMax) {
  const aVal = isX ? a[0] : a[1];
  const bVal = isX ? b[0] : b[1];
  const denom = bVal - aVal;
  if (Math.abs(denom) < 1e-12) return null;
  const t = (val - aVal) / denom;
  if (t < 0 || t > 1) return null;
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
  ];
}

/**
 * Clip a LineString to the bbox. Returns array of clipped segments.
 */
function clipLineToBBox(coords, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const segments = [];
  let current = [];

  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    const inside = p[0] >= xmin && p[0] <= xmax && p[1] >= ymin && p[1] <= ymax;

    if (inside) {
      if (current.length === 0 && i > 0) {
        // entering bbox — add intersection point
        const inter = lineBBoxIntersection(coords[i - 1], p, bbox);
        if (inter) current.push(inter);
      }
      current.push(p);
    } else {
      if (current.length > 0) {
        // leaving bbox — add intersection and close segment
        const inter = lineBBoxIntersection(p, coords[i - 1], bbox);
        if (inter) current.push(inter);
        if (current.length >= 2) segments.push(current);
        current = [];
      }
    }
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

function lineBBoxIntersection(outside, inside, bbox) {
  // Simple: just clamp the outside point to bbox
  return [
    Math.max(bbox[0], Math.min(bbox[2], outside[0])),
    Math.max(bbox[1], Math.min(bbox[3], outside[1])),
  ];
}

// ── Feature Classification ─────────────────────────────────────────────────────

/**
 * Determine what category a GeoJSON feature belongs to.
 * Returns: 'water' | 'border' | 'river' | null
 * 
 * NOTE: OpenMapTiles MVT schema has NO "land" polygon layer.
 * Land is rendered as a solid background color, with water polygons on top.
 * The LAND layer in AE will be a solid, not a shape layer.
 */
function classifyFeature(feature) {
  const layer = feature.properties._layer;
  const geomType = feature.geometry.type;

  if (layer === 'water') {
    // water polygons: oceans, seas, lakes
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      return 'water';
    }
    return null;
  }

  if (layer === 'waterway') {
    // rivers, streams — linestrings
    if (geomType === 'LineString' || geomType === 'MultiLineString') {
      return 'river';
    }
    return null;
  }

  if (layer === 'boundary') {
    // Admin boundaries — always LineStrings in OpenMapTiles
    if (geomType === 'LineString' || geomType === 'MultiLineString') {
      // Only admin_level 2 (country borders) and 3-4 (state/province)
      const adminLevel = feature.properties.admin_level;
      if (adminLevel !== undefined && adminLevel > 6) return null;
      return 'border';
    }
    return null;
  }

  return null;
}

// ── Main Processing Pipeline ───────────────────────────────────────────────────

const MAX_POINTS_PER_RING = 150;
const MAX_TOTAL_SHAPES = 300;

/**
 * Process a GeoJSON FeatureCollection into AE-ready pixel data.
 * 
 * NOTE: There are no "land" polygons in OpenMapTiles MVT.
 * Land is a solid background in AE; water polygons overlay it.
 * 
 * @param {Object}   geojson — FeatureCollection from MVT decoder
 * @param {number[]} bbox    — [west, south, east, north]
 * @param {number}   width   — output pixel width
 * @param {number}   height  — output pixel height
 * @returns {Object} { waterRings, borderRings, riverLines, stats }
 */
function processGeoJSON(geojson, bbox, width, height) {
  const waterRings = [];
  const borderRings = [];
  const riverLines = [];
  let totalShapes = 0;

  // Sort features: larger (by bbox area) first so we prioritize big shapes
  const scored = geojson.features.map((f) => {
    let area = 0;
    try {
      const coords = f.geometry.coordinates;
      if (f.geometry.type === 'Polygon' && coords[0]) {
        const ring = coords[0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        area = (maxX - minX) * (maxY - minY);
      }
    } catch (_) {}
    return { feature: f, area };
  });
  scored.sort((a, b) => b.area - a.area);

  for (const { feature } of scored) {
    if (totalShapes >= MAX_TOTAL_SHAPES) break;

    const category = classifyFeature(feature);
    if (!category) continue;

    const geom = feature.geometry;

    if (category === 'water') {
      const polygons = geom.type === 'MultiPolygon'
        ? geom.coordinates
        : [geom.coordinates];

      for (const polygon of polygons) {
        if (totalShapes >= MAX_TOTAL_SHAPES) break;

        // Process outer ring (index 0), skip holes for now
        const outerRing = polygon[0];
        if (!outerRing || outerRing.length < 3) continue;

        const clipped = clipRingToBBox(outerRing, bbox);
        if (!clipped || clipped.length < 3) continue;

        // Project to pixel space
        const projected = projectRing(clipped, bbox, width, height);

        // Simplify in pixel space
        const simplified = simplifyRing(projected, MAX_POINTS_PER_RING);
        if (simplified.length < 3) continue;

        waterRings.push(simplified);
        totalShapes++;
      }
    }

    if (category === 'border') {
      const lines = geom.type === 'MultiLineString'
        ? geom.coordinates
        : [geom.coordinates];

      for (const line of lines) {
        if (totalShapes >= MAX_TOTAL_SHAPES) break;
        if (!line || line.length < 2) continue;

        const clippedSegments = clipLineToBBox(line, bbox);
        for (const seg of clippedSegments) {
          if (totalShapes >= MAX_TOTAL_SHAPES) break;

          const projected = projectRing(seg, bbox, width, height);
          const simplified = simplifyRing(projected, MAX_POINTS_PER_RING);
          if (simplified.length < 2) continue;

          borderRings.push(simplified);
          totalShapes++;
        }
      }
    }

    if (category === 'river') {
      const lines = geom.type === 'MultiLineString'
        ? geom.coordinates
        : [geom.coordinates];

      for (const line of lines) {
        if (totalShapes >= MAX_TOTAL_SHAPES) break;
        if (!line || line.length < 2) continue;

        const clippedSegments = clipLineToBBox(line, bbox);
        for (const seg of clippedSegments) {
          if (totalShapes >= MAX_TOTAL_SHAPES) break;

          const projected = projectRing(seg, bbox, width, height);
          const simplified = simplifyRing(projected, MAX_POINTS_PER_RING);
          if (simplified.length < 2) continue;

          riverLines.push(simplified);
          totalShapes++;
        }
      }
    }
  }

  return {
    waterRings,
    borderRings,
    riverLines,
    stats: {
      totalShapes,
      water: waterRings.length,
      borders: borderRings.length,
      rivers: riverLines.length,
      totalPoints: [waterRings, borderRings, riverLines]
        .flat()
        .reduce((sum, ring) => sum + ring.length, 0),
    },
  };
}

module.exports = { processGeoJSON, lonLatToPixel, simplifyRing };
