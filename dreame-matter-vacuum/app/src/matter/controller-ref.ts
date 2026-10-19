import type { VacuumController } from "../vacuum/controller.js";

/**
 * Registered in the matter.js Environment so cluster behaviours can reach the
 * vacuum controller through `this.env.get(VacuumControllerRef)`.
 */
export class VacuumControllerRef {
  constructor(readonly controller: VacuumController) {}
}
