// 幾何ユーティリティ — 単純多角形(自己交差なし) × 軸平行矩形
// 多角形は [[x,y], ...] 反時計回り(CCW)に正規化して扱う。単位 mm。

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function ensureCCW(pts) {
  return polyArea(pts) < 0 ? [...pts].reverse() : pts;
}

function polyBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function polyCentroid(pts) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; a += f;
  }
  if (Math.abs(a) < 1e-9) return [pts[0][0], pts[0][1]];
  return [cx / (3 * a), cy / (3 * a)];
}

function pointInPoly(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}

function _cross(ox, oy, ax, ay, bx, by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

// 真の交差のみ true(端点接触・共線は false → 壁にぴったり寄せた配置を許す)
function segsCross(p, q, r, s) {
  const d1 = _cross(r[0], r[1], s[0], s[1], p[0], p[1]);
  const d2 = _cross(r[0], r[1], s[0], s[1], q[0], q[1]);
  const d3 = _cross(p[0], p[1], q[0], q[1], r[0], r[1]);
  const d4 = _cross(p[0], p[1], q[0], q[1], s[0], s[1]);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 &&
    ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// 矩形が多角形に完全に含まれるか(eps だけ縮めて評価 → 境界フラッシュ配置OK)
function rectInPoly(r, poly, eps = 2.7) {
  const x0 = r.x + eps, y0 = r.y + eps, x1 = r.x + r.w - eps, y1 = r.y + r.h - eps;
  if (x1 <= x0 || y1 <= y0) return false;
  const cs = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (const c of cs) if (!pointInPoly(c[0], c[1], poly)) return false;
  const edges = [[cs[0], cs[1]], [cs[1], cs[2]], [cs[2], cs[3]], [cs[3], cs[0]]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    for (const e of edges) if (segsCross(e[0], e[1], a, b)) return false;
    if (a[0] > x0 && a[0] < x1 && a[1] > y0 && a[1] < y1) return false; // 凹角の食い込み
  }
  return true;
}

function rectsOverlap(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && b.x - pad < a.x + a.w &&
         a.y < b.y + b.h + pad && b.y - pad < a.y + a.h;
}

// 軸平行な半平面で多角形をクリップ(Sutherland–Hodgman)
function clipHalf(pts, axis, val, keepBelow) {
  const idx = axis === "x" ? 0 : 1;
  const inside = (p) => keepBelow ? p[idx] <= val : p[idx] >= val;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (val - a[idx]) / (b[idx] - a[idx]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// 矩形で多角形をクリップ
function clipRectPoly(pts, r) {
  let p = clipHalf(pts, "x", r.x, false);
  if (p.length < 3) return [];
  p = clipHalf(p, "x", r.x + r.w, true);
  if (p.length < 3) return [];
  p = clipHalf(p, "y", r.y, false);
  if (p.length < 3) return [];
  p = clipHalf(p, "y", r.y + r.h, true);
  return p.length < 3 ? [] : p;
}

function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distPtPolyEdge(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    d = Math.min(d, distPtSeg(px, py, a[0], a[1], b[0], b[1]));
  }
  return d;
}
