import { BrowserWindow, IpcMainInvokeEvent, ipcMain } from "electron";
import { CoopHostManager, CoopStatus } from "./coop/manager.js";
import type { CoopLogger } from "./coop/logger.js";
import { FsJob, FsJobHandler } from "./fsjob.js";
import { ModLoader } from "./mods/loader.js";

export class IpcHandler {
    private readonly savesHandler = new FsJobHandler("saves");
    private readonly modLoader: ModLoader;
    private readonly coop: CoopHostManager;
    private readonly coopLog: CoopLogger;

    constructor(modLoader: ModLoader, coop: CoopHostManager, coopLog: CoopLogger) {
        this.modLoader = modLoader;
        this.coop = coop;
        this.coopLog = coopLog;
    }

    install(window: BrowserWindow) {
        ipcMain.handle("fs-job", this.handleFsJob.bind(this));
        ipcMain.handle("get-mods", this.getMods.bind(this));
        ipcMain.handle("set-fullscreen", this.setFullscreen.bind(this, window));
        ipcMain.handle("coop-start", (_event: IpcMainInvokeEvent, port: number) => {
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new RangeError("coop-start: invalid port " + String(port));
            }
            return this.coop.start(port);
        });
        ipcMain.handle("coop-stop", (): Promise<CoopStatus> => this.coop.stop());
        ipcMain.handle("coop-status", (): CoopStatus => this.coop.status());
        ipcMain.handle("coop-log", (_event: IpcMainInvokeEvent, level: unknown, text: unknown) => {
            if (typeof level === "string" && typeof text === "string") {
                this.coopLog.write(level, text);
            }
        });

        // Not implemented
        // ipcMain.handle("open-mods-folder", ...)
    }

    private handleFsJob(_event: IpcMainInvokeEvent, job: FsJob) {
        if (job.id !== "saves") {
            throw new Error("Storages other than saves/ are not implemented yet");
        }

        return this.savesHandler.handleJob(job);
    }

    private async getMods() {
        // TODO: Split mod reloads into a different IPC request
        await this.modLoader.loadMods();
        return this.modLoader.getAllMods();
    }

    private setFullscreen(window: BrowserWindow, _event: IpcMainInvokeEvent, flag: boolean) {
        if (window.isFullScreen() != flag) {
            window.setFullScreen(flag);
        }
    }
}
