// Native gzip runs outside the renderer's JavaScript loop. Keep the relay a
// text relay: compressed JSON travels in a small, base64-encoded envelope.
const MAX_WIRE_BYTES = 64 * 1024 * 1024;

export async function encodeWireMessage(wire) {
    if (wire.length < 4096) return wire;
    const bytes = new Uint8Array(
        await new Response(new Blob([wire]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
    );
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    const compressed = JSON.stringify({ t: "compressed", encoding: "gzip", data: btoa(binary) });
    return compressed.length < wire.length ? compressed : wire;
}

function parseEnvelope(wire) {
    if (wire.length > MAX_WIRE_BYTES) throw new Error("Co-op message too large");
    const message = JSON.parse(wire);
    if (message.t !== "compressed") return message;
    if (message.encoding !== "gzip" || typeof message.data !== "string")
        throw new Error("Invalid compressed message");
    return message;
}

async function inflate(message, asBytes) {
    const binary = atob(message.data);
    const bytes = new Uint8Array(binary.length);
    // A typed-array conversion callback iterates a string as Unicode code points
    // and allocates intermediate storage. Base64 yields bytes, so copy directly.
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const textDecoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let size = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_WIRE_BYTES) {
            await reader.cancel();
            throw new Error("Expanded co-op message too large");
        }
        if (asBytes) chunks.push(value);
        else text += textDecoder.decode(value, { stream: true });
    }
    if (asBytes) {
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
    // Avoid another Blob/read task and a second byte-buffer copy after inflate.
    // Streaming UTF-8 decoding retains characters split across stream chunks.
    return text + textDecoder.decode();
}

export async function decodeWireMessage(wire) {
    const message = parseEnvelope(wire);
    return message.t === "compressed" ? JSON.parse(await inflate(message, false)) : message;
}

// Workers transfer the original compact JSON bytes. Do not parse/stringify the
// inflated message or clone an expanded graph across the worker boundary.
export async function decodeWireBytes(wire) {
    const message = parseEnvelope(wire);
    return message.t === "compressed" ? inflate(message, true) : new TextEncoder().encode(wire);
}
