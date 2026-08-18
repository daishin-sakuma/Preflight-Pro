# Design system

Preflight follows an **Adobe CC (Illustrator / InDesign / Photoshop) × shadcn**
tone: professional, minimal, dense-but-calm, restrained colour. The whole UI is
driven by design tokens defined in `app/globals.css` (`:root`). **Never hardcode
raw px** for spacing, font-size, font-weight, radius, or margins — use the scales
below so new UI stays consistent with the rest of the app.

## Tokens (source of truth: `app/globals.css`)

### Spacing — `var(--space-1 … --space-12)`
`2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40` px.
Use for padding, gap, and margin. Pick the nearest step; don't invent values.

### Type size — `var(--fs-2xs … --fs-lg)`
| token | px | use |
|-------|----|-----|
| `--fs-2xs` | 10 | micro labels, legends, captions, kbd hints |
| `--fs-xs`  | 11 | secondary captions, hints, small buttons |
| `--fs-sm`  | 12 | controls, form labels, body-secondary |
| `--fs-base`| 13 | body (default) |
| `--fs-md`  | 14 | filenames, emphasis, primary button |
| `--fs-lg`  | 16 | section / dialog headings |

### Font weight — `var(--fw-regular/medium/semibold/bold)` = 400 / 500 / 600 / 700
Body text `medium`/`regular`; labels & buttons `semibold`; headings & values `bold`.

### Line height — `var(--lh-tight|normal|relaxed)` = 1.3 / 1.65 / 1.8
### Letter spacing — `var(--tracking-wide|caps)` = 0.03em / 0.06em (uppercase mini-labels)

### Radius — `var(--radius-xs/sm/md/lg/full)` = 3 / 4 / 6 / 10 / 999 px
Inputs & small buttons `sm`; cards & bars `md`; modals `lg`; pills/round buttons `full`.
`--radius` is a back-compat alias of `--radius-md`.

### Shadow — `var(--shadow-panel|pop|doc|modal)`
`panel` cards · `pop` floating controls/badges · `doc` the paper/canvas · `modal` dialogs.

### Colour — semantic tokens
`--ground --panel --panel-2 --panel-3 --pasteboard --border --border-strong
--text --muted --subtle --accent --accent-strong --accent-dim --ok --warn --err
--info --ring`. All have light-theme values under `[data-theme='light']`.
Prefer `color-mix(in srgb, var(--x) N%, var(--panel))` for subtle tints rather
than new hex values.

## Principles
- **Restraint over decoration.** No loud coloured banners/borders; convey state
  with a small icon + subtle tint (see `.summaryBanner`).
- **Line (stroke) icons**, lucide-style, `currentColor`. No emoji in the UI.
- **Optical, not mathematical, centering** for glyphs/arrows (nudge toward mass).
- **Consistent control tone**: primary = filled accent; everything else = ghost
  (outlined) or bare icon button.

## Only these may stay literal px
1px hairline borders, positioning nudges (`top: 1px`, `translateX(1px)`), fixed
component dimensions (heights/widths like `44px`, `336px`, `560px`), and icon box
sizes. Everything else → a token.
