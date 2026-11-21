# Aplot Control LLM visual system

This document records the desktop app's current visual language: actual colors and CSS tokens, their effective values, control shapes, states, motion, responsive rules, and extension points. Use it as a reference when changing the interface or handing work to another developer.

## Source of truth and cascade order

The current style entry point is [styles/kontur/index.css](../../src/styles/kontur/index.css), imported by [main.tsx](../../src/main.tsx). It first places the older index.css, polish.css, and studio.css files in the low-priority legacy layer. The design tokens, base rules, components, shell, screens, responsive rules, glass layer, and motion follow:

    legacy → tokens → base → components → shell → screens → responsive → glass → motion

The base system's tokens are defined in [tokens.css](../../src/styles/kontur/tokens.css). The [glass.css](../../src/styles/kontur/glass.css) layer overrides some values for the "Contour · Glass" theme, so this document lists the original semantic values and the effective glass values separately. Components should use semantic --k-* roles instead of hard-coding HEX colors.

When rules conflict, the later cascade layer takes precedence. features.css and agent-workspace-v3.css are also in the glass layer and can refine components. A local component style can define an exception when its function requires one.

## 1. Design character

The interface is a technical workspace and instrument panel behind smoked glass. Its foundation is graphite, cool light text, fine outlines, and a single soft lime accent. Transparency, inner highlights, and shadows separate panels; colored auras show system state and active runs.

The light theme uses the same roles and structure: a warm gray-green background, translucent white surfaces, dark green-graphite text, and a deeper green accent.

Design principles:

- Build visual hierarchy with contrast, density, and a small number of accents.
- Use lime to highlight activity, focus, and the primary action.
- Use each run's color as its identifier in lists and metrics.
- Do not combine heavy borders and strong shadows on the same surface.
- Use blur selectively on large panels and overlays, not on every card.
- Distinguish states with color plus text, an indicator, or shape, not color alone.
- Keep numbers and technical identifiers compact and precise.

## 2. Color tokens

### 2.1. Primitive palette

| Token | Value | Role |
|---|---:|---|
| **--graphite-0** | #0b0d10 | Darkest graphite shade |
| **--graphite-1** | #0e1114 | Chrome and shell in the base theme |
| **--graphite-2** | #13171b | Base surface |
| **--graphite-3** | #181d22 | Raised surface |
| **--graphite-4** | #1f252b | Hover surface |
| **--graphite-5** | #283038 | Stronger border |
| **--graphite-6** | #36404a | Lightest graphite shade |
| **--graphite-7** | #929da8 | Muted text |
| **--graphite-8** | #acb6c1 | Secondary text |
| **--graphite-9** | #ccd3da | Light neutral midtone |
| **--graphite-10** | #edf1f4 | Primary light text |
| **--lime-300** | #c8f27c | Dark-theme accent |
| **--lime-700** | #3d7a1c | Light-theme accent |
| **--red-300** | #ff7070 | Error/danger state in the dark theme |
| **--red-700** | #c22f2a | Error/danger state in the light theme |
| **--amber-300** | #f2b85b | Warning/pending state in the dark theme |
| **--amber-700** | #8c5800 | Warning/pending state in the light theme |
| **--cyan-300** | #62c9ec | Informational state in the dark theme |
| **--cyan-700** | #15739e | Informational state in the light theme |

### 2.2. Base semantic roles from tokens.css

These values belong to the base token layer. Colors that the glass layer does not override remain in effect in the current interface.

| Role | Dark base | Light base |
|---|---|---|
| **--k-bg** | --graphite-0 (#0b0d10) | #f2f3f0 |
| **--k-chrome** | --graphite-1 (#0e1114) | #f9faf7 |
| **--k-surface** | --graphite-2 (#13171b) | #ffffff |
| **--k-raised** | --graphite-3 (#181d22) | #f6f7f4 |
| **--k-hover** | --graphite-4 (#1f252b) | #eceee9 |
| **--k-line** | #222930 | #e2e5df |
| **--k-line-2** | --graphite-5 (#283038) | #ccd2c9 |
| **--k-text** | --graphite-10 (#edf1f4) | #151914 |
| **--k-text-2** | --graphite-8 (#acb6c1) | #4b5548 |
| **--k-text-3** | --graphite-7 (#929da8) | #596454 |
| **--k-accent** | --lime-300 (#c8f27c) | --lime-700 (#3d7a1c) |
| **--k-accent-ink** | #132008 | #ffffff |
| **--k-accent-soft** | #c8f27c14 | #3d7a1c12 |
| **--k-focus** | --lime-300 | --lime-700 |
| **--k-ok** | --lime-300 | #3a7a1b |
| **--k-warn** | --amber-300 | --amber-700 |
| **--k-danger** | --red-300 | --red-700 |
| **--k-info** | --cyan-300 | --cyan-700 |
| **--k-ok-soft** | #c8f27c12 | #3a7a1b12 |
| **--k-warn-soft** | #f2b85b14 | #9c640012 |
| **--k-danger-soft** | #ff707016 | #c22f2a10 |
| **--k-info-soft** | #62c9ec14 | #15739e10 |
| **--k-selection-bg** | #285876 | #c5e5fb |
| **--k-selection-text** | #f5fbff | #102b40 |
| **--k-run-ink** | #0b0d10 | #ffffff |

### 2.3. Effective glass.css surfaces

These roles override the base background, surfaces, lines, and some effects. Suffixes such as 08, 0d, and 12 in alpha colors represent opacity in CSS hex notation.

| Role | Dark glass mode | Light glass mode |
|---|---|---|
| **--k-base** | #06080b | #e9ede6 |
| **--k-bg** | #0a0d1080 | #ffffff8c |
| **--k-chrome** | #0c1014a0 | #f7f9f4b8 |
| **--k-surface** | #ffffff08 | #ffffff9e |
| **--k-raised** | #ffffff0d | #ffffffc2 |
| **--k-hover** | #ffffff12 | #1f33190d |
| **--k-line** | #ffffff10 | #1f331914 |
| **--k-line-2** | #ffffff1c | #1f331926 |
| **--k-edge** | inset 0 1px 0 #ffffff12, inset 0 0 0 1px #ffffff0c | inset 0 1px 0 #ffffffe6, inset 0 0 0 1px #1f33191f |
| **--k-glass-shadow** | 0 1px 0 #ffffff08 inset, 0 18px 40px -24px #000c | 0 1px 0 #fff inset, 0 18px 40px -26px #2a3d2340 |
| **--k-over-bg** | #12171ccc | #fbfcf9d9 |
| **--k-over-solid** | #12171c | #fbfcf9 |
| **--k-shadow-over** | 0 30px 80px -20px #000d, 0 0 0 1px #ffffff14, inset 0 1px 0 #ffffff14 | 0 30px 80px -24px #24361f40, 0 0 0 1px #1f331917, inset 0 1px 0 #fff |
| **--k-accent-glow** | 0 0 0 1px #c8f27c2e, 0 6px 20px -8px #c8f27c38 | 0 0 0 1px #3d7a1c26, 0 6px 18px -8px #3d7a1c40 |
| **--k-aura-strength** | 1 | .75 |
| **--k-grain** | .035 | .02 |
| **--k-blur-pane** | blur(28px) saturate(1.35) | blur(28px) saturate(1.35) |
| **--k-blur-over** | blur(32px) saturate(1.5) | blur(32px) saturate(1.5) |
| **--k-ease** | cubic-bezier(.16, 1, .3, 1) | cubic-bezier(.16, 1, .3, 1) |
| **--k-spring** | cubic-bezier(.32, 1.28, .5, 1) | cubic-bezier(.32, 1.28, .5, 1) |

Key surface roles: --k-bg is for recesses, fields, and code; --k-chrome for the large shell; --k-surface for cards; --k-raised for elevated elements; and --k-hover for hover feedback. Do not use these roles as interchangeable fills.

The base --k-ease formula in tokens.css is cubic-bezier(.2, .8, .2, 1). The base --k-shadow-over values are 0 24px 64px #000b, 0 0 0 1px var(--k-line-2) in the dark theme and 0 24px 64px #1a28122e, 0 0 0 1px var(--k-line-2) in the light theme. The current glass layer replaces them with the values in the table above.

The glass layer also overrides selector values from tokens.css: in the dark theme, --k-select-bg changes from #181d22d9 to #ffffff0a, --k-select-border from #dce9f01c to #ffffff17, and --k-dropdown-bg from #1a2026ed to #151a20d6. In the light theme, --k-select-bg changes from #ffffffcc to #ffffffb3, --k-select-border from #263a2428 to #1f331921, and --k-dropdown-bg from #fbfdf9ed to #fbfcf9e0. Unchanged values are listed in section 2.5.

### 2.4. Charts, runs, and memory

For completeness, the base --k-dropdown-border values in tokens.css are #dae7ee27 in the dark theme and #233b242c in the light theme; the glass layer replaces them with the values in section 2.5. The base --k-dropdown-solid values are #1a2026 in the dark theme and #fbfdf9 in the light theme; the glass layer does not override them.

The --series-N sequence supplies chart colors; --run-N supplies colors that distinguish processes. These colors cycle across multiple runs.

| Token | Dark theme | Light theme |
|---|---|---|
| **--series-1** | #c8f27c | #4e8f22 |
| **--series-2** | #62c9ec | #1679a3 |
| **--series-3** | #68cbb1 | #127c67 |
| **--series-4** | #f2b85b | #b07400 |
| **--series-5** | #80aee8 | #375f9c |
| **--series-6** | #4fd1b5 | #0f8a74 |
| **--run-1** | #7bc2db | #126486 |
| **--run-2** | #68cbb1 | #086755 |
| **--run-3** | #e4b66d | #7f5300 |
| **--run-4** | #80aee8 | #375f9c |
| **--run-5** | #a7c581 | #386617 |
| **--run-6** | #86c9c6 | #226e70 |
| **--k-memory-vram** | #62c9ec | #15739e |
| **--k-memory-ram** | #68cbb1 | #127c67 |
| **--k-hatch** | #ffffff12 | #00000012 |
| **--k-grid** | #ffffff0d | #0000000c |

### 2.5. Selectors and dropdown menus

Exact values from tokens.css after glass overrides:

| Token | Dark theme | Light theme |
|---|---|---|
| **--k-select-radius** | 11px | 11px |
| **--k-dropdown-radius** | 15px | 15px |
| **--k-select-bg** | #ffffff0a | #ffffffb3 |
| **--k-select-border** | #ffffff17 | #1f331921 |
| **--k-select-hover** | #e2edf00b | #39533b0c |
| **--k-select-shadow** | inset 0 1px 0 #ffffff03 | inset 0 1px 0 #ffffffb3 |
| **--k-dropdown-bg** | #151a20d6 | #fbfcf9e0 |
| **--k-dropdown-solid** | #1a2026 | #fbfdf9 |
| **--k-dropdown-border** | #ffffff1c | #1f331921 |
| **--k-dropdown-shadow** | 0 18px 50px #00000050, 0 3px 12px #00000025 | 0 18px 50px #263e251f, 0 3px 12px #263e2510 |
| **--k-dropdown-selected** | #c8f27c17 | #3d7a1c14 |
| **--k-dropdown-scrollbar** | #c8d2dc50 | #425c3c4d |

A selector trigger is usually at least 40 px tall; the version next to the model or reasoning-level control can be more compact. Dropdown options are 38 px tall and the menu search field is at least 36 px tall. When the menu opens, the chevron rotates; the selected option gets a soft accent background and a check mark.

### 2.6. Compatibility with legacy styles

tokens.css maps old names to current roles. They remain available to existing components, but new code should prefer --k-*.

| Legacy token | Current role |
|---|---|
| **--bg** | --k-bg |
| **--surface**, **--surface-1**, **--panel** | --k-surface |
| **--surface2** | --k-raised |
| **--surface3** | --k-hover |
| **--border**, **--line** | --k-line |
| **--border2** | --k-line-2 |
| **--text** | --k-text |
| **--muted** | --k-text-2 |
| **--green**, **--success** | --k-ok |
| **--blue** | --k-info |
| **--violet** | --series-3 |
| **--orange**, **--warning** | --k-warn |
| **--red**, **--danger** | --k-danger |
| **--accent**, **--studio-accent** | --k-accent |
| **--studio-ink** | --k-accent-ink |
| **--studio-tint** | --k-accent-soft |
| **--studio-line** | color-mix(in srgb, var(--k-accent) 32%, transparent) |
| **--studio-panel**, **--studio-glass** | --k-surface |
| **--studio-shadow** | none |
| **--studio-ease** | --k-ease |
| **--shadow** | --k-shadow-over |
| **--engine-bg** | --k-raised |
| **--engine-border** | --k-line-2 |
| **--engine-color**, **--capability-color** | --k-text-2 |

## 3. Geometry, sizing, and fonts

### 3.1. Radii and grid

| Token | tokens.css base | Effective glass.css value |
|---|---:|---:|
| **--k-r-xs** | 3px | 6px |
| **--k-r-ctl** | 4px | 10px |
| **--k-r-card** | 6px | 16px |
| **--k-r-over** | 8px | 20px |
| **--k-r-pill** | 999px | 999px |
| **--k-r-pane** | — | 22px |
| **--k-pane-gap** | — | 10px |
| **--k-nav-h** | — | 34px |
| **--k-nav-gap** | — | 3px |
| **--k-sidebar-w** | 220px | 220px, varies by breakpoint |
| **--k-rail-w** | 80px | 80px |
| **--k-topbar-h** | 48px | 52px, 44px in compact mode |
| **--k-status-h** | 26px | 30px |

The logical steps are 6 px for a small element, 10 px for a control, 16 px for a card, 20 px for a menu or dialog, and 22 px for a large panel. Context-specific exceptions can use a 50% circle or a 999 px pill.

### 3.2. Typography

| Token | Value |
|---|---|
| **--k-t-10** | 10.5px |
| **--k-t-11** | 11px |
| **--k-t-12** | 12px |
| **--k-t-13** | 13px |
| **--k-t-15** | 15px |
| **--k-t-20** | 20px |
| **--k-t-26** | 26px |
| **--k-f-ui** | "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif |
| **--k-f-disp** | "Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif |
| **--k-f-mono** | "Cascadia Mono", "Cascadia Code", Consolas, monospace |

Base text is 13px / 1.45. Message body text is 14px with a line height of about 1.6–1.7. Section headings use 20px; numeric values can use 20–26px. Metadata is usually 11–12px. Use tabular figures for monospace values: font-variant-numeric: tabular-nums.

## 4. Component rules

### 4.1. Application shell

- The desktop shell has two columns: a sidebar and a work area.
- In the glass variant, the shell is transparent with a 10px outer margin and a 10px gap; the sidebar and work area appear as separate floating panels.
- The sidebar is 220px wide in its expanded form and 80px as a compact rail. It collapses to an icon column; when expanded but not pinned, it can temporarily overlay content.
- The sidebar uses --k-blur-pane. The work area has a 22px radius, a fine inner edge, and a large diffused shadow.
- The top bar is transparent and 52px tall; the status row is transparent and 30px tall.
- Navigation uses one shared sliding indicator instead of a set of unrelated bright tiles. The selected item has a soft background, a lime marker, and an accent icon.
- The selected server/run uses its own color channel, --c; a small LED and status text show activity.

### 4.2. Cards and panels

Standard cards use --k-surface, --k-r-card, --k-edge, and --k-glass-shadow. In the glass layer they generally have no separate visible border. Leave enough room between cards to avoid a continuous grid of borders.

Use a semantic stripe or accent edge to call attention to a state. For example, show a warning with a narrow amber stripe rather than filling the entire panel with amber.

### 4.3. Buttons

Base button (.uiButton):

- Minimum height 32px, with 14px horizontal padding.
- 12px UI font at medium weight.
- --k-raised background, no hard border, and --k-edge.
- --k-r-ctl radius (10 px).
- Hover slightly strengthens the background; an active press briefly scales to scale(.97).

Current hover/primary values in glass.css:

- Regular hover background: color-mix(in srgb, var(--k-text) 12%, transparent).
- Primary gradient: linear-gradient(180deg, color-mix(in srgb, var(--k-accent) 86%, #fff), var(--k-accent)).
- Primary shadow: inset 0 1px 0 #ffffff60, var(--k-accent-glow).
- Primary hover lightens the top layer to 76% accent, adds a 1px #c8f27c38 outline, and increases the shadow to 8px.

Variants:

- **Primary:** soft vertical lime gradient, --k-accent-ink text, a light inner highlight, and a subtle accent glow. On hover, the button rises by about 1 px.
- **Danger:** transparent/neutral surface, red label, and translucent red line; hover adds a soft red background.
- **Danger ghost:** no persistent border; red text and a soft red hover background.
- **Icon button:** neutral transparent button; the surface appears on hover. Add a tooltip when the function is not obvious.
- **Composer send button:** round, 36×36px, and lime; its disabled state is neutral.

Disabled controls are muted to about opacity: .5; a control that cannot be pressed should not look active.

### 4.4. Fields, selectors, and toggles

- Standard fields are at least 30px tall, with 5px 9px padding, a --k-bg background, a --k-line-2 border, and a 10 px radius.
- Make field focus immediately visible: the border mixes 70% --k-accent with transparency, a 4px outer ring uses --k-accent-soft, and a faint accent glow appears nearby. Preserve the system :focus-visible ring for keyboard navigation.
- Placeholder text uses --k-text-3.
- Use the UI font for multiline user input; reserve monospace for technical code or values.
- Dropdowns have a translucent background, a 15 px radius, a soft shadow, and an accent tint on the selected item. Use an opaque fallback background if blur is unsupported.
- A toggle is pill-shaped, about 38×22px, with a round 18px white thumb; the enabled state uses --k-accent and a restrained glow.

### 4.5. Tabs, segments, and badges

- A tab/segment group is a recessed container with an inner line, about 3px padding, and a 12–13px radius.
- An inactive segment is transparent; the active segment is raised with --k-raised, an inner edge, and a lime icon.
- A regular badge is 22px tall; a short chip is 20px. In the glass layer both are usually pill-shaped. A status uses a soft background and matching text color.
- A progress track is thin (usually 6px) and pill-shaped; its fill can have a very subtle glow in the same color.

### 4.6. Messages and composer

- Messages have a surface and an inner edge. A user message is lightly tinted with the accent and has a smaller lower-right corner (18px 18px 6px 18px).
- A code block gets a separate subdued surface, a fine inner border, and about a 12px radius.
- The chat composer is a large work surface with about an 18px radius; the text area should not look like an ordinary rectangular field.
- The current desktop agent composer uses a raised surface, a 20px radius, and 16px padding; on focus it gets a fine accent edge.
- Keep the model, agent, and reasoning-level panel compact so it does not compete with the input field.

### 4.7. Dialogs, menus, and notifications

- Dialogs, command palette, popover menus, toasts, and other large overlays use --k-over-bg, --k-r-over, --k-shadow-over, and --k-blur-over.
- The backdrop darkens the base by about 45% and blurs it by 6px.
- The command palette is up to 680px wide: its input row is 56px tall, results are 38px tall, and the selected row gets a soft background and a left/inner marker.
- A toast uses an overlay surface, a relevant icon, an optional action button, and a fine lifetime line. Pause its timer while hovered or paused.
- When backdrop-filter is unsupported, use a solid background. With prefers-reduced-transparency or prefers-contrast: more, hide the ambient field and make primary panels opaque.

### 4.8. Metrics and technical information

- Use --k-f-mono and tabular figures for speed, memory, temperature, ports, endpoints, and keyboard shortcuts.
- Keep chart grid lines and dividers weaker than the data.
- Avoid a series color that could be confused with an error or warning color where that could blur the difference between state and metric.
- Mark VRAM with blue/cyan and RAM with a mint channel.
- Label memory color segments with dark text in the dark theme and white text in the light theme through --k-run-ink.

### 4.9. Scrollbars and empty states

A scrollbar is thin, with a transparent track and a muted rounded thumb. The thumb gets lighter on hover; scrollbar arrows are hidden and corners are transparent.

An empty state uses a calm icon, a short heading, a clear explanation, and, when useful, one action. Keep the dashed border and muted text secondary so the empty area does not look like an error.

## 5. Motion and feedback

Animation tokens from [motion.css](../../src/styles/kontur/motion.css):

| Token | Value | Use |
|---|---|---|
| **--k-motion-press** | 60ms | Brief response to a press |
| **--k-motion-fast** | 120ms | Hover and color/border changes |
| **--k-motion-settle** | 220ms | Settling surfaces and shadows |
| **--k-motion-enter** | 380ms | Route canvas entrance |
| **--k-motion-ease** | cubic-bezier(.16, 1, .3, 1) | Main soft deceleration |
| **--k-motion-spring** | cubic-bezier(.32, 1.28, .5, 1) | Navigation and overlay entrance |
| **--k-ease** | cubic-bezier(.16, 1, .3, 1) in the current glass layer | General transitions |
| **--k-spring** | cubic-bezier(.32, 1.28, .5, 1) | Spring response |

In base tokens.css, --k-ease is cubic-bezier(.2, .8, .2, 1); glass.css replaces it with cubic-bezier(.16, 1, .3, 1).

Rules:

- Hover and focus must change the appearance immediately; animation only smooths the visual settling.
- Regular buttons and rows respond quickly and compress slightly when pressed.
- Action/model cards rise by at most about 2 px on hover.
- Route changes use a brief entrance with a small shift and fade; top blocks can enter in sequence with 50–150 ms delays.
- Ambient light drifts over tens of seconds; active generation adds a soft breathing effect without sharp flashing.
- Status indicators may pulse only during a real transition or active work.
- Respect prefers-reduced-motion by disabling decorative and entrance animations.

## 6. Density and responsiveness

The density preference is stored as auto, comfortable, or compact. In auto mode, compact is used when the width is below 1500px or the height is below 900px; otherwise, comfortable density applies. The logic is in [uiPrefs.ts](../../src/lib/uiPrefs.ts).

### Compact overrides

- --k-nav-h: 29px, --k-nav-gap: 1px, --k-pane-gap: 6px.
- --k-r-card: 13px, --k-r-ctl: 8px.
- Primary text size: 12.5px.
- Brand: 50px; top bar: 44px.
- Run rows get less vertical padding.
- Standard page padding: 12px 16px 16px.
- Home sections move closer together and cards become more compact.
- Base buttons and fields shrink to a minimum height of 28px.

### Glass shell and screen breakpoints

- Up to 820px high: nav 31px, gap 2px, pane gap 8px, brand 54px; page and panel vertical spacing is reduced.
- Up to 1440px wide: command field 220px; memory row is more compact.
- Up to 1360px wide: sidebar 208px, content horizontal padding 18px.
- Up to 1279px wide: some short server and endpoint details are hidden from the top row.
- Up to 1180px wide: sidebar 200px, pane gap 8px.
- Up to 1099px wide: top-bar search remains an icon; some grids become single-column.
- At 1900px and wider: work content is capped at 1600px and page side margins increase to 32px.

Compact mode preserves the same colors and contrast roles. It reduces sizes and gaps instead of creating a separate visual theme.

### Local breakpoint rules

- The agent workspace hides segmented-button labels when the center column is at most 1240px wide, and the new-task button label at 760px.
- Below 1550px, the agent composer hides the agent name and caps model selection at 300px; below 1050px, it wraps controls onto multiple rows.
- Inside the composer, at container widths up to 600px, the agent name is hidden and the model text width is constrained.
- The home grid moves to one main column at a 1200px viewport; below 900px, action lists and side panels become single-column.

## 7. Accessibility and error states

- :focus-visible uses a 2px --k-focus outline with a 2px offset.
- Text selection uses a separate blue-tinted --k-selection-bg background.
- A colored status always includes a text label or an indicator shape.
- Errors use --k-danger and --k-danger-soft; warnings use --k-warn and --k-warn-soft; informational states use --k-info and --k-info-soft.
- Error and recovery states use separate softly colored banners with an explanation and an accessible action.
- Reduced motion, increased contrast, and disabled system transparency effects are supported.
- Disabled states do not rely on color alone: they also use disabled, muted styling, and an unavailable cursor.

## 8. Dynamic CSS parameters

These are local component parameters, not global color tokens. Their values are set by logic or inline styles:

| Parameter | Purpose |
|---|---|
| **--c** | Color of a specific run, series, or active action |
| **--x**, **--y** | Ambient aura position |
| **--d** | Motion period for a specific aura |
| **--o** | Base aura opacity |
| **--nav-i** | Selected-tab index used to position the sliding indicator |
| **--aw-side** | Responsive width of the agent workspace navigation |
| **--toast-ms** | Notification timer duration; CSS fallback is 6000ms |
| **--aplot-popup-height** | Calculated selector popover height; CSS fallback is 320px |
| **--k-zoom** | CSS zoom factor in browser preview; --k-vh compensates for it in viewport height |

The base shell-height formula is --k-vh = calc(100vh / var(--k-zoom, 1)). Tauri uses webview zoom, so --k-zoom is usually not set; browser preview compensates for CSS zoom with this formula.

The base ambient aura is placed at (8%, 6%), with color #2f4a57 and opacity .7 in the dark theme; in the light theme it uses #b7cfb0 and .9. Run auras use four positions: (78%, 18%), (22%, 88%), (92%, 82%), and (46%, -6%). A regular run aura uses its --c color and defaults to .55 opacity; during generation it rises to .85. Run aura drift periods are 38 + 9 × index seconds; the base aura moves over 60 seconds. The radial gradient mixes 60% of its color at the center and 18% halfway through the radius, fading out around 72%. The lower horizon darkens the last 40% of the viewport toward --k-base. The overlay backdrop uses blur(6px) saturate(.9). The --k-grain layer adds a faint surface texture.

In the agent workspace, --aw-side is calculated as clamp(236px, 17vw, 292px). Aura position and color follow active runs; do not assign them a fixed decorative color.

## 9. Source files to change

| Purpose | File |
|---|---|
| Style entry point and layer order | [styles/kontur/index.css](../../src/styles/kontur/index.css) |
| Palette and base theme roles | [styles/kontur/tokens.css](../../src/styles/kontur/tokens.css) |
| Semantic base and components | [styles/kontur/base.css](../../src/styles/kontur/base.css), [styles/kontur/components.css](../../src/styles/kontur/components.css) |
| Window shell and sidebar | [styles/kontur/shell.css](../../src/styles/kontur/shell.css), [styles/kontur/glass.css](../../src/styles/kontur/glass.css) |
| Command palette, toast, density, mini window | [styles/kontur/features.css](../../src/styles/kontur/features.css) |
| Chat and agent composer | [styles/kontur/chat.css](../../src/styles/kontur/chat.css), [styles/kontur/agent-composer.css](../../src/styles/kontur/agent-composer.css), [styles/kontur/agent-workspace-v3.css](../../src/styles/kontur/agent-workspace-v3.css) |
| Motion | [styles/kontur/motion.css](../../src/styles/kontur/motion.css) |
| Selectors | [components/ui/AplotSelect.css](../../src/components/ui/AplotSelect.css) |
| Responsive density | [lib/uiPrefs.ts](../../src/lib/uiPrefs.ts) |
| Ambient field and dynamic run colors | [components/shell/AmbientField.tsx](../../src/components/shell/AmbientField.tsx) |

For a new component, first choose a semantic --k-* role, then use a shared primitive or an existing pattern. If the component needs its own accent, check both themes, hover, focus-visible, disabled, reduced motion, and increased contrast.
