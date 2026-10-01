// npm run test:coop:electron, after just export or just rebundle.
// Tests the actual packaged game/mod in two hidden, isolated Chromium renderers.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const repo = path.resolve(__dirname, "../..");

if (!process.versions.electron) {
    const binary = require(path.join(repo, "electron/node_modules/electron"));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(binary, [__filename], { env, stdio: "inherit", windowsHide: true });
    process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, protocol, net } = require("electron");
const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "shapez-coop-electron-"));
const packaged =
    process.env.COOP_ELECTRON_PACKAGE || path.join(repo, "build_output/standalone/shapez-win32-x64");
const modPath = path.join(packaged, "mods/coop.asar");
app.setPath("userData", path.join(output, "profile"));
protocol.registerSchemesAsPrivileged([
    { scheme: "mod", privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
]);
ipcMain.handle("get-mods", () => []);
ipcMain.handle("fs-job", (_event, job) => {
    if (job.type === "initialize") return;
    if (job.type === "list") return [];
    // Stop normal app startup after it exposes window.shapez. Test roots use
    // real game classes but no user settings, saves, textures or drawing loop.
    throw new Error("Smoke test storage is isolated");
});
ipcMain.handle("set-fullscreen", () => {});
ipcMain.handle("coop-active", () => {});
ipcMain.handle("coop-log", () => {});
const timeout = setTimeout(() => {
    console.error("Electron co-op smoke test timed out. Diagnostics:", output);
    app.exit(1);
}, 90000);

function assertReplica(actual, expected, location = "state") {
    if (typeof expected === "number" && !Number.isInteger(expected)) {
        assert.ok(Math.abs(actual - expected) <= 0.000101, location + ": " + actual + " != " + expected);
    } else if (expected && typeof expected === "object") {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), location);
        for (const key of Object.keys(expected))
            assertReplica(actual[key], expected[key], location + "." + key);
    } else assert.equal(actual, expected, location);
}

async function waitFor(win, expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Timed out waiting for " + expression);
}

app.whenReady()
    .then(async () => {
        assert.ok(fs.existsSync(path.join(packaged, "resources/app.asar")), "Run just export first");
        assert.ok(fs.existsSync(modPath), "Packaged co-op mod missing; run just rebundle");
        protocol.handle("mod", request => {
            const url = new URL(request.url);
            const base = url.hostname === "coop" ? modPath : path.join(repo, "tests/coop");
            const target = path.resolve(base, "." + url.pathname);
            if (!target.startsWith(base + path.sep)) throw new Error("Invalid fixture path");
            return net.fetch(pathToFileURL(target).href);
        });
        // The relay has only built-in Node dependencies. Transpile its actual
        // TypeScript source to a temporary CJS module for this Electron main process.
        const relayModule = path.join(output, "relay.cjs");
        fs.writeFileSync(
            relayModule,
            transpileModule(fs.readFileSync(path.join(repo, "electron/src/coop/ws_server.ts"), "utf8"), {
                compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
            }).outputText
        );
        const { CoopWsServer } = require(relayModule);
        const server = new CoopWsServer();
        const counts = {};
        server.onMessage = (peer, text) => {
            // Compressed envelopes are counted as transport messages; assertions
            // about state/receipt/recovery use the actual mod state in each renderer.
            const type = text.startsWith("{") ? JSON.parse(text).t : "compressed";
            counts[type] = (counts[type] || 0) + 1;
            server.broadcast(text, peer.id);
        };
        const port = await server.start(0);
        const metadata = JSON.parse(fs.readFileSync(path.join(modPath, "mod.json"), "utf8"));
        let dump = null;
        if (process.env.COOP_BENCHMARK_SAVE) {
            const { gunzipSync } = require("node:zlib");
            const { decode } = require("@msgpack/msgpack");
            dump = decode(gunzipSync(fs.readFileSync(process.env.COOP_BENCHMARK_SAVE))).dump;
        }
        const windows = [];
        const errors = [];
        async function start(isHost) {
            const win = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.join(repo, "electron/preload.cjs"),
                    backgroundThrottling: false,
                },
            });
            windows.push(win);
            win.webContents.on("console-message", event => {
                const message = event.message;
                fs.appendFileSync(path.join(output, isHost ? "host.log" : "client.log"), message + "\n");
                if (
                    /applyState failed|applyWelcome failed|message handling failed|dropping invalid message/.test(
                        message
                    )
                )
                    errors.push(message);
            });
            await win.loadFile(path.join(packaged, "resources/app.asar/index.html"));
            await waitFor(win, "!!window.shapez");
            await win.webContents.executeJavaScript(
                `import("mod://coop-test/electron-fixture.js").then(module => module.initialize(${isHost}, ${JSON.stringify(isHost ? dump : null)}, ${JSON.stringify(metadata)}, "ws://127.0.0.1:${port}"))`
            );
            await waitFor(win, "coopSmoke.mod.net.connected");
            return win;
        }
        const host = await start(true);
        if (!dump) await host.webContents.executeJavaScript("coopSmoke.tick(600)");
        const client = await start(false);
        const recovered = "!coopSmoke.mod.awaitingWelcome && coopSmoke.mod.baseline.revision > 0";
        await waitFor(client, recovered);
        await waitFor(host, "coopSmoke.mod.pendingWelcomes.size === 0");
        const samples = [];
        for (let i = 0; i < 20; ++i) {
            const frame = await host.webContents.executeJavaScript(`(async () => {
            coopSmoke.tick(6);
            const start = performance.now();
            coopSmoke.mod.broadcastState();
            const workMs = performance.now() - start;
            await coopSmoke.mod.net.sendChain;
            return { revision: coopSmoke.mod.baseline.revision, workMs, bytes: coopSmoke.mod.net.sendStats.stateBytes };
        })()`);
            await waitFor(client, "coopSmoke.mod.baseline.revision === " + frame.revision);
            await waitFor(
                host,
                "[...coopSmoke.mod.stateReceipts.values()].every(revision => revision === " +
                    frame.revision +
                    ")"
            );
            samples.push(frame);
        }
        assert.equal(counts["resync-request"] || 0, 0, "Healthy state application must not trigger recovery");
        assert.equal(errors.length, 0, errors.join("\n"));
        const hostState = await host.webContents.executeJavaScript("coopSmoke.snapshot()");
        const clientState = await client.webContents.executeJavaScript("coopSmoke.snapshot()");
        fs.writeFileSync(path.join(output, "host-state.json"), JSON.stringify(hostState));
        assertReplica(clientState, hostState);
        if (!dump) assert.ok(hostState.hub.storedShapes.CuCuCuCu > 0, "Fixture must actually deliver shapes");
        // Force a missed baseline and burst duplicate recovery requests while a
        // full welcome is pending. Exactly one replacement snapshot should suffice.
        const beforeRecovery = await host.webContents.executeJavaScript("coopSmoke.mod.baseline.revision");
        await client.webContents.executeJavaScript(`
            coopSmoke.mod.baseline.revision -= 1;
            const send = coopSmoke.mod.net.send.bind(coopSmoke.mod.net);
            coopSmoke.mod.net.send = message => {
                const accepted = send(message);
                if (message.t === "resync-request") for (let i = 0; i < 20; ++i) send(message);
                return accepted;
            };
            void 0;
        `);
        await host.webContents.executeJavaScript("coopSmoke.mod.broadcastState()");
        await waitFor(client, "coopSmoke.sent['resync-request'] >= 21");
        await waitFor(client, recovered);
        await waitFor(host, "coopSmoke.mod.pendingWelcomes.size === 0");
        const hostRevision = await host.webContents.executeJavaScript("coopSmoke.mod.baseline.revision");
        assert.equal(
            await client.webContents.executeJavaScript("coopSmoke.mod.baseline.revision"),
            hostRevision
        );
        assert.equal(await client.webContents.executeJavaScript("coopSmoke.mod.welcomeFailures"), 0);
        assert.equal(
            hostRevision,
            beforeRecovery + 2,
            "Recovery burst must publish one replacement snapshot"
        );
        assert.equal(await host.webContents.executeJavaScript("coopSmoke.sent.welcome"), 2);
        assertReplica(
            await client.webContents.executeJavaScript("coopSmoke.snapshot()"),
            await host.webContents.executeJavaScript("coopSmoke.snapshot()")
        );
        const result = {
            version: metadata.version,
            entities: hostState.entities.length,
            excludedOverlaps: await host.webContents.executeJavaScript("coopSmoke.excluded"),
            updates: samples.length,
            samples,
            recoveredRevision: hostRevision,
            relayMessages: counts,
            diagnostics: output,
        };
        fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
        for (const win of windows) {
            await win.webContents.executeJavaScript(
                "coopSmoke.mod.endSession(); coopSmoke.mod.net.disconnect()"
            );
            win.destroy();
        }
        await server.stop();
        clearTimeout(timeout);
        console.log("Electron co-op smoke test passed:", JSON.stringify(result));
        app.exit(0);
    })
    .catch(error => {
        clearTimeout(timeout);
        console.error(error, "Diagnostics:", output);
        app.exit(1);
    });
