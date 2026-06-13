// renderer.js — GEOlayers Architecture (Full World, No Labels)
const { createCanvas } = require("canvas");
const { geoMercator, geoEquirectangular, geoPath, geoGraticule } = require("d3-geo");
const sharp = require("sharp");
const fetch = require("node-fetch");

// 1. قوالب خوادم الخرائط (بدون نصوص - No Labels) لضمان فصل الطبقات
const TILE_PROVIDERS = {
  "dark":           "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "dark-pro":       "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "light":          "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "positron":       "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "liberty":        "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "voyager":        "https://basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png",
  "political":      "https://basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png",
  "topo":           "https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}",
  "terrain":        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}",
  "satellite":      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "satellite-film": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
};

const STYLES_CONFIG = {
  "dark": { ocean:"#080c14", land:"#141c28", border:"#2a3550" },
  "satellite-film": { vignette:true, vignetteColor:"#000000", vignetteStrength:0.6, grain:true, grainStrength:0.02 }
};

// 2. بناء الإسقاط الهندسي الكامل لخريطة العالم كـ "مربع"
function buildProjection(bbox, width, height) {
  // بما أننا نطلب خريطة العالم الكاملة، لا نحتاج إلى قص fitExtent
  return geoMercator()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
}

function buildEquirectProjection(width, height) {
  return geoEquirectangular().scale(width / (2 * Math.PI)).translate([width / 2, height / 2]);
}

const tileCache = {};
async function fetchTileByUrl(url, timeout = 8000) {
  if (tileCache[url]) return tileCache[url];
  try {
    const res = await fetch(url, { timeout });
    if (!res.ok) return null;
    const buf = await res.buffer();
    tileCache[url] = buf;
    return buf;
  } catch(e) { return null; }
}

function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function tileYToLat(y, z) { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }

function calcZoom(bbox) { 
  const r = Math.max(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat); 
  if (r > 300) return 3; // الزووم المثالي لخريطة العالم الكاملة 2048x2048
  if (r > 80) return 4; if (r > 40) return 5; if (r > 20) return 6; 
  if (r > 10) return 7; if (r > 5)  return 8; if (r > 2)  return 9; 
  return 10; 
}

async function stitchMapTiles(bbox, width, height, styleKey) {
  const template = TILE_PROVIDERS[styleKey] || TILE_PROVIDERS["dark"];
  const zoom = calcZoom(bbox);
  
  const x0 = lonToTileX(bbox.minLon, zoom), x1 = lonToTileX(bbox.maxLon, zoom);
  const y0 = latToTileY(bbox.maxLat, zoom), y1 = latToTileY(bbox.minLat, zoom);
  const TILE = 256, tw = x1 - x0 + 1, th = y1 - y0 + 1;

  if (tw > 16 || th > 16) return null;

  const canvas = createCanvas(tw * TILE, th * TILE);
  const ctx = canvas.getContext("2d");
  let loaded = 0;
  const tasks = [];

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tasks.push((async (tx, ty) => {
        const tileUrl = template.replace("{z}", zoom).replace("{x}", tx).replace("{y}", ty);
        const buf = await fetchTileByUrl(tileUrl);
        if (!buf) return;
        try {
          const { Image } = require("canvas");
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = buf; });
          ctx.drawImage(img, (tx - x0) * TILE, (ty - y0) * TILE);
          loaded++;
        } catch(e) {}
      })(tx, ty));
    }
  }

  await Promise.all(tasks);
  if (loaded === 0) return null;

  const tLonR = tileXToLon(x1 + 1, zoom) - tileXToLon(x0, zoom);
  const tLatR = tileYToLat(y0, zoom) - tileYToLat(y1 + 1, zoom);
  const cX = Math.max(0, Math.floor((bbox.minLon - tileXToLon(x0, zoom)) / tLonR * tw * TILE));
  const cY = Math.max(0, Math.floor((tileYToLat(y0, zoom) - bbox.maxLat) / tLatR * th * TILE));
  const cW = Math.max(1, Math.floor((bbox.maxLon - bbox.minLon) / tLonR * tw * TILE));
  const cH = Math.max(1, Math.floor((bbox.maxLat - bbox.minLat) / tLatR * th * TILE));

  return sharp(canvas.toBuffer("image/png")).extract({ left: cX, top: cY, width: cW, height: cH }).resize(width, height).png().toBuffer();
}

async function renderD3Fallback(world, width, height, styleKey, projection) {
  const cfg = STYLES_CONFIG[styleKey] || STYLES_CONFIG["dark"];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const pathFn = geoPath(projection, ctx);
  ctx.fillStyle = cfg.ocean || "#080c14"; ctx.fillRect(0, 0, width, height);
  for (const f of world.features) {
    ctx.beginPath(); pathFn(f);
    ctx.fillStyle = cfg.land || "#141c28"; ctx.fill();
    ctx.strokeStyle = cfg.border || "#2a3550"; ctx.lineWidth = 0.6; ctx.stroke();
  }
  return canvas.toBuffer("image/png");
}

async function renderBaseMap(world, bbox, options={}) {
  const { width=2048, height=2048, style="dark", projection: existingProj } = options;
  const projection = existingProj || buildProjection(bbox, width, height);
  try {
    const tileBuf = await stitchMapTiles(bbox, width, height, style);
    if (tileBuf) return tileBuf;
  } catch(e) { console.log("[Renderer] Fallback to D3"); }
  return renderD3Fallback(world, width, height, style, projection);
}

function geometryToPixels(geometry, projection, compW, compH) {
  const rings = [];
  const toAE = ([lon, lat]) => { const [x, y] = projection([lon, lat]); return [x - compW/2, y - compH/2]; };
  if (geometry.type === "Polygon") rings.push(geometry.coordinates[0].map(toAE));
  else if (geometry.type === "MultiPolygon") for(const p of geometry.coordinates) rings.push(p[0].map(toAE));
  else if (geometry.type === "LineString") rings.push(geometry.coordinates.map(toAE));
  else if (geometry.type === "MultiLineString") for(const l of geometry.coordinates) rings.push(l.map(toAE));
  return rings;
}
function pointToPixel(geometry, projection) { return projection(geometry.coordinates); }
function getStylesList() { return Object.keys(TILE_PROVIDERS).map(key => ({ key, name: key })); }

module.exports = { renderBaseMap, buildProjection, buildEquirectProjection, geometryToPixels, pointToPixel, getStylesList };
