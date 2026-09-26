# Co-op wire protocol (v1)

Transport: WebSocket text frames carrying JSON. The Electron main-process
relay (`electron/src/coop/`) broadcasts every message to all connected
clients except the sender, including back to the host's own renderer.
Clients MUST ignore messages whose `from` equals their own `clientId`
(the relay echoes them).

All messages share the envelope:

```json
{ "t": "<type>", "v": 1, "from": "<clientId>", ... }
```

`v` is the protocol version. Drop messages with unknown `v`. Unknown `t`
values MUST be ignored (forward compatibility).

## Message types

### `hello` (client → all, on connect)

```json
{ "t": "hello", "from": "<id>", "name": "Player" }
```

The host replies with `welcome`. Anyone may update their peer list UI.

### `welcome` (host → joining client)

```json
{ "t": "welcome", "to": "<clientId>", "dump": { ...SerializedGame... } }
```

`dump` is exactly what `SavegameSerializer.generateDumpFromGameRoot`
produces. Clients ignore it unless `to` matches their `clientId` or is
`"*"` (host-initiated resync of everyone). Hosts never apply welcomes.

### `sync-check` (client → host, every 15s)

```json
{ "t": "sync-check", "hash": "1a2b3c4d", "seq": 1234 }
```

`hash` is an FNV-1a checksum over the structural sim state (map seed,
entity count + UID xor, hub level, upgrade levels, stored shapes).
`seq` is the sender's latest `ops` sequence number (diagnostic for now).
The host compares against its own hash: two consecutive mismatches
trigger a targeted `welcome`; auto-resyncs are rate-limited to one per
peer per minute.

### `resync-request` (client → host)

Ask the host for a targeted `welcome`. Also available as the host's
`welcome` with `to: "*"` (resync everyone).

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
```json
{ "t": "ping-req", "to": "*", "t0": 1727260800000 }
{ "t": "pong", "to": "<clientId>", "t0": 1727260800000 }
```

Round-trip measurement for the peer list. `pong` is only processed when
`to` matches the local client.

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

- `seq` is a per-sender monotonic counter (gap detection is future work;
  it is echoed back in `sync-check` today).
- `place`: `entity` is one entry of the serialized entity map
  (`entity.serialize()`). If the UID is already present, skip it.
  Otherwise deserialize it and bump `entityMgr.nextUid` past it.
- `delete`: look up by UID, `tryDeleteBuilding` if found.
- Receivers MUST NOT rebroadcast applied ops.

UID spaces: host allocates even UIDs, clients odd (see mod), so
host↔client placements never collide. Client↔client collisions resolve
as first-writer-wins (late duplicate UID is dropped).

### `hub-upgrade` (either → all)

```json
{ "t": "hub-upgrade", "upgradeId": "belt", "level": 3 }
```

Receiver purchases the upgrade until its local level reaches `level`.

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
`HubGoals.handleDefinitionDelivered`. Keys are `ShapeDefinition.getHash()`
strings, resolvable via `shapeDefinitionMgr.getShapeFromShortKey`.

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
