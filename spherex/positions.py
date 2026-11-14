"""Sky positions: parsing what a user typed, and the known test targets.

Fast-moving stars are not where old catalogues say they are, so known targets carry
their proper motion and are moved to the date we need.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

_NUM = r"[+-]?\d+(?:\.\d+)?"
_DECIMAL = re.compile(rf"^\s*({_NUM})[\s,]+({_NUM})\s*$")
_SEXA = re.compile(
    r"^\s*(\d{1,2})[:h\s]\s*(\d{1,2})[:m\s]\s*(\d{1,2}(?:\.\d+)?)s?"
    r"[\s,]+([+-]?)(\d{1,2})[:d\s]\s*(\d{1,2})[:m\s]\s*(\d{1,2}(?:\.\d+)?)s?\s*$"
)
_NAME_OK = re.compile(r"^[A-Za-z0-9 +\-.'*]{1,64}$")


def validate(ra: float, dec: float) -> tuple[float, float]:
    """Return (ra, dec) in degrees, or raise ValueError. Never repairs bad input."""
    if not (math.isfinite(ra) and math.isfinite(dec)):
        raise ValueError("position is not a number")
    if not (0.0 <= ra < 360.0):
        raise ValueError("RA must be between 0 and 360 degrees")
    if not (-90.0 <= dec <= 90.0):
        raise ValueError("Dec must be between -90 and +90 degrees")
    return float(ra), float(dec)


def parse_position(text: str) -> tuple[float, float]:
    """Parse '269.45 4.69' (degrees) or '17:57:48 +04:41:36' (hours, degrees)."""
    if not isinstance(text, str) or len(text) > 64:
        raise ValueError("not a position")
    m = _DECIMAL.match(text)
    if m:
        return validate(float(m.group(1)), float(m.group(2)))
    m = _SEXA.match(text)
    if m:
        h, mi, s, sign, d, dm, ds = m.groups()
        h, mi, s, d, dm, ds = int(h), int(mi), float(s), int(d), int(dm), float(ds)
        if h >= 24 or mi >= 60 or s >= 60 or dm >= 60 or ds >= 60:
            raise ValueError("not a position")
        ra = (h + mi / 60 + s / 3600) * 15.0
        dec = d + dm / 60 + ds / 3600
        return validate(ra, -dec if sign == "-" else dec)
    raise ValueError("not a position")


def valid_name(text: str) -> bool:
    return isinstance(text, str) and bool(_NAME_OK.match(text))


@dataclass(frozen=True)
class Known:
    slug: str
    name: str
    kind: str  # "mover" or "variable"
    ra: float  # degrees at `epoch`
    dec: float
    epoch: float  # decimal year of the catalogue position
    pmra: float  # mas/yr, already multiplied by cos(dec)
    pmdec: float  # mas/yr
    aliases: tuple[str, ...] = ()


# Gaia DR3 (epoch 2016.0); WISE 0855 from AllWISE (2010.56) + Kirkpatrick et al. 2021.
KNOWN: dict[str, Known] = {
    k.slug: k
    for k in (
        Known("barnard", "Barnard's Star", "mover", 269.448503, 4.739420, 2016.0, -801.55, 10362.39,
              ("barnard", "barnards star", "barnard's star", "gj 699")),
        Known("eps-indi-b", "Epsilon Indi B", "mover", 331.076453, -56.793812, 2016.0, 3981.98, -2466.83,
              ("epsilon indi b", "eps ind b", "eps indi b", "epsilon indi")),
        Known("wise-0855", "WISE 0855-0714", "mover", 133.794760, -7.245146, 2010.56, -8123.7, 673.2,
              ("wise 0855", "wise 0855-0714", "wise0855", "w0855")),
        Known("rw-aur", "RW Aurigae", "variable", 76.956081, 30.401205, 2016.0, 2.64, -27.40,
              ("rw aur", "rw aurigae")),
        Known("r-dra", "R Draconis", "variable", 248.167378, 66.755007, 2016.0, -20.64, 6.15,
              ("r dra", "r draconis")),
    )
}


def mjd_to_year(mjd: float) -> float:
    return 2000.0 + (mjd - 51544.5) / 365.25


def position_at(known: Known, mjd: float) -> tuple[float, float]:
    """Where a known target is on a given date (straight-line proper motion)."""
    dt = mjd_to_year(mjd) - known.epoch
    dec = known.dec + known.pmdec * dt / 3.6e6
    ra = known.ra + known.pmra * dt / 3.6e6 / math.cos(math.radians(known.dec))
    return ra % 360.0, dec


_SESAME = "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/SNV?"
_RA_TAG = re.compile(r"<jradeg>\s*([-+0-9.eE]+)\s*</jradeg>")
_DEC_TAG = re.compile(r"<jdedeg>\s*([-+0-9.eE]+)\s*</jdedeg>")


def sesame_url(name: str) -> str:
    if not valid_name(name):
        raise ValueError("not a valid name")
    from urllib.parse import quote
    return _SESAME + quote(name.strip())


def parse_sesame(xml: str) -> tuple[float, float] | None:
    """First position in a Sesame XML answer, or None if the name wasn't found."""
    ra, dec = _RA_TAG.search(xml), _DEC_TAG.search(xml)
    if not ra or not dec:
        return None
    try:
        return validate(float(ra.group(1)), float(dec.group(1)))
    except ValueError:
        return None


def find_known(name: str) -> Known | None:
    key = " ".join(name.lower().replace("’", "'").split())
    for k in KNOWN.values():
        if key == k.slug or key == k.name.lower() or key in k.aliases:
            return k
    return None
