"""SphereX web server: the search API plus the web page, from one process.

Run:  uvicorn server.main:app --port 8000
"""
from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from spherex import cutout, net, positions, stack
from spherex.net import FetchError

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("SPHEREX_CACHE", ROOT / "var" / "cache"))
MAX_BUILDING = 3  # stacks being built at once, all visitors together
MAX_IN_MEMORY = 8
MAX_FRAMES_PER_REQUEST = 64
_ID = re.compile(r"^[0-9a-f]{16}$")

app = FastAPI(title="SphereX", docs_url=None, redoc_url=None, openapi_url=None)
_stacks: "OrderedDict[str, stack.Stack]" = OrderedDict()
_building: dict[str, str] = {}  # stack id → visitor address
_lock = threading.Lock()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def _visitor(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def _mjd_now() -> float:
    return (datetime.now(timezone.utc) - datetime(1858, 11, 17, tzinfo=timezone.utc)).total_seconds() / 86400


def _remember(s: stack.Stack) -> None:
    _stacks[s.id] = s
    _stacks.move_to_end(s.id)
    for sid in list(_stacks):
        if len(_stacks) <= MAX_IN_MEMORY:
            break
        if _stacks[sid].done and sid != s.id:
            del _stacks[sid]


def _get(sid: str) -> stack.Stack:
    if not _ID.match(sid):
        raise HTTPException(404, "No such search.")
    with _lock:
        s = _stacks.get(sid)
        if s is None:
            s = stack.Stack.load(CACHE, sid)
            if s is not None:
                _remember(s)
    if s is None:
        raise HTTPException(404, "This search has expired. Search again.")
    return s


def _run(s: stack.Stack) -> None:
    try:
        s.build()
        if s.frames:
            s.save(CACHE)
    finally:
        with _lock:
            _building.pop(s.id, None)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/resolve")
def resolve(name: str = Query(max_length=64)):
    """Turn what the visitor typed into a sky position."""
    try:
        ra, dec = positions.parse_position(name)
        return {"name": None, "ra": ra, "dec": dec, "kind": "position"}
    except ValueError:
        pass
    if not positions.valid_name(name):
        raise HTTPException(422, "That doesn't look like a name or a sky position.")
    if not any(c.isalpha() for c in name.replace("h", "").replace("m", "").replace("s", "").replace("d", "")):
        raise HTTPException(422, "That position isn't on the sky. RA goes from 0 to 360, Dec from -90 to +90.")
    known = positions.find_known(name)
    if known is None:
        try:
            xml = net.fetch(positions.sesame_url(name), max_bytes=200_000).decode("utf-8", "replace")
        except (FetchError, ValueError):
            raise HTTPException(502, "The name lookup service didn't answer. Try coordinates, like 269.45 4.77.")
        found = positions.parse_sesame(xml)
        if found is None:
            raise HTTPException(404, "We couldn't find that name. Check the spelling, or try coordinates.")
        return {"name": name.strip(), "ra": round(found[0], 6), "dec": round(found[1], 6), "kind": "named"}
    ra, dec = positions.position_at(known, _mjd_now())
    return {"name": known.name, "slug": known.slug, "ra": round(ra, 6), "dec": round(dec, 6), "kind": known.kind}


@app.post("/api/stacks")
def create_stack(request: Request, ra: float, dec: float, size: int = 64):
    """Start (or reuse) the stack of frames for a position. Frames arrive via /status."""
    try:
        ra, dec = positions.validate(ra, dec)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if size not in cutout.SIZES:
        raise HTTPException(422, "Size must be 32, 64 or 128.")
    sid = stack.stack_id(ra, dec, size)
    who = _visitor(request)
    with _lock:
        s = _stacks.get(sid) or stack.Stack.load(CACHE, sid)
        if s is not None:
            _remember(s)
            return {**s.summary(), "cached": s.done}
        if who in _building.values():
            raise HTTPException(429, "One search at a time, please. Wait for the current one to finish.")
        if len(_building) >= MAX_BUILDING:
            raise HTTPException(429, "The server is busy with other searches. Try again in a minute.")
        _building[sid] = who
    try:
        s = stack.start(ra, dec, size)
    except FetchError:
        with _lock:
            _building.pop(sid, None)
        raise HTTPException(502, "NASA's archive didn't answer. Try again in a moment.")
    with _lock:
        _remember(s)
    if not s.exposures:
        s.done = True
        with _lock:
            _building.pop(sid, None)
    else:
        threading.Thread(target=_run, args=(s,), daemon=True).start()
    return {**s.summary(), "cached": False}


@app.get("/api/stacks/{sid}/status")
def stack_status(sid: str, after: int = Query(0, ge=0, le=100000)):
    return _get(sid).status(after)


@app.get("/api/stacks/{sid}/frames")
def stack_frames(sid: str, i: str = Query(max_length=600)):
    """Raw pixels for the listed frame numbers: float16, little-endian, n×n each, in order."""
    s = _get(sid)
    try:
        idx = [int(p) for p in i.split(",")]
    except ValueError:
        raise HTTPException(422, "Bad frame list.")
    if not idx or len(idx) > MAX_FRAMES_PER_REQUEST or any(k not in s.blobs for k in idx):
        raise HTTPException(422, "Bad frame list.")
    return Response(s.pixels(idx), media_type="application/octet-stream")


@app.exception_handler(Exception)
async def unexpected(request: Request, exc: Exception):
    return JSONResponse({"detail": "Something went wrong on our side."}, status_code=500)


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
