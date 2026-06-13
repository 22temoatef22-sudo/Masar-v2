/**
 * Masar v2 — Server
 * 
 * Express server providing:
 *   POST /vector-map   — MVT → GeoJSON → pixel geometry (Phase 1 MVP)
 *   GET  /search        — City/country search (existing)
 *   POST /city-boundary — Get boundary for a city (existing)
 *   POST /generate-map  — Legacy D3/PNG map generation (existing, kept for compat)
 *   POST /finalize      — Legacy finalize (existing)
 *   GET  /health        — Health check
 */

const express = require('express');
const cors = require('cors');
const { decodeMVT } = require('./src/mvt-decoder');
const { processGeoJSON } = require('./src/geo-processor');

// Try loading existing modules (they may not exist yet in a fresh deploy)
let geodata, renderer;
try { geodata = require('./src/geodata'); } catch (_) { geodata = null; }
try { renderer = require('./src/renderer'); } catch (_) { renderer = null; }

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

// ── Style Colors ───────────────────────────────────────────────────────────────

const STYLE_COLORS = {
  dark:  { ocean: '#080c14', land: '#141c28', border: '#2a3550', water: '#0d1520', river: '#1a2a40' },
  light: { ocean: '#a8c8e8', land: '#f0ede0', border: '#999999', water: '#a8c8e8', river: '#7cb4d4' },
  topo:  { ocean: '#7ba7bc', land: '#d4c9a0', border: '#8b7040', water: '#7ba7bc', river: '#5a8fa8' },
};

// ── POST /vector-map ───────────────────────────────────────────────────────────

app.post('/vector-map', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      bbox,
      zoom = 4,
      style = 'dark',
      width = 3840,
      height = 2160,
    } = req.body;

    // Validate bbox
    if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
      return res.status(400).json({
        success: false,
        error: 'bbox is required as [west, south, east, north]',
      });
    }

    const [west, south, east, north] = bbox;
    if (west >= east || south >= north) {
      return res.status(400).json({
        success: false,
        error: 'Invalid bbox: west must be < east, south must be < north',
      });
    }

    console.log(`[vector-map] Request: bbox=[${bbox}], zoom=${zoom}, style=${style}, ${width}x${height}`);

    // Step 1: Decode MVT tiles → GeoJSON
    const geojson = await decodeMVT(bbox, zoom);
    const decodeTime = Date.now() - startTime;
    console.log(`[vector-map] MVT decode: ${geojson.features.length} features in ${decodeTime}ms`);

    // Step 2: Process GeoJSON → pixel geometry
    const result = processGeoJSON(geojson, bbox, width, height);
    const processTime = Date.now() - startTime - decodeTime;
    console.log(`[vector-map] Geo process: ${result.stats.totalShapes} shapes, ${result.stats.totalPoints} points in ${processTime}ms`);

    // Step 3: Get style colors
    const colors = STYLE_COLORS[style] || STYLE_COLORS.dark;

    // Step 4: Build response
    const response = {
      success: true,
      metadata: {
        waterRings: result.waterRings,
        borderRings: result.borderRings,
        riverLines: result.riverLines,
        style: colors,
        mapW: width,
        mapH: height,
      },
      stats: result.stats,
      timing: {
        decode: decodeTime,
        process: processTime,
        total: Date.now() - startTime,
      },
    };

    // Check payload size
    const payload = JSON.stringify(response);
    const payloadKB = Math.round(payload.length / 1024);
    console.log(`[vector-map] Payload: ${payloadKB}KB`);

    if (payloadKB > 500) {
      console.warn(`[vector-map] Payload ${payloadKB}KB exceeds 500KB limit!`);
      // Still send it but warn — the client will need to handle this
    }

    res.json(response);
  } catch (err) {
    console.error('[vector-map] Error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ── GET /search ────────────────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  if (!geodata) {
    return res.status(501).json({ error: 'geodata module not available' });
  }
  try {
    const q = req.query.q || '';
    const results = await geodata.search(q);
    res.json(results);
  } catch (err) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /city-boundary ────────────────────────────────────────────────────────

app.post('/city-boundary', async (req, res) => {
  if (!geodata) {
    return res.status(501).json({ error: 'geodata module not available' });
  }
  try {
    const { name, country } = req.body;
    const boundary = await geodata.getCityBoundary(name, country);
    res.json(boundary);
  } catch (err) {
    console.error('[city-boundary] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-map (legacy — kept for compat) ──────────────────────────────

app.post('/generate-map', async (req, res) => {
  if (!renderer) {
    return res.status(501).json({ error: 'Legacy renderer not available. Use /vector-map instead.' });
  }
  try {
    const result = await renderer.generateMap(req.body);
    res.json(result);
  } catch (err) {
    console.error('[generate-map] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /finalize (legacy) ────────────────────────────────────────────────────

app.post('/finalize', async (req, res) => {
  if (!renderer) {
    return res.status(501).json({ error: 'Legacy renderer not available.' });
  }
  try {
    const result = await renderer.finalize(req.body);
    res.json(result);
  } catch (err) {
    console.error('[finalize] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0-phase1',
    endpoints: ['/vector-map', '/search', '/city-boundary', '/generate-map', '/finalize'],
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Masar v2] Server running on port ${PORT}`);
});
