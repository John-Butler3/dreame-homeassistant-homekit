import type { Agent } from "@matter/main";
import { ServiceAreaServer } from "@matter/main/behaviors/service-area";
import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { ServiceArea } from "@matter/main/clusters/service-area";
import { createLogger } from "../../logger.js";

const log = createLogger("matter.service-area");

/**
 * ServiceArea with the Maps (floors) and ProgressReporting features.
 * Room selection is stored by the base implementation; the RvcRunMode and
 * RvcOperationalState servers read it when cleaning starts.
 */
export class VacuumServiceAreaServer extends ServiceAreaServer.with(
  ServiceArea.Feature.Maps,
  ServiceArea.Feature.ProgressReporting,
) {
  override assertSelectServiceArea(request: ServiceArea.SelectAreasRequest) {
    const running = this.agent.endpoint.stateOf("rvcOperationalState") as
      | { operationalState?: number }
      | undefined;
    if (running?.operationalState === RvcOperationalState.OperationalState.Running) {
      return {
        result: {
          status: ServiceArea.SelectAreasStatus.InvalidInMode,
          statusText: "Rooms cannot be changed while the vacuum is cleaning",
        },
      };
    }
    const result = super.assertSelectServiceArea(request);
    if (result.result.status === ServiceArea.SelectAreasStatus.Success) {
      log.info(`Rooms selected: ${(result.validatedAreas ?? []).join(", ") || "none"}`);
    }
    return result;
  }
}

/** Currently selected area ids, or an empty list when the cluster is absent. */
export function selectedAreasOf(agent: Agent): number[] {
  if (!agent.endpoint.behaviors.has(VacuumServiceAreaServer)) {
    return [];
  }
  return [...agent.get(VacuumServiceAreaServer).state.selectedAreas];
}
