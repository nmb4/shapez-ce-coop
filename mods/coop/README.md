# Co-op mod (v1)

Experimental 2-player (N-capable) cooperative multiplayer for shapez CE.

## How it works

- The host's Electron main process runs a zero-dependency WebSocket relay
  (`electron/src/coop/`). No extra servers, no accounts.
- The host sends a full-state snapshot on join; afterwards building
  place/delete ops, hub upgrades, hub deliveries and chat are replicated.
- The hub is host-authoritative and converges within ~5 seconds.
- The sim is locked to 60 Hz while a session is active.

## Running it

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

- Building placement and deletion on both layers (regular + wires),
  including blueprint pastes (batched) and ctrl+right-drag area delete.
- Upgrade purchases, hub level/rewards, deliveries (batched, replayed
  smoothly so throughput goals and statistics see correct rates),
  pinned shapes + waypoints (via full-state join sync).
- Live map cursors with AFK ghosts.
- Drift protection: structural checksums every 15s; the host pushes a
  full snapshot after two consecutive mismatches (max one auto-resync
  per peer per minute, with a per-building diff shown in the panel).
  Either side can also trigger a manual resync.
- Note: trash cans accept items from all four sides, so nearby belts
  prefer pointing into them. That's base-game behavior, not a sync bug —
  but if belts ever disagree between peers, the resync line names the
  differing buildings.
- Up to 8 players (host + 7 UID slots); each session is trusted-LAN
  (no auth/encryption).
- Drops and crashes are handled gracefully: peers age out within ~10s,
  the panel shows "disconnected — playing solo copy", and clients
  auto-reconnect (rejoining the host's new session if it restarted).
- Cameras, settings, keybindings: NOT synced (per-player, by design).

## The panel (bottom-right)

- **Host**: shows one `shapez://ip:port` invite per network interface
  (adapter names included, virtual adapters sorted last) with a Copy button.
  Pick the interface your friend can reach — `Tailscale` for Tailnet,
  `Wi-Fi`/`Ethernet` for LAN.
  Paste it into any client's join box (plain `ws://…` URLs and bare
  `host[:port]` work too).
- **Peers**: live list with host/you tags and round-trip latency.
  Everyone's map cursor is drawn live with their name.
- **Resync / Req sync**: manual full-state push (host) or request (client).
- **Area delete**: hold `Ctrl` and drag with the right mouse button to
  bulk-delete everything in the rectangle (affected buildings highlight
  red while dragging). Works offline too (local only);
  in a session it replicates to all peers as one batch.
- Click the title to collapse, `×` / `Hide` (or `F8`) to hide the panel
  to a pill, click the pill (or `F8`) to bring it back.
- The panel follows the game's light/dark theme and UI scale settings.
- Chat: `Enter` sends and releases the box, `Escape` or clicking the map
  releases it too.

## Known limitations

- 2 players recommended. With 3+, two clients can rarely pick the same
  UID; first-writer-wins, a periodic full re-sync is not yet implemented.
- No encryption or authentication — trusted networks (LAN/VPN) only.
- Opening dialogs pauses the LOCAL sim only; keep pauses short while
  connected or the two sims drift until hub-state converges them.
- Automatic saves keep working per-client; the host's save is the source
  of truth. Save the host's game to keep the shared factory.
- Puzzle/edit modes are not supported; use regular mode.
