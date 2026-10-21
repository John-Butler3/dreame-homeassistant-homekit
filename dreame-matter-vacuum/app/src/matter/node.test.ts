/**
 * Integration smoke test: builds the real Matter node (in a temp storage
 * directory, on a random port) around a fake Home Assistant client and
 * exercises the cluster commands end to end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RvcOperationalState, ServiceArea } from "@matter/main/clusters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import type { HomeAssistantClient } from "../ha/client.js";
import type { HassState, ServiceCall } from "../ha/types.js";
import { VacuumController } from "../vacuum/controller.js";
import { VacuumCleanModeServer } from "./behaviors/clean-mode.js";
import { VacuumOperationalStateServer } from "./behaviors/operational-state.js";
import { VacuumRunModeServer } from "./behaviors/run-mode.js";
import { VacuumServiceAreaServer } from "./behaviors/service-area.js";
import { MatterVacuumNode } from "./node.js";

type Listener = (states: Record<string, HassState>) => void;

class FakeHa {
  states: Record<string, HassState> = {};
  calls: ServiceCall[] = [];
  listeners = new Set<Listener>();

  set(entityId: string, state: string, attributes: Record<string, unknown> = {}) {
    const previous = this.states[entityId];
    this.states = {
      ...this.states,
      [entityId]: { entity_id: entityId, state, attributes: { ...(previous?.attributes ?? {}), ...attributes } },
    };
    for (const l of this.listeners) l(this.states);
  }
  getState(id: string) {
    return this.states[id];
  }
  getAllStates() {
    return this.states;
  }
  onStates(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async call(call: ServiceCall, defaultTarget: string) {
    this.calls.push({ ...call, target: call.target ?? defaultTarget });
  }
}

const VACUUM = "vacuum.robot";
const ha = new FakeHa();
let node: MatterVacuumNode;
let storage: string;

function seed() {
  ha.set(VACUUM, "docked", {
    battery_level: 90,
    charging: true,
    fan_speed: "standard",
    fan_speed_list: ["silent", "standard", "strong", "turbo"],
    rooms: {
      "Ground floor": [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Living room" },
      ],
      Upstairs: [{ id: 1, name: "Bedroom" }],
    },
    selected_map: "Ground floor",
    current_segment: 0,
  });
  ha.set("select.robot_cleaning_mode", "Sweeping", {
    options: ["Sweeping", "Mopping", "Sweeping and mopping", "Mopping after sweeping"],
  });
  ha.set("select.robot_suction_level", "Standard", { options: ["Quiet", "Standard", "Strong", "Turbo"] });
  ha.set("select.robot_water_volume", "Medium", { options: ["Low", "Medium", "High"] });
  ha.set("select.robot_selected_map", "Ground floor", { options: ["Ground floor", "Upstairs"] });
}

const controller = new VacuumController(ha as unknown as HomeAssistantClient, {
  vacuumEntity: VACUUM,
  helpers: {
    cleaningModeEntity: "select.robot_cleaning_mode",
    suctionLevelEntity: "select.robot_suction_level",
    waterVolumeEntity: "select.robot_water_volume",
    selectedMapEntity: "select.robot_selected_map",
    stateSensorEntity: "sensor.robot_state",
  },
  includeUnnamedRooms: false,
});

type EndpointOf = NonNullable<MatterVacuumNode["endpoint"]>;
const endpointOf = (n: MatterVacuumNode) => (n as unknown as { endpoint: EndpointOf }).endpoint;

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  seed();
  controller.start();
  storage = mkdtempSync(join(tmpdir(), "dmv-test-"));
  const config: AppConfig = {
    homeAssistantUrl: "http://localhost",
    homeAssistantToken: "x",
    vacuumEntity: VACUUM,
    deviceName: "Test Vacuum",
    includeUnnamedRooms: false,
    onOffCluster: false,
    matterPort: 15540 + Math.floor(Math.random() * 1000),
    webPort: 0,
    storagePath: storage,
    logLevel: "error",
  };
  node = new MatterVacuumNode(config, controller, undefined);
  await node.start();
}, 60000);

afterAll(async () => {
  await node.close();
  rmSync(storage, { recursive: true, force: true });
});

describe("matter node", () => {
  it("publishes rooms, maps, modes and battery", () => {
    const endpoint = endpointOf(node);
    const area = endpoint.stateOf(VacuumServiceAreaServer);
    expect(area.supportedMaps.map((m) => m.name)).toEqual(["Ground floor", "Upstairs"]);
    expect(area.supportedAreas.map((a) => a.areaInfo.locationInfo?.locationName)).toEqual([
      "Kitchen",
      "Living room",
      "Bedroom",
    ]);
    const clean = endpoint.stateOf(VacuumCleanModeServer);
    expect(clean.supportedModes.map((m) => m.label)).toContain("Deep clean");
    expect(clean.supportedModes.find((m) => m.mode === clean.currentMode)?.label).toBe("Vacuum Standard");
    expect(endpoint.stateOf(VacuumOperationalStateServer).operationalState).toBe(
      RvcOperationalState.OperationalState.Charging,
    );
    expect(endpoint.stateOf("powerSource")).toMatchObject({ batPercentRemaining: 180 });
    expect(node.pairingInfo()?.manualPairingCode).toMatch(/^\d{11}$/);
  });

  it("selects rooms and starts a segment clean", async () => {
    const endpoint = endpointOf(node);
    // Dreame reports the dock's room while docked; Apple must not see it.
    ha.set(VACUUM, "docked", { current_segment: 1 });
    await settle();
    expect(endpoint.stateOf(VacuumServiceAreaServer).currentArea).toBeNull();

    const result = await endpoint.act((agent) =>
      agent.get(VacuumServiceAreaServer).selectAreas({ newAreas: [2, 1] }),
    );
    expect(result.status).toBe(ServiceArea.SelectAreasStatus.Success);
    let selection = endpoint.stateOf(VacuumServiceAreaServer);
    expect(selection.selectedAreas).toEqual([2, 1]);
    expect(selection.currentArea).toBeNull();
    expect(selection.progress.map((p) => [p.areaId, p.status])).toEqual([
      [2, ServiceArea.OperationalStatus.Pending],
      [1, ServiceArea.OperationalStatus.Pending],
    ]);
    // Unrelated state updates keep the selection and pending progress.
    ha.set(VACUUM, "docked", { battery_level: 91 });
    await settle();
    selection = endpoint.stateOf(VacuumServiceAreaServer);
    expect(selection.selectedAreas).toEqual([2, 1]);
    expect(selection.progress).toHaveLength(2);

    ha.calls = [];
    const response = await endpoint.act((agent) => agent.get(VacuumRunModeServer).changeToMode({ newMode: 1 }));
    expect(response.status).toBe(0);
    expect(ha.calls).toEqual([
      { domain: "dreame_vacuum", service: "vacuum_clean_segment", data: { segments: [2, 1] }, target: VACUUM },
    ]);

    // Robot reports progress through the rooms.
    ha.set(VACUUM, "cleaning", { current_segment: 2, charging: false });
    await settle();
    let area = endpoint.stateOf(VacuumServiceAreaServer);
    expect(area.currentArea).toBe(2);
    expect(area.progress.map((p) => p.status)).toEqual([
      ServiceArea.OperationalStatus.Operating,
      ServiceArea.OperationalStatus.Pending,
    ]);
    expect(endpoint.stateOf(VacuumOperationalStateServer).operationalState).toBe(
      RvcOperationalState.OperationalState.Running,
    );

    // Selecting rooms while running is refused.
    const refused = await endpoint.act((agent) => agent.get(VacuumServiceAreaServer).selectAreas({ newAreas: [1] }));
    expect(refused.status).toBe(ServiceArea.SelectAreasStatus.InvalidInMode);

    ha.set(VACUUM, "cleaning", { current_segment: 1 });
    await settle();
    ha.set(VACUUM, "returning", { current_segment: 0 });
    await settle();
    ha.set(VACUUM, "docked", { charging: true });
    await settle();
    area = endpoint.stateOf(VacuumServiceAreaServer);
    expect(area.progress.map((p) => p.status)).toEqual([
      ServiceArea.OperationalStatus.Completed,
      ServiceArea.OperationalStatus.Completed,
    ]);
    expect(area.currentArea).toBeNull();
  });

  it("pauses, resumes and goes home", async () => {
    const endpoint = endpointOf(node);
    ha.set(VACUUM, "cleaning", { current_segment: 1, charging: false });
    await settle();
    ha.calls = [];
    await endpoint.act((agent) => agent.get(VacuumOperationalStateServer).pause());
    ha.set(VACUUM, "paused");
    await settle();
    await endpoint.act((agent) => agent.get(VacuumOperationalStateServer).resume());
    ha.set(VACUUM, "cleaning");
    await settle();
    await endpoint.act((agent) => agent.get(VacuumOperationalStateServer).goHome());
    expect(ha.calls.map((c) => `${c.domain}.${c.service}`)).toEqual(["vacuum.pause", "vacuum.start", "vacuum.return_to_base"]);
    ha.set(VACUUM, "docked", { charging: true });
    await settle();
  });

  it("changes the clean mode through the Dreame selects", async () => {
    const endpoint = endpointOf(node);
    const modes = endpoint.stateOf(VacuumCleanModeServer).supportedModes;
    const mopHigh = modes.find((m) => m.label === "Mop High")!;
    ha.calls = [];
    const result = await endpoint.act((agent) =>
      agent.get(VacuumCleanModeServer).changeToMode({ newMode: mopHigh.mode }),
    );
    expect(result.status).toBe(0);
    expect(ha.calls).toEqual([
      { domain: "select", service: "select_option", data: { option: "Mopping" }, target: "select.robot_cleaning_mode" },
      { domain: "select", service: "select_option", data: { option: "High" }, target: "select.robot_water_volume" },
    ]);
    ha.set("select.robot_cleaning_mode", "Mopping");
    ha.set("select.robot_water_volume", "High");
    await settle();
    expect(endpoint.stateOf(VacuumCleanModeServer).currentMode).toBe(mopHigh.mode);
  });

  it("remembers real select options while CleanGenius locks them", async () => {
    const endpoint = endpointOf(node);
    ha.set("select.robot_water_volume", "unavailable", { options: ["unavailable"] });
    ha.set("select.robot_suction_level", "unavailable", { options: ["unavailable"] });
    await settle();
    const labels = endpoint.stateOf(VacuumCleanModeServer).supportedModes.map((m) => m.label);
    expect(labels).toContain("Mop High");
    expect(labels).toContain("Vacuum Turbo");
    expect(labels.some((l) => /unavailable/i.test(l))).toBe(false);
    ha.set("select.robot_water_volume", "Medium", { options: ["Low", "Medium", "High"] });
    ha.set("select.robot_suction_level", "Standard", { options: ["Quiet", "Standard", "Strong", "Turbo"] });
    await settle();
  });

  it("switches floors for rooms on another map", async () => {
    const endpoint = endpointOf(node);
    const bedroom = endpoint.stateOf(VacuumServiceAreaServer).supportedAreas.find(
      (a) => a.areaInfo.locationInfo?.locationName === "Bedroom",
    )!;
    await endpoint.act((agent) => agent.get(VacuumServiceAreaServer).selectAreas({ newAreas: [bedroom.areaId] }));
    ha.calls = [];
    await endpoint.act((agent) => agent.get(VacuumRunModeServer).changeToMode({ newMode: 1 }));
    expect(ha.calls).toEqual([
      { domain: "select", service: "select_option", data: { option: "Upstairs" }, target: "select.robot_selected_map" },
      { domain: "dreame_vacuum", service: "vacuum_clean_segment", data: { segments: [1] }, target: VACUUM },
    ]);
  });

  it("reports base activity as the current phase", async () => {
    const endpoint = endpointOf(node);
    const state = () => endpoint.stateOf(VacuumOperationalStateServer);
    expect(state().phaseList).toContain("Washing mop pads");
    ha.set("sensor.robot_state", "washing");
    ha.set(VACUUM, "cleaning", { charging: false });
    await settle();
    expect(state().phaseList![state().currentPhase!]).toBe("Washing mop pads");
    expect(state().operationalState).toBe(RvcOperationalState.OperationalState.Running);
    ha.set("sensor.robot_state", "drying");
    ha.set(VACUUM, "docked", { charging: true });
    await settle();
    expect(state().phaseList![state().currentPhase!]).toBe("Drying mop pads");
    ha.set("sensor.robot_state", "charging");
    await settle();
    expect(state().phaseList![state().currentPhase!]).toBe("Charging");
  });

  it("reports errors", async () => {
    const endpoint = endpointOf(node);
    ha.set(VACUUM, "error", { error: "Box full" });
    await settle();
    const state = endpoint.stateOf(VacuumOperationalStateServer);
    expect(state.operationalState).toBe(RvcOperationalState.OperationalState.Error);
    expect(state.operationalError.errorStateId).toBe(RvcOperationalState.ErrorState.DustBinFull);
    expect(state.operationalError.errorStateLabel).toBeUndefined();
    expect(state.operationalError.errorStateDetails).toBe("Dust bin full: Box full");

    // Station problems while docked are errors too, and clear again.
    ha.set(VACUUM, "docked", { error: "No error", charging: true, dirty_water_tank_status: "Not installed or full" });
    await settle();
    const station = endpoint.stateOf(VacuumOperationalStateServer).operationalError;
    expect(station.errorStateId).toBe(RvcOperationalState.ErrorState.WaterTankMissing);
    expect(station.errorStateDetails).toContain("Dirty water tank full or missing");
    ha.set(VACUUM, "docked", { dirty_water_tank_status: "Installed" });
    await settle();
    ha.set(VACUUM, "docked", { error: "No error", charging: true });
    await settle();
    expect(endpoint.stateOf(VacuumOperationalStateServer).operationalState).toBe(
      RvcOperationalState.OperationalState.Charging,
    );
  });
});
