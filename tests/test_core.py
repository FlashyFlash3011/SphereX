"""Offline tests: no network needed. Run with `pytest`."""
import math
from pathlib import Path

import numpy as np
import pytest

from spherex import channels, cutout, irsa, net, positions, stack

FIXTURES = Path(__file__).parent / "fixtures"


def sep_arcsec(a, b):
    dra = (a[0] - b[0]) * math.cos(math.radians(a[1])) * 3600
    return math.hypot(dra, (a[1] - b[1]) * 3600)


# ---- positions ---------------------------------------------------------------------
def test_barnard_is_moved_to_the_observation_date():
    mjd_2025_6 = 51544.5 + 25.6 * 365.25
    got = positions.position_at(positions.KNOWN["barnard"], mjd_2025_6)
    assert sep_arcsec(got, (269.446356, 4.767070)) < 0.5


def test_wise0855_is_two_arcminutes_from_its_2010_position():
    k = positions.KNOWN["wise-0855"]
    got = positions.position_at(k, 51544.5 + 25.6 * 365.25)
    assert abs(sep_arcsec(got, (k.ra, k.dec)) - 122.6) < 1.0


@pytest.mark.parametrize("text,ra,dec", [
    ("269.45 4.69", 269.45, 4.69),
    ("269.45, -4.69", 269.45, -4.69),
    ("17:57:48 +04:41:36", 269.45, 4.6933),
    ("17h57m48s -04d41m36s", 269.45, -4.6933),
])
def test_parse_position_accepts(text, ra, dec):
    got = positions.parse_position(text)
    assert got == pytest.approx((ra, dec), abs=1e-3)


@pytest.mark.parametrize("text", ["", "<script>", "400 0", "10 95", "nan nan", "1e999 0", "25:00:00 +00:00:00",
                                  "12 ", "a" * 200])
def test_parse_position_rejects(text):
    with pytest.raises(ValueError):
        positions.parse_position(text)


def test_names_are_whitelisted():
    assert positions.valid_name("Barnard's Star")
    assert not positions.valid_name("<img src=x>")
    assert positions.find_known("  barnard's   STAR ").slug == "barnard"
    assert positions.find_known("nothing") is None


# ---- archive search ----------------------------------------------------------------
def test_sia_url_always_has_a_position_and_a_limit():
    url = irsa.build_sia_url(269.4464, 4.7671, "spherex_dr1")
    assert "POS=circle+269.446400+4.767100+0.0001" in url and "MAXREC=3000" in url
    for bad in [(float("nan"), 0), (400, 0), (10, 95)]:
        with pytest.raises(ValueError):
            irsa.build_sia_url(*bad, "spherex_dr1")
    with pytest.raises(ValueError):
        irsa.build_sia_url(10, 10, "anything_else")


def test_parse_real_sia_rows():
    rows = irsa.parse_sia_csv((FIXTURES / "sia_sample.csv").read_text())
    assert len(rows) == 3
    e = rows[0]
    assert e.obs_id == "2025W33_2C_0321_1" and e.det == 6 and e.collection == "spherex_dr1"
    assert e.key == "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
    assert len(e.footprint) == 4 and 60902 < e.t_min < 60903
    assert irsa.parse_sia_csv("") == [] and irsa.parse_sia_csv("a,b\n1,2\n") == []


# ---- network guard -----------------------------------------------------------------
class FakeResp:
    def __init__(self, body, length=None):
        self.body, self.headers = body, ({"Content-Length": str(length)} if length is not None else {})

    def read(self, n=-1):
        return self.body[:n] if n >= 0 else self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_refuses_other_hosts():
    for url in ["https://example.com/x", "http://irsa.ipac.caltech.edu/SIA", "file:///etc/passwd",
                "https://irsa.ipac.caltech.edu.evil.com/"]:
        with pytest.raises(net.FetchError):
            net.fetch(url, _open=lambda *a, **k: pytest.fail("must not connect"))


def test_fetch_retries_a_short_response():
    calls = []

    def opener(req, timeout):
        calls.append(1)
        return FakeResp(b"abc", length=10) if len(calls) == 1 else FakeResp(b"0123456789", length=10)

    assert net.fetch("https://irsa.ipac.caltech.edu/SIA", _open=opener, _sleep=lambda s: None) == b"0123456789"
    assert len(calls) == 2


def test_fetch_gives_up_and_caps_size():
    with pytest.raises(net.FetchError):
        net.fetch("https://irsa.ipac.caltech.edu/SIA", _sleep=lambda s: None,
                  _open=lambda req, timeout: FakeResp(b"abc", length=10))
    with pytest.raises(net.FetchError):
        net.fetch("https://irsa.ipac.caltech.edu/SIA", max_bytes=5,
                  _open=lambda req, timeout: FakeResp(b"x" * 99, length=99))


def test_s3_keys_are_checked():
    assert net.s3_url("dr1/level2/a.fits").endswith("dr1/level2/a.fits")
    for bad in ["", "../x.fits", "dr1/../../x.fits", "other/x.fits", "dr1/x.txt"]:
        with pytest.raises(net.FetchError):
            net.s3_url(bad)


# ---- colours and visits ------------------------------------------------------------
def test_channels():
    assert channels.channel_of(0.75) == 0
    assert channels.channel_of(4.9238) // 17 == 5  # detector 6
    assert channels.channel_of(5.00) == 101
    assert channels.channel_of(2.3074) // 17 == 2  # detector 3
    assert all(channels.channel_of(channels.channel_centre(c)) == c for c in range(102))


def test_passes_split_on_long_gaps():
    mjds = [60903, 60925, 61110, 61135, 61269, 61290, 60910]
    assert channels.assign_passes(mjds) == [0, 0, 1, 1, 2, 2, 0]


def test_progressive_order_spreads_first():
    order = channels.progressive_order(100)
    assert sorted(order) == list(range(100))
    assert max(order[:4]) - min(order[:4]) >= 64  # the first few span most of the range


# ---- redrawing ---------------------------------------------------------------------
def test_resample_recovers_a_shifted_star():
    rows = np.zeros((40, 50), np.float32)
    rows[22, 31] = 100.0
    yy, xx = np.mgrid[0:16, 0:16].astype(float)
    out = cutout.resample(rows, x0=100, y0=200, xs=xx + 123.0, ys=yy + 214.0)  # detector coords
    assert np.unravel_index(np.argmax(out), out.shape) == (8, 8)
    edge = cutout.resample(rows, x0=100, y0=200, xs=xx + 90.0, ys=yy + 214.0)
    assert np.isnan(edge[:, :9]).all()  # outside the fetched data = no data, not zero


def test_header_end_finds_where_pixels_start():
    card = lambda text: text.encode().ljust(80)  # noqa: E731
    primary = (card("SIMPLE  = T") + card("END")).ljust(2880)
    short = (card("XTENSION= 'IMAGE'") * 5 + card("END")).ljust(2880 * 8)   # detectors 3-6
    long_ = (card("XTENSION= 'IMAGE'") * 300 + card("END")).ljust(2880 * 9)  # detectors 1-2
    assert cutout.header_end(primary + short, 0) == 2880
    assert cutout.header_end(primary + short, 2880) == 2880 * 2
    assert cutout.header_end(primary + long_, 2880) == 2880 * 10
    with pytest.raises(ValueError):
        cutout.header_end(primary + card("NOEND") * 10, 2880)


def test_target_grid_is_north_up_east_left():
    w = cutout.target_wcs(150.0, 20.0, 64)
    ra0, dec0 = w.wcs_pix2world([[31.5, 31.5]], 0)[0]
    assert (ra0, dec0) == pytest.approx((150.0, 20.0), abs=1e-6)
    assert w.wcs_pix2world([[31.5, 41.5]], 0)[0][1] > dec0  # up = north
    assert w.wcs_pix2world([[21.5, 31.5]], 0)[0][0] > ra0  # left = east


def test_background_and_cuts():
    rng = np.random.default_rng(1)
    img = rng.normal(50.0, 1.0, (64, 64)).astype(np.float32)
    img[30:33, 30:33] += 500
    img[0, 0] = np.nan
    flat = cutout.subtract_background(img)
    assert abs(np.nanmedian(flat)) < 0.2
    lo, hi = cutout.display_cuts(flat)
    assert lo < 0 < hi and hi > 10


# ---- stack -------------------------------------------------------------------------
def fake_exposures(n):
    return [irsa.Exposure(f"obs{i}", 1 + i % 6, "spherex_dr1", 60900.0 + (i // 3) * 180 + i * 0.01,
                          60900.1, (), f"dr1/f{i}.fits", f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/f{i}.fits")
            for i in range(n)]


def test_stack_builds_reports_missing_and_reloads(monkeypatch, tmp_path):
    def fake_meta(key, ra, dec):
        if key.endswith("f4.fits"):
            raise net.FetchError("down")
        return cutout.Meta(key, None, 100.0, 100.0, 1.2, 0.03, 60900.5, 2, 25920)

    monkeypatch.setattr(cutout, "read_meta", fake_meta)
    monkeypatch.setattr(cutout, "cutout", lambda meta, ra, dec, n: np.full((n, n), 3.0, np.float32))
    s = stack.Stack(10.0, 20.0, 32, fake_exposures(6))
    s.build()
    st = s.status()
    assert st["done"] and st["ready"] == 5 and st["total"] == 6
    assert [m["i"] for m in st["missing"]] == [4]
    assert len(s.pixels([0, 1])) == 2 * 32 * 32 * 2
    assert s.status(after=3)["frames"] == st["frames"][3:]
    assert {f["pass"] for f in st["frames"]} == {0, 1}

    s.save(tmp_path)
    again = stack.Stack.load(tmp_path, s.id)
    assert again.done and again.status()["ready"] == 5 and again.pixels([5]) == s.pixels([5])
    assert stack.Stack.load(tmp_path, "0" * 16) is None


def test_no_data_pixels_are_marked():
    img = np.array([[1.0, np.nan], [np.inf, -5.0]], np.float32)
    back = np.frombuffer(stack.encode(img), "<f2")
    assert back.tolist() == [1.0, stack.NO_DATA, stack.NO_DATA, -5.0]


def test_too_many_exposures_are_thinned_evenly():
    s = stack.Stack(10.0, 20.0, 32, fake_exposures(stack.MAX_FRAMES + 300))
    assert len(s.exposures) == stack.MAX_FRAMES and s.truncated == 300
    assert s.exposures[0].obs_id == "obs0" and s.exposures[-1].obs_id == f"obs{stack.MAX_FRAMES + 299}"


def test_sesame_answers_are_parsed_safely():
    xml = "<Sesame><Resolver><jradeg>83.82208</jradeg><jdedeg>-5.39111</jdedeg></Resolver></Sesame>"
    assert positions.parse_sesame(xml) == pytest.approx((83.82208, -5.39111))
    assert positions.parse_sesame("<Sesame><INFO>nothing found</INFO></Sesame>") is None
    assert positions.parse_sesame("<jradeg>999</jradeg><jdedeg>0</jdedeg>") is None
    assert positions.sesame_url("M 42").endswith("SNV?M%2042")
    with pytest.raises(ValueError):
        positions.sesame_url("<script>")


def test_footprint_centre_handles_ra_wrap():
    assert irsa.footprint_centre(((359.0, 1.0), (1.0, 1.0), (1.0, -1.0), (359.0, -1.0))) == pytest.approx((0.0, 0.0), abs=1e-4) \
        or irsa.footprint_centre(((359.0, 1.0), (1.0, 1.0), (1.0, -1.0), (359.0, -1.0)))[0] == pytest.approx(360.0, abs=1e-4)
    ra, dec = irsa.footprint_centre(((10.0, 20.0), (12.0, 20.0), (12.0, 22.0), (10.0, 22.0)))
    assert ra == pytest.approx(11.0, abs=0.05) and dec == pytest.approx(21.0, abs=0.05)


def test_search_endpoint_validates_and_filters(monkeypatch):
    from fastapi import HTTPException
    from server import main
    called = []

    def fake_search(ra, dec):
        called.append((ra, dec))
        return fake_exposures(6)

    monkeypatch.setattr(irsa, "search", fake_search)
    main._searches.clear()

    def run(ra=10.0, dec=20.0, dets="1,2,3,4,5,6", date_from=None, date_to=None):
        return main.search(ra=ra, dec=dec, dets=dets, date_from=date_from, date_to=date_to)

    for bad in [dict(ra=400.0), dict(dets="7"), dict(dets=""), dict(date_from="yesterday")]:
        with pytest.raises(HTTPException) as e:
            run(**bad)
        assert e.value.status_code == 422
    assert called == []  # bad input never reaches the archive
    r = run()
    assert r["total"] == 6 and [v["visit"] for v in r["visits"]] == [0, 1]
    assert {p["release"] for p in r["photos"]} == {"DR1"} and len(r["photos"][0]["outline"]) == 0
    r2 = run(dets="1,2")
    assert {p["det"] for p in r2["photos"]} == {1, 2} and len(called) == 1  # second call served from memory
    r3 = run(date_to="2025-01-01")
    assert r3["total"] == 0 and r3["total_all"] == 6
