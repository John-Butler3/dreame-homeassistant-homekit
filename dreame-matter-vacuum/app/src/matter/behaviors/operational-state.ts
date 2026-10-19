import { RvcOperationalStateServer } from "@matter/main/behaviors/rvc-operational-state";
import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { createLogger } from "../../logger.js";
import { VacuumControllerRef } from "../controller-ref.js";
import { selectedAreasOf } from "./service-area.js";

const log = createLogger("matter.op-state");
const ErrorState = RvcOperationalState.ErrorState;
const OpState = RvcOperationalState.OperationalState;

type Response = RvcOperationalState.OperationalCommandResponse;

function ok(): Response {
  return { commandResponseState: { errorStateId: ErrorState.NoError } };
}

function invalid(): Response {
  return { commandResponseState: { errorStateId: ErrorState.CommandInvalidInState } };
}

function failed(): Response {
  return { commandResponseState: { errorStateId: ErrorState.UnableToStartOrResume } };
}

/** RvcOperationalState: Pause / Resume / GoHome. */
export class VacuumOperationalStateServer extends RvcOperationalStateServer {
  override async pause(): Promise<Response> {
    const state = this.state.operationalState;
    if (state === OpState.Paused) return ok();
    if (state !== OpState.Running && state !== OpState.SeekingCharger) return invalid();
    try {
      log.info("Pause");
      await this.env.get(VacuumControllerRef).controller.pause();
      this.state.operationalState = OpState.Paused;
      return ok();
    } catch (err) {
      log.error("Pause failed", err);
      return failed();
    }
  }

  override async resume(): Promise<Response> {
    const state = this.state.operationalState;
    if (state === OpState.Running) return ok();
    if (state === OpState.Error) return invalid();
    try {
      log.info("Resume");
      await this.env.get(VacuumControllerRef).controller.resume(selectedAreasOf(this.agent));
      this.state.operationalState = OpState.Running;
      return ok();
    } catch (err) {
      log.error("Resume failed", err);
      return failed();
    }
  }

  override async goHome(): Promise<Response> {
    const state = this.state.operationalState;
    if (state === OpState.Docked || state === OpState.Charging) return ok();
    try {
      log.info("Go home");
      await this.env.get(VacuumControllerRef).controller.goHome();
      this.state.operationalState = OpState.SeekingCharger;
      return ok();
    } catch (err) {
      log.error("Go home failed", err);
      return failed();
    }
  }
}
