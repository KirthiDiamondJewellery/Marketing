"""Face-tracked framing for vertical reframes (16:9 or 4:3 → 9:16), without jitter.

1. Detections (5 fps, from `analysis.py`) are cleaned: misses are bridged, single-frame outliers (another face, a
   false positive) are rejected by an innovation gate.
2. A constant-velocity Kalman filter runs forward and a Rauch–Tung–Striebel smoother runs backward: zero lag, no
   overshoot, no frame-to-frame noise.
3. Per shot (one keep range, i.e. between two cuts) the camera is **static** unless the speaker really moves: if the
   smoothed path stays inside a dead zone (a fraction of the crop window), the shot holds the median position. A
   shot whose position is within the dead zone of the previous shot reuses it, so jump cuts don't add a reframe.
4. Moving shots get key positions every 0.4 s with the pan speed capped, and the renderer interpolates linearly
   between them per frame (ffmpeg `crop` with per-frame x/y).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..analysis import VideoAnalysis
from .face import Focus


@dataclass
class ShotFraming:
    src_f0: int  # source frames [f0, f1) of the keep range
    src_f1: int
    keys: list[tuple[int, float, float]]  # (source frame, x, y) as fractions; one key = a static shot
    found: bool

    @property
    def static(self) -> bool:
        return len(self.keys) <= 1

    def at(self, src_frame: int) -> tuple[float, float]:
        if len(self.keys) == 1:
            return self.keys[0][1], self.keys[0][2]
        fs = [k[0] for k in self.keys]
        x = float(np.interp(src_frame, fs, [k[1] for k in self.keys]))
        y = float(np.interp(src_frame, fs, [k[2] for k in self.keys]))
        return x, y


def kalman_smooth(
    values: np.ndarray,
    valid: np.ndarray,
    dt: float,
    *,
    accel_sigma: float = 0.6,
    meas_sigma: float = 0.02,
    gate: float = 4.0,
) -> np.ndarray:
    """Constant-velocity Kalman filter + RTS smoother on one axis. `valid` marks real measurements; others (misses)
    are predicted. Measurements whose innovation exceeds `gate` standard deviations are treated as misses."""
    n = len(values)
    if n == 0:
        return values
    F = np.array([[1.0, dt], [0.0, 1.0]])
    q = accel_sigma**2
    Q = q * np.array([[dt**4 / 4, dt**3 / 2], [dt**3 / 2, dt**2]])
    R = meas_sigma**2
    first = int(np.argmax(valid)) if valid.any() else 0
    x = np.array([values[first] if valid.any() else 0.5, 0.0])
    P = np.diag([0.05, 0.05])
    xs_f = np.zeros((n, 2))
    Ps_f = np.zeros((n, 2, 2))
    xs_p = np.zeros((n, 2))
    Ps_p = np.zeros((n, 2, 2))
    for i in range(n):
        if i > 0:
            x = F @ x
            P = F @ P @ F.T + Q
        xs_p[i], Ps_p[i] = x, P
        if valid[i]:
            s = P[0, 0] + R
            innov = values[i] - x[0]
            if innov * innov <= gate * gate * s:
                k = P[:, 0] / s
                x = x + k * innov
                P = P - np.outer(k, P[0, :])
        xs_f[i], Ps_f[i] = x, P
    xs = xs_f.copy()
    for i in range(n - 2, -1, -1):
        c = Ps_f[i] @ F.T @ np.linalg.inv(Ps_p[i + 1])
        xs[i] = xs_f[i] + c @ (xs[i + 1] - xs_p[i + 1])
    return xs[:, 0]


def smooth_track(analysis: VideoAnalysis) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(times, x, y, found) for every analysis frame, smoothed. Without any detection, x/y are the frame centre."""
    n = len(analysis.faces)
    t = np.arange(n) / analysis.fps
    valid = np.array([f is not None for f in analysis.faces], bool)
    if not valid.any():
        return t, np.full(n, 0.5), np.full(n, 0.38), valid
    xs = np.array([f.x if f else 0.0 for f in analysis.faces])
    ys = np.array([f.y if f else 0.0 for f in analysis.faces])
    dt = 1.0 / analysis.fps
    return t, kalman_smooth(xs, valid, dt), kalman_smooth(ys, valid, dt, accel_sigma=0.4), valid


def plan_shots(
    analysis: VideoAnalysis | None,
    keeps: list[tuple[int, int]],
    fps: int,
    *,
    window_w_frac: float,
    window_h_frac: float,
    track: bool = True,
    deadzone: float = 0.14,
    max_speed: float = 0.35,
    key_every_s: float = 0.4,
) -> list[ShotFraming]:
    """Framing for each keep range (source frames). `window_*_frac` is the crop window as a fraction of the source
    (it sets how much movement the dead zone tolerates). `max_speed` caps panning in source widths per second."""
    if analysis is None or not analysis.faces or not any(analysis.faces):
        return [ShotFraming(a, b, [(a, 0.5, 0.38)], False) for a, b in keeps]
    t, xs, ys, valid = smooth_track(analysis)
    gx, gy = float(np.median(xs[valid])), float(np.median(ys[valid]))
    dz_x = deadzone * window_w_frac
    dz_y = deadzone * window_h_frac
    out: list[ShotFraming] = []
    prev: tuple[float, float] | None = None
    for a, b in keeps:
        ta, tb = a / fps, b / fps
        sel = (t >= ta - 0.1) & (t <= tb + 0.1)
        if not sel.any():  # a shot shorter than one analysis frame: nearest sample
            i = int(np.clip(round(((ta + tb) / 2) * analysis.fps), 0, len(t) - 1))
            sel = np.zeros(len(t), bool)
            sel[i] = True
        found = bool(valid[sel].any())
        sx, sy = xs[sel], ys[sel]
        if not found:
            pos = prev or (gx, gy)
            out.append(ShotFraming(a, b, [(a, *pos)], False))
            prev = pos
            continue
        mx, my = float(np.median(sx)), float(np.median(sy))
        moving = track and (np.ptp(sx) > dz_x or np.ptp(sy) > dz_y)
        if not moving:
            if prev is not None and abs(prev[0] - mx) <= dz_x / 2 and abs(prev[1] - my) <= dz_y / 2:
                mx, my = prev  # hold the previous framing across the jump cut
            out.append(ShotFraming(a, b, [(a, mx, my)], True))
            prev = (mx, my)
            continue
        # Moving: keys every key_every_s, speed-limited.
        step = max(1, round(key_every_s * analysis.fps))
        idx = np.flatnonzero(sel)[::step]
        keys: list[tuple[int, float, float]] = []
        lx, ly, lt = float(sx[0]), float(sy[0]), ta
        for i in idx:
            ti = float(t[i])
            dt = max(1e-3, ti - lt) if keys else 1.0
            cap = max_speed * dt
            nx = lx + float(np.clip(xs[i] - lx, -cap, cap)) if keys else float(xs[i])
            ny = ly + float(np.clip(ys[i] - ly, -cap, cap)) if keys else float(ys[i])
            fr = min(b - 1, max(a, round(ti * fps)))
            if not keys or fr > keys[-1][0]:
                keys.append((fr, nx, ny))
            lx, ly, lt = nx, ny, ti
        if keys[0][0] > a:
            keys.insert(0, (a, keys[0][1], keys[0][2]))
        if keys[-1][0] < b - 1:
            keys.append((b - 1, keys[-1][1], keys[-1][2]))
        out.append(ShotFraming(a, b, keys, True))
        prev = (keys[-1][1], keys[-1][2])
    return out


def focus_of(shots: list[ShotFraming]) -> Focus:
    """One representative focus (for camera zoom centring): the median over the shots."""
    found = [s for s in shots if s.found]
    if not found:
        return Focus(0.5, 0.38, False, "center")
    xs = [k[1] for s in found for k in s.keys]
    ys = [k[2] for s in found for k in s.keys]
    return Focus(float(np.median(xs)), float(np.median(ys)), True, "track")


def piecewise_expr(points: list[tuple[int, float, int, float]], var: str = "n", digits: int = 2) -> str:
    """ffmpeg expression for a piecewise-linear function of `var` from segments (n0, v0, n1, v1), n in [n0, n1].
    Segments are sorted and contiguous; constant segments have v0 == v1. Built as a balanced tree of `if`s so
    long curves stay shallow."""
    if not points:
        return "0"
    if len(points) == 1:
        return _lerp(points[0], var, digits)
    mid = len(points) // 2
    left, right = piecewise_expr(points[:mid], var, digits), piecewise_expr(points[mid:], var, digits)
    return f"if(lt({var},{points[mid][0]}),{left},{right})"


def _lerp(seg: tuple[int, float, int, float], var: str, digits: int) -> str:
    n0, v0, n1, v1 = seg
    eps = 0.5 * 10**-digits
    if abs(v1 - v0) < eps or n1 <= n0:
        return f"{v0:.{digits}f}"
    return f"({v0:.{digits}f}+({v1 - v0:.{digits + 1}f})*({var}-{n0})/{n1 - n0})"
