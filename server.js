// Masar v2 Server — Node.js
// Handles: search, city-boundary, generate-map, finalize

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const sharp   = require("sharp");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");

const { search, getCityBoundary, loadAll, loadGeoData } = require("./src/geodata");
const { buildProjection, buildEquirectProjection, geometryToPixels, pointToPixel, getStylesList } = require("./src/renderer");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit:"50mb" }));
loadAll().catch(console.error);

// ── Health ─────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status:"ok", service:"Masar Server", version:"2.0.0" }));

// ── Search ─────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q||"").trim();
    if (!q || q.length < 2) return res.json({ results:[] });
    res.json({ results: await search(q) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── City boundary ──────────────────────────────────────────────
app.get("/city-boundary", async (req, res) => {
  try {
    const name = (req.query.name||"").trim();
    if (!name) return res.status(400).json({ error:"name required" });
    await new Promise(r => setTimeout(r, 1100));
    const boundary = await getCityBoundary(name);
    if (!boundary) return res.json({ found:false });
    res.json({ found:true, ...boundary });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Generate map (initial low-res tiles) ───────────────────────
app.post("/generate-map", async (req, res) => {
  try {
    const { state={}, bbox, layers=[], style="dark", width=8192, height=4096 } = req.body;
    console.log(`[Masar v2] generate-map — style:${style}, ${width}x${height}, ${layers.length} layers`);

    // Build projection
    const EQUIRECT_STYLES = ["satellite"];
    const projection = EQUIRECT_STYLES.includes(style)
      ? buildEquirectProjection(width, height)
      : buildProjection(bbox||{minLon:-180,maxLon:180,minLat:-85,maxLat:85}, width, height);

    // Fetch base map tiles
    const mapBuffer = await fetchBaseTiles(state, style, width, height);
    const base64 = mapBuffer ? mapBuffer.toString("base64") : null;

    // Convert geometries to pixel coords
    const pixelLayers = layers.map(layer => {
      const result = { id:layer.id, name:layer.name, type:layer.type, mode:layer.mode||"shape", color:layer.color };
      if (!layer.geometry) return result;
      if (layer.geometry.type==="Point" || layer.mode==="point") {
        const [x,y] = pointToPixel(layer.geometry, projection);
        result.pixelX=x; result.pixelY=y; result.geometryType="point";
      } else {
        result.rings = geometryToPixels(layer.geometry, projection, width, height);
        result.geometryType = layer.geometry.type.includes("Line") ? "line" : "polygon";
      }
      return result;
    });

    res.json({
      success:  true,
      map:      base64,
      metadata: { width, height, style, layers:pixelLayers, mapW:width, mapH:height },
    });
  } catch(e) {
    console.error("[Masar v2] generate-map error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ── Finalize (high-res tiles for each zoom level used) ─────────
app.post("/finalize", async (req, res) => {
  try {
    const { keyframes=[], style="dark", compW=3840, compH=2160 } = req.body;
    console.log(`[Masar v2] finalize — ${keyframes.length} keyframes, style:${style}`);

    if (!keyframes.length) return res.json({ success:false, error:"No keyframes" });

    // Get all unique zoom levels used
    const zoomLevels = [...new Set(keyframes.map(kf => Math.round(kf.state.zoom)))];
    console.log("[Masar v2] Zoom levels:", zoomLevels);

    const tiles = [];

    for (const zoom of zoomLevels) {
      // Find keyframes at this zoom level
      const kfsAtZoom = keyframes.filter(kf => Math.round(kf.state.zoom) === zoom);
      if (!kfsAtZoom.length) continue;

      // Get center point for this zoom level
      const kf = kfsAtZoom[Math.floor(kfsAtZoom.length/2)];
      const state = kf.state;

      // Fetch high-res tiles for this zoom level
      try {
        const tileBuf = await fetchBaseTiles(state, style, compW, compH, zoom);
        if (!tileBuf) continue;

        // Save tile to temp file
        const tilePath = path.join(os.tmpdir(), `masar2_tile_z${zoom}_${Date.now()}.png`);
        await fs.promises.writeFile(tilePath, tileBuf);

        // Calculate time range for this zoom level
        const inKf  = kfsAtZoom[0];
        const outKf = kfsAtZoom[kfsAtZoom.length-1];

        tiles.push({
          zoom,
          path:    tilePath,
          inTime:  inKf.time - 0.5,
          outTime: outKf.time + 0.5,
          center:  { lat:state.lat, lon:state.lon },
        });

        console.log(`[Masar v2] Tile Z${zoom} saved: ${tilePath}`);
      } catch(e) {
        console.error(`[Masar v2] Tile Z${zoom} failed:`, e.message);
      }
    }

    res.json({ success:true, metadata:{ tiles, zoomLevels } });
  } catch(e) {
    console.error("[Masar v2] finalize error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ── Tile fetching helpers ──────────────────────────────────────
const tileCache = {};

async function fetchTile(z, x, y, style) {
  const key = `${style}/${z}/${x}/${y}`;
  if (tileCache[key]) return tileCache[key];

  let url;
  if (style === "satellite") {
    url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  } else if (style === "topo") {
    url = `https://tile.opentopomap.org/${z}/${x}/${y}.png`;
  } else {
    // OpenFreeMap raster fallback
    url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }

  try {
    const res = await fetch(url, {
      timeout: 10000,
      headers: { "User-Agent": "MasarPlugin/2.0 (shuwaz.com)" }
    });
    if (!res.ok) return null;
    const buf = await res.buffer();
    tileCache[key] = buf;
    return buf;
  } catch(e) { return null; }
}

function lonToTileX(lon, z) { return Math.floor((lon+180)/360*Math.pow(2,z)); }
function latToTileY(lat, z) {
  const r = lat*Math.PI/180;
  return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z));
}
function tileXToLon(x, z) { return x/Math.pow(2,z)*360-180; }
function tileYToLat(y, z) {
  const n = Math.PI-2*Math.PI*y/Math.pow(2,z);
  return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));
}

function stateToZoomLevel(mapZoom) {
  // MapLibre zoom → tile zoom
  return Math.max(1, Math.min(18, Math.round(mapZoom)));
}

async function fetchBaseTiles(state, style, width, height, overrideZoom) {
  const lat  = state.lat  || 25;
  const lon  = state.lon  || 20;
  const zoom = overrideZoom !== undefined ? overrideZoom : stateToZoomLevel(state.zoom || 2);

  const TILE = 256;
  const tilesX = Math.ceil(width  / TILE) + 2;
  const tilesY = Math.ceil(height / TILE) + 2;

  const centerX = lonToTileX(lon, zoom);
  const centerY = latToTileY(lat, zoom);

  const startX = centerX - Math.floor(tilesX/2);
  const startY = centerY - Math.floor(tilesY/2);
  const endX   = startX + tilesX;
  const endY   = startY + tilesY;

  // Safety check — don't fetch too many tiles
  if ((endX-startX) * (endY-startY) > 64) {
    console.log("[Masar v2] Too many tiles, skipping");
    return null;
  }

  const { createCanvas, Image } = require("canvas");
  const canvas = createCanvas(tilesX*TILE, tilesY*TILE);
  const ctx    = canvas.getContext("2d");
  ctx.fillStyle = style === "dark" ? "#0a0a0a" : "#f0f0f0";
  ctx.fillRect(0, 0, tilesX*TILE, tilesY*TILE);

  let loaded = 0;
  const tasks = [];

  for (let tx = startX; tx < endX; tx++) {
    for (let ty = startY; ty < endY; ty++) {
      tasks.push((async (tx, ty) => {
        const buf = await fetchTile(zoom, tx, ty, style);
        if (!buf) return;
        try {
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload  = resolve;
            img.onerror = reject;
            img.src = buf;
          });
          const px = (tx - startX) * TILE;
          const py = (ty - startY) * TILE;
          ctx.drawImage(img, px, py);
          loaded++;
        } catch(e) {}
      })(tx, ty));
    }
  }

  await Promise.all(tasks);
  console.log(`[Masar v2] Loaded ${loaded}/${tasks.length} tiles at Z${zoom}`);

  if (loaded === 0) return null;

  // Crop to exact dimensions centered on target
  const centerPixelX = (centerX - startX) * TILE + TILE/2;
  const centerPixelY = (centerY - startY) * TILE + TILE/2;
  const cropX = Math.max(0, Math.round(centerPixelX - width/2));
  const cropY = Math.max(0, Math.round(centerPixelY - height/2));

  return sharp(canvas.toBuffer("image/png"))
    .extract({
      left:   Math.min(cropX, tilesX*TILE - width),
      top:    Math.min(cropY, tilesY*TILE - height),
      width:  Math.min(width,  tilesX*TILE),
      height: Math.min(height, tilesY*TILE),
    })
    .resize(width, height)
    .png()
    .toBuffer();
}

app.listen(PORT, () => console.log(`[Masar v2] Server running on port ${PORT}`));
