import test from "node:test";
import assert from "node:assert/strict";
import {
    StateBaseline,
    packStateFrame,
    unpackStateFrame,
    unpackStateFrameAsync,
} from "../../mods/coop/replication.js";
import { encodeWireMessage, decodeWireMessage } from "../../mods/coop/transport.js";
import { WireDecoder } from "../../mods/coop/decoder.js";
import { Worker as NodeWorker } from "node:worker_threads";

function createNodeDecoderWorker() {
    const url = new URL("../../mods/coop/decode_worker.js", import.meta.url).href;
    const worker = new NodeWorker(
        `const { parentPort } = require("node:worker_threads");
         const ready = import(${JSON.stringify(url)});
         parentPort.on("message", async data => {
             const result = await (await ready).decodeRequest(data);
             parentPort.postMessage(result, result.payload ? [result.payload.buffer] : []);
         });`,
        { eval: true }
    );
    const bridge = {
        postMessage: data => worker.postMessage(data),
        terminate: () => worker.terminate(),
    };
    worker.on("message", data => bridge.onmessage?.({ data }));
    worker.on("error", error => bridge.onerror?.(error));
    return { worker: bridge };
}

const snapshot = entities => ({ entities, beltPaths: [], hubGoals: {}, time: {}, analytics: {} });

test("delta frames include additions, changes, removals and acknowledgements", () => {
    const host = new StateBaseline();
    host.reset(10, [{ uid: 1, value: "old" }, { uid: 2 }]);
    const client = new StateBaseline();
    client.reset(10, [...host.entities.values()]);
    const frame = host.createFrame(snapshot([{ uid: 1, value: "new" }, { uid: 3 }]), { peer: 7 });
    assert.deepEqual(frame.removed, [2]);
    assert.equal(frame.acknowledgements.peer, 7);
    assert.equal(client.applyFrame(frame), true);
    assert.deepEqual([...client.entities.values()], frame.entities);
    assert.equal(client.applyFrame(frame), false);
});

test("missing frames fail instead of silently applying a delta to the wrong world", () => {
    const client = new StateBaseline();
    assert.throws(() => client.applyFrame({ base: 1, revision: 2 }), /Missing authoritative/);
    assert.equal(client.revision, 0);
    assert.equal(client.entities.size, 0);
});

test("a snapshot supersedes queued older frames while the next delta still applies", () => {
    const client = new StateBaseline();
    client.reset(100, [{ uid: 1 }]);
    assert.equal(client.applyFrame({ base: 98, revision: 99 }), false);
    assert.equal(client.applyFrame({ base: 100, revision: 101, entities: [{ uid: 2 }], removed: [1] }), true);
    assert.deepEqual([...client.entities.keys()], [2]);
});

test("compact state preserves belt runs, fixed slots and complete processing queues", async () => {
    const item = { $: "shape", data: "CuCuCuCu" };
    const runtimeItem = { $item: item };
    const frame = {
        t: "state",
        base: 1,
        revision: 2,
        entities: [],
        removed: [],
        patches: [
            {
                uid: 1,
                components: {
                    ItemEjector: {
                        slots: [
                            { item, progress: 0.45 },
                            { item: null, progress: 0 },
                        ],
                    },
                    WiredPins: { slots: [{ value: item }, { value: null }] },
                    Miner: { lastMiningTime: 1.4, itemChainBuffer: [item] },
                    UndergroundBelt: { pendingItems: [[item, 0.5]] },
                    Storage: { storedCount: 9, storedItem: item },
                    BeltReader: { lastItem: item },
                    ItemProcessor: { nextOutputSlot: 2 },
                    Lever: { toggled: true },
                },
                runtime: {
                    ItemProcessor: {
                        inputSlots: { $map: [[0, runtimeItem]] },
                        inputCount: 1,
                        ongoingCharges: [
                            { remainingTime: 0.42, items: [{ item: runtimeItem, requiredSlot: 0 }] },
                        ],
                        bonusTime: 0.1,
                        queuedEjects: [
                            { item: runtimeItem, preferredSlot: null, doNotTrack: true },
                            { item: runtimeItem, requiredSlot: 1, doNotTrack: false },
                            { item: runtimeItem },
                        ],
                    },
                    ItemAcceptor: {
                        itemConsumptionAnimations: [
                            { item: runtimeItem, slotIndex: 0, direction: 2, animProgress: 0.5 },
                        ],
                    },
                    UndergroundBelt: { consumptionAnimations: [{ item: runtimeItem, progress: 0.2 }] },
                    Storage: { overlayOpacity: 0.8 },
                    BeltReader: { lastItemTimes: [1, 2], lastThroughput: 8, lastThroughputComputation: 4 },
                },
            },
        ],
        beltPaths: [
            {
                entityPath: [1, 2],
                items: Array.from({ length: 1000 }, () => [0.63, item]),
                spacingToFirstItem: 0.2,
            },
        ],
    };
    const packed = packStateFrame(frame);
    assert.deepEqual(unpackStateFrame(JSON.parse(JSON.stringify(packed))), frame);
    assert.ok(JSON.stringify(packed).length < JSON.stringify(frame).length / 10);
    assert.equal(packed.itemTable.length, 1);
    assert.equal(packed.bp[0][2][0][2], 1000);
    assert.deepEqual((await unpackStateFrameAsync(packed)).message, frame);
    packed.bp[0][2][0][2] = 1000001;
    assert.throws(() => unpackStateFrame(packed), /Invalid belt item run/);
    await assert.rejects(unpackStateFrameAsync(packed), /Invalid belt item run/);
});

test("large compact frames yield without exposing partial state and cancel cleanly", async () => {
    const packed = {
        t: "state",
        itemTable: [{ $: "shape", data: "CuCuCuCu" }],
        p: Array.from({ length: 160 }, (_, uid) => [uid, [["ItemProcessor", 0]], []]),
        bu: [[0, 0.2, [[0.63, 0, 9000]]]],
    };
    const expected = unpackStateFrame(packed);
    const before = JSON.stringify(packed);
    let yields = 0;
    const result = await unpackStateFrameAsync(
        packed,
        async () => {
            ++yields;
            assert.equal(JSON.stringify(packed), before);
        },
        undefined,
        0
    );
    assert.ok(yields > 2, "Both patches and a long belt path must allow UI tasks");
    assert.deepEqual(result.message, expected);
    let cancelled = false;
    await assert.rejects(
        unpackStateFrameAsync(
            packed,
            async () => {
                cancelled = true;
            },
            () => {
                if (cancelled) throw new Error("Disconnected during expansion");
            },
            0
        ),
        /Disconnected during expansion/
    );
    assert.equal(JSON.stringify(packed), before);
});

test("recovery discards compact state before expansion, including the inline fallback", async t => {
    const worker = new WireDecoder({ createWorker: createNodeDecoderWorker });
    const inline = new WireDecoder({
        createWorker() {
            throw new Error("Unavailable");
        },
    });
    t.after(() => {
        worker.dispose();
        inline.dispose();
    });
    const invalid = JSON.stringify({
        t: "state",
        itemTable: [],
        bu: [[0, 0, [[0.63, 9, 1000001]]]],
        padding: " ".repeat(5000),
    });
    for (const decoder of [worker, inline]) {
        assert.equal((await decoder.decode(invalid, () => true)).skipped, true);
        await assert.rejects(decoder.decode(invalid), /Invalid belt item run/);
        assert.equal((await decoder.decode('{"t":"ping"}')).message.t, "ping");
    }
});

test("native compressed transport preserves JSON and rejects damaged envelopes", async () => {
    const original = {
        t: "welcome",
        dump: { repeated: "abcdefgh".repeat(10000), unicode: "\u0000\u00ff☃😀".repeat(1000) },
    };
    const compressed = await encodeWireMessage(JSON.stringify(original));
    assert.ok(compressed.length < 1000);
    assert.deepEqual(await decodeWireMessage(compressed), original);
    assert.deepEqual(await decodeWireMessage(await encodeWireMessage('{"t":"ping"}')), { t: "ping" });
    await assert.rejects(decodeWireMessage('{"t":"compressed","encoding":"gzip","data":"bad"}'));
});

test("worker decoding expands complete state and rejects corruption without poisoning subsequent requests", async t => {
    const decoder = new WireDecoder({ createWorker: createNodeDecoderWorker });
    t.after(() => decoder.dispose());
    const frame = {
        t: "state",
        base: 1,
        revision: 2,
        entities: [],
        patches: [],
        removed: [],
        hub: {},
        time: {},
        analytics: {},
        acknowledgements: {},
        beltUpdates: Array.from({ length: 250 }, (_, index) => ({
            index,
            items: Array.from({ length: 150 }, () => [0.63, { $: "shape", data: "CuCuCuCu" }]),
            spacingToFirstItem: 0.2,
        })),
    };
    // The receive path uses a wire-size threshold, so exercise a large raw
    // compact frame as well as a compressed welcome and malformed envelope.
    const wire = JSON.stringify(packStateFrame(frame));
    assert.ok(wire.length > 4096);
    const result = await decoder.decode(wire);
    assert.equal(result.mode, "worker");
    assert.deepEqual(result.message, frame);
    assert.ok(result.wireDecodeMs >= 0 && result.unpackMs >= 0);
    const welcome = { t: "welcome", dump: { unicode: "\u0000☃😀".repeat(10000) } };
    const compressed = await encodeWireMessage(JSON.stringify(welcome));
    const largeEnvelope = JSON.stringify({ ...JSON.parse(compressed), padding: " ".repeat(5000) });
    assert.deepEqual((await decoder.decode(largeEnvelope)).message, welcome);
    await assert.rejects(
        decoder.decode(
            '{"t":"compressed","encoding":"gzip","data":"bad","padding":"' + " ".repeat(5000) + '"}'
        )
    );
    assert.deepEqual((await decoder.decode(wire)).message, frame);
});

test("worker startup failure falls back once and disposal cancels pending work", async () => {
    let attempts = 0;
    let fallbacks = 0;
    const wire = JSON.stringify({ t: "welcome", dump: "a".repeat(5000) });
    const fallback = new WireDecoder({
        createWorker() {
            ++attempts;
            throw new Error("Worker unavailable");
        },
        onFallback: () => ++fallbacks,
    });
    assert.deepEqual((await fallback.decode(wire)).message, JSON.parse(wire));
    assert.deepEqual((await fallback.decode(wire)).message, JSON.parse(wire));
    assert.equal(attempts, 1);
    assert.equal(fallbacks, 1);
    fallback.dispose();
    let terminated = 0;
    let released = 0;
    const pending = new WireDecoder({
        createWorker: () => ({
            worker: { postMessage() {}, terminate: () => ++terminated },
            release: () => ++released,
        }),
    });
    const rejected = assert.rejects(pending.decode(wire), /disposed/);
    pending.dispose();
    await rejected;
    assert.equal(pending.pending.size, 0);
    assert.equal(terminated, 1);
    assert.equal(released, 1);
    await assert.rejects(pending.decode(wire), /disposed/);
});

test("an asynchronous worker crash recovers pending packets inline and ignores late results", async () => {
    let bridge;
    const decoder = new WireDecoder({
        createWorker: () => ({ worker: (bridge = { postMessage() {}, terminate() {} }) }),
    });
    const message = { t: "welcome", dump: "x".repeat(5000) };
    const promise = decoder.decode(JSON.stringify(message));
    bridge.onerror({ message: "Worker import failed" });
    const result = await promise;
    assert.equal(result.mode, "inline");
    assert.deepEqual(result.message, message);
    bridge.onmessage({ data: { id: 1, message: { t: "incorrect late result" } } });
    assert.equal(decoder.pending.size, 0);
    decoder.dispose();
});

test("a worker that never replies cannot block the receive FIFO indefinitely", async t => {
    let fallbackCount = 0;
    const decoder = new WireDecoder({
        createWorker: () => ({ worker: { postMessage() {}, terminate() {} } }),
        timeoutMs: 5,
        onFallback: () => ++fallbackCount,
    });
    t.after(() => decoder.dispose());
    const message = { t: "welcome", dump: "z".repeat(5000) };
    assert.deepEqual((await decoder.decode(JSON.stringify(message))).message, message);
    assert.equal(decoder.mode, "inline");
    assert.equal((await decoder.decode('{"t":"ping"}')).message.t, "ping");
    assert.equal(fallbackCount, 1);
    assert.equal(decoder.pending.size, 0);
});
