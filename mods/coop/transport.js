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

export async function decodeWireMessage(wire) {
    if (wire.length > MAX_WIRE_BYTES) throw new Error("Co-op message too large");
    const message = JSON.parse(wire);
    if (message.t !== "compressed") return message;
    if (message.encoding !== "gzip" || typeof message.data !== "string")
        throw new Error("Invalid compressed message");
    const binary = atob(message.data);
    const bytes = new Uint8Array(binary.length);
    // A typed-array conversion callback iterates a string as Unicode code points
    // and allocates intermediate storage. Base64 yields bytes, so copy directly.
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_WIRE_BYTES) {
            await reader.cancel();
            throw new Error("Expanded co-op message too large");
        }
        chunks.push(value);
    }
    return JSON.parse(await new Blob(chunks).text());
}
