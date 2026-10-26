<a id="reading-order"></a>
# Learning path

## Suggested order

1. Read [App.tsx](../../src/App.tsx) to see how the shell, navigation, and initialization fit together.
2. Trace state in [control.ts](../../src/store/control.ts): settings, profiles, lifecycle, and runtime polling.
3. Read [types/app.ts](../../src/types/app.ts), [types/config.ts](../../src/types/config.ts), and [types/runtime.ts](../../src/types/runtime.ts) to connect UI data to runtime data.
4. Find the native handler in [lib.rs](../../src-tauri/src/lib.rs), then trace `api_docs.rs` and the relevant engine adapter.
5. For connections, start with [ApiDocsView.tsx](../../src/views/ApiDocsView.tsx), then read [ConnectionPanel.tsx](../../src/features/connections/ConnectionPanel.tsx) and [services/connections.ts](../../src/services/connections.ts).
6. Read [harnesses.ts](../../src/features/connections/harnesses.ts), then the transformation and conflict tests.

## Questions to ask while reading

- Where is the source of truth, and does a value come from the active run or an editable draft?
- Was endpoint state observed in a response or merely configured?
- Is network work cancelled when the run changes, the panel closes, or a timeout expires?
- Could a diagnostic message include a key or user response body?
- Is the harness schema officially documented, and was the installed version tested?

## Checks

`npm test -- tests/connections.test.ts tests/harnessTemplates.test.ts` runs the related Vitest cases from `app/`. `node scripts/verify-docs.mjs` from `app/` checks RU/EN structure and local links. `npm run verify:source` also runs the frontend source checks. Each result applies only when that command was actually run on the current checkout.
