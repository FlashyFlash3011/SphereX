"""The only place SphereX talks to the outside world.

Every request goes to a host on a short allow-list, has a timeout and a size cap, and is
retried a few times, because the archive drops requests now and then.
"""
from __future__ import annotations

import http.client
import logging
import random
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import certifi

ALLOWED_HOSTS = frozenset({
    "irsa.ipac.caltech.edu",
    "nasa-irsa-spherex.s3.us-east-1.amazonaws.com",
    "vizier.cfa.harvard.edu",  # Sesame name resolver and the Gaia catalogue (VizieR)
    "vizier.idia.ac.za",       # VizieR mirror, fallback for the Gaia catalogue
})
S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
TIMEOUT_S = 30
RETRY_WAITS_S = (1.0, 3.0, 9.0)
USER_AGENT = "SphereX/0.1"
log = logging.getLogger("spherex.net")

# Verify certificates against Mozilla's current list (certifi). Slim server images ship an older list
# that lacks the root certificate NASA's archive uses (SSL.com TLS RSA Root CA 2022).
_TLS = ssl.create_default_context(cafile=certifi.where())
_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_TLS))


class FetchError(RuntimeError):
    pass


def _check(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
        raise FetchError("host not allowed")


def fetch(url: str, byte_range: tuple[int, int] | None = None, suffix: int | None = None,
          max_bytes: int = 8_000_000, waits: tuple[float, ...] = RETRY_WAITS_S,
          _sleep=time.sleep, _open=_OPENER.open) -> bytes:
    """GET `url` (optionally a byte range, or the last `suffix` bytes). Raises FetchError.
    `waits` are the pauses between attempts (one more attempt than pauses)."""
    _check(url)
    headers = {"User-Agent": USER_AGENT}
    if byte_range is not None:
        start, end = byte_range
        if start < 0 or end < start or end - start + 1 > max_bytes:
            raise FetchError("bad byte range")
        headers["Range"] = f"bytes={start}-{end}"
    elif suffix is not None:
        if not (0 < suffix <= max_bytes):
            raise FetchError("bad byte range")
        headers["Range"] = f"bytes=-{suffix}"
    last: Exception | None = None
    for attempt in range(len(waits) + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with _open(req, timeout=TIMEOUT_S) as resp:
                expected = resp.headers.get("Content-Length")
                if expected is not None and int(expected) > max_bytes:
                    raise FetchError("response too large")
                data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise FetchError("response too large")
            # A dropped connection can hand back a short body without any error.
            if expected is not None and len(data) != int(expected):
                raise ConnectionError("incomplete response")
            return data
        except FetchError:
            raise
        except urllib.error.HTTPError as e:
            last = e
            log.warning("fetch %s attempt %d: HTTP %s", urlsplit(url).hostname, attempt + 1, e.code)
            if e.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            last = e
            log.warning("fetch %s attempt %d: %s %s", urlsplit(url).hostname, attempt + 1, type(e).__name__, str(e)[:200])
        if attempt < len(waits):
            _sleep(waits[attempt] + random.random() * 0.5)
    raise FetchError(f"fetch failed: {type(last).__name__}")


def s3_url(key: str) -> str:
    if not key or ".." in key or not key.endswith(".fits") or key.split("/")[0] not in ("dr1", "qr3"):
        raise FetchError("bad archive key")
    return S3_BASE + key
