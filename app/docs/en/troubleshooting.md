<a id="api-connection"></a>
# Troubleshooting

## API reference does not open

Check that the selected run is `ready` or `busy` and that its endpoint responds. `fetch_openapi_spec` accepts only a local HTTP endpoint for the current engines; URLs with user info or public HTTPS are rejected. `401/403` means the saved authentication was rejected. A bundled spec for some engines is a reference and may differ from the installed version.

## A legacy fallback is shown

Fallback means this is an older desktop backend that explicitly does not register `list_runs`; it shows only the previous runtime snapshot. The current backend registers both manager commands. If the run list loads but target retrieval fails, check the `run_connection` error and confirm that its `runId` matches the selected run. Other IPC errors are displayed and are not hidden by stale state.

## Health, model listing, and SSE disagree

- `unsupported` — the endpoint returned 404/405/501 or a response shape that this check does not recognize.
- `failed` — HTTP error, wrong model ID, invalid SSE event, error frame, or timeout.
- `cancelled` — the user cancelled the operation or changed the target.
- `partial` — no level failed, but at least one check is unsupported.

The check shows HTTP status and a safe explanation only; it intentionally does not display response bodies.

## localhost cannot be reached from a harness

`127.0.0.1` is reachable only within the same network namespace. If the harness runs in WSL, a container, or another computer, localhost refers to that environment. Use an address reachable from the harness and repeat the check there. The frontend HTTP check can be blocked by CORS even when a request from the harness environment succeeds.

## A template conflicts with the current file

Pi/OpenClaw JSON previews do not overwrite an existing provider ID and preserve unknown JSON-object fields. On conflict, choose another provider ID manually or merge the fragment outside the app. Hermes and DeepSeek Harness YAML is provided as snippets: a YAML parser, automatic merge, and undo are not implemented.
