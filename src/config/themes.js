/**
 * Masar v3 — Theme Configuration
 *
 * Maps Masar display theme names to provider style IDs and paint override palettes.
 * This is a pure data/config file. No network calls. No provider logic.
 *
 * Usage:
 *   const themes = require('./config/themes');
 *   const ofmStyleId = themes.resolveProviderStyle('openfreemap', 'dark');
 *   const palette    = themes.getPalette('dark');
 */

// ── Theme → Provider Style Mapping ────────────────────────────────────────────

// Maps a Masar theme name to the native style ID for each provider.
// Add a new provider column here when MapTiler / OSM support is added.
const PROVIDER_STYLE_MAP = {
  dark:     { openfreemap: 'liberty',  maptiler: null, osm: null },
  light:    { openfreemap: 'positron', maptiler: null, osm: null },
  liberty:  { openfreemap: 'liberty',  maptiler: null, osm: null },
  topo:     { openfreemap: 'liberty',  maptiler: null, osm: null },
  bright:   { openfreemap: 'bright',   maptiler: null, osm: null },
  positron: { openfreemap: 'positron', maptiler: null, osm: null },
};

// ── Theme Palettes (Paint Overrides) ──────────────────────────────────────────

// Masar-specific color palettes applied on top of the base provider style.
// The preview engine uses these for MapLibre paint mutations.
// The export engine uses them for AE solid layer colors.
// null = use the provider's native palette without modification.
const THEME_PALETTES = {
  dark: {
    ocean:  '#080c14',
    land:   '#141c28',
    border: '#2a3550',
    water:  '#0d1520',
    river:  '#1a2a40',
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
  liberty:  null,
  bright:   null,
  positron: null,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get all known Masar theme names.
 * @returns {string[]}
 */
function getThemeNames() {
  return Object.keys(PROVIDER_STYLE_MAP);
}

/**
 * Translate a Masar theme name to a provider-native style ID.
 *
 * @param {string} providerId — e.g. 'openfreemap'
 * @param {string} themeId    — e.g. 'dark'
 * @returns {string} provider-native style ID
 * @throws if theme is unknown or provider has no mapping for it
 */
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
 * Get the paint override palette for a Masar theme.
 * Returns null for themes that use the provider's native palette.
 *
 * @param {string} themeId
 * @returns {Object|null}
 */
function getPalette(themeId) {
  if (!(themeId in THEME_PALETTES)) {
    throw new Error('[themes] Unknown theme: "' + themeId + '"');
  }
  return THEME_PALETTES[themeId];
}

/**
 * Return true if this theme applies custom paint overrides.
 * @param {string} themeId
 * @returns {boolean}
 */
function hasCustomPalette(themeId) {
  return THEME_PALETTES[themeId] !== null && THEME_PALETTES[themeId] !== undefined;
}

module.exports = {
  getThemeNames,
  resolveProviderStyle,
  getPalette,
  hasCustomPalette,
};
