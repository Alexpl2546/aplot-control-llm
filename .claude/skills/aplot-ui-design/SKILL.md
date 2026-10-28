---
name: aplot-ui-design
description: Design system «Контур · Стекло» for the Aplot Control desktop UI (React + Tauri). Load before creating or restyling any screen, panel, card, dialog, settings section, icon set or animation in app/src — covers tokens, surfaces, icon tiles, motion rules, states and i18n so new UI matches the rest of the app.
---

# Aplot UI design («Контур · Стекло»)

Aplot Control is a dark-first Windows desktop app (Tauri webview, Segoe UI Variable). The style is calm graphite glass with one lime accent. New UI must look like it was always part of the app.

## Before you write UI

1. Read the tokens: `app/src/styles/kontur/tokens.css` (roles `--k-*`), `glass.css` (surfaces), `motion.css` (timings and keyframes).
2. Find the closest existing screen and copy its structure (settings: `app/src/views/SettingsView.tsx`, cards: `app/src/features/modelDownloads/`, agent UI: `app/src/styles/kontur/agent-workspace-v3.css`).
3. Primitives live in `app/src/components/ui/Primitives.tsx` (`Panel`, `Button`, `Badge`, `Switch`, `Progress`, `Select`). Use them; do not invent new button styles.

## Tokens — use roles, never raw hex

- Surfaces: `--k-bg` < `--k-chrome` < `--k-surface` < `--k-raised` < `--k-hover`. Borders: `--k-line`, `--k-line-2`, soft edge `box-shadow: var(--k-edge)`.
- Text: `--k-text`, `--k-text-2` (secondary), `--k-text-3` (hints).
- Status: `--k-ok`, `--k-warn`, `--k-danger`, `--k-info`, each with a `*-soft` tint for backgrounds.
- Accent: `--k-accent` (lime), `--k-accent-soft`, `--k-accent-ink` for text on accent.
- Categorical colour (icon tiles, segments of a bar): `--series-1…6`.
- Radii: `--k-r-ctl` 4px, `--k-r-card` 6px, `--k-r-over` 8px, pills `--k-r-pill`. Settings cards use ~10–12px.
- Type: `--k-f-ui`, `--k-f-disp` for big numbers, `--k-f-mono` for paths. Sizes `--k-t-11…26`. Numbers use `font-variant-numeric: tabular-nums`.
- Every colour must work in both `:root[data-theme="dark"]` and `[data-theme="light"]`; tints via `color-mix(in srgb, var(--c) 14%, transparent)` adapt automatically.

## Icons

- Library: `lucide-react` only, 14–16px inline, 18–20px inside tiles, `strokeWidth` default.
- Every entity a user picks or manages (engine, agent, integration, model source, folder) gets an **icon tile**: 36–40px rounded square, background `color-mix(... var(--c) 14% ...)`, icon in `var(--c)`, where `--c` is a `--series-*` colour fixed per entity. Keep the mapping in one place (see `componentCatalog.ts`).
- Icon-only buttons need `aria-label` and a `title`.
- Status is never colour alone: pair the dot/pill with a word (Установлен / Внешний / Не установлен).

## Motion

- Durations from `motion.css`: press 60ms, fast 120ms, settle 220ms, enter 380ms; easings `--k-motion-ease` (settle) and `--k-motion-spring` (playful pop).
- Allowed: list items cascading in on first render (stagger 30–40ms, max ~8 items), card lift `translateY(-1px)` on hover, chevron rotation, `grid-template-rows: 0fr → 1fr` for expanding details, bars growing with `transform: scaleX`, sticky action bars sliding up.
- Wrap all non-essential animation in `@media (prefers-reduced-motion: no-preference)`. Never delay input or actions behind an animation. Animate `transform`/`opacity`, not layout, except the grid-rows expand trick.

## Layout and states

- Settings sections render inside `.settingsWindowContent` (a container: use `@container` queries, not viewport media queries). Must work from ~520px wide.
- Each screen handles: loading (skeleton rows, not a lone spinner), empty, error (`role="alert"` + collapsible technical details), desktop-only (browser preview), busy/disabled.
- Destructive actions: select → summary bar with total → confirmation `<dialog>` that lists exactly what goes away and what is kept.

## Text and i18n

- All strings via `react-i18next` (`t("…")`), keys in `app/src/locales/{ru,en}/common.json` at minimum; other locales fall back to English.
- Russian is the primary voice: short, concrete, no jargon. Explain consequences ("модели и проекты сохранятся"), not internals.

## Verify

- `npm run typecheck` and `npm test` in `app/`.
- Look at it: `npm run dev` and open settings in the browser preview; check dark and light theme and a narrow width.
