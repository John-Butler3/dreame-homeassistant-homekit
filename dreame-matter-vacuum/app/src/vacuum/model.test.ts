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
  findDefaultMode,
  getCurrentAreaId,
  getCurrentCleanMode,
  getOperationalStatus,
  getPhase,
  getPowerStatus,
  PHASES,
  phaseIndex,
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

  it("reports station problems as operational errors with labels", () => {
    const E = RvcOperationalState.ErrorState;
    const dirty = getOperationalStatus(snapshot({}, { dirty_water_tank_status: "Not installed or full" }));
    expect(dirty.state).toBe(OpState.Error);
    expect(dirty.error).toBe(E.WaterTankMissing);
    expect(dirty.errorLabel).toBe("Dirty water tank full or missing");

    const clean = getOperationalStatus(snapshot({}, { clean_water_tank_status: "Low water" }));
    expect(clean.error).toBe(E.WaterTankEmpty);
    expect(getOperationalStatus(snapshot({}, { clean_water_tank_status: "Not installed" })).error).toBe(E.WaterTankMissing);
    expect(getOperationalStatus(snapshot({}, { low_water_warning: "No water left" })).error).toBe(E.WaterTankEmpty);
    expect(getOperationalStatus(snapshot({}, { dust_bag_status: "Check" })).error).toBe(E.DustBinFull);
    const detergent = getOperationalStatus(snapshot({}, { detergent_status: "Low detergent" }));
    expect(detergent.error).toBe(E.UnableToCompleteOperation);
    expect(detergent.errorLabel).toBe("Detergent low");

    // Normal station readings do not raise anything.
    const fine = getOperationalStatus(
      snapshot(
        {},
        {
          dirty_water_tank_status: "Installed",
          clean_water_tank_status: "Installed",
          low_water_warning: "No warning",
          dust_bag_status: "Installed",
          detergent_status: "Installed",
        },
      ),
    );
    expect(fine.state).toBe(OpState.Charging);
    expect(fine.error).toBe(E.NoError);

    // A robot error wins and gets a readable label.
    const stuck = getOperationalStatus({ vacuum: state("v", "error", { error: "Bumper repeat" }) });
    expect(stuck.errorLabel).toBe("Robot is stuck");
    expect(stuck.errorText).toBe("Bumper repeat");
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
      [4, "Deep clean"],
      [1, "Vacuum"],
      [3, "Vacuum and mop"],
      [2, "Mop"],
    ]);
    expect(bases[0].modeTags.map((t) => t.value)).toEqual([Tag.DeepClean, Tag.Vacuum, Tag.Mop]);
    expect(modes.filter((m) => m.kind === "suction" && m.type === CleanType.Vacuum).map((m) => m.value)).toEqual([
      "Quiet",
      "Standard",
      "Strong",
      "Turbo",
    ]);
    const both = modes.filter((m) => m.kind === "suction" && m.type === CleanType.VacuumAndMop);
    expect(both.map((m) => m.label)).toEqual([
      "Vacuum and mop Quiet",
      "Vacuum and mop Standard",
      "Vacuum and mop Strong",
      "Vacuum and mop Turbo",
    ]);
    expect(both[1].modeTags.map((t) => t.value)).toEqual([Tag.Vacuum, Tag.Mop, Tag.Auto]);
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
      "mopping_after_sweeping",
      "sweeping",
      "sweeping_and_mopping",
      "mopping",
    ]);
    expect(getCurrentCleanMode(snap, modes).label).toBe("Vacuum and mop Standard");
    // Still tries the select when asked to change the mode.
    expect(cleanModeCalls(snap, HELPERS, modes.find((m) => m.label === "Mop")!)[0]).toEqual({
      domain: "select",
      service: "select_option",
      data: { option: "mopping" },
      target: "select.robot_cleaning_mode",
    });
  });

  it("ignores Dreame's 'unavailable' placeholder options", () => {
    const locked = snapshot(
      {
        cleaningMode: state("select.robot_cleaning_mode", "unavailable", { options: ["unavailable"] }),
        suctionLevel: state("select.robot_suction_level", "unavailable", { options: ["unavailable"] }),
        waterVolume: state("select.robot_water_volume", "unavailable", { options: ["unavailable"] }),
        cleanGenius: state("select.robot_cleangenius", "routine_cleaning", {
          options: ["off", "routine_cleaning", "deep_cleaning"],
        }),
      },
      { cleaning_mode: "Sweeping and mopping", fan_speed_list: [] },
    );
    const modes = buildCleanModes(locked);
    expect(modes.filter((m) => m.kind === "base").map((m) => m.label)).toEqual([
      "CleanGenius",
      "Deep clean",
      "Vacuum",
      "Vacuum and mop",
      "Mop",
    ]);
    expect(modes.filter((m) => m.kind === "suction" && m.type === CleanType.Vacuum).map((m) => m.value)).toEqual([
      "quiet",
      "standard",
      "strong",
      "turbo",
    ]);
    expect(modes.filter((m) => m.kind === "water").map((m) => m.value)).toEqual(["low", "medium", "high"]);
    expect(modes.some((m) => /unavailable/i.test(m.label))).toBe(false);

    // Self-wash base models use mop pad humidity instead of water volume.
    const humidity = snapshot({
      waterVolume: state("select.robot_mop_pad_humidity", "unavailable", { options: ["unavailable"] }),
    });
    expect(buildCleanModes(humidity).filter((m) => m.kind === "water").map((m) => m.value)).toEqual([
      "slightly_dry",
      "moist",
      "wet",
    ]);
    expect(assignIntensityTags(["slightly_dry", "moist", "wet"])).toEqual([Tag.Quiet, Tag.Auto, Tag.Max]);
    expect(getCurrentCleanMode(locked, modes).label).toBe("CleanGenius");
  });

  it("uses the vacuum's cleaning_mode_list when the select has none", () => {
    const snap = snapshot(
      { cleaningMode: undefined },
      { cleaning_mode: "Mopping", cleaning_mode_list: ["Sweeping", "Mopping"] },
    );
    const modes = buildCleanModes(snap);
    expect(modes.filter((m) => m.kind === "base").map((m) => m.label)).toEqual(["Vacuum", "Mop"]);
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
    expect(getCurrentCleanMode(both, modes).label).toBe("Vacuum and mop Standard");
    const deep = snapshot({ cleaningMode: { ...snap.cleaningMode!, state: "Mopping after sweeping" } });
    expect(getCurrentCleanMode(deep, modes).label).toBe("Deep clean");
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
    const bothMax = modes.find((m) => m.label === "Vacuum and mop Turbo")!;
    expect(cleanModeCalls(snap, HELPERS, bothMax)).toEqual([
      {
        domain: "select",
        service: "select_option",
        data: { option: "Sweeping and mopping" },
        target: "select.robot_cleaning_mode",
      },
      { domain: "select", service: "select_option", data: { option: "Turbo" }, target: "select.robot_suction_level" },
    ]);
    const bare: VacuumSnapshot = { vacuum: state("v", "docked", { fan_speed_list: ["silent", "turbo"] }) };
    const bareModes = buildCleanModes(bare);
    expect(cleanModeCalls(bare, {}, bareModes.find((m) => m.value === "turbo")!)).toEqual([
      { domain: "vacuum", service: "set_fan_speed", data: { fan_speed: "turbo" } },
    ]);
  });
});

describe("CleanGenius", () => {
  const GENIUS = {
    ...HELPERS,
    cleanGeniusEntity: "select.robot_cleangenius",
  };
  const geniusSnapshot = (stateValue: string) =>
    snapshot({
      cleanGenius: state("select.robot_cleangenius", stateValue, {
        options: ["off", "routine_cleaning", "deep_cleaning"],
      }),
    });

  it("adds an Automatic mode when the robot has CleanGenius", () => {
    const modes = buildCleanModes(geniusSnapshot("off"));
    const bases = modes.filter((m) => m.kind === "base");
    expect(bases.map((m) => m.label)).toEqual(["CleanGenius", "Deep clean", "Vacuum", "Vacuum and mop", "Mop"]);
    expect(bases[0].modeTags).toEqual([{ value: Tag.Auto }]);
    expect(buildCleanModes(snapshot()).some((m) => m.type === CleanType.CleanGenius)).toBe(false);
  });

  it("reports CleanGenius as current while it is on", () => {
    const on = geniusSnapshot("routine_cleaning");
    expect(getCurrentCleanMode(on, buildCleanModes(on)).label).toBe("CleanGenius");
    const off = geniusSnapshot("off");
    expect(getCurrentCleanMode(off, buildCleanModes(off)).label).toBe("Vacuum Standard");
    const viaAttribute = snapshot({}, { cleangenius: "Deep cleaning" });
    expect(getCurrentCleanMode(viaAttribute, buildCleanModes(viaAttribute)).label).toBe("CleanGenius");
  });

  it("turns CleanGenius off before a manual mode and on for Automatic", () => {
    const on = geniusSnapshot("routine_cleaning");
    const modes = buildCleanModes(on);
    const mop = modes.find((m) => m.label === "Mop")!;
    expect(cleanModeCalls(on, GENIUS, mop)).toEqual([
      { domain: "select", service: "select_option", data: { option: "off" }, target: "select.robot_cleangenius" },
      { domain: "select", service: "select_option", data: { option: "Mopping" }, target: "select.robot_cleaning_mode" },
    ]);
    const off = geniusSnapshot("off");
    const genius = buildCleanModes(off).find((m) => m.label === "CleanGenius")!;
    expect(cleanModeCalls(off, GENIUS, genius)).toEqual([
      {
        domain: "select",
        service: "select_option",
        data: { option: "routine_cleaning" },
        target: "select.robot_cleangenius",
      },
    ]);
    expect(cleanModeCalls(on, GENIUS, buildCleanModes(on).find((m) => m.label === "CleanGenius")!)).toEqual([]);
  });
});

describe("default mode", () => {
  it("resolves the configured default", () => {
    const modes = buildCleanModes(snapshot());
    expect(findDefaultMode(modes, "vacuum_and_mop", "standard")?.label).toBe("Vacuum and mop Standard");
    expect(findDefaultMode(modes, "Vacuum and mop", "keep")?.label).toBe("Vacuum and mop");
    expect(findDefaultMode(modes, "deep_clean", "turbo")?.label).toBe("Deep clean");
    expect(findDefaultMode(modes, "mop", "turbo")?.label).toBe("Mop");
    expect(findDefaultMode(modes, undefined, "standard")).toBeUndefined();
    expect(findDefaultMode(modes, "cleangenius", undefined)).toBeUndefined();
  });
});

describe("phases", () => {
  it("derives the activity from the state sensor", () => {
    const withSensor = (value: string, vacuumState = "cleaning") => {
      const snap = snapshot({ stateSensor: state("sensor.robot_state", value) });
      snap.vacuum = { ...snap.vacuum!, state: vacuumState };
      return snap;
    };
    expect(getPhase(withSensor("washing"))).toBe("Washing mop pads");
    expect(getPhase(withSensor("washing_paused", "paused"))).toBe("Washing mop pads");
    expect(getPhase(withSensor("returning_to_wash", "returning"))).toBe("Returning to wash mop pads");
    expect(getPhase(withSensor("drying", "docked"))).toBe("Drying mop pads");
    expect(getPhase(withSensor("auto_emptying", "docked"))).toBe("Emptying dust bin");
    expect(getPhase(withSensor("dust_bag_drying", "docked"))).toBe("Emptying dust bin");
    expect(getPhase(withSensor("draining", "cleaning"))).toBe("Draining water");
    expect(getPhase(withSensor("station_cleaning", "cleaning"))).toBe("Cleaning the station");
    expect(getPhase(withSensor("sweeping"))).toBe("Cleaning");
    expect(getPhase(withSensor("charging", "docked"))).toBe("Charging");
    expect(getPhase(withSensor("charging_completed", "docked"), )).toBe("Charging");
  });

  it("falls back to the vacuum attributes and state", () => {
    expect(getPhase(snapshot())).toBe("Charging");
    expect(getPhase(snapshot({}, { battery_level: 100 }))).toBe("Idle");
    const washing = snapshot({}, { washing: true });
    washing.vacuum = { ...washing.vacuum!, state: "cleaning" };
    expect(getPhase(washing)).toBe("Washing mop pads");
    expect(getPhase(snapshot({}, { drying: true }))).toBe("Drying mop pads");
    expect(getPhase({ vacuum: state("v", "returning") })).toBe("Returning to dock");
    expect(getPhase({ vacuum: state("v", "unavailable") })).toBe("Idle");
    expect(getPhase({ vacuum: state("v", "error", { error: "Box full" }) })).toBe("Attention needed");
    expect(phaseIndex("Washing mop pads")).toBe(PHASES.indexOf("Washing mop pads"));
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
