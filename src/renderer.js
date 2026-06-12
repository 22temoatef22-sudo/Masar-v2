const { createCanvas } = require("canvas");
const { geoNaturalEarth1, geoEquirectangular, geoPath, geoGraticule } = require("d3-geo");
const sharp  = require("sharp");
const fetch  = require("node-fetch");
const path   = require("path");
const fs     = require("fs");

const STYLES = {};
const stylesDir = path.join(__dirname, "../styles");
try {
  fs.readdirSync(stylesDir).forEach(f => {
    if (f.endsWith(".json")) STYLES[f.replace(".json","")] = JSON.parse(fs.readFileSync(path.join(stylesDir,f),"utf8"));
  });
} catch(e) {}

const DEFAULT_STYLE = { ocean:"#080c14", land:"#141c28", border:"#2a3550", graticule:"#0f1520", vignette:true, vignetteColor:"#000", vignetteStrength:0.5, grain:true, grainStrength:0.03 };
function getStyle(k){ return STYLES[k]||STYLES["dark-pro"]||DEFAULT_STYLE; }

// ── NaturalEarth1 world projection (for AI maps 8192x4096) ────
function buildProjection(bbox, width, height) {
  return geoNaturalEarth1()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
}

// ── Equirectangular projection (for NASA satellite 5400x2700) ──
// NASA Blue Marble is a simple lon/lat → x/y mapping
// lon: -180..180 → 0..width
// lat: 90..-90   → 0..height
function buildEquirectProjection(width, height) {
  return geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
}

const ESRI_MAP = { "satellite-film":"World_Imagery", "vintage-atlas":"World_Shaded_Relief" };
const tileCache = {};
async function fetchTile(service,z,x,y){
  const key=`${service}/${z}/${x}/${y}`;
  if(tileCache[key]) return tileCache[key];
  try{const res=await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`,{timeout:8000});if(!res.ok)return null;const buf=await res.buffer();tileCache[key]=buf;return buf;}catch(e){return null;}
}
function lonToTileX(lon,z){return Math.floor((lon+180)/360*Math.pow(2,z));}
function latToTileY(lat,z){const r=lat*Math.PI/180;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z));}
function tileXToLon(x,z){return x/Math.pow(2,z)*360-180;}
function tileYToLat(y,z){const n=Math.PI-2*Math.PI*y/Math.pow(2,z);return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));}
function calcZoom(bbox){const r=Math.max(bbox.maxLon-bbox.minLon,bbox.maxLat-bbox.minLat);if(r>80)return 3;if(r>40)return 4;if(r>20)return 5;if(r>10)return 6;if(r>5)return 7;if(r>2)return 8;return 9;}

async function stitchESRI(bbox,width,height,service){
  const zoom=calcZoom(bbox),x0=lonToTileX(bbox.minLon,zoom),x1=lonToTileX(bbox.maxLon,zoom),y0=latToTileY(bbox.maxLat,zoom),y1=latToTileY(bbox.minLat,zoom);
  const TILE=256,tw=x1-x0+1,th=y1-y0+1;
  if(tw>8||th>8)return null;
  const canvas=createCanvas(tw*TILE,th*TILE),ctx=canvas.getContext("2d");
  let loaded=0;
  await Promise.all(Array.from({length:(y1-y0+1)*(x1-x0+1)},(_,i)=>{const ty=y0+Math.floor(i/(x1-x0+1)),tx=x0+(i%(x1-x0+1));return(async()=>{const buf=await fetchTile(service,zoom,tx,ty);if(!buf)return;try{const{Image}=require("canvas"),img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=buf;});ctx.drawImage(img,(tx-x0)*TILE,(ty-y0)*TILE);loaded++;}catch(e){}})();}));
  if(loaded===0)return null;
  const tLonR=tileXToLon(x1+1,zoom)-tileXToLon(x0,zoom),tLatR=tileYToLat(y0,zoom)-tileYToLat(y1+1,zoom);
  return sharp(canvas.toBuffer("image/png")).extract({left:Math.max(0,Math.floor((bbox.minLon-tileXToLon(x0,zoom))/tLonR*tw*TILE)),top:Math.max(0,Math.floor((tileYToLat(y0,zoom)-bbox.maxLat)/tLatR*th*TILE)),width:Math.max(1,Math.floor((bbox.maxLon-bbox.minLon)/tLonR*tw*TILE)),height:Math.max(1,Math.floor((bbox.maxLat-bbox.minLat)/tLatR*th*TILE))}).resize(width,height).png().toBuffer();
}

async function renderD3(world,width,height,styleKey,projection){
  const colors=getStyle(styleKey),canvas=createCanvas(width,height),ctx=canvas.getContext("2d"),pathFn=geoPath(projection,ctx);
  ctx.fillStyle=colors.ocean;ctx.fillRect(0,0,width,height);
  if(colors.graticule){ctx.beginPath();pathFn(geoGraticule()());ctx.strokeStyle=colors.graticule;ctx.lineWidth=0.5;ctx.stroke();}
  for(const f of world.features){ctx.beginPath();pathFn(f);ctx.fillStyle=colors.land;ctx.fill();ctx.strokeStyle=colors.border;ctx.lineWidth=0.6;ctx.stroke();}
  let buf=canvas.toBuffer("image/png");
  if(colors.vignette)buf=await applyVignette(buf,width,height,colors.vignetteColor||"#000",colors.vignetteStrength||0.5);
  if(colors.grain)buf=await applyGrain(buf,width,height,colors.grainStrength||0.03);
  return buf;
}

async function applyVignette(buf,W,H,color,strength){
  const canvas=createCanvas(W,H),ctx=canvas.getContext("2d"),grad=ctx.createRadialGradient(W/2,H/2,H*0.25,W/2,H/2,H*0.9);
  grad.addColorStop(0,"transparent");grad.addColorStop(1,color+Math.floor(strength*255).toString(16).padStart(2,"0"));
  ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);
  return sharp(buf).composite([{input:canvas.toBuffer("image/png"),blend:"over"}]).png().toBuffer();
}
async function applyGrain(buf,W,H,strength){
  const canvas=createCanvas(W,H),ctx=canvas.getContext("2d"),id=ctx.createImageData(W,H);
  for(let i=0;i<id.data.length;i+=4){const v=Math.random()>0.5?255:0;id.data[i]=id.data[i+1]=id.data[i+2]=v;id.data[i+3]=Math.floor(strength*60);}
  ctx.putImageData(id,0,0);
  return sharp(buf).composite([{input:canvas.toBuffer("image/png"),blend:"overlay"}]).png().toBuffer();
}

async function renderBaseMap(world,bbox,options={}){
  const{width=8192,height=4096,style="dark-pro",projection:existingProj}=options;
  const projection=existingProj||buildProjection(bbox,width,height);
  const esriService=ESRI_MAP[style];
  if(esriService){try{const esriBuf=await stitchESRI(bbox,width,height,esriService);if(esriBuf){const colors=getStyle(style);let result=esriBuf;if(colors.vignette)result=await applyVignette(result,width,height,colors.vignetteColor||"#000",colors.vignetteStrength||0.5);if(colors.grain)result=await applyGrain(result,width,height,colors.grainStrength||0.03);return result;}}catch(e){}}
  return renderD3(world,width,height,style,projection);
}

function geometryToPixels(geometry,projection,compW,compH){
  const rings=[],toAE=([lon,lat])=>{const[x,y]=projection([lon,lat]);return[x-compW/2,y-compH/2];};
  if(geometry.type==="Polygon")rings.push(geometry.coordinates[0].map(toAE));
  else if(geometry.type==="MultiPolygon")for(const p of geometry.coordinates)rings.push(p[0].map(toAE));
  else if(geometry.type==="LineString")rings.push(geometry.coordinates.map(toAE));
  else if(geometry.type==="MultiLineString")for(const l of geometry.coordinates)rings.push(l.map(toAE));
  return rings;
}

function pointToPixel(geometry,projection){return projection(geometry.coordinates);}
function getStylesList(){return Object.entries(STYLES).map(([key,s])=>({key,name:s.name||key,nameAr:s.nameAr||s.name||key}));}
module.exports={renderBaseMap,buildProjection,buildEquirectProjection,geometryToPixels,pointToPixel,getStylesList};
