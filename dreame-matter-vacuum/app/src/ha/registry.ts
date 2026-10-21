import type { DeviceRegistryEntry, EntityRegistryEntry } from "./types.js";

export interface HelperEntities {
  cleaningModeEntity?: string;
  suctionLevelEntity?: string;
  waterVolumeEntity?: string;
  selectedMapEntity?: string;
  cleanGeniusEntity?: string;
  stateSensorEntity?: string;
  device?: DeviceRegistryEntry;
}

const PATTERNS: Record<keyof Omit<HelperEntities, "device">, RegExp> = {
  cleaningModeEntity: /(^|[._])cleaning_mode$/,
  suctionLevelEntity: /(^|[._])suction_level$/,
  waterVolumeEntity: /(^|[._])(water_volume|mop_pad_humidity|wetness_level)$/,
  selectedMapEntity: /(^|[._])selected_map$/,
  cleanGeniusEntity: /(^|[._])cleangenius$/,
  stateSensorEntity: /(^|[._])state$/,
};

/**
 * Find the Dreame helper `select` entities that live on the same device as the
 * vacuum. Falls back to deriving names from the vacuum entity id, which matches
 * the Dreame integration's default naming (`vacuum.r2d2` -> `select.r2d2_cleaning_mode`).
 */
export function detectHelperEntities(
  vacuumEntity: string,
  entities: EntityRegistryEntry[],
  devices: DeviceRegistryEntry[],
  known: Record<string, unknown>,
): HelperEntities {
  const result: HelperEntities = {};
  const vacuum = entities.find((e) => e.entity_id === vacuumEntity);
  const deviceId = vacuum?.device_id;
  if (deviceId) {
    result.device = devices.find((d) => d.id === deviceId);
    const siblings = entities.filter((e) => e.device_id === deviceId && !e.disabled_by);
    for (const [key, pattern] of Object.entries(PATTERNS) as [keyof typeof PATTERNS, RegExp][]) {
      const domain = key === "stateSensorEntity" ? "sensor." : "select.";
      const match = siblings.find(
        (e) =>
          e.entity_id.startsWith(domain) &&
          [e.translation_key ?? "", e.unique_id ?? "", e.entity_id].some((v) => pattern.test(v)),
      );
      if (match) {
        result[key] = match.entity_id;
      }
    }
  }
  const objectId = vacuumEntity.replace(/^vacuum\./, "");
  const derived: Record<keyof typeof PATTERNS, string> = {
    cleaningModeEntity: `select.${objectId}_cleaning_mode`,
    suctionLevelEntity: `select.${objectId}_suction_level`,
    waterVolumeEntity: `select.${objectId}_water_volume`,
    selectedMapEntity: `select.${objectId}_selected_map`,
    cleanGeniusEntity: `select.${objectId}_cleangenius`,
    stateSensorEntity: `sensor.${objectId}_state`,
  };
  for (const [key, entityId] of Object.entries(derived) as [keyof typeof PATTERNS, string][]) {
    if (!result[key] && known[entityId] !== undefined) {
      result[key] = entityId;
    }
  }
  return result;
}
