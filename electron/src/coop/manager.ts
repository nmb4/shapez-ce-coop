import { BrowserWindow } from "electron";
import { getLanAddresses, LanInterface } from "./addresses.js";
import { CoopWsServer } from "./ws_server.js";
import type { CoopLogger } from "./logger.js";

export const COOP_DEFAULT_PORT = 47821;

export interface CoopStatus {
    running: boolean;
    port: number;
    peers: number;
    addresses: LanInterface[];
}

/**
 * Owns the built-in co-op relay server in the Electron main process.
 *
 * The relay is intentionally dumb: it forwards WebSocket text messages
 * between connected game clients (the host's own renderer connects as a
 * client too). All game protocol logic lives in the renderer-side co-op
 * mod, so old and new mod versions interoperate as long as the JSON
 * protocol in mods/coop/PROTOCOL.md is respected.
 */
export class CoopHostManager {
    private readonly server = new CoopWsServer();
    private window: BrowserWindow | null = null;
    private port = 0;
    private pingTimer: NodeJS.Timeout | null = null;

    constructor(private readonly log?: CoopLogger) {
        this.server.onMessage = (peer, text) => {
            // Relay to everyone except the sender (includes host renderer)
            this.server.broadcast(text, peer.id);
        };
        this.server.onPeersChanged = peers => {
            this.log?.write("info", `coop relay peers: ${peers}`);
            this.notifyPeers(peers);
        };
    }

    setWindow(window: BrowserWindow | null): void {
        this.window = window;
    }

    private notifyPeers(peers: number): void {
        try {
            const contents = this.window?.webContents;
            if (contents && !contents.isDestroyed()) {
                contents.send("coop-peer-count", peers);
            }
        } catch {
            // Window gone; relay keeps running headless
        }
    }

    async start(port: number = COOP_DEFAULT_PORT): Promise<CoopStatus> {
        if (!this.server.isRunning()) {
            this.port = await this.server.start(port);
            this.log?.write("info", `coop relay started on :${this.port}`);
            this.pingTimer ??= setInterval(() => {
                this.server.broadcast(JSON.stringify({ t: "ping", ts: Date.now() }));
            }, 25000);
            this.pingTimer.unref?.();
        }
        return this.status();
    }

    async stop(): Promise<CoopStatus> {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        await this.server.stop();
        this.port = 0;
        this.log?.write("info", "coop relay stopped");
        this.notifyPeers(0);
        return this.status();
    }

    status(): CoopStatus {
        return {
            running: this.server.isRunning(),
            port: this.port,
            peers: this.server.peerCount,
            addresses: getLanAddresses(),
        };
    }
}
