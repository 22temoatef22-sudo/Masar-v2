/**
 * Masar v2 — MVT Decoder
 * * Discovers vector tile sources from OpenFreeMap style.json,
 * fetches .pbf tiles for a given bbox/zoom, decodes to GeoJSON.
 */

const { VectorTile } = require('@mapbox/vector-tile');
const Protobuf = require('pbf');
const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────────────────────

// ✅ تم تصحيح الرابط ليشير إلى ملف style.json مباشرة
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty/style.json';
const ALLOWED_LAYERS = ['boundary', 'water', 'waterway'];
const MAX_TILES = 64; 

let _cachedTileURL = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; 

const tileCache = new Map();
const MAX_CACHE_SIZE = 200;

// ── Tile Math ──────────────────────────────────────────────────────────────────

function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function getTilesForBBox(bbox, zoom) {
  const [west, south, east, north] = bbox;
  const z = Math.floor(zoom);

  const topLeft = lonLatToTile(west, north, z);
  const bottomRight = lonLatToTile(east, south, z);

  const tiles = [];
  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) {
      tiles.push({ x, y, z });
    }
  }

  if (tiles.length > MAX_TILES) {
    console.warn(`[mvt-decoder] Tile count ${tiles.length} exceeds cap ${MAX_TILES}, truncating`);
    return tiles.slice(0, MAX_TILES);
  }

  return tiles;
}

// ── Style Discovery ────────────────────────────────────────────────────────────

async function discoverTileURL() {
  const now = Date.now();
  if (_cachedTileURL && now - _cacheTimestamp < CACHE_TTL) {
    return _cachedTileURL;
  }

  console.log('[mvt-decoder] Fetching style.json from', STYLE_URL);
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`Failed to fetch style.json: ${res.status}`);

  const style = await res.json();
  const sources = style.sources || {};
  let tileURL = null;

  for (const [name, src] of Object.entries(sources)) {
    if (src.type === 'vector') {
      if (src.tiles && src.tiles.length > 0) {
        tileURL = src.tiles[0];
        console.log(`[mvt-decoder] Found tiles in source "${name}": ${tileURL}`);
        break;
      }
      if (src.url) {
        const tjRes = await fetch(src.url);
        if (tjRes.ok) {
          const tj = await tjRes.json();
          if (tj.tiles && tj.tiles.length > 0) {
            tileURL = tj.tiles[0];
            console.log(`[mvt-decoder] Found tiles via TileJSON "${name}": ${tileURL}`);
            break;
          }
        }
      }
    }
  }

  if (!tileURL) {
    throw new Error('No vector tile source found in style.json');
  }

  _cachedTileURL = tileURL;
  _cacheTimestamp = now;
  return tileURL;
}

// ── MVT Decoding ───────────────────────────────────────────────────────────────

function vtFeatureToGeoJSON(vtFeature, layerName, x, y, z) {
  const geojson = vtFeature.toGeoJSON(x, y, z);
  geojson.properties = geojson.properties || {};
  geojson.properties._layer = layerName;
  return geojson;
}

async function fetchAndDecodeTile(tileURL, x, y, z) {
  const cacheKey = `${tileURL}|${z}/${x}/${y}`;

  if (tileCache.has(cacheKey)) {
    console.log("[cache] hit", cacheKey);
    const cachedData = tileCache.get(cacheKey);
    tileCache.delete(cacheKey);
    tileCache.set(cacheKey, cachedData);
    return cachedData;
  }

  console.log("[cache] miss", cacheKey);

  const url = tileURL
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.warn(`[mvt-decoder] Network error fetching tile ${z}/${x}/${y}: ${err.message}`);
    return [];
  }

  if (!res.ok) {
    if (res.status === 404) return []; 
    console.warn(`[mvt-decoder] HTTP ${res.status} for tile ${z}/${x}/${y}`);
    return [];
  }

  const buffer = await res.arrayBuffer();
  
  // ✅ حل مشكلة Protobuf is not a constructor
  const PbfConstructor = Protobuf.default || Protobuf;
  const pbf = new PbfConstructor(new Uint8Array(buffer));
  const vt = new VectorTile(pbf);

  const features = [];

  for (const layerName of ALLOWED_LAYERS) {
    const layer = vt.layers[layerName];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const vtFeature = layer.feature(i);
      const geojson = vtFeatureToGeoJSON(vtFeature, layerName, x, y, z);
      features.push(geojson);
    }
  }

  if (tileCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = tileCache.keys().next().value;
    tileCache.delete(oldestKey);
  }

  tileCache.set(cacheKey, features);
  return features;
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function decodeMVT(bbox, zoom) {
  const tileURL = await discoverTileURL();
  const tiles = getTilesForBBox(bbox, zoom);

  console.log(`[mvt-decoder] Fetching ${tiles.length} tiles at z${Math.floor(zoom)} for bbox [${bbox.join(', ')}]`);

  const CONCURRENCY = 8;
  const allFeatures = [];

  for (let i = 0; i < tiles.length; i += CONCURRENCY) {
    const batch = tiles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(t => fetchAndDecodeTile(tileURL, t.x, t.y, t.z))
    );
    for (const feats of results) {
      allFeatures.push(...feats);
    }
  }

  console.log(`[mvt-decoder] Decoded ${allFeatures.length} features total`);

  return {
    type: 'FeatureCollection',
    features: allFeatures,
  };
}

module.exports = { decodeMVT, getTilesForBBox, discoverTileURL };
