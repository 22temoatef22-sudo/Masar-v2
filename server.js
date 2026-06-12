// Masar v2 Server — Fixed
// Base map via D3 (reliable) + tile fetching for finalize

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const sharp   = require("sharp");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");

const { search, getCityBoundary, loadAll, loadGeoData } = require("./src/geodata");
const { buildProjection, buildEquirectProjection, geometryToPixels, pointToPixel, renderBaseMap } = require("./src/renderer");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit:"50mb" }));
loadAll().catch(console.error);

app.get("/", (req, res) => res.json({ status:"ok", service:"Masar v2 Server", version:"2.1.0" }));

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

const EQUIRECT_STYLES = ["satellite", "satellite-film"];

app.post("/generate-map", async (req, res) => {
  try {
    const { state={}, bbox, layers=[], style="dark", width=8192, height=4096 } = req.body;
    console.log(`[Masar v2] generate-map — style:${style}, ${width}x${height}, ${layers.length} layers`);

    // Build projection
    const rawBbox = bbox || { minLon:-180, maxLon:180, minLat:-85, maxLat:85 };
    const projection = EQUIRECT_STYLES.includes(style)
      ? buildEquirectProjection(width, height)
      : buildProjection(rawBbox, width, height);

    // Generate base map via D3 (reliable, no external tile deps)
    const world = await loadGeoData("countries");
    const mapBuffer = await renderBaseMap(world, rawBbox, { width, height, style, projection });
    const base64 = mapBuffer.toString("base64");

    // Convert geometries to pixel coords
    const pixelLayers = layers.map(layer => {
      const result = { id:layer.id, name:layer.name, type:layer.type, mode:layer.mode||"shape", color:layer.color||"#f97316" };
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

    console.log(`[Masar v2] Done! map size: ${mapBuffer.length} bytes`);
    res.json({ success:true, map:base64, metadata:{ width, height, style, layers:pixelLayers, mapW:width, mapH:height } });
  } catch(e) {
    console.error("[Masar v2] generate-map error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// Finalize — fetch high-res tiles per zoom level
app.post("/finalize", async (req, res) => {
  try {
    const { keyframes=[], style="dark", compW=3840, compH=2160 } = req.body;
    console.log(`[Masar v2] finalize — ${keyframes.length} KFs, style:${style}`);

    if (!keyframes.length) return res.json({ success:false, error:"No keyframes" });

    const zoomLevels = [...new Set(keyframes.map(kf => Math.round(kf.state.zoom||2)))];
    const tiles = [];

    for (const zoom of zoomLevels) {
      const kfsAtZoom = keyframes.filter(kf => Math.round(kf.state.zoom||2) === zoom);
      const kf = kfsAtZoom[Math.floor(kfsAtZoom.length/2)];

      try {
        // Try to fetch satellite tiles, fallback to D3
        let tileBuf = null;
        if (style === "satellite") {
          tileBuf = await fetchSatelliteTiles(kf.state.lat||25, kf.state.lon||30, zoom, compW, compH);
        }

        // Fallback: D3 render at this zoom level
        if (!tileBuf) {
          const world = await loadGeoData("countries");
          const proj  = buildProjection({ minLon:-180,maxLon:180,minLat:-85,maxLat:85 }, compW, compH);
          tileBuf = await renderBaseMap(world, { minLon:-180,maxLon:180,minLat:-85,maxLat:85 }, { width:compW, height:compH, style, projection:proj });
        }

        const tilePath = path.join(os.tmpdir(), `masar2_tile_z${zoom}_${Date.now()}.png`);
        await fs.promises.writeFile(tilePath, tileBuf);

        const inKf  = kfsAtZoom[0];
        const outKf = kfsAtZoom[kfsAtZoom.length-1];
        tiles.push({ zoom, path:tilePath, inTime:inKf.time-0.5, outTime:outKf.time+0.5 });
        console.log(`[Masar v2] Tile Z${zoom} saved`);
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

// Satellite tile fetching
const tileCache = {};
async function fetchSatTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache[key]) return tileCache[key];
  try {
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    const res = await fetch(url, { timeout:8000 });
    if (!res.ok) return null;
    const buf = await res.buffer();
    tileCache[key] = buf;
    return buf;
  } catch(e) { return null; }
}

function lonToTileX(lon,z){ return Math.floor((lon+180)/360*Math.pow(2,z)); }
function latToTileY(lat,z){ const r=lat*Math.PI/180; return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z)); }

async function fetchSatelliteTiles(lat, lon, zoom, width, height) {
  const TILE=256;
  const cx=lonToTileX(lon,zoom), cy=latToTileY(lat,zoom);
  const tw=Math.ceil(width/TILE)+2, th=Math.ceil(height/TILE)+2;
  const x0=cx-Math.floor(tw/2), y0=cy-Math.floor(th/2);

  if (tw*th > 36) return null; // too many tiles

  const { createCanvas, Image } = require("canvas");
  const canvas=createCanvas(tw*TILE,th*TILE), ctx=canvas.getContext("2d");
  ctx.fillStyle="#000"; ctx.fillRect(0,0,tw*TILE,th*TILE);

  let loaded=0;
  await Promise.all(Array.from({length:tw*th},(_,i)=>{
    const tx=x0+Math.floor(i/th), ty=y0+(i%th);
    return (async()=>{
      const buf=await fetchSatTile(zoom,tx,ty); if(!buf) return;
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

function flattenCoords(g) {
  if (!g) return [];
  switch(g.type) {
    case "Point": return [g.coordinates];
    case "MultiPoint": case "LineString": return g.coordinates;
    case "MultiLineString": case "Polygon": return g.coordinates.flat();
    case "MultiPolygon": return g.coordinates.flat(2);
    default: return [];
  }
}

app.listen(PORT, () => console.log(`[Masar v2] Server v2.1 running on port ${PORT}`));
