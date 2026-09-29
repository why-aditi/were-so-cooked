The React SPA (section 10). React 19, Vite, TypeScript, React Router, TanStack Query, `useAgent` + `useAgentChat`, Tailwind. Served from Workers static assets.

## Design system

`src/index.css` holds the whole visual system. The organising idea is a fridge door: things the agent produces arrive stuck on, with thick borders, hard offset shadows and a degree of rotation.

The rule that makes that mean something is the inverse. Section 10 says safety, allergy and data-loss messages stay plain and sentence-case — so anything carrying that weight also drops the tilt and the shadow and squares its corners. `.sticker` and `.sober` are the two halves; every card picks one. The profile screen is `.sober` throughout, because it is nothing but those three categories.

Accents are semantic, never decorative: marigold acts, chilli warns, mint confirms, ultramarine is work in progress.

## Accessibility

`src/lib/contrast.test.ts` parses `index.css` and checks every colour pair in both themes against WCAG AA. It reads the stylesheet rather than duplicating the values, so a token changed in one place and not the other fails rather than drifting. It also asserts the light theme defines every semantic token, that reduced motion is respected, and that a visible focus style exists.

Beyond that: real form controls over styled `div`s, a skip link, keyboard-reachable everything, `aria-live` on states that change without a click, and colour never used as the only signal.

## Screens

Every route in section 10's table exists. Chat, pantry, profile, inbox, trending and status are complete against the section 11 API. Plan and grocery render their real (empty) state: both depend on `WeeklyPlanWorkflow`, which is not built, and neither fabricates a week to look finished.
