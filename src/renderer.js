const { createCanvas } = require("canvas");
const { geoNaturalEarth1, geoEquirectangular, geoPath, geoGraticule } = require("d3-geo");
const sharp = require("sharp");
const fetch = require("node-fetch");

// ── Inline styles ─────────────────────────────────────────────
const STYLES = {
  "dark":          { ocean:"#080c14", land:"#141c28", border:"#2a3550", graticule:"#0f1520", vignette:true,  vignetteColor:"#000000", vignetteStrength:0.5, grain:true,  grainStrength:0.03 },
  "dark-pro":      { ocean:"#080c14", land:"#141c28", border:"#2a3550", graticule:"#0f1520", vignette:true,  vignetteColor:"#000000", vignetteStrength:0.5, grain:true,  grainStrength:0.03 },
  "light":         { ocean:"#a8c8e8", land:"#f0ede0", border:"#999999", graticule:"#cccccc", vignette:false, grain:false },
  "positron":      { ocean:"#a8c8e8", land:"#f0ede0", border:"#999999", graticule:"#cccccc", vignette:false, grain:false },
  "political":     { ocean:"#4a90d9", land:"#e8e0d0", border:"#666666", graticule:"#aaaaaa", vignette:false, grain:false },
  "vintage-atlas": { ocean:"#7ba7bc", land:"#f4e4c1", border:"#8b6914", graticule:"#c4a862", vignette:true,  vignetteColor:"#3a2010", vignetteStrength:0.4, grain:true,  grainStrength:0.04 },
  "terrain":       { ocean:"#6ba7d6", land:"#c8b98a", border:"#8b7040", graticule:"#b09060", vignette:false, grain:true,  grainStrength:0.02 },
  "satellite":     { ocean:"#061018", land:"#0a1a0a", border:"#1a3a1a", graticule:"#0a2010", vignette:true,  vignetteColor:"#000000", vignetteStrength:0.6, grain:true,  grainStrength:0.02 },
  "satellite-film":{ ocean:"#061018", land:"#0a1a0a", border:"#1a3a1a", graticule:"#0a2010", vignette:true,  vignetteColor:"#000000", vignetteStrength:0.6, grain:true,  grainStrength:0.02 },
  "topo":          { ocean:"#7ba7bc", land:"#d4c9a0", border:"#8b7040", graticule:"#b09060", vignette:false, grain:false },
  // Map CEP style names → renderer style names
  "liberty":       { ocean:"#a8c8e8", land:"#f0ede0", border:"#999999", graticule:"#cccccc", vignette:false, grain:false },
  "voyager":       { ocean:"#a8c8e8", land:"#e8e4d8", border:"#aaaaaa", graticule:"#cccccc", vignette:false, grain:false },
};

function getStyle(k) {
  // Normalize CEP style names to renderer styles
  const map = { "light":"light", "positron":"light", "dark":"dark", "liberty":"light",
                "satellite":"satellite", "topo":"topo", "terrain":"terrain", "voyager":"voyager" };
  return STYLES[map[k] || k] || STYLES["dark"];
}

// ── Projection — zooms to bbox ────────────────────────────────
function buildProjection(bbox, width, height) {
  const proj = geoNaturalEarth1()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);

  // Full world: don't zoom
  const spanLon = (bbox.maxLon || 180) - (bbox.minLon || -180);
  const spanLat = (bbox.maxLat || 85)  - (bbox.minLat || -85);
  if (spanLon > 300 || spanLat > 150) return proj;

  // Zoom to bbox with padding
  const pad = Math.min(width, height) * 0.06;
  proj.fitExtent(
    [[pad, pad], [width - pad, height - pad]],
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [bbox.minLon, bbox.minLat],
          [bbox.maxLon, bbox.minLat],
          [bbox.maxLon, bbox.maxLat],
          [bbox.minLon, bbox.maxLat],
          [bbox.minLon, bbox.minLat],
        ]]
      }
    }
  );
  return proj;
}

function buildEquirectProjection(width, height) {
  return geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
}

// ── ESRI satellite tile fetching ──────────────────────────────
const ESRI_MAP = { "satellite":"World_Imagery", "satellite-film":"World_Imagery" };
const tileCache = {};

async function fetchTile(service, z, x, y) {
  const key = `${service}/${z}/${x}/${y}`;
  if (tileCache[key]) return tileCache[key];
  try {
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`;
    const res = await fetch(url, { timeout:8000 });
    if (!res.ok) return null;
    const buf = await res.buffer();
    tileCache[key] = buf;
    return buf;
  } catch(e) { return null; }
}

function lonToTileX(lon,z){ return Math.floor((lon+180)/360*Math.pow(2,z)); }
function latToTileY(lat,z){ const r=lat*Math.PI/180; return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z)); }
function tileXToLon(x,z){ return x/Math.pow(2,z)*360-180; }
function tileYToLat(y,z){ const n=Math.PI-2*Math.PI*y/Math.pow(2,z); return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))); }
function calcZoom(bbox){ const r=Math.max(bbox.maxLon-bbox.minLon,bbox.maxLat-bbox.minLat); if(r>80)return 3;if(r>40)return 4;if(r>20)return 5;if(r>10)return 6;if(r>5)return 7;if(r>2)return 8;return 9; }

async function stitchESRI(bbox, width, height, service) {
  const zoom=calcZoom(bbox), x0=lonToTileX(bbox.minLon,zoom), x1=lonToTileX(bbox.maxLon,zoom);
  const y0=latToTileY(bbox.maxLat,zoom), y1=latToTileY(bbox.minLat,zoom);
  const TILE=256, tw=x1-x0+1, th=y1-y0+1;
  if (tw>8||th>8) return null;
  const canvas=createCanvas(tw*TILE,th*TILE), ctx=canvas.getContext("2d");
  let loaded=0;
  const tasks=[];
  for(let ty=y0;ty<=y1;ty++) for(let tx=x0;tx<=x1;tx++){
    tasks.push((async(tx,ty)=>{
      const buf=await fetchTile(service,zoom,tx,ty); if(!buf) return;
      try {
        const {Image}=require("canvas"), img=new Image();
        await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=buf;});
        ctx.drawImage(img,(tx-x0)*TILE,(ty-y0)*TILE); loaded++;
      } catch(e){}
    })(tx,ty));
  }
  await Promise.all(tasks);
  if (loaded===0) return null;
  const tLonR=tileXToLon(x1+1,zoom)-tileXToLon(x0,zoom);
  const tLatR=tileYToLat(y0,zoom)-tileYToLat(y1+1,zoom);
  const cX=Math.max(0,Math.floor((bbox.minLon-tileXToLon(x0,zoom))/tLonR*tw*TILE));
  const cY=Math.max(0,Math.floor((tileYToLat(y0,zoom)-bbox.maxLat)/tLatR*th*TILE));
  const cW=Math.max(1,Math.floor((bbox.maxLon-bbox.minLon)/tLonR*tw*TILE));
  const cH=Math.max(1,Math.floor((bbox.maxLat-bbox.minLat)/tLatR*th*TILE));
  return sharp(canvas.toBuffer("image/png")).extract({left:cX,top:cY,width:cW,height:cH}).resize(width,height).png().toBuffer();
}

// ── D3 renderer ───────────────────────────────────────────────
async function renderD3(world, width, height, styleKey, projection) {
  const colors = getStyle(styleKey);
  const canvas  = createCanvas(width, height);
  const ctx     = canvas.getContext("2d");
  const pathFn  = geoPath(projection, ctx);

  ctx.fillStyle = colors.ocean;
  ctx.fillRect(0, 0, width, height);

  if (colors.graticule) {
    ctx.beginPath(); pathFn(geoGraticule()());
    ctx.strokeStyle = colors.graticule; ctx.lineWidth = 0.5; ctx.stroke();
  }

  for (const f of world.features) {
    ctx.beginPath(); pathFn(f);
    ctx.fillStyle   = colors.land;   ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 0.6; ctx.stroke();
  }

  let buf = canvas.toBuffer("image/png");
  if (colors.vignette) buf = await applyVignette(buf, width, height, colors.vignetteColor||"#000000", colors.vignetteStrength||0.5);
  if (colors.grain)    buf = await applyGrain(buf, width, height, colors.grainStrength||0.03);
  return buf;
}

async function applyVignette(buf, W, H, color, strength) {
  const canvas=createCanvas(W,H), ctx=canvas.getContext("2d");
  const grad=ctx.createRadialGradient(W/2,H/2,H*0.25,W/2,H/2,H*0.9);
  grad.addColorStop(0,"transparent");
  grad.addColorStop(1, color + Math.floor(strength*255).toString(16).padStart(2,"0"));
  ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
  return sharp(buf).composite([{input:canvas.toBuffer("image/png"),blend:"over"}]).png().toBuffer();
}

async function applyGrain(buf, W, H, strength) {
  const canvas=createCanvas(W,H), ctx=canvas.getContext("2d"), id=ctx.createImageData(W,H);
  for(let i=0;i<id.data.length;i+=4){const v=Math.random()>0.5?255:0;id.data[i]=id.data[i+1]=id.data[i+2]=v;id.data[i+3]=Math.floor(strength*60);}
  ctx.putImageData(id,0,0);
  return sharp(buf).composite([{input:canvas.toBuffer("image/png"),blend:"overlay"}]).png().toBuffer();
}

// ── Main render ───────────────────────────────────────────────
async function renderBaseMap(world, bbox, options={}) {
  const { width=1920, height=960, style="dark", projection:existingProj } = options;
  const projection = existingProj || buildProjection(bbox, width, height);

  const esriService = ESRI_MAP[style];
  if (esriService) {
    try {
      const esriBuf = await stitchESRI(bbox, width, height, esriService);
      if (esriBuf) {
        const colors = getStyle(style);
        let result = esriBuf;
        if (colors.vignette) result = await applyVignette(result, width, height, colors.vignetteColor||"#000000", colors.vignetteStrength||0.5);
        if (colors.grain)    result = await applyGrain(result, width, height, colors.grainStrength||0.03);
        return result;
      }
    } catch(e) { console.log("[Renderer] ESRI fallback:", e.message); }
  }

  return renderD3(world, width, height, style, projection);
}

// ── Pixel converters ──────────────────────────────────────────
function geometryToPixels(geometry, projection, compW, compH) {
  const rings = [];
  const toAE  = ([lon,lat]) => { const [x,y]=projection([lon,lat]); return [x-compW/2, y-compH/2]; };
  if (geometry.type==="Polygon")           rings.push(geometry.coordinates[0].map(toAE));
  else if (geometry.type==="MultiPolygon") for(const p of geometry.coordinates) rings.push(p[0].map(toAE));
  else if (geometry.type==="LineString")   rings.push(geometry.coordinates.map(toAE));
  else if (geometry.type==="MultiLineString") for(const l of geometry.coordinates) rings.push(l.map(toAE));
  return rings;
}

function pointToPixel(geometry, projection) { return projection(geometry.coordinates); }
function getStylesList() { return Object.keys(STYLES).map(key => ({ key, name:key })); }

module.exports = { renderBaseMap, buildProjection, buildEquirectProjection, geometryToPixels, pointToPixel, getStylesList };
