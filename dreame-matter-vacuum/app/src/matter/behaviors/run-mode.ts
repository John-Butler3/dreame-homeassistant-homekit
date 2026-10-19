import { RvcRunModeServer } from "@matter/main/behaviors/rvc-run-mode";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { createLogger } from "../../logger.js";
import { RUN_MODE_CLEANING, RUN_MODE_IDLE } from "../../vacuum/model.js";
import { VacuumControllerRef } from "../controller-ref.js";
import { selectedAreasOf } from "./service-area.js";

const log = createLogger("matter.run-mode");

/** RvcRunMode: Idle <-> Cleaning. Cleaning honours the rooms selected via ServiceArea. */
export class VacuumRunModeServer extends RvcRunModeServer {
  override async changeToMode(request: ModeBase.ChangeToModeRequest): Promise<ModeBase.ChangeToModeResponse> {
    const controller = this.env.get(VacuumControllerRef).controller;
    const { newMode } = request;
    if (!this.state.supportedModes.some((m) => m.mode === newMode)) {
      return { status: ModeBase.ModeChangeStatus.UnsupportedMode, statusText: "Unsupported run mode" };
    }
    try {
      if (newMode === RUN_MODE_CLEANING) {
        const areas = selectedAreasOf(this.agent);
        log.info(`Run mode -> Cleaning (areas: ${areas.join(", ") || "all"})`);
        await controller.startCleaning(areas);
      } else if (newMode === RUN_MODE_IDLE) {
        log.info("Run mode -> Idle (returning to dock)");
        await controller.goHome();
      }
    } catch (err) {
      log.error("Run mode change failed", err);
      return { status: ModeBase.ModeChangeStatus.GenericFailure, statusText: String(err) };
    }
    this.state.currentMode = newMode;
    return { status: ModeBase.ModeChangeStatus.Success, statusText: "" };
  }
}
