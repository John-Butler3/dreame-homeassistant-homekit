/**
 * Pure mapping between Home Assistant (Dreame Vacuum integration) state and
 * the Matter Robotic Vacuum Cleaner clusters. No I/O here, so everything is
 * unit-testable.
 */

import { PowerSource, RvcCleanMode, RvcOperationalState, RvcRunMode, ServiceArea } from "@matter/main/clusters";
import type { HassState, ServiceCall } from "../ha/types.js";

// ------------------------------------------------------------------ input

export interface VacuumSnapshot {
  vacuum?: HassState;
  cleaningMode?: HassState;
  suctionLevel?: HassState;
  waterVolume?: HassState;
  selectedMap?: HassState;
  /** Dreame CleanGenius select (off / routine_cleaning / deep_cleaning). */
  cleanGenius?: HassState;
}

export interface HelperEntityIds {
  cleaningModeEntity?: string;
  suctionLevelEntity?: string;
  waterVolumeEntity?: string;
  selectedMapEntity?: string;
  cleanGeniusEntity?: string;
}

export const VACUUM_STATES = {
  cleaning: "cleaning",
  docked: "docked",
  returning: "returning",
  idle: "idle",
  paused: "paused",
  error: "error",
} as const;

export function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleCase(value: string): string {
  const text = normalize(value);
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function attr<T = unknown>(state: HassState | undefined, key: string): T | undefined {
  return state?.attributes?.[key] as T | undefined;
}

/** Placeholder values the Dreame integration puts into option lists. */
const JUNK_OPTIONS = new Set(["", "unavailable", "unknown", "none", "null"]);

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(String).filter((v) => !JUNK_OPTIONS.has(normalize(v)));
}

/**
 * Options of a select entity. The Dreame integration reports `["unavailable"]`
 * while a setting cannot be changed (CleanGenius active, robot busy), which
 * must not be mistaken for a real choice.
 */
function selectOptions(state: HassState | undefined): string[] {
  return cleanList(attr<unknown>(state, "options"));
}

function isAvailable(state: HassState | undefined): state is HassState {
  return !!state && state.state !== "unavailable" && state.state !== "unknown";
}

// ------------------------------------------------------------------ rooms

export interface VacuumArea {
  areaId: number;
  mapId: number | null;
  mapName: string | null;
  name: string;
  /** Segment id as used by the Dreame clean_segment action. */
  segmentId: number;
}

export interface VacuumMap {
  mapId: number;
  name: string;
}

export interface RoomLayout {
  maps: VacuumMap[];
  areas: VacuumArea[];
}

const UNNAMED_ROOM = /^(room|raum|zimmer|chambre|habitación|stanza|kamer|rum)\s*\d+$/i;
/** Dreame reuses segment ids on every map; offset per map keeps area ids unique. */
export const MAP_AREA_OFFSET = 10000;

interface RawRoom {
  id?: unknown;
  name?: unknown;
}

/**
 * Read the Dreame `rooms` attribute: `{ "Map name": [{ id, name, ... }] }`
 * (a flat list of rooms is accepted as a single, unnamed map).
 */
export function getRoomLayout(snapshot: VacuumSnapshot, includeUnnamed = false): RoomLayout {
  const raw = attr<unknown>(snapshot.vacuum, "rooms");
  const perMap: [string | null, RawRoom[]][] = [];
  if (Array.isArray(raw)) {
    perMap.push([null, raw as RawRoom[]]);
  } else if (raw && typeof raw === "object") {
    for (const [mapName, rooms] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(rooms)) {
        perMap.push([mapName, rooms as RawRoom[]]);
      }
    }
  }
  const multipleMaps = perMap.length > 1;
  const maps: VacuumMap[] = [];
  const areas: VacuumArea[] = [];
  perMap.forEach(([mapName, rooms], index) => {
    const mapId = multipleMaps ? index + 1 : null;
    if (multipleMaps && mapName) {
      maps.push({ mapId: index + 1, name: mapName.slice(0, 64) });
    }
    const usedNames = new Map<string, number>();
    for (const room of rooms) {
      const segmentId = Number(room?.id);
      if (!Number.isInteger(segmentId) || segmentId <= 0) {
        continue;
      }
      let name = typeof room.name === "string" && room.name.trim() ? room.name.trim() : `Room ${segmentId}`;
      if (!includeUnnamed && UNNAMED_ROOM.test(name)) {
        continue;
      }
      const seen = (usedNames.get(name.toLowerCase()) ?? 0) + 1;
      usedNames.set(name.toLowerCase(), seen);
      if (seen > 1) {
        name = `${name} ${seen}`;
      }
      areas.push({
        areaId: multipleMaps ? index * MAP_AREA_OFFSET + segmentId : segmentId,
        mapId,
        mapName,
        name: name.slice(0, 128),
        segmentId,
      });
    }
  });
  return { maps, areas };
}

export function toMatterArea(area: VacuumArea): ServiceArea.Area {
  return {
    areaId: area.areaId,
    mapId: area.mapId,
    areaInfo: {
      locationInfo: { locationName: area.name, floorNumber: null, areaType: null },
      landmarkInfo: null,
    },
  };
}

export function toMatterMap(map: VacuumMap): ServiceArea.Map {
  return { mapId: map.mapId, name: map.name };
}

/** Name of the map the vacuum currently uses (Dreame `selected_map`). */
export function getSelectedMapName(snapshot: VacuumSnapshot): string | null {
  const fromVacuum = attr<unknown>(snapshot.vacuum, "selected_map");
  if (typeof fromVacuum === "string" && fromVacuum) {
    return fromVacuum;
  }
  if (isAvailable(snapshot.selectedMap)) {
    return snapshot.selectedMap.state;
  }
  return null;
}

/**
 * Area id of the room the vacuum is working in right now, if known.
 *
 * Only reported while cleaning or paused: Dreame keeps `current_segment` set
 * while docked, and a non-null current area makes Apple Home treat the robot
 * as busy there and drop that room from a new selection.
 */
export function getCurrentAreaId(snapshot: VacuumSnapshot, layout: RoomLayout): number | null {
  const state = snapshot.vacuum?.state;
  if (state !== VACUUM_STATES.cleaning && state !== VACUUM_STATES.paused) {
    return null;
  }
  const segment = Number(attr<unknown>(snapshot.vacuum, "current_segment"));
  if (!Number.isInteger(segment) || segment <= 0) {
    return null;
  }
  const mapName = getSelectedMapName(snapshot);
  const candidates = layout.areas.filter((a) => a.segmentId === segment);
  const onMap = candidates.find((a) => a.mapName === mapName) ?? candidates.find((a) => a.mapName === null);
  return (onMap ?? (candidates.length === 1 ? candidates[0] : undefined))?.areaId ?? null;
}

// ------------------------------------------------------- operational state

const OpState = RvcOperationalState.OperationalState;
const ErrorState = RvcOperationalState.ErrorState;

export interface OperationalStatus {
  state: RvcOperationalState.OperationalState;
  error: RvcOperationalState.ErrorState;
  /** Short label for the controller (max 64 chars), null when no error. */
  errorLabel: string | null;
  /** Human readable details, null when no error. */
  errorText: string | null;
}

/**
 * Dreame problems without a dedicated Matter error code. matter.js rejects
 * manufacturer-specific ids, so the closest standard code is used and the
 * specifics travel in the details text.
 */
export const VENDOR_ERROR = {
  dirtyWaterTankFull: ErrorState.WaterTankMissing,
  detergentLow: ErrorState.UnableToCompleteOperation,
  station: ErrorState.UnableToCompleteOperation,
} as const;

export interface Attention {
  error: RvcOperationalState.ErrorState;
  label: string;
  details: string;
}

const NORMAL_STATUS = new Set(["", "installed", "normal", "ok", "no warning", "no water left dismiss", "idle", "unknown", "disabled"]);

/**
 * Problems the base station or the robot report while the vacuum itself is
 * not in the `error` state: empty clean-water tank, full dirty-water tank,
 * missing dust bag, low detergent. They are surfaced as operational errors
 * so Apple Home shows them on the accessory and can notify.
 */
export function getAttention(snapshot: VacuumSnapshot): Attention | null {
  const text = (key: string) => normalize(attr(snapshot.vacuum, key));
  const dirty = text("dirty_water_tank_status");
  if (!NORMAL_STATUS.has(dirty)) {
    return {
      error: VENDOR_ERROR.dirtyWaterTankFull,
      label: "Dirty water tank full or missing",
      details: `Dirty water tank: ${dirty}`,
    };
  }
  const clean = text("clean_water_tank_status");
  if (!NORMAL_STATUS.has(clean) && clean !== "checking") {
    return clean.includes("not installed")
      ? { error: ErrorState.WaterTankMissing, label: "Clean water tank missing", details: `Clean water tank: ${clean}` }
      : { error: ErrorState.WaterTankEmpty, label: "Clean water tank empty", details: `Clean water tank: ${clean}` };
  }
  const water = text("low_water_warning");
  if (!NORMAL_STATUS.has(water)) {
    return { error: ErrorState.WaterTankEmpty, label: "Clean water tank empty", details: `Water: ${water}` };
  }
  const bag = text("dust_bag_status");
  if (!NORMAL_STATUS.has(bag)) {
    return bag.includes("not installed")
      ? { error: ErrorState.DustBinMissing, label: "Dust bag missing", details: `Dust bag: ${bag}` }
      : { error: ErrorState.DustBinFull, label: "Dust bag needs attention", details: `Dust bag: ${bag}` };
  }
  const detergent = text("detergent_status");
  if (!NORMAL_STATUS.has(detergent)) {
    return { error: VENDOR_ERROR.detergentLow, label: "Detergent low", details: `Detergent: ${detergent}` };
  }
  return null;
}

export function getBattery(snapshot: VacuumSnapshot): { percent: number | null; charging: boolean } {
  const raw = attr<unknown>(snapshot.vacuum, "battery_level") ?? attr<unknown>(snapshot.vacuum, "battery");
  const percent = raw == null ? NaN : Number(raw);
  const chargingAttr = attr<unknown>(snapshot.vacuum, "charging");
  const charging =
    typeof chargingAttr === "boolean" ? chargingAttr : snapshot.vacuum?.state === VACUUM_STATES.docked;
  return { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null, charging };
}

export function mapErrorText(text: string | null | undefined): RvcOperationalState.ErrorState {
  const t = normalize(text);
  if (!t || t === "no error" || t === "unknown") {
    return ErrorState.UnableToCompleteOperation;
  }
  if (/dirty water|dirty tank|sewage/.test(t)) return ErrorState.WaterTankMissing;
  if (/box full|bin full|dust full|bag full/.test(t)) return ErrorState.DustBinFull;
  if (/waterbox empty|water tank empty|water empty|low water|no water|clean water/.test(t)) return ErrorState.WaterTankEmpty;
  if (/tankbox|water tank|waterbox|tank missing/.test(t)) return ErrorState.WaterTankMissing;
  if (/^box$|dust box|dust bin|dust bag|bin missing/.test(t)) return ErrorState.DustBinMissing;
  if (/detergent/.test(t)) return ErrorState.UnableToCompleteOperation;
  if (/mop|pad/.test(t)) return ErrorState.MopCleaningPadMissing;
  if (/charger|charge|dock/.test(t)) return ErrorState.FailedToFindChargingDock;
  if (/drop|cliff|bumper|blocked|suffocate|stuck|trapped|wheel|edge|carpet|move|magnet|laser|lds|optical|flow/.test(t)) {
    return ErrorState.Stuck;
  }
  if (/station|drain|hot water|heat/.test(t)) return ErrorState.UnableToCompleteOperation;
  return ErrorState.UnableToCompleteOperation;
}

/** Human readable label for an error state id. */
export function errorLabel(error: RvcOperationalState.ErrorState, fallback: string | null): string {
  switch (error) {
    case ErrorState.Stuck:
      return "Robot is stuck";
    case ErrorState.DustBinFull:
      return "Dust bin full";
    case ErrorState.DustBinMissing:
      return "Dust bin missing";
    case ErrorState.WaterTankEmpty:
      return "Clean water tank empty";
    case ErrorState.WaterTankMissing:
      return "Water tank missing";
    case ErrorState.WaterTankLidOpen:
      return "Water tank lid open";
    case ErrorState.MopCleaningPadMissing:
      return "Mop pad missing";
    case ErrorState.FailedToFindChargingDock:
      return "Cannot find the dock";
    default:
      return fallback ? titleCase(fallback) : "Robot needs attention";
  }
}

export function getOperationalStatus(snapshot: VacuumSnapshot): OperationalStatus {
  const vacuum = snapshot.vacuum;
  if (!isAvailable(vacuum)) {
    return {
      state: OpState.Error,
      error: ErrorState.UnableToCompleteOperation,
      errorLabel: "Vacuum unavailable",
      errorText: "Home Assistant reports the vacuum as unavailable",
    };
  }
  if (vacuum.state === VACUUM_STATES.error) {
    const text = attr<unknown>(vacuum, "error");
    const errorText = typeof text === "string" ? text : null;
    const error = mapErrorText(errorText);
    return { state: OpState.Error, error, errorLabel: errorLabel(error, errorText), errorText };
  }
  const attention = getAttention(snapshot);
  if (attention) {
    return { state: OpState.Error, error: attention.error, errorLabel: attention.label, errorText: attention.details };
  }
  const noError = { error: ErrorState.NoError, errorLabel: null, errorText: null };
  switch (vacuum.state) {
    case VACUUM_STATES.cleaning:
      return { state: OpState.Running, ...noError };
    case VACUUM_STATES.paused:
      return { state: OpState.Paused, ...noError };
    case VACUUM_STATES.returning:
      return { state: OpState.SeekingCharger, ...noError };
    case VACUUM_STATES.docked: {
      const { percent, charging } = getBattery(snapshot);
      return { state: charging && (percent ?? 100) < 100 ? OpState.Charging : OpState.Docked, ...noError };
    }
    case VACUUM_STATES.idle:
      return { state: OpState.Stopped, ...noError };
    default:
      return { state: OpState.Stopped, ...noError };
  }
}

export const RUN_MODE_IDLE = 0;
export const RUN_MODE_CLEANING = 1;

export function getRunMode(snapshot: VacuumSnapshot): number {
  const state = snapshot.vacuum?.state;
  return state === VACUUM_STATES.cleaning || state === VACUUM_STATES.paused ? RUN_MODE_CLEANING : RUN_MODE_IDLE;
}

export const RUN_MODES: RvcRunMode.ModeOption[] = [
  { label: "Idle", mode: RUN_MODE_IDLE, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: "Cleaning", mode: RUN_MODE_CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
];

// ------------------------------------------------------------- clean modes

export enum CleanType {
  Vacuum = 0,
  Mop = 1,
  VacuumAndMop = 2,
  VacuumThenMop = 3,
  /** Dreame CleanGenius: the robot picks the mode itself (Matter tag Auto). */
  CleanGenius = 4,
}

export type CleanModeKind = "base" | "suction" | "water";

export interface CleanModeOption {
  mode: number;
  label: string;
  kind: CleanModeKind;
  type: CleanType;
  modeTags: RvcCleanMode.ModeTagStruct[];
  /** Select option (base modes) or intensity option (suction / water). */
  value: string | null;
  /** For intensity variants: the base mode option to select first. */
  baseValue: string | null;
}

const Tag = RvcCleanMode.ModeTag;
const BASE_MODE = 1;
const SUCTION_MODE_BASE = 10;
const WATER_MODE_BASE = 50;

const BASE_TAGS: Record<CleanType, RvcCleanMode.ModeTagStruct[]> = {
  [CleanType.Vacuum]: [{ value: Tag.Vacuum }],
  [CleanType.Mop]: [{ value: Tag.Mop }],
  [CleanType.VacuumAndMop]: [{ value: Tag.Vacuum }, { value: Tag.Mop }],
  [CleanType.VacuumThenMop]: [{ value: Tag.DeepClean }, { value: Tag.Vacuum }, { value: Tag.Mop }],
  [CleanType.CleanGenius]: [{ value: Tag.Auto }],
};

const BASE_LABELS: Record<CleanType, string> = {
  [CleanType.Vacuum]: "Vacuum",
  [CleanType.Mop]: "Mop",
  [CleanType.VacuumAndMop]: "Vacuum and mop",
  [CleanType.VacuumThenMop]: "Deep clean",
  [CleanType.CleanGenius]: "CleanGenius",
};

/** Order of the base modes as shown to the controller. */
const BASE_ORDER: CleanType[] = [
  CleanType.CleanGenius,
  CleanType.VacuumThenMop,
  CleanType.Vacuum,
  CleanType.VacuumAndMop,
  CleanType.Mop,
];

// ------------------------------------------------------------ CleanGenius

/** Does the robot have CleanGenius (select entity or vacuum attribute)? */
export function hasCleanGenius(snapshot: VacuumSnapshot): boolean {
  return !!snapshot.cleanGenius || attr(snapshot.vacuum, "cleangenius") !== undefined;
}

/** Is CleanGenius currently controlling the cleaning mode? */
export function isCleanGeniusOn(snapshot: VacuumSnapshot): boolean {
  const fromVacuum = attr<unknown>(snapshot.vacuum, "cleangenius");
  if (typeof fromVacuum === "boolean") return fromVacuum;
  if (typeof fromVacuum === "string" && fromVacuum.trim()) {
    const v = normalize(fromVacuum);
    return v !== "off" && v !== "unknown";
  }
  if (isAvailable(snapshot.cleanGenius)) {
    const v = normalize(snapshot.cleanGenius.state);
    return v !== "off";
  }
  return false;
}

/** Select option that turns CleanGenius on (prefers "routine cleaning"). */
export function cleanGeniusOnOption(snapshot: VacuumSnapshot): string {
  const options = selectOptions(snapshot.cleanGenius);
  const on = options.filter((o) => normalize(o) !== "off");
  return on.find((o) => /routine/.test(normalize(o))) ?? on[0] ?? "routine_cleaning";
}

/** Select option that turns CleanGenius off. */
export function cleanGeniusOffOption(snapshot: VacuumSnapshot): string {
  return selectOptions(snapshot.cleanGenius).find((o) => normalize(o) === "off") ?? "off";
}

/** Classify a Dreame cleaning-mode option ("Sweeping and mopping", ...). */
export function classifyCleaningOption(option: string): CleanType {
  const s = normalize(option);
  const vac = /\b(sweep|sweeping|vacuum|vacuuming|suction|dry)\b/.test(s);
  const mop = /\b(mop|mopping|wash|wet)\b/.test(s);
  const seq = /\b(after|then|first|followed)\b/.test(s);
  if (vac && mop && seq) return CleanType.VacuumThenMop;
  if (vac && mop) return CleanType.VacuumAndMop;
  if (mop) return CleanType.Mop;
  return CleanType.Vacuum;
}

type IntensityTag = typeof Tag.Quiet | typeof Tag.Auto | typeof Tag.Max;

/**
 * Assign Apple Home's three intensity buckets (Quiet / Automatic / Max) to a
 * list of ordered levels. Levels without a bucket keep only the base tag;
 * they stay selectable from other controllers.
 */
export function assignIntensityTags(levels: string[]): (IntensityTag | null)[] {
  const result: (IntensityTag | null)[] = levels.map(() => null);
  const idx = (pattern: RegExp, fromEnd = false) => {
    const list = levels.map((l, i) => [normalize(l), i] as const);
    const ordered = fromEnd ? [...list].reverse() : list;
    return ordered.find(([l]) => pattern.test(l))?.[1];
  };
  const quiet = idx(/quiet|silent|gentle|low|mild|min|eco|slightly/);
  const max = idx(/turbo|max|strong|high|intense|wet|boost/, true);
  const auto = idx(/standard|normal|balanced|medium|moderate|auto|moist|default/);
  if (quiet !== undefined) result[quiet] = Tag.Quiet;
  if (max !== undefined && result[max] === null) result[max] = Tag.Max;
  if (auto !== undefined && result[auto] === null) result[auto] = Tag.Auto;
  // Fallbacks for unknown vocabularies: first -> Quiet, last -> Max.
  if (!result.includes(Tag.Quiet) && levels.length > 1 && result[0] === null) result[0] = Tag.Quiet;
  if (!result.includes(Tag.Max) && levels.length > 1 && result[levels.length - 1] === null) {
    result[levels.length - 1] = Tag.Max;
  }
  return result;
}

export function getSuctionLevels(snapshot: VacuumSnapshot): string[] {
  const fromSelect = selectOptions(snapshot.suctionLevel);
  if (fromSelect.length > 0) return fromSelect;
  const list = cleanList(attr<unknown>(snapshot.vacuum, "fan_speed_list")).filter((s) => normalize(s) !== "off");
  if (list.length > 0) return list;
  // Dreame reports no levels while the setting is locked; keep the real ones.
  return snapshot.suctionLevel ? [...DREAME_SUCTION_LEVELS] : [];
}

export function getWaterLevels(snapshot: VacuumSnapshot): string[] {
  const fromSelect = selectOptions(snapshot.waterVolume);
  if (fromSelect.length > 0) return fromSelect;
  return snapshot.waterVolume ? [...DREAME_WATER_LEVELS] : [];
}

/** Dreame's cleaning modes on vacuum + mop models (select option values). */
export const DREAME_MOP_CLEANING_MODES = ["sweeping", "mopping", "sweeping_and_mopping", "mopping_after_sweeping"];
/** Dreame suction levels (select option values). */
export const DREAME_SUCTION_LEVELS = ["quiet", "standard", "strong", "turbo"];
/** Dreame water volumes (select option values). */
export const DREAME_WATER_LEVELS = ["low", "medium", "high"];

/** Heuristic: does this robot have a mop at all? */
export function isMopModel(snapshot: VacuumSnapshot): boolean {
  const attrs = snapshot.vacuum?.attributes ?? {};
  if (snapshot.waterVolume || snapshot.cleaningMode) return true;
  return ["water_tank", "mop_pad", "mop_pad_humidity", "water_volume", "cleaning_mode", "mop_pad_installed"].some(
    (key) => key in attrs,
  );
}

/**
 * The cleaning-mode option texts. The Dreame select is the first choice,
 * but it is unavailable in some situations (CleanGenius active, zone or
 * spot cleaning, ...). Then the vacuum's own `cleaning_mode_list` attribute
 * or, for mop models, Dreame's standard list is used, so Apple Home always
 * sees the picker.
 */
export function getCleaningModeOptions(snapshot: VacuumSnapshot): string[] {
  const fromSelect = selectOptions(snapshot.cleaningMode);
  if (fromSelect.length > 0) return fromSelect;
  const list = cleanList(attr<unknown>(snapshot.vacuum, "cleaning_mode_list"));
  if (list.length > 0) return list;
  return isMopModel(snapshot) ? [...DREAME_MOP_CLEANING_MODES] : [];
}

/** All RvcCleanMode options for the current configuration. */
export function buildCleanModes(snapshot: VacuumSnapshot): CleanModeOption[] {
  const modes: CleanModeOption[] = [];
  const baseOptions = getCleaningModeOptions(snapshot);
  const byType = new Map<CleanType, string>();
  for (const option of baseOptions) {
    const type = classifyCleaningOption(option);
    if (!byType.has(type)) byType.set(type, option);
  }
  if (byType.size === 0) {
    byType.set(CleanType.Vacuum, "");
  }
  if (hasCleanGenius(snapshot)) {
    byType.set(CleanType.CleanGenius, cleanGeniusOnOption(snapshot));
  }
  for (const type of BASE_ORDER) {
    const value = byType.get(type);
    if (value === undefined) continue;
    modes.push({
      mode: BASE_MODE + type,
      label: BASE_LABELS[type],
      kind: "base",
      type,
      modeTags: BASE_TAGS[type],
      value: value || null,
      baseValue: null,
    });
  }

  const vacuumBase = byType.get(CleanType.Vacuum) ?? null;
  const suction = getSuctionLevels(snapshot);
  if (vacuumBase !== undefined) {
    assignIntensityTags(suction).forEach((tag, i) => {
      modes.push({
        mode: SUCTION_MODE_BASE + i,
        label: `Vacuum ${titleCase(suction[i])}`,
        kind: "suction",
        type: CleanType.Vacuum,
        modeTags: tag === null ? [{ value: Tag.Vacuum }] : [{ value: Tag.Vacuum }, { value: tag }],
        value: suction[i],
        baseValue: vacuumBase || null,
      });
    });
  }
  const mopBase = byType.get(CleanType.Mop);
  const water = getWaterLevels(snapshot);
  if (mopBase !== undefined) {
    assignIntensityTags(water).forEach((tag, i) => {
      modes.push({
        mode: WATER_MODE_BASE + i,
        label: `Mop ${titleCase(water[i])}`,
        kind: "water",
        type: CleanType.Mop,
        modeTags: tag === null ? [{ value: Tag.Mop }] : [{ value: Tag.Mop }, { value: tag }],
        value: water[i],
        baseValue: mopBase,
      });
    });
  }
  if (modes.length === 1) {
    // ModeBase wants a choice; offer a harmless "Auto" that maps to the same mode.
    modes.push({
      mode: 99,
      label: "Auto",
      kind: "base",
      type: CleanType.Vacuum,
      modeTags: [{ value: Tag.Auto }],
      value: modes[0].value,
      baseValue: null,
    });
  }
  return modes;
}

export function toMatterCleanMode(mode: CleanModeOption): RvcCleanMode.ModeOption {
  return { label: mode.label.slice(0, 64), mode: mode.mode, modeTags: mode.modeTags };
}

/** Current cleaning mode text: the vacuum attribute first, then the select. */
export function getCurrentCleaningModeText(snapshot: VacuumSnapshot): string | null {
  const fromVacuum = attr<unknown>(snapshot.vacuum, "cleaning_mode");
  if (typeof fromVacuum === "string" && fromVacuum.trim() && normalize(fromVacuum) !== "unknown") {
    return normalize(fromVacuum);
  }
  return isAvailable(snapshot.cleaningMode) ? normalize(snapshot.cleaningMode.state) : null;
}

/** The mode that best describes the vacuum's current settings. */
export function getCurrentCleanMode(snapshot: VacuumSnapshot, modes: CleanModeOption[]): CleanModeOption {
  const bases = modes.filter((m) => m.kind === "base");
  const genius = bases.find((m) => m.type === CleanType.CleanGenius);
  if (genius && isCleanGeniusOn(snapshot)) {
    return genius;
  }
  const manual = bases.filter((m) => m.type !== CleanType.CleanGenius);
  const current = getCurrentCleaningModeText(snapshot);
  let base = manual.find((m) => current !== null && normalize(m.value) === current);
  if (!base && current !== null) {
    const type = classifyCleaningOption(current);
    base = manual.find((m) => m.type === type);
  }
  base ??= manual[0] ?? modes[0];

  if (base.type === CleanType.Vacuum) {
    const level = isAvailable(snapshot.suctionLevel)
      ? normalize(snapshot.suctionLevel.state)
      : normalize(attr(snapshot.vacuum, "fan_speed"));
    const variant = modes.find((m) => m.kind === "suction" && normalize(m.value) === level);
    if (variant) return variant;
  } else if (base.type === CleanType.Mop) {
    const level = isAvailable(snapshot.waterVolume) ? normalize(snapshot.waterVolume.state) : "";
    const variant = modes.find((m) => m.kind === "water" && normalize(m.value) === level);
    if (variant) return variant;
  }
  return base;
}

/** Service calls that apply a clean mode. */
export function cleanModeCalls(
  snapshot: VacuumSnapshot,
  helpers: HelperEntityIds,
  target: CleanModeOption,
): ServiceCall[] {
  const calls: ServiceCall[] = [];
  const geniusOn = isCleanGeniusOn(snapshot);
  if (target.type === CleanType.CleanGenius) {
    if (!geniusOn && helpers.cleanGeniusEntity) {
      calls.push({
        domain: "select",
        service: "select_option",
        data: { option: target.value ?? cleanGeniusOnOption(snapshot) },
        target: helpers.cleanGeniusEntity,
      });
    }
    return calls;
  }
  if (geniusOn && helpers.cleanGeniusEntity) {
    // A manual mode only takes effect once CleanGenius lets go.
    calls.push({
      domain: "select",
      service: "select_option",
      data: { option: cleanGeniusOffOption(snapshot) },
      target: helpers.cleanGeniusEntity,
    });
  }
  const currentBase = getCurrentCleaningModeText(snapshot);
  const baseValue = target.kind === "base" ? target.value : target.baseValue;
  if (baseValue && helpers.cleaningModeEntity && (geniusOn || normalize(baseValue) !== currentBase)) {
    calls.push({
      domain: "select",
      service: "select_option",
      data: { option: baseValue },
      target: helpers.cleaningModeEntity,
    });
  }
  if (target.kind === "suction" && target.value) {
    if (helpers.suctionLevelEntity) {
      calls.push({
        domain: "select",
        service: "select_option",
        data: { option: target.value },
        target: helpers.suctionLevelEntity,
      });
    } else {
      calls.push({ domain: "vacuum", service: "set_fan_speed", data: { fan_speed: target.value } });
    }
  }
  if (target.kind === "water" && target.value && helpers.waterVolumeEntity) {
    calls.push({
      domain: "select",
      service: "select_option",
      data: { option: target.value },
      target: helpers.waterVolumeEntity,
    });
  }
  return calls;
}

// ----------------------------------------------------------------- actions

/** Service calls that start cleaning the selected areas (or everything). */
export function startCalls(
  snapshot: VacuumSnapshot,
  helpers: HelperEntityIds,
  layout: RoomLayout,
  selectedAreaIds: number[],
): ServiceCall[] {
  const selected = selectedAreaIds
    .map((id) => layout.areas.find((a) => a.areaId === id))
    .filter((a): a is VacuumArea => a !== undefined);
  if (selected.length === 0) {
    return [{ domain: "vacuum", service: "start" }];
  }
  const calls: ServiceCall[] = [];
  // Dreame can only clean on the active map: switch floors when needed and
  // keep the rooms of that floor (first selected room decides).
  const targetMap = selected[0].mapName;
  const rooms = selected.filter((a) => a.mapName === targetMap);
  if (targetMap && targetMap !== getSelectedMapName(snapshot) && helpers.selectedMapEntity) {
    calls.push({
      domain: "select",
      service: "select_option",
      data: { option: targetMap },
      target: helpers.selectedMapEntity,
    });
  }
  calls.push({
    domain: "dreame_vacuum",
    service: "vacuum_clean_segment",
    data: { segments: rooms.map((a) => a.segmentId) },
  });
  return calls;
}

export const PAUSE_CALL: ServiceCall = { domain: "vacuum", service: "pause" };
export const RESUME_CALL: ServiceCall = { domain: "vacuum", service: "start" };
export const GO_HOME_CALL: ServiceCall = { domain: "vacuum", service: "return_to_base" };
export const STOP_CALL: ServiceCall = { domain: "vacuum", service: "stop" };
export const LOCATE_CALL: ServiceCall = { domain: "vacuum", service: "locate" };

// ----------------------------------------------------------- power source

export interface PowerStatus {
  percentRemaining: number | null;
  chargeLevel: PowerSource.BatChargeLevel;
  chargeState: PowerSource.BatChargeState;
}

export function getPowerStatus(snapshot: VacuumSnapshot): PowerStatus {
  const { percent, charging } = getBattery(snapshot);
  const level =
    percent === null || percent > 20
      ? PowerSource.BatChargeLevel.Ok
      : percent > 10
        ? PowerSource.BatChargeLevel.Warning
        : PowerSource.BatChargeLevel.Critical;
  let chargeState = PowerSource.BatChargeState.IsNotCharging;
  if (charging && percent !== null && percent >= 100) {
    chargeState = PowerSource.BatChargeState.IsAtFullCharge;
  } else if (charging) {
    chargeState = PowerSource.BatChargeState.IsCharging;
  }
  return { percentRemaining: percent === null ? null : percent * 2, chargeLevel: level, chargeState };
}

// ------------------------------------------------------ progress tracking

const Progress = ServiceArea.OperationalStatus;

/**
 * Tracks the progress of one room-cleaning job for the ServiceArea cluster's
 * progress list: Pending -> Operating -> Completed, in the order the robot
 * visits the rooms.
 */
export class CleanSession {
  private readonly order: number[];
  private readonly status = new Map<number, ServiceArea.OperationalStatus>();
  private current: number | null = null;
  readonly startedAt: number;
  finished = false;

  constructor(selectedAreaIds: number[], now = Date.now()) {
    this.order = [...selectedAreaIds];
    for (const id of this.order) this.status.set(id, Progress.Pending);
    this.startedAt = now;
  }

  get selected(): number[] {
    return [...this.order];
  }

  /** The robot reported it is in `areaId` (null = unknown / in transit). */
  visit(areaId: number | null): void {
    if (this.finished || areaId === null || areaId === this.current) return;
    if (this.current !== null && this.status.get(this.current) === Progress.Operating) {
      this.status.set(this.current, Progress.Completed);
    }
    if (this.status.has(areaId)) {
      this.status.set(areaId, Progress.Operating);
      this.current = areaId;
    }
  }

  /** The job ended; rooms never reached are reported as skipped. */
  finish(completed = true): void {
    if (this.finished) return;
    for (const [id, status] of this.status) {
      if (status === Progress.Operating) {
        this.status.set(id, Progress.Completed);
      } else if (status === Progress.Pending) {
        this.status.set(id, completed ? Progress.Completed : Progress.Skipped);
      }
    }
    this.current = null;
    this.finished = true;
  }

  progress(): ServiceArea.Progress[] {
    return this.order.map((areaId) => ({
      areaId,
      status: this.status.get(areaId) ?? Progress.Pending,
      totalOperationalTime: null,
      estimatedTime: null,
    }));
  }
}
