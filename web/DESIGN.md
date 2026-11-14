# SphereX design notes

**What the page is for:** explore the infrared sky, pick a place, and see how it changed in NASA SPHEREx
images. The sky is the main screen; everything else sits at its edges.

**References:** structure from IRSA's SPHEREx Spectral Image Search (sky + search panel, Results with
Coverage), interaction from the Aladin Lite demo (drag, zoom, globe), feel from NASA's Eyes on the Earth
(full-screen data, thin translucent panels, fixed places for "what" and "where"). The flipbook follows
WiseView. Target screenshots: `RESEARCH/docs/research/target-screens/` in the team folder.

## Colour
| Token | Value | Used for |
|---|---|---|
| `--space` | `#05070B` | page and sky backdrop |
| `--panel` | `rgba(16, 22, 34, .80)` + blur | floating panels over the sky |
| `--panel-solid` | `#101622` | bars, fallback when blur is unavailable |
| `--line` | `rgba(190, 210, 240, .16)` | hairlines, control borders |
| `--text` | `#F2F5FA` | text |
| `--text-2` | `rgba(242, 245, 250, .70)` | secondary text |
| `--accent` | `#8DB7F2` | active tab, focus ring, selected control |
| `--target` | `#FFB547` | the searched position on the sky |

Wavelength swatches use the infrared ramp (0.75 µm blue → 5 µm red), only next to wavelength values.

## Type
Public Sans (USWDS), weights 400/500/600. Sizes 12 / 14 / 16 / 20. Numbers use tabular figures.
Sentence case everywhere; no all-caps labels.

## Layout (desktop)
```
┌ top bar: SphereX   [Sky] [Results]                                   About ┐
├ toolbar: Colour 0.753 µm ‹ › [1] /102 ──slider──   Background ▾   Globe | Flat ┤
│ ┌ search panel ┐                                                     [+]    │
│ │ Find SPHEREx │              the sky (Aladin)                       [−]    │
│ │ images       │                    ✛ target                                │
│ └──────────────┘                                                            │
└ status: cursor RA/Dec · field of view · data credit                 Aladin ┘
```
Left-aligned text. Panels: 8 px corners, hairline border, no shadows except a soft one under floating
panels. Controls: 6 px corners.

## Motion
Panel open/close 200 ms ease-out; fly-to uses Aladin's animation; respects reduced motion.

## Not this
No glow, gradient text, purple, card grids, emoji icons, all-caps labels, arrows on buttons, NASA logos.
