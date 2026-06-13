// Masar v2 Server — Full World Architecture
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const sharp   = require("sharp");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");

const { search, getCityBoundary, loadAll, loadGeoData } = require("./src/geodata");
const { buildProjection, geometryToPixels, pointToPixel, renderBaseMap } = require("./src/renderer");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit:"50mb" }));
loadAll().catch(console.error);

app.get("/", (req, res) => res.json({ status:"ok", service:"Masar v2 Server", version:"3.0.0" }));

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q||"").trim();
    if (!q||q.length<2) return res.json({ results:[] });
    res.json({ results: await search(q) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

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

app.post("/generate-map", async (req, res) => {
  try {
    // نتجاهل الأبعاد القادمة من الواجهة ونفرض خريطة العالم الكاملة
    const { state={}, layers=[], style="dark" } = req.body;
    
    // إحداثيات خريطة العالم المربعة (Web Mercator Standard)
    const FULL_WORLD_BBOX = { minLon: -180, maxLon: 180, minLat: -85.05112878, maxLat: 85.05112878 };
    const MAP_SIZE = 2048; // سريع جداً ليكون Base Map

    console.log(`[Masar v2] generate-map — FULL WORLD mode, style:${style}`);

    const projection = buildProjection(FULL_WORLD_BBOX, MAP_SIZE, MAP_SIZE);
    const world = await loadGeoData("countries");
    const mapBuffer = await renderBaseMap(world, FULL_WORLD_BBOX, { width: MAP_SIZE, height: MAP_SIZE, style, projection });
    const base64 = mapBuffer.toString("base64");

    const pixelLayers = layers.map(layer => {
      const result = { id:layer.id, name:layer.name, type:layer.type, mode:layer.mode||"shape", color:layer.color||"#f97316" };
      if (!layer.geometry) return result;
      if (layer.geometry.type==="Point" || layer.mode==="point") {
        const [x,y] = pointToPixel(layer.geometry, projection);
        result.pixelX=x; result.pixelY=y; result.geometryType="point";
      } else {
        result.rings = geometryToPixels(layer.geometry, projection, MAP_SIZE, MAP_SIZE);
        result.geometryType = layer.geometry.type.includes("Line") ? "line" : "polygon";
      }
      return result;
    });

    // إرسال الـ state مهم جداً لمحرك الـ Expressions القادم
    res.json({ 
      success:true, map:base64, 
      metadata:{ mapW:MAP_SIZE, mapH:MAP_SIZE, style, layers:pixelLayers, state:state } 
    });
  } catch(e) {
    console.error("[Masar v2] generate-map error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ── منطق Finalize المحدث لدعم No Labels لجميع الأساليب ──
const TILE_PROVIDERS_NOLABELS = {
  "dark":           "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "light":          "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "topo":           "https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}",
  "satellite":      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
};

const tileCache = {};
async function fetchTile(url) {
  if (tileCache[url]) return tileCache[url];
  try {
    const res = await fetch(url, { timeout:8000 });
    if (!res.ok) return null;
    const buf = await res.buffer();
    tileCache[url] = buf;
    return buf;
  } catch(e) { return null; }
}

function lonToTileX(lon,z){ return Math.floor((lon+180)/360*Math.pow(2,z)); }
function latToTileY(lat,z){ const r=lat*Math.PI/180; return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z)); }

async function fetchFinalizeTiles(lat, lon, zoom, width, height, style) {
  const TILE=256;
  const cx=lonToTileX(lon,zoom), cy=latToTileY(lat,zoom);
  const tw=Math.ceil(width/TILE)+2, th=Math.ceil(height/TILE)+2;
  const x0=cx-Math.floor(tw/2), y0=cy-Math.floor(th/2);

  if (tw*th > 36) return null;

  const template = TILE_PROVIDERS_NOLABELS[style] || TILE_PROVIDERS_NOLABELS["dark"];
  const { createCanvas, Image } = require("canvas");
  const canvas=createCanvas(tw*TILE,th*TILE), ctx=canvas.getContext("2d");
  ctx.fillStyle="#000"; ctx.fillRect(0,0,tw*TILE,th*TILE);

  let loaded=0;
  await Promise.all(Array.from({length:tw*th},(_,i)=>{
    const tx=x0+Math.floor(i/th), ty=y0+(i%th);
    return (async()=>{
      const url = template.replace("{z}", zoom).replace("{x}", tx).replace("{y}", ty);
      const buf = await fetchTile(url); if(!buf) return;
      try {
        const img=new Image();
        await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=buf;});
        ctx.drawImage(img,(tx-x0)*TILE,(ty-y0)*TILE); loaded++;
      } catch(e){}
    })();
  }));

  if (loaded===0) return null;

  const px=Math.max(0,(cx-x0)*TILE+TILE/2-width/2);
  const py=Math.max(0,(cy-y0)*TILE+TILE/2-height/2);
  return sharp(canvas.toBuffer("image/png"))
    .extract({left:Math.round(px),top:Math.round(py),width:Math.min(width,tw*TILE),height:Math.min(height,th*TILE)})
    .resize(width,height).png().toBuffer();
}

app.post("/finalize", async (req, res) => {
  try {
    let { keyframes=[], style="dark", compW=3840, compH=2160 } = req.body;
    const styleMap = { "positron":"light", "liberty":"light", "voyager":"topo", "satellite-film":"satellite" };
    style = styleMap[style] || style;
    
    if (!keyframes.length) return res.json({ success:false, error:"No keyframes" });
    const zoomLevels = [...new Set(keyframes.map(kf => Math.round(kf.state.zoom||2)))];
    const tiles = [];

    for (const zoom of zoomLevels) {
      const kfsAtZoom = keyframes.filter(kf => Math.round(kf.state.zoom||2) === zoom);
      const kf = kfsAtZoom[Math.floor(kfsAtZoom.length/2)];

      try {
        const tileBuf = await fetchFinalizeTiles(kf.state.lat||25, kf.state.lon||30, zoom, compW, compH, style);
        if (tileBuf) {
          const tilePath = path.join(os.tmpdir(), `masar2_tile_z${zoom}_${Date.now()}.png`);
          await fs.promises.writeFile(tilePath, tileBuf);
          const inKf  = kfsAtZoom[0], outKf = kfsAtZoom[kfsAtZoom.length-1];
          tiles.push({ zoom, path:tilePath, inTime:inKf.time-0.5, outTime:outKf.time+0.5 });
        }
      } catch(e) { console.error(`[Masar v2] Tile Z${zoom} failed:`, e.message); }
    }
    res.json({ success:true, metadata:{ tiles, zoomLevels } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`[Masar v2] Server v3.0 running on port ${PORT}`));
