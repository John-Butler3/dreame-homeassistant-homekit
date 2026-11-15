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
  /** Dreame detailed state sensor (washing, drying, auto_emptying, ...). */
  stateSensor?: HassState;
  /** Dreame cleaning progress sensor (percent of the job done). */
  cleaningProgress?: HassState;
  /** Dreame cleaning time sensor (minutes spent on the job). */
  cleaningTime?: HassState;
}

export interface HelperEntityIds {
  cleaningModeEntity?: string;
  suctionLevelEntity?: string;
  waterVolumeEntity?: string;
  selectedMapEntity?: string;
  cleanGeniusEntity?: string;
  stateSensorEntity?: string;
  cleaningProgressEntity?: string;
  cleaningTimeEntity?: string;
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

/**
 * Phases reported through the operational-state cluster's PhaseList /
 * CurrentPhase, so controllers can show what the robot and its base are
 * doing (washing or drying mop pads, emptying the bin, ...).
 */
export const PHASES = [
  "Cleaning",
  "Returning to dock",
  "Returning to wash mop pads",
  "Washing mop pads",
  "Drying mop pads",
  "Emptying dust bin",
  "Draining water",
  "Cleaning the station",
  "Charging",
  "Idle",
  "Mapping",
  "Attention needed",
] as const;

export type Phase = (typeof PHASES)[number];

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

/** Detailed Dreame state: the state sensor first, then the boolean attributes. */
export function getDetailedState(snapshot: VacuumSnapshot): string | null {
  if (isAvailable(snapshot.stateSensor)) {
    return normalize(snapshot.stateSensor.state);
  }
  const flag = (key: string) => attr<unknown>(snapshot.vacuum, key) === true;
  if (flag("washing_paused")) return "washing paused";
  if (flag("washing")) return "washing";
  if (flag("drying")) return "drying";
  if (flag("draining")) return "draining";
  if (flag("returning_to_wash_paused")) return "returning to wash paused";
  if (flag("returning_to_wash")) return "returning to wash";
  return null;
}

/**
 * What the robot / base is doing right now, as a phase. Matter requires a
 * valid index whenever a phase list exists, so this never returns null.
 */
export function getPhase(snapshot: VacuumSnapshot): Phase {
  const vacuum = snapshot.vacuum;
  if (!isAvailable(vacuum)) return "Idle";
  if (vacuum.state === VACUUM_STATES.error) return "Attention needed";
  const detail = getDetailedState(snapshot) ?? "";
  if (/washing/.test(detail)) return "Washing mop pads";
  if (/returning to wash|returning wash/.test(detail)) return "Returning to wash mop pads";
  if (/dust bag drying/.test(detail)) return "Emptying dust bin";
  if (/drying/.test(detail)) return "Drying mop pads";
  if (/emptying|auto empty/.test(detail)) return "Emptying dust bin";
  if (/draining|drain/.test(detail)) return "Draining water";
  if (/station cleaning|station reset|self repair/.test(detail)) return "Cleaning the station";
  if (/mapping|building/.test(detail)) return "Mapping";
  switch (vacuum.state) {
    case VACUUM_STATES.cleaning:
    case VACUUM_STATES.paused:
      return "Cleaning";
    case VACUUM_STATES.returning:
      return "Returning to dock";
    case VACUUM_STATES.docked: {
      const { percent, charging } = getBattery(snapshot);
      return charging && (percent ?? 100) < 100 ? "Charging" : "Idle";
    }
    default:
      return "Idle";
  }
}

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

export interface OperationalStatusOptions {
  /** Report base-station work (mop washing / drying, auto emptying) as its own state. */
  stationStates?: boolean;
}

/**
 * Matter 1.4.2 operational states for work done at the base station, from
 * the Dreame detailed state. Controllers that know these states (Apple Home
 * since iOS 18.4) show them instead of a plain "Docked".
 */
export function getStationState(snapshot: VacuumSnapshot): RvcOperationalState.OperationalState | null {
  const detail = getDetailedState(snapshot) ?? "";
  if (/dust bag drying|emptying|auto empty/.test(detail)) return OpState.EmptyingDustBin;
  // Matter has no "drying mop" state. Drying stays Docked / Charging (the phase
  // still says "Drying mop pads") so the Home app keeps offering Start; the
  // robot happily starts a new job while the base is drying.
  if (/washing/.test(detail)) return OpState.CleaningMop;
  if (/adding water|filling water|water refill|refilling/.test(detail)) return OpState.FillingWaterTank;
  return null;
}

export function getOperationalStatus(
  snapshot: VacuumSnapshot,
  options: OperationalStatusOptions = {},
): OperationalStatus {
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
  if (options.stationStates !== false) {
    const station = getStationState(snapshot);
    if (station !== null) return { state: station, ...noError };
  }
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
const VACUUM_AND_MOP_MODE_BASE = 30;
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
  return snapshot.waterVolume ? defaultOptionsFor(snapshot.waterVolume.entity_id) : [];
}

/** Dreame's cleaning modes on vacuum + mop models (select option values). */
export const DREAME_MOP_CLEANING_MODES = ["sweeping", "mopping", "sweeping_and_mopping", "mopping_after_sweeping"];
/** Dreame suction levels (select option values). */
export const DREAME_SUCTION_LEVELS = ["quiet", "standard", "strong", "turbo"];
/** Dreame water volumes (select option values). */
export const DREAME_WATER_LEVELS = ["low", "medium", "high"];
/** Dreame mop pad humidity levels (self-wash base models). */
export const DREAME_MOP_HUMIDITY_LEVELS = ["slightly_dry", "moist", "wet"];

/** Last-resort option list for a Dreame select, derived from its entity id. */
export function defaultOptionsFor(entityId: string | undefined): string[] {
  const id = (entityId ?? "").toLowerCase();
  if (id.includes("mop_pad_humidity")) return [...DREAME_MOP_HUMIDITY_LEVELS];
  if (id.includes("wetness")) return [];
  if (id.includes("water_volume")) return [...DREAME_WATER_LEVELS];
  if (id.includes("suction")) return [...DREAME_SUCTION_LEVELS];
  if (id.includes("cleaning_mode")) return [...DREAME_MOP_CLEANING_MODES];
  return [];
}

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
  // Apple Home lists the modifier-tagged modes (Quiet / Automatic / Max /
  // Deep clean) as the options of a cleaning type; a plain "Vacuum and mop"
  // would have no visible option next to "Deep clean". Give it the suction
  // levels as intensities, or at least an Automatic entry.
  const bothBase = byType.get(CleanType.VacuumAndMop);
  if (bothBase !== undefined) {
    const levels = suction.length > 0 ? suction : [""];
    const tags = suction.length > 0 ? assignIntensityTags(suction) : [Tag.Auto];
    levels.forEach((level, i) => {
      const tag = tags[i];
      modes.push({
        mode: VACUUM_AND_MOP_MODE_BASE + i,
        label: level ? `Vacuum and mop ${titleCase(level)}` : "Vacuum and mop",
        kind: "suction",
        type: CleanType.VacuumAndMop,
        modeTags:
          tag === null
            ? [{ value: Tag.Vacuum }, { value: Tag.Mop }]
            : [{ value: Tag.Vacuum }, { value: Tag.Mop }, { value: tag }],
        value: level || null,
        baseValue: bothBase || null,
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

/** Clean-type names accepted in the add-on options. */
export const CLEAN_TYPE_BY_NAME: Record<string, CleanType> = {
  vacuum: CleanType.Vacuum,
  mop: CleanType.Mop,
  vacuum_and_mop: CleanType.VacuumAndMop,
  deep_clean: CleanType.VacuumThenMop,
  cleangenius: CleanType.CleanGenius,
};

/**
 * The mode to fall back to after a job (add-on options `default_clean_mode`
 * and `default_suction_level`), or undefined when nothing is configured or
 * the robot has no such mode.
 */
export function findDefaultMode(
  modes: CleanModeOption[],
  typeName: string | undefined,
  suctionLevel: string | undefined,
): CleanModeOption | undefined {
  const type = typeName ? CLEAN_TYPE_BY_NAME[normalize(typeName).replace(/ /g, "_")] : undefined;
  if (type === undefined) return undefined;
  const level = suctionLevel && normalize(suctionLevel) !== "keep" ? normalize(suctionLevel) : null;
  if (level && (type === CleanType.Vacuum || type === CleanType.VacuumAndMop)) {
    const variant = modes.find((m) => m.kind === "suction" && m.type === type && normalize(m.value) === level);
    if (variant) return variant;
  }
  return modes.find((m) => m.kind === "base" && m.type === type);
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

  if (base.type === CleanType.Vacuum || base.type === CleanType.VacuumAndMop) {
    const level = isAvailable(snapshot.suctionLevel)
      ? normalize(snapshot.suctionLevel.state)
      : normalize(attr(snapshot.vacuum, "fan_speed"));
    const variant = modes.find(
      (m) => m.kind === "suction" && m.type === base.type && (normalize(m.value) === level || m.value === null),
    );
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

// ------------------------------------------------------- job progress

function sensorNumber(state: HassState | undefined): number | null {
  if (!isAvailable(state)) return null;
  const value = Number(state.state);
  return Number.isFinite(value) ? value : null;
}

/** Percent of the running job done, from the Dreame cleaning progress sensor. */
export function getCleaningProgress(snapshot: VacuumSnapshot): number | null {
  const state = snapshot.vacuum?.state;
  if (state !== VACUUM_STATES.cleaning && state !== VACUUM_STATES.paused) return null;
  const percent = sensorNumber(snapshot.cleaningProgress);
  if (percent === null) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Seconds the running job still needs, for the operational-state cluster's
 * CountdownTime. Matter has no "percent done" attribute, so the Dreame
 * progress and elapsed cleaning time are turned into a remaining time.
 */
export function getRemainingSeconds(snapshot: VacuumSnapshot): number | null {
  const percent = getCleaningProgress(snapshot);
  if (percent === null) return null;
  if (percent >= 100) return 0;
  if (percent <= 0) return null;
  const minutes = sensorNumber(snapshot.cleaningTime) ?? Number(attr<unknown>(snapshot.vacuum, "cleaning_time"));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.round((minutes * 60 * (100 - percent)) / percent);
}

// ------------------------------------------------------ progress tracking

const Progress = ServiceArea.OperationalStatus;

/** Pace assumed until jobs have been observed: 8 minutes per room. */
export const DEFAULT_SECONDS_PER_ROOM = 480;
/** An operating room never reports less than this many seconds left. */
const MIN_ROOM_ESTIMATE = 30;

/**
 * Tracks the progress of one room-cleaning job for the ServiceArea cluster's
 * progress list: Pending -> Operating -> Completed, in the order the robot
 * visits the rooms.
 */
export class CleanSession {
  private readonly order: number[];
  private readonly status = new Map<number, ServiceArea.OperationalStatus>();
  private current: number | null = null;
  /** The current room is a guess (first room still pending), not reported by the robot. */
  private assumed = false;
  /** When the robot started working in the current room (paused time excluded). */
  private enteredAt: number | null = null;
  /** Seconds spent in each finished room. */
  private readonly spent = new Map<number, number>();
  readonly startedAt: number;
  finished = false;

  constructor(
    selectedAreaIds: number[],
    now = Date.now(),
    /** Seconds the robot needs for one room, learned from earlier jobs. */
    readonly secondsPerRoom = DEFAULT_SECONDS_PER_ROOM,
  ) {
    this.order = [...selectedAreaIds];
    for (const id of this.order) this.status.set(id, Progress.Pending);
    this.startedAt = now;
  }

  get selected(): number[] {
    return [...this.order];
  }

  /** Room reported as being worked on right now (null once the job is over). */
  currentArea(): number | null {
    return this.finished ? null : this.current;
  }

  /** Rooms the robot has finished. */
  completedCount(): number {
    return [...this.status.values()].filter((s) => s === Progress.Completed).length;
  }

  /**
   * The robot reported it is in `areaId` (null = unknown / in transit).
   *
   * Dreame reports `current_segment` 0 while the robot drives to the first
   * room and while it follows the walls of a room, and Apple Home shows a
   * running job without a current room as "travelling". So while the robot
   * has not told us a room yet, the first room still pending counts as the
   * one being cleaned; a later report of another room corrects the guess.
   */
  visit(areaId: number | null, now = Date.now()): void {
    if (this.finished) return;
    if (areaId === null || !this.status.has(areaId)) {
      if (this.current === null) this.assume(now);
      return;
    }
    if (areaId === this.current) {
      this.assumed = false;
      return;
    }
    if (this.current !== null && this.status.get(this.current) === Progress.Operating) {
      if (this.assumed) {
        this.status.set(this.current, Progress.Pending);
      } else {
        this.status.set(this.current, Progress.Completed);
        this.spent.set(this.current, this.secondsIn(now));
      }
    }
    // A corrected guess keeps its clock: the robot was on its way to this room all along.
    this.enteredAt = this.assumed && this.enteredAt !== null ? this.enteredAt : now;
    this.status.set(areaId, Progress.Operating);
    this.current = areaId;
    this.assumed = false;
  }

  private assume(now: number): void {
    const next = this.order.find((id) => this.status.get(id) === Progress.Pending);
    if (next === undefined) return;
    this.status.set(next, Progress.Operating);
    this.current = next;
    this.assumed = true;
    this.enteredAt = now;
  }

  /** Time spent paused does not count as working in a room. */
  addPause(ms: number): void {
    if (this.enteredAt !== null) this.enteredAt += ms;
  }

  private secondsIn(now: number): number {
    return this.enteredAt === null ? 0 : Math.max(0, Math.round((now - this.enteredAt) / 1000));
  }

  /** The job ended; rooms never reached are reported as skipped. */
  finish(completed = true, now = Date.now()): void {
    if (this.finished) return;
    for (const [id, status] of this.status) {
      if (status === Progress.Operating) {
        this.status.set(id, Progress.Completed);
        if (id === this.current) this.spent.set(id, this.secondsIn(now));
      } else if (status === Progress.Pending) {
        this.status.set(id, completed ? Progress.Completed : Progress.Skipped);
      }
    }
    this.current = null;
    this.enteredAt = null;
    this.finished = true;
  }

  /** Estimated seconds still needed for one room (null once it is done). */
  estimatedTime(areaId: number, now = Date.now()): number | null {
    switch (this.status.get(areaId)) {
      case Progress.Pending:
        return this.secondsPerRoom;
      case Progress.Operating:
        // Never claim zero while still working there.
        return Math.max(MIN_ROOM_ESTIMATE, this.secondsPerRoom - (areaId === this.current ? this.secondsIn(now) : 0));
      default:
        return null;
    }
  }

  /** Progress list for the ServiceArea cluster, with time estimates. */
  progress(now = Date.now()): ServiceArea.Progress[] {
    return this.order.map((areaId) => ({
      areaId,
      status: this.status.get(areaId) ?? Progress.Pending,
      totalOperationalTime: this.spent.get(areaId) ?? null,
      estimatedTime: this.estimatedTime(areaId, now),
    }));
  }

  /** Estimated seconds left in the whole job. */
  remainingSeconds(now = Date.now()): number {
    if (this.finished) return 0;
    return this.order.reduce((sum, id) => sum + (this.estimatedTime(id, now) ?? 0), 0);
  }

  /** Percent of the job done, by estimated time. */
  percentDone(now = Date.now()): number {
    if (this.finished) return 100;
    const total = this.order.length * this.secondsPerRoom;
    if (total <= 0) return 0;
    const done = total - this.remainingSeconds(now);
    return Math.min(100, Math.max(0, Math.round((100 * done) / total)));
  }
}

// ----------------------------------------------------------- job pace memory

/** Learned cleaning pace, persisted between runs. */
export interface PaceStats {
  secondsPerRoom: number;
  jobs: number;
}

export const DEFAULT_PACE: PaceStats = { secondsPerRoom: DEFAULT_SECONDS_PER_ROOM, jobs: 0 };

/** Fold a finished job (total working seconds over `rooms` rooms) into the pace. */
export function learnPace(stats: PaceStats, totalSeconds: number, rooms: number): PaceStats {
  if (rooms <= 0 || !Number.isFinite(totalSeconds) || totalSeconds < 60) return stats;
  const perRoom = Math.min(3600, Math.max(60, totalSeconds / rooms));
  if (stats.jobs <= 0) return { secondsPerRoom: Math.round(perRoom), jobs: 1 };
  return { secondsPerRoom: Math.round(stats.secondsPerRoom * 0.7 + perRoom * 0.3), jobs: stats.jobs + 1 };
}

/** Rooms a job covers when none were picked: every room on the selected map. */
export function roomsOnSelectedMap(snapshot: VacuumSnapshot, layout: RoomLayout): number[] {
  const mapName = getSelectedMapName(snapshot);
  const onMap = layout.areas.filter((a) => a.mapName === mapName || a.mapName === null);
  return (onMap.length > 0 ? onMap : layout.areas).map((a) => a.areaId);
}

/**
 * Rooms of a job started outside Matter (Dreame app, automation): the Dreame
 * `active_segments` attribute when it names rooms, otherwise the whole map.
 */
export function roomsOfExternalJob(snapshot: VacuumSnapshot, layout: RoomLayout): number[] {
  const segments = attr<unknown>(snapshot.vacuum, "active_segments");
  if (Array.isArray(segments) && segments.length > 0) {
    const mapName = getSelectedMapName(snapshot);
    const areas = segments
      .map((s) => Number(s))
      .filter((s) => Number.isInteger(s) && s > 0)
      .map((segment) => {
        const candidates = layout.areas.filter((a) => a.segmentId === segment);
        const onMap = candidates.find((a) => a.mapName === mapName) ?? candidates.find((a) => a.mapName === null);
        return (onMap ?? (candidates.length === 1 ? candidates[0] : undefined))?.areaId;
      })
      .filter((id): id is number => id !== undefined);
    if (areas.length > 0) return areas;
  }
  return roomsOnSelectedMap(snapshot, layout);
}

/** Whole Unix seconds, as matter.js expects for epoch-s attributes (it converts to the Matter epoch itself). */
export function epochSeconds(unixMs: number): number {
  return Math.floor(unixMs / 1000);
}
