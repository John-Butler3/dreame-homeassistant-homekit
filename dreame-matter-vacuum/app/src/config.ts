import { readFileSync } from "node:fs";
import type { LogLevel } from "./logger.js";

/**
 * Runtime configuration. Values come from the add-on options
 * (`/data/options.json`) and can be overridden through environment
 * variables (useful when running outside of the Supervisor).
 */
export interface AppConfig {
  /** Home Assistant base URL, e.g. http://supervisor/core */
  homeAssistantUrl: string;
  /** Long-lived or Supervisor access token. */
  homeAssistantToken: string;
  /** The Dreame vacuum entity, e.g. vacuum.dreame_l10 */
  vacuumEntity: string;
  /** Name shown to Apple Home. */
  deviceName: string;
  /** Optional explicit helper entities (auto-detected when empty). */
  cleaningModeEntity?: string;
  suctionLevelEntity?: string;
  waterVolumeEntity?: string;
  selectedMapEntity?: string;
  cleanGeniusEntity?: string;
  /** Expose rooms named like "Room 7". */
  includeUnnamedRooms: boolean;
  /** Add the OnOff cluster (needed by Alexa, may confuse Apple Home). */
  onOffCluster: boolean;
  /** Matter UDP port. */
  matterPort: number;
  /** Restrict mDNS announcements to one interface. */
  mdnsInterface?: string;
  /** Port of the small status / pairing web page. */
  webPort: number;
  /** Where Matter and app state is persisted. */
  storagePath: string;
  logLevel: LogLevel;
}

interface AddonOptions {
  vacuum_entity?: string;
  device_name?: string;
  cleaning_mode_entity?: string;
  suction_level_entity?: string;
  water_volume_entity?: string;
  selected_map_entity?: string;
  cleangenius_entity?: string;
  include_unnamed_rooms?: boolean;
  on_off_cluster?: boolean;
  matter_port?: number;
  mdns_interface?: string;
  log_level?: string;
}

function readOptions(path: string): AddonOptions {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AddonOptions;
  } catch {
    return {};
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const options = readOptions(env.DMV_OPTIONS_FILE ?? "/data/options.json");
  const vacuumEntity = clean(env.DMV_VACUUM_ENTITY) ?? clean(options.vacuum_entity);
  if (!vacuumEntity) {
    throw new Error("No vacuum entity configured (option 'vacuum_entity' or DMV_VACUUM_ENTITY)");
  }
  const token = clean(env.DMV_HA_TOKEN) ?? clean(env.SUPERVISOR_TOKEN);
  if (!token) {
    throw new Error("No Home Assistant token (SUPERVISOR_TOKEN or DMV_HA_TOKEN)");
  }
  const logLevel = (clean(env.DMV_LOG_LEVEL) ?? clean(options.log_level) ?? "info") as LogLevel;
  return {
    homeAssistantUrl: clean(env.DMV_HA_URL) ?? "http://supervisor/core",
    homeAssistantToken: token,
    vacuumEntity,
    deviceName: clean(env.DMV_DEVICE_NAME) ?? clean(options.device_name) ?? "Robot Vacuum",
    cleaningModeEntity: clean(env.DMV_CLEANING_MODE_ENTITY) ?? clean(options.cleaning_mode_entity),
    suctionLevelEntity: clean(env.DMV_SUCTION_LEVEL_ENTITY) ?? clean(options.suction_level_entity),
    waterVolumeEntity: clean(env.DMV_WATER_VOLUME_ENTITY) ?? clean(options.water_volume_entity),
    selectedMapEntity: clean(env.DMV_SELECTED_MAP_ENTITY) ?? clean(options.selected_map_entity),
    cleanGeniusEntity: clean(env.DMV_CLEANGENIUS_ENTITY) ?? clean(options.cleangenius_entity),
    includeUnnamedRooms: env.DMV_INCLUDE_UNNAMED_ROOMS === "true" || options.include_unnamed_rooms === true,
    onOffCluster: env.DMV_ON_OFF_CLUSTER === "true" || options.on_off_cluster === true,
    matterPort: Number(clean(env.DMV_MATTER_PORT) ?? options.matter_port ?? 5540),
    mdnsInterface: clean(env.DMV_MDNS_INTERFACE) ?? clean(options.mdns_interface),
    webPort: Number(clean(env.DMV_WEB_PORT) ?? 8099),
    storagePath: clean(env.DMV_STORAGE_PATH) ?? "/data/matter",
    logLevel: ["debug", "info", "warn", "error"].includes(logLevel) ? logLevel : "info",
  };
}
