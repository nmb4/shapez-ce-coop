# Co-op wire protocol (v2)

Transport: WebSocket text frames carrying JSON. The Electron main-process
relay (`electron/src/coop/`) broadcasts every message to all connected
clients except the sender, including back to the host's own renderer.
Clients MUST ignore messages whose `from` equals their own `clientId`
(the relay echoes them).

All messages share the envelope:

```json
{ "t": "<type>", "v": 2, "from": "<clientId>", ... }
```

`v` is the protocol version. Drop messages with unknown `v`. Unknown `t`
values MUST be ignored (forward compatibility).

Clients remember the sender of their first valid `welcome` as the session
host and ignore `welcome`/`hub-state` from anyone else. The relay itself
is unauthenticated (trusted LAN only).

## Message types

### `hello` (client → all, on connect)

```json
{ "t": "hello", "from": "<id>", "name": "Player", "mv": "0.8.1" }
```

The host replies with `welcome`. Anyone may update their peer list UI.
`mv` is the co-op mod version; mismatches warn loudly since hash logic
differs between versions. **Run the same version on all sides.**

### `welcome` (host → joining client)

```json
{ "t": "welcome", "to": "<clientId>", "slot": 2, "dump": { ...SerializedGame... } }
```

`dump` is exactly what `SavegameSerializer.generateDumpFromGameRoot`
produces. Clients ignore it unless `to` matches their `clientId` or is
`"*"` (host-initiated resync of everyone), and unless it comes from the
session host. Hosts never apply welcomes.

`slot` is the client's UID allocation slot (see below); rejoins keep
their slot. The receiver keeps its own camera (the snapshot is about
buildings, not where you look) and replays locally-held pre-snapshot ops
after applying (duplicates are skipped by UID).

UID allocation uses stride 8: residue 0 = host, 1..7 = client slots
(8 players max). Receivers bump `nextUid` past seen UIDs (forward-only).

### `sync-check` (client → host, every 15s)

```json
{ "t": "sync-check", "hash": "1a2b3c4d", "seq": 1234 }
```

`hash` is an FNV-1a checksum over the structural sim state (map seed,
entity count, hub level, upgrade levels, plus per-entity identity tuples
so moves, rotations and same-UID collisions are detected).
Stored-shape counters are excluded: they legitimately differ between
delivery batches and hub-state broadcasts and must not count as drift.
`seq` is the sender's latest `ops` sequence number (diagnostic for now).
The host compares against its own hash: two consecutive mismatches
trigger a targeted `welcome`; auto-resyncs are rate-limited to one per
peer per minute.

### `resync-request` (client → host)

Ask the host for a targeted `welcome` (same per-peer cooldown as
auto-resyncs). Also available as the host's `welcome` with `to: "*"`
(resync everyone).

### `bye` (either → all, on leave)

```json
{ "t": "bye" }
```

Peer-list removal. Lists also expire after 30s of silence.

### `ping-req` / `pong` (either → all, every 10s)

Round-trip measurement for the peer list. `pong` is only processed when
`to` matches the local client.

### `cursor` (either → all, ~10Hz while in a session)

```json
{ "t": "cursor", "x": 12345, "y": -6789 }
```

Map cursor in world pixels (see `Camera.screenToWorld`), sent only when
changed since the last broadcast. Ephemeral: receivers expire it after
~2.5s without an update and never persist it.

### `ops` (either → all)

Ordered building operations, applied in array order:

```json
{
  "t": "ops",
  "seq": 41,
  "ops": [
    { "k": "place", "uid": 10422, "entity": { "uid": 10422, "components": { ... } } },
    { "k": "delete", "uid": 10410 }
  ]
}
```

- `seq` is a per-sender monotonic counter (diagnostic for now).
- `place`: `entity` is one entry of the serialized entity map
  (`entity.serialize()`) with `entity.uid === uid`. If the UID is already
  present (including queued-for-destroy), skip it. Otherwise deserialize it
  and bump `entityMgr.nextUid` past it.
- `delete`: look up by UID, `tryDeleteBuilding` if found.
- Receivers MUST NOT rebroadcast applied ops.
- Batches are capped at 5000 entries.

UID allocation uses stride 8 (see `welcome`): disjoint by construction;
any residual collision resolves as first-writer-wins and is caught by the
sync hash.

### `hub-upgrade` (either → all)

```json
{ "t": "hub-upgrade", "upgradeId": "belt", "level": 3 }
```

Receiver purchases the upgrade until its local level reaches `level`;
if funds lag behind the broadcast the receiver force-converges (the
purchaser already paid) instead of reverting on the next `hub-state`.

### `hub-state` (host → all, every 5s + on goal completion)

```json
{ "t": "hub-state", "hub": { ...HubGoals.serialize()... } }
```

Authoritative hub snapshot. Clients overwrite local hub state.
Host ignores it.

### `deliver-batch` (client → host, every 2s)

```json
{ "t": "deliver-batch", "batch": { "<shapeShortKey>": 12 } }
```

The host replays each shape through
`HubGoals.handleDefinitionDelivered`, spread over ~120 frames so analytics
slices observe smooth rates. Keys are `ShapeDefinition.getHash()`
strings, resolvable via `shapeDefinitionMgr.getShapeFromShortKey`.
Batches are capped at 256 keys with a bounded per-frame replay budget.

### `chat` (either → all)

```json
{ "t": "chat", "name": "Player", "text": "hello" }
```

### `ping` (relay → all, every 25s)

Keep-alive. Ignore.

## Main-process IPC (renderer ↔ Electron host)

- `ipcRenderer.invoke("coop-start", port)` → `{ running, port, peers, addresses }`
  where `addresses` is `[{ name, address }]` (OS interface name + IPv4).
- `ipcRenderer.invoke("coop-stop")` → status
- `ipcRenderer.invoke("coop-status")` → status
- Event `coop-peer-count` → number of relay connections
