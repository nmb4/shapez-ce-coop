import { decodeWireBytes } from "./transport.js";

// Pure message processing: no root, game exports or simulation in this worker.
export async function decodeRequest({ id, wire }) {
    const start = performance.now();
    try {
        const payload = await decodeWireBytes(wire);
        return {
            id,
            payload,
            wireDecodeMs: performance.now() - start,
        };
    } catch (error) {
        return { id, error: error.message || String(error) };
    }
}
