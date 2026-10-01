// Loaded by electron-smoke.cjs in each isolated packaged renderer.
/* global window */
import CoopMod from "mod://coop/entry.js";
import { StateCapture } from "mod://coop/replication.js";

export function initialize(isHost, dump, metadata, url) {
    const s = window.shapez;
    if (Object.keys(s).length || !s.SerializerInternal) throw new Error("Unexpected production export API");
    s.Loader.getSprite = () => ({});
    s.Loader.getRegularSprite = () => ({});
    s.buildBuildingCodeCache();
    const root = new s.GameRoot({
        settings: {
            getDesiredFps: () => 60,
            getAllSettings: () => ({ simplifiedBelts: false, enableTunnelSmartplace: false }),
        },
    });
    root.gameMode = new s.RegularGameMode(root);
    root.dynamicTickrate = new s.DynamicTickrate(root);
    root.entityMgr = new s.EntityManager(root);
    root.map = new s.BaseMap(root);
    root.logic = new s.GameLogic(root);
    root.camera = { serialize: () => ({}), deserialize() {}, getIsMapOverlayActive: () => false };
    root.hud = { parts: {}, shouldPauseGame: () => false };
    root.shapeDefinitionMgr = new s.ShapeDefinitionManager(root);
    root.hubGoals = new s.HubGoals(root);
    root.time = new s.GameTime(root);
    root.productionAnalytics = new s.ProductionAnalytics(root);
    root.systemMgr = new s.GameSystemManager(root);
    let excluded = 0;
    if (isHost && dump) {
        // Historical saves can include stale overlapping registry entries.
        // Exclude them in memory for this fixture; never change the input save.
        const occupied = new Set();
        const removed = new Set();
        dump.entities = dump.entities.filter(data => {
            const entity = new s.SerializerInternal().createEntityFromSerialized(root, data);
            const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
            const tiles = [];
            for (let y = bounds.y; y < bounds.y + bounds.h; ++y)
                for (let x = bounds.x; x < bounds.x + bounds.w; ++x)
                    tiles.push(entity.layer + ":" + x + ":" + y);
            if (tiles.some(tile => occupied.has(tile))) {
                removed.add(data.uid);
                return false;
            }
            tiles.forEach(tile => occupied.add(tile));
            return true;
        });
        excluded = removed.size;
        dump.beltPaths = dump.beltPaths.filter(path => !path.entityPath.some(uid => removed.has(uid)));
        const result = new s.SavegameSerializer().deserialize(dump, root);
        if (!result.isGood()) throw new Error(result.reason);
    } else if (isHost) {
        root.gameInitialized = true; // Live placements construct belt paths immediately.
        const place = (Building, x, y, rotation = 0) => {
            const entity = root.logic.tryPlaceBuilding({
                origin: new s.Vector(x, y),
                rotation,
                originalRotation: rotation,
                rotationVariant: 0,
                variant: "default",
                building: s.gMetaBuildingRegistry.findByClass(Building),
            });
            if (!entity) throw new Error("Fixture placement failed");
        };
        place(s.MetaHubBuilding, 0, 0);
        place(s.MetaMinerBuilding, 1, -5, 180);
        for (let y = -4; y < 0; ++y) place(s.MetaBeltBuilding, 1, y, 180);
        root.map.getLowerLayerContentXY = () => root.shapeDefinitionMgr.getShapeItemFromShortKey("CuCuCuCu");
    }
    root.gameInitialized = true;
    root.signals.postLoadHook.dispatch();
    const mod = new CoopMod(metadata, root.app, {});
    mod.signals = { gameStarted: new s.Signal() };
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
    const sent = {};
    const send = mod.net.send.bind(mod.net);
    mod.net.send = message => {
        const accepted = send(message);
        if (accepted) sent[message.t] = (sent[message.t] || 0) + 1;
        return accepted;
    };
    mod.beginSession(root, isHost);
    mod.endTimers(); // Publications are controlled by the test, not wall-clock scheduling.
    window.coopSmoke = {
        mod,
        root,
        excluded,
        sent,
        tick(count) {
            for (let i = 0; i < count; ++i) {
                root.time.performTicks(root.dynamicTickrate.deltaMs, () => {
                    root.entityMgr.update();
                    root.systemMgr.update();
                    return true;
                });
                root.productionAnalytics.update();
            }
        },
        snapshot() {
            const capture = new StateCapture(root);
            try {
                const snapshot = capture.capture();
                return {
                    entities: snapshot.entities.sort((a, b) => a.uid - b.uid),
                    beltPaths: snapshot.beltPaths,
                    hub: snapshot.hubGoals,
                    time: snapshot.time.timeSeconds,
                    analytics: snapshot.analytics,
                };
            } finally {
                capture.dispose();
            }
        },
    };
    if (!mod.net.connect(url)) throw new Error("Fixture connection failed");
}
