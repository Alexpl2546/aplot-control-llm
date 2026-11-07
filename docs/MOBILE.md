# Mobile preview

The mobile client is a separate PWA at `/mobile/`. It uses the standalone
server's projects and task history. It does not change the desktop interface
or import the installed desktop database automatically.

## Build and start

From the repository root:

```powershell
npm --prefix app run build:mobile
cargo build --locked --manifest-path crates/aplot-server/Cargo.toml
$aplotServer = '.\crates\aplot-server\target\debug\aplotd.exe'
& $aplotServer --data-dir C:\AplotMobile --register-project C:\Work\MyProject --name 'My project'
& $aplotServer --data-dir C:\AplotMobile --init-mobile-token
& $aplotServer --data-dir C:\AplotMobile --mobile --listen 127.0.0.1:4180 --mobile-assets .\app\dist-mobile
```

The initialization command creates `C:\AplotMobile\mobile-access.token` and
prints its path, never its value. It refuses to overwrite an existing key.
Open the private file on the server and enter the key in the mobile client's
connection screen. `--mobile-token-file` selects a different private file.
The key grants owner access to the mobile endpoints; it is not a provider key.

The final command prints a local mobile URL. Without a configured runtime it
supports browsing existing projects and history. To enable new tasks and
messages, supply the server's explicitly configured Codex executable, model
and isolated home:

```powershell
& $aplotServer --data-dir C:\AplotMobile --mobile --listen 127.0.0.1:4180 --mobile-assets .\app\dist-mobile --codex-executable 'C:\Tools\codex.exe' --model '<available-model-id>' --codex-home C:\AplotMobile\codex-home
```

Authenticate that isolated provider profile separately. The mobile client
cannot select an executable, filesystem root, provider key or authentication
home. It sends prompts to the server's configured runtime. The initial adapter
keeps project files read-only; see [Server](SERVER.md) for its runtime limits.

## Open on a phone

Expose the loopback listener through a trusted HTTPS reverse proxy, preserving
the public Host header, and start with the exact public origin:

```powershell
& $aplotServer --data-dir C:\AplotMobile --mobile --listen 127.0.0.1:4180 --mobile-assets .\app\dist-mobile --public-origin https://aplot.example.test
```

Replace the example with the server's actual HTTPS origin, without a path,
trailing slash or default port. Open `https://aplot.example.test/mobile/` on
the phone. Runtime flags from the previous example can be added to this command.
The listener remains on loopback; it is not a plaintext public API.

A manifest-based PWA installation requires HTTPS on a phone; localhost is a
development exception. Use the browser's install or Add to Home Screen action
when available. [MDN installability requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

## Trusted WireGuard LAN over HTTP

For a phone that already reaches this PC through a trusted WireGuard tunnel,
the mobile server can bind to this PC's reachable RFC1918 IPv4 address. Use the
address assigned to the PC's WireGuard interface, a fixed nonzero port, and
the exact matching HTTP origin:

```powershell
$lanIp = '10.8.0.2' # Replace with this PC's reachable WireGuard IPv4 address
$lanAuthority = '{0}:4180' -f $lanIp
& $aplotServer --data-dir C:\AplotMobile --mobile --listen $lanAuthority --public-origin "http://$lanAuthority" --allow-private-http --mobile-assets .\app\dist-mobile
```

`--allow-private-http` is valid only with `--mobile` and a concrete RFC1918
IPv4 listener. The origin must match the listener IP and port exactly; public
addresses, hostnames, wildcard binds and port `0` are rejected. Keep the
WireGuard route and host firewall limited to trusted peers. The token and exact
Host/Origin checks remain required.

This serves the client over HTTP inside the WireGuard tunnel. Phone browsers
do not treat that private HTTP origin as a secure context, so the PWA cannot be
installed or use its service worker there. Use the HTTPS reverse-proxy setup
above when PWA installation is needed.

## First workflow

Task options (`⋯` in the chat header) include **Read only** and **Full access**.
New tasks start read-only. Full access requires an explicit owner confirmation
and allows commands, network access and file changes as the server OS user,
including outside the project folder. It does not add Windows administrator
rights or mouse-control APIs. Access can change only while the task and its
queues are idle; the server checks task revision and replays matching command
IDs without applying the change twice. The native conversation stays attached.
Interactive approval mode is not available yet.

For browser regression checks, install the WebKit test browser once with
`npm --prefix app exec playwright install webkit`, then run
`npm --prefix app run test:mobile:e2e` after `build:mobile`. The suite checks
Chromium's full task flow and WebKit's authenticated task creation.

1. Connect with the server access key and choose a project.
2. Create a task, write a message, and send it.
3. Follow the task's messages and tool progress. Closing the client leaves
   accepted work with the server.
4. Cancel a queued request or stop the current task. A stale stop request
   cannot stop a newer turn.
5. If a reply is lost, use the offered retry: it keeps the original request ID
   and text. New text remains a separate draft.

The client refreshes visible history and refreshes again after returning to
the foreground. The key and private views stay in memory. Reloading requires
reconnecting. Its service worker caches only the public application shell;
private API responses and access keys are not cached for offline use.

The server persists accepted mobile commands. Queued commands can continue
after a restart with the same execution profile. Work whose dispatch was
uncertain is not automatically run again. The command list reports that state
so the user can check history before making a new request. A changed server
execution selection does not silently replace the profile of accepted work.

This preview has one server owner and sequential Codex execution. Interactive
approvals, file downloads/uploads, other runtime adapters, push notifications,
desktop data migration and real-device installation remain separate acceptance
steps. The unchanged default metadata listener still exposes no task commands;
the mobile endpoints are enabled only with `--mobile`.
