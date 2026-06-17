/**
 * Masar v3 — Central API Server
 * * Orchestration layer. Contains no legacy D3/Canvas code.
 * Routes requests directly to specialized raster/vector engines.
 */

'use strict';

const express = require('express');
const cors = require('cors');

// ── Engine Imports ─────────────────────────────────────────────────────────────
const openfreemap = require('./src/providers/openfreemap');
const { cache: tileCache } = require('./src/tiles/tile-cache');
const { exportRaster } = require('./src/export/raster-export');
const { exportVector } = require('./src/vector/vector-export');
const { buildRoute } = require('./src/vector/route-engine');

const app = express();

// Middleware
app.use(cors());
// 50mb limit to handle exceptionally large custom flight path / point arrays
app.use(express.json({ limit: '50mb' })); 

// ── Diagnostics & Logging ──────────────────────────────────────────────────────

function dbg(namespace, msg) {
  console.log(`[${namespace}] ${msg}`);
}

// ── Centralized Response Helpers ───────────────────────────────────────────────

function sendSuccess(res, namespace, data, startTime) {
  const durationMs = Date.now() - startTime;
  dbg(namespace, `200 OK (${durationMs}ms)`);
  
  res.status(200).json({
    success: true,
    ...data,
    timing: {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      durationMs: durationMs
    }
  });
}

function sendError(res, namespace, error, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  dbg(namespace, `${status} ERROR: ${message}`);
  
  res.status(status).json({
    success: false,
    error: message
  });
}

// ── API Endpoints ──────────────────────────────────────────────────────────────

/**
 * 1) GET /health
 * Returns system health, provider specs, and memory cache stats.
 */
app.get('/health', (req, res) => {
  const startTime = Date.now();
  const namespace = 'server';
  dbg(namespace, 'GET /health');

  try {
    const providerInfo = openfreemap.getProviderInfo();
    const cacheStats = tileCache.getStats();

    const healthData = {
      status: 'healthy',
      version: '3.0.0',
      provider: providerInfo,
      cache: cacheStats
    };

    sendSuccess(res, namespace, healthData, startTime);
  } catch (err) {
    sendError(res, namespace, err);
  }
});

/**
 * 2) POST /vector-map
 * Orchestrates MVT decoding -> GeoJSON filtering -> Vector Alignment.
 */
app.post('/vector-map', async (req, res) => {
  const startTime = Date.now();
  const namespace = 'vector-map';
  dbg(namespace, 'POST /vector-map');

  try {
    const { bbox, zoom, width, height, style, layers, simplify, clip, limits } = req.body;

    const payload = await exportVector({
      provider: 'openfreemap',
      style: style || 'dark',
      bbox: bbox,
      zoom: zoom,
      width: width,
      height: height,
      layers: layers,
      simplify: simplify,
      clip: clip,
      limits: limits
    });

    const responseData = {
      metadata: payload.metadata,
      stats: payload.stats,
      waterRings: payload.waterRings,
      borderRings: payload.borderRings,
      riverLines: payload.riverLines,
      outputBounds: payload.outputBounds
    };

    sendSuccess(res, namespace, responseData, startTime);
  } catch (err) {
    sendError(res, namespace, err, 400);
  }
});

/**
 * 3) POST /raster-map
 * Orchestrates Raster Download -> Sharp Pipeline -> Output encoding.
 */
app.post('/raster-map', async (req, res) => {
  const startTime = Date.now();
  const namespace = 'raster-map';
  dbg(namespace, 'POST /raster-map');

  try {
    const { bbox, zoom, width, height, style, format, backgroundColor } = req.body;

    const exportResult = await exportRaster({
      provider: 'openfreemap',
      style: style || 'dark',
      bbox: bbox,
      zoom: zoom,
      width: width,
      height: height,
      format: format || 'png',
      backgroundColor: backgroundColor
    });

    // Convert binary buffer to Base64 payload for Phase 1 JSON transmission
    const imageBase64 = exportResult.buffer.toString('base64');

    const responseData = {
      image: imageBase64,
      width: exportResult.width,
      height: exportResult.height,
      bounds: exportResult.bbox,
      stats: exportResult.stats,
      metadata: exportResult.metadata
    };

    sendSuccess(res, namespace, responseData, startTime);
  } catch (err) {
    sendError(res, namespace, err, 400);
  }
});

/**
 * 4) POST /route
 * Generates Great Circle or straight IDL-safe paths for AE animations.
 */
app.post('/route', (req, res) => {
  const startTime = Date.now();
  const namespace = 'route';
  dbg(namespace, 'POST /route');

  try {
    const { start, end, routeType, width, height, bbox, simplify, smooth } = req.body;

    if (!start || !end) {
      throw new Error("Missing 'start' or 'end' coordinate objects.");
    }

    const routeData = buildRoute({
      points: [start, end],
      bbox: bbox,
      width: width,
      height: height,
      routeType: routeType,
      simplify: simplify,
      smooth: smooth
    });

    sendSuccess(res, namespace, routeData, startTime);
  } catch (err) {
    sendError(res, namespace, err, 400);
  }
});

/**
 * 5) GET /provider
 * Fetches provider capabilities and supported styles.
 */
app.get('/provider', (req, res) => {
  const startTime = Date.now();
  const namespace = 'provider';
  dbg(namespace, 'GET /provider');

  try {
    const providerInfo = openfreemap.getProviderInfo();
    sendSuccess(res, namespace, providerInfo, startTime);
  } catch (err) {
    sendError(res, namespace, err);
  }
});

/**
 * 6) GET /cache
 * Diagnostics for LRU memory management.
 */
app.get('/cache', (req, res) => {
  const startTime = Date.now();
  const namespace = 'cache';
  dbg(namespace, 'GET /cache');

  try {
    const stats = tileCache.getStats();
    sendSuccess(res, namespace, stats, startTime);
  } catch (err) {
    sendError(res, namespace, err);
  }
});

// ── Global Error Fallback ──────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  sendError(res, 'server', err, 500);
});

// ── Boot sequence ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  dbg('server', `Masar v3 Core API Online — Listening on Port ${PORT}`);
});
