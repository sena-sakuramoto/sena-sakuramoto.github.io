// 経路解析 — 占有グリッド + クリアランス距離変換 + Dijkstra
// 「実際に歩ける経路」で配膳・避難距離を測り、到達できない席を検出する。
// セル中心がいずれかの障害矩形内 or 境界外なら占有。クリアランス(最寄り障害までの距離)が
// minClear 以上のセルだけを歩行可能とする(minClear=300 → 有効幅600mm相当)。

function buildWalkGrid(poly, bb, obstacles, cs, minClear) {
  const nx = Math.max(2, Math.ceil(bb.maxX / cs));
  const ny = Math.max(2, Math.ceil(bb.maxY / cs));
  const n = nx * ny;
  const obs = new Uint8Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * cs, y = (j + 0.5) * cs;
      let blocked = !pointInPoly(x, y, poly);
      if (!blocked) {
        for (const r of obstacles) {
          if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) { blocked = true; break; }
        }
      }
      obs[j * nx + i] = blocked ? 1 : 0;
    }
  }
  // チャンファー距離変換(2パス)で各セルの障害クリアランスを求める
  const INF = 1e12;
  const clear = new Float64Array(n).fill(INF);
  for (let k = 0; k < n; k++) if (obs[k]) clear[k] = 0;
  const D = cs, Dd = Math.SQRT2 * cs;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0 && clear[k - 1] + D < clear[k]) clear[k] = clear[k - 1] + D;
      if (j > 0) {
        if (clear[k - nx] + D < clear[k]) clear[k] = clear[k - nx] + D;
        if (i > 0 && clear[k - nx - 1] + Dd < clear[k]) clear[k] = clear[k - nx - 1] + Dd;
        if (i < nx - 1 && clear[k - nx + 1] + Dd < clear[k]) clear[k] = clear[k - nx + 1] + Dd;
      }
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i < nx - 1 && clear[k + 1] + D < clear[k]) clear[k] = clear[k + 1] + D;
      if (j < ny - 1) {
        if (clear[k + nx] + D < clear[k]) clear[k] = clear[k + nx] + D;
        if (i < nx - 1 && clear[k + nx + 1] + Dd < clear[k]) clear[k] = clear[k + nx + 1] + Dd;
        if (i > 0 && clear[k + nx - 1] + Dd < clear[k]) clear[k] = clear[k + nx - 1] + Dd;
      }
    }
  }
  const walk = new Uint8Array(n);
  for (let k = 0; k < n; k++) walk[k] = (!obs[k] && clear[k] >= minClear) ? 1 : 0;
  return { nx, ny, cs, obs, clear, walk };
}

// 矩形(reach だけ膨らませた範囲)内の歩行可能セル番号を列挙
function cellsInRect(grid, rect, reach = 0) {
  const { nx, ny, cs, walk } = grid;
  const i0 = Math.max(0, Math.floor((rect.x - reach) / cs));
  const i1 = Math.min(nx - 1, Math.floor((rect.x + rect.w + reach) / cs));
  const j0 = Math.max(0, Math.floor((rect.y - reach) / cs));
  const j1 = Math.min(ny - 1, Math.floor((rect.y + rect.h + reach) / cs));
  const out = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++)
      if (walk[j * nx + i]) out.push(j * nx + i);
  return out;
}

// 8近傍Dijkstra(コスト: 直交=cs, 斜め=cs√2)。dist[mm] と parent を返す。
function shortestField(grid, sources) {
  const { nx, ny, cs, walk } = grid;
  const n = nx * ny;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  // 二分ヒープ([dist, cell] ペアを平置き。decrease-key の代わりに重複pushするため 8n+α 確保)
  const heap = new Float64Array(2 * (8 * n + 16));
  let hn = 0;
  const push = (d, k) => {
    let i = ++hn;
    while (i > 1) {
      const p = i >> 1;
      if (heap[2 * p] <= d) break;
      heap[2 * i] = heap[2 * p]; heap[2 * i + 1] = heap[2 * p + 1];
      i = p;
    }
    heap[2 * i] = d; heap[2 * i + 1] = k;
  };
  const pop = () => {
    const top = [heap[2], heap[3]];
    const d = heap[2 * hn], k = heap[2 * hn + 1];
    hn--;
    let i = 1;
    while (2 * i <= hn) {
      let c = 2 * i;
      if (c < hn && heap[2 * (c + 1)] < heap[2 * c]) c++;
      if (heap[2 * c] >= d) break;
      heap[2 * i] = heap[2 * c]; heap[2 * i + 1] = heap[2 * c + 1];
      i = c;
    }
    heap[2 * i] = d; heap[2 * i + 1] = k;
    return top;
  };
  for (const s of sources) {
    if (walk[s] && dist[s] > 0) { dist[s] = 0; push(0, s); }
  }
  const D = cs, Dd = Math.SQRT2 * cs;
  while (hn > 0) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
        const kk = jj * nx + ii;
        if (!walk[kk]) continue;
        const nd = d + (di !== 0 && dj !== 0 ? Dd : D);
        if (nd < dist[kk]) { dist[kk] = nd; parent[kk] = k; push(nd, kk); }
      }
    }
  }
  return { dist, parent };
}

// ユニット矩形へのアクセス点(到達可能な最近傍歩行セル)。null = 到達不能
function accessPoint(grid, dist, rect, reach = 650) {
  let best = null;
  for (const k of cellsInRect(grid, rect, reach)) {
    if (dist[k] < Infinity && (!best || dist[k] < best.d)) best = { d: dist[k], k };
  }
  return best;
}

// 経路を遡って最小クリアランス(=最狭部の半幅)を返す
function pathMinClearance(grid, parent, k0) {
  let k = k0, m = grid.clear[k];
  let guard = grid.nx * grid.ny;
  while (parent[k] >= 0 && guard-- > 0) {
    k = parent[k];
    if (grid.clear[k] < m) m = grid.clear[k];
  }
  return m;
}
