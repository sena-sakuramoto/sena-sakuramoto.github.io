# -*- coding: utf-8 -*-
"""飲食店レイアウト・エンジン(CADベース理解版) — 純Python・Rhino非依存。

入力は「既存CADから読んだ実寸の幾何」: 内壁境界・窓・PS(パイプスペース)・柱・入口・(任意で確定済み厨房)。
出力は席・什器・通路(階層付き)の幾何要素。Rhino側(GHPython)はこのコアを呼ぶだけ。

座標系: CADの座標をそのまま使用(原点正規化しない)。単位 mm。
通路は単一値でなく階層で扱う:
  main    : 主要客導線/避難経路(入口→各席エリア)
  service : 配膳サービス動線(スタッフ)
  pass    : 席間の客通り抜け
  chair   : 椅子引き代(通路と兼用しない着席側)
"""

import math

# ---- 寸法ルール(実務調査値, mm) -------------------------------------------
FURN = {
    "table2": (600, 700, 2, "2人"),
    "table4": (1200, 750, 4, "4人"),   # 600×2連結運用
    "table6": (1800, 750, 6, "6人"),
    "chair": (420, 420),
    "chair_zone": 450,
    "counter_top": 450, "stool": 600,
    "dishup": 600,
    "bench_depth": 500, "bench_tableD": 700, "bench_zoneD": 1650,
    "bench_mod4": 1500, "bench_mod2": 750, "bench_gap": 300, "bench_min_wall": 1800,
}
CLEAR = {"main": 1000, "service": 800, "pass": 600, "chair": 500}
WC = dict(boothW=900, boothD=1500, urinalP=750, urinalD=400,
          lavW=900, lavD=550, corridor=900, bfW=2000, bfD=2000)

BIZ = {
    "izakaya":    dict(kitchen=0.30, mix4=0.60, sptsubo=2.5, main=1000, service=800, gap=600, counter=True, pitch=650),
    "cafe":       dict(kitchen=0.20, mix4=0.30, sptsubo=1.8, main=1000, service=750, gap=550, counter=True, pitch=600),
    "restaurant": dict(kitchen=0.35, mix4=0.55, sptsubo=1.5, main=1200, service=800, gap=700, counter=False, pitch=650),
    "ramen":      dict(kitchen=0.20, mix4=0.25, sptsubo=2.5, main=1000, service=750, gap=550, counter=True, pitch=600),
}


# ---- 幾何ユーティリティ -----------------------------------------------------
def area(pts):
    s = 0.0
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        s += a[0] * b[1] - b[0] * a[1]
    return s / 2.0


def ccw(pts):
    return pts[:] if area(pts) >= 0 else pts[::-1]


def bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return dict(x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys),
                w=max(xs) - min(xs), h=max(ys) - min(ys))


def centroid(pts):
    a = area(pts)
    if abs(a) < 1e-9:
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    cx = cy = 0.0
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        f = p[0] * q[1] - q[0] * p[1]
        cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f
    return (cx / (6 * a), cy / (6 * a))


def pt_in_poly(x, y, pts):
    c = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            c = not c
        j = i
    return c


def _cross(ox, oy, ax, ay, bx, by):
    return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox)


def segs_cross(p, q, r, s):
    d1 = _cross(r[0], r[1], s[0], s[1], p[0], p[1])
    d2 = _cross(r[0], r[1], s[0], s[1], q[0], q[1])
    d3 = _cross(p[0], p[1], q[0], q[1], r[0], r[1])
    d4 = _cross(p[0], p[1], q[0], q[1], s[0], s[1])
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def rect_corners(r):
    return [(r["x"], r["y"]), (r["x"] + r["w"], r["y"]),
            (r["x"] + r["w"], r["y"] + r["h"]), (r["x"], r["y"] + r["h"])]


def rect_in_poly(r, poly, eps=3.0):
    x0, y0 = r["x"] + eps, r["y"] + eps
    x1, y1 = r["x"] + r["w"] - eps, r["y"] + r["h"] - eps
    if x1 <= x0 or y1 <= y0:
        return False
    cs = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for c in cs:
        if not pt_in_poly(c[0], c[1], poly):
            return False
    edges = [(cs[0], cs[1]), (cs[1], cs[2]), (cs[2], cs[3]), (cs[3], cs[0])]
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        for e in edges:
            if segs_cross(e[0], e[1], a, b):
                return False
        if x0 < a[0] < x1 and y0 < a[1] < y1:
            return False
    return True


def rects_overlap(a, b, pad=0.0):
    return (a["x"] < b["x"] + b["w"] + pad and b["x"] - pad < a["x"] + a["w"]
            and a["y"] < b["y"] + b["h"] + pad and b["y"] - pad < a["y"] + a["h"])


def clip_half(pts, axis, val, keep_below):
    idx = 0 if axis == "x" else 1
    out = []
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        ia = (a[idx] <= val) if keep_below else (a[idx] >= val)
        ib = (b[idx] <= val) if keep_below else (b[idx] >= val)
        if ia:
            out.append(a)
        if ia != ib:
            t = (val - a[idx]) / (b[idx] - a[idx])
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def clip_rect_poly(poly, r):
    p = clip_half(poly, "x", r["x"], False)
    if len(p) < 3: return []
    p = clip_half(p, "x", r["x"] + r["w"], True)
    if len(p) < 3: return []
    p = clip_half(p, "y", r["y"], False)
    if len(p) < 3: return []
    p = clip_half(p, "y", r["y"] + r["h"], True)
    return p if len(p) >= 3 else []


def dist_pt_seg(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / L2))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))


def dist_pt_polyline(px, py, pts):
    return min(dist_pt_seg(px, py, pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))


def poly_to_rect(pts):
    bb = bbox(pts)
    return dict(x=bb["x0"], y=bb["y0"], w=bb["w"], h=bb["h"])


def rect_poly(r):
    return [(r["x"], r["y"]), (r["x"] + r["w"], r["y"]),
            (r["x"] + r["w"], r["y"] + r["h"]), (r["x"], r["y"] + r["h"])]


# ---- 便器数(席数→器具)。法定の席数基準は無く、労安規則下限+事務所レベル1換算 -----
def toilet_plan(seats, area_m2=0):
    if seats <= 30 and area_m2 < 100:
        return dict(shared=1, female=0, male=0, urinal=0,
                    label=u"男女共用1(独立個室型)")
    mb = max(1, math.ceil(seats / 80.0))
    ur = max(1, math.ceil(seats / 60.0))
    fb = max(1, math.ceil(seats / 40.0))
    return dict(shared=0, female=fb, male=mb, urinal=ur,
                label=u"男 大%d・小%d / 女 %d" % (mb, ur, fb))


# ---- 入口・PSから厨房面の向きを決める -------------------------------------
def _side_of(pt, bb):
    d = {"S": pt[1] - bb["y0"], "N": bb["y1"] - pt[1],
         "W": pt[0] - bb["x0"], "E": bb["x1"] - pt[0]}
    return min(d, key=d.get)


def _band_rect(orient, face, bb):
    if orient == "N": return dict(x=bb["x0"], y=face, w=bb["w"], h=bb["y1"] - face)
    if orient == "S": return dict(x=bb["x0"], y=bb["y0"], w=bb["w"], h=face - bb["y0"])
    if orient == "E": return dict(x=face, y=bb["y0"], w=bb["x1"] - face, h=bb["h"])
    return dict(x=bb["x0"], y=bb["y0"], w=face - bb["x0"], h=bb["h"])  # W


def _strip(orient, face, off, depth, a0, a1):
    """厨房面から客席側へ off だけ寄った位置の帯矩形(a0..a1 は面方向の区間)。"""
    if orient == "N": return dict(x=a0, y=face - off - depth, w=a1 - a0, h=depth)
    if orient == "S": return dict(x=a0, y=face + off, w=a1 - a0, h=depth)
    if orient == "E": return dict(x=face - off - depth, y=a0, w=depth, h=a1 - a0)
    return dict(x=face + off, y=a0, w=depth, h=a1 - a0)  # W


def _find_run(orient, face, off, depth, boundary, bb, blocks, step=100):
    """厨房面に沿って、帯矩形が境界内かつ blocks に当たらない最長区間 (a0,a1) を返す。"""
    start, end = (bb["x0"], bb["x1"]) if orient in ("N", "S") else (bb["y0"], bb["y1"])
    best = None; s = None; a = start
    while a <= end - step:
        r = _strip(orient, face, off, depth, a, a + step)
        ok = rect_in_poly(r, boundary) and not any(rects_overlap(r, bl, bl.get("pad", 0)) for bl in blocks)
        if ok:
            if s is None: s = a
        elif s is not None:
            if best is None or a - s > best[1] - best[0]: best = (s, a)
            s = None
        a += step
    if s is not None and (best is None or end - s > best[1] - best[0]):
        best = (s, end)
    return best


def _solve_kitchen(boundary, bb, orient, target):
    def region(d):
        if orient == "N": return clip_half(boundary, "y", bb["y1"] - d, False)
        if orient == "S": return clip_half(boundary, "y", bb["y0"] + d, True)
        if orient == "E": return clip_half(boundary, "x", bb["x1"] - d, False)
        return clip_half(boundary, "x", bb["x0"] + d, True)
    span = bb["h"] if orient in ("N", "S") else bb["w"]
    lo, hi = 2500.0, max(2600.0, span * 0.6)
    if len(region(hi)) < 3 or abs(area(region(hi))) < target:
        lo = hi
    else:
        for _ in range(36):
            mid = (lo + hi) / 2
            r = region(mid)
            if len(r) >= 3 and abs(area(r)) < target:
                lo = mid
            else:
                hi = mid
    d = round(lo)
    face = (bb["y1"] - d if orient == "N" else bb["y0"] + d if orient == "S"
            else bb["x1"] - d if orient == "E" else bb["x0"] + d)
    return d, region(d), face


def _inward_normal(seg, boundary):
    a, b = seg
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    if L < 1: return (0, 0)
    u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    for n in [(-u[1], u[0]), (u[1], -u[0])]:
        if pt_in_poly(mid[0] + n[0] * 50, mid[1] + n[1] * 50, boundary):
            return n
    return (-u[1], u[0])


# ---- メイン生成 -------------------------------------------------------------
def generate(base, params):
    P = dict(BIZ.get(params.get("biz", "izakaya"), BIZ["izakaya"]))
    P.update({k: params[k] for k in
              ("kitchen", "mix4", "main", "service", "gap", "counter", "pitch")
              if k in params})
    bf = bool(params.get("bf", False))
    staff = int(params.get("staff", 4))
    n6 = int(params.get("n6", 0))
    bench_on = bool(params.get("bench", True))

    boundary = ccw([(float(p[0]), float(p[1])) for p in base["boundary"]])
    bb = bbox(boundary)
    gross = abs(area(boundary))
    windows = [tuple(map(tuple, w)) for w in base.get("windows", [])]
    columns = [poly_to_rect(c) for c in base.get("columns", [])]
    ps_list = [poly_to_rect(c) for c in base.get("ps", [])]
    holes = columns + ps_list
    ent = base.get("entrance")
    ent_seg = (tuple(ent[0]), tuple(ent[1])) if ent else \
        ((bb["x0"] + bb["w"] * 0.6, bb["y0"]), (bb["x0"] + bb["w"] * 0.9, bb["y0"]))
    ent_c = ((ent_seg[0][0] + ent_seg[1][0]) / 2, (ent_seg[0][1] + ent_seg[1][1]) / 2)
    ent_side = _side_of(ent_c, bb)

    els = []
    warn = []
    els.append(dict(layer="WALL", kind="poly", pts=boundary))
    for w in windows:
        els.append(dict(layer="WINDOW", kind="seg", a=w[0], b=w[1]))
    for c in base.get("columns", []):
        els.append(dict(layer="COLUMN", kind="poly", pts=c))
    for c in base.get("ps", []):
        els.append(dict(layer="PS", kind="poly", pts=c, label="PS"))

    # 窓のある辺(向き集合)— 厨房はここを避ける
    win_sides = set(_side_of(((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2), bb) for s in windows)

    # --- 厨房の向き: PSに近く、入口辺・窓辺を避ける ---
    if base.get("kitchen"):
        kpoly = ccw([tuple(p) for p in base["kitchen"]])
        kc = centroid(kpoly)
        orient = _side_of(kc, bb)
        kbb = bbox(kpoly)
        face = (kbb["y0"] if orient == "N" else kbb["y1"] if orient == "S"
                else kbb["x0"] if orient == "E" else kbb["x1"])
    else:
        ps_c = centroid(base["ps"][0]) if ps_list else None
        best, bestsc = "N", 1e18
        for o in ("N", "S", "E", "W"):
            band = _band_rect(o, _solve_kitchen(boundary, bb, o, P["kitchen"] * gross)[2], bb)
            bc = (band["x"] + band["w"] / 2, band["y"] + band["h"] / 2)
            sc = (math.hypot(bc[0] - ps_c[0], bc[1] - ps_c[1]) if ps_c else
                  (0 if o != ent_side else 1e6))
            if o == ent_side: sc += 1e7
            if o in win_sides: sc += 4e6
            if sc < bestsc: bestsc, best = sc, o
        orient = best
        _, kpoly, face = _solve_kitchen(boundary, bb, orient, P["kitchen"] * gross)

    kitchen_area = abs(area(kpoly)) if len(kpoly) >= 3 else 0
    kel = dict(layer="KITCHEN", kind="poly", pts=kpoly, label="")
    els.append(kel)
    band = _band_rect(orient, face, bb)
    axis_full = (bb["x0"], bb["x1"]) if orient in ("N", "S") else (bb["y0"], bb["y1"])

    # 厨房内ゾーニング(面に沿って 仕込→加熱→洗浄)
    for f0, f1, lab in [(0.0, 0.30, u"下処理・冷蔵"), (0.30, 0.70, u"加熱・盛付"), (0.70, 1.0, u"洗浄・下膳")]:
        a0 = axis_full[0] + (axis_full[1] - axis_full[0]) * f0
        a1 = axis_full[0] + (axis_full[1] - axis_full[0]) * f1
        sub = dict(x=band["x"], y=band["y"], w=band["w"], h=band["h"])
        if orient in ("N", "S"): sub["x"], sub["w"] = a0, a1 - a0
        else: sub["y"], sub["h"] = a0, a1 - a0
        cp = clip_rect_poly(kpoly, sub)
        if len(cp) >= 3 and abs(area(cp)) > 2e6:
            els.append(dict(layer="KZONE", kind="poly", pts=cp, label=lab))

    reserved = [dict(r, pad=0) for r in holes]
    placed = []  # 席ユニット {rect, seats, kind}

    # --- デシャップ → カウンター → サービス通路(厨房面の最長有効区間に沿って) ---
    off = 0
    dishup_rect = None
    col_blocks = [dict(r, pad=150) for r in holes]
    if params.get("dishup", True):
        run = _find_run(orient, face, off, FURN["dishup"], boundary, bb, col_blocks)
        if run and run[1] - run[0] > 2200:
            r = _strip(orient, face, off, FURN["dishup"], run[0] + 200, run[1] - 1000)
            dishup_rect = r
            els.append(dict(layer="DISHUP", kind="rect", **r, label=u"デシャップ"))
            reserved.append(dict(r, pad=0)); off += FURN["dishup"]
    counter_seats = 0
    if P["counter"]:
        depth = FURN["counter_top"] + FURN["stool"]
        run = _find_run(orient, face, off, depth, boundary, bb, col_blocks)
        if run and run[1] - run[0] > 2000:
            a0, a1 = run[0] + 500, run[1] - 1000
            span = a1 - a0
            counter_seats = max(0, int(span // P["pitch"]))
            if counter_seats > 0:
                full = _strip(orient, face, off, depth, a0, a1)
                top = _strip(orient, face, off, FURN["counter_top"], a0, a1)
                els.append(dict(layer="COUNTER", kind="rect", **top, label=u"カウンター%d" % counter_seats))
                # スツール
                stool = _strip(orient, face, off + FURN["counter_top"] + 90, FURN["chair"][1], a0, a1)
                reserved.append(dict(full, pad=0))
                placed.append(dict(rect=full, seats=counter_seats, kind="counter"))
                off += depth
    # サービス通路(厨房前の横断動線)— 面の有効全長に
    srun = _find_run(orient, face, off, P["service"], boundary, bb, col_blocks)
    if srun:
        serv = _strip(orient, face, off, P["service"], srun[0], srun[1])
        cp = clip_rect_poly(boundary, serv)
        if len(cp) >= 3:
            els.append(dict(layer="AISLE_SERVICE", kind="poly", pts=cp, label=u"配膳%d" % P["service"]))
        reserved.append(dict(serv, pad=0))
    off += P["service"]
    band_used = _band_rect(orient, (face - off if orient == "N" else face + off if orient == "S"
                                    else face - off if orient == "E" else face + off), bb)
    reserved.append(dict(band_used, pad=0))  # 厨房〜サービス帯は客席不可

    # --- WC: PS隣接(給排水共用)・前室付き ---
    wcp = toilet_plan(40, gross / 1e6)  # 仮席数で寸法 → 後で確定
    def wc_size(plan):
        w = max(1800, (plan["shared"] + plan["female"] + plan["male"]) * WC["boothW"]
                + plan["urinal"] * WC["urinalP"] + (WC["bfW"] if bf else 0) + WC["lavW"])
        d = max(WC["boothD"], WC["bfD"] if bf else 0) + WC["corridor"]
        return w, d
    wcW, wcD = wc_size(wcp)
    anchor = None
    if ps_list:
        p0 = ps_list[0]
        anchor = (p0["x"], p0["y"])
    else:
        far = max([("S", bb["y0"]), ("N", bb["y1"]), ("W", bb["x0"]), ("E", bb["x1"])],
                  key=lambda s: abs((s[1]) - (ent_c[1] if s[0] in ("N", "S") else ent_c[0])))
        anchor = (bb["x0"], bb["y1"] - wcD)
    wc_rect = None; bestd = 1e18
    for gy in range(int(bb["y0"]), int(bb["y1"] - wcD) + 1, 250):
        for gx in range(int(bb["x0"]), int(bb["x1"] - wcW) + 1, 250):
            d2 = (gx - anchor[0]) ** 2 + (gy - anchor[1]) ** 2
            if d2 >= bestd: continue
            r = dict(x=gx, y=gy, w=wcW, h=wcD)
            if not rect_in_poly(r, boundary): continue
            if any(rects_overlap(r, q, q.get("pad", 0)) for q in reserved if q is not band_used): continue
            # 前室側(客席方向)に900の自由床
            free = [dict(x=r["x"], y=r["y"] - 900, w=r["w"], h=900),
                    dict(x=r["x"], y=r["y"] + r["h"], w=r["w"], h=900),
                    dict(x=r["x"] - 900, y=r["y"], w=900, h=r["h"]),
                    dict(x=r["x"] + r["w"], y=r["y"], w=900, h=r["h"])]
            if not any(rect_in_poly(f, boundary) and not rects_overlap(f, band_used, 0) for f in free):
                continue
            wc_rect = r; bestd = d2
    if not wc_rect:
        wc_rect = dict(x=anchor[0], y=anchor[1], w=wcW, h=wcD)
        warn.append(u"WCが収まりません(PS位置・寸法を確認)")
    els.append(dict(layer="WC", kind="rect", **wc_rect, label=u"WC"))
    reserved.append(dict(wc_rect, pad=600))
    # WC器具(ブース/小便器/手洗い)
    flip = (wc_rect["y"] + wc_rect["h"] / 2) > (bb["y0"] + bb["h"] / 2)
    ox = 0
    def put_fix(w, d, lab):
        nonlocal ox
        y = wc_rect["y"] + wc_rect["h"] - d if flip else wc_rect["y"]
        els.append(dict(layer="WC", kind="rect", x=wc_rect["x"] + ox, y=y, w=w, h=d, label=lab))
        ox += w
    for _ in range(wcp["shared"]): put_fix(WC["boothW"], WC["boothD"], u"共")
    for _ in range(wcp["female"]): put_fix(WC["boothW"], WC["boothD"], u"女")
    if bf: put_fix(WC["bfW"], WC["bfD"], u"多目的")
    put_fix(WC["lavW"], WC["lavD"], u"手洗")
    for _ in range(wcp["male"]): put_fix(WC["boothW"], WC["boothD"], u"男")
    for _ in range(wcp["urinal"]): put_fix(WC["urinalP"], WC["urinalD"], u"小")

    # WCが厨房帯に食い込む分を控除
    ov = clip_rect_poly(kpoly, wc_rect)
    if len(ov) >= 3:
        kitchen_area -= abs(area(ov))
    kel["label"] = u"厨房 %.1f㎡" % (kitchen_area / 1e6)

    # --- 入口前室・レジ ---
    ent_fore = dict(x=ent_c[0] - 1000, y=bb["y0"] if ent_side == "S" else ent_c[1] - 750,
                    w=2000, h=1500)
    if ent_side == "S": ent_fore = dict(x=ent_c[0] - 1000, y=bb["y0"], w=2000, h=1500)
    elif ent_side == "N": ent_fore = dict(x=ent_c[0] - 1000, y=bb["y1"] - 1500, w=2000, h=1500)
    elif ent_side == "W": ent_fore = dict(x=bb["x0"], y=ent_c[1] - 1000, w=1500, h=2000)
    else: ent_fore = dict(x=bb["x1"] - 1500, y=ent_c[1] - 1000, w=1500, h=2000)
    els.append(dict(layer="ENTRANCE", kind="rect", **ent_fore, label=u"入口・待合"))
    reserved.append(dict(ent_fore, pad=300))
    for rr in [dict(x=ent_fore["x"] + ent_fore["w"] + 150, y=ent_fore["y"], w=900, h=600),
               dict(x=ent_fore["x"] - 150 - 900, y=ent_fore["y"], w=900, h=600)]:
        if rect_in_poly(rr, boundary) and not any(rects_overlap(rr, q, q.get("pad", 0)) for q in reserved):
            els.append(dict(layer="REGI", kind="rect", **rr, label=u"レジ"))
            reserved.append(dict(rr, pad=300)); break

    # --- 窓沿いベンチ(バンケット): 窓辺は優先席 ---
    if bench_on:
        BZ = FURN
        for seg in windows:
            sd = _side_of(((seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2), bb)
            if sd == orient or sd == ent_side:
                continue  # 厨房側・入口側の窓には置かない
            a, b = seg
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if L < BZ["bench_min_wall"]: continue
            u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
            n = _inward_normal(seg, boundary)
            t = 150
            while t < L - BZ["bench_mod2"]:
                done = False
                for modW, seats in [(BZ["bench_mod4"], 4), (BZ["bench_mod2"], 2)]:
                    if t + modW > L - 150: continue
                    def piece(o0, dep, t0, t1):
                        p0 = (a[0] + u[0] * t0 + n[0] * o0, a[1] + u[1] * t0 + n[1] * o0)
                        p1 = (a[0] + u[0] * t1 + n[0] * (o0 + dep), a[1] + u[1] * t1 + n[1] * (o0 + dep))
                        return dict(x=min(p0[0], p1[0]), y=min(p0[1], p1[1]),
                                    w=abs(p1[0] - p0[0]), h=abs(p1[1] - p0[1]))
                    full = piece(0, BZ["bench_zoneD"], t, t + modW)
                    if not rect_in_poly(full, boundary): continue
                    if any(rects_overlap(full, q, q.get("pad", 0)) for q in reserved): continue
                    if any(rects_overlap(full, q["rect"], 0) for q in placed): continue
                    els.append(dict(layer="BENCH", kind="rect", **piece(0, BZ["bench_depth"], t, t + modW)))
                    els.append(dict(layer="TABLE", kind="rect", label=("B4" if seats == 4 else "B2"),
                                    **piece(BZ["bench_depth"], BZ["bench_tableD"], t + 30, t + modW - 30)))
                    nc = seats // 2
                    for c in range(nc):
                        cc = t + (modW / nc) * (c + 0.5) - FURN["chair"][0] / 2
                        els.append(dict(layer="CHAIR", kind="rect",
                                        **piece(BZ["bench_depth"] + BZ["bench_tableD"] + 20, FURN["chair"][1], cc, cc + FURN["chair"][0])))
                    placed.append(dict(rect=full, seats=seats, kind="bench"))
                    t += modW + BZ["bench_gap"]; done = True; break
                if not done: t += 250

    # --- メイン客導線(入口→奥) ---
    spine = None
    if orient in ("N", "S"):  # 厨房が上下 → 客席はx方向に広がる、spineはy方向
        sx = min(max(ent_c[0] - P["main"] / 2, bb["x0"]), bb["x1"] - P["main"])
        spine = dict(x=sx, y=bb["y0"], w=P["main"], h=bb["h"])
    else:
        sy = min(max(ent_c[1] - P["main"] / 2, bb["y0"]), bb["y1"] - P["main"])
        spine = dict(x=bb["x0"], y=sy, w=bb["w"], h=P["main"])
    cp = clip_rect_poly(boundary, spine)
    if len(cp) >= 3:
        els.append(dict(layer="AISLE_MAIN", kind="poly", pts=cp, label=u"主通路%d" % P["main"]))
    reserved.append(dict(spine, pad=0))

    # --- フィールドテーブル(行充填・通路階層) ---
    t4 = FURN["table4"]; row_mod = t4[1] + FURN["chair_zone"] * 2
    n6left = max(0, n6)
    s4 = s2 = s6 = 0
    rows_y = []
    y = bb["y0"] + 200
    while y + row_mod <= bb["y1"]:
        rows_y.append(y); y += row_mod + P["service"]
    seats6 = seats4 = seats2 = 0
    n6c = n4c = n2c = nbench = 0
    for q in placed:
        if q["kind"] == "bench":
            nbench += 1; (None)
    bench_seats = sum(q["seats"] for q in placed if q["kind"] == "bench")

    def fits(r):
        if not rect_in_poly(r, boundary): return False
        if any(rects_overlap(r, q, q.get("pad", 0)) for q in reserved): return False
        for q in placed:
            pad = (CLEAR["pass"] if q["kind"] == "bench" else 0)
            if rects_overlap(r, q["rect"], pad): return False
        return True

    for ry in rows_y:
        x = bb["x0"] + 200
        gap_band = dict(x=bb["x0"], y=ry + row_mod, w=bb["w"], h=P["service"])
        while x < bb["x1"] - FURN["table2"][0]:
            if n6left > 0: cand = "table6"
            else:
                ts = s4 + s2 + s6
                cand = "table4" if (ts == 0 and P["mix4"] >= 0.5) or (ts > 0 and (s4 + s6) / ts < P["mix4"]) else "table2"
            trylist = {"table2": ["table2"], "table4": ["table4", "table2"],
                       "table6": ["table6", "table4", "table2"]}[cand]
            put = None
            for tk in trylist:
                tw, td, ts2, lab = FURN[tk]
                r = dict(x=x, y=ry, w=tw, h=row_mod)
                if x + tw <= bb["x1"] and fits(r):
                    put = (tk, tw, td, ts2, lab); break
            if put:
                tk, tw, td, ts2, lab = put
                ty = ry + FURN["chair_zone"] + (t4[1] - td) / 2
                els.append(dict(layer="TABLE", kind="rect", x=x, y=ty, w=tw, h=td, label=lab))
                if tk in ("table4", "table6"):
                    sx = 600
                    while sx < tw - 10:
                        els.append(dict(layer="TABLE", kind="rect", x=x + sx - 5, y=ty, w=10, h=td))
                        sx += 600
                per = ts2 // 2
                for s in range(per):
                    cx = x + (tw / per) * (s + 0.5) - FURN["chair"][0] / 2
                    els.append(dict(layer="CHAIR", kind="rect", x=cx, y=ty - FURN["chair"][1] - 20, w=FURN["chair"][0], h=FURN["chair"][1]))
                    els.append(dict(layer="CHAIR", kind="rect", x=cx, y=ty + td + 20, w=FURN["chair"][0], h=FURN["chair"][1]))
                wall = dist_pt_polyline(x + tw / 2, ry + row_mod / 2, boundary) < 1400
                placed.append(dict(rect=dict(x=x, y=ry, w=tw, h=row_mod), seats=ts2, kind="field"))
                if tk == "table6": seats6 += 6; n6c += 1; n6left -= 1; s6 += 6
                elif tk == "table4": seats4 += 4; n4c += 1; s4 += 4
                else: seats2 += 2; n2c += 1; s2 += 2
                x += tw + P["gap"]
            else:
                x += 250
        # 行間ギャップを通路として明示(配膳/客通り抜け)
        cpg = clip_rect_poly(boundary, gap_band)
        cpg = [p for p in [cpg] if len(p) >= 3]

    total = seats6 + seats4 + seats2 + bench_seats + counter_seats
    wc_final = toilet_plan(total, gross / 1e6)
    tsubo = gross / 1e6 / 3.30578
    seat_zone = max(0, (gross - kitchen_area - wc_rect["w"] * wc_rect["h"]) / 1e6)
    aps = (seat_zone / total) if total else 0
    if total and aps < 0.9:
        warn.append(u"席あたり%.2f㎡ — 実務最小0.9㎡未満(詰めすぎ)" % aps)
    warn.append(u"通路は階層管理(主%d/配膳%d/通抜%d/椅子%d mm)。実寸はCADベースに従う。"
                % (P["main"], P["service"], CLEAR["pass"], CLEAR["chair"]))

    metrics = dict(total=total, seats6=seats6, seats4=seats4, seats2=seats2,
                   bench=bench_seats, counter=counter_seats,
                   n6=n6c, n4=n4c, n2=n2c,
                   kitchen_m2=kitchen_area / 1e6, area_m2=gross / 1e6, tsubo=tsubo,
                   sptsubo=total / tsubo if tsubo else 0, aps=aps,
                   wc=wc_final["label"], orient=orient, target_sptsubo=P["sptsubo"])
    return dict(elements=els, metrics=metrics, warnings=warn, bbox=bb)
