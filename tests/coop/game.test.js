import test from "node:test";
import assert from "node:assert/strict";
import { Loader } from "../../src/js/core/loader";
import { Signal } from "../../src/js/core/signal";
import { globalConfig } from "../../src/js/core/config";
import { gMetaBuildingRegistry } from "../../src/js/core/global_registries";
import { Vector } from "../../src/js/core/vector";
import { GameRoot } from "../../src/js/game/root";
import { GameCore } from "../../src/js/game/core";
import { GameMode } from "../../src/js/game/game_mode";
import { BaseMap } from "../../src/js/game/map";
import { GameLogic } from "../../src/js/game/logic";
import { GameSystemManager } from "../../src/js/game/game_system_manager";
import { GameSystemWithFilter } from "../../src/js/game/game_system_with_filter";
import { GameTime } from "../../src/js/game/game_time";
import { DynamicTickrate } from "../../src/js/game/dynamic_tickrate";
import { EntityManager } from "../../src/js/game/entity_manager";
import { HubGoals } from "../../src/js/game/hub_goals";
import { ProductionAnalytics } from "../../src/js/game/production_analytics";
import { ShapeDefinitionManager } from "../../src/js/game/shape_definition_manager";
import { Blueprint } from "../../src/js/game/blueprint";
import { initComponentRegistry } from "../../src/js/game/component_registry";
import { initItemRegistry } from "../../src/js/game/item_registry";
import { initMetaBuildingRegistry } from "../../src/js/game/meta_building_registry";
import { buildBuildingCodeCache } from "../../src/js/game/building_codes";
import { MetaBeltBuilding } from "../../src/js/game/buildings/belt";
import { MetaMinerBuilding } from "../../src/js/game/buildings/miner";
import { MetaCutterBuilding } from "../../src/js/game/buildings/cutter";
import { MetaUndergroundBeltBuilding } from "../../src/js/game/buildings/underground_belt";
import { MetaHubBuilding } from "../../src/js/game/buildings/hub";
import { MetaLeverBuilding } from "../../src/js/game/buildings/lever";
import { MetaConstantSignalBuilding } from "../../src/js/game/buildings/constant_signal";
import { MetaWireBuilding } from "../../src/js/game/buildings/wire";
import { SavegameSerializer } from "../../src/js/savegame/savegame_serializer";
import { SerializerInternal } from "../../src/js/savegame/serializer_internal";
import { itemResolverSingleton } from "../../src/js/game/item_resolver";
import { BOOL_TRUE_SINGLETON } from "../../src/js/game/items/boolean_item";
import { types } from "../../src/js/savegame/serialization";
import { MOD_SIGNALS } from "../../src/js/mods/mod_signals";
import { RegularGameMode } from "../../src/js/game/modes/regular";
import { decodeWireMessage, encodeWireMessage } from "../../mods/coop/transport.js";
import { CoopWsServer } from "../../electron/src/coop/ws_server";
import {
    captureSnapshot,
    StateBaseline,
    StateCapture,
    packStateFrame,
    unpackStateFrame,
    reconcileWorld,
    applyRuntime,
    applyCommands,
} from "../../mods/coop/replication.js";

Loader.getSprite = () => ({});
Loader.getRegularSprite = () => ({});
globalConfig.debug.checkBeltPaths = true;
initComponentRegistry();
initItemRegistry();
initMetaBuildingRegistry();
buildBuildingCodeCache();

// ModLoader exposes non-enumerable getters, not an enumerable export literal.
// A spread of the live namespace silently drops every game export.
const exportGetters = values =>
    Object.defineProperties(
        {},
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }]))
    );
const exports = exportGetters({ SavegameSerializer, SerializerInternal, itemResolverSingleton });
window.shapez = exportGetters({
    SavegameSerializer,
    SerializerInternal,
    itemResolverSingleton,
    GameMode,
    GameCore,
    GameLogic,
    GameTime,
    DynamicTickrate,
    EntityManager,
    HubGoals,
    ProductionAnalytics,
    Blueprint,
    Mod: class {},
    BaseHUDPart: class {},
    GameHUD: class {
        drawOverlays() {}
    },
    KEYCODES: { F8: 119 },
});

class TestMode extends GameMode {
    static getId() {
        return "regularMode";
    }
    getFixedTickrate() {
        return 60;
    }
    getLevelDefinitions() {
        return [{ shape: "CuCuCuCu", required: 1000000, reward: "no_reward_freeplay" }];
    }
    getUpgrades() {
        return {
            belt: [{ required: [{ shape: "CuCuCuCu", amount: 30 }], improvement: 0.5 }],
            miner: [],
            processors: [],
            painting: [],
        };
    }
}

function makeRoot(seed = 123) {
    const root = new GameRoot({
        settings: {
            getDesiredFps: () => 60,
            getAllSettings: () => ({ simplifiedBelts: false, enableTunnelSmartplace: false }),
        },
    });
    root.gameMode = new TestMode(root);
    root.dynamicTickrate = new DynamicTickrate(root);
    root.entityMgr = new EntityManager(root);
    root.map = new BaseMap(root);
    root.map.seed = seed;
    root.logic = new GameLogic(root);
    root.camera = { serialize: () => ({}), deserialize() {}, getIsMapOverlayActive: () => false };
    root.hud = { parts: {}, shouldPauseGame: () => false };
    root.shapeDefinitionMgr = new ShapeDefinitionManager(root);
    root.hubGoals = new HubGoals(root);
    root.time = new GameTime(root);
    root.productionAnalytics = new ProductionAnalytics(root);
    root.systemMgr = new GameSystemManager(root);
    root.gameInitialized = true;
    return root;
}

function place(root, Building, x, y, rotation = 0) {
    const entity = root.logic.tryPlaceBuilding({
        origin: new Vector(x, y),
        rotation,
        originalRotation: rotation,
        rotationVariant: 0,
        variant: "default",
        building: gMetaBuildingRegistry.findByClass(Building),
    });
    assert.ok(entity, "test building placement failed");
    return entity;
}

function tick(root, count) {
    for (let i = 0; i < count; ++i) {
        root.time.performTicks(root.dynamicTickrate.deltaMs, () => {
            root.entityMgr.update();
            root.systemMgr.update();
            return true;
        });
        root.productionAnalytics.update();
    }
}

// Read-only profiling of a real save. Set COOP_BENCHMARK_SAVE to its .bin path.
if (process.env.COOP_BENCHMARK_SAVE) {
    test("profile authoritative replication on a real saved factory", async t => {
        const { readFileSync } = await import("node:fs");
        const { gunzipSync } = await import("node:zlib");
        const { decode } = await import("@msgpack/msgpack");
        const dump = decode(gunzipSync(readFileSync(process.env.COOP_BENCHMARK_SAVE))).dump;
        const checkBeltPaths = globalConfig.debug.checkBeltPaths;
        t.after(() => {
            globalConfig.debug.checkBeltPaths = checkBeltPaths;
        });
        globalConfig.debug.checkBeltPaths = false;
        class BenchmarkMode extends RegularGameMode {
            static getId() {
                return "benchmarkRegularMode";
            }
        }
        // Historical co-op saves may contain stale overlapping registry entries.
        // Exclude those in this in-memory benchmark only; never write the save.
        const probe = makeRoot();
        const occupied = new Set();
        const removed = new Set();
        dump.entities = dump.entities.filter(data => {
            const entity = new SerializerInternal().createEntityFromSerialized(probe, data);
            const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
            const tiles = [];
            for (let y = bounds.y; y < bounds.y + bounds.h; ++y) {
                for (let x = bounds.x; x < bounds.x + bounds.w; ++x) {
                    tiles.push(entity.layer + ":" + x + ":" + y);
                }
            }
            if (tiles.some(tile => occupied.has(tile))) {
                removed.add(data.uid);
                return false;
            }
            tiles.forEach(tile => occupied.add(tile));
            return true;
        });
        dump.beltPaths = dump.beltPaths.filter(path => !path.entityPath.some(uid => removed.has(uid)));
        console.log("COOP PROFILE excluded stale overlapping entries:", removed.size);
        const host = makeRoot();
        const client = makeRoot();
        for (const root of [host, client]) {
            root.gameMode = new BenchmarkMode(root);
            root.gameInitialized = false;
            assert.ok(new SavegameSerializer().deserialize(dump, root).isGood());
            root.gameInitialized = true;
            root.signals.postLoadHook.dispatch();
        }
        const baseline = new StateBaseline();
        const replica = new StateBaseline();
        const capture = new StateCapture(host);
        t.after(() => capture.dispose());
        const initial = captureSnapshot(host, exports);
        baseline.reset(1, initial.entities, initial.beltPaths);
        replica.reset(1, initial.entities, initial.beltPaths);
        const timings = [];
        for (let i = 0; i < 20; ++i) {
            const simulationStarted = performance.now();
            tick(host, 6);
            const start = performance.now();
            const snapshot = capture.capture();
            const captured = performance.now();
            const frame = baseline.createFrame(snapshot, {});
            baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
            const packed = packStateFrame(frame);
            const wire = JSON.stringify(packed);
            const encoded = performance.now();
            const compressed = await encodeWireMessage(wire);
            const compressedAt = performance.now();
            const decoded = await decodeWireMessage(compressed);
            const decodedAt = performance.now();
            const received = unpackStateFrame(decoded);
            const unpackedAt = performance.now();
            replica.applyFrame(received);
            const baselineAt = performance.now();
            reconcileWorld(client, replica, received, exports);
            const appliedAt = performance.now();
            timings.push({
                simulationMs: start - simulationStarted,
                captureMs: captured - start,
                encodeMs: encoded - captured,
                applyMs: appliedAt - compressedAt,
                decodeMs: decodedAt - compressedAt,
                unpackMs: unpackedAt - decodedAt,
                baselineMs: baselineAt - unpackedAt,
                reconcileMs: appliedAt - baselineAt,
                bytes: Buffer.byteLength(wire),
                compressedBytes: Buffer.byteLength(compressed),
                compressMs: compressedAt - encoded,
            });
            if (i === 19)
                console.log(
                    "COOP PROFILE packet sections",
                    JSON.stringify(
                        Object.fromEntries(
                            Object.entries(packed).map(([key, value]) => [key, JSON.stringify(value).length])
                        )
                    )
                );
        }
        console.log(
            "COOP PROFILE",
            JSON.stringify({
                entities: host.entityMgr.entities.size,
                paths: host.systemMgr.systems.belt.beltPaths.length,
                mean: Object.fromEntries(
                    Object.keys(timings[0]).map(key => [
                        key,
                        timings.reduce((sum, sample) => sum + sample[key], 0) / timings.length,
                    ])
                ),
                warmMean: Object.fromEntries(
                    Object.keys(timings[0]).map(key => [
                        key,
                        timings.slice(1).reduce((sum, sample) => sum + sample[key], 0) / (timings.length - 1),
                    ])
                ),
            })
        );
        const previousPaths = new Set(client.systemMgr.systems.belt.beltPaths);
        const chunks = new Map(
            [...client.map.chunksById.values()].map(chunk => [chunk, chunk.renderIteration])
        );
        const ejectors = client.systemMgr.systems.itemEjector;
        let ejectorRecomputes = 0;
        const recompute = ejectors.recomputeSingleEntityCache.bind(ejectors);
        ejectors.recomputeSingleEntityCache = entity => {
            ++ejectorRecomputes;
            recompute(entity);
        };
        let wireRecomputes = 0;
        const wire = client.systemMgr.systems.wire;
        const recomputeWire = wire.recomputeWiresNetwork.bind(wire);
        wire.recomputeWiresNetwork = () => {
            ++wireRecomputes;
            recomputeWire();
        };
        // A single isolated edit previously rebuilt every path/ejector/chunk.
        // The save remains untouched; this placement exists only in the fixture.
        place(host, MetaCutterBuilding, 20000, 20000);
        const edited = capture.capture();
        const editFrame = unpackStateFrame(
            JSON.parse(JSON.stringify(packStateFrame(baseline.createFrame(edited, {}))))
        );
        const editStarted = performance.now();
        replica.applyFrame(editFrame);
        reconcileWorld(client, replica, editFrame, exports);
        const editMs = performance.now() - editStarted;
        console.log(
            "COOP PROFILE isolated edit",
            JSON.stringify({
                editMs,
                retainedPaths: client.systemMgr.systems.belt.beltPaths.filter(path => previousPaths.has(path))
                    .length,
                totalPaths: previousPaths.size,
                ejectorRecomputes,
                totalEjectors: ejectors.allEntities.length,
                dirtyExistingChunks: [...chunks].filter(
                    ([chunk, iteration]) => chunk.renderIteration !== iteration
                ).length,
                totalExistingChunks: chunks.size,
                wireRecomputes,
            })
        );
        assert.equal(
            client.systemMgr.systems.belt.beltPaths.filter(path => previousPaths.has(path)).length,
            previousPaths.size
        );
        assert.equal(ejectorRecomputes, 1);
        assert.equal(wireRecomputes, 0);
        assert.equal(
            [...chunks].filter(([chunk, iteration]) => chunk.renderIteration !== iteration).length,
            0
        );
        // Isolate the registration cost from building construction/map work.
        // Use the loaded factory's processor list and the previous full-sort
        // implementation as the control, preserving the same ordered result.
        const processorEntities = host.systemMgr.systems.itemProcessor.allEntities;
        const legacyRegister = function (entity) {
            this.allEntities.push(entity);
            if (this.root.gameInitialized && !this.root.bulkOperationRunning)
                this.allEntities.sort((a, b) => a.uid - b.uid);
        };
        const registration = {};
        for (const order of ["ascending", "descending"]) {
            const additions = Array.from({ length: 1000 }, (_, i) => ({
                uid: host.entityMgr.nextUid + (order === "ascending" ? i : 999 - i),
            }));
            let expected;
            for (const [kind, method] of [
                ["fullSort", legacyRegister],
                ["orderedInsert", GameSystemWithFilter.prototype.internalRegisterEntity],
            ]) {
                const sample = {
                    root: host,
                    allEntities: processorEntities.slice(),
                    entityOrderDirty: false,
                };
                const start = performance.now();
                for (const entity of additions) method.call(sample, entity);
                registration[order + "_" + kind + "Ms"] = performance.now() - start;
                const uids = sample.allEntities.map(entity => entity.uid);
                if (expected) assert.deepEqual(uids, expected);
                else expected = uids;
            }
        }
        console.log(
            "COOP PROFILE registration",
            JSON.stringify({ existing: processorEntities.length, additions: 1000, ...registration })
        );
    });
}

async function makeMod(root, host, t) {
    const { default: CoopMod } = await import("../../mods/coop/entry.js");
    const mod = new CoopMod();
    mod.app = root.app;
    mod.signals = { gameStarted: new Signal() };
    mod.modInterface = {
        replaceMethod(Class, name, handler) {
            const original = Class.prototype[name];
            Class.prototype[name] = function (...args) {
                return handler.call(this, original.bind(this), args);
            };
        },
        registerHudElement() {},
        addStylesheet() {},
        registerIngameKeybinding() {},
    };
    mod.init();
    mod.messages = [];
    mod.net.connected = true;
    mod.net.send = message => {
        mod.messages.push(JSON.parse(JSON.stringify(message)));
        return true;
    };
    mod.beginSession(root, host);
    t.after(() => mod.endSession());
    return mod;
}

function runtimeState(root) {
    const snapshot = captureSnapshot(root, exports);
    return {
        entities: snapshot.entities.sort((a, b) => a.uid - b.uid),
        beltPaths: snapshot.beltPaths,
        hub: snapshot.hubGoals,
        time: snapshot.time.timeSeconds,
        analytics: snapshot.analytics,
    };
}

function assertReplicaState(actual, expected, path = "state") {
    // Savegame float serializers truncate at 4 decimal places. Re-serializing
    // a restored binary float can lose one last decimal; counts remain exact.
    if (typeof expected === "number" && !Number.isInteger(expected)) {
        assert.ok(Math.abs(actual - expected) <= 0.000101, path + ": " + actual + " != " + expected);
    } else if (expected && typeof expected === "object") {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
        for (const key of Object.keys(expected)) {
            assertReplicaState(actual[key], expected[key], path + "." + key);
        }
    } else {
        assert.equal(actual, expected, path);
    }
}

test("real factory production stays identical on replicas without multiplying hub deliveries", async t => {
    const host = makeRoot();
    place(host, MetaHubBuilding, 0, 0);
    place(host, MetaMinerBuilding, 1, -5, 180);
    for (let y = -4; y < 0; ++y) {
        place(host, MetaBeltBuilding, 1, y, 180);
    }
    // Deterministic resource for this fixture; mining and transport are real.
    host.map.getLowerLayerContentXY = () => host.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    const client = makeRoot(999);
    const mod = await makeMod(client, false, t);
    mod.hostId = "host";
    mod.slot = 1;
    tick(host, 600);
    mod.applyWelcome(captureSnapshot(host, exports), 1, 0);
    assert.equal(mod.awaitingWelcome, false);
    const baseline = new StateBaseline();
    const capture = new StateCapture(host);
    t.after(() => capture.dispose());
    const initial = captureSnapshot(host, exports);
    baseline.reset(1, initial.entities, initial.beltPaths);
    let localTicks = 0;
    // Deliberately unequal client frame intervals and pauses.
    for (let i = 0; i < 100; ++i) {
        tick(host, 6);
        client.hud.shouldPauseGame = () => i % 3 === 0;
        client.time.performTicks(i % 2 ? 900 : 4, () => {
            localTicks++;
            return true;
        });
        const snapshot = capture.capture();
        const frame = baseline.createFrame(snapshot, {});
        baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
        mod.applyState({
            ...unpackStateFrame(JSON.parse(JSON.stringify(packStateFrame(frame)))),
            from: "host",
        });
        assertReplicaState(runtimeState(client), runtimeState(host));
    }
    assert.equal(localTicks, 0);
    assert.ok(host.hubGoals.getShapesStoredByKey("CuCuCuCu") > 0, "fixture must actually deliver shapes");
    const delivered = host.hubGoals.getShapesStoredByKey("CuCuCuCu");
    mod.session = { root: host, isHost: true };
    mod.handleMessage({ t: "deliver-batch", from: "client", v: 4, batch: { CuCuCuCu: 999 } });
    assert.equal(host.hubGoals.getShapesStoredByKey("CuCuCuCu"), delivered);
});

test("network snapshots preserve processing queues omitted from savegames", () => {
    const host = makeRoot();
    const cutter = place(host, MetaCutterBuilding, 10, 10);
    const processor = cutter.components.ItemProcessor;
    const item = host.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    processor.inputSlots.set(0, item);
    processor.inputCount = 1;
    processor.ongoingCharges = [{ remainingTime: 0.42, items: [{ item, requiredSlot: 0 }] }];
    processor.queuedEjects = [{ item, preferredSlot: 1 }];
    processor.bonusTime = 0.012;
    const snapshot = captureSnapshot(host, exports);
    assert.equal(snapshot.entities[0].components.ItemProcessor.ongoingCharges, undefined);
    const client = makeRoot();
    const baseline = new StateBaseline();
    baseline.reset(1, snapshot.entities);
    reconcileWorld(
        client,
        baseline,
        {
            beltPaths: snapshot.beltPaths,
            hub: snapshot.hubGoals,
            time: snapshot.time,
            analytics: snapshot.analytics,
        },
        exports
    );
    assert.deepEqual(runtimeState(client), runtimeState(host));
    assert.ok(client.entityMgr.findByUid(cutter.uid).components.ItemProcessor.inputSlots instanceof Map);
    processor.ongoingCharges[0].remainingTime = 0.3;
    assert.equal(snapshot.entities[0].runtime.ItemProcessor.ongoingCharges[0].remainingTime, 0.42);
});

test("overlapping placements converge, protect the hub, and map tiles match entity registry", () => {
    const root = makeRoot();
    const source = makeRoot();
    const data = place(source, MetaBeltBuilding, 10, 10).serialize();
    applyCommands(root, [{ k: "place", uid: 10001, entity: { ...data, uid: 10001 } }], exports, 1);
    applyCommands(root, [{ k: "place", uid: 10002, entity: { ...data, uid: 10002 } }], exports, 2);
    assert.equal(root.entityMgr.entities.size, 1);
    assert.equal(root.map.getLayerContentXY(10, 10, "regular").uid, 10002);
    assert.equal(root.entityMgr.findByUid(10001, false), null);
    place(root, MetaHubBuilding, 0, 0);
    const blocked = {
        ...data,
        uid: 10009,
        components: {
            ...data.components,
            StaticMapEntity: { ...data.components.StaticMapEntity, origin: { x: 0, y: 0 } },
        },
    };
    applyCommands(root, [{ k: "place", uid: blocked.uid, entity: blocked }], exports, 1);
    assert.equal(root.entityMgr.findByUid(blocked.uid, false), null);
    root.systemMgr.systems.belt.debug_verifyBeltPaths();
});

test("blueprint and upgrade costs are paid once on the host and rejected when unaffordable", () => {
    const root = makeRoot();
    const source = makeRoot();
    const entity = place(source, MetaBeltBuilding, 10, 10).serialize();
    entity.uid = 10001;
    const key = root.gameMode.getBlueprintShapeKey();
    const op = { k: "blueprint", cost: { key, amount: 10 }, ops: [{ k: "place", uid: entity.uid, entity }] };
    applyCommands(root, [op], exports, 1);
    assert.equal(root.entityMgr.entities.size, 0);
    root.hubGoals.storedShapes[key] = 20;
    applyCommands(root, [op], exports, 1);
    assert.equal(root.hubGoals.storedShapes[key], 10);
    assert.equal(applyCommands(root, [op], exports, 1), false);
    assert.equal(root.hubGoals.storedShapes[key], 10, "an existing UID is not a new paid placement");
    root.hubGoals.storedShapes.CuCuCuCu = 30;
    applyCommands(
        root,
        [
            { k: "upgrade", upgradeId: "belt" },
            { k: "upgrade", upgradeId: "belt" },
        ],
        exports,
        1
    );
    assert.equal(root.hubGoals.getUpgradeLevel("belt"), 1);
    assert.equal(root.hubGoals.storedShapes.CuCuCuCu, 0);
});

test("client configuration edits carry lever and constant signal state", () => {
    const root = makeRoot();
    const lever = place(root, MetaLeverBuilding, 10, 10);
    const constant = place(root, MetaConstantSignalBuilding, 10, 11);
    applyCommands(
        root,
        [
            { k: "configure", uid: lever.uid, component: "Lever", data: { toggled: true } },
            {
                k: "configure",
                uid: constant.uid,
                component: "ConstantSignal",
                data: {
                    signal: {
                        $: BOOL_TRUE_SINGLETON.constructor.getId(),
                        data: BOOL_TRUE_SINGLETON.serialize(),
                    },
                },
            },
        ],
        exports
    );
    assert.equal(lever.components.Lever.toggled, true);
    assert.equal(constant.components.ConstantSignal.signal.getItemType(), "boolean");
});

test("failed bulk and blueprint operations clear flags and finalize partially changed caches", () => {
    for (const [method, flag, signal] of [
        ["performBulkOperation", "bulkOperationRunning", "bulkOperationFinished"],
        ["performImmutableOperation", "immutableOperationRunning", "immutableOperationFinished"],
    ]) {
        const root = makeRoot();
        const removed = place(root, MetaCutterBuilding, 10, 10);
        let completed = 0;
        root.signals[signal].add(() => {
            ++completed;
            assert.equal(root[flag], false);
        });
        const failure = new Error("placement callback failed");
        assert.throws(
            () =>
                root.logic[method](() => {
                    assert.ok(root.logic.tryDeleteBuilding(removed));
                    place(root, MetaCutterBuilding, 20, 20);
                    throw failure;
                }),
            error => error === failure
        );
        assert.equal(root[flag], false);
        assert.equal(completed, 1);
        assert.ok(!root.systemMgr.systems.itemProcessor.allEntities.includes(removed));
        assert.equal(
            root.logic[method](() => 42),
            42
        );
        assert.equal(completed, 2);
        tick(root, 1);
    }
});

test("filtered systems keep UID ordering for remote slots, deferred appends and bulk completion", () => {
    const root = makeRoot();
    const source = makeRoot();
    const system = root.systemMgr.systems.itemProcessor;
    let sorts = 0;
    const sort = system.allEntities.sort;
    system.allEntities.sort = function (...args) {
        ++sorts;
        return sort.apply(this, args);
    };
    const add = (uid, x) => {
        const entity = place(source, MetaCutterBuilding, x, 20).serialize();
        entity.uid = uid;
        applyCommands(root, [{ k: "place", uid, entity }], exports, 1);
    };
    for (const [i, uid] of [10401, 10001, 10561, 10081].entries()) add(uid, 20 + i * 10);
    const assertOrder = expected =>
        assert.deepEqual(
            system.allEntities.map(entity => entity.uid),
            expected
        );
    assertOrder([10001, 10081, 10401, 10561]);
    assert.equal(sorts, 0, "live inserts preserve ordering without a full sort");
    root.gameInitialized = false;
    add(10041, 80);
    root.gameInitialized = true;
    add(10121, 90);
    assertOrder([10001, 10041, 10081, 10121, 10401, 10561]);
    assert.equal(sorts, 1, "a deferred append must not leave an unsorted list");
    root.logic.performBulkOperation(() => {
        add(10161, 100);
        root.logic.tryDeleteBuilding(root.entityMgr.findByUid(10081, false));
        add(10105, 110);
    });
    assertOrder([10001, 10041, 10105, 10121, 10161, 10401, 10561]);
    assert.equal(sorts, 2);
    tick(root, 1);
});

test("large deletes split without loss and duplicate command sequences do not charge twice", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, false, t);
    mod.awaitingWelcome = false;
    mod.pendingOps = Array.from({ length: 10001 }, (_, uid) => ({ k: "delete", uid }));
    mod.flushOps();
    assert.deepEqual(
        mod.messages.map(message => message.ops.length),
        [5000, 5000, 1]
    );
    assert.deepEqual(
        mod.messages.map(message => message.seq),
        [1, 2, 3]
    );
    mod.session.isHost = true;
    mod.slots.set("peer", 1);
    root.hubGoals.storedShapes.CuCuCuCu = 100;
    const message = { from: "peer", seq: 1, ops: [{ k: "upgrade", upgradeId: "belt" }] };
    mod.acceptOps(message);
    mod.acceptOps(message);
    assert.equal(root.hubGoals.storedShapes.CuCuCuCu, 70);
    assert.equal(mod.acceptedSeq.get("peer"), 1);
});

test("missing updates request a snapshot; joining clients cannot build with an unassigned UID slot", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, false, t);
    const building = gMetaBuildingRegistry.findByClass(MetaBeltBuilding);
    assert.equal(
        root.logic.tryPlaceBuilding({
            origin: new Vector(10, 10),
            rotation: 0,
            originalRotation: 0,
            rotationVariant: 0,
            variant: "default",
            building,
        }),
        null
    );
    mod.awaitingWelcome = false;
    mod.hostId = "host";
    mod.applyState({ from: "host", base: 10, revision: 11 });
    assert.equal(mod.awaitingWelcome, true);
    assert.equal(mod.messages.at(-1).t, "resync-request");
    assert.equal(root.entityMgr.entities.size, 0);
});

test("live variable arrays shrink to empty while fixed slots retain their geometry", () => {
    const dynamic = { items: [1, 2, 3] };
    const type = types.array(types.uint);
    assert.equal(type.deserialize([4], dynamic, "items"), undefined);
    assert.deepEqual(dynamic.items, [4]);
    type.deserialize([], dynamic, "items");
    assert.deepEqual(dynamic.items, []);
    const fixed = {
        slots: [
            { value: 1, direction: "top" },
            { value: 2, direction: "bottom" },
        ],
    };
    types.fixedSizeArray(types.structured({ value: types.uint })).deserialize([{ value: 3 }], fixed, "slots");
    assert.deepEqual(fixed.slots, [
        { value: 3, direction: "top" },
        { value: 2, direction: "bottom" },
    ]);
});

test("unacknowledged edits survive host frames and disappear when rejected or superseded", async t => {
    const host = makeRoot();
    place(host, MetaBeltBuilding, 10, 10);
    const client = makeRoot();
    const mod = await makeMod(client, false, t);
    mod.slot = 1;
    mod.hostId = "host";
    const snapshot = captureSnapshot(host, exports);
    mod.applyWelcome(snapshot, 1, 0);
    const original = client.map.getLayerContentXY(10, 10, "regular");
    const predicted = place(client, MetaBeltBuilding, 10, 10, 90);
    mod.flushOps();
    assert.equal(mod.unacknowledged.length, 1);
    const baseline = new StateBaseline();
    baseline.reset(1, snapshot.entities);
    const first = baseline.createFrame(captureSnapshot(host, exports), {});
    mod.applyState({ ...first, from: "host" });
    assert.equal(client.map.getLayerContentXY(10, 10, "regular").uid, predicted.uid);
    baseline.reset(first.revision, snapshot.entities);
    const rejected = baseline.createFrame(captureSnapshot(host, exports), { [mod.net.clientId]: 1 });
    mod.applyState({ ...rejected, from: "host" });
    assert.equal(mod.unacknowledged.length, 0);
    assert.equal(client.map.getLayerContentXY(10, 10, "regular").uid, original.uid);
    assertReplicaState(runtimeState(client), runtimeState(host));
    client.systemMgr.systems.belt.debug_verifyBeltPaths();
});

test("resync replays pending work and reconnect drops edits to the disconnected solo copy", async t => {
    const host = makeRoot();
    place(host, MetaBeltBuilding, 10, 10);
    const client = makeRoot();
    const mod = await makeMod(client, false, t);
    mod.slot = 2;
    mod.hostId = "host";
    const snapshot = captureSnapshot(host, exports);
    mod.applyWelcome(snapshot, 1, 0);
    const predicted = place(client, MetaBeltBuilding, 10, 11);
    mod.requestResync(); // An edit is queued but its zero-delay flush hasn't run.
    mod.applyWelcome(snapshot, 2, 0);
    assert.ok(client.entityMgr.findByUid(predicted.uid, false));
    assert.equal(mod.messages.at(-1).t, "ops");
    mod.net.connected = false;
    mod.onSocketClose();
    let ticks = 0;
    client.time.performTicks(100, () => {
        ticks++;
        return true;
    });
    assert.ok(ticks > 0, "disconnected copy should resume solo simulation");
    mod.net.connected = true;
    mod.onSocketOpen();
    mod.applyWelcome(snapshot, 3, 8);
    assert.equal(client.entityMgr.findByUid(predicted.uid, false), null);
    assert.equal(mod.opSeq, 8);
    assert.equal(mod.unacknowledged.length, 0);
    assert.equal(client.map.seed, host.map.seed);
});

test("slot allocation never wraps onto an active peer and freed slots remain reusable", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, true, t);
    for (let i = 1; i <= 7; ++i) {
        mod.sendWelcome("peer" + i);
    }
    assert.deepEqual([...mod.slots.values()], [1, 2, 3, 4, 5, 6, 7]);
    mod.sendWelcome("eighth-client");
    assert.equal(mod.messages.at(-1).t, "session-full");
    assert.equal(mod.slots.has("eighth-client"), false);
    mod.handleMessage({ t: "bye", from: "peer3", v: 4 });
    mod.sendWelcome("replacement");
    assert.equal(mod.slots.get("replacement"), 3);
});

test("backpressure retains the baseline and defers welcome until its frame is published", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, true, t);
    const send = mod.net.send;
    mod.net.send = message => (message.t === "state" ? false : send(message));
    mod.sendWelcome("peer");
    assert.equal(mod.baseline.revision, 0);
    assert.equal(
        mod.messages.some(message => message.t === "welcome"),
        false
    );
    mod.net.send = message => (message.t === "welcome" ? false : send(message));
    mod.sendWelcome("peer");
    assert.equal(mod.baseline.revision, 1);
    assert.equal(mod.pendingWelcomes.has("peer"), false, "a failed send must not suppress recovery");
    assert.equal(mod.stateReceipts.has("peer"), false, "a failed welcome is not an application receipt");
    mod.net.send = send;
    mod.sendWelcome("peer");
    const welcome = mod.messages.at(-1);
    assert.equal(welcome.t, "welcome");
    assert.equal(welcome.revision, mod.baseline.revision);
    assert.deepEqual(welcome.dump.entities, [...mod.baseline.entities.values()]);
});

test("a host departure releases the replica back to solo simulation", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, false, t);
    mod.hostId = "host";
    mod.handleMessage({ t: "bye", from: "host", v: 4 });
    assert.equal(mod.session, null);
    let ticks = 0;
    root.time.performTicks(100, () => {
        ticks++;
        return true;
    });
    assert.ok(ticks > 0);
});

test("cached capture stays frozen and tracks geometry, configuration and empty queues", () => {
    const root = makeRoot();
    const cutter = place(root, MetaCutterBuilding, 10, 10);
    const lever = place(root, MetaLeverBuilding, 15, 10);
    const capture = new StateCapture(root);
    try {
        const item = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
        cutter.components.ItemProcessor.inputSlots.set(0, item);
        cutter.components.ItemProcessor.inputCount = 1;
        const first = capture.capture();
        const frozen = JSON.stringify(first);
        let staticSerializations = 0;
        const original = lever.components.StaticMapEntity.serialize.bind(lever.components.StaticMapEntity);
        lever.components.StaticMapEntity.serialize = () => {
            ++staticSerializations;
            return original();
        };
        const idle = capture.capture();
        assert.equal(idle.entities[0], first.entities[0], "unchanged live input maps reuse captures");
        assert.equal(idle.entities[1], first.entities[1]);
        assert.equal(staticSerializations, 0, "unchanged geometry is cached");
        cutter.components.ItemProcessor.inputSlots.clear();
        cutter.components.ItemProcessor.inputCount = 0;
        lever.components.Lever.toggled = true;
        root.signals.entityChanged.dispatch(lever);
        const next = capture.capture();
        assert.equal(JSON.stringify(first), frozen, "ticks cannot mutate captured state");
        assert.deepEqual(next.entities, captureSnapshot(root, exports).entities);
        assert.equal(next.entities[0].runtime.ItemProcessor.inputSlots.$map.length, 0);
        assert.ok(staticSerializations > 0, "configuration signals invalidate captures");
    } finally {
        capture.dispose();
    }
});

test("incremental captures recover skipped publications and preserve changes across capture replacement", () => {
    const root = makeRoot();
    const cutter = place(root, MetaCutterBuilding, 10, 10);
    const miner = place(root, MetaMinerBuilding, 20, 20);
    const belt = place(root, MetaBeltBuilding, 30, 30);
    const spare = place(root, MetaBeltBuilding, 40, 40);
    const capture = new StateCapture(root);
    let replacement;
    const baseline = new StateBaseline();
    const initial = capture.capture();
    baseline.reset(1, initial.entities, initial.beltPaths);
    const replica = new StateBaseline();
    replica.reset(1, initial.entities, initial.beltPaths);
    const publish = snapshot => {
        const frame = baseline.createFrame(snapshot, {});
        baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
        replica.applyFrame(unpackStateFrame(JSON.parse(JSON.stringify(packStateFrame(frame)))));
        for (const entity of snapshot.entities) assert.deepEqual(replica.entities.get(entity.uid), entity);
        assert.equal(replica.entities.size, snapshot.entities.length);
        assert.deepEqual(replica.beltPaths, snapshot.beltPaths);
        return frame;
    };
    try {
        const map = baseline.entities;
        miner.components.Miner.lastMiningTime = 2;
        assert.ok(root.logic.tryDeleteBuilding(belt));
        const first = publish(capture.capture());
        assert.deepEqual(first.removed, [belt.uid]);
        assert.equal(baseline.entities, map, "ordinary publication updates the existing baseline map");
        cutter.components.ItemProcessor.bonusTime = 0.125;
        assert.ok(root.logic.tryDeleteBuilding(spare));
        const unpublished = capture.capture();
        const unusedFrame = baseline.createFrame(unpublished, {});
        assert.equal(unusedFrame.base, baseline.revision);
        assert.equal(baseline.entities.get(cutter.uid).runtime.ItemProcessor.bonusTime, 0);
        miner.components.Miner.lastMiningTime = 3;
        const recovered = publish(capture.capture());
        assert.deepEqual(recovered.removed, [spare.uid], "failed publication's removal must survive");
        assert.ok(
            recovered.patches.some(patch => patch.uid === cutter.uid),
            "failed publication's change must survive"
        );
        assert.ok(recovered.patches.some(patch => patch.uid === miner.uid));
        replacement = new StateCapture(root);
        publish(replacement.capture());
        cutter.components.ItemProcessor.inputSlots.set(
            0,
            root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu")
        );
        cutter.components.ItemProcessor.inputCount = 1;
        publish(replacement.capture());
        assert.equal(replica.entities.get(cutter.uid).runtime.ItemProcessor.inputCount, 1);
    } finally {
        capture.dispose();
        replacement?.dispose();
    }
});

test("changing a charge timer reuses unchanged captured queue branches without mutating old state", () => {
    const root = makeRoot();
    const cutter = place(root, MetaCutterBuilding, 10, 10);
    const processor = cutter.components.ItemProcessor;
    const item = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    processor.inputSlots.set(0, item);
    processor.inputCount = 1;
    processor.ongoingCharges = [{ remainingTime: 0.4, items: [{ item, requiredSlot: 0 }] }];
    processor.queuedEjects = [{ item, preferredSlot: 1 }];
    const capture = new StateCapture(root);
    try {
        const first = capture.capture();
        const frozen = JSON.stringify(first);
        processor.ongoingCharges[0].remainingTime = 0.3;
        const next = capture.capture();
        const previous = first.entities[0].runtime.ItemProcessor;
        const runtime = next.entities[0].runtime.ItemProcessor;
        assert.notEqual(runtime.ongoingCharges, previous.ongoingCharges);
        assert.equal(runtime.ongoingCharges[0].items, previous.ongoingCharges[0].items);
        assert.equal(runtime.inputSlots, previous.inputSlots);
        assert.equal(runtime.queuedEjects, previous.queuedEjects);
        assert.equal(JSON.stringify(first), frozen);
        assert.deepEqual(next.entities, captureSnapshot(root, exports).entities);
    } finally {
        capture.dispose();
    }
});

test("one-pass runtime captures detach map, object-key, type and array changes", () => {
    const root = makeRoot();
    const entity = place(root, MetaCutterBuilding, 10, 10);
    const processor = entity.components.ItemProcessor;
    const item = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    processor.inputSlots.set(0, item);
    processor.ongoingCharges = [{ remainingTime: 0.4, items: [{ item, requiredSlot: 0, extra: 3 }] }];
    const capture = new StateCapture(root);
    try {
        const first = capture.capture();
        const frozen = JSON.stringify(first);
        processor.inputSlots.clear();
        processor.inputSlots.set(1, item);
        const eject = processor.ongoingCharges[0].items[0];
        delete eject.requiredSlot;
        eject.preferredSlot = null;
        eject.extra = {};
        const second = capture.capture();
        assert.deepEqual(second.entities, captureSnapshot(root, exports).entities);
        assert.equal(
            Object.hasOwn(
                second.entities[0].runtime.ItemProcessor.ongoingCharges[0].items[0],
                "requiredSlot"
            ),
            false
        );
        eject.extra = [];
        assert.deepEqual(capture.capture().entities, captureSnapshot(root, exports).entities);
        processor.ongoingCharges.length = 0;
        processor.inputSlots.clear();
        assert.deepEqual(capture.capture().entities, captureSnapshot(root, exports).entities);
        assert.equal(JSON.stringify(first), frozen);
    } finally {
        capture.dispose();
    }
});

test("underground and miner captures preserve precision and reuse unchanged item containers", () => {
    const root = makeRoot();
    const tunnel = place(root, MetaUndergroundBeltBuilding, 10, 10).components.UndergroundBelt;
    const miner = place(root, MetaMinerBuilding, 20, 20).components.Miner;
    const item = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    const capture = new StateCapture(root);
    try {
        capture.capture();
        tunnel.pendingItems.push([item, 0.00009]);
        miner.itemChainBuffer.push(item);
        const initial = capture.capture();
        const frozen = JSON.stringify(initial);
        for (const time of [-0.10005, 0.10005, 0.99999, 1.00001]) {
            tunnel.pendingItems[0][1] = time;
            miner.lastMiningTime = Math.abs(time);
            const current = capture.capture();
            assert.deepEqual(current.entities, captureSnapshot(root, exports).entities);
            assert.equal(
                current.entities[1].components.Miner.itemChainBuffer,
                initial.entities[1].components.Miner.itemChainBuffer
            );
            assert.equal(capture.capture().entities[0], current.entities[0]);
        }
        tunnel.pendingItems.length = 0;
        miner.itemChainBuffer.length = 0;
        assert.deepEqual(capture.capture().entities, captureSnapshot(root, exports).entities);
        assert.equal(JSON.stringify(initial), frozen);
    } finally {
        capture.dispose();
    }
});

test("belt captures reuse unchanged pairs and detach spacing, item changes and shrinking arrays", () => {
    const root = makeRoot();
    for (let y = 10; y < 13; ++y) place(root, MetaBeltBuilding, 10, y);
    const path = root.systemMgr.systems.belt.beltPaths[0];
    const circle = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    const rectangle = root.shapeDefinitionMgr.getShapeItemFromShortKey("RuRuRuRu");
    path.items = [
        [0.63, circle],
        [0.63, circle],
    ];
    path.spacingToFirstItem = 0.1;
    const capture = new StateCapture(root);
    try {
        const first = capture.capture();
        const frozen = JSON.stringify(first);
        assert.equal(capture.capture().beltPaths[0], first.beltPaths[0]);
        path.spacingToFirstItem = 0.2;
        const moved = capture.capture();
        assert.notEqual(moved.beltPaths[0], first.beltPaths[0]);
        assert.equal(moved.beltPaths[0].items, first.beltPaths[0].items);
        path.items[0][0] = 0.31;
        const changed = capture.capture();
        assert.notEqual(changed.beltPaths[0].items[0], first.beltPaths[0].items[0]);
        assert.equal(changed.beltPaths[0].items[1], first.beltPaths[0].items[1]);
        path.items[1][1] = rectangle;
        assert.equal(capture.capture().beltPaths[0].items[1][1].data, "RuRuRuRu");
        path.items.length = 1;
        const shrunk = capture.capture();
        assert.equal(shrunk.beltPaths[0].items.length, 1);
        assert.deepEqual(shrunk.beltPaths, captureSnapshot(root, exports).beltPaths);
        assert.equal(JSON.stringify(first), frozen);
    } finally {
        capture.dispose();
    }
});

test("count updates preserve derived goals; progression and rejected upgrades rebuild them", () => {
    const host = makeRoot();
    const client = makeRoot();
    const capture = new StateCapture(host);
    const baseline = new StateBaseline();
    const replica = new StateBaseline();
    const initial = capture.capture();
    baseline.reset(1, initial.entities, initial.beltPaths);
    replica.reset(1, initial.entities, initial.beltPaths);
    let goals = 0;
    const compute = client.hubGoals.computeNextGoal.bind(client.hubGoals);
    client.hubGoals.computeNextGoal = () => {
        ++goals;
        return compute();
    };
    const publish = () => {
        const snapshot = capture.capture();
        const frame = unpackStateFrame(
            JSON.parse(JSON.stringify(packStateFrame(baseline.createFrame(snapshot, {}))))
        );
        baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
        replica.applyFrame(frame);
        reconcileWorld(client, replica, frame, exports);
    };
    try {
        client.hubGoals.storedShapes.CuCuCuCu = 99;
        client.hubGoals.storedShapes.RuRuRuRu = 42;
        host.hubGoals.storedShapes.CuCuCuCu = 5;
        publish();
        assert.deepEqual(client.hubGoals.storedShapes, host.hubGoals.storedShapes);
        assert.equal(goals, 0, "deliveries must not regenerate goals");
        client.hubGoals.upgradeLevels.belt = 1;
        client.hubGoals.upgradeImprovements.belt = 1.5;
        publish();
        assert.equal(client.hubGoals.upgradeLevels.belt, 0, "host rejection restores progression");
        assert.equal(client.hubGoals.upgradeImprovements.belt, 1);
        assert.equal(goals, 1);
        host.hubGoals.upgradeLevels.belt = 1;
        host.hubGoals.gainedRewards.add("no_reward_freeplay");
        publish();
        assert.equal(client.hubGoals.upgradeImprovements.belt, 1.5);
        assert.deepEqual(client.hubGoals.gainedRewards, host.hubGoals.gainedRewards);
        assert.equal(goals, 2);
        publish();
        assert.equal(goals, 2);
    } finally {
        capture.dispose();
    }
});

test("welcome reuses the publication capture and broadcasts one revision to every peer", async t => {
    const root = makeRoot();
    const cutter = place(root, MetaCutterBuilding, 10, 10);
    const mod = await makeMod(root, true, t);
    mod.slots.set("one", 1);
    mod.slots.set("two", 2);
    mod.touchPeer("one", "One", false);
    mod.touchPeer("two", "Two", false);
    let serializations = 0;
    const serialize = cutter.serialize.bind(cutter);
    cutter.serialize = () => {
        ++serializations;
        return serialize();
    };
    mod.sendWelcome("*");
    assert.equal(serializations, 1, "join/resync must not serialize the factory twice");
    const welcomes = mod.messages.filter(message => message.t === "welcome");
    assert.equal(welcomes.length, 2);
    assert.equal(welcomes[0].revision, welcomes[1].revision);
    assert.equal(mod.messages.filter(message => message.t === "state").length, 1);
    assert.deepEqual(welcomes[0].dump.entities, [...mod.baseline.entities.values()]);
    welcomes[0].dump.entities[0].components.StaticMapEntity.origin.x = 999;
    assert.equal(
        mod.baseline.entities.get(cutter.uid).components.StaticMapEntity.origin.x,
        10,
        "welcome and serialization hooks cannot mutate the baseline"
    );
});

test("routine packets refresh peer liveness without rebuilding the peer list", async t => {
    const mod = await makeMod(makeRoot(), true, t);
    let renders = 0;
    mod.renderPeers = () => {
        ++renders;
    };
    mod.touchPeer("peer", "Friend", false);
    assert.equal(renders, 1);
    mod.peers.get("peer").lastSeen = 0;
    for (let i = 0; i < 100; ++i) mod.touchPeer("peer", "Friend", false);
    assert.ok(mod.peers.get("peer").lastSeen > 0);
    assert.equal(renders, 1);
    mod.touchPeer("peer", "Renamed", false);
    mod.touchPeer("peer", "Renamed", true);
    assert.equal(renders, 3);
});

test("hot slot captures match save schemas through item changes and float boundaries", () => {
    const root = makeRoot();
    const cutter = place(root, MetaCutterBuilding, 10, 10);
    const lever = place(root, MetaLeverBuilding, 15, 10);
    const capture = new StateCapture(root);
    const item = root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    const miner = place(root, MetaMinerBuilding, 20, 20);
    try {
        for (const progress of [0.00009, 0.10005, 0.99999, 1.00001, 0]) {
            cutter.components.ItemEjector.slots[0].item = progress ? item : null;
            cutter.components.ItemEjector.slots[0].progress = progress;
            lever.components.WiredPins.slots[0].value = progress ? BOOL_TRUE_SINGLETON : null;
            miner.components.Miner.lastMiningTime = progress;
            miner.components.Miner.itemChainBuffer = progress ? [item, item] : [];
            const snapshot = capture.capture();
            assert.deepEqual(snapshot.entities, captureSnapshot(root, exports).entities);
        }
    } finally {
        capture.dispose();
    }
});

test("welcome keeps serialization hooks and isolates their mutations from cached captures", () => {
    const root = makeRoot();
    place(root, MetaCutterBuilding, 10, 10);
    const capture = new StateCapture(root);
    const captured = capture.capture();
    const frozen = JSON.stringify(captured);
    const hook = (gameRoot, dump) => {
        assert.equal(gameRoot, root);
        dump.entities[0].runtime.ItemProcessor.bonusTime = 12;
        dump.modExtraData.example = { value: "hook data" };
    };
    MOD_SIGNALS.gameSerialized.add(hook);
    try {
        const welcome = captureSnapshot(root, exports, captured);
        assert.equal(welcome.entities[0].runtime.ItemProcessor.bonusTime, 12);
        assert.equal(welcome.modExtraData.example.value, "hook data");
        assert.equal(JSON.stringify(captured), frozen);
    } finally {
        MOD_SIGNALS.gameSerialized.remove(hook);
        capture.dispose();
    }
});

test("runtime restoration reuses queues, removes stale fields, and keeps canonical data isolated", () => {
    const host = makeRoot();
    const source = place(host, MetaCutterBuilding, 10, 10);
    const client = makeRoot();
    const target = place(client, MetaCutterBuilding, 10, 10);
    const processor = source.components.ItemProcessor;
    const replica = target.components.ItemProcessor;
    const item = host.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    processor.inputSlots.set(0, item);
    processor.inputCount = 1;
    processor.ongoingCharges = [{ remainingTime: 0.4, items: [{ item, requiredSlot: 0 }] }];
    processor.queuedEjects = [{ item, requiredSlot: 1 }];
    const first = captureSnapshot(host, exports).entities[0];
    const frozen = JSON.stringify(first);
    const slots = replica.inputSlots;
    const charges = replica.ongoingCharges;
    const queued = replica.queuedEjects;
    applyRuntime(target, first, client, exports);
    const charge = charges[0];
    const eject = queued[0];
    assert.equal(replica.inputSlots, slots);
    assert.equal(replica.ongoingCharges, charges);
    assert.equal(replica.queuedEjects, queued);
    processor.inputSlots.clear();
    processor.inputCount = 0;
    processor.ongoingCharges[0].remainingTime = 0.2;
    processor.ongoingCharges[0].items = [{ item, preferredSlot: 1 }];
    processor.queuedEjects = [{ item, preferredSlot: null }];
    const second = captureSnapshot(host, exports).entities[0];
    applyRuntime(target, second, client, exports);
    assert.equal(charges[0], charge);
    assert.equal(queued[0], eject);
    assert.equal(slots.size, 0);
    assert.equal(Object.hasOwn(eject, "requiredSlot"), false);
    assert.equal(eject.preferredSlot, null);
    assert.equal(charge.remainingTime, 0.2);
    charge.items[0].preferredSlot = 99;
    assert.equal(second.runtime.ItemProcessor.ongoingCharges[0].items[0].preferredSlot, 1);
    assert.equal(JSON.stringify(first), frozen);
    processor.ongoingCharges.length = 0;
    processor.queuedEjects.length = 0;
    applyRuntime(target, captureSnapshot(host, exports).entities[0], client, exports);
    assert.equal(replica.ongoingCharges, charges);
    assert.equal(charges.length, 0);
    assert.equal(queued.length, 0);
});

test("small edits retain distant paths and caches while reconnecting nearby machine targets", () => {
    const host = makeRoot();
    for (const x of [10, 100]) {
        place(host, MetaMinerBuilding, x, 13);
        place(host, MetaBeltBuilding, x, 12);
        place(host, MetaBeltBuilding, x, 11);
        place(host, MetaCutterBuilding, x, 10);
    }
    const client = makeRoot();
    const initial = captureSnapshot(host, exports);
    client.gameInitialized = false;
    assert.ok(new SavegameSerializer().deserialize(initial, client).isGood());
    client.gameInitialized = true;
    client.signals.postLoadHook.dispatch();
    client.systemMgr.systems.wire.update();
    const baseline = new StateBaseline();
    const replica = new StateBaseline();
    baseline.reset(1, initial.entities, initial.beltPaths);
    replica.reset(1, initial.entities, initial.beltPaths);
    const capture = new StateCapture(host);
    const distantPath = client.map.getLayerContentXY(100, 12, "regular").components.Belt.assignedPath;
    const distantChunk = client.map.getChunkAtTileOrNull(100, 12);
    const distantIteration = distantChunk.renderIteration;
    const localMiner = client.map.getLayerContentXY(10, 13, "regular");
    const distantMiner = client.map.getLayerContentXY(100, 13, "regular");
    const caches = [];
    const ejectors = client.systemMgr.systems.itemEjector;
    const recompute = ejectors.recomputeSingleEntityCache.bind(ejectors);
    ejectors.recomputeSingleEntityCache = entity => {
        caches.push(entity.uid);
        recompute(entity);
    };
    let wires = 0;
    const wire = client.systemMgr.systems.wire;
    const recomputeWire = wire.recomputeWiresNetwork.bind(wire);
    wire.recomputeWiresNetwork = () => {
        ++wires;
        recomputeWire();
    };
    const publish = () => {
        const snapshot = capture.capture();
        const frame = unpackStateFrame(
            JSON.parse(JSON.stringify(packStateFrame(baseline.createFrame(snapshot, {}))))
        );
        baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
        replica.applyFrame(frame);
        reconcileWorld(client, replica, frame, exports);
        client.systemMgr.systems.belt.debug_verifyBeltPaths();
        assertReplicaState(runtimeState(client), runtimeState(host));
    };
    try {
        const originalPath = localMiner.components.ItemEjector.slots[0].cachedBeltPath;
        assert.ok(host.logic.tryDeleteBuilding(host.map.getLayerContentXY(10, 10, "regular")));
        const replacement = place(host, MetaCutterBuilding, 10, 10);
        publish();
        assert.equal(localMiner.components.ItemEjector.slots[0].cachedBeltPath, originalPath);
        const target = client.entityMgr.findByUid(replacement.uid).components.ItemProcessor;
        assert.ok(originalPath.boundAcceptor);
        assert.equal(
            originalPath.boundAcceptor(client.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu")),
            true
        );
        assert.equal(target.inputCount, 1, "the reused path must target the replacement machine");
        // Deliver on both copies so the following frame also compares the real
        // acceptor animation and processing input rather than a test-only edit.
        host.map
            .getLayerContentXY(10, 11, "regular")
            .components.Belt.assignedPath.boundAcceptor(
                host.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu")
            );
        assert.equal(wires, 0, "regular buildings cannot require a wire network rebuild");
        assert.equal(caches.includes(distantMiner.uid), false);
        assert.equal(distantChunk.renderIteration, distantIteration);
        assert.equal(
            client.map.getLayerContentXY(100, 12, "regular").components.Belt.assignedPath,
            distantPath
        );
        caches.length = 0;
        assert.ok(host.logic.tryDeleteBuilding(host.map.getLayerContentXY(10, 11, "regular")));
        publish();
        assert.equal(
            client.map.getLayerContentXY(100, 12, "regular").components.Belt.assignedPath,
            distantPath
        );
        assert.ok(
            caches.includes(localMiner.uid),
            "an ejector must reconnect when its long path is replaced"
        );
        assert.equal(caches.includes(distantMiner.uid), false);
        assert.equal(
            localMiner.components.ItemEjector.slots[0].cachedBeltPath,
            client.map.getLayerContentXY(10, 12, "regular").components.Belt.assignedPath
        );
        assert.equal(distantChunk.renderIteration, distantIteration);
        assert.equal(wires, 0);
    } finally {
        capture.dispose();
    }
});

test("replicated wire edits rebuild networks while ordinary pin updates retain them", () => {
    const host = makeRoot();
    const lever = place(host, MetaLeverBuilding, 20, 10);
    const client = makeRoot();
    const initial = captureSnapshot(host, exports);
    client.gameInitialized = false;
    assert.ok(new SavegameSerializer().deserialize(initial, client).isGood());
    client.gameInitialized = true;
    client.signals.postLoadHook.dispatch();
    client.systemMgr.systems.wire.update();
    const baseline = new StateBaseline();
    const replica = new StateBaseline();
    baseline.reset(1, initial.entities, initial.beltPaths);
    replica.reset(1, initial.entities, initial.beltPaths);
    const capture = new StateCapture(host);
    const publish = () => {
        const snapshot = capture.capture();
        const frame = unpackStateFrame(
            JSON.parse(JSON.stringify(packStateFrame(baseline.createFrame(snapshot, {}))))
        );
        baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
        replica.applyFrame(frame);
        reconcileWorld(client, replica, frame, exports);
    };
    try {
        const wireEntity = place(host, MetaWireBuilding, 20, 9);
        host.systemMgr.systems.lever.update();
        host.systemMgr.systems.wire.update();
        publish();
        const network = client.entityMgr.findByUid(wireEntity.uid).components.Wire.linkedNetwork;
        assert.ok(network);
        assert.equal(
            network.currentValue,
            client.entityMgr.findByUid(lever.uid).components.WiredPins.slots[0].value
        );
        lever.components.Lever.toggled = true;
        host.signals.entityChanged.dispatch(lever);
        host.systemMgr.systems.lever.update();
        host.systemMgr.systems.wire.update();
        publish();
        assert.equal(client.entityMgr.findByUid(wireEntity.uid).components.Wire.linkedNetwork, network);
        assert.equal(network.currentValue, BOOL_TRUE_SINGLETON);
        assert.ok(host.logic.tryDeleteBuilding(wireEntity));
        publish();
        assert.equal(client.entityMgr.findByUid(wireEntity.uid, false), null);
        assert.notEqual(
            client.entityMgr.findByUid(lever.uid).components.WiredPins.slots[0].linkedNetwork,
            network
        );
    } finally {
        capture.dispose();
    }
});

test("idle updates and rejected previews leave unrelated buildings untouched", async t => {
    const host = makeRoot();
    place(host, MetaCutterBuilding, 10, 10);
    place(host, MetaBeltBuilding, 20, 20);
    const client = makeRoot();
    const mod = await makeMod(client, false, t);
    mod.hostId = "host";
    const snapshot = captureSnapshot(host, exports);
    mod.applyWelcome(snapshot, 1, 0);
    const unrelated = [...client.entityMgr.entities.values()][0];
    let restores = 0;
    const component = unrelated.components.ItemProcessor;
    const original = component.deserialize.bind(component);
    component.deserialize = (...args) => {
        ++restores;
        return original(...args);
    };
    const baseline = new StateBaseline();
    baseline.reset(1, snapshot.entities, snapshot.beltPaths);
    const idle = baseline.createFrame(snapshot, {});
    mod.applyState({ ...idle, from: "host" });
    assert.equal(restores, 0);
    baseline.reset(idle.revision, snapshot.entities, snapshot.beltPaths);
    place(client, MetaBeltBuilding, 20, 20, 90);
    mod.flushOps();
    // Reject on the very first acknowledgement (no intervening host update).
    const rejected = baseline.createFrame(snapshot, { [mod.net.clientId]: 1 });
    mod.applyState({ ...rejected, from: "host" });
    assertReplicaState(runtimeState(client), runtimeState(host));
    assert.equal(restores, 0, "prediction rollback is scoped to touched entities");
});

test("a slow client's receipts bound queued frames without capturing another save", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, true, t);
    mod.slots.set("peer", 1);
    mod.stateReceipts.set("peer", 0);
    mod.broadcastState();
    mod.broadcastState();
    let captures = 0;
    const capture = mod.stateCapture.capture.bind(mod.stateCapture);
    mod.stateCapture.capture = () => {
        ++captures;
        return capture();
    };
    mod.broadcastState();
    assert.equal(mod.baseline.revision, 2);
    assert.equal(captures, 0);
    mod.handleMessage({ t: "state-received", v: 4, from: "peer", to: mod.net.clientId, revision: 100 });
    assert.equal(mod.stateReceipts.get("peer"), 0);
    mod.handleMessage({ t: "state-received", v: 4, from: "peer", to: mod.net.clientId, revision: 1 });
    mod.broadcastState();
    assert.equal(mod.baseline.revision, 3);
    assert.equal(captures, 1);
});

test("failed client application requests one snapshot and waits before retrying", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, false, t);
    const now = Date.now;
    let clock = now();
    Date.now = () => clock;
    try {
        mod.awaitingWelcome = false;
        mod.hostId = "host";
        const broken = { from: "host", base: 10, revision: 11 };
        mod.applyState(broken);
        assert.equal(mod.awaitingWelcome, true);
        for (let i = 0; i < 14; ++i) {
            clock += 1000;
            mod.applyState(broken);
            mod.requestResync();
        }
        assert.equal(mod.messages.filter(message => message.t === "resync-request").length, 1);
        clock += 1001;
        mod.requestResync();
        assert.equal(mod.messages.filter(message => message.t === "resync-request").length, 2);
        mod.applyWelcome(captureSnapshot(root, exports), 12, 0);
        assert.equal(mod.awaitingWelcome, false);
        assert.equal(mod.messages.at(-1).t, "state-received");
    } finally {
        Date.now = now;
    }
});

test("pending welcomes coalesce requests until a valid receipt or snapshot timeout", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, true, t);
    mod.touchPeer("peer", "Peer", false);
    const now = Date.now;
    let clock = now();
    Date.now = () => clock;
    try {
        let captures = 0;
        const capture = mod.stateCapture.capture.bind(mod.stateCapture);
        mod.stateCapture.capture = () => {
            ++captures;
            return capture();
        };
        mod.sendWelcome("peer");
        for (let i = 0; i < 14; ++i) {
            clock += 1000;
            mod.sendWelcome("peer");
            mod.sendWelcome("*");
        }
        assert.equal(captures, 1, "duplicate requests must not even capture another factory");
        const receipt = revision =>
            mod.handleMessage({ t: "state-received", v: 4, from: "peer", to: mod.net.clientId, revision });
        receipt(100);
        assert.equal(mod.pendingWelcomes.size, 1, "future receipts cannot release recovery flow control");
        receipt(0);
        assert.equal(mod.pendingWelcomes.size, 1, "stale receipts cannot release recovery flow control");
        receipt(1);
        assert.equal(mod.pendingWelcomes.size, 0, "the welcome's own revision must be acknowledged");
        mod.sendWelcome("peer");
        assert.equal(captures, 2);
        clock += 15001;
        mod.sendWelcome("peer");
        assert.equal(captures, 3, "a lost or rejected welcome must remain recoverable");
        mod.handleMessage({ t: "bye", v: 4, from: "peer" });
        assert.equal(mod.pendingWelcomes.size, 0);
    } finally {
        Date.now = now;
    }
});

test("compression backlog bounds publication before bytes reach the WebSocket", async t => {
    const mod = await makeMod(makeRoot(), true, t);
    mod.slots.set("peer", 1);
    const wires = [];
    mod.net.socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: wire => wires.push(wire),
        close() {},
    };
    mod.net.send = Object.getPrototypeOf(mod.net).send.bind(mod.net);
    let release;
    mod.net.sendChain = new Promise(resolve => (release = resolve));
    try {
        const welcome = { t: "welcome", to: "peer", dump: { repeated: "abcdefgh".repeat(100000) } };
        assert.equal(mod.net.send(welcome), true);
        assert.equal(mod.net.send(welcome), false, "one peer cannot queue duplicate full snapshots");
        assert.ok(mod.net.sendStats.queuedBytes > 512 * 1024);
        assert.equal(mod.net.sendStats.pending, 1);
        let captures = 0;
        const capture = mod.stateCapture.capture.bind(mod.stateCapture);
        mod.stateCapture.capture = () => {
            ++captures;
            return capture();
        };
        mod.broadcastState();
        mod.sendWelcome("other");
        assert.equal(captures, 0);
        assert.equal(mod.baseline.revision, 0);
        release();
        await mod.net.sendChain;
        assert.equal(wires.length, 1);
        assert.equal(mod.net.sendStats.queuedBytes, 0);
        assert.equal(mod.net.sendStats.pending, 0);
        assert.equal(mod.net.sendStats.welcomes.size, 0);
        assert.equal(mod.net.sendStats.lastWelcomeBytes, wires[0].length);
        mod.broadcastState();
        await mod.net.sendChain;
        assert.equal(captures, 1);
        assert.equal(mod.net.sendStats.stateCount, 1);
        assert.equal(mod.net.sendStats.stateBytes, wires[1].length);
    } finally {
        release();
        mod.net.disconnect();
        await mod.net.sendChain;
    }
});

test("compression preserves send order and departure flushes before disconnect", async t => {
    const mod = await makeMod(makeRoot(), false, t);
    const wires = [];
    mod.net.socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: wire => wires.push(wire),
        close() {},
    };
    mod.net.send = Object.getPrototypeOf(mod.net).send.bind(mod.net);
    mod.net.send({ t: "welcome", dump: { repeated: "abcdefgh".repeat(10000) } });
    mod.net.send({ t: "cursor", x: 2, y: 3 });
    await mod.net.sendChain;
    assert.equal((await decodeWireMessage(wires[0])).t, "welcome");
    assert.equal(JSON.parse(wires[1]).t, "cursor");
    mod.net.send({ t: "bye" });
    mod.net.disconnect();
    assert.equal(JSON.parse(wires[2]).t, "bye");
});

test("disconnect cancels queued compression before it starts on an obsolete socket", async t => {
    const mod = await makeMod(makeRoot(), false, t);
    const wires = [];
    mod.net.socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: wire => wires.push(wire),
        close() {},
    };
    mod.net.send = Object.getPrototypeOf(mod.net).send.bind(mod.net);
    const NativeCompression = globalThis.CompressionStream;
    let compressions = 0;
    globalThis.CompressionStream = class extends NativeCompression {
        constructor(...args) {
            super(...args);
            ++compressions;
        }
    };
    try {
        mod.net.send({ t: "welcome", dump: { repeated: "abcdefgh".repeat(10000) } });
        mod.net.send({ t: "welcome", dump: { repeated: "abcdefgh".repeat(10000) } });
        mod.net.disconnect();
        await mod.net.sendChain;
        assert.equal(compressions, 0);
        assert.equal(wires.length, 0);
    } finally {
        globalThis.CompressionStream = NativeCompression;
    }
});

test("real WebSocket relay carries welcome, client edits and authoritative acknowledgements", async t => {
    const root = makeRoot();
    const mod = await makeMod(root, true, t);
    const server = new CoopWsServer();
    server.onMessage = (peer, text) => server.broadcast(text, peer.id);
    const port = await server.start(0);
    const connect = async () => {
        const socket = new WebSocket("ws://127.0.0.1:" + port);
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
        });
        return socket;
    };
    const hostSocket = await connect();
    const clientSocket = await connect();
    t.after(async () => {
        hostSocket.close();
        clientSocket.close();
        await server.stop();
    });
    hostSocket.addEventListener("message", event => mod.handleMessage(JSON.parse(event.data)));
    mod.net.socket = hostSocket;
    mod.net.send = Object.getPrototypeOf(mod.net).send.bind(mod.net);
    const receive = predicate =>
        new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                clientSocket.removeEventListener("message", listener);
                reject(new Error("Relay response timed out"));
            }, 3000);
            const listener = async event => {
                let message = await decodeWireMessage(event.data);
                if (message.t === "state") message = unpackStateFrame(message);
                if (predicate(message)) {
                    clearTimeout(timeout);
                    clientSocket.removeEventListener("message", listener);
                    resolve(message);
                }
            };
            clientSocket.addEventListener("message", listener);
        });
    const welcomePromise = receive(message => message.t === "welcome");
    clientSocket.send(JSON.stringify({ t: "hello", v: 4, from: "remote", name: "test" }));
    const welcome = await welcomePromise;
    assert.equal(welcome.slot, 1);
    assert.ok(welcome.revision > 0);
    const source = makeRoot();
    const entity = place(source, MetaBeltBuilding, 10, 10).serialize();
    entity.uid = 10001;
    const acknowledgement = receive(
        message => message.t === "state" && message.acknowledgements.remote === 1
    );
    clientSocket.send(
        JSON.stringify({
            t: "ops",
            v: 4,
            from: "remote",
            seq: 1,
            ops: [{ k: "place", uid: entity.uid, entity }],
        })
    );
    const frame = await acknowledgement;
    assert.ok(frame.entities.some(data => data.uid === 10001));
    assert.equal(root.map.getLayerContentXY(10, 10, "regular").uid, 10001);
});
