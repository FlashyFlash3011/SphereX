"""Stars from ESA's Gaia DR3 catalogue around a position: where they are, how they move, how far they are.

Gaia is ESA's star-mapping telescope (2013-2025). We use it as the reference: a change SphereX sees can be
checked against Gaia's known positions and motions. Queried through VizieR mirrors (CfA, IDIA), which answer
in seconds; ESA's own archive was too slow on 15 Nov.
"""
from __future__ import annotations

from urllib.parse import urlencode

from . import net
from .positions import validate

MIRRORS = ("https://vizier.cfa.harvard.edu/viz-bin/asu-tsv", "https://vizier.idia.ac.za/viz-bin/asu-tsv")
COLUMNS = ("Source", "RA_ICRS", "DE_ICRS", "pmRA", "pmDE", "Plx", "Gmag", "VarFlag")
MAX_STARS = 2000
MAX_RADIUS_DEG = 0.3
EPOCH = 2016.0  # Gaia DR3 positions are for the start of 2016


def query_url(mirror: str, ra: float, dec: float, radius: float) -> str:
    ra, dec = validate(ra, dec)
    if not (0 < radius <= MAX_RADIUS_DEG):
        raise ValueError("radius not allowed")
    if mirror not in MIRRORS:
        raise ValueError("unknown mirror")
    q = {"-source": "I/355/gaiadr3", "-c": f"{ra:.6f} {dec:+.6f}", "-c.rd": f"{radius:.4f}",
         "-out": ",".join(COLUMNS), "-out.max": str(MAX_STARS), "-sort": "Gmag"}
    return f"{mirror}?{urlencode(q)}"


def _num(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_tsv(text: str) -> list[dict]:
    """VizieR's tab-separated answer → list of stars. Rows without a position or brightness are skipped."""
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    try:
        head = next(i for i, ln in enumerate(lines) if ln.split("\t")[0].strip() == "Source")
    except StopIteration:
        return []
    cols = [c.strip() for c in lines[head].split("\t")]
    if any(c not in cols for c in COLUMNS):
        return []
    idx = {c: cols.index(c) for c in COLUMNS}
    stars = []
    for ln in lines[head + 3:]:  # skip the header, units and dashes lines
        f = ln.split("\t")
        if len(f) < len(cols):
            continue
        ra, dec, g = _num(f[idx["RA_ICRS"]]), _num(f[idx["DE_ICRS"]]), _num(f[idx["Gmag"]])
        if ra is None or dec is None or g is None:
            continue
        stars.append({
            "id": f[idx["Source"]].strip(), "ra": ra, "dec": dec, "g": round(g, 3),
            "pmra": _num(f[idx["pmRA"]]), "pmdec": _num(f[idx["pmDE"]]), "plx": _num(f[idx["Plx"]]),
            "variable": f[idx["VarFlag"]].strip() == "VARIABLE",
        })
    return stars


def stars_near(ra: float, dec: float, radius: float) -> list[dict]:
    """Gaia stars within `radius` degrees, brightest first. Tries each mirror; raises net.FetchError if all fail."""
    last: Exception | None = None
    for mirror in MIRRORS:
        try:
            text = net.fetch(query_url(mirror, ra, dec, radius), max_bytes=3_000_000).decode("utf-8", "replace")
            stars = parse_tsv(text)
            if stars or "Source" in text:
                return stars
        except net.FetchError as e:
            last = e
    raise net.FetchError(f"Gaia lookup failed: {last}")
