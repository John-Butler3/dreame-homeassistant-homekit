import { OnOffServer } from "@matter/main/behaviors/on-off";
import { createLogger } from "../../logger.js";
import { VacuumControllerRef } from "../controller-ref.js";
import { selectedAreasOf } from "./service-area.js";

const log = createLogger("matter.on-off");

/**
 * Optional OnOff cluster (Amazon Alexa needs it, Apple Home does not).
 * On = start cleaning, Off = return to the dock.
 */
export class VacuumOnOffServer extends OnOffServer {
  override async on(): Promise<void> {
    log.info("OnOff -> on");
    await this.env.get(VacuumControllerRef).controller.startCleaning(selectedAreasOf(this.agent));
    await super.on();
  }

  override async off(): Promise<void> {
    log.info("OnOff -> off");
    await this.env.get(VacuumControllerRef).controller.goHome();
    await super.off();
  }
}
