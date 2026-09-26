import { createHash } from "node:crypto";
import { createServer, IncomingMessage, Server } from "node:http";
import { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Full-state join dumps can be several MB of JSON; stay generous but bounded.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// RFC 6455 opcodes we care about
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function computeAccept(key: string): string {
    return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function buildFrame(payload: Buffer, opcode: number): Buffer {
    const headerBytes = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
    const frame = Buffer.alloc(headerBytes + payload.length);
    frame[0] = 0x80 | (opcode & 0x0f); // FIN + opcode, server frames are never masked
    if (payload.length < 126) {
        frame[1] = payload.length;
    } else if (payload.length < 65536) {
        frame[1] = 126;
        frame.writeUInt16BE(payload.length, 2);
    } else {
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    payload.copy(frame, headerBytes);
    return frame;
}

export class CoopWsPeer {
    readonly id: number;
    private readonly socket: Duplex;
    private recvBuffer: Buffer = Buffer.alloc(0);
    private fragmentedOpcode = -1;
    private readonly fragmentedParts: Buffer[] = [];
    private fragmentedBytes = 0;
    private closed = false;

    onMessage: ((peer: CoopWsPeer, text: string) => void) | null = null;
    onClose: ((peer: CoopWsPeer) => void) | null = null;

    constructor(id: number, socket: Duplex, head: Buffer) {
        this.id = id;
        this.socket = socket;
        this.socket.on("data", data => this.onData(data));
        this.socket.on("close", () => this.handleClose());
        this.socket.on("error", () => this.handleClose());
        if (head.length > 0) {
            // The HTTP parser may already have read WebSocket bytes
            this.onData(head);
        }
    }

    sendText(text: string): void {
        if (this.closed) {
            return;
        }
        this.socket.write(buildFrame(Buffer.from(text, "utf-8"), OP_TEXT));
    }

    close(): void {
        if (this.closed) {
            return;
        }
        try {
            this.socket.write(buildFrame(Buffer.alloc(0), OP_CLOSE));
        } catch {
            // Ignore write errors during close
        }
        this.socket.destroy();
        this.handleClose();
    }

    private handleClose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.onClose?.(this);
    }

    private onData(data: Buffer): void {
        this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
        try {
            this.parseBuffer();
        } catch {
            // Malformed frame: terminate the connection per RFC 6455 §7.1.7
            this.close();
        }
    }

    private parseBuffer(): void {
        for (;;) {
            if (this.recvBuffer.length < 2) {
                return;
            }
            const fin = (this.recvBuffer[0] & 0x80) !== 0;
            const opcode = this.recvBuffer[0] & 0x0f;
            const masked = (this.recvBuffer[1] & 0x80) !== 0;
            let payloadLen = this.recvBuffer[1] & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
                if (this.recvBuffer.length < 4) {
                    return;
                }
                payloadLen = this.recvBuffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this.recvBuffer.length < 10) {
                    return;
                }
                const big = this.recvBuffer.readBigUInt64BE(2);
                if (big > BigInt(MAX_MESSAGE_BYTES)) {
                    throw new Error("Frame too large");
                }
                payloadLen = Number(big);
                offset = 10;
            }

            const maskBytes = masked ? 4 : 0;
            if (this.recvBuffer.length < offset + maskBytes + payloadLen) {
                return; // Wait for more data
            }

            let payload = this.recvBuffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
            if (masked) {
                const mask = this.recvBuffer.subarray(offset, offset + 4);
                const raw = Buffer.alloc(payload.length);
                for (let i = 0; i < payload.length; ++i) {
                    raw[i] = payload[i] ^ mask[i % 4];
                }
                payload = raw;
            }
            this.recvBuffer = this.recvBuffer.subarray(offset + maskBytes + payloadLen);

            this.handleFrame(fin, opcode, payload);
        }
    }

    private pushFragment(opcode: number, chunk: Buffer): void {
        if (opcode !== OP_CONT) {
            // Start of a new fragmented message; drop any stale partial state
            this.fragmentedParts.length = 0;
            this.fragmentedBytes = 0;
            this.fragmentedOpcode = opcode;
        }
        this.fragmentedBytes += chunk.length;
        if (this.fragmentedBytes > MAX_MESSAGE_BYTES) {
            throw new Error("Fragmented message too large");
        }
        this.fragmentedParts.push(chunk);
    }

    private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case OP_CLOSE:
                this.close();
                return;
            case OP_PING:
                if (!fin) {
                    throw new Error("Fragmented control frame");
                }
                this.socket.write(buildFrame(payload, OP_PONG));
                return;
            case OP_PONG:
                return; // Keep-alive only
            case OP_TEXT:
            case OP_BINARY:
            case OP_CONT: {
                if (opcode === OP_CONT && this.fragmentedOpcode === -1) {
                    throw new Error("Unexpected continuation frame");
                }
                if (!fin) {
                    this.pushFragment(opcode, payload);
                    return;
                }
                let message: Buffer;
                if (this.fragmentedOpcode === -1) {
                    message = payload;
                } else {
                    this.pushFragment(opcode, payload);
                    message = Buffer.concat(this.fragmentedParts);
                    this.fragmentedParts.length = 0;
                    this.fragmentedBytes = 0;
                    this.fragmentedOpcode = -1;
                }
                if (message.length > MAX_MESSAGE_BYTES) {
                    throw new Error("Message too large");
                }
                this.onMessage?.(this, message.toString("utf-8"));
                return;
            }
            default:
                throw new Error("Unsupported opcode: " + opcode);
        }
    }
}

export class CoopWsServer {
    private server: Server | null = null;
    private nextPeerId = 1;
    private readonly peers = new Map<number, CoopWsPeer>();

    onMessage: ((peer: CoopWsPeer, text: string) => void) | null = null;
    onPeersChanged: ((peerCount: number) => void) | null = null;

    get peerCount(): number {
        return this.peers.size;
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    start(port: number): Promise<number> {
        if (this.server) {
            return Promise.resolve(this.boundPort());
        }

        return new Promise((resolve, reject) => {
            const server = createServer((_req, res) => {
                res.writeHead(426, { "Content-Type": "text/plain" });
                res.end("shapez CE co-op relay: use a WebSocket client");
            });

            server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
                this.handleUpgradeRequest(req, socket, head)
            );
            server.on("error", (err: NodeJS.ErrnoException) => {
                if (!this.server) {
                    reject(err);
                }
            });
            server.listen(port, () => {
                this.server = server;
                resolve(this.boundPort());
            });
        });
    }

    stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        for (const peer of this.peers.values()) {
            peer.onMessage = null;
            peer.onClose = null;
            peer.close();
        }
        this.peers.clear();
        if (!server) {
            return Promise.resolve();
        }
        return new Promise(resolve => server.close(() => resolve()));
    }

    broadcast(text: string, exceptId = -1): void {
        for (const peer of this.peers.values()) {
            if (peer.id !== exceptId) {
                peer.sendText(text);
            }
        }
    }

    private boundPort(): number {
        const addr = this.server?.address();
        return typeof addr === "object" && addr !== null ? addr.port : 0;
    }

    /** Bound as the http server 'upgrade' listener. */
    handleUpgradeRequest(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const key = req.headers["sec-websocket-key"];
        const version = req.headers["sec-websocket-version"];
        if (typeof key !== "string" || version !== "13") {
            socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }

        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`
        );

        const peer = new CoopWsPeer(this.nextPeerId++, socket, head);
        this.peers.set(peer.id, peer);
        peer.onMessage = (p, text) => this.onMessage?.(p, text);
        peer.onClose = p => {
            this.peers.delete(p.id);
            this.onPeersChanged?.(this.peers.size);
        };
        this.onPeersChanged?.(this.peers.size);
    }
}
