# SphereX design notes

**What the page is for:** explore the infrared sky, pick a place, and see how it changed in NASA SPHEREx
images. The sky is the main screen; everything else sits at its edges.

**References:** structure from IRSA's SPHEREx Spectral Image Search (sky + search panel, Results with
Coverage), interaction from the Aladin Lite demo (drag, zoom, globe), feel from NASA's Eyes on the Earth
(full-screen data, thin translucent panels, fixed places for "what" and "where"). The flipbook follows
WiseView. Target screenshots: `RESEARCH/docs/research/target-screens/` in the team folder.

## Colour ("mission control", 14 Nov)
No gradients, no bright colours, no highlighted backgrounds. Active state = a thin pale-steel line plus
brighter/bolder text. Data colours are muted but distinguishable.

| Token | Value | Used for |
|---|---|---|
| `--space` | `#04060A` | page and sky backdrop |
| `--panel` / `--panel-solid` | `rgba(11,16,24,.90)` / `#0A0F17` | panels and bars |
| `--line` / `--line-strong` | steel at 14% / 34% | hairlines, control borders |
| `--text` | `#DCE3EC` | text (secondary 64%, tertiary 44%) |
| `--accent` | `#9DB2C8` | thin active-state lines and focus ring only, never a fill |
| `--target` | `#C5D0DC` | the searched position on the sky |
| `--brighter` / `--dimmer` | `#39FF14` / `#8F008F` | brightness changes only: green = got brighter, purple = got fainter (Ethan's choice) |
| `--ghost-change` | `#FF0000` | ghost view only: what's new in the current frame, its rings and arrow (Ethan's choice) |

Visits: `#7F9DBB #7FA89F #B08C9B #B3A47E #9C98B8 #B48E7C`. Wavelength dots: a muted blue→red ramp.

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
