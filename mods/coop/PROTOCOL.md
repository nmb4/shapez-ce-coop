# Co-op wire protocol (v4)

WebSocket text frames carry JSON through the built-in Electron relay.
The relay broadcasts to other sockets; all authoritative decisions are made
by the host renderer. Every decoded game message has `{ t, v: 4, from }`. Ignore
self messages, unknown types, and incompatible versions. The relay's
versionless `ping` is a keepalive.

Only the host simulates the factory. Clients preview edits and render
replicated state; client deliveries never contribute to shared production.
Run co-op 0.10.1 with the matching rebuilt game on every peer.

Large state/welcome messages may be gzip-compressed using native browser
streams, then base64-wrapped as `{ t: "compressed", encoding: "gzip", data }`.
The inner JSON retains version/sender metadata. Encoding and decoding queues
preserve message order across asynchronous compression. Reject invalid data
and messages expanding beyond 64 MB. The relay forwards these text envelopes
without decoding them. Small/control messages remain ordinary JSON; `bye`
flushes immediately before disconnect cancels queued work.

## Join and snapshot

A connecting renderer sends `hello` with `name` and `mv` (mod version).
The host answers with a targeted `welcome`:

```json
{
    "t": "welcome",
    "to": "client-id",
    "slot": 2,
    "revision": 123,
    "ack": 8,
    "dump": { "entities": [], "beltPaths": [] }
}
```

`dump` contains the savegame fields plus network-only entity `runtime` data
and production `analytics`. These additions preserve in-flight processing
inputs, charges, pending ejects, consumption animations and reader history
that ordinary saves omit. They do not change the on-disk save format.

The host first broadcasts state revision `revision`, then sends the snapshot
of that same synchronous state. The client ignores frames until welcome,
validates the snapshot before destroying its map, restores it with placement
heuristics suspended, preserves its camera and rebuilds caches. Its canonical
baseline is set to `revision`; pending predictions newer than `ack` are
replayed and resent (the host deduplicates them).

Welcome serialization reuses that publication's detached entity/runtime and
belt capture. The savegame header and serialization hooks are retained without
walking the factory a second time. A host resync to all connected peers shares
one capture and revision, with each peer receiving its own slot/acknowledgement.

UID allocation uses stride 8: residue 0 for the host and 1..7 for clients.
A welcome must assign a nonzero client slot. Joining clients cannot build
before assignment. Receivers advance `nextUid` past observed UIDs; the host
validates each placement's residue. Slots never wrap over active peers.
`session-full` with `to` rejects a join when no slot is free.

On reconnect, abandon the disconnected copy's pending edits and wait for a
fresh snapshot and acknowledgement before issuing commands. A restarted
host may have a different id; the connection resets host discovery.

## Authoritative frames

The host publishes `state` at up to 10 Hz. Accepted edit bursts are coalesced
into the next publication instead of triggering repeated full captures.
Internally, consecutive captures carry changed/removed entities to avoid a
second full scan. Publication failure, skipped captures or a new capture owner
force full comparison; these optimizations do not change wire data or revisions.
The following is the logical decoded form (before compact wire encoding):

```json
{
    "t": "state",
    "base": 123,
    "revision": 124,
    "entities": [{ "uid": 10008, "components": {}, "runtime": {} }],
    "patches": [{ "uid": 10016, "components": {}, "runtime": {} }],
    "removed": [10001],
    "beltPaths": [],
    "hub": {},
    "time": {},
    "analytics": {},
    "acknowledgements": { "client-id": 9 }
}
```

`entities` contains additions or entities whose geometry changed;
`patches` contains only changed components/runtime groups of existing entities.
`removed` lists deleted UIDs. Unchanged belt topology is omitted: `beltUpdates`
contains changed path indices, items and first-item spacing. If topology
changes, `beltPaths` replaces the complete layout. The canonical baseline
reconstructs full entities/paths before reconciliation. Hub goals, simulation
time and analytics describe the complete state at this revision. Runtime
excludes entity/path/network pointers and other caches.

On the wire, `p` stores component/runtime tuples, `bp` stores full belt path
tuples and `bu` stores path-index updates. `itemTable` deduplicates items across
the frame; consecutive equal belt distances/items become `[distance, itemId,
count]` runs. These codecs are lossless relative to the captured data, including
fixed slot geometry and processing queues. `replication.js` defines the tuple
layouts and expands them before applying a frame.

Processor output tuples carry `[itemId, requiredSlot, preferredSlot, flags]`.
Flag bits 1 and 2 retain optional slot-field presence; co-op 0.10.2 uses bit 4
for `doNotTrack` presence and bit 8 for its boolean value. Absence stays absent,
and explicit false stays false. Host/client mod versions must match. Runtime
captures share unchanged immutable branches; client restoration keeps separate
mutable containers. Existing-UID placement retries do not count as new paid
blueprint placements.

Only frames from the elected host may mutate a client. Ignore duplicates
and older revisions. Require `base === localRevision` and
`revision === base + 1`; otherwise request a snapshot. Never apply a delta
to an unrelated baseline. Transport backpressure skips publication without
advancing the host baseline, so the next successful frame remains usable.

After successful state/welcome application, clients send targeted
`state-received` with `revision`. The host allows at most two outstanding state
revisions per welcomed client, deferring capture/publication until receipts
advance. Receipt revisions cannot exceed the host's published revision. Full
resyncs may bypass this window to recover a stalled baseline.
Compression waiting in the send queue also counts toward transport backpressure,
before those bytes reach the socket. Welcome sends coalesce per recipient until
their revision is acknowledged or 15 seconds elapse. A welcome still waiting in
the encoding queue is never duplicated, even after that timeout. Failed enqueue
attempts do not mark a recipient as welcomed.

Apply only changed entities/components against the canonical cache, removing
obsolete/colliding local previews before adding entities. Prediction rollback
also restores the entities touched by current/previous unacknowledged edits,
including a rejection arriving in the first acknowledgement. Unrelated
entities remain untouched. Keep existing entities when geometry agrees;
restore components/runtime queues and host belt items, rebuild topology caches
only when needed, then replay unacknowledged local edits. Runtime containers on
the client are reused but never alias the canonical cache. Belt paths whose
UID sequences and live entity identities still match retain their objects;
refresh nearby targets and ejectors pointing to replaced paths. Dirty affected
render chunks rather than the whole map. Wire topology rebuilds follow wire,
pin or tunnel geometry changes; pin values still update existing networks.
Never recalculate authoritative belt or wire geometry against a partial map.
Variable item arrays must shrink when restored; fixed building slot arrays
retain constructor geometry.

## Client commands

Clients send `ops` with a monotonic `seq` starting at 1. Every batch is
at most 5000 top-level commands; large deletes split into consecutive batches.
Client-to-client `ops` are ignored. Host edits enter its world directly and
are included in the next authoritative frame.

Command forms:

-   `{ k: "place", uid, entity }`: a detached serialized entity. The host
    validates UID identity/slot and game placement rules, removes replaceable
    occupants first, places tiles, then registers the entity.
-   `{ k: "delete", uid }`: delete if found and permitted by game logic.
-   `{ k: "configure", uid, component, data }`: only `Lever` and
    `ConstantSignal` component settings can be edited this way.
-   `{ k: "upgrade", upgradeId }`: attempt one purchase using host funds and
    the normal upgrade rules. No force-unlock or client-supplied target level.
-   `{ k: "blueprint", ops, cost }`: group place/delete commands under an
    immutable placement operation. `cost` is null for a free paste or
    `{ key, amount }` for blueprint shapes. Reject unaffordable transactions
    before any edits; charge once if at least one placement succeeded.

The host requires the next sequence, ignores already-processed sequences,
and acknowledges accepted/rejected work in state. A sequence gap sends a
fresh welcome. Acknowledgements mean processed, not necessarily successful;
clients discard predictions through the acknowledged sequence. Concurrent
conflicts resolve in the host's received order. Applied/predicted commands
must never be rebroadcast through local hooks.

## Recovery and ephemeral messages

-   `resync-request`: request targeted welcome; limited to one per peer per
    second at the host. Clients detect a stalled normal stream after five
    seconds; while awaiting a welcome they wait 15 seconds before retrying.
    Failed application does not reset this cooldown. States received while
    awaiting a welcome are ignored before expanding their compact item tables.

Large packets inflate in a per-connection worker. Only compact UTF-8 bytes
cross back to the renderer; cloning an expanded item/queue graph causes large
UI stalls. Main-thread expansion yields between bounded batches with a 3 ms
work target. The receive FIFO awaits complete expansion and application before
processing the next packet or acknowledging a revision. Partial frames never
enter the live world. Disconnect cancels obsolete worker/expansion work, and
worker failure retries pending packets through the inline decoder once.

-   `sync-check`: structural hash fallback every 15 seconds when no edits are
    pending. Two quiet mismatches (six during building) can request a snapshot,
    with a one-minute automatic drift cooldown.
-   `bye`: release peer/slot metadata. A host bye ends the shared session and
    resumes the client's solo copy.
-   `cursor`: world-pixel `x/y`, broadcast on movement at approximately 10 Hz.
-   `chat`: `name/text`, with text capped at 200 characters.
-   `ping-req` / targeted `pong`: `t0` timestamp for latency display.

The obsolete `deliver-batch`, `hub-upgrade` and `hub-state` types have no
mutating behavior in v4. Hub state is atomic with simulation frames.

## Main-process IPC

-   `coop-start(port)` returns `{ running, port, peers, addresses }`;
    addresses contain interface name and IPv4 address.
-   `coop-stop`, `coop-status`, and the `coop-peer-count` event manage/status
    the relay. `coop-log` writes diagnostics to the rotated co-op log.
-   `coop-active(boolean)` disables background timer/render throttling during
    a multiplayer session and restores it on departure.
