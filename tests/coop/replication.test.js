import test from "node:test";
import assert from "node:assert/strict";
import { StateBaseline, packStateFrame, unpackStateFrame } from "../../mods/coop/replication.js";
import { encodeWireMessage, decodeWireMessage } from "../../mods/coop/transport.js";

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

test("compact state preserves belt runs, fixed slots and complete processing queues", () => {
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
                        queuedEjects: [{ item: runtimeItem, preferredSlot: null }],
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
    packed.bp[0][2][0][2] = 1000001;
    assert.throws(() => unpackStateFrame(packed), /Invalid belt item run/);
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
