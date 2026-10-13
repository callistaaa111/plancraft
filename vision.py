"""Image work for the plan tools: finding repeated symbols (auto count) and tinted page images (revision overlay).

Needs OpenCV (opencv-python-headless) and numpy.
"""
from __future__ import annotations

from pathlib import Path

TINTS = {"red": (210, 25, 25), "green": (0, 150, 60)}     # RGB; multiplied together they make black
TINT_MAX_SIDE = 5000
MAX_TEMPLATE = 700                                       # px; a symbol bigger than this is not a symbol


def _cv():
    try:
        import cv2
        import numpy as np
    except ImportError:
        raise ValueError("Auto count and overlays need OpenCV. Run: python -m pip install opencv-python-headless numpy")
    return cv2, np


def read_gray(path: Path):
    cv2, np = _cv()
    data = np.fromfile(str(path), dtype=np.uint8)          # imread can't open non-ASCII paths on Windows
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("Could not read the page image.")
    return img


def _box(rect, W, H, what):
    try:
        x, y, w, h = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError(f"The {what} is not valid.")
    x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
    x1, y1 = min(W, int(round(x + w))), min(H, int(round(y + h)))
    return x0, y0, x1, y1


def find_symbols(path: Path, rect, rotations: bool = False, min_score: float = 0.4, limit: int = 5000,
                 method: str = "auto", area=None) -> dict:
    """Places that look like the symbol inside rect = [x, y, w, h] (page pixels).

    method: "shape" compares the whole boxed picture (good for distinct symbols like a circled J), "dots" looks for
    solid dots of the same size sitting on wires (light fixtures drawn as dots), "auto" picks one from the box.
    area: optional [x, y, w, h] to search only part of the page.
    Returns {"matches": [[cx, cy, score], ...] best first, "size": [w, h], "method": used}. score is 0..1.
    """
    cv2, np = _cv()
    img = read_gray(path)
    H, W = img.shape
    x0, y0, x1, y1 = _box(rect, W, H, "search box")
    if x1 - x0 < 4 or y1 - y0 < 4:
        raise ValueError("Draw the box around one symbol.")
    if max(x1 - x0, y1 - y0) > MAX_TEMPLATE:
        raise ValueError("That box is too big. Draw it tightly around one symbol.")
    tpl = img[y0:y1, x0:x1]
    if float(tpl.std()) < 3:
        raise ValueError("The box looks empty. Draw it around a symbol.")
    ax0, ay0, ax1, ay1 = _box(area, W, H, "search area") if area else (0, 0, W, H)
    if ax1 - ax0 < x1 - x0 or ay1 - ay0 < y1 - y0:
        raise ValueError("The search area is smaller than the symbol.")

    dot = _dot_template(img, (x0, y0, x1, y1))
    if method not in ("shape", "dots"):
        method = "dots" if dot and dot["dotlike"] else "shape"
    if method == "dots":
        if not dot:
            raise ValueError("No solid dot found in the box. Use the Shape method for this symbol.")
        candidates = _find_dots(img, dot, (ax0, ay0, ax1, ay1), min_score)
        min_d = max(4.0, dot["R"] * 1.6)
    else:
        candidates = _find_shapes(img, tpl, (ax0, ay0, ax1, ay1), rotations, min_score)
        min_d = max(4.0, min(x1 - x0, y1 - y0) * 0.6)
    candidates.sort(reverse=True)

    # keep the best match in each neighbourhood (grid-bucketed non-maximum suppression)
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    kept = []
    for sc, cx, cy in candidates:
        gx, gy = int(cx // min_d), int(cy // min_d)
        clash = any((kx - cx) ** 2 + (ky - cy) ** 2 < min_d * min_d
                    for dx in (-1, 0, 1) for dy in (-1, 0, 1) for kx, ky in grid.get((gx + dx, gy + dy), ()))
        if clash:
            continue
        grid.setdefault((gx, gy), []).append((cx, cy))
        kept.append([round(cx, 2), round(cy, 2), round(sc, 4)])
        if len(kept) >= limit:
            break
    return {"matches": kept, "size": [x1 - x0, y1 - y0], "method": method}


def _find_shapes(img, tpl, area, rotations, min_score):
    """Normalised cross-correlation of the boxed picture over the search area."""
    cv2, np = _cv()
    ax0, ay0, ax1, ay1 = area
    region = img[ay0:ay1, ax0:ax1]
    templates = [tpl]
    if rotations:
        templates += [cv2.rotate(tpl, c) for c in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE)]
    out = []
    for t in templates:
        th, tw = t.shape
        if th > region.shape[0] or tw > region.shape[1]:
            continue
        res = cv2.matchTemplate(region, t, cv2.TM_CCOEFF_NORMED)
        res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
        k = max(3, (min(th, tw) // 2) | 1)
        peaks = (res >= cv2.dilate(res, np.ones((k, k), np.uint8))) & (res >= min_score)
        ys, xs = np.nonzero(peaks)
        scores = res[ys, xs]
        if len(scores) > 30000:
            keep = np.argsort(scores)[::-1][:30000]
            ys, xs, scores = ys[keep], xs[keep], scores[keep]
        out += zip(scores.tolist(), (xs + ax0 + tw / 2).tolist(), (ys + ay0 + th / 2).tolist())
    return out


# ---- dots on wires -----------------------------------------------------------------------------------------
# A light drawn as a filled dot on its circuit wire: a blob detector (Laplacian of Gaussian) tuned to the dot's size
# finds dot-like spots, then each one must be solid black in the middle (not dithered grey like a column, not text)
# and about as light around it as the boxed dot (so hatching and line crossings drop out).

# tuned on real lighting sheets (dithered PDFs with hatching, text and columns), see the comparison in the README
DOT_TUNING = {"fill": "raw", "local_ring": "either", "rays": False, "core_exp": 2}


def _disk(r):
    _, np = _cv()
    k = int(np.ceil(r))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    d = (xx * xx + yy * yy <= r * r).astype(np.float32)
    return d / d.sum()


def _ring(r0, r1):
    _, np = _cv()
    k = int(np.ceil(r1))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    rr = xx * xx + yy * yy
    d = ((rr >= r0 * r0) & (rr <= r1 * r1)).astype(np.float32)
    return d / d.sum()


def _dot_maps(gray, sigma):
    """LoG response, centre darkness, ring darkness and solid-black fraction for every pixel of gray."""
    cv2, np = _cv()
    R = sigma * 1.414
    inv = (255 - gray).astype(np.float32) / 255.0
    log = -cv2.Laplacian(cv2.GaussianBlur(inv, (0, 0), sigma), cv2.CV_32F, ksize=3) * sigma * sigma
    soft = cv2.GaussianBlur(inv, (0, 0), 1.0)                      # evens out dithering
    core = cv2.filter2D(soft, -1, _disk(max(1.0, R * 0.6)))
    ring = cv2.filter2D(soft, -1, _ring(R * 1.5, R * 2.3))
    outer = cv2.filter2D(soft, -1, _ring(R * 2.8, R * 3.8))          # the local background (paper or shading)
    # filled: share of the centre that is inked, solid black or dithered grey alike (text strokes and wire
    # crossings leave gaps)
    if DOT_TUNING["fill"] == "dithered":
        inked = (cv2.GaussianBlur(inv, (0, 0), 1.3) > 0.3).astype(np.float32)
    else:
        inked = (gray < 100).astype(np.float32)
    solid = cv2.filter2D(inked, -1, _disk(max(1.0, R * 0.7)))
    if DOT_TUNING["local_ring"] == "either":
        return log, core, np.stack([ring, ring - outer]), solid, soft
    return log, core, (ring - outer) if DOT_TUNING["local_ring"] else ring, solid, soft


def _thick_rays(soft, xs, ys, R):
    """How many of 16 directions leaving each point stay dark (a thin wire darkens 1-2, a thick letter stroke more)."""
    _, np = _cv()
    H, W = soft.shape
    ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    near = np.linspace(R * 1.5, R * 2.4, 4)
    far = np.linspace(R * 3.2, R * 4.2, 3)

    def sample(radii):
        dx = (np.cos(ang)[:, None] * radii[None, :])[None]
        dy = (np.sin(ang)[:, None] * radii[None, :])[None]
        px = np.clip(np.rint(xs[:, None, None] + dx).astype(int), 0, W - 1)
        py = np.clip(np.rint(ys[:, None, None] + dy).astype(int), 0, H - 1)
        return soft[py, px]                                   # (n, 16, len(radii))
    rays = sample(near).mean(axis=2)
    background = np.median(sample(far).reshape(len(xs), -1), axis=1)
    return ((rays - background[:, None]) > 0.35).sum(axis=1)


def _dot_template(img, box):
    """Size and look of the dot in the box, or None if there is no dot-like blob in it."""
    cv2, np = _cv()
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    H, W = img.shape
    pad = 40
    sx0, sy0, sx1, sy1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    sub = img[sy0:sy1, sx0:sx1]
    inv = (255 - sub).astype(np.float32) / 255.0
    best = None
    for sigma in np.arange(1.0, max(1.5, min(w, h) / 2.5), 0.5):
        log = -cv2.Laplacian(cv2.GaussianBlur(inv, (0, 0), float(sigma)), cv2.CV_32F, ksize=3) * sigma * sigma
        part = log[y0 - sy0:y1 - sy0, x0 - sx0:x1 - sx0]
        v = float(part.max())
        if v > 0 and (not best or v > best["resp"]):
            yy, xx = np.unravel_index(np.argmax(part), part.shape)
            best = {"resp": v, "sigma": float(sigma), "x": int(xx) + x0, "y": int(yy) + y0}
    if not best:
        return None
    log, core, ring, solid, soft = _dot_maps(sub, best["sigma"])
    px, py = best["x"] - sx0, best["y"] - sy0
    R = best["sigma"] * 1.414
    rays = int(_thick_rays(soft, np.array([px]), np.array([py]), R)[0])
    ring_t = ring[:, py, px].tolist() if ring.ndim == 3 else float(ring[py, px])
    best.update(R=R, core=float(core[py, px]), ring=ring_t, solid=float(solid[py, px]), rays=rays)
    # a light boxed on its own: a filled dot in the middle of the box, taking up a fair part of it
    off_centre = ((best["x"] - (x0 + w / 2)) ** 2 + (best["y"] - (y0 + h / 2)) ** 2) ** 0.5
    best["dotlike"] = (best["solid"] >= 0.45 and best["core"] >= 0.35
                       and 0.22 * min(w, h) <= 2 * R <= 0.8 * min(w, h) and off_centre <= 0.25 * min(w, h))
    return best


def _ring_excess(ring, ys, xs, ring_t):
    """How much darker the edge is than around the boxed dot (with two measures, the more forgiving one)."""
    _, np = _cv()
    if ring.ndim == 3:
        return np.minimum(ring[0, ys, xs] - ring_t[0], ring[1, ys, xs] - ring_t[1])
    return ring[ys, xs] - ring_t


def _find_dots(img, t, area, min_score):
    cv2, np = _cv()
    H, W = img.shape
    ax0, ay0, ax1, ay1 = area
    m = int(t["R"] * 3) + 4
    sx0, sy0, sx1, sy1 = max(0, ax0 - m), max(0, ay0 - m), min(W, ax1 + m), min(H, ay1 + m)
    log, core, ring, solid, soft = _dot_maps(img[sy0:sy1, sx0:sx1], t["sigma"])
    k = max(3, int(t["sigma"] * 3) | 1)
    peaks = (log >= cv2.dilate(log, np.ones((k, k), np.uint8))) & (log >= t["resp"] * 0.4)
    ys, xs = np.nonzero(peaks)
    gx, gy = xs + sx0, ys + sy0
    inside = (gx >= ax0) & (gx < ax1) & (gy >= ay0) & (gy < ay1)
    ys, xs, gx, gy = ys[inside], xs[inside], gx[inside], gy[inside]
    lr = log[ys, xs] / t["resp"]
    score = (np.minimum(core[ys, xs] / max(t["core"], 0.05), 1.0) ** DOT_TUNING["core_exp"]
             * np.minimum(solid[ys, xs] / max(t["solid"], 0.05), 1.0) ** 3
             * np.exp(-np.maximum(0, _ring_excess(ring, ys, xs, t["ring"]) - 0.03) * 12)
             * np.minimum(lr, 1 / lr) ** 0.5)
    pre = score >= min_score
    ys, xs, gx, gy, score = ys[pre], xs[pre], gx[pre], gy[pre], score[pre]
    if len(xs) and DOT_TUNING["rays"]:
        extra = np.maximum(0, _thick_rays(soft, xs, ys, t["R"]) - t["rays"] - 1)
        score = score * np.exp(-extra * 0.6)
    ok = score >= min_score
    return list(zip(score[ok].tolist(), gx[ok].astype(float).tolist(), gy[ok].astype(float).tolist()))


def tinted(path: Path, color: str, cache_dir: Path) -> Path:
    """The page's dark lines in one colour on a transparent background (cached), at most TINT_MAX_SIDE px."""
    cv2, np = _cv()
    if color not in TINTS:
        raise ValueError("Unknown overlay colour.")
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{path.stem}.{color}.png"
    if out.is_file() and out.stat().st_mtime >= path.stat().st_mtime:
        return out
    g = read_gray(path)
    h, w = g.shape
    f = min(1.0, TINT_MAX_SIDE / max(h, w))
    if f < 1:
        g = cv2.resize(g, (max(1, round(w * f)), max(1, round(h * f))), interpolation=cv2.INTER_AREA)
    alpha = np.clip((255 - g.astype(np.int16)) * 1.6, 0, 255).astype(np.uint8)
    rgba = np.zeros((*g.shape, 4), np.uint8)
    r, gr, b = TINTS[color]
    rgba[..., 0], rgba[..., 1], rgba[..., 2], rgba[..., 3] = b, gr, r, alpha      # OpenCV writes BGRA
    ok, buf = cv2.imencode(".png", rgba, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise ValueError("Could not make the overlay image.")
    tmp = out.with_suffix(".tmp")
    buf.tofile(str(tmp))
    tmp.replace(out)
    return out
