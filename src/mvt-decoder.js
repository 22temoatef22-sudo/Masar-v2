const tileCache = new Map();
const MAX_CACHE_SIZE = 200;

async function fetchAndDecodeTile(tileURL, x, y, z) {
  // دمج الرابط مع الإحداثيات لضمان عزل الـ Cache بين الستاينلات المختلفة
  const cacheKey = `${tileURL}|${z}/${x}/${y}`;

  if (tileCache.has(cacheKey)) {
    console.log("[cache] hit", cacheKey);
    const cachedData = tileCache.get(cacheKey);
    tileCache.delete(cacheKey);
    tileCache.set(cacheKey, cachedData);
    return cachedData;
  }

  console.log("[cache] miss", cacheKey);

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
    if (res.status === 404) return [];
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

  if (tileCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = tileCache.keys().next().value;
    tileCache.delete(oldestKey);
  }

  tileCache.set(cacheKey, features);
  return features;
}
