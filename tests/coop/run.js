import { rspack } from "@rspack/core";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";

const root = resolve(import.meta.dirname, "../..");
process.chdir(resolve(root, "gulp"));
const { convertToJson } = await import("../../gulp/translations.js");
await finished(convertToJson(), { readable: false });
const { default: gameConfig } = await import("../../gulp/rspack.config.js");
const config = {
    ...gameConfig,
    target: "node",
    entry: resolve(root, "tests/coop/game.test.js"),
    output: {
        path: resolve(root, "build_output/coop-tests"),
        filename: "game.test.cjs",
        chunkFormat: "commonjs",
    },
    plugins: gameConfig.plugins.filter(
        plugin => plugin.constructor.name !== "CircularDependencyRspackPlugin"
    ),
    devtool: false,
};
await new Promise((resolve, reject) => {
    rspack(config, (error, stats) => {
        if (error || stats.hasErrors()) {
            reject(error || new Error(stats.toString("errors-only")));
        } else {
            resolve();
        }
    });
});
process.chdir(root);
const result = spawnSync(
    process.execPath,
    [
        "--require",
        "./tests/coop/headless.cjs",
        "--test",
        "./tests/coop/replication.test.js",
        "./build_output/coop-tests/game.test.cjs",
    ],
    { stdio: "inherit" }
);
process.exitCode = result.status ?? 1;
