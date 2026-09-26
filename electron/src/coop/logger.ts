import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;

/**
 * Append-only log for co-op diagnostics (drift diffs, resyncs, session
 * events, errors) at <userData>/coop.log with rotation to coop.log.1.
 * Logging must never break the game: every failure is swallowed, writes
 * are serialized through a promise chain, and input is validated.
 */
export class CoopLogger {
    private readonly file = path.join(app.getPath("userData"), "coop.log");
    private queue: Promise<void> = Promise.resolve();
    private readonly allowedLevels = new Set(["info", "warn", "error"]);

    get path(): string {
        return this.file;
    }

    write(level: string, text: string): void {
        if (!this.allowedLevels.has(level) || typeof text !== "string") {
            return;
        }
        const line = `${new Date().toISOString()} [${level}] ${text.slice(0, MAX_LINE_CHARS)}\n`;
        this.queue = this.queue.then(() => this.append(line)).catch(() => {
            // Swallow: logging failures stay invisible by design
        });
    }

    private async append(line: string): Promise<void> {
        try {
            const stat = await fs.stat(this.file).catch(() => null);
            if (stat && stat.size > MAX_BYTES) {
                await fs.rename(this.file, this.file + ".1").catch(() => {});
            }
            await fs.appendFile(this.file, line, "utf-8");
        } catch {
            // Swallow: logging failures stay invisible by design
        }
    }
}
