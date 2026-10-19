import { ModeUtils } from "@matter/main/behaviors/mode-base";
import { RvcCleanModeServer } from "@matter/main/behaviors/rvc-clean-mode";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { createLogger } from "../../logger.js";
import { VacuumControllerRef } from "../controller-ref.js";

const log = createLogger("matter.clean-mode");

/** RvcCleanMode: cleaning type plus suction / water intensity. */
export class VacuumCleanModeServer extends RvcCleanModeServer {
  override async changeToMode(request: ModeBase.ChangeToModeRequest): Promise<ModeBase.ChangeToModeResponse> {
    const result = ModeUtils.assertModeChange(this.state.supportedModes, this.state.currentMode, request.newMode);
    if (result.status !== ModeBase.ModeChangeStatus.Success) {
      return result;
    }
    const controller = this.env.get(VacuumControllerRef).controller;
    const mode = controller.view().cleanModes.find((m) => m.mode === request.newMode);
    if (!mode) {
      return { status: ModeBase.ModeChangeStatus.UnsupportedMode, statusText: "Unknown clean mode" };
    }
    try {
      log.info(`Clean mode -> ${mode.label}`);
      await controller.setCleanMode(mode);
    } catch (err) {
      log.error("Clean mode change failed", err);
      return { status: ModeBase.ModeChangeStatus.GenericFailure, statusText: String(err) };
    }
    this.state.currentMode = request.newMode;
    return { status: ModeBase.ModeChangeStatus.Success, statusText: "" };
  }
}
