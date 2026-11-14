# SphereX

**Status: being built during NASA Space Apps Challenge 2026 (14–15 Nov), challenge
"Planet X and SPHEREx". Nothing here is finished yet.**

## What it is

A public web tool for watching the infrared sky change over time. Type a sky position
(RA/Dec) or an object name, and SphereX plays the SPHEREx images of that patch as a
flipbook. Moving and changing objects stand out: nearby stars, brown dwarfs, variable
stars, asteroids and comets.

SPHEREx photographs the whole sky every ~6 months in 102 infrared colours. Each exposure
sees a given star in a different colour, so a naive flipbook flickers even when nothing
changed. SphereX only compares images taken in the **same colour**, then highlights
changes that are larger than the measured noise and shows how confident each one is.

How it is built (planned):
- A **Python pipeline** finds every SPHEREx exposure of a target in NASA's IRSA archive,
  downloads only a small cut-out of each, masks bad pixels, aligns everything north-up
  and writes compact files plus a `manifest.json`.
- A **static web viewer** (plain HTML/JS, WebGL2) loads those files and does the
  flipbook, blink, difference view and spectrum in the browser. The demo targets are
  precomputed, so the site doesn't depend on the archive's speed.

## How to run

Needs Python 3.11 (Mac, Linux or WSL; no GPU needed).

```bash
git clone https://github.com/FlashyFlash3011/SphereX.git
cd SphereX
./setup.sh
source .venv/bin/activate
```

The app itself isn't runnable yet. Instructions will be added here as the pipeline and viewer land.

## Credits and data

Data and services (to be completed as each one is actually used):
- **SPHEREx** spectral images, DR1 (DOI 10.26131/IRSA678) and QR3 (DOI 10.26131/IRSA662),
  via the NASA/IPAC Infrared Science Archive (IRSA). "This publication makes use of data
  products from the Spectro-Photometer for the History of the Universe, Epoch of
  Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion
  Laboratory and the California Institute of Technology, and is funded by the National
  Aeronautics and Space Administration."
- Inspiration: WiseView / Backyard Worlds (named in the challenge resources).

Libraries, each with its licence, will be listed here when added.

This project is not affiliated with or endorsed by NASA.

## Team

NASA Space Apps 2026, Tel Aviv. Team members and roles will be added here.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
