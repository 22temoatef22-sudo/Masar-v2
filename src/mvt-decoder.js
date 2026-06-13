/**
 * Masar v2 — MVT Decoder
 * 
 * Discovers vector tile sources from OpenFreeMap style.json,
 * fetches .pbf tiles for a given bbox/zoom, decodes to GeoJSON.
 * 
 * Input:  { bbox: [west, south, east, north], zoom: number }
 * Output: GeoJSON FeatureCollection
 */

const { VectorTile } = require('@mapbox/vector-tile');
const Protobuf = require('pbf');
const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────────────────────

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ALLOWED_LAYERS = ['boundary', 'water', 'waterway'];
const MAX_TILES = 64; // safety cap — never fetch more than this

// Cache the resolved tile URL template so we don't re-fetch style.json every call
let _cachedTileURL = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ── Tile Math ──────────────────────────────────────────────────────────────────

/**
 * Convert lon/lat to tile x/y at a given zoom.
 */
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

/**
 * Calculate all tile coordinates that cover a bbox at a given zoom.
 * Returns array of { x, y, z }.
 */
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

  // Safety cap
  if (tiles.length > MAX_TILES) {
    console.warn(`[mvt-decoder] Tile count ${tiles.length} exceeds cap ${MAX_TILES}, truncating`);
    return tiles.slice(0, MAX_TILES);
  }

  return tiles;
}

// ── Style Discovery ────────────────────────────────────────────────────────────

/**
 * Fetch the OpenFreeMap style.json, find the first vector tile source,
 * and return its URL template (with {z}/{x}/{y} placeholders).
 */
async function discoverTileURL() {
  const now = Date.now();
  if (_cachedTileURL && now - _cacheTimestamp < CACHE_TTL) {
    return _cachedTileURL;
  }

  console.log('[mvt-decoder] Fetching style.json from', STYLE_URL);
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`Failed to fetch style.json: ${res.status}`);

  const style = await res.json();

  // Find the first "vector" type source
  const sources = style.sources || {};
  let tileURL = null;

  for (const [name, src] of Object.entries(sources)) {
    if (src.type === 'vector') {
      // Source may have tiles[] directly, or a url pointing to a TileJSON
      if (src.tiles && src.tiles.length > 0) {
        tileURL = src.tiles[0];
        console.log(`[mvt-decoder] Found tiles in source "${name}": ${tileURL}`);
        break;
      }
      if (src.url) {
        // Fetch TileJSON
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

/**
 * Convert a VectorTileFeature to a GeoJSON Feature.
 * VectorTileFeature.toGeoJSON(x, y, z) returns GeoJSON in EPSG:4326.
 */
function vtFeatureToGeoJSON(vtFeature, layerName, x, y, z) {
  const geojson = vtFeature.toGeoJSON(x, y, z);

  // Attach the source layer name and any useful properties
  geojson.properties = geojson.properties || {};
  geojson.properties._layer = layerName;

  return geojson;
}

/**
 * Fetch a single .pbf tile and decode it, extracting only ALLOWED_LAYERS.
 * Returns array of GeoJSON Features.
 */
async function fetchAndDecodeTile(tileURL, x, y, z) {
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
    if (res.status === 404) return []; // tile doesn't exist at this coord
    console.warn(`[mvt-decoder] HTTP ${res.status} for tile ${z}/${x}/${y}`);
    return [];
  }

  const buffer = await res.arrayBuffer();
  const pbf = new Protobuf(new Uint8Array(buffer));
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

  return features;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Decode MVT tiles for the given bbox and zoom level.
 * 
 * @param {number[]} bbox  — [west, south, east, north] in degrees
 * @param {number}   zoom  — map zoom level
 * @returns {Promise<Object>} GeoJSON FeatureCollection
 */
async function decodeMVT(bbox, zoom) {
  const tileURL = await discoverTileURL();
  const tiles = getTilesForBBox(bbox, zoom);

  console.log(`[mvt-decoder] Fetching ${tiles.length} tiles at z${Math.floor(zoom)} for bbox [${bbox.join(', ')}]`);

  // Fetch all tiles in parallel (with concurrency limit)
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
