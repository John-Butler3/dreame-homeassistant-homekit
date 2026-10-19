import { IdentifyServer } from "@matter/main/behaviors/identify";
import type { Identify } from "@matter/main/clusters/identify";
import { createLogger } from "../../logger.js";
import { VacuumControllerRef } from "../controller-ref.js";

const log = createLogger("matter.identify");

/** "Play sound" / identify makes the robot announce its position. */
export class VacuumIdentifyServer extends IdentifyServer {
  override async identify(request: Identify.IdentifyRequest): Promise<void> {
    await super.identify(request);
    await this.locate();
  }

  override async triggerEffect(request: Identify.TriggerEffectRequest): Promise<void> {
    await super.triggerEffect(request);
    await this.locate();
  }

  private async locate(): Promise<void> {
    try {
      log.info("Identify -> locate");
      await this.env.get(VacuumControllerRef).controller.locate();
    } catch (err) {
      log.error("Locate failed", err);
    }
  }
}
