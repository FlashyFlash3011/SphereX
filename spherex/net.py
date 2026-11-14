"""The only place SphereX talks to the outside world.

Every request goes to a host on a short allow-list, has a timeout and a size cap, and is
retried a few times, because the archive drops requests now and then.
"""
from __future__ import annotations

import http.client
import random
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ALLOWED_HOSTS = frozenset({
    "irsa.ipac.caltech.edu",
    "nasa-irsa-spherex.s3.us-east-1.amazonaws.com",
})
S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
TIMEOUT_S = 30
RETRY_WAITS_S = (1.0, 3.0, 9.0)
USER_AGENT = "SphereX/0.1"


class FetchError(RuntimeError):
    pass


def _check(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
        raise FetchError("host not allowed")


def fetch(url: str, byte_range: tuple[int, int] | None = None, suffix: int | None = None,
          max_bytes: int = 8_000_000, _sleep=time.sleep, _open=urllib.request.urlopen) -> bytes:
    """GET `url` (optionally a byte range, or the last `suffix` bytes). Raises FetchError."""
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
    for attempt in range(len(RETRY_WAITS_S) + 1):
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
            if e.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            last = e
        if attempt < len(RETRY_WAITS_S):
            _sleep(RETRY_WAITS_S[attempt] + random.random() * 0.5)
    raise FetchError(f"fetch failed: {type(last).__name__}")


def s3_url(key: str) -> str:
    if not key or ".." in key or not key.endswith(".fits") or key.split("/")[0] not in ("dr1", "qr3"):
        raise FetchError("bad archive key")
    return S3_BASE + key
