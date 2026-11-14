"""Build the stack of frames for one sky position, frame by frame.

A Stack fills up while it is being built, so the web page can start playing after the
first few frames. Finished stacks are saved to disk and reused.
"""
from __future__ import annotations

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import cutout, irsa
from .channels import assign_passes, channel_of, progressive_order
from .positions import validate

MAX_FRAMES = 600
WORKERS = 12
NO_DATA = -30000.0  # float16 value meaning "no data in this pixel"
_MJD0 = datetime(1858, 11, 17, tzinfo=timezone.utc)


def mjd_to_utc(mjd: float) -> str:
    return (_MJD0 + timedelta(days=mjd)).strftime("%Y-%m-%dT%H:%M:%SZ")


def stack_id(ra: float, dec: float, n: int) -> str:
    return hashlib.sha1(f"{ra:.4f},{dec:.4f},{n}".encode()).hexdigest()[:16]


def encode(img: np.ndarray) -> bytes:
    """Little-endian float16; pixels without data become NO_DATA."""
    out = np.clip(img, -20000.0, 60000.0)
    out[~np.isfinite(img)] = NO_DATA
    return out.astype("<f2").tobytes()


class Stack:
    def __init__(self, ra: float, dec: float, n: int, exposures: list[irsa.Exposure], first_det: int | None = None):
        self.ra, self.dec, self.n = ra, dec, n
        self.id = stack_id(ra, dec, n)
        self.truncated = max(len(exposures) - MAX_FRAMES, 0)
        if self.truncated:  # keep an even spread over time
            keep = np.linspace(0, len(exposures) - 1, MAX_FRAMES).round().astype(int)
            exposures = [exposures[i] for i in keep]
        self.exposures = exposures
        self.passes = assign_passes([e.t_min for e in exposures])
        self.frames: dict[int, dict] = {}  # index → metadata, for frames that are ready
        self.blobs: dict[int, bytes] = {}  # index → float16 pixels
        self.arrived: list[int] = []  # indices in the order they finished
        self.missing: list[dict] = []
        self.done = False
        self.first_det = first_det
        self.cancelled = False
        self._lock = threading.Lock()

    def cancel(self) -> None:
        """Stop building: the visitor moved on to another search."""
        self.cancelled = True

    # ---- what the web page asks for -------------------------------------------------
    def summary(self) -> dict:
        return {
            "id": self.id, "ra": self.ra, "dec": self.dec, "n": self.n,
            "pixscale_arcsec": cutout.PIXEL_ARCSEC, "total": len(self.exposures),
            "truncated": self.truncated, "no_data": NO_DATA,
            "exposures": [{"i": i, "obs_id": e.obs_id, "det": e.det, "collection": e.collection,
                           "mjd": e.t_min, "utc": mjd_to_utc(e.t_min), "pass": self.passes[i],
                           "access_url": e.access_url}
                          for i, e in enumerate(self.exposures)],
        }

    def status(self, after: int = 0) -> dict:
        with self._lock:
            new = [self.frames[i] for i in self.arrived[after:]]
            return {"frames": new, "next": len(self.arrived), "ready": len(self.arrived),
                    "missing": list(self.missing), "total": len(self.exposures), "done": self.done}

    def pixels(self, indices: list[int]) -> bytes:
        with self._lock:
            return b"".join(self.blobs[i] for i in indices)

    # ---- building -------------------------------------------------------------------
    def _one(self, i: int) -> None:
        if self.cancelled:
            return
        e = self.exposures[i]
        try:
            meta = cutout.read_meta(e.key, self.ra, self.dec)
            img = cutout.cutout(meta, self.ra, self.dec, self.n)
            lo, hi = cutout.display_cuts(img)
            frame = {"i": i, "obs_id": e.obs_id, "det": e.det, "mjd": meta.mjd, "utc": mjd_to_utc(meta.mjd),
                     "lam_um": round(meta.lam_um, 5), "bw_um": round(meta.bw_um, 5),
                     "channel": channel_of(meta.lam_um), "pass": self.passes[i],
                     "cuts": [round(lo, 4), round(hi, 4)], "access_url": e.access_url}
            blob = encode(img)
        except Exception as err:  # one bad frame must never stop the stack
            reason = "not on the detector" if isinstance(err, cutout.OffDetector) else "could not be loaded"
            with self._lock:
                self.missing.append({"i": i, "obs_id": e.obs_id, "reason": reason})
            return
        with self._lock:
            self.frames[i] = frame
            self.blobs[i] = blob
            self.arrived.append(i)

    def build_order(self) -> list[int]:
        """Spread over time first; the visitor's chosen detector before the others."""
        order = progressive_order(len(self.exposures))
        if self.first_det:
            order = ([i for i in order if self.exposures[i].det == self.first_det]
                     + [i for i in order if self.exposures[i].det != self.first_det])
        return order

    def build(self) -> None:
        try:
            with ThreadPoolExecutor(WORKERS) as pool:
                list(pool.map(self._one, self.build_order()))
        finally:
            self.done = True

    # ---- disk cache -----------------------------------------------------------------
    def save(self, root: Path) -> None:
        d = root / self.id
        d.mkdir(parents=True, exist_ok=True)
        order = sorted(self.frames)
        (d / "frames.bin").write_bytes(b"".join(self.blobs[i] for i in order))
        doc = {"summary": self.summary(), "frames": [self.frames[i] for i in order], "missing": self.missing}
        (d / "stack.json").write_text(json.dumps(doc))

    @classmethod
    def load(cls, root: Path, sid: str) -> "Stack | None":
        d = root / sid
        try:
            doc = json.loads((d / "stack.json").read_text())
            raw = (d / "frames.bin").read_bytes()
        except (OSError, ValueError):
            return None
        s = doc["summary"]
        self = cls.__new__(cls)
        self.ra, self.dec, self.n, self.id = s["ra"], s["dec"], s["n"], s["id"]
        self.truncated = s.get("truncated", 0)
        self.exposures = [irsa.Exposure(e["obs_id"], e["det"], e["collection"], e["mjd"], e["mjd"], (),
                                        "", e["access_url"]) for e in s["exposures"]]
        self.passes = [e["pass"] for e in s["exposures"]]
        size = self.n * self.n * 2
        self.frames = {f["i"]: f for f in doc["frames"]}
        self.blobs = {f["i"]: raw[k * size:(k + 1) * size] for k, f in enumerate(doc["frames"])}
        self.arrived = [f["i"] for f in doc["frames"]]
        self.missing = doc.get("missing", [])
        self.done = True
        self.first_det = None
        self.cancelled = False
        self._lock = threading.Lock()
        return self


def start(ra: float, dec: float, n: int, exposures: list[irsa.Exposure] | None = None,
          first_det: int | None = None) -> Stack:
    """Return an empty Stack ready to build (searches the archive unless exposures are given)."""
    ra, dec = validate(ra, dec)
    if n not in cutout.SIZES:
        raise ValueError("size not allowed")
    return Stack(ra, dec, n, irsa.search(ra, dec) if exposures is None else exposures, first_det)
