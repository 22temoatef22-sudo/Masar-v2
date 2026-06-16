/**
 * Masar v3 — Theme Configuration
 *
 * Maps Masar display theme names to:
 *   1. Provider style IDs (for vector tile decoding)
 *   2. Raster tile URL templates (for high-res raster export)
 *   3. MapLibre style URLs (for CEP panel preview)
 *   4. Paint override palettes (for AE solid colors)
 *
 * Pure data/config. No network calls. No provider logic.
 */

'use strict';

// ── Raster Tile URL Templates ─────────────────────────────────────────────────
//
// These are direct raster tile URLs used by the raster export pipeline.
// They bypass the OFM provider's getRasterTileURL() which only works
// for styles that have a raster source in their style.json.
//
// All URLs use {z}/{x}/{y} placeholders.
// All services below are free for reasonable usage.

const RASTER_TILES = {
  carto_dark:      'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  carto_light:     'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
  carto_voyager:   'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
  esri_satellite:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  opentopomap:     'https://tile.opentopomap.org/{z}/{x}/{y}.png',
};

// ── MapLibre Style URLs (for CEP panel preview) ───────────────────────────────

const MAPLIBRE_STYLES = {
  dark:       'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light:      'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  topo:       'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  neon:       'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',   // + neon paint overrides
  satellite:  null,  // raster-only, no vector style
  terrain:    null,  // raster-only
  watercolor: null,  // raster-only
  toner:      null,  // raster-only
};

// ── Theme → Provider Style Mapping (for vector export) ────────────────────────

const PROVIDER_STYLE_MAP = {
  dark:      { openfreemap: 'liberty',  maptiler: null, osm: null },
  light:     { openfreemap: 'positron', maptiler: null, osm: null },
  topo:      { openfreemap: 'liberty',  maptiler: null, osm: null },
  satellite: { openfreemap: 'liberty',  maptiler: null, osm: null },
  terrain:   { openfreemap: 'liberty',  maptiler: null, osm: null },
};

// ── Theme → Raster Tile URL Mapping ───────────────────────────────────────────

const THEME_RASTER_MAP = {
  dark:      RASTER_TILES.carto_dark,
  light:     RASTER_TILES.carto_light,
  topo:      RASTER_TILES.carto_voyager,
  satellite: RASTER_TILES.esri_satellite,
  terrain:   RASTER_TILES.opentopomap,
};

// ── Theme Palettes (for AE solid colors + vector overlays) ────────────────────

const THEME_PALETTES = {
  dark: {
    ocean:  '#080c14',
    land:   '#141c28',
    border: '#4a5a7a',
    water:  '#1a3050',
    river:  '#2a5a8a',
  },
  light: {
    ocean:  '#a8c8e8',
    land:   '#f0ede0',
    border: '#999999',
    water:  '#a8c8e8',
    river:  '#7cb4d4',
  },
  topo: {
    ocean:  '#7ba7bc',
    land:   '#d4c9a0',
    border: '#8b7040',
    water:  '#7ba7bc',
    river:  '#5a8fa8',
  },
  satellite: {
    ocean:  '#0a1a2a',
    land:   '#2a3a20',
    border: '#ffaa00',
    water:  '#0a1a2a',
    river:  '#1a4a6a',
  },
  terrain: {
    ocean:  '#7ba7bc',
    land:   '#c8c0a0',
    border: '#6a5a40',
    water:  '#7ba7bc',
    river:  '#5a8fa8',
  },
};

// ── Public API ─────────────────────────────────────────────────────────────────

function getThemeNames() {
  return Object.keys(THEME_RASTER_MAP);
}

function resolveProviderStyle(providerId, themeId) {
  var theme = PROVIDER_STYLE_MAP[themeId];
  if (!theme) {
    throw new Error('[themes] Unknown theme: "' + themeId + '". Known: ' + getThemeNames().join(', '));
  }
  var styleId = theme[providerId];
  if (!styleId) {
    throw new Error('[themes] Provider "' + providerId + '" has no mapping for theme "' + themeId + '"');
  }
  return styleId;
}

/**
 * Get the direct raster tile URL template for a Masar theme.
 * This bypasses the provider's getRasterTileURL() for guaranteed results.
 *
 * @param {string} themeId
 * @returns {string} URL template with {z}/{x}/{y}
 */
function getRasterTileURL(themeId) {
  var url = THEME_RASTER_MAP[themeId];
  if (!url) {
    // Fallback to CartoDB voyager
    return RASTER_TILES.carto_voyager;
  }
  return url;
}

/**
 * Get the MapLibre style URL for the CEP panel preview.
 * Returns null for raster-only themes.
 *
 * @param {string} themeId
 * @returns {string|null}
 */
function getMapLibreStyleURL(themeId) {
  return MAPLIBRE_STYLES[themeId] || null;
}

function getPalette(themeId) {
  if (!(themeId in THEME_PALETTES)) {
    throw new Error('[themes] Unknown theme: "' + themeId + '"');
  }
  return THEME_PALETTES[themeId];
}

function hasCustomPalette(themeId) {
  return THEME_PALETTES[themeId] !== null && THEME_PALETTES[themeId] !== undefined;
}

module.exports = {
  getThemeNames,
  resolveProviderStyle,
  getRasterTileURL,
  getMapLibreStyleURL,
  getPalette,
  hasCustomPalette,
  RASTER_TILES,
};
