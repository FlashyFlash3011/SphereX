"""Cut a small north-up square out of one 65 MB SPHEREx exposure without downloading it.

SPHEREx files are uncompressed FITS, so the pixels we want sit at a known byte offset.
Three small reads per exposure: the header (where is the sky on this detector, and where
do its pixels start?), the
wavelength table at the end of the file, and the image rows that cover our square.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
from astropy import log as _astropy_log
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy.ndimage import map_coordinates

from . import net

_astropy_log.setLevel("ERROR")
warnings.filterwarnings("ignore", category=FITSFixedWarning)

NX = NY = 2040  # detector size in pixels
HEAD_BYTES = 34_560  # enough for the primary + IMAGE headers (their length varies by detector)
TAIL_BYTES = 8_640  # WCS-WAVE header + table, the last extension of the file
ROW_BYTES = NX * 4  # float32
PIXEL_ARCSEC = 6.15
SIZES = (32, 64, 128)


class OffDetector(ValueError):
    """The position is not on this detector (or too close to its edge)."""


@dataclass
class Meta:
    key: str
    wcs: WCS
    x: float  # where the position falls on the detector (0-based pixels)
    y: float
    lam_um: float  # wavelength this detector pixel saw
    bw_um: float  # width of that wavelength band
    mjd: float
    det: int
    data_offset: int = 0  # byte where this file's IMAGE pixels start


def header_end(buf: bytes, start: int) -> int:
    """Byte just after the FITS header that begins at `start` (headers are 80-byte cards in
    2880-byte blocks, closed by an END card). Raises ValueError if the END card isn't in `buf`."""
    i = start
    while i + 80 <= len(buf):
        if buf[i:i + 80].rstrip() == b"END":
            return (i // 2880 + 1) * 2880
        i += 80
    raise ValueError("FITS header is longer than expected")


def parse_meta(key: str, head: bytes, tail: bytes, ra: float, dec: float) -> Meta:
    primary_end = header_end(head, 0)
    data_offset = header_end(head, primary_end)  # 25,920 for detectors 3-6, 28,800 for 1-2
    h_img = fits.Header.fromstring(head[primary_end:data_offset])
    start = tail.find(b"XTENSION")
    if start < 0:
        raise ValueError("wavelength table not found")
    wave_hdu = fits.BinTableHDU.fromstring(tail[start:])
    hdul = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=h_img, name="IMAGE"), wave_hdu])
    wcs = WCS(h_img)
    wave = WCS(h_img, fobj=hdul, key="W")
    wave.sip = None
    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0, quiet=True))
    if not (np.isfinite(x) and np.isfinite(y)) or not (0 <= x <= NX - 1 and 0 <= y <= NY - 1):
        raise OffDetector("position is off this detector")
    lam, bw = (float(v) for v in wave.pixel_to_world_values(x, y))
    mjd = float(h_img.get("MJD-AVG") or h_img.get("MJD-OBS"))
    return Meta(key=key, wcs=wcs, x=x, y=y, lam_um=lam, bw_um=bw, mjd=mjd, det=int(h_img.get("DETECTOR", 0)),
                data_offset=data_offset)


def read_meta(key: str, ra: float, dec: float) -> Meta:
    url = net.s3_url(key)
    head = net.fetch(url, byte_range=(0, HEAD_BYTES - 1))
    tail = net.fetch(url, suffix=TAIL_BYTES)
    return parse_meta(key, head, tail, ra, dec)


def target_wcs(ra: float, dec: float, n: int) -> WCS:
    """The grid every frame is redrawn onto: north up, east left, centred on the position."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIXEL_ARCSEC / 3600, PIXEL_ARCSEC / 3600]
    return w


def source_coords(meta: Meta, ra: float, dec: float, n: int) -> tuple[np.ndarray, np.ndarray]:
    """For each output pixel, the (x, y) detector position it comes from."""
    yy, xx = np.mgrid[0:n, 0:n]
    sky = target_wcs(ra, dec, n).wcs_pix2world(np.column_stack([xx.ravel(), yy.ravel()]), 0)
    src = meta.wcs.all_world2pix(sky, 0, quiet=True)
    return src[:, 0].reshape(n, n), src[:, 1].reshape(n, n)


def resample(rows: np.ndarray, x0: int, y0: int, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Redraw detector pixels onto the output grid (bilinear). Outside the data = NaN."""
    return map_coordinates(rows, [ys - y0, xs - x0], order=1, mode="constant", cval=np.nan,
                           prefilter=False).astype(np.float32)


def subtract_background(img: np.ndarray) -> np.ndarray:
    """Remove the smooth glow (mostly zodiacal light): subtract a clipped median."""
    v = img[np.isfinite(img)]
    if v.size < 16:
        return img
    for _ in range(3):
        med = np.median(v)
        sig = 1.4826 * np.median(np.abs(v - med))
        if sig <= 0:
            break
        keep = np.abs(v - med) < 3 * sig
        if keep.all():
            break
        v = v[keep]
    return img - np.float32(np.median(v))


def display_cuts(img: np.ndarray) -> tuple[float, float]:
    """Sensible default black and white points for showing one frame."""
    v = img[np.isfinite(img)]
    if v.size == 0:
        return 0.0, 1.0
    med = float(np.median(v))
    sig = float(1.4826 * np.median(np.abs(v - med))) or 1e-3
    hi = max(float(np.percentile(v, 99.0)), med + 15 * sig)
    return med - 2 * sig, hi


def cutout(meta: Meta, ra: float, dec: float, n: int) -> np.ndarray:
    """An n×n north-up, background-subtracted image centred on (ra, dec). NaN = no data."""
    if n not in SIZES:
        raise ValueError("size not allowed")
    xs, ys = source_coords(meta, ra, dec, n)
    y0 = max(int(np.floor(np.nanmin(ys))) - 1, 0)
    y1 = min(int(np.ceil(np.nanmax(ys))) + 1, NY - 1)
    x0 = max(int(np.floor(np.nanmin(xs))) - 1, 0)
    x1 = min(int(np.ceil(np.nanmax(xs))) + 1, NX - 1)
    if y1 <= y0 or x1 <= x0:
        raise OffDetector("position is off this detector")
    raw = net.fetch(net.s3_url(meta.key),
                    byte_range=(meta.data_offset + y0 * ROW_BYTES, meta.data_offset + (y1 + 1) * ROW_BYTES - 1))
    rows = np.frombuffer(raw, dtype=">f4").reshape(y1 - y0 + 1, NX)[:, x0:x1 + 1].astype(np.float32)
    return subtract_background(resample(rows, x0, y0, xs, ys))
