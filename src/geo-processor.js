/**
 * Masar v2 — Geometry Processor
 */

// ── Web Mercator Projection ────────────────────────────────────────────────────

function lonLatToPixel(lon, lat, bbox, width, height) {
  const [west, south, east, north] = bbox;

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

function projectRing(ring, bbox, width, height) {
  return ring.map(([lon, lat]) => lonLatToPixel(lon, lat, bbox, width, height));
}

// ── Douglas-Peucker Simplification ─────────────────────────────────────────────

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

function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;

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

function simplifyRing(ring, maxPoints) {
  if (ring.length <= maxPoints) return ring;

  let epsilon = 0.5;
  let result = douglasPeucker(ring, epsilon);

  while (result.length > maxPoints && epsilon < 1000) {
    epsilon *= 2;
    result = douglasPeucker(ring, epsilon);
  }

  return result;
}

// ── BBox Clipping ──────────────────────────────────────────────────────────────

function pointInBBox(lon, lat, bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function ringIntersectsBBox(ring, bbox) {
  if (ring.length === 0) return false;

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return !(maxLon < bbox[0] || minLon > bbox[2] || maxLat < bbox[1] || minLat > bbox[3]);
}

function clipRingToBBox(ring, bbox) {
  if (!ringIntersectsBBox(ring, bbox)) return null;

  const [xmin, ymin, xmax, ymax] = bbox;

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
 * Liang–Barsky Line Clipping Algorithm
 */
function clipSegmentLiangBarsky(p1, p2, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  let [x0, y0] = p1;
  let [x1, y1] = p2;
  
  let t0 = 0.0;
  let t1 = 1.0;
  const dx = x1 - x0;
  const dy = y1 - y0;

  const p = [-dx, dx, -dy, dy];
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; 
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  if (t0 > t1) return null;

  return [
    [x0 + t0 * dx, y0 + t0 * dy],
    [x0 + t1 * dx, y0 + t1 * dy]
  ];
}

function clipLineToBBox(coords, bbox) {
  const clippedLines = [];
  let currentSegment = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    
    const clipped = clipSegmentLiangBarsky(p1, p2, bbox);
    
    if (clipped) {
      if (currentSegment.length === 0) {
        currentSegment.push(clipped[0]);
      }
      currentSegment.push(clipped[1]);
      
      if (clipped[1][0] !== p2[0] || clipped[1][1] !== p2[1]) {
        if (currentSegment.length >= 2) clippedLines.push(currentSegment);
        currentSegment = [];
      }
    } else {
      if (currentSegment.length >= 2) clippedLines.push(currentSegment);
      currentSegment = [];
    }
  }

  if (currentSegment.length >= 2) clippedLines.push(currentSegment);
  return clippedLines;
}

// ── Feature Classification ─────────────────────────────────────────────────────

function classifyFeature(feature) {
  const layer = feature.properties._layer;
  const geomType = feature.geometry.type;

  if (layer === 'water') {
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      return 'water';
    }
    return null;
  }

  if (layer === 'waterway') {
    if (geomType === 'LineString' || geomType === 'MultiLineString') {
      return 'river';
    }
    return null;
  }

  if (layer === 'boundary') {
    if (geomType === 'LineString' || geomType === 'MultiLineString') {
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

function processGeoJSON(geojson, bbox, width, height) {
  const waterRings = [];
  const borderRings = [];
  const riverLines = [];
  let totalShapes = 0;

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

        const outerRing = polygon[0];
        if (!outerRing || outerRing.length < 3) continue;

        const clipped = clipRingToBBox(outerRing, bbox);
        if (!clipped || clipped.length < 3) continue;

        const projected = projectRing(clipped, bbox, width, height);
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
