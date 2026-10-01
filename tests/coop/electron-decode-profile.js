/* global PerformanceObserver */
import { WireDecoder } from "mod://coop/decoder.js";

// Controlled renderer responsiveness comparison, not a game FPS benchmark.
// Both paths process the same actual compressed state frame. The main-process
// runner can apply CPU throttling equally to expose stalls on slower machines.
export async function profile(wire, mode, iterations = 40) {
    const decoder = new WireDecoder();
    let baseline;
    if (mode === "baseline") {
        const transport = await import("mod://coop-baseline/transport.js");
        const replication = await import("mod://coop-baseline/replication.js");
        baseline = async () => {
            const start = performance.now();
            const message = await transport.decodeWireMessage(wire);
            const wireDecodeMs = performance.now() - start;
            const unpackStart = performance.now();
            const expanded = replication.unpackStateFrame(message);
            return { message: expanded, wireDecodeMs, unpackMs: performance.now() - unpackStart };
        };
    }
    const decode =
        mode === "baseline"
            ? baseline
            : mode === "inline"
              ? () => decoder.decodeInline(wire)
              : () => decoder.decode(wire);
    try {
        for (let i = 0; i < 3; ++i) await decode();
        const gaps = [];
        const longTasks = [];
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()));
        observer.observe({ type: "longtask" });
        let lastBeat = performance.now();
        const heartbeat = setInterval(() => {
            const now = performance.now();
            gaps.push(now - lastBeat);
            lastBeat = now;
        }, 10);
        const samples = [];
        const wireTimes = [];
        const unpackTimes = [];
        const parseTimes = [];
        const unpackWork = [];
        try {
            for (let i = 0; i < iterations; ++i) {
                const start = performance.now();
                const decoded = await decode();
                if (decoded.message.t !== "state") throw new Error("Profile requires a real state frame");
                if (mode === "worker" && decoded.mode !== "worker")
                    throw new Error("Worker fallback in profile");
                samples.push(performance.now() - start);
                wireTimes.push(decoded.wireDecodeMs);
                unpackTimes.push(decoded.unpackMs);
                parseTimes.push(decoded.parseMs || 0);
                unpackWork.push(decoded.unpackWorkMs ?? decoded.unpackMs);
                // Match the maximum publication rate, rather than flooding the
                // renderer with consecutive frames faster than the real host.
                await new Promise(resolve =>
                    setTimeout(resolve, Math.max(0, 100 - (performance.now() - start)))
                );
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        } finally {
            clearInterval(heartbeat);
            longTasks.push(...observer.takeRecords());
            observer.disconnect();
        }
        gaps.sort((a, b) => a - b);
        return {
            mode,
            iterations,
            averageDecodeMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
            averageWireMs: wireTimes.reduce((sum, value) => sum + value, 0) / wireTimes.length,
            averageUnpackMs: unpackTimes.reduce((sum, value) => sum + value, 0) / unpackTimes.length,
            averageParseMs: parseTimes.reduce((sum, value) => sum + value, 0) / parseTimes.length,
            averageUnpackWorkMs: unpackWork.reduce((sum, value) => sum + value, 0) / unpackWork.length,
            heartbeatP95Ms: gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))],
            heartbeatMaxMs: gaps.at(-1),
            longTasks: longTasks.length,
            longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
            maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)),
        };
    } finally {
        decoder.dispose();
    }
}
