/**
 * Liang–Barsky Line Clipping Algorithm
 * Clips a line segment strictly to the geographic bounding box.
 * Returns an array of clipped segments or null if completely outside.
 */
function clipSegmentLiangBarsky(p1, p2, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  let [x0, y0] = p1;
  let [x1, y1] = p2;
  
  let t0 = 0.0;
  let t1 = 1.0;
  const dx = x1 - x0;
  const dy = y1 - y0;

  // الحالات الأربعة للحدود الجغرافية [اليسار، اليمين، الأسفل، الأعلى]
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; // الخط موازي وخارج الحدود تماماً
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  if (t0 > t1) return null;

  return [
    [x0 + t0 * dx, y0 + t0 * dy],
    [x0 + t1 * dx, y0 + t1 * dy]
  ];
}

/**
 * Replaces the old clipLineToBBox to build clean paths along viewport edges
 */
function clipLineToBBox(coords, bbox) {
  const clippedLines = [];
  let currentSegment = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    
    const clipped = clipSegmentLiangBarsky(p1, p2, bbox);
    
    if (clipped) {
      if (currentSegment.length === 0) {
        currentSegment.push(clipped[0]);
      }
      currentSegment.push(clipped[1]);
      
      // إذا كان الجزء المقطوع ينتهي قبل النقطة الأصلية p2، فهذا يعني أنه خرج من الحدود
      if (clipped[1][0] !== p2[0] || clipped[1][1] !== p2[1]) {
        if (currentSegment.length >= 2) clippedLines.push(currentSegment);
        currentSegment = [];
      }
    } else {
      if (currentSegment.length >= 2) clippedLines.push(currentSegment);
      currentSegment = [];
    }
  }

  if (currentSegment.length >= 2) clippedLines.push(currentSegment);
  return clippedLines;
}
