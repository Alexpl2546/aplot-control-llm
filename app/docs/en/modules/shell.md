# Contour shell

## Responsibility and boundaries

The redesign was integrated into the main `app/` on October 13, 2026. Working source lives in `app/src`; `_redesign/` remains the first-stage archive. Production code does not import the archived copy.

[App.tsx](../../../src/App.tsx) composes the shell, routes and existing subscriptions. [KSidebar](../../../src/components/shell/KSidebar.tsx), [KTopbar](../../../src/components/shell/KTopbar.tsx) and [KStatusBar](../../../src/components/shell/KStatusBar.tsx) present state through the control facade. Components do not own processes, profiles, SQLite, jobs or resource allocation. Lifecycle calls continue through run actions and existing IPC.

[useSidebarState](../../../src/components/shell/useSidebarState.ts) owns presentation state only: pinning, hover, focus and compact mode. Engine settings are excluded. At widths up to 1279 CSS px, navigation becomes a rail and expands on hover or focus; the workspace always occupies the second grid column.

## Launches and change confirmation

The server card and Ctrl K palette share [useLaunchAction](../../../src/features/launches/useLaunchAction.ts). The pure [launchActions](../../../src/features/launches/launchActions.ts) use case accepts a typed snapshot and action port; it does not import React, Zustand or Tauri.

With unsaved changes, creating an intent neither saves the profile nor changes the run. Confirmation executes the existing `startManagedRun` / `restartManagedRun` actions, which own persistence and lifecycle. Before execution, the selected run ID, generation, draft, settings and busy state are checked again. Changes to the target or draft reject the action with an explanation. Cancellation retains the draft. A native HTML dialog contains focus and supports Escape.

Server selection remains keyed by stable `runId`. [presentation](../../../src/features/launches/presentation.ts) contains pure state rules and colors derived from IDs, so reordering the list preserves server colors. CH labels describe the current position and are not lifecycle identities.

## Memory and observability

[memoryUsage](../../../src/features/resources/memoryUsage.ts) is a pure resource presentation model, separate from the [planner](../../../src/features/resources/planner.ts). It consumes the existing llama.cpp estimator and typed input snapshots without reading the store or invoking IPC. It does not admit launches or reserve memory.

RAM/VRAM totals come from the system runtime snapshot. Server shares are estimates, not PID measurements. Only single-model llama.cpp runs with GGUF metadata are supported; other engines and routers remain in the unattributed remainder. When estimates exceed measured usage, the track and legend use identical proportional shares. The warning identifies VRAM and/or RAM; tooltips retain original estimates. Differences are not attributed to `--fit` without evidence.

## Styles and preserved capabilities

[styles/kontur/index.css](../../../src/styles/kontur/index.css) defines CSS layers and semantic tokens for RU/EN and dark/light themes. Charts resolve colors through [useCssVars](../../../src/lib/useCssVars.ts). Conflicting legacy `!important` declarations for server-card padding were removed because important declarations reverse layer precedence.

The shell preserves the library, two-engine profiles, launch editors, resource-plan preview, benchmarks, logs, API and harness connections, setup, recovery, tray and dashboard customization. The editable canvas and stored widget coordinates are not migrated. Model/engine/profile selection remains available in an expandable card section; speed and TTFT remain visible in the summary.

## Module verification

`npm run verify:modules` and CI check transitive runtime imports of seven pure entry points: launches/actions, launches/presentation, resources/memoryUsage, resources/planner, models/artifactCatalog, profiles/profileAdapters and connections/harnesses. UI, store, services, React, Zustand and native API dependencies are forbidden in their runtime graphs. Type-only dependencies are allowed. Shell imports and production dependencies on the archived redesign are checked separately.

This protects existing boundaries without declaring the entire restructuring plan complete. The control store remains a compatibility facade; legacy Rust files and the existing SQL dependency in `domain/secrets.rs` remain. Complete application/infrastructure separation is future work.
