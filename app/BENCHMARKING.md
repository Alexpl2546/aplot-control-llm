# Benchmark suites and automatic tuning

The app ships a versioned suite catalog in `src-tauri/resources/benchmark-suites.json`. SQLite seeds this catalog at startup and updates each built-in row when its suite version changes. Benchmark runs, per-window measurements, exact-answer scores, and the configuration snapshot are stored in the `benchmarks` table.

## Built-in suites

- **Throughput** streams a fixed-size request and records prompt processing, generation, first-token latency, elapsed time, and hardware peaks.
- **Context recall** generates a deterministic but seed-specific ledger, asks for 20 exact values, and scores key/value matches. The prompt is measured using the running server's chat template and tokenizer before generation.
- **Context stability** repeats recall across three windows. Each window asks the model to compress its results into a checkpoint; the next window must copy values from that checkpoint and recover new values from a fresh long prompt. The default run count repeats that sequence twice with different seeds.

Exact context suites require `POST /v1/chat/completions/input_tokens`. If the endpoint is absent, the app reports the missing capability instead of treating an estimate as an exact near-capacity test. The local Strata and QwFNfer additions are preserved in [integration patches](../integrations); engines are installed separately.

## Automatic tuning

The Performance page's **Find best configuration** action tests a small one-factor candidate set built from the current profile. It includes the baseline and supported batch, micro-batch, parallel-slot, and KV-cache choices. The Parameter Registry and detected `--help` capabilities filter the candidates; invalid configurations are skipped.

Each candidate is screened with one exact-recall run against the selected prompt size and configured quality/speed gates. Up to three passing candidates are then checked with the stability suite's full default of two independent runs across three windows each: six windows, six checkpoint compressions, and four carryover transitions. The first candidate that meets the requested gates in every window becomes a recommendation. Its full configuration snapshot is stored with the benchmark result and can be reloaded into the editor for review. The app restores the server configuration that was running before tuning; it does not silently save the recommendation over the user's profile.

Automatic parameter tuning currently supports llama.cpp single-server and router modes. Strata can run the built-in benchmark suites, but its prepared engine settings are not yet varied by the optimizer.

## Automatic selection of three profiles (0.7.7)

Enable **Automatically select three profiles** before starting a benchmark. This mode supports llama.cpp single-server and router launches. Every goal uses at least **65,536 tokens per session**; users can raise that minimum and set a search upper bound. The known scanned model context limit caps the search. With unknown metadata, the default upper bound is 262,144 or the current configured context, whichever is larger; the UI caps it at 1,048,576.

The bounded search tests the minimum, doubled context sizes and the exact upper bound, with the existing capability-filtered KV/batch variants. All candidates use one slot and disable automatic fit so the requested context cannot be silently reduced. Conflicting extra arguments are rejected before restarting. This finds the best **tested** configuration rather than claiming an exhaustive hardware optimum.

Each candidate first passes exact recall with input near the context capacity (reserving room for output/checkpoint). Passing candidates then receive a separate throughput test with the same prompt and output budgets. The three rankings are largest context, highest measured decode throughput, and an equal-weight geometric balance of normalized context and decode throughput. Finalists must also pass the full stability suite (currently two runs × three windows); failed finalists fall back to the next candidate. A shared configuration is verified once and may serve multiple goals.

Only after restoring the original server does the app save separate profiles with fresh IDs. Their descriptions reference both the throughput and stability benchmark IDs. Original profiles, editor drafts and last-known-good snapshots are preserved. No passing candidate means no new profile. Cancellation takes effect after the current operation and restores the original launch; restoration failure prevents saving. Profile or router-refresh failures are reported independently of restoration failures.

The results cards are session state; profiles and benchmark measurements remain in SQLite after restarting the app. Strata, Ollama and QwFNfer retain their existing benchmark flows; this profile search does not vary their launch parameters.

## Adding a suite

Add a new definition with a new integer `version` to `benchmark-suites.json`, keep its `kind` in sync with the Rust dispatcher, add RU and EN translation keys, and add tests for its deterministic scoring and data shape. The SQLite seed upsert refreshes built-ins at application startup; historical benchmark rows keep the version and snapshot they were run with.
