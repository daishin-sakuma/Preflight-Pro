# Preflight — working notes

Client-side print-data preflight/proofing web app (Next.js 14 App Router,
TypeScript, fully browser-side analysis — no server). Deployed on Vercel.

## Design
- **Follow `DESIGN.md`.** All UI uses the design tokens in `app/globals.css`
  (spacing / type / weight / radius / shadow / colour scales). Do **not** hardcode
  raw px for spacing, font-size, font-weight, radius, or margin — use the tokens.
- Tone: Adobe CC × shadcn — professional, minimal, restrained colour. Stroke
  (lucide-style) icons only, no emoji. Optical centering for glyphs.

## Conventions
- Keep changes theme-safe (dark + `[data-theme='light']`).
- Verify with `npx next build` before committing.
- Do **not** put any Claude/Anthropic signature in commit messages or PRs.
