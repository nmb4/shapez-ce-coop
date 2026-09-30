# Co-op performance investigation

The 0.10.0 correctness rewrite was too expensive for a large factory. Its
100 ms timer generated and JSON-cloned a complete savegame, compared entire
serialized entities, and sent all belt layouts/items. Clients deserialized
every canonical entity, checked every belt layout and rebuilt all ejector
caches on every update. This work ran on the same JavaScript thread as input
and rendering.

The local co-op log confirms a 0.10.0/protocol-v3 host and a roughly 33-second
remote session. It records join/departure events, but no frame timings, payload
sizes or client receipt rate. It cannot establish which bottleneck dominated
that session. `host state #50` counts publications, not simulation ticks; it
should normally advance about ten times per second.

The Electron window also inherited `backgroundThrottling: true`. An obscured
or minimized renderer can have its timers/animation throttled. This is a
plausible explanation for a counter advancing once per second, separate from
the substantial CPU/bandwidth cost. Whether the host was backgrounded during
the reported session has not been verified.

## Changes in 0.10.1

-   Cache static/empty component schemas and belt topology; invalidate them on
    entity changes. Capture mutable components directly without running the
    savegame serializer and its UI/mod hooks every update.
-   Send component/runtime patches and changed belt paths. Deduplicate item
    definitions, encode known state as tuples and run-length encode equal belt
    distances/items. Preserve actual item counts and machine queues.
-   Compress large live frames and welcomes with native gzip streams. FIFO
    encoding/decoding queues preserve ordering while compression runs
    asynchronously. The relay still forwards text and needs no new dependency.
-   Apply changed entities/components only. Roll back predictions only on their
    touched UIDs, including a rejection in the first host response. Rebuild
    topology caches when geometry/path layout changes.
-   Wait for application receipts when a client is two revisions behind; check
    socket buffering before capture. Coalesce edit bursts into the periodic
    publisher. Slow connections reduce publication rate instead of accumulating
    an ever-growing queue of obsolete updates.
-   Disable Electron background throttling while co-op is active, restoring it
    on departure. Both main process and renderer/mod must be rebuilt.
-   Log rate, timing and compressed payload diagnostics every five seconds.
    Display measured receipt Hz alongside the revision counter.
-   Compare live queues with their detached captures before allocating copies.
    Reuse unchanged slot state and immutable item definitions. Avoid stringifying
    component/runtime changes twice and allocating temporary entity-map pairs.
-   Restore inventory counts without regenerating goal/upgrade definitions on
    every frame. Progression changes and rejected previews still rebuild derived
    data. Update peer-list DOM only when peer metadata or latency changes.
-   Reuse the publication capture for welcome serialization, retaining save
    hooks with a detached copy. A host resync to all peers captures once and
    sends the same revision to everyone.
-   Restore machine queues/animations into existing client containers and
    process only runtime groups present in the frame. Resolve shared item
    definitions once per application, without sharing mutable state with the
    canonical baseline.
-   Retain unchanged belt path objects across edits, checking live entity
    identity as well as UIDs. Refresh nearby acceptors/ejectors and invalid path
    references; dirty only affected render chunks. Rebuild wire topology only
    for relevant geometry changes. Welcome no longer rebuilds ejectors twice.

## Read-only benchmark

The local saved factory contains 12,909 entity records. Nine stale overlapping
records and the affected belt path were excluded **in memory only** to load a
valid headless fixture. The original save was neither modified nor rewritten.
The benchmark uses the actual game systems and serializers, with drawing
stubbed, on 12,900 buildings and 1,391 belt paths. It simulates six host ticks
between each of 20 publications, corresponding to 10 Hz at 60 simulation Hz.
The means include the first capture's cache initialization. Packet-section
diagnostics run outside the measured intervals.

Representative local means:

| Per publication                    |   0.10.0 | 0.10.1 first pass | 0.10.1 second pass | 0.10.1 third pass |
| ---------------------------------- | -------: | ----------------: | -----------------: | ----------------: |
| Host capture + delta/JSON encoding |   118 ms |             46 ms |              32 ms |             26 ms |
| Client decode + application        |    62 ms |             18 ms |              19 ms |             14 ms |
| Transmitted text payload           | 1,524 KB |             38 KB |              38 KB |             38 KB |
| Native compression elapsed time    |        — |              9 ms |              10 ms |              8 ms |

The second pass reduced host capture/encoding by approximately 30%. The third
pass reduces client decode/application from roughly 19–20 ms to 14–15 ms. Host
capture/encoding code is unchanged in the third pass; the observed host timing
difference may reflect run variation and garbage collection in the shared
headless process, and is not claimed as another host performance improvement.
Join/resync and peer DOM savings are separate from this publication benchmark.
Wire encoding and protocol remain v4.

The third-pass client breakdown is approximately 5.7 ms decompressing/parsing,
2.2 ms unpacking, 0.9 ms updating its baseline and 5.4 ms reconciling the game.
An isolated building addition retains all 1,391 paths, recomputes **one of
2,462 ejectors**, dirties none of the 265 existing chunks and performs no wire
network rebuild. Reconciliation took approximately 5 ms, including creating
the new resource/render chunk. Nearby edit targets and replaced paths are
covered separately by the regressions.

## Fourth pass: frozen input and repeated comparisons

The save changed during development. For this pass a read-only copy was frozen
before comparison, yielding 13,320 buildings and 1,493 belt paths after the same
in-memory overlap filtering. Both the previous implementation and the new one
ran against that exact file. Three alternating before/after trials averaged the
19 warm publications after each trial's initial capture, avoiding cache setup
in the steady-state figures below. These figures should not be compared directly
with the earlier 20-publication means on a different save state.

| Warm cost per publication         | Before this pass | After this pass |
| --------------------------------- | ---------------: | --------------: |
| Host capture                      |          15.5 ms |         13.8 ms |
| Host delta/baseline/JSON encoding |          10.6 ms |          7.1 ms |
| Host total                        |          26.1 ms |         20.9 ms |
| Client decode/application total   |          16.2 ms |         13.4 ms |
| Decompression/JSON parse subset   |           6.7 ms |          4.3 ms |
| Compressed text payload           |          35.6 KB |         35.6 KB |

This pass removes redundant whole-factory delta scans and baseline rebuilding
by carrying capture-generation change sets. A skipped/failed publication or a
different capture owner falls back to a complete comparison. Client frame
application clears host capture metadata. Queue captures share unchanged
branches, and belt captures reuse immutable pairs/arrays until distances,
items or counts change. Empty schemas skip serialization, and hot miner and
processor schemas reuse unchanged values. Delta construction avoids temporary
entry/filter arrays. Compressed envelope decoding copies base64 bytes directly
instead of using a per-character typed-array conversion callback.

These changes reduce measured host work by about 20% and client work by about
17%, with identical plain and compressed payload sizes in all paired trials.
Simulation code and the wire protocol are unchanged; the differences in
simulation timings are not claimed as a production-loop improvement. The
benchmark now reports simulation time and separate warm/cold-inclusive means.

The 0.10.1 client figure includes decompressing the actual compressed envelope.
Native compression is asynchronous and reported separately from host capture/
encoding. Payloads exclude TCP/WebSocket overhead. At 10 Hz these means imply
about 15.2 MB/s before the fix versus 0.38 MB/s afterward per client. Timings
vary with machine, save contents, warm-up and garbage collection. This is a
local headless benchmark, not a live two-PC FPS or latency measurement.

Large-factory capture still occupies the renderer for tens of milliseconds.
The changes substantially reduce the cost, but do not make it negligible.
Item presentation still updates at the publication rate; rendering
interpolation and further CPU optimization remain possible improvements.

To profile another save without changing it (PowerShell):

```powershell
$env:COOP_BENCHMARK_SAVE = 'C:\path\to\savegame.bin'
npm run test:coop
```

Without that variable, `npm run test:coop` runs the 34 regressions, including
real production, compact queue/item codecs, compression/order, scoped
prediction rollback, flow control, reconnects, slot-schema equivalence, cached
welcome/hook isolation, progression rollback, peer DOM updates and a WebSocket
relay round trip. Additional tests cover queue reuse/canonical isolation,
partial cache refresh with replacement acceptors and split paths, and wire
topology versus pin-value updates. With a save specified, the benchmark adds
a 35th test and reports costs/counts for an isolated building edit. New tests
cover skipped-publication recovery, capture-owner replacement, unchanged queue
branches, frozen belt-item reuse/shrinkage and miner schema precision. Compressed
transport also round-trips non-ASCII and control characters.

For the next live test, collect `just logs 200` on both PCs after at least ten
seconds of connected play. `state performance` distinguishes capture work,
client decoding/application, payload rate and socket buffering. Repeated
`state backpressure` records show which receipt revisions have stalled.
