const fetch = require("node-fetch");

const SOURCES = {
  countries: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson",
  cities:    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places.geojson",
  rivers:    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_rivers_lake_centerlines.geojson",
  lakes:     "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_lakes.geojson",
};

const cache = {};

async function loadGeoData(key) {
  if (cache[key]) return cache[key];
  console.log(`[GeoData] Loading ${key}...`);
  const res  = await fetch(SOURCES[key]);
  const data = await res.json();
  cache[key] = data;
  console.log(`[GeoData] ${key} — ${data.features.length} features`);
  return data;
}

async function loadAll() {
  await Promise.all(Object.keys(SOURCES).map(k => loadGeoData(k)));
  console.log("[GeoData] All loaded!");
}

// ── OSM Nominatim search (fallback for cities/places) ─────────
async function nominatimSearch(query) {
  try {
    await new Promise(r => setTimeout(r, 500));
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
    const res  = await fetch(url, { headers: { "User-Agent": "MasarPlugin/2.0 (shuwaz.com)" } });
    const data = await res.json();
    return data.map(item => ({
      type:      item.type === "administrative" ? "city" : (item.class === "waterway" ? "river" : "city"),
      name:      item.display_name.split(",")[0],
      nameLocal: item.display_name.split(",")[0],
      country:   item.address?.country || "",
      geometry:  { type: "Point", coordinates: [parseFloat(item.lon), parseFloat(item.lat)] },
      bbox:      item.boundingbox ? {
        minLat: parseFloat(item.boundingbox[0]), maxLat: parseFloat(item.boundingbox[1]),
        minLon: parseFloat(item.boundingbox[2]), maxLon: parseFloat(item.boundingbox[3]),
      } : null,
      score: 50,
      osmId: item.osm_id,
      osmType: item.osm_type,
    }));
  } catch(e) {
    console.error("[Nominatim] Error:", e.message);
    return [];
  }
}

async function search(query) {
  const q = query.toLowerCase().trim();
  const results = [];
  const seen = new Set();

  // 1. Countries from Natural Earth
  const countries = await loadGeoData("countries");
  for (const f of countries.features) {
    const name   = (f.properties.NAME || "").toLowerCase();
    const nameAr = (f.properties.NAME_AR || "").toLowerCase();
    const iso    = (f.properties.ISO_A2 || "").toLowerCase();
    if (name.includes(q) || nameAr.includes(q) || iso === q) {
      const key = "country_" + f.properties.NAME;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          type:      "country",
          name:      f.properties.NAME,
          nameLocal: f.properties.NAME_AR || f.properties.NAME,
          iso:       f.properties.ISO_A2,
          geometry:  f.geometry,
          bbox:      getBBox(f.geometry),
          score:     name === q ? 100 : 80,
        });
      }
    }
  }

  // 2. Cities from Natural Earth (50m = more cities)
  const cities = await loadGeoData("cities");
  for (const f of cities.features) {
    const name   = (f.properties.NAME || "").toLowerCase();
    const nameAr = (f.properties.NAME_AR || "").toLowerCase();
    if (name.includes(q) || nameAr.includes(q)) {
      const key = "city_" + f.properties.NAME;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          type:      "city",
          name:      f.properties.NAME,
          nameLocal: f.properties.NAME_AR || f.properties.NAME,
          country:   f.properties.ADM0NAME,
          population:f.properties.POP_MAX || 0,
          geometry:  f.geometry,
          bbox:      null,
          score:     name === q ? 90 : 65,
        });
      }
    }
  }

  // 3. Rivers
  const rivers = await loadGeoData("rivers");
  for (const f of rivers.features) {
    const name = (f.properties.name || "").toLowerCase();
    if (name.includes(q)) {
      const key = "river_" + f.properties.name;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          type: "river", name: f.properties.name,
          geometry: f.geometry, bbox: getBBox(f.geometry), score: 70,
        });
      }
    }
  }

  // 4. Lakes
  const lakes = await loadGeoData("lakes");
  for (const f of lakes.features) {
    const name = (f.properties.name || "").toLowerCase();
    if (name.includes(q)) {
      const key = "lake_" + f.properties.name;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          type: "lake", name: f.properties.name,
          geometry: f.geometry, bbox: getBBox(f.geometry), score: 70,
        });
      }
    }
  }

  // 5. OSM Nominatim fallback if results < 3
  if (results.length < 3) {
    const osmResults = await nominatimSearch(query);
    for (const r of osmResults) {
      const key = r.type + "_" + r.name;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(r);
      }
    }
  }

  results.sort((a, b) => b.score - a.score || (b.population||0) - (a.population||0));
  return results.slice(0, 10);
}

async function getCityBoundary(name) {
  const q = name.toLowerCase().trim();

  // 1. Natural Earth countries — land boundaries only, no coastal issues
  try {
    const countries = await loadGeoData("countries");
    for (const f of countries.features) {
      const fname = (f.properties.NAME      || "").toLowerCase();
      const flong = (f.properties.NAME_LONG || "").toLowerCase();
      const fiso  = (f.properties.ISO_A2   || "").toLowerCase();
      if (fname === q || flong === q || fiso === q || fname.includes(q) || q.includes(fname)) {
        console.log(`[GeoData] Country match: ${f.properties.NAME}`);
        return { geometry: f.geometry, bbox: getBBox(f.geometry), name: f.properties.NAME, found: true };
      }
    }
  } catch(e) { console.log("[GeoData] Country lookup:", e.message); }

  // 2. Natural Earth lakes
  try {
    const lakes = await loadGeoData("lakes");
    for (const f of lakes.features) {
      const fname = (f.properties.name || "").toLowerCase();
      if (fname === q || fname.includes(q)) {
        return { geometry: f.geometry, bbox: getBBox(f.geometry), name: f.properties.name, found: true };
      }
    }
  } catch(e) {}

  // 3. Nominatim fallback (cities only)
  try {
    await new Promise(r => setTimeout(r, 600));
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=geojson&limit=1&polygon_geojson=1`;
    const res  = await fetch(url, { headers: { "User-Agent": "MasarPlugin/2.0 (shuwaz.com)" } });
    const data = await res.json();
    if (data.features?.length > 0) {
      const f = data.features[0];
      return { geometry: f.geometry, bbox: getBBox(f.geometry), name: f.properties.display_name.split(",")[0], found: true };
    }
  } catch(e) { console.error("[Nominatim]", e.message); }

  return null;
}

async function geocode(name) {
  try {
    await new Promise(r => setTimeout(r, 600));
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1`;
    const res  = await fetch(url, { headers: { "User-Agent": "MasarPlugin/2.0 (shuwaz.com)" } });
    const data = await res.json();
    if (data?.length > 0) {
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), name: data[0].display_name.split(",")[0] };
    }
    return null;
  } catch(e) { return null; }
}

function getBBox(geometry) {
  const coords = flattenCoords(geometry);
  if (!coords.length) return null;
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
}

function flattenCoords(geometry) {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":            return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":       return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":          return geometry.coordinates.flat();
    case "MultiPolygon":     return geometry.coordinates.flat(2);
    default:                 return [];
  }
}

module.exports = { search, getCityBoundary, geocode, loadAll, loadGeoData };
