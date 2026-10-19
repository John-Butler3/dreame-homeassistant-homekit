import { PowerSource, RvcCleanMode, RvcOperationalState, ServiceArea } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import type { HassState } from "../ha/types.js";
import {
  assignIntensityTags,
  buildCleanModes,
  classifyCleaningOption,
  CleanSession,
  CleanType,
  cleanModeCalls,
  getCurrentAreaId,
  getCurrentCleanMode,
  getOperationalStatus,
  getPowerStatus,
  getRoomLayout,
  getRunMode,
  MAP_AREA_OFFSET,
  mapErrorText,
  RUN_MODE_CLEANING,
  RUN_MODE_IDLE,
  startCalls,
  type VacuumSnapshot,
} from "./model.js";

const Tag = RvcCleanMode.ModeTag;
const OpState = RvcOperationalState.OperationalState;

function state(entity_id: string, s: string, attributes: Record<string, unknown> = {}): HassState {
  return { entity_id, state: s, attributes };
}

const ROOMS = {
  "Ground floor": [
    { id: 1, name: "Kitchen", icon: "mdi:kitchen", type: 1, index: 0 },
    { id: 2, name: "Living room", icon: "mdi:sofa", type: 2, index: 1 },
    { id: 3, name: "Room 3", icon: "mdi:door", type: 0, index: 2 },
    { id: 4, name: "Kitchen", icon: "mdi:door", type: 0, index: 3 },
  ],
};

function snapshot(overrides: Partial<VacuumSnapshot> = {}, vacuumAttrs: Record<string, unknown> = {}): VacuumSnapshot {
  return {
    vacuum: state("vacuum.robot", "docked", {
      supported_features: 8192 | 4 | 32,
      battery_level: 80,
      charging: true,
      docked: true,
      fan_speed: "standard",
      fan_speed_list: ["silent", "standard", "strong", "turbo"],
      rooms: ROOMS,
      selected_map: "Ground floor",
      current_segment: 0,
      ...vacuumAttrs,
    }),
    cleaningMode: state("select.robot_cleaning_mode", "Sweeping", {
      options: ["Sweeping", "Mopping", "Sweeping and mopping", "Mopping after sweeping"],
    }),
    suctionLevel: state("select.robot_suction_level", "Standard", {
      options: ["Quiet", "Standard", "Strong", "Turbo"],
    }),
    waterVolume: state("select.robot_water_volume", "Medium", { options: ["Low", "Medium", "High"] }),
    ...overrides,
  };
}

const HELPERS = {
  cleaningModeEntity: "select.robot_cleaning_mode",
  suctionLevelEntity: "select.robot_suction_level",
  waterVolumeEntity: "select.robot_water_volume",
  selectedMapEntity: "select.robot_selected_map",
};

describe("rooms", () => {
  it("builds areas from a single Dreame map without the Maps feature", () => {
    const layout = getRoomLayout(snapshot());
    expect(layout.maps).toEqual([]);
    expect(layout.areas.map((a) => [a.areaId, a.name, a.mapId])).toEqual([
      [1, "Kitchen", null],
      [2, "Living room", null],
      [4, "Kitchen 2", null],
    ]);
  });

  it("can include unnamed rooms", () => {
    const layout = getRoomLayout(snapshot(), true);
    expect(layout.areas.map((a) => a.name)).toContain("Room 3");
  });

  it("offsets area ids per map for multi-floor homes", () => {
    const multi = snapshot({}, { rooms: { ...ROOMS, Upstairs: [{ id: 1, name: "Bedroom" }] } });
    const layout = getRoomLayout(multi);
    expect(layout.maps).toEqual([
      { mapId: 1, name: "Ground floor" },
      { mapId: 2, name: "Upstairs" },
    ]);
    const bedroom = layout.areas.find((a) => a.name === "Bedroom")!;
    expect(bedroom.areaId).toBe(MAP_AREA_OFFSET + 1);
    expect(bedroom.mapId).toBe(2);
    expect(bedroom.segmentId).toBe(1);
  });

  it("resolves the current area on the selected map while cleaning", () => {
    const multi = snapshot(
      {},
      { rooms: { ...ROOMS, Upstairs: [{ id: 1, name: "Bedroom" }] }, current_segment: 1, selected_map: "Upstairs" },
    );
    multi.vacuum = { ...multi.vacuum!, state: "cleaning" };
    const layout = getRoomLayout(multi);
    expect(getCurrentAreaId(multi, layout)).toBe(MAP_AREA_OFFSET + 1);
    const cleaning = snapshot({}, { current_segment: 2 });
    cleaning.vacuum = { ...cleaning.vacuum!, state: "cleaning" };
    expect(getCurrentAreaId(cleaning, getRoomLayout(snapshot()))).toBe(2);
    expect(getCurrentAreaId(snapshot(), layout)).toBeNull();
    // Dreame keeps current_segment while docked; must not leak to Matter.
    expect(getCurrentAreaId(snapshot({}, { current_segment: 2 }), getRoomLayout(snapshot()))).toBeNull();
  });
});

describe("start", () => {
  it("cleans selected segments through the Dreame action", () => {
    const snap = snapshot();
    const layout = getRoomLayout(snap);
    expect(startCalls(snap, HELPERS, layout, [2, 1])).toEqual([
      { domain: "dreame_vacuum", service: "vacuum_clean_segment", data: { segments: [2, 1] } },
    ]);
  });

  it("starts a full clean without a selection", () => {
    const snap = snapshot();
    expect(startCalls(snap, HELPERS, getRoomLayout(snap), [])).toEqual([{ domain: "vacuum", service: "start" }]);
    expect(startCalls(snap, HELPERS, getRoomLayout(snap), [999])).toEqual([{ domain: "vacuum", service: "start" }]);
  });

  it("switches the map first when rooms of another floor are selected", () => {
    const multi = snapshot({}, { rooms: { ...ROOMS, Upstairs: [{ id: 1, name: "Bedroom" }] } });
    const layout = getRoomLayout(multi);
    expect(startCalls(multi, HELPERS, layout, [MAP_AREA_OFFSET + 1])).toEqual([
      { domain: "select", service: "select_option", data: { option: "Upstairs" }, target: "select.robot_selected_map" },
      { domain: "dreame_vacuum", service: "vacuum_clean_segment", data: { segments: [1] } },
    ]);
  });
});

describe("operational state", () => {
  it("maps vacuum states", () => {
    expect(getOperationalStatus(snapshot()).state).toBe(OpState.Charging);
    expect(getOperationalStatus(snapshot({}, { battery_level: 100 })).state).toBe(OpState.Docked);
    expect(getOperationalStatus({ vacuum: state("v", "cleaning") }).state).toBe(OpState.Running);
    expect(getOperationalStatus({ vacuum: state("v", "paused") }).state).toBe(OpState.Paused);
    expect(getOperationalStatus({ vacuum: state("v", "returning") }).state).toBe(OpState.SeekingCharger);
    expect(getOperationalStatus({ vacuum: state("v", "idle") }).state).toBe(OpState.Stopped);
    expect(getOperationalStatus({ vacuum: state("v", "unavailable") }).state).toBe(OpState.Error);
  });

  it("maps Dreame error texts to Matter error states", () => {
    const E = RvcOperationalState.ErrorState;
    const status = getOperationalStatus({ vacuum: state("v", "error", { error: "Box full" }) });
    expect(status.state).toBe(OpState.Error);
    expect(status.error).toBe(E.DustBinFull);
    expect(mapErrorText("Waterbox empty")).toBe(E.WaterTankEmpty);
    expect(mapErrorText("Tankbox")).toBe(E.WaterTankMissing);
    expect(mapErrorText("Box")).toBe(E.DustBinMissing);
    expect(mapErrorText("Bumper repeat")).toBe(E.Stuck);
    expect(mapErrorText("Charger get")).toBe(E.FailedToFindChargingDock);
    expect(mapErrorText("Something odd")).toBe(E.UnableToCompleteOperation);
  });

  it("derives the run mode", () => {
    expect(getRunMode({ vacuum: state("v", "cleaning") })).toBe(RUN_MODE_CLEANING);
    expect(getRunMode({ vacuum: state("v", "paused") })).toBe(RUN_MODE_CLEANING);
    expect(getRunMode(snapshot())).toBe(RUN_MODE_IDLE);
  });
});

describe("clean modes", () => {
  it("classifies Dreame options", () => {
    expect(classifyCleaningOption("Sweeping")).toBe(CleanType.Vacuum);
    expect(classifyCleaningOption("Mopping")).toBe(CleanType.Mop);
    expect(classifyCleaningOption("sweeping_and_mopping")).toBe(CleanType.VacuumAndMop);
    expect(classifyCleaningOption("Mopping after sweeping")).toBe(CleanType.VacuumThenMop);
  });

  it("assigns Apple's three intensity buckets", () => {
    expect(assignIntensityTags(["Quiet", "Standard", "Strong", "Turbo"])).toEqual([Tag.Quiet, Tag.Auto, null, Tag.Max]);
    expect(assignIntensityTags(["Low", "Medium", "High"])).toEqual([Tag.Quiet, Tag.Auto, Tag.Max]);
    expect(assignIntensityTags(["a", "b", "c"])).toEqual([Tag.Quiet, null, Tag.Max]);
  });

  it("builds base modes plus suction and water variants", () => {
    const modes = buildCleanModes(snapshot());
    const bases = modes.filter((m) => m.kind === "base");
    expect(bases.map((m) => [m.mode, m.label])).toEqual([
      [1, "Sweeping"],
      [2, "Mopping"],
      [3, "Sweeping and mopping"],
      [4, "Mopping after sweeping"],
    ]);
    expect(bases[3].modeTags.map((t) => t.value)).toEqual([Tag.DeepClean, Tag.Vacuum, Tag.Mop]);
    expect(modes.filter((m) => m.kind === "suction").map((m) => m.value)).toEqual(["Quiet", "Standard", "Strong", "Turbo"]);
    expect(modes.filter((m) => m.kind === "water").map((m) => m.value)).toEqual(["Low", "Medium", "High"]);
    expect(new Set(modes.map((m) => m.mode)).size).toBe(modes.length);
  });

  it("keeps the Dreame modes when the select is unavailable", () => {
    const snap = snapshot(
      { cleaningMode: state("select.robot_cleaning_mode", "unavailable") },
      { cleaning_mode: "Sweeping and mopping", mop_pad: true },
    );
    const modes = buildCleanModes(snap);
    expect(modes.filter((m) => m.kind === "base").map((m) => m.value)).toEqual([
      "Sweeping",
      "Mopping",
      "Sweeping and mopping",
      "Mopping after sweeping",
    ]);
    expect(getCurrentCleanMode(snap, modes).mode).toBe(3);
    // Still tries the select when asked to change the mode.
    expect(cleanModeCalls(snap, HELPERS, modes[1])[0]).toEqual({
      domain: "select",
      service: "select_option",
      data: { option: "Mopping" },
      target: "select.robot_cleaning_mode",
    });
  });

  it("uses the vacuum's cleaning_mode_list when the select has none", () => {
    const snap = snapshot(
      { cleaningMode: undefined },
      { cleaning_mode: "Mopping", cleaning_mode_list: ["Sweeping", "Mopping"] },
    );
    const modes = buildCleanModes(snap);
    expect(modes.filter((m) => m.kind === "base").map((m) => m.label)).toEqual(["Sweeping", "Mopping"]);
    expect(getCurrentCleanMode(snap, modes).label).toBe("Mop Medium");
  });

  it("falls back to fan speeds and a filler mode without selects", () => {
    const bare: VacuumSnapshot = {
      vacuum: state("v", "docked", { fan_speed: "standard", fan_speed_list: ["silent", "standard", "turbo"] }),
    };
    const modes = buildCleanModes(bare);
    expect(modes.filter((m) => m.kind === "base").map((m) => m.label)).toEqual(["Vacuum"]);
    expect(modes.filter((m) => m.kind === "suction")).toHaveLength(3);
    expect(getCurrentCleanMode(bare, modes).value).toBe("standard");

    const none = buildCleanModes({ vacuum: state("v", "docked") });
    expect(none.map((m) => m.label)).toEqual(["Vacuum", "Auto"]);
  });

  it("reports the current mode including the intensity", () => {
    const snap = snapshot();
    const modes = buildCleanModes(snap);
    expect(getCurrentCleanMode(snap, modes).label).toBe("Vacuum Standard");
    const mopping = snapshot({ cleaningMode: { ...snap.cleaningMode!, state: "Mopping" } });
    expect(getCurrentCleanMode(mopping, modes).label).toBe("Mop Medium");
    const both = snapshot({ cleaningMode: { ...snap.cleaningMode!, state: "Sweeping and mopping" } });
    expect(getCurrentCleanMode(both, modes).mode).toBe(3);
  });

  it("creates the right service calls for a mode change", () => {
    const snap = snapshot();
    const modes = buildCleanModes(snap);
    const mopHigh = modes.find((m) => m.label === "Mop High")!;
    expect(cleanModeCalls(snap, HELPERS, mopHigh)).toEqual([
      { domain: "select", service: "select_option", data: { option: "Mopping" }, target: "select.robot_cleaning_mode" },
      { domain: "select", service: "select_option", data: { option: "High" }, target: "select.robot_water_volume" },
    ]);
    const turbo = modes.find((m) => m.label === "Vacuum Turbo")!;
    expect(cleanModeCalls(snap, HELPERS, turbo)).toEqual([
      { domain: "select", service: "select_option", data: { option: "Turbo" }, target: "select.robot_suction_level" },
    ]);
    const bare: VacuumSnapshot = { vacuum: state("v", "docked", { fan_speed_list: ["silent", "turbo"] }) };
    const bareModes = buildCleanModes(bare);
    expect(cleanModeCalls(bare, {}, bareModes.find((m) => m.value === "turbo")!)).toEqual([
      { domain: "vacuum", service: "set_fan_speed", data: { fan_speed: "turbo" } },
    ]);
  });
});

describe("power", () => {
  it("reports battery in half percent with charge state", () => {
    expect(getPowerStatus(snapshot())).toEqual({
      percentRemaining: 160,
      chargeLevel: PowerSource.BatChargeLevel.Ok,
      chargeState: PowerSource.BatChargeState.IsCharging,
    });
    expect(getPowerStatus(snapshot({}, { battery_level: 100 })).chargeState).toBe(PowerSource.BatChargeState.IsAtFullCharge);
    expect(getPowerStatus(snapshot({}, { battery_level: 8, charging: false })).chargeLevel).toBe(
      PowerSource.BatChargeLevel.Critical,
    );
  });
});

describe("clean session", () => {
  const S = ServiceArea.OperationalStatus;
  it("tracks pending, operating and completed rooms", () => {
    const session = new CleanSession([1, 2, 4]);
    expect(session.progress().map((p) => p.status)).toEqual([S.Pending, S.Pending, S.Pending]);
    session.visit(2);
    expect(session.progress().map((p) => p.status)).toEqual([S.Pending, S.Operating, S.Pending]);
    session.visit(null);
    session.visit(1);
    expect(session.progress().map((p) => p.status)).toEqual([S.Operating, S.Completed, S.Pending]);
    session.finish(false);
    expect(session.progress().map((p) => p.status)).toEqual([S.Completed, S.Completed, S.Skipped]);
    expect(session.finished).toBe(true);
  });
});
