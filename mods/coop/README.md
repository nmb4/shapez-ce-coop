# Co-op mod (0.10.4, protocol v4)

Experimental 2-player (N-capable) cooperative multiplayer for shapez CE.

## How it works

-   The host's Electron main process runs a zero-dependency WebSocket relay
    (`electron/src/coop/`). No extra servers, no accounts.
-   The host runs the shared factory simulation at 60 Hz. Clients render
    authoritative state updates at up to 10 Hz; they do not independently
    mine, process, transport or deliver items while connected.
-   Clients preview building edits immediately. The host validates and orders
    their commands, then acknowledges them alongside the resulting world state.
    Conflicting or unaffordable previews are corrected to the host's result.
-   Updates carry belt items, machine queues, storage, wire pin values, hub
    progress and production statistics. Production is counted once regardless
    of the number of players. Client dialogs and frame rates cannot change it.
-   Full snapshots establish a numbered baseline on join/reconnect; missing
    updates trigger a fresh snapshot instead of accumulating drift.

## Running it

Both sides must run **co-op 0.10.4 and the rebuilt game from this checkout**.
Protocol v4 is incompatible with older co-op versions. This change includes
base-game serializer fixes, so replacing only the mod in an old app is insufficient.
The co-op version is shown in the panel title.

0.10.3 fixes a production mod-API regression that could make every client state
application throw and trigger repeated full snapshots. Recovery requests now
coalesce until acknowledgement or a 15-second timeout, and flow control includes
queued compression as well as WebSocket buffering. See PERFORMANCE.md for the
incident evidence and packaged Electron verification.

0.10.4 moves large-packet inflation to a persistent worker, transfers compact
bytes back to the renderer, and expands state in short slices that allow UI
tasks between them. Packet order and complete-state receipts are preserved.
Workers fall back to inline decoding if unavailable and stop on disconnect.
This targets packet processing stalls; it does not establish live client FPS.

1. Build both processes (main + renderer). From the repo root:
   `npm i`, then `npm run gulp` in one terminal and `npm start -- --dev --load-mod mods/coop --watch`
   in `electron/` (see root README for prerequisites).
    - The `--load-mod` flag loads this unpacked dev mod; `--watch`
      reloads the game when you edit it.
2. Host: open (or start) a regular-mode game, type a name, press **Host**.
   The panel shows `hosting :47821`.
3. Client (second PC on the same network, or a second instance):
   open any regular-mode game, enter `ws://<host-ip>:47821`, press **Join**.
   The host's factory snapshot replaces your current map.
4. Build together. Chat box is in the panel (bottom-right).

Find the host IP with `ipconfig` (Windows) / `ip addr` (Linux).
Allow inbound TCP on port 47821 through the firewall.

## What syncs

-   Building placement and deletion on both layers (regular + wires),
    including blueprint pastes (batched) and ctrl+right-drag area delete.
-   Host-validated upgrade and blueprint purchases; authoritative hub levels,
    rewards, stored shapes and throughput statistics.
-   Lever toggles and constant signal edits, including wires-layer buildings.
-   Live map cursors with AFK ghosts.
-   Numbered state updates and command acknowledgements prevent arrival-order
    conflicts. Missing updates or failed applies request a full snapshot.
    Structural checksums remain a fallback; either side can manually resync.
-   Up to 8 players (host + 7 distinct UID slots). Slots never wrap onto an
    active player, and departed players release theirs.
-   Disconnects resume a solo copy. Automatic reconnection replaces that copy
    with the host's current state. Edits made while disconnected are local only.
-   Pinned shapes and waypoints are copied on full-state join/resync.
-   Cameras, settings, keybindings: NOT synced (per-player, by design).

## The panel (bottom-right)

-   **Host**: shows one `shapez://ip:port` invite per network interface
    (adapter names included, virtual adapters sorted last) with a Copy button.
    Pick the interface your friend can reach — `Tailscale` for Tailnet,
    `Wi-Fi`/`Ethernet` for LAN.
    Paste it into any client's join box (plain `ws://…` URLs and bare
    `host[:port]` work too).
-   **Peers**: live list with host/you tags and round-trip latency.
    Everyone's map cursor is drawn live with their name.
-   **Resync / Req sync**: manual full-state push (host) or request (client).
-   **Area delete**: hold `Ctrl` and drag with the right mouse button to
    bulk-delete everything in the rectangle (affected buildings highlight
    red while dragging). Works offline too (local only);
    in a session it replicates to all peers as one batch.
-   Click the title to collapse, `×` / `Hide` (or `F8`) to hide the panel
    to a pill, click the pill (or `F8`) to bring it back.
-   The panel follows the game's light/dark theme and UI scale settings.
-   Chat: `Enter` sends and releases the box, `Escape` or clicking the map
    releases it too.

## Bug reports

Every co-op event (sessions, joins, drift diffs, resyncs, errors) is
appended to `%APPDATA%/shapez-ce/coop.log` (rotated at 2 MB). After
something weird happens, run `just logs` (or `just logs 200`) and share
the output.

The sync label includes the received state rate after the first five seconds.
`host state #50` is an update counter, not a simulation tick. A healthy local
session approaches 10 updates per second. Logs now include `state performance`
records every five seconds (rate, capture/apply/decode time, compressed payload
size and socket buffering), plus `state backpressure` when waiting for a slow
client. `renderer performance` now measures canvas/HUD draw calls, draw duration,
frame gaps, zoom and canvas size separately. State timings distinguish worker
inflation, main-thread parsing, expansion work versus waits, and receive-queue
delay. Check logs on both PCs. See [PERFORMANCE.md](PERFORMANCE.md) for the
investigation and benchmark.

## Validation

`npm run test:coop` bundles the actual game source and runs the headless
regressions. They cover live factory production, unequal client frame times,
client dialogs, in-flight machine queues, shorter/empty item arrays, overlapping
builds, costs, acknowledgements, missing frames, reconnects and UID allocation.
Browser drawing and two-PC LAN performance still require live testing.

## Known limitations

-   No encryption or authentication — trusted networks (LAN/VPN) only.
-   The host must stay in the game. Host dialogs pause the shared simulation;
    client dialogs do not pause or independently advance it.
-   Item presentation updates at up to 10 Hz. There is no rendering interpolation
    yet. Live frames use component patches, cached geometry, compact belt item
    runs and native gzip compression. Two unacknowledged frames limit buffering;
    the slowest client's connection/application rate can reduce the shared
    publication rate. Large factories still incur serialization work.
-   Background timer throttling is disabled during co-op, then restored on
    leaving. This requires rebuilding the Electron main process as well as the
    renderer/mod; replacing just the mod cannot change that setting.
-   When simultaneous edits conflict, the host's processing order wins. A
    rejected client preview is rolled back when its acknowledgement arrives.
-   Automatic saves work per-player; the host's save is the source of truth.
    Save the host's game to keep the shared factory. Offline edits are discarded
    on reconnect.
-   Puzzle/edit modes and arbitrary other simulation mods are not supported;
    use regular mode with matching game/mod builds on all peers.
