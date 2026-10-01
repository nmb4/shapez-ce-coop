import { decodeWireMessage } from "./transport.js";
import { unpackStateFrameAsync } from "./replication.js";

// Blob workers inherit the renderer's origin. Import the mod inside that worker
// instead of constructing a cross-origin Worker(mod://...), which Chromium rejects.
function createDecoderWorker() {
    const moduleUrl = new URL("./decode_worker.js", import.meta.url).href;
    const source = `
        const ready = import(${JSON.stringify(moduleUrl)});
        self.onmessage = async ({ data }) => {
            let module;
            try { module = await ready; }
            catch (error) { self.postMessage({ id: data.id, fatal: String(error) }); return; }
            const result = await module.decodeRequest(data);
            self.postMessage(result, result.payload ? [result.payload.buffer] : []);
        };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
        const worker = new Worker(url);
        return { worker, release: () => URL.revokeObjectURL(url) };
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

export class WireDecoder {
    constructor({ createWorker = createDecoderWorker, onFallback = () => {}, timeoutMs = 15000 } = {}) {
        this.createWorker = createWorker;
        this.onFallback = onFallback;
        this.timeoutMs = timeoutMs;
        this.pending = new Map();
        this.nextId = 0;
        this.closed = false;
        this.disabled = typeof Worker === "undefined" && createWorker === createDecoderWorker;
        this.mode = "inline";
    }

    decode(wire, shouldSkipState = () => false) {
        if (this.closed) return Promise.reject(new Error("Co-op decoder disposed"));
        // Keep tiny control packets cheap. CoopNet's receive chain preserves
        // FIFO order across both paths, including a welcome followed by deltas.
        if (wire.length < 4096 || this.disabled) return this.decodeInline(wire, shouldSkipState);
        if (!this.worker) {
            try {
                const { worker, release } = this.createWorker();
                this.worker = worker;
                this.release = release;
                worker.onmessage = ({ data }) => {
                    if (this.closed) return;
                    if (data.fatal) return this.fallback(data.fatal);
                    const pending = this.pending.get(data.id);
                    if (!pending) return;
                    clearTimeout(pending.timer);
                    this.pending.delete(data.id);
                    if (data.error) pending.reject(new Error(data.error));
                    else {
                        try {
                            const parseStart = performance.now();
                            const parsed = JSON.parse(new TextDecoder().decode(data.payload));
                            pending.resolve(
                                this.expand(
                                    parsed,
                                    data.wireDecodeMs,
                                    "worker",
                                    pending.shouldSkipState,
                                    performance.now() - parseStart
                                )
                            );
                        } catch (error) {
                            pending.reject(error);
                        }
                    }
                };
                worker.onerror = error => this.fallback(error.message || "Decoder worker failed");
                worker.onmessageerror = () => this.fallback("Decoder worker message could not be cloned");
                this.mode = "worker";
            } catch (error) {
                this.fallback(error.message || String(error));
                return this.decodeInline(wire, shouldSkipState);
            }
        }
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            const timer = setTimeout(() => this.fallback("Decoder worker timed out"), this.timeoutMs);
            this.pending.set(id, { resolve, reject, wire, shouldSkipState, timer });
            try {
                this.worker.postMessage({ id, wire });
            } catch (error) {
                this.fallback(error.message || String(error));
            }
        });
    }

    async decodeInline(wire, shouldSkipState = () => false) {
        const start = performance.now();
        const message = await decodeWireMessage(wire);
        if (this.closed) throw new Error("Co-op decoder disposed");
        return this.expand(message, performance.now() - start, "inline", shouldSkipState);
    }

    async expand(message, wireDecodeMs, mode, shouldSkipState, parseMs = 0) {
        const start = performance.now();
        if (message.t === "state" && shouldSkipState()) return { message, skipped: true, mode };
        let unpackWorkMs = 0;
        if (message.t === "state") {
            const result = await unpackStateFrameAsync(message, undefined, () => {
                if (this.closed) throw new Error("Co-op decoder disposed");
            });
            message = result.message;
            unpackWorkMs = result.workMs;
        }
        return { message, wireDecodeMs, parseMs, unpackMs: performance.now() - start, unpackWorkMs, mode };
    }

    fallback(reason) {
        if (this.closed || this.disabled) return;
        this.stopWorker();
        this.disabled = true;
        this.mode = "inline";
        this.onFallback(reason);
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const request of pending) {
            clearTimeout(request.timer);
            this.decodeInline(request.wire, request.shouldSkipState).then(request.resolve, request.reject);
        }
    }

    stopWorker() {
        this.worker?.terminate();
        this.worker = null;
        this.release?.();
        this.release = null;
    }

    dispose() {
        this.closed = true;
        this.stopWorker();
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error("Co-op decoder disposed"));
        }
        this.pending.clear();
    }
}
