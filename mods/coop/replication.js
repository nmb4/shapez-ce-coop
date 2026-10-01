// Host-authoritative replication. This module has no DOM dependencies so the
// ordering, acknowledgements and runtime state can be regression tested in Node.
export const STATE_INTERVAL_MS = 100;

const fingerprints = new WeakMap();
const capturedSnapshots = new WeakSet();
const capturedEntities = new WeakSet();
const captureChanges = new WeakMap();
function followsCapture(previous, next) {
    return previous && next && previous.owner === next.owner && previous.generation + 1 === next.generation;
}
function fingerprint(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (!fingerprints.has(value)) fingerprints.set(value, JSON.stringify(value));
    return fingerprints.get(value);
}
const equalData = (a, b) => a === b || fingerprint(a) === fingerprint(b);
const sameReference = (a, b) => a === b;
const equalBeltState = (a, b) =>
    a === b ||
    (a.spacingToFirstItem === b.spacingToFirstItem &&
        (a.items === b.items ||
            (a.items.length === b.items.length &&
                a.items.every(
                    ([distance, item], i) => distance === b.items[i][0] && equalData(item, b.items[i][1])
                ))));

export class StateBaseline {
    constructor() {
        this.revision = 0;
        this.entities = new Map();
        this.beltPaths = [];
    }

    reset(revision, entities, beltPaths = []) {
        this.revision = revision;
        const changes = captureChanges.get(entities);
        if (followsCapture(this.capture, changes)) {
            for (const uid of changes.removed) this.entities.delete(uid);
            for (const entity of changes.changed) this.entities.set(entity.uid, entity);
        } else {
            this.entities = new Map();
            for (const entity of entities) this.entities.set(entity.uid, entity);
        }
        this.capture = changes;
        this.beltPaths = beltPaths;
    }

    createFrame(snapshot, acknowledgements) {
        // StateCapture replaces a component/runtime object only after detecting
        // a change. Avoid stringifying these proven changes a second time.
        const trustedCapture = capturedSnapshots.has(snapshot);
        const changes = captureChanges.get(snapshot.entities);
        const incremental = followsCapture(this.capture, changes);
        const next = incremental ? null : new Set();
        const changed = [];
        const patches = [];
        for (const entity of incremental ? changes.changed : snapshot.entities) {
            const uid = entity.uid;
            next?.add(uid);
            const previous = this.entities.get(uid);
            if (previous === entity) continue;
            if (!entity.components && equalData(previous, entity)) continue;
            if (
                !previous?.components ||
                !entity.components ||
                !equalData(previous.components.StaticMapEntity, entity.components.StaticMapEntity)
            ) {
                changed.push(entity);
            } else {
                const sameComponent =
                    trustedCapture && capturedEntities.has(previous) ? sameReference : equalData;
                const components = {};
                const runtime = {};
                let changed = false;
                for (const id of Object.keys(entity.components)) {
                    const data = entity.components[id];
                    if (!sameComponent(previous.components[id], data)) {
                        components[id] = data;
                        changed = true;
                    }
                }
                for (const id of Object.keys(entity.runtime || {})) {
                    const data = entity.runtime[id];
                    if (!sameComponent(previous.runtime?.[id], data)) {
                        runtime[id] = data;
                        changed = true;
                    }
                }
                if (changed) patches.push({ uid, components, runtime });
            }
        }
        const sameLayout =
            this.beltPaths.length === snapshot.beltPaths.length &&
            this.beltPaths.every((path, i) => equalData(path.entityPath, snapshot.beltPaths[i].entityPath));
        return {
            t: "state",
            base: this.revision,
            revision: this.revision + 1,
            entities: changed,
            patches,
            removed: incremental ? changes.removed : [...this.entities.keys()].filter(uid => !next.has(uid)),
            ...(sameLayout
                ? {
                      beltUpdates: snapshot.beltPaths.flatMap((path, index) =>
                          equalBeltState(this.beltPaths[index], path)
                              ? []
                              : [{ index, items: path.items, spacingToFirstItem: path.spacingToFirstItem }]
                      ),
                  }
                : { beltPaths: snapshot.beltPaths }),
            hub: snapshot.hubGoals,
            time: snapshot.time,
            analytics: snapshot.analytics,
            acknowledgements,
        };
    }

    applyFrame(frame) {
        if (frame.revision <= this.revision) {
            return false; // Old/duplicate packet, including one preceding welcome.
        }
        if (frame.base !== this.revision || frame.revision !== frame.base + 1) {
            throw new Error("Missing authoritative state frame");
        }
        for (const uid of frame.removed) {
            this.entities.delete(uid);
        }
        for (const entity of frame.entities) {
            this.entities.set(entity.uid, entity);
        }
        for (const patch of frame.patches || []) {
            const previous = this.entities.get(patch.uid);
            if (!previous) throw new Error("Patch without authoritative entity");
            this.entities.set(patch.uid, {
                ...previous,
                components: { ...previous.components, ...patch.components },
                runtime: { ...previous.runtime, ...patch.runtime },
            });
        }
        frame.beltTopologyChanged = !!frame.beltPaths;
        if (frame.beltPaths) this.beltPaths = frame.beltPaths;
        else {
            this.beltPaths = this.beltPaths.slice();
            for (const update of frame.beltUpdates || []) {
                if (!this.beltPaths[update.index]) throw new Error("Unknown authoritative belt path");
                this.beltPaths[update.index] = { ...this.beltPaths[update.index], ...update };
            }
            frame.beltPaths = this.beltPaths;
        }
        this.revision = frame.revision;
        this.capture = undefined;
        return true;
    }
}

// Savegames intentionally omit some in-flight and display state. Carry it in
// network snapshots without changing the on-disk save format or copying caches.
const RUNTIME_FIELDS = {
    ItemProcessor: ["inputSlots", "inputCount", "ongoingCharges", "bonusTime", "queuedEjects"],
    ItemAcceptor: ["itemConsumptionAnimations"],
    UndergroundBelt: ["consumptionAnimations"],
    BeltReader: ["lastItemTimes", "lastThroughput", "lastThroughputComputation"],
    Storage: ["overlayOpacity"],
};

const serializedItems = new WeakMap();
const runtimeItems = new WeakMap();
function encodeItem(item) {
    if (!serializedItems.has(item)) {
        serializedItems.set(item, { $: item.constructor.getId(), data: item.serialize() });
    }
    return serializedItems.get(item);
}

function encodeRuntime(value, previous) {
    if (value == null || typeof value !== "object") {
        return value;
    }
    if (typeof value.getItemType === "function") {
        if (!runtimeItems.has(value)) runtimeItems.set(value, { $item: encodeItem(value) });
        return runtimeItems.get(value);
    }
    if (value instanceof Map) {
        const entries = previous?.$map;
        let result = entries?.length === value.size ? entries : [];
        let i = 0;
        for (const [key, item] of value) {
            const prior = entries?.[i];
            const encoded = encodeRuntime(item, prior?.[1]);
            if (!prior || key !== prior[0] || encoded !== prior[1]) {
                if (result === entries) result = entries.slice();
                result[i] = [key, encoded];
            } else if (result !== entries) result[i] = prior;
            ++i;
        }
        return result === entries ? previous : { $map: result };
    }
    if (Array.isArray(value)) {
        const prior = Array.isArray(previous) ? previous : null;
        let result = prior?.length === value.length ? prior : [];
        for (let i = 0; i < value.length; ++i) {
            const encoded = encodeRuntime(value[i], prior?.[i]);
            if (!prior || encoded !== prior[i]) {
                if (result === prior) result = prior.slice();
                result[i] = encoded;
            } else if (result !== prior) result[i] = encoded;
        }
        return result;
    }
    const keys = Object.keys(value);
    const prior = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : null;
    let result = prior && keys.length === Object.keys(prior).length ? prior : {};
    for (const key of keys) {
        const encoded = encodeRuntime(value[key], prior?.[key]);
        if (!prior || !Object.hasOwn(prior, key) || encoded !== prior[key]) {
            if (result === prior) result = { ...prior };
            result[key] = encoded;
        } else if (result !== prior) result[key] = encoded;
    }
    // Equal key counts can hide a removed field and an added field. Detached
    // captures must carry exactly the current keys, including optional slots.
    if (result !== prior)
        for (const key of Object.keys(result)) if (!Object.hasOwn(value, key)) delete result[key];
    return result;
}

// Compare live queues to their detached capture before allocating replacements.
// Item singletons are immutable; their cached serialization is safe to share.
function matchesCapture(value, previous) {
    if (value === previous) return true;
    if (value == null || previous == null || typeof value !== "object" || typeof previous !== "object")
        return false;
    if (typeof value.getItemType === "function") return previous.$item === encodeItem(value);
    if (value instanceof Map) {
        const entries = previous.$map;
        if (!entries || entries.length !== value.size) return false;
        let i = 0;
        for (const [key, item] of value) {
            if (key !== entries[i][0] || !matchesCapture(item, entries[i][1])) return false;
            ++i;
        }
        return true;
    }
    if (Array.isArray(value)) {
        if (!Array.isArray(previous) || value.length !== previous.length) return false;
        for (let i = 0; i < value.length; ++i) if (!matchesCapture(value[i], previous[i])) return false;
        return true;
    }
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(previous).length) return false;
    for (const key of keys)
        if (!Object.hasOwn(previous, key) || !matchesCapture(value[key], previous[key])) return false;
    return true;
}

function captureItems(values, previous) {
    let result = previous?.length === values.length ? previous : [];
    for (let i = 0; i < values.length; ++i) {
        const item = encodeItem(values[i]);
        if (item !== previous?.[i]) {
            if (result === previous) result = previous.slice();
            result[i] = item;
        } else if (result !== previous) result[i] = item;
    }
    return result;
}

function captureComponent(id, component, previous) {
    if (id === "ItemProcessor")
        return previous?.nextOutputSlot === component.nextOutputSlot
            ? previous
            : { nextOutputSlot: component.nextOutputSlot };
    if (id === "Miner") {
        const lastMiningTime = Math.floor(component.lastMiningTime * 10000) / 10000;
        const itemChainBuffer = captureItems(component.itemChainBuffer, previous?.itemChainBuffer);
        if (previous?.lastMiningTime === lastMiningTime && itemChainBuffer === previous.itemChainBuffer)
            return previous;
        return { lastMiningTime, itemChainBuffer };
    }
    if (id === "UndergroundBelt") {
        const values = component.pendingItems;
        const prior = previous?.pendingItems;
        let pendingItems = prior?.length === values.length ? prior : [];
        for (let i = 0; i < values.length; ++i) {
            const item = encodeItem(values[i][0]);
            const time = Math.floor(values[i][1] * 10000) / 10000;
            if (item !== prior?.[i]?.[0] || time !== prior?.[i]?.[1]) {
                if (pendingItems === prior) pendingItems = prior.slice();
                pendingItems[i] = [item, time];
            } else if (pendingItems !== prior) pendingItems[i] = prior[i];
        }
        return pendingItems === prior ? previous : { pendingItems };
    }
    if (id !== "ItemEjector" && id !== "WiredPins") return component.serialize();
    // Match the core slot schemas without creating temporary structured objects
    // or reserializing singleton items for thousands of idle slots each frame.
    const key = id === "ItemEjector" ? "item" : "value";
    const slots = component.slots;
    let changed = !previous || previous.slots.length !== slots.length;
    for (let i = 0; !changed && i < slots.length; ++i) {
        const item = slots[i][key] ? encodeItem(slots[i][key]) : null;
        changed =
            !matchesCapture(item, previous.slots[i][key]) ||
            (id === "ItemEjector" &&
                Math.floor(slots[i].progress * 10000) / 10000 !== previous.slots[i].progress);
    }
    if (!changed) return previous;
    return {
        slots: slots.map(slot => ({
            [key]: slot[key] ? encodeItem(slot[key]) : null,
            ...(id === "ItemEjector" ? { progress: Math.floor(slot.progress * 10000) / 10000 } : {}),
        })),
    };
}

// Capture mutable components, not a savegame. Empty/static component schemas
// and belt geometry are cached until placement/configuration signals invalidate
// them. Every cached payload is detached; subsequent ticks cannot mutate it.
export class StateCapture {
    constructor(root) {
        this.root = root;
        this.entities = new Map();
        this.paths = new WeakMap();
        this.beltStates = new WeakMap();
        this.generation = 0;
        this.invalidated = new Set();
        this.structureDirty = true;
        this.invalidate = entity => {
            this.entities.delete(entity.uid);
            this.invalidated.add(entity.uid);
            this.structureDirty = true;
        };
        this.signals = [
            "entityAdded",
            "entityChanged",
            "entityGotNewComponent",
            "entityComponentRemoved",
            "entityDestroyed",
        ];
        for (const name of this.signals) root.signals[name].add(this.invalidate);
    }

    dispose() {
        for (const name of this.signals) this.root.signals[name].remove(this.invalidate);
    }

    capture() {
        const root = this.root;
        root.entityMgr.processDestroyList();
        const entities = [];
        const changed = [];
        const removed = [...this.invalidated].filter(uid => !root.entityMgr.entities.has(uid));
        this.invalidated.clear();
        for (const entity of root.entityMgr.entities.values()) {
            if (entity.destroyed || entity.queuedForDestroy) continue;
            let cached = this.entities.get(entity.uid);
            const previous = cached?.data;
            if (!cached || cached.entity !== entity) {
                const data = JSON.parse(JSON.stringify(entity.serialize()));
                data.runtime = {};
                cached = {
                    entity,
                    data,
                    dynamic: Object.entries(entity.components).flatMap(([id, component]) => {
                        const hasSchema = Object.keys(component.constructor.getSchema()).length > 0;
                        return id !== "StaticMapEntity" && (hasSchema || RUNTIME_FIELDS[id])
                            ? [[id, component, hasSchema]]
                            : [];
                    }),
                };
                this.entities.set(entity.uid, cached);
            }
            let data = cached.data;
            for (const [id, component, hasSchema] of cached.dynamic) {
                const fields = RUNTIME_FIELDS[id];
                const previousRuntime = data.runtime[id];
                let runtime = previousRuntime;
                if (fields)
                    for (const field of fields) {
                        const encoded = encodeRuntime(component[field], previousRuntime?.[field]);
                        if (!previousRuntime || encoded !== previousRuntime[field]) {
                            if (runtime === previousRuntime) runtime = { ...previousRuntime };
                            runtime[field] = encoded;
                        }
                    }
                const changedRuntime = runtime !== previousRuntime;
                // Core schemas serialize arrays/objects into fresh containers;
                // encodeRuntime also copies every mutable container. Reuse
                // these detached values instead of cloning through JSON again.
                const serialized = hasSchema ? captureComponent(id, component, data.components[id]) : null;
                const changedComponent = hasSchema && !matchesCapture(serialized, data.components[id]);
                if (!changedComponent && !changedRuntime) continue;
                if (data === cached.data)
                    data = { ...data, components: { ...data.components }, runtime: { ...data.runtime } };
                if (changedComponent) {
                    // Entity.serialize omits empty component schemas. Runtime
                    // supplements still apply to their constructor components.
                    if (Object.keys(serialized).length || Object.hasOwn(data.components, id))
                        data.components[id] = serialized;
                }
                if (changedRuntime) {
                    data.runtime[id] = runtime;
                }
            }
            cached.data = data;
            if (data !== previous) changed.push(data);
            if (data !== previous) capturedEntities.add(data);
            entities.push(data);
        }
        const beltPaths = root.systemMgr.systems.belt.beltPaths.map(path => {
            let layout = this.paths.get(path);
            if (!layout || this.structureDirty) {
                layout = path.entityPath.map(entity => entity.uid);
                this.paths.set(path, layout);
            }
            const previous = this.beltStates.get(path);
            let items = previous?.items.length === path.items.length ? previous.items : [];
            for (let i = 0; i < path.items.length; ++i) {
                const distance = Math.floor(path.items[i][0] * 10000) / 10000;
                const item = encodeItem(path.items[i][1]);
                const pair = previous?.items[i];
                if (pair && pair[0] === distance && pair[1] === item) {
                    if (items !== previous.items) items[i] = pair;
                } else {
                    if (items === previous?.items) items = items.slice();
                    items[i] = [distance, item];
                }
            }
            const spacingToFirstItem = Math.floor(path.spacingToFirstItem * 10000) / 10000;
            const data =
                previous &&
                previous.entityPath === layout &&
                previous.items === items &&
                previous.spacingToFirstItem === spacingToFirstItem
                    ? previous
                    : { entityPath: layout, items, spacingToFirstItem };
            this.beltStates.set(path, data);
            return data;
        });
        this.structureDirty = false;
        const snapshot = {
            entities,
            beltPaths,
            hubGoals: JSON.parse(JSON.stringify(root.hubGoals.serialize())),
            time: root.time.serialize(),
            analytics: {
                history: JSON.parse(JSON.stringify(root.productionAnalytics.history)),
                lastAnalyticsSlice: root.productionAnalytics.lastAnalyticsSlice,
            },
        };
        capturedSnapshots.add(snapshot);
        captureChanges.set(entities, { owner: this, generation: ++this.generation, changed, removed });
        return snapshot;
    }
}

// Protocol v4 encodes repeated items once per frame and run-length encodes equal
// belt spacings/items. This is lossless relative to the serializer payload;
// counts and distances are never inferred from client simulation.
export function packStateFrame(frame) {
    const items = [];
    const itemIds = new Map();
    const itemReferences = new WeakMap();
    function itemId(value) {
        if (value == null) return null;
        const existing = itemReferences.get(value);
        if (existing !== undefined) return existing;
        const key = fingerprint(value);
        if (!itemIds.has(key)) {
            itemIds.set(key, items.length);
            items.push(value);
        }
        const id = itemIds.get(key);
        itemReferences.set(value, id);
        return id;
    }
    function pack(value) {
        if (!value || typeof value !== "object") return value;
        if (typeof value.$ === "string" && Object.hasOwn(value, "data") && Object.keys(value).length === 2) {
            return { $i: itemId(value) };
        }
        if (Array.isArray(value)) return value.map(pack);
        return Object.fromEntries(Object.entries(value).map(([key, data]) => [key, pack(data)]));
    }
    const ejects = values =>
        values.map(value => [
            itemId(value.item.$item),
            value.requiredSlot ?? null,
            value.preferredSlot ?? null,
            (Object.hasOwn(value, "requiredSlot") ? 1 : 0) |
                (Object.hasOwn(value, "preferredSlot") ? 2 : 0) |
                (typeof value.doNotTrack === "boolean" ? 4 | (value.doNotTrack ? 8 : 0) : 0),
        ]);
    function packRuntime(id, value) {
        if (id === "ItemProcessor")
            return [
                value.inputSlots.$map.map(([slot, item]) => [slot, itemId(item.$item)]),
                value.inputCount,
                value.ongoingCharges.map(charge => [charge.remainingTime, ejects(charge.items)]),
                value.bonusTime,
                ejects(value.queuedEjects),
            ];
        if (id === "ItemAcceptor")
            return [
                value.itemConsumptionAnimations.map(animation => [
                    itemId(animation.item.$item),
                    animation.slotIndex,
                    animation.animProgress,
                    animation.direction,
                ]),
            ];
        if (id === "UndergroundBelt")
            return [
                value.consumptionAnimations.map(animation => [
                    itemId(animation.item.$item),
                    animation.progress,
                ]),
            ];
        return RUNTIME_FIELDS[id].map(field => pack(value[field]));
    }
    function packComponent(id, value) {
        switch (id) {
            case "ItemEjector":
                return value.slots.map(slot => [itemId(slot.item), slot.progress]);
            case "WiredPins":
                return value.slots.map(slot => itemId(slot.value));
            case "Miner":
                return [value.lastMiningTime, value.itemChainBuffer.map(itemId)];
            case "ItemProcessor":
                return value.nextOutputSlot;
            case "UndergroundBelt":
                return value.pendingItems.map(([item, time]) => [itemId(item), time]);
            case "Storage":
                return [value.storedCount, itemId(value.storedItem)];
            case "BeltReader":
                return itemId(value.lastItem);
            default:
                return pack(value);
        }
    }
    function runs(values) {
        const result = [];
        for (const [distance, item] of values) {
            const id = itemId(item);
            const last = result[result.length - 1];
            if (last && last[0] === distance && last[1] === id) ++last[2];
            else result.push([distance, id, 1]);
        }
        return result;
    }
    const { beltPaths, beltUpdates, patches, ...rest } = frame;
    const packed = pack(rest);
    if (patches)
        packed.p = patches.map(patch => [
            patch.uid,
            Object.entries(patch.components).map(([id, value]) => [id, packComponent(id, value)]),
            Object.entries(patch.runtime).map(([id, value]) => [id, packRuntime(id, value)]),
        ]);
    if (beltPaths)
        packed.bp = beltPaths.map(path => [path.entityPath, path.spacingToFirstItem, runs(path.items)]);
    if (beltUpdates)
        packed.bu = beltUpdates.map(path => [path.index, path.spacingToFirstItem, runs(path.items)]);
    packed.itemTable = items;
    return packed;
}

function stateUnpacker(itemTable) {
    function item(id) {
        if (id === null) return null;
        if (!Number.isSafeInteger(id) || !itemTable[id]) throw new Error("Unknown state item");
        return itemTable[id];
    }
    function unpack(value) {
        if (!value || typeof value !== "object") return value;
        if (Object.hasOwn(value, "$i")) {
            if (!itemTable[value.$i]) throw new Error("Unknown state item");
            return itemTable[value.$i];
        }
        if (Array.isArray(value)) return value.map(unpack);
        return Object.fromEntries(Object.entries(value).map(([key, data]) => [key, unpack(data)]));
    }
    const ejects = values =>
        values.map(([id, requiredSlot, preferredSlot, flags]) => ({
            item: { $item: item(id) },
            ...(flags & 1 ? { requiredSlot } : {}),
            ...(flags & 2 ? { preferredSlot } : {}),
            ...(flags & 4 ? { doNotTrack: !!(flags & 8) } : {}),
        }));
    function unpackRuntime(id, value) {
        if (id === "ItemProcessor")
            return {
                inputSlots: { $map: value[0].map(([slot, id]) => [slot, { $item: item(id) }]) },
                inputCount: value[1],
                ongoingCharges: value[2].map(([remainingTime, items]) => ({
                    remainingTime,
                    items: ejects(items),
                })),
                bonusTime: value[3],
                queuedEjects: ejects(value[4]),
            };
        if (id === "ItemAcceptor")
            return {
                itemConsumptionAnimations: value[0].map(([id, slotIndex, animProgress, direction]) => ({
                    item: { $item: item(id) },
                    slotIndex,
                    animProgress,
                    direction,
                })),
            };
        if (id === "UndergroundBelt")
            return {
                consumptionAnimations: value[0].map(([id, progress]) => ({
                    item: { $item: item(id) },
                    progress,
                })),
            };
        return Object.fromEntries(RUNTIME_FIELDS[id].map((field, i) => [field, unpack(value[i])]));
    }
    function unpackComponent(id, value) {
        switch (id) {
            case "ItemEjector":
                return { slots: value.map(([id, progress]) => ({ item: item(id), progress })) };
            case "WiredPins":
                return { slots: value.map(id => ({ value: item(id) })) };
            case "Miner":
                return { lastMiningTime: value[0], itemChainBuffer: value[1].map(item) };
            case "ItemProcessor":
                return { nextOutputSlot: value };
            case "UndergroundBelt":
                return { pendingItems: value.map(([id, time]) => [item(id), time]) };
            case "Storage":
                return { storedCount: value[0], storedItem: item(value[1]) };
            case "BeltReader":
                return { lastItem: item(value) };
            default:
                return unpack(value);
        }
    }
    function* expand(runs) {
        let length = 0;
        for (const [, id, count] of runs) {
            if (
                !itemTable[id] ||
                !Number.isSafeInteger(count) ||
                count < 1 ||
                count > 1000000 ||
                length + count > 1000000
            )
                throw new Error("Invalid belt item run");
            length += count;
        }
        const values = new Array(length);
        let offset = 0;
        let untilYield = 1024;
        for (const [distance, id, count] of runs) {
            for (let i = 0; i < count; ) {
                const end = i + Math.min(count - i, untilYield);
                untilYield -= end - i;
                for (; i < end; ++i) values[offset++] = [distance, itemTable[id]];
                if (untilYield === 0) {
                    yield;
                    untilYield = 1024;
                }
            }
        }
        return values;
    }
    const patch = ([uid, components, runtime]) => ({
        uid,
        components: Object.fromEntries(components.map(([id, value]) => [id, unpackComponent(id, value)])),
        runtime: Object.fromEntries(runtime.map(([id, value]) => [id, unpackRuntime(id, value)])),
    });
    return { unpack, patch, expand };
}

function* unpackStateFrameSteps(frame) {
    if (!frame.itemTable) return frame;
    const { itemTable, bp, bu, p, ...rest } = frame;
    const { unpack, patch, expand } = stateUnpacker(itemTable);
    const result = unpack(rest);
    if (p) {
        result.patches = new Array(p.length);
        for (let i = 0; i < p.length; ++i) {
            result.patches[i] = patch(p[i]);
            if ((i + 1) % 64 === 0) yield;
        }
    }
    if (bp) {
        result.beltPaths = new Array(bp.length);
        for (let i = 0; i < bp.length; ++i) {
            const [entityPath, spacingToFirstItem, runs] = bp[i];
            result.beltPaths[i] = { entityPath, spacingToFirstItem, items: yield* expand(runs) };
            if ((i + 1) % 4 === 0) yield;
        }
    }
    if (bu) {
        result.beltUpdates = new Array(bu.length);
        for (let i = 0; i < bu.length; ++i) {
            const [index, spacingToFirstItem, runs] = bu[i];
            result.beltUpdates[i] = { index, spacingToFirstItem, items: yield* expand(runs) };
            if ((i + 1) % 4 === 0) yield;
        }
    }
    return result;
}

export function unpackStateFrame(frame) {
    const steps = unpackStateFrameSteps(frame);
    for (;;) {
        const result = steps.next();
        if (result.done) return result.value;
    }
}

// Parsing compact production state must not monopolize the UI task. Yields
// publish nothing: the receive FIFO applies/acknowledges the complete result.
export async function unpackStateFrameAsync(
    frame,
    yieldToUI = () =>
        globalThis.scheduler?.postTask
            ? globalThis.scheduler.postTask(() => {})
            : new Promise(resolve => setTimeout(resolve, 0)),
    checkActive = () => {},
    budgetMs = 3
) {
    const steps = unpackStateFrameSteps(frame);
    let start = performance.now();
    let workMs = 0;
    for (;;) {
        checkActive();
        const result = steps.next();
        const now = performance.now();
        if (result.done) return { message: result.value, workMs: workMs + now - start };
        if (now - start >= budgetMs) {
            workMs += now - start;
            await yieldToUI();
            start = performance.now();
        }
    }
}

function decodeRuntime(value, root, exports, target) {
    if (value == null || typeof value !== "object") {
        return value;
    }
    if (value.$item) {
        return exports.itemResolverSingleton(root, value.$item);
    }
    if (value.$map) {
        const result = target instanceof Map ? target : new Map();
        result.clear();
        for (const [key, item] of value.$map) result.set(key, decodeRuntime(item, root, exports));
        return result;
    }
    if (Array.isArray(value)) {
        const result = Array.isArray(target) ? target : [];
        for (let i = 0; i < value.length; ++i) result[i] = decodeRuntime(value[i], root, exports, result[i]);
        result.length = value.length;
        return result;
    }
    const result = target && Object.getPrototypeOf(target) === Object.prototype ? target : {};
    for (const key in result) if (!Object.hasOwn(value, key)) delete result[key];
    for (const key in value)
        if (Object.hasOwn(value, key)) result[key] = decodeRuntime(value[key], root, exports, result[key]);
    return result;
}

export function captureSnapshot(root, exports, capturedState = null) {
    root.entityMgr.processDestroyList();
    if (capturedState) {
        // Welcome reuses the publication's exact state. Give serialization hooks
        // a detached copy so they cannot mutate the host's delta baseline.
        const detached = JSON.parse(JSON.stringify(capturedState));
        const snapshot = new exports.SavegameSerializer().generateDumpFromGameRoot(root, false, detached);
        snapshot.analytics = detached.analytics;
        for (const key of Object.keys(snapshot)) {
            if (snapshot[key] !== detached[key]) snapshot[key] = JSON.parse(JSON.stringify(snapshot[key]));
        }
        return snapshot;
    }
    const snapshot = new exports.SavegameSerializer().generateDumpFromGameRoot(root, false);
    for (const data of snapshot.entities) {
        const entity = root.entityMgr.findByUid(data.uid, false);
        data.runtime = {};
        for (const [id, fields] of Object.entries(RUNTIME_FIELDS)) {
            const component = entity.components[id];
            if (component) {
                data.runtime[id] = Object.fromEntries(
                    fields.map(field => [field, encodeRuntime(component[field])])
                );
            }
        }
    }
    snapshot.analytics = {
        history: JSON.parse(JSON.stringify(root.productionAnalytics.history)),
        lastAnalyticsSlice: root.productionAnalytics.lastAnalyticsSlice,
    };
    // Component serializers can return references (e.g. item times). Freeze the
    // baseline at the wire boundary, otherwise later ticks mutate the baseline.
    return JSON.parse(JSON.stringify(snapshot));
}

export function applyRuntime(entity, data, root, exports) {
    for (const id of Object.keys(data.runtime || {})) {
        const fields = RUNTIME_FIELDS[id];
        const component = entity.components[id];
        if (!fields || !component) continue;
        for (const field of fields) {
            component[field] = decodeRuntime(data.runtime[id][field], root, exports, component[field]);
        }
    }
}

export function restoreAnalytics(root, analytics) {
    if (analytics) {
        root.productionAnalytics.history = JSON.parse(JSON.stringify(analytics.history));
        root.productionAnalytics.lastAnalyticsSlice = analytics.lastAnalyticsSlice;
    }
}

function restoreHub(root, data) {
    const hub = root.hubGoals;
    // Counts change every delivery; goal generation and upgrade definitions only
    // need rebuilding when progression changes. Compare the actual client state
    // so an optimistic upgrade is still rolled back when rejected by the host.
    const levels = Object.keys(data.upgradeLevels);
    if (
        hub.level === data.level &&
        levels.length === Object.keys(hub.upgradeLevels).length &&
        levels.every(id => hub.upgradeLevels[id] === data.upgradeLevels[id]) &&
        hub.gainedRewards.size === data.gainedRewards.length &&
        data.gainedRewards.every(reward => hub.gainedRewards.has(reward))
    ) {
        return hub.constructor
            .getCachedSchema()
            .storedShapes.deserializeWithVerify(data.storedShapes, hub, "storedShapes", root);
    }
    return hub.deserialize(data, root);
}

function restoreBeltItems(path, data, root, exports) {
    if (!Number.isFinite(data.spacingToFirstItem) || data.spacingToFirstItem < 0)
        throw new Error("Invalid belt spacing");
    path.spacingToFirstItem = data.spacingToFirstItem;
    for (let i = 0; i < data.items.length; ++i) {
        const [distance, item] = data.items[i];
        if (!Number.isFinite(distance) || distance < 0) throw new Error("Invalid belt item distance");
        const pair = path.items[i] || (path.items[i] = []);
        pair[0] = distance;
        pair[1] = exports.itemResolverSingleton(root, item);
    }
    path.items.length = data.items.length;
    path.numCompressedItemsAfterFirstItem = 0;
}

function restoreComponents(entity, data, internal, root, exports) {
    // Slot geometry comes from the validated welcome/building, not live frames.
    // These hot schemas contain just items and numeric state; restore directly
    // instead of recursively verifying/rebuilding every unchanged slot field.
    for (const id of Object.keys(data)) {
        const value = data[id];
        const component = entity.components[id];
        if (id === "ItemEjector" || id === "WiredPins") {
            if (value.slots.length !== component.slots.length)
                throw new Error("Invalid replicated slot count");
            for (let i = 0; i < value.slots.length; ++i) {
                const slot = value.slots[i];
                if (id === "ItemEjector") {
                    component.slots[i].item = slot.item
                        ? exports.itemResolverSingleton(root, slot.item)
                        : null;
                    component.slots[i].progress = slot.progress;
                } else
                    component.slots[i].value = slot.value
                        ? exports.itemResolverSingleton(root, slot.value)
                        : null;
            }
        } else if (component) {
            const error = component.deserialize(value, root);
            if (error) return error;
        } else {
            // Keep the serializer's missing-component diagnostics for modded
            // entities while avoiding temporary dictionaries in the hot path.
            const error = internal.deserializeComponents(root, entity, { [id]: value });
            if (error) return error;
        }
    }
}

// Apply the canonical map without placement heuristics seeing half a map.
// Preserve entities with unchanged geometry (selection/dialog references).
export function reconcileWorld(root, baseline, frame, exports, forceFull = false) {
    // Each frame's item table shares serialized objects across slots and queues.
    // Resolve each definition once, while keeping caches scoped to this apply
    // (a reconnect can replace managers or the resolver supplied by another mod).
    const items = new WeakMap();
    const resolve = exports.itemResolverSingleton;
    // ModLoader exposes non-enumerable, getter-only exports. Spreading that
    // namespace drops the serializer constructors in the actual game.
    exports = Object.create(exports, {
        itemResolverSingleton: {
            value(root, data) {
                if (!items.has(data)) items.set(data, resolve(root, data));
                return items.get(data);
            },
        },
    });
    const forcedUids = forceFull instanceof Set ? forceFull : null;
    const rollbackBelts = forceFull === true || !!forcedUids?.size;
    forceFull = forceFull === true;
    forceFull ||= !frame.entities;
    const initialized = root.gameInitialized;
    const internal = new exports.SerializerInternal();
    let structuralChange = false;
    let wireStructureChanged = forceFull;
    let recheckBeltCaches = forceFull || rollbackBelts || !!frame.beltTopologyChanged;
    const dirtyChunks = new Set();
    const affectedEntities = new Set();
    const affectedAreas = [];
    const invalidateGeometry = entity => {
        structuralChange = true;
        wireStructureChanged ||= !!root.systemMgr.systems.wire.isEntityRelevantForWires(entity);
        recheckBeltCaches ||= !!entity.components.Belt;
        affectedAreas.push(entity.components.StaticMapEntity.getTileSpaceBounds().expandedInAllDirections(1));
    };
    root.gameInitialized = false;
    try {
        root.entityMgr.processDestroyList();
        // Normally touch only changed entities. A local prediction also restores
        // its touched UIDs, including entries absent from the current delta.
        const patches = new Map((frame.patches || []).map(patch => [patch.uid, patch]));
        const changedUids = new Set([
            ...(frame.removed || []),
            ...(frame.entities || []).map(data => data.uid),
            ...patches.keys(),
            ...(forcedUids || []),
        ]);
        const candidates = forceFull
            ? [...root.entityMgr.entities.values()]
            : [...changedUids].map(uid => root.entityMgr.findByUid(uid, false)).filter(Boolean);
        for (const entity of candidates) {
            const data = baseline.entities.get(entity.uid);
            if (
                !data ||
                (!(patches.has(entity.uid) && !forceFull && !forcedUids?.has(entity.uid)) &&
                    JSON.stringify(entity.components.StaticMapEntity.serialize()) !==
                        JSON.stringify(data.components.StaticMapEntity))
            ) {
                invalidateGeometry(entity);
                root.map.removeStaticEntity(entity);
                root.hud.parts.massSelector?.selectedUids?.delete(entity.uid);
                root.entityMgr.destroyEntity(entity);
            }
        }
        root.entityMgr.processDestroyList();
        const changedData = forceFull
            ? baseline.entities.values()
            : [...changedUids].map(uid => baseline.entities.get(uid)).filter(Boolean);
        for (const data of changedData) {
            let entity = root.entityMgr.findByUid(data.uid, false);
            if (!entity) {
                entity = internal.deserializeEntity(root, data);
                invalidateGeometry(entity);
            } else {
                const patch = !forceFull && !forcedUids?.has(data.uid) && patches.get(data.uid);
                const error = restoreComponents(
                    entity,
                    patch ? patch.components : data.components,
                    internal,
                    root,
                    exports
                );
                if (error) {
                    throw new Error(error);
                }
            }
            applyRuntime(
                entity,
                (!forceFull && !forcedUids?.has(data.uid) && patches.get(data.uid)) || data,
                root,
                exports
            );
            root.entityMgr.nextUid = Math.max(root.entityMgr.nextUid, data.uid + 1);
        }
        const error = restoreHub(root, frame.hub);
        if (error) {
            throw new Error(error);
        }
        root.time.timeSeconds = frame.time.timeSeconds;
        root.time.logicTimeBudget = 0;
        restoreAnalytics(root, frame.analytics);

        const belt = root.systemMgr.systems.belt;
        const samePaths =
            !structuralChange &&
            !forceFull &&
            !rollbackBelts &&
            belt.beltPaths.length === frame.beltPaths.length &&
            (!!frame.beltUpdates ||
                belt.beltPaths.every(
                    (path, i) =>
                        path.entityPath.length === frame.beltPaths[i].entityPath.length &&
                        path.entityPath.every((entity, j) => entity.uid === frame.beltPaths[i].entityPath[j])
                ));
        if (samePaths) {
            const updates = frame.beltUpdates || frame.beltPaths.map((data, index) => ({ ...data, index }));
            for (const update of updates) {
                const i = update.index;
                restoreBeltItems(belt.beltPaths[i], update, root, exports);
            }
        } else {
            const previousPaths = new Set(belt.beltPaths);
            const error = belt.reconcilePathLayouts(frame.beltPaths);
            if (error) {
                throw new Error(error);
            }
            for (let i = 0; i < frame.beltPaths.length; ++i)
                restoreBeltItems(belt.beltPaths[i], frame.beltPaths[i], root, exports);
            recheckBeltCaches ||=
                previousPaths.size !== belt.beltPaths.length ||
                belt.beltPaths.some(path => !previousPaths.has(path));
        }

        // Geometry changes invalidate nearby targets and render chunks, rather
        // than every machine and cached chunk in the factory. Separate areas
        // avoid scanning the empty rectangle between distant simultaneous edits.
        for (const area of affectedAreas) {
            for (let x = area.x; x < area.right(); ++x) {
                for (let y = area.y; y < area.bottom(); ++y) {
                    const chunk = root.map.getChunkAtTileOrNull(x, y);
                    if (chunk) dirtyChunks.add(chunk);
                    for (const entity of root.map.getLayersContentsMultipleXY(x, y))
                        affectedEntities.add(entity);
                }
            }
        }
        if (structuralChange) {
            const affectedPaths = new Set();
            for (const entity of affectedEntities) {
                const path = entity.components.Belt?.assignedPath;
                if (path) affectedPaths.add(path);
            }
            for (const path of affectedPaths) path.onSurroundingsChanged();
        }
    } finally {
        root.gameInitialized = initialized;
    }
    refreshReplicaCaches(root, wireStructureChanged, recheckBeltCaches, { dirtyChunks, affectedEntities });
}

export function refreshReplicaCaches(
    root,
    structuralChange = true,
    beltTopologyChanged = true,
    scope = null
) {
    const systems = root.systemMgr.systems;
    // WireSystem.update only aggregates already-replicated pin values. Prevent
    // its placement heuristics from rotating the authoritative wire geometry.
    systems.wire.staleArea.staleArea = null;
    if (structuralChange) {
        systems.wire.isFirstRecompute = false;
        systems.wire.recomputeWiresNetwork();
    }
    for (const chunk of scope ? scope.dirtyChunks : root.map.chunksById.values()) chunk.markDirty();
    systems.wire.update();
    // Belt path restoration replaces objects; ejectors must target the new ones.
    if (beltTopologyChanged || scope?.affectedEntities.size) {
        const livePaths = beltTopologyChanged && scope ? new Set(systems.belt.beltPaths) : null;
        const candidates =
            scope && !beltTopologyChanged ? scope.affectedEntities : systems.itemEjector.allEntities;
        for (const entity of candidates) {
            if (!entity.components.ItemEjector) continue;
            if (
                !scope ||
                scope.affectedEntities.has(entity) ||
                (livePaths &&
                    entity.components.ItemEjector.slots.some(
                        slot => slot.cachedBeltPath && !livePaths.has(slot.cachedBeltPath)
                    ))
            )
                systems.itemEjector.recomputeSingleEntityCache(entity);
        }
    }
    root.queue.requireRedraw = true;
}

export function applyCommands(root, ops, exports, slot = null) {
    const internal = new exports.SerializerInternal();
    let placed = false;
    for (const op of ops) {
        if (op.k === "blueprint") {
            if (!Array.isArray(op.ops) || op.ops.some(child => !["place", "delete"].includes(child.k))) {
                throw new Error("Invalid blueprint transaction");
            }
            if (
                op.cost &&
                (!Number.isSafeInteger(op.cost.amount) ||
                    op.cost.amount < 0 ||
                    op.cost.key !== root.gameMode.getBlueprintShapeKey() ||
                    root.hubGoals.getShapesStoredByKey(op.cost.key) < op.cost.amount)
            ) {
                continue;
            }
            let blueprintPlaced = false;
            root.logic.performImmutableOperation(() => {
                blueprintPlaced = applyCommands(root, op.ops, exports, slot);
            });
            if (blueprintPlaced && op.cost) {
                root.hubGoals.takeShapeByKey(op.cost.key, op.cost.amount);
            }
            placed ||= blueprintPlaced;
            continue;
        }
        if (op.k === "place") {
            if (
                !op.entity ||
                op.entity.uid !== op.uid ||
                !Number.isSafeInteger(op.uid) ||
                op.uid < 10000 ||
                (slot !== null && op.uid % 8 !== slot)
            ) {
                throw new Error("Invalid placement UID");
            }
            if (root.entityMgr.entities.has(op.uid)) {
                continue;
            }
            const entity = internal.createEntityFromSerialized(root, op.entity);
            if (!root.logic.checkCanPlaceEntity(entity, {})) {
                continue;
            }
            root.logic.freeEntityAreaBeforeBuild(entity);
            root.map.placeStaticEntity(entity);
            root.entityMgr.registerEntity(entity, op.uid);
            root.entityMgr.nextUid = Math.max(root.entityMgr.nextUid, op.uid + 1);
            placed = true;
        } else if (op.k === "delete") {
            const entity = root.entityMgr.findByUid(op.uid, false);
            if (entity) {
                root.logic.tryDeleteBuilding(entity);
            }
        } else if (op.k === "configure") {
            const entity = root.entityMgr.findByUid(op.uid, false);
            if (
                entity &&
                ["Lever", "ConstantSignal"].includes(op.component) &&
                entity.components[op.component]
            ) {
                const error = entity.components[op.component].deserialize(op.data, root);
                if (error) {
                    throw new Error(error);
                }
                root.signals.entityChanged.dispatch(entity);
            }
        } else if (op.k === "upgrade") {
            if (Object.hasOwn(root.gameMode.getUpgrades(), op.upgradeId)) {
                root.hubGoals.tryUnlockUpgrade(op.upgradeId);
            }
        }
    }
    return placed;
}
