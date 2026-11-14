"""Ask NASA's IRSA archive which SPHEREx exposures cover a sky position.

Uses the Simple Image Access service. A request is never built without a validated
position: without one, IRSA answers with the whole archive.
"""
from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from . import net
from .positions import validate

SIA = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
MAXREC = 3000
_IBE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"


@dataclass(frozen=True)
class Exposure:
    obs_id: str
    det: int  # detector 1..6
    collection: str
    t_min: float  # MJD
    t_max: float
    footprint: tuple[tuple[float, float], ...]  # sky corners (ra, dec)
    key: str  # path inside the public S3 bucket
    access_url: str


def build_sia_url(ra: float, dec: float, collection: str) -> str:
    ra, dec = validate(ra, dec)
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    return (f"{SIA}?COLLECTION={collection}&POS=circle+{ra:.6f}+{dec:.6f}+0.0001"
            f"&MAXREC={MAXREC}&RESPONSEFORMAT=csv")


def _footprint(s_region: str) -> tuple[tuple[float, float], ...]:
    parts = s_region.split()
    nums = [float(p) for p in parts if p[0].isdigit() or p[0] in "+-."]
    pts = tuple(zip(nums[0::2], nums[1::2]))
    return pts[:-1] if len(pts) > 1 and pts[0] == pts[-1] else pts


def parse_sia_csv(text: str) -> list[Exposure]:
    """Parse IRSA's CSV. Its last columns hold unquoted JSON with commas, so only columns
    before that one are read, by name."""
    rows = csv.reader(io.StringIO(text))
    try:
        header = next(rows)
    except StopIteration:
        return []
    need = ("obs_id", "energy_bandpassname", "access_url", "s_region", "obs_collection", "t_min", "t_max")
    try:
        idx = {name: header.index(name) for name in need}
    except ValueError:
        return []
    out = []
    for r in rows:
        try:
            url = r[idx["access_url"]]
            band = r[idx["energy_bandpassname"]]
            if not url.startswith(_IBE_PREFIX) or not band.startswith("SPHEREx-D"):
                continue
            out.append(Exposure(
                obs_id=r[idx["obs_id"]], det=int(band[-1]), collection=r[idx["obs_collection"]],
                t_min=float(r[idx["t_min"]]), t_max=float(r[idx["t_max"]]),
                footprint=_footprint(r[idx["s_region"]]),
                key=url[len(_IBE_PREFIX):], access_url=url))
        except (IndexError, ValueError):
            continue
    return out


def search(ra: float, dec: float) -> list[Exposure]:
    """All exposures covering (ra, dec), oldest first."""
    urls = [build_sia_url(ra, dec, c) for c in COLLECTIONS]
    with ThreadPoolExecutor(len(urls)) as pool:
        texts = list(pool.map(lambda u: net.fetch(u, max_bytes=6_000_000).decode("utf-8", "replace"), urls))
    found: dict[tuple[str, int], Exposure] = {}
    for t in texts:
        for e in parse_sia_csv(t):
            found[(e.obs_id, e.det)] = e
    return sorted(found.values(), key=lambda e: (e.t_min, e.det))


def footprint_centre(points: tuple[tuple[float, float], ...]) -> tuple[float, float]:
    """Centre of a footprint polygon, averaging on the sphere (safe across RA = 0/360)."""
    import math
    if not points:
        return (0.0, 0.0)
    x = y = z = 0.0
    for ra, dec in points:
        r, d = math.radians(ra), math.radians(dec)
        x += math.cos(d) * math.cos(r)
        y += math.cos(d) * math.sin(r)
        z += math.sin(d)
    ra = math.degrees(math.atan2(y, x)) % 360.0
    dec = math.degrees(math.atan2(z, math.hypot(x, y)))
    return (round(ra, 5), round(dec, 5))
