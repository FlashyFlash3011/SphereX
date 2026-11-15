# SphereX

**Watch the infrared sky change.** A public web tool for NASA's SPHEREx mission, built at NASA Space Apps
Challenge 2026 for the challenge "Planet X and SPHEREx".

**Live:** https://flashyflash3011.github.io/SphereX/

## The idea

SPHEREx photographs the whole sky every six months in 102 colours of infrared light. Comparing photos of the
same spot taken at different times reveals things that **move** (nearby stars, brown dwarfs, asteroids) or
**change brightness** (variable stars). That is how Pluto was found, and how volunteers found most known brown
dwarfs.

NASA's archive already has an expert tool for SPHEREx data, but it cannot play photos over time and is built for
astronomers. SphereX follows its structure (an interactive sky, a search panel, results on the sky and in a list)
and adds what it lacks: **a flipbook over time, changes marked and explained in plain words, and the colour
fingerprint of any star.**

Only objects close to the Sun visibly move, and the coldest of them (brown dwarfs, a possible "Planet X") are
invisible to ESA's Gaia star map, which works in visible light. SPHEREx sees them in infrared. So the discovery
recipe SphereX supports is: **it moves + it is not in Gaia + its colour fingerprint is cold = a candidate new
neighbour.**

## What you can do

1. **Explore the sky.** The opening screen is SPHEREx's own all-sky infrared map as an interactive globe
   (Aladin Lite). A control steps through SPHEREx's infrared colours (planes 2-102); the 2MASS near-infrared and
   DSS visible-light colour maps are available as other backgrounds.
2. **Search.** Type an object name ("Barnard's Star", "M 42") or coordinates, or click the sky. Optional filters:
   dates, detectors (colour ranges), patch size (3′, 7′ or 13′).
3. **Coverage.** The outline of every SPHEREx photo of that spot on the sky, coloured by visit, linked to a list
   of the photos (date, visit, detector, colour range, release, link to the original file). Visits can be shown
   or hidden.
4. **Flipbook.** The photos, aligned north-up, played over time: one photo per frame, or one visit per frame (all
   photos of that visit in the chosen colour band added together). Colour band (all colours, one detector or one
   exact colour), speed, zoom, brightness range, stretch, invert, smoothing and patch size.
5. **Changes.** Each photo (or visit) is compared with an earlier visit in the same colours. Green marks what got
   brighter, purple what got fainter, rings mark clear changes, and an arrow shows where something moved. A
   **ghost** lays the earlier frame under the current one, with what is new shown in red. Both can be on at once.
6. **What changed.** Under the image, every clear change gets a plain-words verdict with its evidence, computed
   from measurements and statistical tests (no AI) and checked against Gaia: for example *"Known moving star:
   Barnard's Star"*, *"Unknown mover: candidate worth a closer look"*, *"Known star got fainter"* or *"Probably not
   real: next to a very bright star"*. Weak signals are folded away.
7. **Spectrum.** The colour fingerprint of the search position, or of any star you click in the flipbook: its brightness in every photo,
   plotted against the exact colour that photo saw, with the bands of water, water ice, methane, CO₂ and CO
   marked. Exact values on hover; CSV download.

The challenge's five test targets (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis) are
**prepared in advance** as files inside the website: they load instantly and work even when NASA's archive or
our server is unavailable.

## How it works

```
NASA/IPAC IRSA ──which photos cover this spot?──▶ Python server (FastAPI on Google Cloud Run, Virginia)
NASA's public image storage ──byte ranges──────▶   1. find every photo (SPHEREx DR1 + QR3)
                                                    2. cut a small square from each 65 MB photo
                                                    3. remove the background glow
                                                    4. redraw it north-up on one 6.15″ grid
                                                    5. label date, detector and exact colour
                                                    6. stream the squares as they are ready (~8 KB each)
                                                            │
                                                            ▼
                    Browser (GitHub Pages): adds visits, compares, explains, plots (WebGL2, plain JavaScript)
ESA Gaia DR3 (via VizieR) ─────────────────────────────────▲  star positions, motions, distances
```

- **Finding photos:** IRSA's Simple Image Access service. When the archive is overloaded the server keeps
  trying for about a minute, shows the half of the results that did arrive, and the page offers the prepared
  targets if the archive is down.
- **Cut-outs:** only the needed rows of each photo are read from NASA's public storage, ~1 s per photo.
  A 375-photo spot finishes in about 45 s; the flipbook starts after the first few photos.
- **Alignment:** every frame is resampled onto a north-up tangent-plane grid at SPHEREx's native 6.15″ pixels
  (photos from different visits are rotated by up to 180°).

### Keeping the comparisons honest

1. **Same colours only.** Each SPHEREx photo sees a star at a different colour, and stars differ in brightness
   across colours, so a naive flipbook flickers even when nothing changed. Comparisons use only the colours both
   sides share.
2. **Measured noise.** Each pixel's noise is measured from the spread between the photos of a visit (with at
   least 5 photos; otherwise from the whole image). A change counts only if it is several times its noise
   (default 5×).
3. **Stars are smaller than a pixel.** A star's pixel pattern depends on where it lands inside a pixel, which
   fakes changes at star edges; those pixels get an allowance of one fifth of a pixel. Measured: in an ordinary
   patch of sky this removed all 5 false alarms (5 → 0), while Barnard's Star's real motion still stands out.
4. **Too few photos, no comparison.** Visits with fewer than 8 photos in the chosen band are left out.
5. **Broken pixels are "no data",** never "no change".

### How a change is explained (no AI)

For each change SphereX measures, tests, and applies a written rule table:
- **Chance it is noise:** from its size against its measured noise and the number of pixels tested.
- **Seen independently:** the same comparison is repeated in each of the 6 detectors; strong evidence needs 3 or
  more, moderate needs 2.
- **In Gaia?** Gaia DR3 stars in the patch are moved to the dates being compared.
- **Does the motion match?** The object's position is measured in both (speed and direction ± uncertainty) and
  tested against Gaia's prediction (χ², 99% level).
- **Brightness and colour:** how much brighter or fainter (± uncertainty), and whether it is very red (bright
  at 4-5 µm, like a cold brown dwarf).
- **Near a very bright star?** Then it is probably glare, and the verdict says so.

## What we verified

| Check | Result |
|---|---|
| Find all photos of a spot | Barnard's Star: 358 photos in 3 visits, ~2 s |
| Alignment across the 6 detectors | the star lands within 2 pixels of the centre on every detector |
| Motion | Barnard's Star: *"Known moving star"*, measured 8.5″ ± 1.8″ north in a year, Gaia predicts 10.3″: consistent; seen in 6 of 6 detectors; distance 6.0 light years (Gaia) |
| False alarms | ordinary field (RA 150.5°, Dec +2.2°): nothing flagged |
| Spectrum | an ordinary star: smooth curve peaking near 1.6 µm, all three visits agree, no ice dips |
| Archive outages | partial results and prepared targets keep the tool usable |

## Limits

- Very bright stars (Barnard's Star, R Draconis) overflow the detector at their centres; those pixels are left
  out of measurements.
- Comparing single photos is noisier than comparing whole visits (cosmic-ray hits, noise around stars).
- Very faint movers are hard: WISE 0855 moves only ~0.6 pixel between its usable visits and is not flagged.
- The spectrum is a quick aperture measurement; IRSA's Spectrophotometry Tool is the research-grade version.
- Searching a new position depends on IRSA being available; the prepared targets are a snapshot of 15 Nov 2026.

## Run it yourself

Needs Python 3.11 (Mac, Linux or WSL; no GPU).

```bash
git clone https://github.com/FlashyFlash3011/SphereX.git && cd SphereX
./setup.sh && source .venv/bin/activate      # pinned dependencies
uvicorn server.main:app --port 8000          # then open http://localhost:8000
pytest                                       # offline tests
python tools/precompute.py                   # rebuild the prepared targets (uses the archive; slow)
```

Layout: `spherex/` (search, cut-outs, alignment, Gaia), `server/` (API), `web/` (the website),
`tools/precompute.py` (prepared targets), `tests/`.

## Credits and data

- **SPHEREx** spectral images, DR1 (DOI 10.26131/IRSA678) and QR3 (DOI 10.26131/IRSA662), and the SPHEREx DR1
  all-sky map (DOI 10.26131/IRSA679), via the NASA/IPAC Infrared Science Archive (IRSA). "This publication makes
  use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and
  Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute
  of Technology, and is funded by the National Aeronautics and Space Administration."
- **Gaia DR3** (ESA), via VizieR (CDS; mirrors at CfA and IDIA). "This work has made use of data from the
  European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data
  Processing and Analysis Consortium (DPAC). Funding for the DPAC has been provided by national institutions, in
  particular the institutions participating in the Gaia Multilateral Agreement."
- **2MASS** near-infrared colour map (via IRSA) and **Digitized Sky Survey** colour map (via ESA ESASky), as
  optional backgrounds. **Sesame** name resolver (CDS, CfA mirror).
- Inspiration: WiseView / Backyard Worlds (named in the challenge resources), and IRSA's SPHEREx Data Explorer.

Libraries and assets:
- [Aladin Lite](https://github.com/cds-astro/aladin-lite) 3.8.2, CDS Strasbourg, LGPL-3.0-or-later (unmodified
  copy in `web/vendor/`, licence included).
- [Astropy](https://www.astropy.org) 7.2.0 (BSD-3), NumPy (BSD-3), SciPy (BSD-3), FastAPI (MIT), Uvicorn
  (BSD-3), certifi (MPL-2.0).
- [Public Sans](https://public-sans.digital.gov) typeface (SIL Open Font License), via Google Fonts.

This project is not affiliated with or endorsed by NASA.

## Team

NASA Space Apps 2026, Tel Aviv.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
