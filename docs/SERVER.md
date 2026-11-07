# Standalone server foundation

The initial `aplotd` binary runs without Tauri, a desktop window or WebView. This
is an early development component, not the completed remote-access release.
Its default HTTP mode exposes public metadata only. The explicit `--mobile`
mode adds an authenticated PWA, task commands and a persistent worker; see
[Mobile preview](MOBILE.md). GPU peer connections, device pairing and the
desktop network transport remain pending. Local CLI commands can register
projects, create tasks and run an experimental read-only Codex turn.

Build from the repository root:

```powershell
cargo build --locked --manifest-path crates/aplot-server/Cargo.toml
```

Choose a separate development data directory, then run:

```powershell
.\crates\aplot-server\target\debug\aplotd.exe --data-dir C:\AplotServerTest --listen 127.0.0.1:8123
```

The first stdout line is JSON containing the bound address and server ID. Port
`0` selects an available port. `GET /healthz` checks liveness;
`GET /api/v1/info` reports the API version, stable ID and explicit capabilities.
Use the exact bound address in the HTTP Host header. Requests with a browser
Origin header and non-loopback listening addresses are rejected in this default
metadata mode. Mobile mode also binds only to loopback by default and uses an explicitly
configured HTTPS origin behind a reverse proxy for phone access. For a trusted
WireGuard LAN, `--mobile --allow-private-http --listen <RFC1918-IPv4:port>` can
serve HTTP when the public origin exactly matches that address and port; this
mode is opt-in and does not provide PWA installation on phones. No desktop database, provider
credentials or model files are opened by this bootstrap.

`--check` opens and validates the data directory, prints metadata and exits.
Both inspection commands initialize missing server files and settle interrupted
journal state; they are not side-effect-free read-only operations.
`--snapshot` prints the private task snapshot and cursor to the local terminal;
it is an administrative inspection command, not a network endpoint. The server
initializes its separate `server-tasks.sqlite3` journal using the same task
schema as desktop and settles interrupted state on startup. It does not import
or open the existing desktop database. Desktop data import remains a subsequent
implementation step. Mobile mode supervises its own bounded Codex jobs.

Register an existing folder and create a saved task using local commands:

```powershell
$aplotServer = '.\crates\aplot-server\target\debug\aplotd.exe'
$aplotProject = & $aplotServer --data-dir C:\AplotServerTest --register-project C:\Work\MyProject --name 'My project' | ConvertFrom-Json
$aplotTask = & $aplotServer --data-dir C:\AplotServerTest --new-task $aplotProject.project.id --name 'Read project' | ConvertFrom-Json
& $aplotServer --data-dir C:\AplotServerTest --workspace
```

These are exclusive administrative modes: stop the metadata listener before
running them against its directory. Creating a task writes its workspace entry
and journal aggregate in one transaction. Project files are not copied.

For an experimental local turn, provide an absolute Codex executable path, an
available model ID and a UTF-8 prompt file (at most 64,000 bytes):

```powershell
& $aplotServer --data-dir C:\AplotServerTest --run-codex $aplotTask.task.id --codex-executable 'C:\Tools\codex.exe' --model '<model-id>' --prompt-file C:\Work\prompt.txt --command-id 'read-project-1'
```

The working directory is resolved from the saved task's project. The default
CODEX_HOME is `codex-home` inside the server data directory, with no fallback to
desktop credentials. Configure authentication for that profile separately; this
command does not log in, copy credentials or discover another account's home.
An explicit isolated profile may be supplied with `--codex-home`. This initial
adapter requires a ChatGPT account with an email reported by `account/read`;
API-key, missing-email and unknown account types fail before a turn starts.
The server stores a hash of the normalized email, not the raw email. This is an
email-level identity check: the documented API does not expose an account or
workspace ID, so different workspaces under the same email are not distinguished.

The initial adapter uses the documented [Codex app-server stdio protocol](https://learn.chatgpt.com/docs/app-server)
with read-only project files and no network access for shell tools. Unsupported
interactive requests are rejected. It starts one turn, persists streamed
messages and final status, and stops its child process. Five Aplot tools use
the experimental dynamic-tools protocol: `aplot_list_projects`,
`aplot_list_agents`, `aplot_delegate`, `aplot_task_result`, and
`aplot_propose_agent`. Tool calls are fenced to the active thread, turn and
host-assigned task generation. Repeated native call IDs replay the same response;
changed arguments under an existing ID are rejected. Arguments are limited to
64 KiB of serialized JSON and broker responses to 32 KiB. Lists may be truncated
with an explicit marker. No proposal approval tool is exposed to the model.
The first request creates a native thread. Further command IDs resume the saved
thread after checking the same canonical executable, profile home, model,
project folder and reported account identity. Failed resume never falls back to
starting a new thread. A changed account is rejected before the saved thread ID
is sent to app-server. Existing preview sessions without a stored identity must
be explicitly reset. Use `--reset-session <task-id>` to abandon that pointer and
start fresh on the next request; saved journal history is retained. Preview
threads created before the dynamic toolset binding also require a reset to gain
the new tools; their previously saved command receipts remain replayable.
Windows child trees
are owned through the shared Job Object implementation; equivalent Unix process
tree supervision is still required before claiming full Linux runtime support.

Hosted web search is separate from shell networking. An administrator can set
`web_search = "live"` in the explicit server Codex home's `config.toml` for
current research; this does not enable network access for commands. On Windows,
the isolated profile also needs a supported, configured sandbox. On compatible
systems `[windows] sandbox = "mxc"` avoids legacy administrator setup; verify
read-only command execution on the target machine. The process environment
preserves Windows `SystemDrive`, required for MXC startup, while keeping home
and temporary directories isolated. See the official [web search](https://learn.chatgpt.com/docs/web-search)
and [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) guidance.

Before starting or resuming a native thread, the server reads the effective
Codex configuration and explicitly applies its hosted search mode. A resumed
thread also receives the current host instructions through
`thread/inject_items` before its next user turn. This prevents historical
host instructions from leaving an existing conversation under an obsolete
search restriction. It retains the native thread ID, history, read-only project
policy and disabled shell networking. If the context refresh is rejected, no
new model turn starts. A host setting of `web_search = "disabled"` remains
disabled. These calls require a compatible Codex app-server version.

The same `--command-id` with the same input returns its saved receipt; a
different input under that ID is rejected. Interrupted or uncertain work is not
automatically restarted. Use a new ID only for an intentional new request.
Ctrl+C requests cancellation; `--timeout-seconds` sets the bounded run timeout
(1–3600, default 300). A failed or interrupted turn returns a nonzero exit code.
The default metadata listener keeps `taskExecution` false and accepts no task
commands. The separate mobile API advertises send/interrupt capabilities for
its explicitly configured runtime.

Delegation creates a durable queued child with bounded ancestry and
least-privilege access. A queued receipt does not mean a worker has started.
For Codex children accepted by an active standalone runtime, the transaction
also reserves the parent's canonical executable/home and account fingerprint,
with the child's saved model and project folder. These reservations are checked
even before the child's first native thread. Older preview queue entries
without a trusted execution binding fail visibly instead of adopting whichever
account is supplied later.

Run accepted Codex work using a separate bounded administrative action after
the parent turn has returned:

```powershell
& $aplotServer --data-dir C:\AplotServerTest --drain-codex-queue --codex-executable 'C:\Tools\codex.exe' --max-turns 8 --timeout-seconds 300
```

Supply the same `--codex-home` as the parent if it used an explicit home.
The queue uses each task's saved model; `--model` is not accepted for a drain.
Turns run sequentially in acceptance order, using their existing message and
turn IDs. `--max-turns` is 1–64 (default 8); the timeout applies to each turn.
The JSON report includes outcomes, remaining Codex work, unsupported queued
runtimes and cancellation. Failures, interrupted work and cancellation return a
nonzero exit code. Running or uncertain work recovered after a crash is never
automatically dispatched again. Unsupported runtimes remain queued and do not
block eligible Codex work. Unsupported profile, attachment, reasoning or local
engine settings on a Codex entry fail with a saved error rather than being
silently ignored. Project/task instructions are supplied as bounded developer
context, with an explicit truncation marker when needed.

This CLI drain is bounded. Mobile mode instead keeps a persistent sequential
worker and automatically drains eligible Codex children between root requests.
Any listener must be stopped before an administrative process can own the same directory.
`aplot_task_result` returns immediately (`waitSeconds` must be 0 or omitted):
children run after the parent, and a later parent turn can collect the saved
result. Concurrent workers and waiting within a parent turn remain future work.
Agent proposals retain frozen configuration and require a separate host-user
decision; a model cannot resolve its proposal. Restart stales pending proposals.
The standalone user approval surface and persistent interactive approvals are
still pending. The mobile API exposes task creation, messages and cancellation;
it does not expose proposal decisions or interactive approvals. The existing
desktop delegation path remains in use.

Workspace synchronization uses a v2 envelope with its own CAS revision. Task
snapshots include the workspace, task views and event cursor from one database
transaction. Desktop also exposes a separate persisted workspace snapshot read
that does not run legacy imports or move project references. A missing saved
workspace remains optional in a desktop task snapshot, preserving the initial
legacy import path.

Server-authored workspace changes publish `workspace.changed` with the workspace
revision. Ordinary desktop workspace saves currently use CAS without a push
event; another window observes those changes when it next refreshes or handles
a save conflict. This is not yet a network synchronization API.

The desktop merges workspace metadata by entity ID and field against its last
acknowledged server version. During merging, the window retains its current
drafts, attachments and selection. A conflicting save fetches the persisted envelope and retries once when
changes can be merged. Same-field, edit/delete and dependency conflicts retain
the original local metadata and stop automatic saves; they never authorize a
blind overwrite. The existing conflict indicator remains in use; a dedicated
conflict-resolution interface is still pending. During a task snapshot refresh,
later journal events are buffered and replayed above its cursor. Stale snapshots
and failed snapshot application are retried without discarding that buffer.

The standalone database is schema version 3. Earlier preview data is upgraded
additively; a newer schema is rejected by older binaries that enforce this
version check. This does not migrate the installed desktop database.
The server holds an OS file lock for its lifetime. A second process using the
same directory fails; stopping the process releases the lock. Invalid or newer
identity files are rejected rather than replaced. Ctrl+C shuts the HTTP listener
down gracefully. Normal desktop exit behavior is unchanged at this stage.

The shared `aplot-core` crate contains the extracted task journal and approval
state machine and the event publication boundary used by desktop. It has no
Tauri dependency. Subsequent changes can attach the existing runtime adapters
to this shared storage without creating a second task implementation.

Checks:

```powershell
cargo test --locked --manifest-path crates/aplot-core/Cargo.toml
cargo test --locked --manifest-path crates/aplot-server/Cargo.toml
```

CI also checks these independent components on Windows and Linux. This does not
establish Linux support for the existing provider runtimes or local GPU engines.
