# SphereX design notes

**What the page is for:** type a place in the sky, watch it change. The first thing a visitor does is
search; the first thing they see afterwards is the image playing.

**Character: a darkroom blink comparator.** Pluto was found by flipping between two photographic plates.
SphereX is that instrument for SPHEREx data, so the page borrows from the plate archive: a sharp-cornered
plate with registration ticks, a logbook entry beside it, a date stamped in narrow numerals.

**Feel reference:** NASA's Eyes on the Earth (the data fills the view, thin controls at the edges, "what"
and "when" always in the same place). We borrow the feel, not the look.

## Colour
| Name | Value | Used for |
|---|---|---|
| Darkroom | `#0E0D0B` | page |
| Bench | `#1A1815` | panels, controls |
| Rule | `#2E2A24` | hairlines, no-data hatching |
| Paper | `#ECE6DA` | text |
| Dust | `#9C9486` | secondary text |
| Safelight | `#F0A04B` | only "this is active": playhead, focus ring, pressed control |

**All vivid colour belongs to the data.** Every frame is tinted by the wavelength it was taken at, on a
ramp from 0.75 µm (`#6F7BFF`) through `#35C6C0`, `#B9D650`, `#FFB13D` to 5 µm (`#E8472B`). Timeline
ticks use the same ramp, so a visitor can see the colour sweep inside each visit. The interface itself
never uses these colours.

## Type
Archivo (variable width) only. Width 100 for text; width 68, weight 600, tabular numerals for the date
and other numbers. Sizes 13 / 15 / 20 / 28, date `clamp(40px, 5.2vw, 76px)`.

## Layout
```
desktop                                        phone
┌──────────────────────────┬───────────────┐   ┌───────────────┐
│                          │ search        │   │ search        │
│        plate             │ Observed on   │   │ plate         │
│     (the image)          │ 15 Aug 2025   │   │               │
│                          │ colour · det  │   │ 15 Aug 2025   │
│                          │ status        │   │ colour · det  │
├──────────────────────────┴───────────────┤   ├───────────────┤
│ ▶  ◀ ▶   ▍▍▍▍▍▍▍   ▍▍▍▍▍▍▍   ▍▍▍▍▍▍▍    │   │ ▶ ▍▍▍▍ ▍▍▍▍   │
└──────────────────────────────────────────┘   └───────────────┘
```
Left-aligned text. The plate is square and sharp-cornered; controls have 4 px corners.

## Motion
Frames switch instantly (a fade would hide motion). Controls respond in 120 ms. With reduced motion on,
nothing plays until asked.

## Not this
No glow, gradients on text, purple, card grids, emoji icons, all-caps labels, monospace labels, arrows on
buttons, or strings of facts joined by dots.
