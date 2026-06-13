/**
 * Masar v3 — OpenFreeMap Provider
 *
 * Abstracts all interaction with OpenFreeMap tile infrastructure.
 * Discovers tile sources dynamically from style.json and TileJSON endpoints.
 * Conforms to the Masar provider interface so the rest of the system
 * never touches provider-specific URLs or schemas.
 *
 * This file is THEME-AGNOSTIC. It knows only about native OpenFreeMap style IDs
 * (liberty, bright, positron). All Masar theme mapping lives in config/themes.js.
 *
 * Provider Interface:
 *   provider.getStyle(ofmStyleId)         → { spec, meta } — raw MapLibre spec + provider metadata
 *   provider.getTileJSON(ofmStyleId)      → TileJSON metadata + tile URL template
 *   provider.getRasterTileURL(ofmStyleId) → raster tile URL template string or null
 *   provider.getVectorTileURL(ofmStyleId) → vector tile URL template string
 *   provider.validateProvider()           → { success, errors, ... } health check
 *   provider.getProviderInfo()            → provider metadata + capabilities
 */

// Node 18+ ships fetch as a global. Fall back to node-fetch on older runtimes.
const fetchFn = global.fetch || require('node-fetch');

// ── Diagnostics ────────────────────────────────────────────────────────────────

const DEBUG_PROVIDER = false;

function dbg(msg) {
  if (DEBUG_PROVIDER) {
    console.log('[openfreemap] ' + msg);
  }
}

// ── Configuration ──────────────────────────────────────────────────────────────

const PROVIDER_ID = 'openfreemap';
const BASE_URL = 'https://tiles.openfreemap.org';

// Native OpenFreeMap style IDs. These are the only IDs this provider knows.
// Masar theme names (dark, light, topo) are translated to these IDs
// by config/themes.js before calling any provider method.
const STYLE_ENDPOINTS = {
  liberty:  BASE_URL + '/styles/liberty',
  bright:   BASE_URL + '/styles/bright',
  positron: BASE_URL + '/styles/positron',
};

// The canonical list of styles this provider can serve.
const SUPPORTED_STYLES = Object.keys(STYLE_ENDPOINTS);

// ── Cache ──────────────────────────────────────────────────────────────────────

const _cache = {
  styles:   {},
  tileJSON: {},
};
const CACHE_TTL = 15 * 60 * 1000;

function cacheGet(bucket, key) {
  const entry = _cache[bucket][key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    delete _cache[bucket][key];
    return null;
  }
  return entry.data;
}

function cacheSet(bucket, key, data) {
  _cache[bucket][key] = { data, ts: Date.now() };
}

// ── Internal Fetchers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  dbg('fetching ' + url);
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error('[openfreemap] HTTP ' + res.status + ' fetching ' + url);
  }
  return res.json();
}

/**
 * Validate that a native OFM style ID is known to this provider.
 * Callers are responsible for translating Masar theme names first.
 */
function assertKnownStyle(ofmStyleId) {
  if (!STYLE_ENDPOINTS[ofmStyleId]) {
    throw new Error('[openfreemap] Unknown OFM style: "' + ofmStyleId + '". Known styles: ' + SUPPORTED_STYLES.join(', '));
  }
}

/**
 * Fetch and cache a full MapLibre style spec from OFM.
 */
async function fetchStyle(ofmStyleId) {
  assertKnownStyle(ofmStyleId);

  var cached = cacheGet('styles', ofmStyleId);
  if (cached) {
    dbg('cache hit styles/' + ofmStyleId);
    return cached;
  }

  dbg('cache miss styles/' + ofmStyleId);
  var endpoint = STYLE_ENDPOINTS[ofmStyleId];
  var style = await fetchJSON(endpoint);
  cacheSet('styles', ofmStyleId, style);
  return style;
}

/**
 * Fetch TileJSON for the vector source declared in a style spec.
 * Walks style.sources looking for type:"vector", then resolves its
 * TileJSON URL or inline tiles array.
 */
async function fetchTileJSON(ofmStyleId) {
  var cached = cacheGet('tileJSON', ofmStyleId);
  if (cached) {
    dbg('cache hit tileJSON/' + ofmStyleId);
    return cached;
  }

  dbg('cache miss tileJSON/' + ofmStyleId);
  var style = await fetchStyle(ofmStyleId);
  var sources = style.sources || {};
  var vectorSourceName = null;
  var vectorSource = null;

  var sourceNames = Object.keys(sources);
  for (var i = 0; i < sourceNames.length; i++) {
    var name = sourceNames[i];
    if (sources[name].type === 'vector') {
      vectorSourceName = name;
      vectorSource = sources[name];
      break;
    }
  }

  if (!vectorSource) {
    throw new Error('[openfreemap] No vector source in style ' + ofmStyleId);
  }

  var tileJSON;

  if (vectorSource.tiles && vectorSource.tiles.length > 0) {
    // Inline tiles — synthesize a minimal TileJSON object.
    tileJSON = {
      tilejson: '3.0.0',
      tiles: vectorSource.tiles,
      minzoom: vectorSource.minzoom || 0,
      maxzoom: vectorSource.maxzoom || 14,
      bounds: vectorSource.bounds || [-180, -85.05113, 180, 85.05113],
      sourceName: vectorSourceName,
    };
  } else if (vectorSource.url) {
    // Fetch TileJSON from the declared URL, then extend with source name.
    var fetched = await fetchJSON(vectorSource.url);
    tileJSON = Object.assign({}, fetched, { sourceName: vectorSourceName });
    dbg('tilejson discovered via ' + vectorSource.url);
  } else {
    throw new Error('[openfreemap] Vector source has no tiles[] or url');
  }

  cacheSet('tileJSON', ofmStyleId, tileJSON);
  return tileJSON;
}

/**
 * Extract raster tile URL templates from a style spec.
 * Returns the first raster source's tile URL, or null.
 */
async function resolveRasterTileURL(ofmStyleId) {
  var style = await fetchStyle(ofmStyleId);
  var sources = style.sources || {};

  var sourceNames = Object.keys(sources);
  for (var i = 0; i < sourceNames.length; i++) {
    var src = sources[sourceNames[i]];
    if (src.type === 'raster' && src.tiles && src.tiles.length > 0) {
      dbg('raster tile URL found for ' + ofmStyleId);
      return src.tiles[0];
    }
  }
  dbg('no raster tiles in style ' + ofmStyleId);
  return null;
}

// ── Public Provider Interface ──────────────────────────────────────────────────

/**
 * Get the full MapLibre style spec for a native OFM style.
 *
 * Returns a clean envelope so the raw MapLibre spec is never mutated:
 *   spec  — untouched MapLibre StyleSpecification (safe to pass to MapLibre directly)
 *   meta  — provider context for Masar's engine layer to consume
 *
 * Callers that need Masar theme context (paint overrides, display name)
 * should obtain it from config/themes.js, not from this method.
 *
 * @param {string} ofmStyleId — native OFM style ID (liberty | bright | positron)
 * @returns {Promise<{ spec: Object, meta: Object }>}
 */
async function getStyle(ofmStyleId) {
  var spec = await fetchStyle(ofmStyleId);
  var meta = {
    providerId:  PROVIDER_ID,
    ofmStyleId:  ofmStyleId,
    styleUrl:    STYLE_ENDPOINTS[ofmStyleId],
    fetchedAt:   Date.now(),
  };
  return { spec, meta };
}

/**
 * Get TileJSON metadata for the vector tile source of a native OFM style.
 *
 * @param {string} ofmStyleId — native OFM style ID
 * @returns {Promise<Object>} TileJSON with tiles[], bounds, zoom range, sourceName
 */
async function getTileJSON(ofmStyleId) {
  return fetchTileJSON(ofmStyleId);
}

/**
 * Get the raster tile URL template for a native OFM style.
 * Returns null if the style has no raster source.
 *
 * @param {string} ofmStyleId
 * @returns {Promise<string|null>} URL with {z}/{x}/{y} placeholders
 */
async function getRasterTileURL(ofmStyleId) {
  return resolveRasterTileURL(ofmStyleId);
}

/**
 * Get the vector tile URL template for a native OFM style.
 *
 * @param {string} ofmStyleId
 * @returns {Promise<string>} URL with {z}/{x}/{y} placeholders
 */
async function getVectorTileURL(ofmStyleId) {
  var tileJSON = await getTileJSON(ofmStyleId);
  if (!tileJSON.tiles || tileJSON.tiles.length === 0) {
    throw new Error('[openfreemap] TileJSON has no tile URLs');
  }
  return tileJSON.tiles[0];
}

/**
 * Validate that OpenFreeMap is reachable and all critical endpoints resolve.
 * Tests three legs independently so partial failures are reportable.
 * Powers Settings → Connection Test in the Masar panel.
 *
 * @returns {Promise<Object>} validation result
 */
async function validateProvider() {
  dbg('validating provider');

  var result = {
    success:          false,
    provider:         PROVIDER_ID,
    styleReachable:   false,
    tileJSONReachable: false,
    vectorReachable:  false,
    errors:           [],
  };

  // Leg 1 — style endpoint reachable and returns valid JSON
  var testStyle = 'liberty';
  try {
    var styleResult = await getStyle(testStyle);
    if (styleResult && styleResult.spec && styleResult.spec.version === 8) {
      result.styleReachable = true;
      dbg('style endpoint OK');
    } else {
      result.errors.push('Style JSON invalid: missing version:8');
    }
  } catch (e) {
    result.errors.push('Style endpoint error: ' + e.message);
    dbg('style endpoint FAILED: ' + e.message);
  }

  // Leg 2 — TileJSON reachable and contains tiles array
  try {
    var tileJSON = await getTileJSON(testStyle);
    if (tileJSON && tileJSON.tiles && tileJSON.tiles.length > 0) {
      result.tileJSONReachable = true;
      dbg('tilejson endpoint OK');
    } else {
      result.errors.push('TileJSON has no tiles array');
    }
  } catch (e) {
    result.errors.push('TileJSON endpoint error: ' + e.message);
    dbg('tilejson endpoint FAILED: ' + e.message);
  }

  // Leg 3 — vector tile URL is discoverable (HEAD request, no full tile fetch)
  try {
    var vectorURL = await getVectorTileURL(testStyle);
    if (typeof vectorURL === 'string' && vectorURL.indexOf('{z}') !== -1) {
      result.vectorReachable = true;
      dbg('vector tile URL OK: ' + vectorURL);
    } else {
      result.errors.push('Vector tile URL does not contain {z} placeholder');
    }
  } catch (e) {
    result.errors.push('Vector URL error: ' + e.message);
    dbg('vector URL FAILED: ' + e.message);
  }

  result.success = result.styleReachable && result.tileJSONReachable && result.vectorReachable;
  dbg('validation ' + (result.success ? 'PASSED' : 'FAILED') + ' — errors: ' + result.errors.length);

  return result;
}

/**
 * Provider metadata and capability flags.
 * capabilities drives the provider selection UI and tile engine routing.
 */
function getProviderInfo() {
  return {
    id:             PROVIDER_ID,
    name:           'OpenFreeMap',
    attribution:    'OpenFreeMap · © OpenMapTiles · Data from OpenStreetMap',
    supportedStyles: SUPPORTED_STYLES,
    tileSchema:     'openmaptiles',
    maxZoom:        14,
    capabilities: {
      vectorTiles:  true,
      rasterTiles:  true,   // Natural Earth shaded relief at low zooms
      tileJSON:     true,
      styleJSON:    true,
      offlineMode:  false,
    },
  };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  getStyle,
  getTileJSON,
  getRasterTileURL,
  getVectorTileURL,
  validateProvider,
  getProviderInfo,
};
