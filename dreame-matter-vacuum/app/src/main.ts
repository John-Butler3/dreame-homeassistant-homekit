import { loadConfig } from "./config.js";
import { HomeAssistantClient } from "./ha/client.js";
import { detectHelperEntities } from "./ha/registry.js";
import { createLogger, setLogLevel } from "./logger.js";
import { MatterVacuumNode } from "./matter/node.js";
import { VacuumController } from "./vacuum/controller.js";
import { startWebServer } from "./web/server.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  log.info(`Dreame Matter Vacuum starting for ${config.vacuumEntity}`);

  const ha = new HomeAssistantClient(config.homeAssistantUrl, config.homeAssistantToken);
  await ha.connect();

  // Wait until the vacuum entity exists (Dreame integration may still be loading).
  for (let waited = 0; !ha.getState(config.vacuumEntity); waited += 5) {
    if (waited % 30 === 0) {
      log.warn(`Entity ${config.vacuumEntity} not found in Home Assistant yet, waiting`);
      explainMissingEntity(config.vacuumEntity, Object.keys(ha.getAllStates()));
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  const [entities, devices] = await Promise.all([ha.getEntityRegistry(), ha.getDeviceRegistry()]);
  const detected = detectHelperEntities(config.vacuumEntity, entities, devices, ha.getAllStates());
  const helpers = {
    cleaningModeEntity: config.cleaningModeEntity ?? detected.cleaningModeEntity,
    suctionLevelEntity: config.suctionLevelEntity ?? detected.suctionLevelEntity,
    waterVolumeEntity: config.waterVolumeEntity ?? detected.waterVolumeEntity,
    selectedMapEntity: config.selectedMapEntity ?? detected.selectedMapEntity,
    cleanGeniusEntity: config.cleanGeniusEntity ?? detected.cleanGeniusEntity,
    stateSensorEntity: config.stateSensorEntity ?? detected.stateSensorEntity,
  };
  for (const [key, value] of Object.entries(helpers)) {
    log.info(`${key}: ${value ?? "not found"}`);
  }
  if (!(await ha.hasService("dreame_vacuum", "vacuum_clean_segment"))) {
    log.warn("Service dreame_vacuum.vacuum_clean_segment is not available; room cleaning will start a full clean");
  }

  const controller = new VacuumController(ha, {
    vacuumEntity: config.vacuumEntity,
    helpers,
    includeUnnamedRooms: config.includeUnnamedRooms,
    defaultCleanMode: config.defaultCleanMode,
    defaultSuctionLevel: config.defaultSuctionLevel,
  });
  controller.start();
  const view = controller.view();
  log.info(
    `Vacuum ${view.snapshot.vacuum?.state}: ${view.layout.areas.length} rooms on ${Math.max(1, view.layout.maps.length)} map(s)`,
  );
  log.info(`Rooms: ${view.layout.areas.map((a) => a.name).join(", ") || "none"}`);
  log.info(
    `Clean modes: ${view.cleanModes.map((m) => `${m.label}${m.mode === view.currentCleanMode.mode ? " (current)" : ""}`).join(", ")}`,
  );

  const matter = new MatterVacuumNode(config, controller, detected.device);
  await matter.start();
  const web = startWebServer(config.webPort, controller, matter);

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    web.close();
    controller.stop();
    await matter.close();
    await ha.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Help the user when the configured value is not a Home Assistant entity id. */
function explainMissingEntity(configured: string, entityIds: string[]): void {
  const vacuums = entityIds.filter((id) => id.startsWith("vacuum.")).sort();
  if (!configured.startsWith("vacuum.")) {
    log.error(
      `"${configured}" is not a Home Assistant entity id. The option 'vacuum_entity' needs the id of the ` +
        "vacuum entity, which always starts with 'vacuum.' (Developer tools -> States, filter 'vacuum.').",
    );
  }
  if (vacuums.length > 0) {
    log.info(`Vacuum entities available in Home Assistant: ${vacuums.join(", ")}`);
  } else {
    log.warn("No vacuum entities exist in Home Assistant yet. Is the Dreame Vacuum integration set up?");
  }
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
