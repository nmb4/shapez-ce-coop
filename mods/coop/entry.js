// shapez CE co-op: one host simulation, acknowledged client edit previews,
// incremental authoritative state frames. See PROTOCOL.md.

import {
    STATE_INTERVAL_MS,
    StateBaseline,
    StateCapture,
    applyCommands,
    applyRuntime,
    captureSnapshot,
    reconcileWorld,
    refreshReplicaCaches,
    restoreAnalytics,
    packStateFrame,
} from "./replication.js";
import { encodeWireMessage } from "./transport.js";
import { WireDecoder } from "./decoder.js";

const ModBase = window.shapez.Mod;

const COOP_TICKRATE = 60;
const COOP_VERSION = 4;
const COOP_DEFAULT_PORT = 47821;
const SYNC_CHECK_MS = 15000;
const PING_MS = 10000;
const PEER_EXPIRE_MS = 30000;
const RESYNC_COOLDOWN_MS = 60000;
// UID allocation stride. Residue 0 = host, 1..7 = client slots (8 players
// max, matching the relay peer cap). See sendWelcome slot assignment.
const SLOT_STEP = 8;
const MAX_CLIENT_SLOTS = 7;
// Inbound sanity caps (malicious/buggy peers, giant area deletes).
const MAX_OPS_PER_MESSAGE = 5000;
// Remote cursor broadcast: 10 Hz while in a session, peers expire them fast.
const CURSOR_MS = 100;
const CURSOR_EXPIRE_MS = 2500;
const SNAPSHOT_TIMEOUT_MS = 15000;
// Persisted player identity (shared by Host + Join so the name only has to
// be typed once). localStorage survives reloads and new savegames.
const COOP_NAME_KEY = "shapez-coop:playerName";
const COOP_ADDR_KEY = "shapez-coop:lastJoinAddress";

function loadStoredCoopValue(key) {
    try {
        if (typeof localStorage === "undefined") {
            return "";
        }
        return (localStorage.getItem(key) || "").trim();
    } catch {
        return "";
    }
}

function saveStoredCoopValue(key, value) {
    try {
        if (typeof localStorage === "undefined") {
            return;
        }
        const clean = String(value || "").trim();
        if (clean) {
            localStorage.setItem(key, clean);
        } else {
            localStorage.removeItem(key);
        }
    } catch {
        // Storage unavailable (private mode, etc.): session still works
    }
}

function loadStoredCoopName() {
    return loadStoredCoopValue(COOP_NAME_KEY);
}

let activeMod = null;

function formatLogArgs(args) {
    return Array.from(args)
        .map(arg => {
            if (typeof arg === "string") {
                return arg;
            }
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        })
        .join(" ");
}

/** Best-effort file sink: the main process appends to <userData>/coop.log.
 *  Never throws, never blocks; logging must not break the game. */
function shipLogToFile(level, text) {
    try {
        if (typeof ipcRenderer !== "undefined" && ipcRenderer.invoke) {
            const pending = ipcRenderer.invoke("coop-log", level, text);
            if (pending && pending.catch) {
                pending.catch(() => {});
            }
        }
    } catch {
        // Ignore: console output remains
    }
}

function log(...args) {
    const line = "[coop] " + formatLogArgs(args);
    console.log(line);
    shipLogToFile("info", line);
}
function warn(...args) {
    const line = "[coop] " + formatLogArgs(args);
    console.warn(line);
    shipLogToFile("warn", line);
}

/** Compact "belt 120→119" style diff of two "code:count,..." strings. */
function summarizeCodeDiff(ownCodes, peerCodes) {
    const parse = text => {
        const map = new Map();
        for (const part of String(text || "").split(",")) {
            const [code, count] = part.split(":");
            if (code) {
                map.set(code, Number(count) | 0);
            }
        }
        return map;
    };
    const own = parse(ownCodes);
    const peer = parse(peerCodes);
    const diffs = [];
    for (const code of new Set([...own.keys(), ...peer.keys()])) {
        const delta = (peer.get(code) || 0) - (own.get(code) || 0);
        if (delta !== 0) {
            diffs.push({ code, delta });
        }
    }
    diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (diffs.length === 0) {
        return "no count diff";
    }
    return diffs
        .slice(0, 3)
        .map(d => d.code + " " + (d.delta > 0 ? "+" : "") + d.delta)
        .join(", ");
}

/** Resolves a global export published by ModLoader.exposeExports. */
function shapez(name) {
    const value = window.shapez[name];
    if (!value) {
        throw new Error("[coop] Missing shapez export: " + name);
    }
    return value;
}

function fnv1aHex(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; ++i) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return ("0000000" + (hash >>> 0).toString(16)).slice(-8);
}

/**
 * Structural checksum of the shared sim state. Excludes wall-clock time,
 * cameras, in-flight belt items and stored-shape counters (those converge
 * via hub-state on their own beat and must not count as drift). Includes
 * per-entity identity tuples so moves, rotations, variant swaps and
 * same-UID collisions are detected.
 */
function computeSyncSummary(root) {
    const upgradeParts = [];
    const upgrades = root.hubGoals.upgradeLevels || {};
    for (const id of Object.keys(upgrades).sort()) {
        upgradeParts.push(id + ":" + upgrades[id]);
    }
    const entityParts = [];
    for (const [uid, entity] of root.entityMgr.entities) {
        try {
            const staticComp = entity.components.StaticMapEntity;
            entityParts.push(
                uid +
                    ":" +
                    staticComp.code +
                    ":" +
                    staticComp.rotation +
                    ":" +
                    staticComp.origin.x +
                    "," +
                    staticComp.origin.y
            );
        } catch {
            entityParts.push(uid + ":?");
        }
    }
    entityParts.sort();
    const codeCounts = {};
    for (const entity of root.entityMgr.entities.values()) {
        try {
            const code = String(entity.components.StaticMapEntity.code);
            codeCounts[code] = (codeCounts[code] || 0) + 1;
        } catch {
            // Counted in the tuple fallback already
        }
    }
    const codeParts = Object.keys(codeCounts)
        .sort()
        .map(code => code + ":" + codeCounts[code]);
    const summary = {
        seed: root.map.seed,
        n: entityParts.length,
        level: root.hubGoals.level,
        upgrades: upgradeParts.join(","),
        entities: entityParts.join(";"),
    };
    return { hash: fnv1aHex(JSON.stringify(summary)), codes: codeParts.join(",") };
}

/** Normalize status.addresses (string[] from old builds or {name,address}[]). */
function normalizeInviteEntries(addresses) {
    const out = [];
    for (const entry of addresses || []) {
        if (typeof entry === "string") {
            out.push({ name: "", address: entry });
        } else if (entry && typeof entry.address === "string") {
            out.push({ name: entry.name || "", address: entry.address });
        }
    }
    return out;
}

/**
 * Build one invite per interface, virtual adapters (Docker/WSL/Hyper-V…)
 * sorted last since they rarely reach the friend's machine.
 */
function buildInvites(addresses, port) {
    const virtualRe = /vethernet|virtualbox|vbox|docker|wsl|hyper-v|vmware|teredo|bluetooth|isatap|6to4/i;
    const entries = normalizeInviteEntries(addresses).map(e => ({
        label: e.name ? e.name + " — " + e.address : e.address,
        url: "shapez://" + e.address + ":" + port,
        virtual: virtualRe.test(e.name || ""),
    }));
    entries.sort((a, b) => Number(a.virtual) - Number(b.virtual));
    return entries;
}

/** True when the root has a live, initialized game (menu/teardown roots fail this). */
function rootReadyForNet(root) {
    return !!(
        root &&
        root.entityMgr &&
        root.logic &&
        root.map &&
        root.hubGoals &&
        root.systemMgr &&
        root.hud
    );
}

// Message types that mutate or read live game state; anything else
// (hello/bye/chat/ping/cursor) is safe without a game.
const ROOTED_MESSAGE_TYPES = new Set([
    "state",
    "welcome",
    "ops",
    "hub-upgrade",
    "hub-state",
    "deliver-batch",
    "sync-check",
    "resync-request",
]);

/** Stable per-peer cursor color derived from the client id. */
function peerColor(clientId) {
    let h = 0;
    for (let i = 0; i < clientId.length; ++i) {
        h = (Math.imul(h, 31) + clientId.charCodeAt(i)) | 0;
    }
    return "hsl(" + ((h >>> 0) % 360) + ", 85%, 62%)";
}

/** Accepts shapez://ip:port, ws(s)://, http(s)://, bare host or host:port. */
function parseJoinInput(input) {
    const validateWsUrl = url => {
        // Reject out-of-range ports explicitly: WHATWG URL parsing does not
        // reliably throw for them, but the WebSocket constructor does (which
        // previously surfaced as an unhandled rejection).
        const portMatch = url.match(/:(\d+)(?:\/[^]*)?$/);
        if (portMatch) {
            const port = Number(portMatch[1]);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                return null;
            }
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
                return null;
            }
            if (!parsed.hostname) {
                return null;
            }
        } catch {
            return null;
        }
        return url;
    };
    if (!input) {
        return null;
    }
    const text = String(input).trim();
    if (!text) {
        return null;
    }
    const schemeMatch = text.match(/^([a-z]+):\/\/(.*)$/i);
    let rest = text;
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        rest = schemeMatch[2];
        if (scheme === "http") {
            return validateWsUrl("ws://" + rest);
        }
        if (scheme === "https") {
            return validateWsUrl("wss://" + rest);
        }
        if (scheme === "ws" || scheme === "wss" || scheme === "shapez") {
            return validateWsUrl((scheme === "shapez" ? "ws://" : scheme + "://") + rest);
        }
        return null;
    }
    // Bare host[:port]
    if (/^[A-Za-z0-9.[\]:-]+(:\d+)?$/.test(rest)) {
        if (!/:\d+$/.test(rest) || rest.endsWith("]")) {
            rest += ":" + COOP_DEFAULT_PORT;
        }
        return validateWsUrl("ws://" + rest);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Network client (renderer side, native WebSocket only)
// ---------------------------------------------------------------------------

class CoopNet {
    constructor(mod) {
        this.mod = mod;
        this.socket = null;
        this.url = null;
        this.clientId = "c" + Math.random().toString(36).slice(2, 10);
        this.name = loadStoredCoopName() || "Player";
        this.isHost = false;
        this.connected = false;
        this.onMessage = null;
        this.onOpen = null;
        this.onClose = null;
        this.resetTransportStats();
    }

    resetTransportStats() {
        this.sendStats = { pending: 0, queuedBytes: 0, welcomes: new Set(), stateBytes: 0, stateCount: 0 };
    }

    transportBusy() {
        return (this.socket?.bufferedAmount || 0) + this.sendStats.queuedBytes > 512 * 1024;
    }

    connect(url) {
        this.disconnect();
        let socket;
        try {
            socket = new WebSocket(url);
        } catch (ex) {
            // Invalid URL (e.g. out-of-range port): never let this escape as
            // an unhandled rejection. Caller shows "invalid join code".
            warn("invalid server URL", url);
            this.url = null;
            this.socket = null;
            this.connected = false;
            return false;
        }
        this.url = url;
        log("connecting to", url);
        this.socket = socket;
        this.resetTransportStats();
        this.sendChain = Promise.resolve();
        const decoder = (this.decoder = new WireDecoder({
            onFallback: reason => warn("background decoder unavailable, using inline decoding", reason),
        }));
        let receiveChain = Promise.resolve();
        socket.onopen = () => {
            if (this.socket !== socket) {
                return; // Stale event from a previous connection
            }
            this.connected = true;
            log("connected as", this.clientId);
            this.send({
                t: "hello",
                v: COOP_VERSION,
                from: this.clientId,
                name: this.name,
                mv: (this.mod.metadata && this.mod.metadata.version) || null,
            });
            if (this.onOpen) {
                this.onOpen();
            }
        };
        socket.onmessage = event => {
            const receivedAt = performance.now();
            receiveChain = receiveChain
                .then(async () => {
                    if (this.socket !== socket) {
                        return;
                    }
                    let message;
                    try {
                        const start = performance.now();
                        const decoded = await decoder.decode(event.data, () => this.mod.awaitingWelcome);
                        message = decoded.message;
                        if (this.socket !== socket) return;
                        if (message.t === "state") {
                            if (this.mod.awaitingWelcome) return;
                            message.decodeMs = performance.now() - start;
                            message.wireDecodeMs = decoded.wireDecodeMs;
                            message.parseMs = decoded.parseMs;
                            message.unpackMs = decoded.unpackMs;
                            message.unpackWorkMs = decoded.unpackWorkMs;
                            message.receiveQueueMs = start - receivedAt;
                            message.decodeMode = decoded.mode;
                            message.wireBytes = event.data.length;
                        }
                    } catch (ex) {
                        if (this.socket !== socket) return;
                        warn("dropping invalid message", ex);
                        if (!this.mod.session?.isHost) this.mod.requestResync();
                        return;
                    }
                    if (message.from === this.clientId) {
                        return; // Relay echoes our own messages back to us
                    }
                    if (this.onMessage) {
                        this.onMessage(message);
                    }
                })
                .catch(ex => {
                    warn("message handling failed", ex);
                    if (this.socket === socket) this.mod.requestResync();
                });
        };
        socket.onclose = () => {
            if (this.socket !== socket) {
                return; // Stale close; a newer connection is active
            }
            this.connected = false;
            this.socket = null;
            decoder.dispose();
            log("disconnected");
            if (this.onClose) {
                this.onClose();
            }
        };
        socket.onerror = () => {
            // onclose follows; surface it through the hud status
            warn("socket error");
        };
        return true;
    }

    disconnect() {
        this.decoder?.dispose();
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            this.connected = false;
            try {
                socket.close();
            } catch {
                // Ignore
            }
        }
    }

    send(message) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        if (this.transportBusy() && message.t === "state") {
            return false; // Retain the baseline and retry after the transport drains.
        }
        const stats = this.sendStats;
        if (message.t === "welcome" && stats.welcomes.has(message.to)) return false;
        message.from = this.clientId;
        message.v = COOP_VERSION;
        try {
            const wire = JSON.stringify(message.t === "state" ? packStateFrame(message) : message);
            if (message.t === "bye") {
                // leaveGame closes immediately after this call; flush departure
                // before canceling queued compression from the old connection.
                this.socket.send(wire);
                return true;
            }
            const socket = this.socket;
            ++stats.pending;
            stats.queuedBytes += wire.length;
            if (message.t === "welcome") stats.welcomes.add(message.to);
            this.sendChain = (this.sendChain || Promise.resolve())
                .then(async () => {
                    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
                    const started = performance.now();
                    const encoded =
                        message.t === "state" || message.t === "welcome"
                            ? await encodeWireMessage(wire)
                            : wire;
                    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
                    this.lastWireBytes = encoded.length;
                    socket.send(encoded);
                    if (message.t === "state") {
                        stats.stateBytes += encoded.length;
                        ++stats.stateCount;
                        stats.lastStateMs = performance.now() - started;
                    } else if (message.t === "welcome") stats.lastWelcomeBytes = encoded.length;
                })
                .catch(ex => {
                    warn("send failed", ex);
                    if (this.socket === socket) socket.close();
                })
                .finally(() => {
                    --stats.pending;
                    stats.queuedBytes -= wire.length;
                    if (message.t === "welcome") stats.welcomes.delete(message.to);
                });
            return true;
        } catch (ex) {
            warn("send failed", ex);
            return false;
        }
    }
}

// ---------------------------------------------------------------------------
// HUD panel
// ---------------------------------------------------------------------------

export class CoopHudPart extends shapez("BaseHUDPart") {
    createElements(parent) {
        const makeDiv = window.shapez.makeDiv;
        this.element = makeDiv(
            parent,
            "ingame_HUD_Coop",
            ["coopPanel"],
            `
            <div class="coopHead">
                <div class="coopTitle" title="Click to collapse (F8 hides the panel)">
                    <span class="coopDot"></span>Co-op <span class="coopStatus">offline</span><span class="coopVersion"></span>
                </div>
                <span class="coopHide" title="Hide panel (F8 to show)">×</span>
            </div>
            <div class="coopBody">
                <div class="coopRow"><input class="coopName" placeholder="Name" maxlength="24" /></div>
                <div class="coopRow">
                    <button class="coopHost primary">Host</button>
                    <button class="coopResync" title="Host: push full state to everyone">Resync</button>
                    <button class="coopLeave">Leave</button>
                    <button class="coopHideBtn" title="Hide panel (F8 to show)">Hide</button>
                </div>
                <div class="coopInviteRow">
                    <select class="coopInviteSel"></select>
                    <div class="coopRow">
                        <input class="coopInvite" readonly title="Share this address" />
                        <button class="coopCopy">Copy</button>
                    </div>
                </div>
                <div class="coopRow"><input class="coopAddr" placeholder="join code or host address" /></div>
                <div class="coopRow">
                    <button class="coopJoin good">Join</button>
                    <button class="coopAskResync" title="Ask host for a full state">Req sync</button>
                </div>
                <div class="coopSync">sync: -</div>
                <div class="coopPeers">peers: -</div>
                <div class="coopChat"></div>
                <div class="coopRow"><input class="coopChatIn" placeholder="Chat…" maxlength="200" /></div>
            </div>`
        );

        // Compact reopen pill, shown only while the panel is hidden
        this.pill = makeDiv(
            parent,
            "ingame_HUD_Coop_Pill",
            ["coopPill"],
            `<span class="coopPillDot"></span>Co-op`
        );
        this.pill.style.display = "none";

        const query = selector => this.element.querySelector(selector);
        this.statusEl = query(".coopStatus");
        this.dotEl = query(".coopDot");
        this.bodyEl = query(".coopBody");
        this.peersEl = query(".coopPeers");
        this.syncEl = query(".coopSync");
        this.chatEl = query(".coopChat");
        this.inviteRow = query(".coopInviteRow");
        this.inviteInput = query(".coopInvite");
        this.inviteSelect = query(".coopInviteSel");
        this.hostButton = query(".coopHost");
        this.joinButton = query(".coopJoin");
        this.nameInput = query(".coopName");
        this.addrInput = query(".coopAddr");
        const versionEl = query(".coopVersion");
        if (versionEl && activeMod && activeMod.metadata && activeMod.metadata.version) {
            versionEl.textContent = " v" + activeMod.metadata.version;
        }
        // Remember the name (and last join address) across games/reloads:
        // one shared name field feeds both Host and Join.
        if (this.nameInput) {
            const storedName = loadStoredCoopName();
            const netName = activeMod && activeMod.net ? activeMod.net.name : "";
            this.nameInput.value = storedName || (netName && netName !== "Player" ? netName : "");
            this.nameInput.addEventListener("input", event => {
                const clean = String(event.target.value || "")
                    .trim()
                    .slice(0, 24);
                saveStoredCoopValue(COOP_NAME_KEY, clean);
                if (activeMod && activeMod.net && clean) {
                    activeMod.net.name = clean;
                    const self = activeMod.peers && activeMod.peers.get(activeMod.net.clientId);
                    if (self) {
                        self.name = clean;
                        activeMod.renderPeers();
                    }
                }
            });
        }
        if (this.addrInput) {
            this.addrInput.value = loadStoredCoopValue(COOP_ADDR_KEY) || "";
            this.addrInput.addEventListener("input", event => {
                saveStoredCoopValue(COOP_ADDR_KEY, event.target.value || "");
            });
        }

        // Plain native clicks for the pure UI toggles: no sounds, no game
        // click machinery, nothing to swallow them.
        query(".coopTitle").addEventListener("click", () => {
            if (activeMod) {
                activeMod.setPanelMode(activeMod.panelMode === "collapsed" ? "open" : "collapsed");
            }
        });
        query(".coopHide").addEventListener("click", event => {
            event.stopPropagation();
            if (activeMod) {
                activeMod.setPanelMode("hidden");
            }
        });
        query(".coopHideBtn").addEventListener("click", () => {
            if (activeMod) {
                activeMod.setPanelMode("hidden");
            }
        });
        this.pill.addEventListener("click", () => {
            if (activeMod) {
                activeMod.setPanelMode("open");
            }
        });
        this.trackClicks(
            this.hostButton,
            () => activeMod && activeMod.hostGame(this.nameInput && this.nameInput.value)
        );
        this.trackClicks(
            this.joinButton,
            () =>
                activeMod &&
                activeMod.joinGame(
                    this.addrInput && this.addrInput.value,
                    this.nameInput && this.nameInput.value
                )
        );
        this.trackClicks(query(".coopLeave"), () => activeMod && activeMod.leaveGame());
        this.trackClicks(query(".coopResync"), () => activeMod && activeMod.resyncAll());
        this.trackClicks(query(".coopAskResync"), () => activeMod && activeMod.requestResync());
        this.trackClicks(query(".coopCopy"), () => this.copyInvite());
        this.inviteSelect.addEventListener("change", () => {
            if (this.inviteInput) {
                this.inviteInput.value = this.inviteSelect.value;
            }
        });
        this.chatInput = query(".coopChatIn");
        this.chatInput.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                if (activeMod) {
                    activeMod.sendChat(event.target.value);
                }
                event.target.value = "";
                // Release focus or every later keypress keeps landing here
                event.target.blur();
            } else if (event.key === "Escape") {
                event.target.blur();
            }
            event.stopPropagation();
        });
        // Clicking the game canvas always releases the chat box, even if
        // the click itself gets consumed before it can move focus
        this.blurOnCanvasDown = event => {
            if (
                this.chatInput &&
                document.activeElement === this.chatInput &&
                !this.element.contains(event.target)
            ) {
                this.chatInput.blur();
            }
        };
        document.addEventListener("mousedown", this.blurOnCanvasDown, true);
        // Don't let game input leak into/out of the other fields
        for (const input of this.element.querySelectorAll("input:not(.coopChatIn)")) {
            input.addEventListener("keydown", event => event.stopPropagation());
            input.addEventListener("keyup", event => event.stopPropagation());
        }
        this.chatInput.addEventListener("keyup", event => event.stopPropagation());
        this.inviteSelect.addEventListener("keydown", event => event.stopPropagation());
        this.inviteSelect.addEventListener("keyup", event => event.stopPropagation());
        for (const button of this.element.querySelectorAll("button")) {
            button.addEventListener("keydown", event => event.stopPropagation());
            button.addEventListener("keyup", event => event.stopPropagation());
        }
        // F8 toggles the panel even when a field has focus: capture on the
        // panel runs before the field handlers and the game listener.
        this.element.addEventListener(
            "keydown",
            event => {
                if (event.keyCode === 119) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (activeMod) {
                        activeMod.togglePanel();
                    }
                }
            },
            true
        );
        // Direct reference so panel toggles work without a session too
        if (activeMod) {
            activeMod.coopPart = this;
            activeMod.syncPanelFromMod();
        }
    }

    initialize() {
        // Ctrl+right-drag area delete. Window-level capture so the gesture
        // works no matter which element is under the cursor, and the game
        // never sees it (no placement cancel, no camera pan). Gestures that
        // start inside our own panel are ignored.
        this.areaDrag = null;
        this.suppressContextMenuUntil = 0;
        this.onWindowMouseDown = event => {
            const mod = activeMod;
            if (!mod || !mod.shouldStartAreaDelete(this.root)) {
                return;
            }
            if (this.element && this.element.contains(event.target)) {
                return;
            }
            if (event.button === 2 && event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                this.areaDrag = {
                    x0: event.clientX,
                    y0: event.clientY,
                    x1: event.clientX,
                    y1: event.clientY,
                    at: Date.now(),
                };
                this.suppressContextMenuUntil = Date.now() + 1000;
            }
        };
        this.onWindowMouseMove = event => {
            if (this.areaDrag) {
                this.areaDrag.x1 = event.clientX;
                this.areaDrag.y1 = event.clientY;
                event.stopPropagation();
            }
        };
        this.onWindowMouseUp = event => {
            if (!this.areaDrag) {
                return;
            }
            if (event.button === 2 && event.ctrlKey && Date.now() - this.areaDrag.at < 60000) {
                event.preventDefault();
                event.stopPropagation();
                const drag = this.areaDrag;
                this.areaDrag = null;
                if (activeMod) {
                    activeMod.finishAreaDelete(this.root, drag);
                }
            } else {
                // Wrong button, ctrl released, or a stale rect from a
                // missed mouseup (alt-tab): never fire it later.
                this.areaDrag = null;
            }
        };
        this.onWindowBlur = () => {
            this.areaDrag = null;
        };
        this.onWindowContextMenu = event => {
            if (Date.now() < this.suppressContextMenuUntil) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        window.addEventListener("mousedown", this.onWindowMouseDown, true);
        window.addEventListener("mousemove", this.onWindowMouseMove, true);
        window.addEventListener("mouseup", this.onWindowMouseUp, true);
        window.addEventListener("contextmenu", this.onWindowContextMenu, true);
        window.addEventListener("blur", this.onWindowBlur, true);
    }

    cleanup() {
        super.cleanup();
        if (activeMod && activeMod.coopPart === this) {
            activeMod.coopPart = null;
        }
        // HUD DOM is never removed by the game; drop ours or stale
        // duplicate panels stay live over menus and later games.
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
        if (this.pill) {
            this.pill.remove();
            this.pill = null;
        }
        if (this.blurOnCanvasDown) {
            document.removeEventListener("mousedown", this.blurOnCanvasDown, true);
            this.blurOnCanvasDown = null;
        }
        window.removeEventListener("mousedown", this.onWindowMouseDown, true);
        window.removeEventListener("contextmenu", this.onWindowContextMenu, true);
        window.removeEventListener("mousemove", this.onWindowMouseMove, true);
        window.removeEventListener("mouseup", this.onWindowMouseUp, true);
        window.removeEventListener("blur", this.onWindowBlur, true);
        this.areaDrag = null;
    }

    /** Draw area-delete rubber band + remote player cursors in screen space. */
    drawOverlays(parameters) {
        const mod = activeMod;
        if (!mod || !this.root || !this.root.camera) {
            return;
        }
        const context = parameters.context;
        if (this.areaDrag) {
            const rx = Math.min(this.areaDrag.x0, this.areaDrag.x1);
            const ry = Math.min(this.areaDrag.y0, this.areaDrag.y1);
            const rw = Math.abs(this.areaDrag.x1 - this.areaDrag.x0);
            const rh = Math.abs(this.areaDrag.y1 - this.areaDrag.y0);
            context.save();
            context.fillStyle = "rgba(244,67,54,.15)";
            context.strokeStyle = "rgba(244,67,54,.9)";
            context.lineWidth = 1;
            context.fillRect(rx, ry, rw, rh);
            context.strokeRect(rx, ry, rw, rh);
            context.restore();
            this.drawAreaDeleteHighlights(context);
        }
        if (!mod.session) {
            return;
        }
        const Vector = window.shapez.Vector;
        if (!Vector) {
            return;
        }
        const now = Date.now();
        for (const [id, peer] of mod.peers) {
            if (id === mod.net.clientId || !peer.cursor) {
                continue;
            }
            // Idle peers keep a gray ghost instead of vanishing entirely.
            // The peer entry itself is removed on bye/expiry, cursors with
            // it, so ghosts only ever belong to connected players.
            const stale = now - peer.cursor.at > CURSOR_EXPIRE_MS;
            let screen;
            try {
                if (!this.root.camera.isWorldPointOnScreen(new Vector(peer.cursor.x, peer.cursor.y))) {
                    continue;
                }
                screen = this.root.camera.worldToScreen(new Vector(peer.cursor.x, peer.cursor.y));
            } catch {
                continue;
            }
            const color = stale ? "rgba(150,150,150,.9)" : peerColor(id);
            context.save();
            // Cursor arrow
            context.fillStyle = color;
            context.strokeStyle = "rgba(0,0,0,.65)";
            context.lineWidth = 1.5;
            context.beginPath();
            context.moveTo(screen.x, screen.y);
            context.lineTo(screen.x, screen.y + 16);
            context.lineTo(screen.x + 4.5, screen.y + 12);
            context.lineTo(screen.x + 7, screen.y + 17.5);
            context.lineTo(screen.x + 9.5, screen.y + 16);
            context.lineTo(screen.x + 7, screen.y + 10.5);
            context.lineTo(screen.x + 12, screen.y + 10.5);
            context.closePath();
            context.fill();
            context.stroke();
            // Name tag
            const label = stale ? (peer.name || id) + " (afk)" : peer.name || id;
            context.font = "12px GameFont, sans-serif";
            const w = context.measureText(label).width;
            const bx = screen.x + 14;
            const by = screen.y + 14;
            context.fillStyle = "rgba(10,14,22,.85)";
            context.fillRect(bx - 3, by - 12, w + 8, 17);
            context.fillStyle = "#fff";
            context.fillText(label, bx + 1, by + 1);
            context.restore();
        }
    }

    /** Red-highlight the buildings the active area-delete drag would remove. */
    drawAreaDeleteHighlights(context) {
        const mod = activeMod;
        const Vector = window.shapez.Vector;
        const globalConfig = window.shapez.globalConfig;
        if (!mod || !Vector || !globalConfig || !this.root || !this.root.camera || !this.root.logic) {
            return;
        }
        let a;
        let b;
        try {
            a = this.root.camera.screenToWorld(new Vector(this.areaDrag.x0, this.areaDrag.y0)).toTileSpace();
            b = this.root.camera.screenToWorld(new Vector(this.areaDrag.x1, this.areaDrag.y1)).toTileSpace();
        } catch {
            return;
        }
        const targets = mod.collectDeletableInTileRect(
            this.root,
            Math.min(a.x, b.x),
            Math.min(a.y, b.y),
            Math.max(a.x, b.x),
            Math.max(a.y, b.y)
        );
        const tileSize = globalConfig.tileSize;
        context.save();
        context.strokeStyle = "rgba(244,67,54,.95)";
        context.fillStyle = "rgba(244,67,54,.22)";
        context.lineWidth = 2;
        context.beginPath();
        let drawn = 0;
        for (const entity of targets) {
            if (drawn >= 2000) {
                break;
            }
            try {
                if (!this.root.logic.canDeleteBuilding(entity)) {
                    continue;
                }
                const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
                const topLeft = this.root.camera.worldToScreen(
                    new Vector(bounds.x * tileSize, bounds.y * tileSize)
                );
                const bottomRight = this.root.camera.worldToScreen(
                    new Vector((bounds.x + bounds.w) * tileSize, (bounds.y + bounds.h) * tileSize)
                );
                context.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
                drawn++;
            } catch {
                // Entity changed mid-drag; skip it
            }
        }
        context.fill();
        context.stroke();
        context.restore();
    }

    copyInvite() {
        if (!this.inviteInput || !this.inviteInput.value) {
            return;
        }
        const text = this.inviteInput.value;
        const done = () => this.addChat("system", "invite copied");
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, () => this.legacyCopy(text, done));
        } else {
            this.legacyCopy(text, done);
        }
    }

    legacyCopy(text, done) {
        try {
            this.inviteInput.select();
            document.execCommand("copy");
            done();
        } catch {
            // Clipboard unavailable; the text is still selectable
        }
    }

    setStatus(text, kind) {
        if (this.statusEl) {
            this.statusEl.textContent = text;
        }
        if (this.dotEl) {
            this.dotEl.style.background =
                kind === "ok" ? "#4caf50" : kind === "warn" ? "#ff9800" : kind === "err" ? "#f44336" : "#777";
        }
    }

    setConnected(role) {
        // role: null (offline), "host", "client"
        if (this.hostButton) {
            this.hostButton.disabled = role !== null;
        }
        if (this.joinButton) {
            this.joinButton.disabled = role !== null;
        }
        if (this.inviteRow) {
            this.inviteRow.style.display = role === "host" ? "block" : "none";
        }
    }

    /** open | collapsed (title only) | hidden (pill only) */
    applyPanelMode(mode) {
        if (this.element) {
            this.element.style.display = mode === "hidden" ? "none" : "";
        }
        if (this.pill) {
            this.pill.style.display = mode === "hidden" ? "" : "none";
            const dot = this.pill.querySelector(".coopPillDot");
            if (dot && this.dotEl) {
                dot.style.background = this.dotEl.style.background || "#777";
            }
        }
        if (this.bodyEl) {
            this.bodyEl.style.display = mode === "collapsed" ? "none" : "";
        }
    }

    setInvite(text) {
        if (this.inviteInput) {
            this.inviteInput.value = text;
        }
        if (this.inviteSelect) {
            this.inviteSelect.style.display = "none";
        }
    }

    setInvites(invites) {
        if (!this.inviteSelect || !this.inviteInput) {
            return;
        }
        this.inviteSelect.style.display = invites.length > 1 ? "" : "none";
        this.inviteSelect.innerHTML = "";
        for (const invite of invites) {
            const option = document.createElement("option");
            option.value = invite.url;
            option.textContent = invite.label;
            this.inviteSelect.appendChild(option);
        }
        if (invites.length > 0) {
            this.inviteSelect.value = invites[0].url;
            this.inviteInput.value = invites[0].url;
        }
    }

    setSync(text) {
        if (this.syncEl) {
            this.syncEl.textContent = "sync: " + text;
        }
    }

    renderPeers(peers, selfId) {
        if (!this.peersEl) {
            return;
        }
        if (peers.size === 0) {
            this.peersEl.textContent = "peers: -";
            return;
        }
        const rows = [];
        for (const [id, peer] of peers) {
            const tags = [];
            if (id === selfId) {
                tags.push("you");
            }
            if (peer.isHost) {
                tags.push("host");
            }
            const rtt = peer.rtt == null ? "?" : Math.round(peer.rtt) + "ms";
            rows.push(peer.name + (tags.length ? " (" + tags.join(",") + ")" : "") + " " + rtt);
        }
        this.peersEl.textContent = "peers: " + rows.join(" · ");
    }

    addChat(from, text) {
        if (!this.chatEl) {
            return;
        }
        const line = document.createElement("div");
        line.textContent = from + ": " + text;
        this.chatEl.appendChild(line);
        while (this.chatEl.children.length > 30) {
            this.chatEl.removeChild(this.chatEl.firstChild);
        }
        this.chatEl.scrollTop = this.chatEl.scrollHeight;
    }
}

// ---------------------------------------------------------------------------
// Mod
// ---------------------------------------------------------------------------

export default class CoopMod extends ModBase {
    init() {
        activeMod = this;

        const GameLogic = shapez("GameLogic");
        const GameMode = shapez("GameMode");
        const DynamicTickrate = shapez("DynamicTickrate");
        const EntityManager = shapez("EntityManager");
        const HubGoals = shapez("HubGoals");

        this.GameLogic = GameLogic;
        this.session = null; // { root, isHost } while connected
        this.applyingRemote = false;
        this.pendingOps = [];
        this.flushScheduled = false;
        this.opSeq = 0;
        this.baseline = new StateBaseline();
        this.acceptedSeq = new Map();
        this.unacknowledged = [];
        this.blueprintTransaction = null;
        this.lastOpActivity = 0; // last local/remote structural change (ms)
        this.versionWarned = new Set();
        this.slot = 1; // UID slot (0 = host); assigned by welcome, 1 pre-join
        this.hostId = null; // clientId of the session host, once known
        this.slots = new Map(); // host: peerId -> slot (stable across rejoins)
        this.awaitingWelcome = false; // client: hold ops until first snapshot
        this.hookedRoots = new WeakSet();
        this.lastResyncRequest = 0;
        this.peers = new Map(); // clientId -> { name, lastSeen, rtt, isHost }
        this.mismatches = new Map(); // host: clientId -> consecutive sync-check mismatches
        this.lastResync = new Map(); // host: clientId -> timestamp of last auto resync
        this.hubTimer = null;
        this.syncTimer = null;
        this.pingTimer = null;
        this.sweepTimer = null;
        this.cursorTimer = null;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.lastCursorSent = null;
        this.lastSyncText = "-";
        this.lastStatusText = "offline";
        this.lastStatusKind = null;
        this.lastInvites = [];
        this.panelMode = "open"; // open | collapsed | hidden
        this.coopPart = null; // live HUD part; session-independent access
        this.net = new CoopNet(this);
        this.net.onMessage = message => this.handleMessage(message);
        this.net.onOpen = () => this.onSocketOpen();
        this.net.onClose = () => this.onSocketClose();

        const mod = this;
        // Measure the real canvas/HUD draw path separately from async network
        // waits. A slow decode wall time alone cannot establish rendering FPS.
        this.modInterface.replaceMethod(shapez("GameCore"), "draw", function (oldFn, args) {
            if (!mod.session || mod.session.isHost || mod.session.root !== this.root || !mod.net.connected)
                return oldFn(...args);
            const started = performance.now();
            try {
                return oldFn(...args);
            } finally {
                if (this.root && mod.session?.root === this.root)
                    mod.recordRenderPerf(this.root, performance.now() - started);
            }
        });

        // --- Fixed tickrate while a session is active ---------------------
        // A client renders host state, never independently produces or delivers
        // items. Wall-clock pauses/FPS therefore cannot change the shared sim.
        this.modInterface.replaceMethod(shapez("GameTime"), "performTicks", function (oldFn, args) {
            if (mod.session && !mod.session.isHost && mod.net.connected && mod.session.root === this.root) {
                this.logicTimeBudget = 0;
                return;
            }
            return oldFn(...args);
        });
        this.modInterface.replaceMethod(shapez("ProductionAnalytics"), "update", function (oldFn, args) {
            if (mod.session && !mod.session.isHost && mod.net.connected && mod.session.root === this.root) {
                return;
            }
            return oldFn(...args);
        });
        // Do not allocate provisional slot-1 UIDs or edit the previous map
        // while waiting for the host's initial/reconnection snapshot.
        this.modInterface.replaceMethod(GameLogic, "checkCanPlaceEntity", function (oldFn, args) {
            if (
                mod.session &&
                mod.session.root === this.root &&
                !mod.session.isHost &&
                mod.awaitingWelcome &&
                !mod.applyingRemote
            ) {
                return false;
            }
            return oldFn(...args);
        });
        const Blueprint = shapez("Blueprint");
        this.modInterface.replaceMethod(Blueprint, "tryPlace", function (oldFn, args) {
            if (
                !mod.session ||
                mod.session.root !== args[0] ||
                mod.session.isHost ||
                mod.applyingRemote ||
                !mod.net.connected
            ) {
                return oldFn(...args);
            }
            if (mod.awaitingWelcome) {
                return false;
            }
            const root = args[0];
            const cost = this.getIsEffectivelyFree(root)
                ? null
                : {
                      key: root.gameMode.getBlueprintShapeKey(),
                      amount: this.getCost(),
                  };
            const transaction = [];
            mod.blueprintTransaction = transaction;
            let result;
            try {
                result = oldFn(...args);
            } finally {
                mod.blueprintTransaction = null;
            }
            if (result) {
                mod.queueOp({ k: "blueprint", ops: transaction, cost });
            }
            return result;
        });
        const origGetFixedTickrate = GameMode.prototype.getFixedTickrate;
        GameMode.prototype.getFixedTickrate = function () {
            // "regularMode" is enumGameModeIds.regular; puzzle mode keeps 300.
            if (mod.session && this.getId && this.getId() === "regularMode") {
                return COOP_TICKRATE;
            }
            return origGetFixedTickrate.call(this);
        };

        const origSetTickRate = DynamicTickrate.prototype.setTickRate;
        DynamicTickrate.prototype.setTickRate = function (rate) {
            if (mod.session && rate !== COOP_TICKRATE) {
                try {
                    // Puzzle mode has its own fixed rate; only lock regular play
                    if (!this.root || !this.root.gameMode || this.root.gameMode.getId() !== "regularMode") {
                        return origSetTickRate.call(this, rate);
                    }
                } catch {
                    // Fall through to the lock when the mode is unreadable
                }
                rate = COOP_TICKRATE;
            }
            return origSetTickRate.call(this, rate);
        };

        // --- Partition UID allocation into host/client slots --------------
        // Stride SLOT_STEP with residue = slot keeps every peer disjoint
        // even after full-state syncs (all peers derive from one nextUid).
        const origGenerateUid = EntityManager.prototype.generateUid;
        EntityManager.prototype.generateUid = function () {
            if (!mod.session) {
                return origGenerateUid.call(this);
            }
            const slot = mod.session.isHost ? 0 : mod.slot;
            const want = ((slot % SLOT_STEP) + SLOT_STEP) % SLOT_STEP;
            let uid = this.nextUid;
            const residue = ((uid % SLOT_STEP) + SLOT_STEP) % SLOT_STEP;
            if (residue !== want) {
                uid += (want - residue + SLOT_STEP) % SLOT_STEP;
            }
            this.nextUid = uid + SLOT_STEP;
            return uid;
        };

        // --- Replicate entity creation at the true choke point --------------
        // Every creation path (tryPlaceBuilding, blueprint paste, puzzle
        // setup) funnels through EntityManager.registerEntity, AFTER the
        // UID is assigned — so capture the op here instead of in
        // tryPlaceBuilding (which blueprint paste bypasses entirely).
        this.modInterface.replaceMethod(EntityManager, "registerEntity", function (oldFn, args) {
            const result = oldFn(...args);
            const entity = args[0];
            if (!mod.session || mod.applyingRemote || !entity) {
                return result;
            }
            const root = this.root;
            if (!root || mod.session.root !== root || !root.gameInitialized) {
                return result; // game setup (hub, loads): covered by snapshots
            }
            mod.queueOp({ k: "place", uid: entity.uid, entity: entity.serialize() });
            return result;
        });

        this.modInterface.replaceMethod(GameLogic, "tryDeleteBuilding", function (oldFn, args) {
            if (
                mod.session &&
                mod.session.root === this.root &&
                !mod.session.isHost &&
                mod.awaitingWelcome &&
                !mod.applyingRemote
            ) {
                return false;
            }
            const building = args[0];
            const uid = building ? building.uid : null;
            const result = oldFn(...args);
            if (result && uid !== null) {
                // Always (offline, remote-applied, replaced): a destroyed
                // entity left in the mass selector's set crashes its draw
                // pass on the next frame (null.components).
                mod.dropFromMassSelection(this.root, uid);
            }
            if (
                !mod.session ||
                mod.session.root !== this.root ||
                mod.applyingRemote ||
                !result ||
                !building
            ) {
                return result;
            }
            mod.queueOp({ k: "delete", uid: building.uid });
            return result;
        });

        // --- Replicate hub upgrade purchases --------------------------------
        this.modInterface.replaceMethod(HubGoals, "tryUnlockUpgrade", function (oldFn, args) {
            if (
                mod.session &&
                mod.session.root === this.root &&
                !mod.session.isHost &&
                mod.awaitingWelcome &&
                !mod.applyingRemote
            ) {
                return false;
            }
            const result = oldFn(...args);
            if (!mod.session || mod.session.root !== this.root || mod.applyingRemote || !result) {
                return result;
            }
            mod.queueOp({ k: "upgrade", upgradeId: args[0] });
            return result;
        });

        // --- Track per-game root --------------------------------------------
        this.signals.gameStarted.add(root => this.onGameStarted(root));

        // --- HUD --------------------------------------------------------------
        this.modInterface.registerHudElement("coop", CoopHudPart);
        if (this.modInterface.addStylesheet) {
            this.modInterface.addStylesheet("style.css");
        } else {
            warn("addStylesheet unavailable, panel will be unstyled");
        }

        // GameHUD.drawOverlays uses a hardcoded part list; route our part
        // through it so cursors and the area-delete rubber band render.
        try {
            const GameHUD = shapez("GameHUD");
            this.modInterface.replaceMethod(GameHUD, "drawOverlays", function (oldFn, args) {
                const result = oldFn(...args);
                try {
                    const part = this.parts && this.parts.coop;
                    if (part) {
                        part.drawOverlays(...args);
                    }
                } catch (ex) {
                    warn("coop drawOverlays failed", ex);
                }
                return result;
            });
        } catch (ex) {
            warn("coop overlay hook unavailable", ex);
        }

        // --- F8 toggles the panel (HUD parts are looked up live) --------------
        try {
            const KEYCODES = shapez("KEYCODES");
            this.modInterface.registerIngameKeybinding({
                id: "coopTogglePanel",
                keyCode: KEYCODES.F8,
                translation: "Toggle co-op panel",
                handler: () => this.togglePanel(),
            });
        } catch (ex) {
            warn("panel keybinding unavailable", ex);
        }

        // --- Peer count pushed by the main process -----------------------------
        try {
            ipcRenderer.on("coop-peer-count", (_event, count) => this.onPeerCount(count));
        } catch {
            // Not running under Electron (shouldn't happen in CE standalone)
        }

        log("initialized (protocol v" + COOP_VERSION + ")");
    }

    // --- Session ------------------------------------------------------------

    get hud() {
        const root = this.session && this.session.root;
        return root && root.hud && root.hud.parts ? root.hud.parts.coop : null;
    }

    setPanelMode(mode) {
        this.panelMode = mode;
        const part = this.coopPart || this.hud;
        if (part) {
            part.applyPanelMode(mode);
        }
    }

    togglePanel() {
        this.setPanelMode(this.panelMode === "hidden" ? "open" : "hidden");
    }

    /** Push mod-side state into a (possibly fresh) panel after game loads. */
    syncPanelFromMod() {
        const part = this.coopPart || this.hud;
        if (!part) {
            return;
        }
        // Fresh HUD parts (new game / reload) start with empty fields:
        // refill the remembered name + join address.
        try {
            if (part.nameInput && !part.nameInput.value) {
                part.nameInput.value =
                    loadStoredCoopName() || (this.net.name !== "Player" ? this.net.name : "");
            }
            if (part.addrInput && !part.addrInput.value) {
                part.addrInput.value = loadStoredCoopValue(COOP_ADDR_KEY) || "";
            }
        } catch {
            // Cosmetic only; panel still works
        }
        part.setStatus(this.lastStatusText, this.lastStatusKind);
        part.setConnected(this.session ? (this.session.isHost ? "host" : "client") : null);
        if (this.lastInvites.length > 0) {
            part.setInvites(this.lastInvites);
        }
        part.setSync(this.lastSyncText);
        part.renderPeers(this.peers, this.net.clientId);
        part.applyPanelMode(this.panelMode);
    }

    onGameStarted(root) {
        if (!this.session) {
            return;
        }
        const rootChanged = this.session.root !== root;
        this.session.root = root;
        this.hookRootSignals(root);
        this.syncPanelFromMod();
        if (rootChanged) {
            // A new map mid-session: drop in-flight state and converge now
            // instead of leaking cross-map ops for ~30s.
            this.pendingOps = [];
            this.flushScheduled = false;
            this.mismatches.clear();
            if (this.session.isHost) {
                this.resyncAll();
            } else {
                this.requestResync();
            }
        }
        try {
            root.dynamicTickrate.setTickRate(COOP_TICKRATE);
        } catch {
            // Root not fully initialized yet; constructor already fixed it
        }
    }

    hookRootSignals(root) {
        if (this.hookedRoots.has(root)) {
            return;
        }
        this.hookedRoots.add(root);
        root.signals.bulkOperationFinished.add(() => this.flushOps());
        root.signals.entityChanged.add(entity => {
            if (!this.session || this.session.root !== root || this.applyingRemote || this.awaitingWelcome) {
                return;
            }
            for (const component of ["Lever", "ConstantSignal"]) {
                if (entity.components[component]) {
                    this.queueOp({
                        k: "configure",
                        uid: entity.uid,
                        component,
                        data: entity.components[component].serialize(),
                    });
                }
            }
        });
        root.signals.aboutToDestruct.add(() => {
            // Leaving/destroying the game ends the session: no live game
            // means no hub-state, no resync answers, nothing to converge to.
            if (this.session && this.session.root === root) {
                try {
                    this.net.send({ t: "bye" });
                } catch {
                    // Best effort
                }
                const wasHost = this.session.isHost;
                this.endSession();
                this.net.disconnect();
                if (wasHost) {
                    try {
                        ipcRenderer.invoke("coop-stop").catch(ex => warn("relay shutdown failed", ex));
                    } catch (ex) {
                        warn("relay shutdown unavailable", ex);
                    }
                }
                this.setStatus(wasHost ? "game closed (host left)" : "game closed", "warn");
                this.renderPeers();
            }
        });
    }

    /** Normalize + persist the shared player name for Host and Join. */
    rememberName(name) {
        const clean = String(name || "")
            .trim()
            .slice(0, 24);
        if (clean) {
            this.net.name = clean;
            saveStoredCoopValue(COOP_NAME_KEY, clean);
        }
        return clean;
    }

    async hostGame(name) {
        if (this.session) {
            await this.leaveGame();
        }
        const root = this.requireRoot();
        if (!root) {
            return;
        }
        this.rememberName(name);
        let status;
        try {
            status = await ipcRenderer.invoke("coop-start", COOP_DEFAULT_PORT);
        } catch (ex) {
            warn("coop-start failed", ex);
            this.setStatus("host failed (see console)", "err");
            return;
        }
        this.net.isHost = true;
        if (!this.net.connect("ws://127.0.0.1:" + status.port)) {
            this.setStatus("host failed (see console)", "err");
            return;
        }
        this.beginSession(root, true);
        const invites = buildInvites(status.addresses, status.port);
        this.lastInvites = invites;
        const ownVersion = (this.metadata && this.metadata.version) || "?";
        log(
            "hosting co-op v" + ownVersion + " on port",
            status.port,
            "invites:",
            invites.map(i => i.url).join(",")
        );
        const part = this.hud;
        if (part) {
            if (invites.length > 0) {
                part.setInvites(invites);
            } else {
                part.setInvite("ws://<this-pc-ip>:" + status.port);
            }
        }
        this.setStatus("hosting :" + status.port, "ok");
    }

    async joinGame(address, name) {
        if (this.session) {
            await this.leaveGame();
        }
        const root = this.requireRoot();
        if (!root) {
            return;
        }
        const url = parseJoinInput(address);
        if (!url) {
            this.setStatus("invalid join code — check address and port (1-65535)", "err");
            return;
        }
        this.rememberName(name);
        saveStoredCoopValue(COOP_ADDR_KEY, address);
        this.net.isHost = false;
        if (!this.net.connect(url)) {
            this.setStatus("invalid join code — check address and port (1-65535)", "err");
            return;
        }
        this.beginSession(root, false);
        log("joining co-op v" + ((this.metadata && this.metadata.version) || "?"), "at", url);
        this.setStatus("joining…", "warn");
    }

    async leaveGame() {
        if (this.session) {
            this.net.send({ t: "bye" });
        }
        const part = this.hud;
        this.endSession();
        this.net.disconnect();
        try {
            await ipcRenderer.invoke("coop-stop");
        } catch {
            // Best effort; client-only sessions never started a server
        }
        if (part) {
            part.setStatus("offline", null);
            part.setConnected(null);
            part.setSync("-");
            part.renderPeers(new Map(), null);
        }
    }

    requireRoot() {
        // Prefer the live session root, else the global dev root.
        if (this.session) {
            return this.session.root;
        }
        const app = this.app;
        const state = app && app.stateMgr ? app.stateMgr.currentState : null;
        const core = state && state.core ? state.core : null;
        if (core && core.root) {
            return core.root;
        }
        if (typeof window !== "undefined" && window.globalRoot) {
            return window.globalRoot;
        }
        this.setStatus("open a game first");
        return null;
    }

    beginSession(root, isHost) {
        this.endTimers();
        this.stateCapture?.dispose();
        this.stateCapture = isHost ? new StateCapture(root) : null;
        this.predictionOps = [];
        this.stateReceipts = new Map();
        this.pendingWelcomes = new Map();
        this.perfStats = null;
        this.renderStats = null;
        this.lastFlowLog = Date.now();
        try {
            ipcRenderer.invoke("coop-active", true).catch(() => {});
        } catch {
            /* Headless tests */
        }
        this.session = { root, isHost };
        this.pendingOps = [];
        this.flushScheduled = false;
        this.opSeq = 0;
        this.baseline = new StateBaseline();
        this.acceptedSeq.clear();
        this.unacknowledged = [];
        this.lastResyncRequest = 0;
        this.lastStateAt = Date.now();
        this.lastSyncCheckAt = 0;
        this.lastCursorSent = null;
        this.peers.clear();
        this.mismatches.clear();
        this.lastResync.clear();
        this.versionWarned.clear();
        this.awaitingWelcome = !isHost;
        if (isHost) {
            this.hostId = this.net.clientId;
            this.slots.clear();
        } else {
            this.hostId = null;
            this.slot = 1;
        }
        this.lastSyncText = "-";
        // Self entry so the peer list always shows the local player
        this.peers.set(this.net.clientId, {
            name: this.net.name,
            lastSeen: Date.now(),
            rtt: 0,
            isHost,
        });
        try {
            root.dynamicTickrate.setTickRate(COOP_TICKRATE);
        } catch {
            // Ignore; new roots get the fixed rate via the patched game mode
        }
        this.hookRootSignals(root);
        this.startCommonTimers();
        if (isHost) {
            this.startHostTimers();
        } else {
            this.startClientTimers();
        }
        const part = this.hud;
        if (part) {
            part.setConnected(isHost ? "host" : "client");
        }
        this.renderPeers();
    }

    endSession() {
        const root = this.session && this.session.root;
        this.endTimers();
        this.stateCapture?.dispose();
        this.stateCapture = null;
        try {
            ipcRenderer.invoke("coop-active", false).catch(() => {});
        } catch {
            /* Headless tests */
        }
        this.session = null;
        this.pendingOps = [];
        this.flushScheduled = false;
        this.unacknowledged = [];
        this.predictionOps = [];
        this.stateReceipts?.clear();
        this.pendingWelcomes?.clear();
        this.baseline = new StateBaseline();
        this.acceptedSeq.clear();
        this.lastCursorSent = null;
        this.peers.clear();
        this.mismatches.clear();
        this.lastResync.clear();
        this.awaitingWelcome = false;
        // Session is null now so the tickrate patch passes through
        if (root) {
            try {
                root.dynamicTickrate.setTickRate(root.app.settings.getDesiredFps());
            } catch {
                // Root half-torn-down; nothing to restore
            }
        }
    }

    startHostTimers() {
        this.endRoleTimers();
        this.hubTimer = setInterval(() => this.broadcastState(), STATE_INTERVAL_MS);
    }

    startClientTimers() {
        this.endRoleTimers();
        this.syncTimer = setInterval(() => {
            if (!this.net.connected) {
                return;
            }
            if (Date.now() - this.lastStateAt > (this.awaitingWelcome ? SNAPSHOT_TIMEOUT_MS : 5000)) {
                this.requestResync();
            } else if (Date.now() - this.lastSyncCheckAt >= SYNC_CHECK_MS) {
                this.lastSyncCheckAt = Date.now();
                this.sendSyncCheck();
            }
        }, 1000);
    }

    startCommonTimers() {
        this.endCommonTimers();
        this.pingTimer = setInterval(() => {
            if (this.session) {
                this.net.send({ t: "ping-req", to: "*", t0: Date.now() });
            }
        }, PING_MS);
        this.sweepTimer = setInterval(() => this.sweepPeers(), PING_MS);
        this.cursorTimer = setInterval(() => this.sendCursor(), CURSOR_MS);
    }

    endRoleTimers() {
        if (this.hubTimer) {
            clearInterval(this.hubTimer);
            this.hubTimer = null;
        }
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    endCommonTimers() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        if (this.cursorTimer) {
            clearInterval(this.cursorTimer);
            this.cursorTimer = null;
        }
        this.stopReconnectLoop();
    }

    endTimers() {
        this.endRoleTimers();
        this.endCommonTimers();
    }

    setStatus(text, kind) {
        this.lastStatusText = text;
        this.lastStatusKind = kind || null;
        const part = this.coopPart || this.hud;
        if (part) {
            part.setStatus(text, kind);
        }
    }

    setSync(text) {
        this.lastSyncText = text;
        const part = this.hud;
        if (part) {
            part.setSync(text);
        }
    }

    renderPeers() {
        const part = this.hud;
        if (part) {
            part.renderPeers(this.peers, this.net.clientId);
        }
    }

    touchPeer(id, name, isHost) {
        if (!id) {
            return;
        }
        const existing = this.peers.get(id);
        let changed = !existing;
        if (existing) {
            existing.lastSeen = Date.now();
            if (name && name !== existing.name) {
                existing.name = name;
                changed = true;
            }
            if (isHost !== undefined && isHost !== existing.isHost) {
                existing.isHost = isHost;
                changed = true;
            }
        } else {
            this.peers.set(id, {
                name: name || id,
                lastSeen: Date.now(),
                rtt: null,
                isHost: !!isHost,
            });
        }
        if (changed) this.renderPeers();
    }

    sweepPeers() {
        if (!this.session) {
            return;
        }
        const now = Date.now();
        let changed = false;
        for (const [id, peer] of this.peers) {
            if (id !== this.net.clientId && now - peer.lastSeen > PEER_EXPIRE_MS) {
                this.peers.delete(id);
                this.mismatches.delete(id);
                this.lastResync.delete(id);
                this.slots.delete(id);
                this.acceptedSeq.delete(id);
                this.stateReceipts.delete(id);
                this.pendingWelcomes.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.renderPeers();
        }
    }

    onPeerCount(count) {
        // Relay-level connection count; the named peer list is tracked
        // separately from hello traffic. Log only to avoid confusion.
        log("relay peers:", count);
    }

    onSocketOpen() {
        this.stopReconnectLoop();
        if (!this.session) {
            return;
        }
        // Fresh connection, fresh election: a restarted host has a new id.
        this.hostId = this.session.isHost ? this.net.clientId : null;
        this.perfStats = null;
        this.renderStats = null;
        this.lastResyncRequest = 0;
        this.pendingWelcomes.clear();
        if (!this.session.isHost) {
            this.awaitingWelcome = true;
            this.pendingOps = [];
            this.unacknowledged = [];
            this.opSeq = 0;
            this.lastStateAt = Date.now();
            // Drop ghosts from the dead connection; hellos rebuild the list.
            for (const id of this.peers.keys()) {
                if (id !== this.net.clientId) {
                    this.peers.delete(id);
                }
            }
            this.renderPeers();
            this.setStatus("syncing…", "warn");
        } else if (this.session.isHost) {
            this.setStatus("hosting (waiting for join)", "ok");
        }
    }

    onSocketClose() {
        if (!this.session) {
            return;
        }
        this.pendingOps = [];
        this.unacknowledged = [];
        this.awaitingWelcome = false;
        // Age everyone out fast (sweep collects them within ~10s) instead
        // of showing a dead session as healthy for 30s.
        const now = Date.now();
        for (const [id, peer] of this.peers) {
            if (id !== this.net.clientId) {
                peer.lastSeen = Math.min(peer.lastSeen, now - (PEER_EXPIRE_MS - 10000));
            }
        }
        this.renderPeers();
        this.setStatus(this.session.isHost ? "relay lost" : "disconnected", "err");
        this.setSync("disconnected — playing solo copy");
        this.startReconnectLoop();
    }

    startReconnectLoop() {
        this.stopReconnectLoop();
        this.reconnectAttempts = 0;
        this.reconnectTimer = setInterval(() => {
            if (!this.session || !this.net.url || this.net.connected) {
                this.stopReconnectLoop();
                return;
            }
            this.reconnectAttempts++;
            this.setStatus("reconnecting… (" + this.reconnectAttempts + ")", "warn");
            this.net.connect(this.net.url);
        }, 5000);
    }

    stopReconnectLoop() {
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    sendSyncCheck() {
        if (
            !this.session ||
            this.session.isHost ||
            this.awaitingWelcome ||
            this.pendingOps.length ||
            this.unacknowledged.length ||
            !rootReadyForNet(this.session.root)
        ) {
            return;
        }
        try {
            const summary = computeSyncSummary(this.session.root);
            this.net.send({
                t: "sync-check",
                hash: summary.hash,
                codes: summary.codes,
                seq: this.opSeq,
            });
        } catch (ex) {
            warn("sync-check failed", ex);
        }
    }

    /** Host: push a full snapshot to one client (or "*" for everyone). */
    resyncAll() {
        if (!this.session || !this.session.isHost) {
            return;
        }
        this.sendWelcome("*");
        const part = this.hud;
        if (part) {
            part.addChat("system", "pushed full state to all peers");
        }
    }

    /** Broadcast our map cursor ~10x/s so peers see where we are. */
    sendCursor() {
        if (!this.session) {
            return;
        }
        const root = this.session.root;
        const mouse = root.app && root.app.mousePosition;
        if (!mouse || !root.camera) {
            return;
        }
        let world;
        try {
            world = root.camera.screenToWorld(mouse);
        } catch {
            return;
        }
        if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) {
            return;
        }
        const x = Math.round(world.x);
        const y = Math.round(world.y);
        if (this.lastCursorSent && this.lastCursorSent.x === x && this.lastCursorSent.y === y) {
            return;
        }
        this.lastCursorSent = { x, y };
        this.net.send({ t: "cursor", x, y });
    }

    /** Drop one UID from the game's mass selection (stale entries crash
     *  its draw pass). Runs for every delete, any session state. */
    dropFromMassSelection(root, uid) {
        try {
            const parts = root && root.hud && root.hud.parts;
            const ms = parts && parts.massSelector;
            if (ms && ms.selectedUids) {
                ms.selectedUids.delete(uid);
            }
        } catch {
            // Selection state is best-effort only
        }
    }

    /** Entities whose tile bounds overlap the given inclusive tile rect. */
    collectDeletableInTileRect(root, x0, y0, x1, y1) {
        const found = [];
        for (const entity of root.entityMgr.entities.values()) {
            const staticComp = entity.components && entity.components.StaticMapEntity;
            if (!staticComp) {
                continue;
            }
            let bounds;
            try {
                bounds = staticComp.getTileSpaceBounds();
            } catch {
                continue;
            }
            if (!bounds) {
                continue;
            }
            if (
                bounds.x <= x1 &&
                bounds.x + bounds.w - 1 >= x0 &&
                bounds.y <= y1 &&
                bounds.y + bounds.h - 1 >= y0
            ) {
                found.push(entity);
            }
        }
        return found;
    }

    /** Bulk-deletes everything in the tile rect, replicating as one op batch. */
    areaDeleteTileRect(root, x0, y0, x1, y1) {
        const targets = this.collectDeletableInTileRect(root, x0, y0, x1, y1);
        if (targets.length === 0) {
            return 0;
        }
        let count = 0;
        root.logic.performBulkOperation(() => {
            for (const entity of targets) {
                try {
                    if (root.logic.tryDeleteBuilding(entity)) {
                        count++;
                    }
                } catch (ex) {
                    warn("area delete failed", ex);
                }
            }
        });
        return count;
    }

    /** Whether a ctrl+right gesture on this root should start area delete.
     *  Works offline too: without a session the delete is simply local.
     *  Uses the HUD's own live root (not session.root identity) so reloads
     *  and late joins can't desync the gesture from the visible game. */
    shouldStartAreaDelete(root) {
        return rootReadyForNet(root);
    }

    /** Called by the HUD on ctrl+right-drag release (screen-space rect). */
    finishAreaDelete(root, drag) {
        if (!rootReadyForNet(root)) {
            return 0;
        }
        // Refuse cross-game broadcast: if the session tracks a *different*
        // live game, the gesture and the session disagree — abort.
        if (
            this.session &&
            this.session.root &&
            this.session.root !== root &&
            rootReadyForNet(this.session.root)
        ) {
            warn("area delete aborted: session tracks another live game");
            return 0;
        }
        const Vector = window.shapez.Vector;
        if (!Vector) {
            return 0;
        }
        let a;
        let b;
        try {
            a = root.camera.screenToWorld(new Vector(drag.x0, drag.y0)).toTileSpace();
            b = root.camera.screenToWorld(new Vector(drag.x1, drag.y1)).toTileSpace();
        } catch (ex) {
            warn("area delete coordinate mapping failed", ex);
            return 0;
        }
        const count = this.areaDeleteTileRect(
            root,
            Math.min(a.x, b.x),
            Math.min(a.y, b.y),
            Math.max(a.x, b.x),
            Math.max(a.y, b.y)
        );
        if (count > 0) {
            const parts = root.hud && root.hud.parts;
            const part = parts && parts.coop;
            if (part) {
                part.addChat("system", "deleted " + count + " buildings");
            }
        }
        return count;
    }

    /** Client: ask the host for a full snapshot. */
    requestResync() {
        if (!this.session || this.session.isHost) {
            return;
        }
        const now = Date.now();
        if (
            this.awaitingWelcome &&
            this.lastResyncRequest &&
            now - this.lastResyncRequest < SNAPSHOT_TIMEOUT_MS
        )
            return;
        if (now - this.lastResyncRequest < 1000) {
            this.setSync("resync on cooldown…");
            return;
        }
        this.lastResyncRequest = now;
        if (!this.net.send({ t: "resync-request" })) {
            return;
        }
        this.awaitingWelcome = true;
        this.setSync("resync requested…");
    }

    sendChat(text) {
        if (!text || !this.session) {
            return;
        }
        const trimmed = String(text).slice(0, 200);
        if (!this.net.send({ t: "chat", name: this.net.name, text: trimmed })) {
            const part = this.coopPart || this.hud;
            if (part) {
                part.addChat("system", "not sent (disconnected)");
            }
            return;
        }
        const part = this.hud;
        if (part) {
            part.addChat(this.net.name + " (you)", trimmed);
        }
    }

    // --- Op replication ------------------------------------------------------

    queueOp(op) {
        if (!this.session || this.session.isHost || !this.net.connected || this.awaitingWelcome) {
            return;
        }
        if (this.blueprintTransaction) {
            this.blueprintTransaction.push(op);
            return;
        }
        this.pendingOps.push(op);
        this.lastOpActivity = Date.now();
        if (this.flushScheduled) {
            return;
        }
        this.flushScheduled = true;
        setTimeout(() => this.flushOps(), 0);
    }

    flushOps() {
        this.flushScheduled = false;
        if (this.awaitingWelcome) {
            // Pre-snapshot ops are causally newer than the coming welcome;
            // hold them and replay after the wipe instead of losing them.
            return;
        }
        const ops = this.pendingOps;
        this.pendingOps = [];
        // Offline ops are already applied locally; never replay them into a
        // session that starts later.
        if (!this.session || this.session.isHost || ops.length === 0) {
            return;
        }
        // Split instead of silently truncating large area-delete batches.
        for (let start = 0; start < ops.length; start += MAX_OPS_PER_MESSAGE) {
            const batch = {
                t: "ops",
                seq: this.opSeq + 1,
                ops: ops.slice(start, start + MAX_OPS_PER_MESSAGE),
            };
            if (!this.net.send(batch)) {
                this.pendingOps = ops.slice(start).concat(this.pendingOps);
                return;
            }
            this.opSeq = batch.seq;
            this.unacknowledged.push(batch);
        }
    }

    recordStatePerf(role, sample) {
        const now = performance.now();
        const stats =
            this.perfStats ||
            (this.perfStats = {
                start: now,
                count: 0,
                workMs: 0,
                captureMs: 0,
                decodeMs: 0,
                wireDecodeMs: 0,
                parseMs: 0,
                unpackMs: 0,
                unpackWorkMs: 0,
                receiveQueueMs: 0,
                bytes: 0,
                maxMs: 0,
                rate: 0,
                sentBytes: this.net.sendStats.stateBytes,
                sentCount: this.net.sendStats.stateCount,
            });
        ++stats.count;
        for (const key of [
            "workMs",
            "captureMs",
            "decodeMs",
            "wireDecodeMs",
            "parseMs",
            "unpackMs",
            "unpackWorkMs",
            "receiveQueueMs",
            "bytes",
        ])
            stats[key] += sample[key] || 0;
        stats.maxMs = Math.max(stats.maxMs, (sample.workMs || 0) + (sample.decodeMs || 0));
        const seconds = (now - stats.start) / 1000;
        if (seconds >= 5) {
            stats.rate = stats.count / seconds;
            const bytes = role === "host" ? this.net.sendStats.stateBytes - stats.sentBytes : stats.bytes;
            const count = role === "host" ? this.net.sendStats.stateCount - stats.sentCount : stats.count;
            log(
                "state performance",
                JSON.stringify({
                    role,
                    revision: this.baseline.revision,
                    hz: +stats.rate.toFixed(2),
                    workMs: +(stats.workMs / stats.count).toFixed(2),
                    captureMs: +(stats.captureMs / stats.count).toFixed(2),
                    decodeMs: +(stats.decodeMs / stats.count).toFixed(2),
                    wireDecodeMs: +(stats.wireDecodeMs / stats.count).toFixed(2),
                    parseMs: +(stats.parseMs / stats.count).toFixed(2),
                    unpackMs: +(stats.unpackMs / stats.count).toFixed(2),
                    unpackWorkMs: +(stats.unpackWorkMs / stats.count).toFixed(2),
                    receiveQueueMs: +(stats.receiveQueueMs / stats.count).toFixed(2),
                    decoder: this.net.decoder?.mode || "inline",
                    maxMs: +stats.maxMs.toFixed(2),
                    bytesPerFrame: count ? Math.round(bytes / count) : 0,
                    kbPerSecond: Math.round(bytes / seconds / 1024),
                    bufferedBytes: this.net.socket?.bufferedAmount || 0,
                    queuedBytes: this.net.sendStats.queuedBytes,
                    pendingMessages: this.net.sendStats.pending,
                    lastStateEncodeMs: this.net.sendStats.lastStateMs || 0,
                    lastWelcomeBytes: this.net.sendStats.lastWelcomeBytes || 0,
                    hidden: document.hidden || false,
                    entities: this.session.root.entityMgr.entities.size,
                })
            );
            this.perfStats = {
                start: now,
                count: 0,
                workMs: 0,
                captureMs: 0,
                decodeMs: 0,
                wireDecodeMs: 0,
                parseMs: 0,
                unpackMs: 0,
                unpackWorkMs: 0,
                receiveQueueMs: 0,
                bytes: 0,
                maxMs: 0,
                rate: stats.rate,
                sentBytes: this.net.sendStats.stateBytes,
                sentCount: this.net.sendStats.stateCount,
            };
        }
        return stats.rate;
    }

    recordRenderPerf(root, drawMs) {
        const now = performance.now();
        const stats =
            this.renderStats ||
            (this.renderStats = { start: now - drawMs, frames: 0, ms: 0, max: 0, lastFrame: now, maxGap: 0 });
        stats.maxGap = Math.max(stats.maxGap, now - stats.lastFrame);
        stats.lastFrame = now;
        ++stats.frames;
        stats.ms += drawMs;
        stats.max = Math.max(stats.max, drawMs);
        const seconds = (now - stats.start) / 1000;
        if (seconds < 5) return;
        log(
            "renderer performance",
            JSON.stringify({
                role: "client",
                revision: this.baseline.revision,
                renderHz: +(stats.frames / seconds).toFixed(2),
                drawMs: +(stats.ms / stats.frames).toFixed(2),
                maxDrawMs: +stats.max.toFixed(2),
                maxFrameGapMs: +stats.maxGap.toFixed(2),
                decoder: this.net.decoder?.mode || "inline",
                zoom: root.camera?.zoomLevel,
                canvasWidth: root.canvas?.width,
                canvasHeight: root.canvas?.height,
                hidden: document.hidden || false,
            })
        );
        this.renderStats = { start: now, frames: 0, ms: 0, max: 0, lastFrame: now, maxGap: 0 };
    }

    broadcastState(fullSnapshot = false) {
        if (
            !this.session ||
            !this.session.isHost ||
            !this.net.connected ||
            !this.slots.size ||
            !rootReadyForNet(this.session.root)
        ) {
            return;
        }
        if (
            !fullSnapshot &&
            (this.net.transportBusy() ||
                [...this.stateReceipts].some(
                    ([id, receipt]) => this.slots.has(id) && this.baseline.revision - receipt >= 2
                ))
        ) {
            if (Date.now() - this.lastFlowLog > 5000) {
                this.lastFlowLog = Date.now();
                log(
                    "state backpressure",
                    JSON.stringify({
                        revision: this.baseline.revision,
                        receipts: Object.fromEntries(this.stateReceipts),
                        bufferedBytes: this.net.socket?.bufferedAmount || 0,
                        queuedBytes: this.net.sendStats.queuedBytes,
                        pendingMessages: this.net.sendStats.pending,
                    })
                );
            }
            return;
        }
        try {
            const started = performance.now();
            if (!this.stateCapture || this.stateCapture.root !== this.session.root) {
                this.stateCapture?.dispose();
                this.stateCapture = new StateCapture(this.session.root);
            }
            const snapshot = this.stateCapture.capture();
            const captured = performance.now();
            const frame = this.baseline.createFrame(snapshot, Object.fromEntries(this.acceptedSeq));
            if (this.net.send(frame)) {
                this.baseline.reset(frame.revision, snapshot.entities, snapshot.beltPaths);
                this.recordStatePerf("host", {
                    captureMs: captured - started,
                    workMs: performance.now() - started,
                });
                return fullSnapshot ? captureSnapshot(this.session.root, window.shapez, snapshot) : snapshot;
            }
        } catch (ex) {
            warn("state capture failed", ex);
        }
    }

    applyState(frame) {
        if (this.awaitingWelcome || frame.from !== this.hostId || this.session.isHost) {
            return;
        }
        try {
            const started = performance.now();
            if (!this.baseline.applyFrame(frame)) {
                return;
            }
            this.lastStateAt = Date.now();
            const previousPredictions = this.unacknowledged
                .flatMap(batch => batch.ops)
                .concat(this.pendingOps, this.predictionOps || []);
            const ack = frame.acknowledgements?.[this.net.clientId] || 0;
            this.unacknowledged = this.unacknowledged.filter(batch => batch.seq > ack);
            this.applyingRemote = true;
            const predictions = this.unacknowledged.flatMap(batch => batch.ops).concat(this.pendingOps);
            const predictedUids = new Set();
            const collect = ops => {
                for (const op of ops) {
                    if (op.k === "blueprint") collect(op.ops);
                    else if (op.uid !== undefined) predictedUids.add(op.uid);
                }
            };
            collect(previousPredictions);
            reconcileWorld(this.session.root, this.baseline, frame, window.shapez, predictedUids);
            // Replay predictions only until the host has accepted/rejected them.
            // Every preview is rebased on a complete canonical world, never on
            // another client's optimistic edit or a stale resync map.
            if (predictions.length) {
                applyCommands(this.session.root, predictions, window.shapez);
            }
            this.predictionOps = predictions;
            const rate = this.recordStatePerf("client", {
                workMs: performance.now() - started,
                decodeMs: frame.decodeMs || 0,
                wireDecodeMs: frame.wireDecodeMs || 0,
                parseMs: frame.parseMs || 0,
                unpackMs: frame.unpackMs || 0,
                unpackWorkMs: frame.unpackWorkMs || 0,
                receiveQueueMs: frame.receiveQueueMs || 0,
                bytes: frame.wireBytes || 0,
            });
            this.setSync("host state #" + frame.revision + (rate ? " · " + rate.toFixed(1) + " Hz" : ""));
            this.net.send({ t: "state-received", to: this.hostId, revision: frame.revision });
        } catch (ex) {
            warn("state apply failed", ex);
            this.requestResync();
        } finally {
            this.applyingRemote = false;
        }
    }

    acceptOps(message) {
        const slot = this.slots.get(message.from);
        if (
            !this.session.isHost ||
            slot === undefined ||
            !Array.isArray(message.ops) ||
            message.ops.length > MAX_OPS_PER_MESSAGE ||
            !Number.isSafeInteger(message.seq)
        ) {
            return;
        }
        const previous = this.acceptedSeq.get(message.from) || 0;
        if (message.seq <= previous) {
            return;
        }
        if (message.seq !== previous + 1) {
            this.sendWelcome(message.from);
            return;
        }
        this.applyingRemote = true;
        try {
            applyCommands(this.session.root, message.ops, window.shapez, slot);
            this.lastOpActivity = Date.now();
        } catch (ex) {
            warn("command rejected", message.from, message.seq, ex);
        } finally {
            this.acceptedSeq.set(message.from, message.seq);
            this.applyingRemote = false;
        }
        // The 100 ms publisher coalesces edit bursts. Capturing after every
        // area-delete packet would block the renderer repeatedly in one frame.
    }

    // --- Incoming messages ----------------------------------------------------

    handleMessage(message) {
        if (!this.session) {
            return;
        }
        if (message.t === "ping") {
            return; // Relay keep-alive, versionless by design
        }
        if (message.v !== COOP_VERSION) {
            this.setStatus("protocol mismatch — update both peers", "err");
            warn("dropping message with wrong version", message.v);
            return;
        }
        if (message.from) {
            this.touchPeer(
                message.from,
                message.name,
                message.t === "hello" && this.session.isHost ? false : undefined
            );
        }
        const root = this.session.root;
        if (ROOTED_MESSAGE_TYPES.has(message.t) && !rootReadyForNet(root)) {
            // Ops (or a snapshot) arrived with no live game, e.g. while
            // sitting in the menu or between games. Drop them; the next
            // sync-check (or a manual resync) converges once a game loads.
            warn("dropping", message.t, "- no live game");
            if (message.t === "ops" || message.t === "welcome") {
                this.setSync("waiting for game…");
            }
            return;
        }
        switch (message.t) {
            case "state-received":
                if (
                    this.session.isHost &&
                    message.to === this.net.clientId &&
                    this.slots.has(message.from) &&
                    Number.isSafeInteger(message.revision) &&
                    message.revision >= 0 &&
                    message.revision <= this.baseline.revision &&
                    message.revision >= (this.stateReceipts.get(message.from) ?? -1)
                ) {
                    this.stateReceipts.set(message.from, message.revision);
                    const pending = this.pendingWelcomes.get(message.from);
                    if (pending && message.revision >= pending.revision)
                        this.pendingWelcomes.delete(message.from);
                }
                return;
            case "ping-req":
                if (message.to === "*" || message.to === this.net.clientId) {
                    this.net.send({ t: "pong", to: message.from, t0: message.t0 });
                }
                return;
            case "pong": {
                if (message.to !== this.net.clientId) {
                    return;
                }
                const peer = this.peers.get(message.from);
                if (peer) {
                    peer.rtt = Date.now() - message.t0;
                    this.renderPeers();
                }
                return;
            }
            case "hello":
                this.checkPeerVersion(message);
                if (this.session.isHost) {
                    const peer = this.peers.get(message.from);
                    if (peer) {
                        peer.isHost = false;
                    }
                    this.sendWelcome(message.from);
                    this.setStatus("hosting (" + (message.name || message.from) + " joined)", "ok");
                    this.renderPeers();
                } else {
                    // Client-to-client visibility: mark the host once known.
                    // The host's own hello is relayed like everyone else's.
                    this.renderPeers();
                }
                return;
            case "bye":
                if (!this.session.isHost && message.from === this.hostId) {
                    this.endSession();
                    this.net.disconnect();
                    this.setStatus("host left — playing solo copy", "warn");
                    this.renderPeers();
                    return;
                }
                this.peers.delete(message.from);
                this.mismatches.delete(message.from);
                this.lastResync.delete(message.from);
                this.slots.delete(message.from);
                this.acceptedSeq.delete(message.from);
                this.stateReceipts.delete(message.from);
                this.pendingWelcomes.delete(message.from);
                this.renderPeers();
                return;
            case "session-full":
                if (message.to === this.net.clientId) {
                    this.endSession();
                    this.net.disconnect();
                    this.setStatus("session full (8 players maximum)", "err");
                }
                return;
            case "welcome":
                if (message.to !== this.net.clientId && message.to !== "*") {
                    return;
                }
                if (this.session.isHost && message.from !== this.net.clientId) {
                    return; // Host never applies welcomes from others
                }
                if (!this.session.isHost && message.from !== this.hostId && this.hostId !== null) {
                    return; // Only the session host may snapshot us
                }
                if (!this.session.isHost) {
                    // First valid welcome elects the host; later ones must match
                    this.hostId = message.from;
                    this.touchPeer(message.from, message.name, true);
                    if (
                        Number.isInteger(message.slot) &&
                        message.slot >= 1 &&
                        message.slot <= MAX_CLIENT_SLOTS
                    ) {
                        this.slot = message.slot;
                    } else {
                        return;
                    }
                }
                this.applyWelcome(message.dump, message.revision, message.ack || 0);
                return;
            case "resync-request":
                if (this.session.isHost) {
                    const now = Date.now();
                    if (now - (this.lastResync.get(message.from) || 0) < 1000) {
                        warn("resync-request throttled for", message.from);
                        return;
                    }
                    this.lastResync.set(message.from, now);
                    this.sendWelcome(message.from);
                }
                return;
            case "sync-check":
                if (this.session.isHost) {
                    this.handleSyncCheck(message);
                }
                return;
            case "ops":
                if (this.session.isHost) {
                    this.acceptOps(message);
                }
                return;
            case "state":
                this.applyState(message);
                return;
            case "cursor": {
                const peer = this.peers.get(message.from);
                if (
                    peer &&
                    Number.isFinite(message.x) &&
                    Number.isFinite(message.y) &&
                    Math.abs(message.x) < 1e9 &&
                    Math.abs(message.y) < 1e9
                ) {
                    peer.cursor = { x: Math.round(message.x), y: Math.round(message.y), at: Date.now() };
                }
                return;
            }
            case "hub-upgrade":
                // v3 purchases are ordered, validated commands in ops.
                return;
            case "hub-state":
                // Included atomically with belt/machine state in v3 frames.
                return;
            case "deliver-batch":
                // The host already simulates the shared factory exactly once.
                return;
            case "chat": {
                const part = this.hud;
                if (part) {
                    part.addChat(message.name || message.from, String(message.text || ""));
                }
                return;
            }
            default:
                warn("unknown message type", message.t);
        }
    }

    /** Warn once per peer about mod version skew (different hashes lie). */
    checkPeerVersion(message) {
        const own = this.metadata && this.metadata.version;
        const theirs = message.mv;
        if (!own || !theirs || own === theirs || this.versionWarned.has(message.from)) {
            return;
        }
        this.versionWarned.add(message.from);
        const text =
            "version mismatch: " +
            (message.name || message.from) +
            " runs co-op " +
            theirs +
            ", you run " +
            own +
            " — update both sides";
        warn(text);
        const part = this.coopPart || this.hud;
        if (part) {
            part.addChat("system", text);
        }
    }

    handleSyncCheck(message) {
        const root = this.session.root;
        let own;
        try {
            own = computeSyncSummary(root);
        } catch (ex) {
            warn("sync hash failed", ex);
            return;
        }
        if (message.hash === own.hash) {
            this.mismatches.set(message.from, 0);
            this.setSync("in sync");
            return;
        }
        const count = (this.mismatches.get(message.from) || 0) + 1;
        this.mismatches.set(message.from, count);
        // During active building both sides legitimately disagree between
        // beats (ops in flight). Only treat quiet divergence as drift, but
        // never let a persistent mismatch ride longer than ~90s.
        const busy = Date.now() - this.lastOpActivity < 10000;
        const needed = busy ? 6 : 2;
        if (count < needed) {
            this.setSync(busy ? "building, checking…" : "checking…");
            return;
        }
        const now = Date.now();
        if (now - (this.lastResync.get(message.from) || 0) < RESYNC_COOLDOWN_MS) {
            this.setSync("diverged (cooling down)");
            return;
        }
        this.lastResync.set(message.from, now);
        this.mismatches.set(message.from, 0);
        const driftDiff = summarizeCodeDiff(own.codes, message.codes);
        log(
            "auto-resyncing diverged peer",
            message.from,
            "diff:",
            driftDiff,
            "own:",
            own.codes,
            "peer:",
            message.codes
        );
        try {
            window.__coopLastDrift = {
                at: new Date().toISOString(),
                peer: message.from,
                diff: driftDiff,
                ownCodes: own.codes,
                peerCodes: message.codes || "?",
            };
        } catch {
            // Diagnostics only
        }
        this.sendWelcome(message.from);
        const part = this.hud;
        if (part) {
            part.addChat(
                "system",
                "resynced diverged peer " + (message.name || message.from) + " (" + driftDiff + ")"
            );
        }
        this.setSync("resynced (" + driftDiff + ")");
    }

    sendWelcome(to, sharedDump = null) {
        if (!this.session || !this.session.isHost || !rootReadyForNet(this.session.root)) {
            return;
        }
        const awaitingSnapshot = id => {
            const pending = this.pendingWelcomes.get(id);
            return (
                this.net.sendStats.welcomes.has(id) ||
                (pending && Date.now() - pending.at < SNAPSHOT_TIMEOUT_MS)
            );
        };
        if (awaitingSnapshot(to)) return;
        if (!sharedDump && this.net.transportBusy()) return;
        if (to === "*") {
            const ids = [...this.slots.keys()].filter(id => this.peers.has(id) && !awaitingSnapshot(id));
            if (!ids.length) return;
            const dump = this.broadcastState(true);
            if (dump) for (const id of ids) this.sendWelcome(id, dump);
            return;
        }
        if (!this.slots.has(to)) {
            const used = new Set(this.slots.values());
            const slot = Array.from({ length: MAX_CLIENT_SLOTS }, (_, i) => i + 1).find(s => !used.has(s));
            if (slot === undefined) {
                this.net.send({ t: "session-full", to });
                return; // Never wrap and reuse another peer's UID residue.
            }
            this.slots.set(to, slot);
        }
        try {
            // All replicas and the joining peer get the same baseline revision.
            const dump = sharedDump || this.broadcastState(true);
            if (!dump) {
                return; // Retry after backpressure; never mislabel a snapshot's baseline.
            }
            if (
                !this.net.send({
                    t: "welcome",
                    to,
                    slot: this.slots.get(to),
                    dump,
                    revision: this.baseline.revision,
                    ack: this.acceptedSeq.get(to) || 0,
                })
            )
                return;
            this.stateReceipts.set(to, this.baseline.revision);
            this.pendingWelcomes.set(to, { revision: this.baseline.revision, at: Date.now() });
            log("sent welcome dump to", to, "revision", this.baseline.revision);
        } catch (ex) {
            warn("welcome dump failed", ex);
        }
    }

    applyWelcome(dump, revision, ack) {
        const root = this.session && this.session.root;
        if (!root || !Number.isSafeInteger(revision) || revision < 0) {
            return;
        }
        const serializer = new (shapez("SavegameSerializer"))();
        const initialized = root.gameInitialized;
        const cameraState = root.camera.serialize();
        try {
            // Validate before destroying the currently playable map.
            const validity = serializer.verifyLogicalErrors(dump);
            if (!validity.isGood()) {
                throw new Error("savegame invalid: " + validity.reason);
            }
            this.applyingRemote = true;
            root.gameInitialized = false;
            this.clearRoot(root);
            // Resource chunks belong to the previous map seed. Keeping them
            // makes joining a different save show/mine the old map's resources.
            root.map.chunksById.clear();
            root.map.aggregatesById.clear();
            root.buffers?.clear();
            const result = serializer.deserialize(dump, root);
            if (!result.isGood()) {
                throw new Error("savegame invalid: " + result.reason);
            }
            root.camera.deserialize(cameraState);
            root.time.logicTimeBudget = 0;
            this.broadcastNothingJustResyncUid(root);
            for (const data of dump.entities) {
                applyRuntime(root.entityMgr.findByUid(data.uid, false), data, root, window.shapez);
            }
            restoreAnalytics(root, dump.analytics);
            root.gameInitialized = initialized;
            root.signals.postLoadHook.dispatch();
            // The post-load hook has already rebuilt every ejector cache.
            refreshReplicaCaches(root, true, false);
            this.baseline.reset(revision, dump.entities, dump.beltPaths);
            this.lastStateAt = Date.now();
            this.unacknowledged = this.unacknowledged.filter(batch => batch.seq > ack);
            this.opSeq = Math.max(this.opSeq, ack);
            const predictions = this.unacknowledged.flatMap(batch => batch.ops).concat(this.pendingOps);
            if (predictions.length) {
                applyCommands(root, predictions, window.shapez);
            }
            this.predictionOps = predictions;
            this.awaitingWelcome = false;
            // A resync is also a recovery point for a detected sequence gap.
            // Reliable WebSockets normally make this redundant; dedup on the
            // host keeps resending an already-processed request harmless.
            for (const batch of this.unacknowledged) {
                this.net.send(batch);
            }
            this.welcomeFailures = 0;
            this.setStatus("connected (co-op)", "ok");
            this.setSync("host state #" + revision);
            this.net.send({ t: "state-received", to: this.hostId, revision });
            log("applied welcome dump", revision);
        } catch (ex) {
            warn("applyWelcome failed, requesting a fresh snapshot", ex);
            this.welcomeFailures = (this.welcomeFailures || 0) + 1;
            this.setStatus("sync failed, retrying…", "err");
            // A rejected request must not strand awaitingWelcome forever.
            this.awaitingWelcome = true;
            if (this.welcomeFailures <= 3) {
                setTimeout(() => this.requestResync(), 1100);
            } else {
                this.setStatus("sync failed, use Req sync", "err");
            }
        } finally {
            root.gameInitialized = initialized;
            this.applyingRemote = false;
        }
        this.flushOps();
    }

    clearRoot(root) {
        const entities = Array.from(root.entityMgr.entities.values());
        for (const entity of entities) {
            try {
                root.map.removeStaticEntity(entity);
            } catch {
                // Entity may already be half-removed; continue
            }
            root.entityMgr.destroyEntity(entity);
        }
        root.entityMgr.processDestroyList();
        // A full wipe invalidates the whole mass selection; stale UIDs
        // crash the selector's draw pass (null.components).
        try {
            const parts = root.hud && root.hud.parts;
            const ms = parts && parts.massSelector;
            if (ms && typeof ms.clearSelection === "function") {
                ms.clearSelection();
            } else if (ms && ms.selectedUids) {
                ms.selectedUids.clear();
            }
        } catch {
            // Best effort
        }
        // NOTE: belt paths are NOT cleared here; deserializePaths (which
        // always follows in the same dump apply) owns that invariant, so
        // paths end up exactly as serialized — never duplicated.
    }

    broadcastNothingJustResyncUid(root) {
        // After a full-state sync, make sure local UID allocation continues
        // past every UID in the dump (client role already steps oddly).
        let maxUid = 9999;
        for (const uid of root.entityMgr.entities.keys()) {
            if (uid > maxUid) {
                maxUid = uid;
            }
        }
        const mgr = root.entityMgr;
        if (mgr.nextUid <= maxUid) {
            mgr.nextUid = maxUid + 1;
        }
    }
}
