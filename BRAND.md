# Elara — Brand tokens & assets

The single source of truth for how the Elara brand is applied across the product
(operator portal, resident & owner SPAs, public booking site). Derived from the
Elara Brand Book. Distinctive "E" monogram + wordmark — no real-estate cliché.

## Logo — the "E" monogram

One geometric bold-E letterform (left stem + three rounded arms, middle arm
shorter), drawn as a single SVG path in a `0 0 128 128` viewBox:

```
M 24.40 29.00 Q 24.40 16.00 37.40 16.00 L 90.60 16.00 Q 103.60 16.00 103.60 29.00
L 103.60 31.51 Q 103.60 44.51 90.60 44.51 L 59.92 44.51 Q 56.08 44.51 56.08 48.35
L 56.08 48.35 Q 56.08 52.19 59.92 52.19 L 74.73 52.19 Q 86.73 52.19 86.73 64.19
L 86.73 64.19 Q 86.73 76.19 74.73 76.19 L 59.73 76.19 Q 56.08 76.19 56.08 79.84
L 56.08 79.84 Q 56.08 83.49 59.73 83.49 L 90.60 83.49 Q 103.60 83.49 103.60 96.49
L 103.60 99.00 Q 103.60 112.00 90.60 112.00 L 37.40 112.00 Q 24.40 112.00 24.40 99.00 Z
```

| Variant | Composition | Where to use |
|---|---|---|
| **App icon** | Rounded square (`rx 30`) filled with the brand gradient + the E in **white** | Portal sidebar mark, login badge, favicon, avatars, app icon |
| **Symbol** | The E path filled with the brand gradient on transparent | Tight/1-color header lockups on light surfaces |
| **Reversed** | The E in **white** on the brand color / imagery / any dark surface | Hero banners, dark headers |
| **Wordmark** | "Elara" in Plus Jakarta Sans 800 | Beside the mark in horizontal / stacked lockups |

Clear space ≥ the height of the "E". Minimum: mark 24 px · lockup 120 px wide.
The mark ships inline (SVG path + `data:` URI favicon) — no external asset fetch,
CSP-safe. It renders on light and dark because the badge carries its own gradient.

## Color

| Token | Hex | Role |
|---|---|---|
| Indigo (primary / `--accent`) | `#6572FF` | Primary actions, links, active nav |
| Violet (`--accent-2`) | `#8B6CFF` | Gradient end, secondary accent |
| Brand gradient (`--brand-grad`) | `#6D8BFF → #8B6CFF` (135°) | Logo fill, hero, primary CTA |
| Indigo soft | `#ECEFFF` | Accent-tinted surfaces |
| Ink (`--text`) | `#1B2333` | Body text (light) |
| Slate (`--muted`) | `#5C6678` | Secondary text |
| Subtle | `#8B95A8` | Tertiary text |
| Line (`--border`) | `#E4E8F0` | Borders / dividers |
| Cloud (`--bg`) | `#F5F7FB` | App background (light) |
| White | `#FFFFFF` | Cards |
| Success (`--success`) | `#10B981` | Positive / paid |
| Warning (`--warn`) | `#F59E0B` | Caution / overdue soon |
| Danger (`--danger`) | `#EF4444` | Errors / past due |

The operator portal ships these as CSS variables in both light and dark themes.
The Settings → Branding panel (or `PUT /config` with `brandColor`) lets a tenant
override `--accent`; it defaults to the Elara indigo.

## Typography

| Family | Weight | Use | Token |
|---|---|---|---|
| **Plus Jakarta Sans** | 800 | Display · wordmark | `--font-display` |
| **Plus Jakarta Sans** | 700 | Headings (h1–h3) | `--font-display` |
| **Inter** | 700 uppercase, +0.1em | Section labels | `--font-ui` |
| **Inter** | 400 / 500 | Body · UI | `--font-ui` |
| **Inter** | tabular-nums | Data · currency | `font-variant-numeric: tabular-nums` |

Loaded via Google Fonts (`Inter:400,500,600,700` + `Plus Jakarta Sans:700,800`);
falls back to the system sans stack if the network is unavailable. Every surface
sets `font-variant-numeric: tabular-nums` so money and metrics align.

## Where it's wired

- **Operator portal** (`src/api/portal.html`) — favicon, fonts, `mark()`/`elaraLogo()`
  app-icon badge (sidebar + login), palette tokens.
- **Public booking site** (`src/api/booking-site.ts`) — favicon, fonts, header mark,
  brand-gradient hero + CTA.
- **Resident SPA** (`src/api/resident.html`) & **Owner SPA** (`src/api/owner.html`) —
  favicon, fonts, indigo accent, E-monogram header mark.
