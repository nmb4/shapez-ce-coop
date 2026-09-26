// shapez CE co-op mod (v1): host-authoritative shared-map co-op.
//
// Design (see PROTOCOL.md):
//  - Transport: native WebSocket to the built-in relay in the Electron main
//    process (electron/src/coop/). The relay is dumb broadcast; the host's
//    own renderer connects as a client too.
//  - Join: host sends a full savegame dump (`welcome`); the client wipes its
//    live root and deserializes it (same path as savegame loading).
//  - Steady state: building place/delete ops are replicated in order.
//    Blueprint pastes are batched via the bulk-operation signal.
//  - Hub: host-authoritative. Clients batch their hub deliveries to the host,
//    the host replays them through HubGoals.handleDefinitionDelivered and
//    broadcasts hub-state every few seconds + on goal completion.
//  - Determinism aid: fixed 60 Hz tick while a session is active, and
//    UID slots (stride 8: host 0, clients 1..7) so allocations never collide.
//  - Drift guard: structural sync-checks with auto-resync backstop.
//
// Limits: 8 players max, no lag compensation, no auth/encryption
// (LAN/trusted only), dialogs pause the local sim (short-term divergence).

const ModBase = window.shapez.Mod;

const COOP_TICKRATE = 60;
const COOP_VERSION = 2;
const COOP_DEFAULT_PORT = 47821;
const HUB_STATE_INTERVAL_MS = 5000;
const DELIVERY_FLUSH_MS = 2000;
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
const MAX_BATCH_KEYS = 256;
const MAX_REPLAY_PER_FRAME = 2000;
// Remote cursor broadcast: 10 Hz while in a session, peers expire them fast.
const CURSOR_MS = 100;
const CURSOR_EXPIRE_MS = 2500;
// Host spreads each delivery batch over ~2s of frames so analytics slices
// (and throughput goals) see smooth rates instead of one spike.
const DELIVERY_SPREAD_FRAMES = 120;
const DELIVERY_QUEUE_CAP = 50000;

let activeMod = null;

function log(...args) {
    console.log("[coop]", ...args);
}
function warn(...args) {
    console.warn("[coop]", ...args);
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
                uid + ":" + staticComp.code + ":" + staticComp.rotation + ":" +
                staticComp.origin.x + "," + staticComp.origin.y
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
function parseJoinInput(input) {    if (!input) {
        return null;
    }
    let text = String(input).trim();
    if (!text) {
        return null;
    }
    const schemeMatch = text.match(/^([a-z]+):\/\/(.*)$/i);
    let rest = text;
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        rest = schemeMatch[2];
        if (scheme === "http") {
            return "ws://" + rest;
        }
        if (scheme === "https") {
            return "wss://" + rest;
        }
        if (scheme === "ws" || scheme === "wss" || scheme === "shapez") {
            return (scheme === "shapez" ? "ws://" : scheme + "://") + rest;
        }
        return null;
    }
    // Bare host[:port]
    if (/^[A-Za-z0-9.[\]:-]+(:\d+)?$/.test(rest)) {
        if (!/:\d+$/.test(rest) || rest.endsWith("]")) {
            rest += ":" + COOP_DEFAULT_PORT;
        }
        return "ws://" + rest;
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
        this.name = "Player";
        this.isHost = false;
        this.connected = false;
        this.onMessage = null;
        this.onOpen = null;
        this.onClose = null;
    }

    connect(url) {
        this.disconnect();
        this.url = url;
        log("connecting to", url);
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket !== socket) {
                return; // Stale event from a previous connection
            }
            this.connected = true;
            log("connected as", this.clientId);
            this.send({ t: "hello", v: COOP_VERSION, from: this.clientId, name: this.name });
            if (this.onOpen) {
                this.onOpen();
            }
        };
        socket.onmessage = event => {
            if (this.socket !== socket) {
                return;
            }
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (ex) {
                warn("dropping non-JSON message", ex);
                return;
            }
            if (message.from === this.clientId) {
                return; // Relay echoes our own messages back to us
            }
            if (this.onMessage) {
                this.onMessage(message);
            }
        };
        socket.onclose = () => {
            if (this.socket !== socket) {
                return; // Stale close; a newer connection is active
            }
            this.connected = false;
            this.socket = null;
            log("disconnected");
            if (this.onClose) {
                this.onClose();
            }
        };
        socket.onerror = () => {
            // onclose follows; surface it through the hud status
            warn("socket error");
        };
    }

    disconnect() {
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
        message.from = this.clientId;
        message.v = COOP_VERSION;
        try {
            this.socket.send(JSON.stringify(message));
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
        const versionEl = query(".coopVersion");
        if (versionEl && activeMod && activeMod.metadata && activeMod.metadata.version) {
            versionEl.textContent = " v" + activeMod.metadata.version;
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
        this.trackClicks(this.hostButton, () => activeMod && activeMod.hostGame(query(".coopName").value));
        this.trackClicks(query(".coopJoin"), () =>
            activeMod && activeMod.joinGame(query(".coopAddr").value, query(".coopName").value)
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
        this.slot = 1; // UID slot (0 = host); assigned by welcome, 1 pre-join
        this.hostId = null; // clientId of the session host, once known
        this.slots = new Map(); // host: peerId -> slot (stable across rejoins)
        this.nextSlot = 1;
        this.awaitingWelcome = false; // client: hold ops until first snapshot
        this.hookedRoots = new WeakSet();
        this.lastResyncRequest = 0;
        this.deliveryCounts = new Map();
        this.deliveryQueue = []; // host-side smoothed replay: { def, remaining, perFrame }
        this.peers = new Map(); // clientId -> { name, lastSeen, rtt, isHost }
        this.mismatches = new Map(); // host: clientId -> consecutive sync-check mismatches
        this.lastResync = new Map(); // host: clientId -> timestamp of last auto resync
        this.hubTimer = null;
        this.deliveryTimer = null;
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

        // --- Fixed tickrate while a session is active ---------------------
        const mod = this;
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

        // --- Replicate local building ops ----------------------------------
        // NOTE: runAfterMethod does not receive the return value, so the
        // placement hooks use replaceMethod to capture the result entity.
        this.modInterface.replaceMethod(GameLogic, "tryPlaceBuilding", function (oldFn, args) {
            const result = oldFn(...args);
            if (!mod.session || mod.applyingRemote || !result) {
                return result;
            }
            mod.queueOp({ k: "place", uid: result.uid, entity: result.serialize() });
            return result;
        });

        this.modInterface.replaceMethod(GameLogic, "tryDeleteBuilding", function (oldFn, args) {
            const building = args[0];
            const uid = building ? building.uid : null;
            const result = oldFn(...args);
            if (result && uid !== null) {
                // Always (offline, remote-applied, replaced): a destroyed
                // entity left in the mass selector's set crashes its draw
                // pass on the next frame (null.components).
                mod.dropFromMassSelection(this.root, uid);
            }
            if (!mod.session || mod.applyingRemote || !result || !building) {
                return result;
            }
            mod.queueOp({ k: "delete", uid: building.uid });
            return result;
        });

        // --- Replicate hub upgrade purchases --------------------------------
        this.modInterface.replaceMethod(HubGoals, "tryUnlockUpgrade", function (oldFn, args) {
            const result = oldFn(...args);
            if (!mod.session || mod.applyingRemote || !result) {
                return result;
            }
            const root = mod.session.root;
            mod.net.send({
                t: "hub-upgrade",
                upgradeId: args[0],
                level: root.hubGoals.getUpgradeLevel(args[0]),
            });
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
            this.deliveryCounts.clear();
            this.deliveryQueue = [];
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
        root.signals.gameFrameStarted.add(() => this.drainDeliveries());
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
                this.setStatus(wasHost ? "game closed (host left)" : "game closed", "warn");
                this.renderPeers();
            }
        });
        root.signals.storyGoalCompleted.add(() => {
            if (this.session && this.session.isHost) {
                this.broadcastHubState();
            }
        });
        root.signals.shapeDelivered.add(definition => {
            if (!this.session || this.session.isHost || this.applyingRemote) {
                return;
            }
            const key = definition.getHash();
            this.deliveryCounts.set(key, (this.deliveryCounts.get(key) || 0) + 1);
        });
    }

    async hostGame(name) {
        if (this.session) {
            await this.leaveGame();
        }
        const root = this.requireRoot();
        if (!root) {
            return;
        }
        if (name) {
            this.net.name = name;
        }
        let status;
        try {
            status = await ipcRenderer.invoke("coop-start", COOP_DEFAULT_PORT);
        } catch (ex) {
            warn("coop-start failed", ex);
            this.setStatus("host failed (see console)", "err");
            return;
        }
        this.net.isHost = true;
        this.beginSession(root, true);
        this.net.connect("ws://127.0.0.1:" + status.port);
        const invites = buildInvites(status.addresses, status.port);
        this.lastInvites = invites;
        const part = this.hud;
        if (part) {
            if (invites.length > 0) {
                part.setInvites(invites);
            } else {
                part.setInvite("ws://<this-pc-ip>:" + status.port);
            }
        }
        this.setStatus("hosting :" + status.port, "ok");
        log("hosting on port", status.port);
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
            this.setStatus("invalid join code", "err");
            return;
        }
        if (name) {
            this.net.name = name;
        }
        this.net.isHost = false;
        this.beginSession(root, false);
        this.net.connect(url);
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
        this.session = { root, isHost };
        this.pendingOps = [];
        this.flushScheduled = false;
        this.deliveryCounts.clear();
        this.deliveryQueue = [];
        this.lastCursorSent = null;
        this.peers.clear();
        this.mismatches.clear();
        this.lastResync.clear();
        this.awaitingWelcome = !isHost;
        if (isHost) {
            this.hostId = this.net.clientId;
            this.slots.clear();
            this.nextSlot = 1;
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
        this.session = null;
        this.pendingOps = [];
        this.flushScheduled = false;
        this.deliveryCounts.clear();
        this.deliveryQueue = [];
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
        this.hubTimer = setInterval(() => this.broadcastHubState(), HUB_STATE_INTERVAL_MS);
    }

    startClientTimers() {
        this.endRoleTimers();
        this.deliveryTimer = setInterval(() => this.flushDeliveries(), DELIVERY_FLUSH_MS);
        this.syncTimer = setInterval(() => this.sendSyncCheck(), SYNC_CHECK_MS);
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
        if (this.deliveryTimer) {
            clearInterval(this.deliveryTimer);
            this.deliveryTimer = null;
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
        if (existing) {
            existing.lastSeen = Date.now();
            if (name) {
                existing.name = name;
            }
            if (isHost !== undefined) {
                existing.isHost = isHost;
            }
        } else {
            this.peers.set(id, {
                name: name || id,
                lastSeen: Date.now(),
                rtt: null,
                isHost: !!isHost,
            });
        }
        this.renderPeers();
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
        if (!this.session.isHost) {
            // Drop ghosts from the dead connection; hellos rebuild the list.
            for (const id of this.peers.keys()) {
                if (id !== this.net.clientId) {
                    this.peers.delete(id);
                }
            }
            this.renderPeers();
            this.flushOps();
            this.setStatus("syncing…", "warn");
        } else if (this.session.isHost) {
            this.setStatus("hosting (waiting for join)", "ok");
        }
    }

    onSocketClose() {
        if (!this.session) {
            return;
        }
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
        if (!this.session || this.session.isHost || !rootReadyForNet(this.session.root)) {
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

    /** Recompute every belt direction against the complete map.
     *  Op batches and snapshots apply entities one by one; intermediate
     *  neighbor recomputes can strand a belt with a direction decided from
     *  a partial neighborhood. A final pass over all belts converges both
     *  peers to the same pure function of the same map. Runs after
     *  snapshots only (steady-state batches self-converge on arrival). */
    reconvergeBelts(root) {
        let system = null;
        try {
            system = root.systemMgr.systems.belt;
        } catch {
            return 0;
        }
        if (!system) {
            return 0;
        }
        let fixed = 0;
        const belts = [];
        try {
            for (const entity of root.entityMgr.entities.values()) {
                if (entity.components && entity.components.Belt) {
                    belts.push(entity);
                }
            }
        } catch {
            return 0;
        }
        this.applyingRemote = true;
        try {
            for (const belt of belts) {
                try {
                    system.updateSurroundingBeltPlacement(belt);
                } catch (ex) {
                    warn("belt reconverge failed", ex);
                }
            }
            fixed = belts.length;
        } finally {
            this.applyingRemote = false;
        }
        return fixed;
    }

    /** Client: ask the host for a full snapshot. */
    requestResync() {
        if (!this.session || this.session.isHost) {
            return;
        }
        const now = Date.now();
        if (now - this.lastResyncRequest < RESYNC_COOLDOWN_MS) {
            this.setSync("resync on cooldown…");
            return;
        }
        this.lastResyncRequest = now;
        this.awaitingWelcome = true;
        this.net.send({ t: "resync-request" });
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
        this.pendingOps.push(op);
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
        if (!this.session || ops.length === 0) {
            return;
        }
        if (!this.net.send({ t: "ops", seq: this.opSeq++, ops })) {
            // Socket down: requeue at the front, order preserved
            this.pendingOps = ops.concat(this.pendingOps);
        }
    }

    flushDeliveries() {
        if (!this.session || this.session.isHost || this.deliveryCounts.size === 0) {
            return;
        }
        if (this.deliveryCounts.size > MAX_BATCH_KEYS) {
            warn("deliver-batch too large, truncating");
        }
        const batch = {};
        let keys = 0;
        for (const [key, count] of this.deliveryCounts) {
            if (keys++ >= MAX_BATCH_KEYS) {
                break;
            }
            batch[key] = count;
        }
        if (!this.net.send({ t: "deliver-batch", batch })) {
            return; // Socket down: keep counts, retry on the next beat
        }
        for (const key of Object.keys(batch)) {
            this.deliveryCounts.delete(key);
        }
    }

    broadcastHubState() {
        if (!this.session || !this.session.isHost || !rootReadyForNet(this.session.root)) {
            return;
        }
        try {
            this.net.send({ t: "hub-state", hub: this.session.root.hubGoals.serialize() });
        } catch (ex) {
            warn("hub-state serialize failed", ex);
        }
    }

    // --- Incoming messages ----------------------------------------------------

    handleMessage(message) {
        if (!this.session) {
            return;
        }
        if (message.v !== COOP_VERSION) {
            warn("dropping message with wrong version", message.v);
            return;
        }
        if (message.from) {
            this.touchPeer(message.from, message.name, message.t === "hello" && this.session.isHost ? false : undefined);
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
            case "ping":
                return; // Keep-alive from the relay
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
                this.peers.delete(message.from);
                this.mismatches.delete(message.from);
                this.lastResync.delete(message.from);
                this.renderPeers();
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
                    if (Number.isInteger(message.slot) && message.slot >= 0 && message.slot <= MAX_CLIENT_SLOTS) {
                        this.slot = message.slot;
                    }
                }
                this.applyWelcome(message.dump);
                return;
            case "resync-request":
                if (this.session.isHost) {
                    const now = Date.now();
                    if (now - (this.lastResync.get(message.from) || 0) < RESYNC_COOLDOWN_MS) {
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
                this.applyOps(root, message.ops || []);
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
                this.applyHubUpgrade(root, message);
                return;
            case "hub-state":
                if (this.session.isHost) {
                    return;
                }
                if (this.hostId !== null && message.from !== this.hostId) {
                    return; // Only the session host is authoritative
                }
                this.touchPeer(message.from, message.name, true);
                this.applyHubState(root, message);
                return;
            case "deliver-batch":
                if (this.session.isHost) {
                    this.applyDeliveryBatch(root, message.batch || {});
                }
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
        if (count < 2) {
            // One mismatch can be an in-flight op; wait for the next check.
            this.setSync("checking…");
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
        log("auto-resyncing diverged peer", message.from, "own:", own.codes, "peer:", message.codes);
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
            part.addChat("system", "resynced diverged peer " + (message.name || message.from) + " (" + driftDiff + ")");
        }
        this.setSync("resynced (" + driftDiff + ")");
    }

    sendWelcome(to) {
        if (!this.session || !rootReadyForNet(this.session.root)) {
            warn("welcome skipped - no live game");
            return;
        }
        // Stable per-peer UID slots (host = 0); rejoins keep their slot.
        let slot = null;
        if (to !== "*" && this.session.isHost) {
            if (!this.slots.has(to)) {
                let s = this.nextSlot++;
                if (s > MAX_CLIENT_SLOTS) {
                    s = ((s - 1) % MAX_CLIENT_SLOTS) + 1;
                }
                this.slots.set(to, s);
            }
            slot = this.slots.get(to);
        }
        try {
            const SavegameSerializer = shapez("SavegameSerializer");
            const dump = new SavegameSerializer().generateDumpFromGameRoot(this.session.root, false);
            this.net.send({ t: "welcome", to, slot, dump });
            log("sent welcome dump to", to);
        } catch (ex) {
            warn("welcome dump failed", ex);
        }
    }

    applyWelcome(dump) {
        const root = this.session && this.session.root;
        if (!root) {
            return;
        }
        // Don't teleport the player on every resync; the snapshot is about
        // buildings, not where we look.
        let cameraState = null;
        try {
            cameraState = root.camera.serialize();
        } catch {
            // Root partially ready; proceed without restoring
        }
        try {
            this.clearRoot(root);
            const SavegameSerializer = shapez("SavegameSerializer");
            const result = new SavegameSerializer().deserialize(dump, root);
            if (result && result.isGood && !result.isGood()) {
                throw new Error("savegame invalid: " + result.reason);
            }
            if (cameraState) {
                try {
                    root.camera.deserialize(cameraState);
                } catch {
                    // Cosmetic; ignore
                }
            }
            this.broadcastNothingJustResyncUid(root);
            this.reconvergeBelts(root);
            this.setStatus("connected (co-op)", "ok");
            this.setSync("in sync");
            log("applied welcome dump");
        } catch (ex) {
            warn("applyWelcome failed, requesting a fresh snapshot", ex);
            this.welcomeFailures = (this.welcomeFailures || 0) + 1;
            if (this.welcomeFailures > 3) {
                this.setStatus("sync failed, use Req sync", "err");
                return;
            }
            this.setStatus("sync failed, retrying…", "err");
            this.lastResyncRequest = 0; // allow this one immediate retry
            this.requestResync();
            return;
        }
        this.welcomeFailures = 0;
        // Ops made while "syncing…" are causally newer than the snapshot
        // (duplicates are skipped by UID); replay them instead of dropping.
        this.awaitingWelcome = false;
        this.flushOps();
    }

    clearRoot(root) {
        this.applyingRemote = true;
        try {
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
            // Belt paths are rebuilt incrementally on entity add AND appended
            // by deserializePaths — without clearing, every resync duplicates
            // all belts and simulates them twice.
            try {
                const belt = root.systemMgr.systems.belt;
                if (belt && Array.isArray(belt.beltPaths)) {
                    belt.beltPaths.length = 0;
                }
            } catch {
                // Non-fatal; belt system will reconcile on next update
            }
        } finally {
            this.applyingRemote = false;
        }
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

    applyOps(root, ops) {
        if (!Array.isArray(ops) || ops.length === 0) {
            return;
        }
        if (ops.length > MAX_OPS_PER_MESSAGE) {
            warn("ops batch too large, truncating", ops.length);
            ops = ops.slice(0, MAX_OPS_PER_MESSAGE);
        }
        const SerializerInternal = shapez("SerializerInternal");
        const internal = new SerializerInternal();
        this.applyingRemote = true;
        try {
            for (const op of ops) {
                try {
                    if (op.k === "place") {
                        // Raw map check: findByUid hides queued-for-destroy
                        // entities, which would let a crafted batch resurrect
                        // a UID over a pending destroy.
                        if (!op.entity || op.entity.uid !== op.uid || root.entityMgr.entities.has(op.uid)) {
                            continue;
                        }
                        internal.deserializeEntity(root, op.entity);
                        const mgr = root.entityMgr;
                        if (mgr.nextUid <= op.uid) {
                            mgr.nextUid = op.uid + 1;
                        }
                    } else if (op.k === "delete") {
                        const entity = root.entityMgr.findByUid(op.uid, false);
                        if (entity) {
                            root.logic.tryDeleteBuilding(entity);
                        }
                    }
                } catch (ex) {
                    warn("op apply failed", op.k, op.uid, ex);
                }
            }
            root.entityMgr.processDestroyList();
        } finally {
            this.applyingRemote = false;
        }
    }

    applyHubUpgrade(root, message) {
        const tiers = root.gameMode.getUpgrades()[message.upgradeId];
        if (!tiers) {
            warn("unknown upgrade", message.upgradeId);
            return;
        }
        const target = Math.min(message.level | 0, tiers.length);
        this.applyingRemote = true;
        try {
            let guard = 0;
            while (root.hubGoals.getUpgradeLevel(message.upgradeId) < target && guard++ < 50) {
                if (!root.hubGoals.tryUnlockUpgrade(message.upgradeId)) {
                    break;
                }
            }
            // The purchaser already paid: if funds lagged behind the
            // broadcast (delivery batches arrive every 2s), force-converge
            // instead of letting the next hub-state silently revert it.
            let level = root.hubGoals.getUpgradeLevel(message.upgradeId);
            while (level < target) {
                root.hubGoals.upgradeLevels[message.upgradeId] = level + 1;
                root.hubGoals.upgradeImprovements[message.upgradeId] += tiers[level].improvement;
                level++;
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    applyHubState(root, message) {
        if (this.session.isHost) {
            return; // Host is authoritative; ignore echoes
        }
        this.applyingRemote = true;
        try {
            const error = root.hubGoals.deserialize(message.hub, root);
            if (error) {
                warn("hub-state deserialize error", error);
            }
        } catch (ex) {
            warn("hub-state apply failed", ex);
        } finally {
            this.applyingRemote = false;
        }
    }

    applyDeliveryBatch(root, batch) {
        // Resolve definitions once, then spread the replay over frames so
        // analytics slices observe smooth rates: exact counts AND correct
        // throughput for throughputOnly goals.
        for (const key of Object.keys(batch)) {
            let count = batch[key] | 0;
            if (count <= 0) {
                continue;
            }
            // Cap per-message replay so a huge backlog can't freeze the tick
            count = Math.min(count, 20000);
            let definition;
            try {
                definition = root.shapeDefinitionMgr.getShapeFromShortKey(key);
            } catch {
                warn("unknown shape key in deliver-batch", key);
                continue;
            }
            this.deliveryQueue.push({
                def: definition,
                remaining: count,
                perFrame: Math.max(1, Math.ceil(count / DELIVERY_SPREAD_FRAMES)),
            });
        }
        if (this.deliveryQueue.length > DELIVERY_QUEUE_CAP) {
            this.deliveryQueue.splice(0, this.deliveryQueue.length - DELIVERY_QUEUE_CAP);
            warn("delivery queue overflow, dropped oldest entries");
        }
    }

    drainDeliveries() {
        if (!this.session || !this.session.isHost || this.deliveryQueue.length === 0) {
            return;
        }
        const root = this.session.root;
        this.applyingRemote = true;
        try {
            let budget = MAX_REPLAY_PER_FRAME;
            for (let i = this.deliveryQueue.length - 1; i >= 0 && budget > 0; --i) {
                const entry = this.deliveryQueue[i];
                const n = Math.min(entry.perFrame, entry.remaining, budget);
                for (let k = 0; k < n; ++k) {
                    root.hubGoals.handleDefinitionDelivered(entry.def);
                }
                entry.remaining -= n;
                budget -= n;
                if (entry.remaining <= 0) {
                    this.deliveryQueue.splice(i, 1);
                }
            }
        } finally {
            this.applyingRemote = false;
        }
    }
}
