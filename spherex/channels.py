"""Group exposures by colour (wavelength channel) and by visit (pass).

SPHEREx sees a star at a different wavelength in every exposure, so two frames are only
comparable when they fall in the same channel. A pass is one few-week visit; passes come
about six months apart.
"""
from __future__ import annotations

import math

# Wavelength range of each detector in microns.
DETECTOR_RANGES = ((0.75, 1.10), (1.10, 1.63), (1.63, 2.42), (2.42, 3.83), (3.83, 4.42), (4.42, 5.01))
PER_DETECTOR = 17
N_CHANNELS = PER_DETECTOR * len(DETECTOR_RANGES)  # 102


def channel_of(lam_um: float) -> int:
    """Channel 0..101 for a wavelength. Approximates the 102 nominal SPHEREx channels with
    17 logarithmically even bins per detector."""
    if not math.isfinite(lam_um):
        raise ValueError("bad wavelength")
    for d, (lo, hi) in enumerate(DETECTOR_RANGES):
        if lam_um < hi or d == len(DETECTOR_RANGES) - 1:
            f = math.log(max(lam_um, lo) / lo) / math.log(hi / lo)
            return d * PER_DETECTOR + min(max(int(f * PER_DETECTOR), 0), PER_DETECTOR - 1)
    raise AssertionError("unreachable")


def channel_centre(ch: int) -> float:
    lo, hi = DETECTOR_RANGES[ch // PER_DETECTOR]
    return lo * (hi / lo) ** (((ch % PER_DETECTOR) + 0.5) / PER_DETECTOR)


def assign_passes(mjds: list[float], gap_days: float = 30.0) -> list[int]:
    """Pass number for each date (dates in any order): a new pass starts after a long gap."""
    order = sorted(range(len(mjds)), key=lambda i: mjds[i])
    out = [0] * len(mjds)
    p, prev = 0, None
    for i in order:
        if prev is not None and mjds[i] - prev > gap_days:
            p += 1
        out[i] = p
        prev = mjds[i]
    return out


def progressive_order(n: int) -> list[int]:
    """Visit 0..n-1 coarse-to-fine, so the first frames to arrive are spread over the whole
    time range and the flipbook is watchable almost at once."""
    seen, out = set(), []
    step = 1
    while step * 2 < n:
        step *= 2
    while step >= 1:
        for i in range(0, n, step):
            if i not in seen:
                seen.add(i)
                out.append(i)
        step //= 2
    return out
