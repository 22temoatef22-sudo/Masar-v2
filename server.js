/**
 * ════════════════════════════════════════════════════════════════
 * POST /raster-map — Raster Export Endpoint
 * 
 * Add this route to your server.js alongside the existing /vector-map route.
 * 
 * Request body:
 *   { bbox, zoom, style, width, height, format?, provider? }
 * 
 * Response:
 *   { success, image (base64), metadata, stats, timing }
 * ════════════════════════════════════════════════════════════════
 */

// ── Add this route in server.js after app.post('/vector-map', ...) ──

app.post('/raster-map', async (req, res) => {
  const tag = '[raster-map]';
  const startTime = Date.now();

  try {
    console.log(tag, 'POST /raster-map');

    const {
      bbox,
      zoom,
      style    = 'dark',
      width    = 1920,
      height   = 1080,
      format   = 'png',
      provider = 'openfreemap',
      padding  = 0,       // extra padding factor (0 = viewport only, 1 = 2x area)
    } = req.body;

    // ── Validate ────────────────────────────────────────────────
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      return res.status(400).json({
        success: false,
        error: 'bbox must be [west, south, east, north]'
      });
    }

    if (typeof zoom !== 'number' || zoom < 0 || zoom > 18) {
      return res.status(400).json({
        success: false,
        error: 'zoom must be a number between 0 and 18'
      });
    }

    // ── Optional: expand bbox for camera movement headroom ─────
    let exportBbox = bbox;
    if (padding > 0) {
      const lonSpan = bbox[2] - bbox[0];
      const latSpan = bbox[3] - bbox[1];
      const padLon = lonSpan * padding;
      const padLat = latSpan * padding;
      exportBbox = [
        bbox[0] - padLon,
        bbox[1] - padLat,
        bbox[2] + padLon,
        bbox[3] + padLat,
      ];
    }

    // ── Clamp dimensions to merger max (8192) ──────────────────
    const clampedWidth  = Math.min(Math.round(width),  8192);
    const clampedHeight = Math.min(Math.round(height), 8192);

    console.log(tag, `style=${style} zoom=${zoom} ${clampedWidth}x${clampedHeight} padding=${padding}`);
    console.log(tag, `bbox=[${exportBbox.map(n => n.toFixed(4)).join(', ')}]`);

    // ── Call raster export pipeline ────────────────────────────
    const result = await exportRaster({
      provider:   provider,
      style:      style,
      bbox:       exportBbox,
      zoom:       Math.round(zoom),
      width:      clampedWidth,
      height:     clampedHeight,
      format:     format,
    });

    // ── Convert buffer to base64 ──────────────────────────────
    const base64Image = result.buffer.toString('base64');
    const durationMs  = Date.now() - startTime;

    console.log(tag, `200 OK (${durationMs}ms) — ${Math.round(base64Image.length / 1024)}KB base64`);

    res.json({
      success:  true,
      image:    base64Image,        // base64 PNG — raster-builder.jsx consumes this
      format:   result.format,
      width:    result.width,
      height:   result.height,
      bbox:     result.bbox,
      zoom:     result.zoom,
      metadata: result.metadata,
      stats:    result.stats,
      timing: {
        totalMs: durationMs,
      },
    });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(tag, `ERROR (${durationMs}ms):`, err.message);

    res.status(err.message.includes('validation') ? 502 : 500).json({
      success: false,
      error:   err.message,
    });
  }
});
