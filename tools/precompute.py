"""Prepare the challenge's five test targets in advance, as static files inside the website.

Run:  .venv/bin/python tools/precompute.py            (all five)
      .venv/bin/python tools/precompute.py barnard    (one)
      .venv/bin/python tools/precompute.py barnard=var/cache/<id>   (from a stack the server already built,
                                                     when the archive's search is down)

For each target it saves, in web/data/<slug>/:
  search.json  every SPHEREx photo of the spot (same shape as /api/search)
  stack.json   the frame list (same shape as the server's cache), frames.bin the cut-outs (float16)
  gaia.json    Gaia DR3 stars around the spot (same shape as /api/gaia)
and web/data/targets.json, the list the website uses to recognise the names without the server.
These are a snapshot: they don't include SPHEREx photos taken after the build date.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import main  # noqa: E402  (reuses the server's own search, so the files match the live API)
from spherex import cutout, gaia, irsa, net, positions, stack  # noqa: E402

SIZE = 64
OUT = ROOT / "web" / "data"


def gaia_radius(size: int) -> float:   # must match loadGaia() in web/js/flip.js
    return round(min(0.3, size * 6.15 / 3600 * 0.75 + 0.01), 3)


def build(slug: str) -> dict:
    known = positions.KNOWN[slug]
    ra, dec = positions.position_at(known, main._mjd_now())
    ra, dec = round(ra, 6), round(dec, 6)
    print(f"[{slug}] position {ra}, {dec}", flush=True)
    for attempt in range(10):   # the archive's search is often overloaded: wait and try again
        try:
            found = main.search(ra=ra, dec=dec, dets="1,2,3,4,5,6", date_from=None, date_to=None)
        except main.HTTPException:
            found = {"unavailable": ["all"]}
        if not found["unavailable"]:
            break
        print(f"[{slug}] archive didn't return the full photo list; retrying in 60 s", flush=True)
        time.sleep(60)
    else:
        raise RuntimeError("archive kept returning a partial photo list")
    print(f"[{slug}] {found['total']} photos in {len(found['visits'])} visits", flush=True)
    exposures = main._searches[(round(ra, 4), round(dec, 4))]
    s = stack.start(ra, dec, SIZE, exposures)
    t0 = time.time()
    s.build()
    print(f"[{slug}] cut-outs: {len(s.frames)} ready, {len(s.missing)} missing, {time.time() - t0:.0f} s", flush=True)
    return write_files(slug, s, found, ra, dec)


def outline_from_header(key: str) -> list[list[float]]:
    """A photo's outline on the sky, from its own file header (needs only NASA's image storage)."""
    import warnings
    from astropy.io import fits
    from astropy.wcs import WCS
    head = net.fetch(net.s3_url(key), byte_range=(0, cutout.HEAD_BYTES - 1))
    start = cutout.header_end(head, 0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w = WCS(fits.Header.fromstring(head[start:cutout.header_end(head, start)]))
        corners = w.all_pix2world([[0, 0], [cutout.NX - 1, 0], [cutout.NX - 1, cutout.NY - 1], [0, cutout.NY - 1]], 0)
    return [[round(float(a), 5), round(float(b), 5)] for a, b in corners]


def write_files(slug: str, s: stack.Stack, found: dict, ra: float, dec: float) -> dict:
    known = positions.KNOWN[slug]
    stars = gaia.stars_near(ra, dec, gaia_radius(SIZE))
    d = OUT / slug
    d.mkdir(parents=True, exist_ok=True)
    order = sorted(s.frames)
    (d / "frames.bin").write_bytes(b"".join(s.blobs[i] for i in order))
    (d / "stack.json").write_text(json.dumps({"summary": s.summary(), "frames": [s.frames[i] for i in order], "missing": s.missing}))
    (d / "search.json").write_text(json.dumps(found))
    (d / "gaia.json").write_text(json.dumps({"epoch": gaia.EPOCH, "stars": stars}))
    print(f"[{slug}] saved {sum(f.stat().st_size for f in d.iterdir()) / 1e6:.1f} MB", flush=True)
    return {"slug": slug, "name": known.name, "aliases": list(known.aliases), "kind": known.kind, "ra": ra, "dec": dec,
            "size": SIZE, "photos": found["total"], "frames": len(order)}


def build_from_cache(slug: str, cache_dir: Path) -> dict:
    """Use a stack the server already built (var/cache/<id>/) when the archive's search is down.
    Photo outlines are rebuilt from each file's header via NASA's image storage."""
    from concurrent.futures import ThreadPoolExecutor
    s = stack.Stack.load(cache_dir.parent, cache_dir.name)
    if s is None:
        raise RuntimeError(f"no saved stack in {cache_dir}")
    prefix = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
    exps = s.exposures
    with ThreadPoolExecutor(16) as pool:
        outlines = list(pool.map(lambda e: outline_from_header(e.access_url[len(prefix):]), exps))
    visit = s.passes
    photos, visits = [], {}
    for e, o, v in zip(exps, outlines, visit):
        visits.setdefault(v, []).append(e.t_min)
        photos.append({"obs_id": e.obs_id, "det": e.det, "um": main.DETECTOR_UM[e.det],
                       "release": "DR1" if e.collection.endswith("dr1") else "QR3", "mjd": round(e.t_min, 5),
                       "utc": stack.mjd_to_utc(e.t_min), "visit": v, "centre": irsa.footprint_centre(tuple(map(tuple, o))),
                       "outline": o, "url": e.access_url})
    found = {"ra": s.ra, "dec": s.dec, "total_all": len(photos), "total": len(photos), "unavailable": [],
             "visits": [{"visit": v, "start": stack.mjd_to_utc(min(t)), "end": stack.mjd_to_utc(max(t)), "n": len(t)}
                        for v, t in sorted(visits.items())],
             "photos": photos}
    print(f"[{slug}] from saved stack {cache_dir.name}: {len(photos)} photos, {len(s.frames)} cut-outs", flush=True)
    return write_files(slug, s, found, s.ra, s.dec)


def main_cli(slugs: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "targets.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"targets": {}}
    for arg in slugs:
        slug, _, cache = arg.partition("=")   # "slug=var/cache/<id>" builds from a saved stack
        entry = build_from_cache(slug, Path(cache)) if cache else build(slug)
        entry["built_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        index["targets"][slug] = entry
        index_path.write_text(json.dumps(index, indent=1))
    print("done:", ", ".join(index["targets"]), flush=True)


if __name__ == "__main__":
    main_cli(sys.argv[1:] or list(positions.KNOWN))
