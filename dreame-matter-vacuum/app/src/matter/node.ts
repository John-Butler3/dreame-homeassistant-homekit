import {
  type Behavior,
  Endpoint,
  Environment,
  Logger as MatterLogger,
  LogLevel as MatterLogLevel,
  ServerNode,
  VendorId,
} from "@matter/main";
import { PowerSourceServer } from "@matter/main/behaviors/power-source";
import { PowerSource } from "@matter/main/clusters/power-source";
import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices/robotic-vacuum-cleaner";
import type { AppConfig } from "../config.js";
import type { DeviceRegistryEntry } from "../ha/types.js";
import { createLogger, type LogLevel } from "../logger.js";
import type { CompletionInfo, VacuumController, VacuumView } from "../vacuum/controller.js";
import { RUN_MODES, toMatterArea, toMatterCleanMode, toMatterMap } from "../vacuum/model.js";
import { VacuumCleanModeServer } from "./behaviors/clean-mode.js";
import { VacuumIdentifyServer } from "./behaviors/identify.js";
import { VacuumOnOffServer } from "./behaviors/on-off.js";
import { VacuumOperationalStateServer } from "./behaviors/operational-state.js";
import { VacuumRunModeServer } from "./behaviors/run-mode.js";
import { VacuumServiceAreaServer } from "./behaviors/service-area.js";
import { VacuumControllerRef } from "./controller-ref.js";

const log = createLogger("matter");

const BatteryPowerSourceServer = PowerSourceServer.with(
  PowerSource.Feature.Battery,
  PowerSource.Feature.Rechargeable,
);

const VacuumDevice = RoboticVacuumCleanerDevice.with(
  VacuumIdentifyServer,
  VacuumRunModeServer,
  VacuumOperationalStateServer,
  VacuumCleanModeServer,
  VacuumServiceAreaServer,
  BatteryPowerSourceServer,
);

const VacuumDeviceWithOnOff = VacuumDevice.with(VacuumOnOffServer);

const ALL_OPERATIONAL_STATES = Object.values(RvcOperationalState.OperationalState)
  .filter((v): v is number => typeof v === "number")
  .map((operationalStateId) => ({ operationalStateId }));

export interface PairingInfo {
  commissioned: boolean;
  fabrics: number;
  qrPairingCode: string;
  manualPairingCode: string;
}

/** Owns the Matter server node and keeps the vacuum endpoint in sync. */
export class MatterVacuumNode {
  private node?: ServerNode;
  private endpoint?: Endpoint<typeof VacuumDevice>;
  private lastMapsKey = "";

  constructor(
    private readonly config: AppConfig,
    private readonly controller: VacuumController,
    private readonly device: DeviceRegistryEntry | undefined,
  ) {}

  async start(): Promise<void> {
    configureMatterLogging(this.config.logLevel);
    const environment = Environment.default;
    environment.vars.set("storage.path", this.config.storagePath);
    if (this.config.mdnsInterface) {
      environment.vars.set("mdns.networkInterface", this.config.mdnsInterface);
    }
    environment.set(VacuumControllerRef, new VacuumControllerRef(this.controller));

    const view = this.controller.view();
    const deviceName = this.config.deviceName.slice(0, 32);
    const serial = (this.device?.serial_number ?? this.config.vacuumEntity).slice(0, 32);

    this.node = await ServerNode.create({
      id: "dreame-matter-vacuum",
      environment,
      network: { port: this.config.matterPort },
      productDescription: {
        name: deviceName,
        deviceType: RoboticVacuumCleanerDevice.deviceType,
      },
      basicInformation: {
        vendorName: (this.device?.manufacturer ?? "Dreame").slice(0, 32),
        vendorId: VendorId(0xfff1),
        nodeLabel: deviceName,
        productName: (this.device?.model ?? "Robot Vacuum").slice(0, 32),
        productLabel: (this.device?.model ?? "Robot Vacuum").slice(0, 64),
        productId: 0x8001,
        serialNumber: serial,
        uniqueId: `dreame-${serial}`.slice(0, 32),
        hardwareVersionString: (this.device?.hw_version ?? "1").slice(0, 64),
        softwareVersionString: (this.device?.sw_version ?? "1").slice(0, 64),
      },
    });

    const Device = this.config.onOffCluster ? VacuumDeviceWithOnOff : VacuumDevice;
    this.endpoint = new Endpoint(Device.set(initialState(view, this.config.onOffCluster) as never), {
      id: "vacuum",
    });
    await this.node.add(this.endpoint);
    this.lastMapsKey = mapsKey(view);

    this.controller.onChange((v) => this.scheduleSync(v));
    this.controller.onCompletion((info) => void this.emitCompletion(info));

    await this.node.start();
    log.info(`Matter node online on UDP ${this.config.matterPort}`);
    const pairing = this.pairingInfo();
    if (pairing && !pairing.commissioned) {
      log.info(`Not paired yet. Manual pairing code: ${pairing.manualPairingCode}`);
      log.info(`QR pairing code: ${pairing.qrPairingCode}`);
    } else if (pairing) {
      log.info(`Paired with ${pairing.fabrics} controller(s)`);
    }
  }

  pairingInfo(): PairingInfo | undefined {
    if (!this.node) return undefined;
    const commissioning = this.node.state.commissioning;
    return {
      commissioned: commissioning.commissioned,
      fabrics: Object.keys(commissioning.fabrics ?? {}).length,
      qrPairingCode: commissioning.pairingCodes.qrPairingCode,
      manualPairingCode: commissioning.pairingCodes.manualPairingCode,
    };
  }

  async factoryReset(): Promise<void> {
    if (!this.node) return;
    log.warn("Factory reset requested: removing all fabrics");
    await this.node.erase();
    await this.node.start();
    log.info("Matter node restarted after factory reset");
  }

  async close(): Promise<void> {
    await this.node?.close();
  }

  // ------------------------------------------------------------- syncing

  private pendingView: VacuumView | null = null;
  private syncing = false;

  /** Coalesce rapid updates and apply them strictly one after another. */
  private scheduleSync(view: VacuumView): void {
    this.pendingView = view;
    if (this.syncing) return;
    this.syncing = true;
    void (async () => {
      try {
        while (this.pendingView) {
          const next = this.pendingView;
          this.pendingView = null;
          await this.sync(next);
        }
      } finally {
        this.syncing = false;
      }
    })();
  }

  private async sync(view: VacuumView): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint || !endpoint.lifecycle.isReady) return;
    try {
      await this.syncServiceArea(endpoint, view);
      await patch(endpoint, VacuumOperationalStateServer, {
        operationalState: view.operational.state,
        operationalError: { errorStateId: view.operational.error },
      });
      await patch(endpoint, VacuumRunModeServer, { currentMode: view.runMode });
      await patch(endpoint, VacuumCleanModeServer, { supportedModes: view.cleanModes.map(toMatterCleanMode) });
      await patch(endpoint, VacuumCleanModeServer, { currentMode: view.currentCleanMode.mode });
      await patch(endpoint, BatteryPowerSourceServer, {
        batPercentRemaining: view.power.percentRemaining,
        batChargeLevel: view.power.chargeLevel,
        batChargeState: view.power.chargeState,
      });
      if (this.config.onOffCluster) {
        await patch(endpoint, VacuumOnOffServer, {
          onOff: view.operational.state === RvcOperationalState.OperationalState.Running,
        });
      }
    } catch (err) {
      log.error("Failed to update Matter state", err);
    }
  }

  private async syncServiceArea(endpoint: Endpoint<typeof VacuumDevice>, view: VacuumView): Promise<void> {
    const supportedIds = new Set(view.layout.areas.map((a) => a.areaId));
    const current = endpoint.stateOf(VacuumServiceAreaServer);
    const key = mapsKey(view);
    if (key !== this.lastMapsKey) {
      // Maps changed: clear everything that references areas first, then
      // publish maps and areas (matter.js validates each step).
      await endpoint.setStateOf(VacuumServiceAreaServer, {
        selectedAreas: [],
        progress: [],
        currentArea: null,
        supportedAreas: [],
      });
      await endpoint.setStateOf(VacuumServiceAreaServer, {
        supportedMaps: view.layout.maps.map(toMatterMap),
      });
      this.lastMapsKey = key;
    }
    await patch(endpoint, VacuumServiceAreaServer, { supportedAreas: view.layout.areas.map(toMatterArea) });

    const values: Record<string, unknown> = {
      selectedAreas: current.selectedAreas.filter((id) => supportedIds.has(id)),
      currentArea: view.currentAreaId !== null && supportedIds.has(view.currentAreaId) ? view.currentAreaId : null,
    };
    if (view.session) {
      // Progress belongs to the running / finished job. Without a job the
      // list stays as the last selection left it (pending rooms).
      values.progress = view.session.progress().filter((p) => supportedIds.has(p.areaId));
    } else {
      values.progress = current.progress.filter((p) => supportedIds.has(p.areaId));
    }
    await patch(endpoint, VacuumServiceAreaServer, values as never);
  }

  private async emitCompletion(info: CompletionInfo): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint || !endpoint.lifecycle.isReady) return;
    try {
      await endpoint.act((agent) => {
        agent.get(VacuumOperationalStateServer).events.operationCompletion?.emit(
          {
            completionErrorCode: RvcOperationalState.ErrorState.NoError,
            totalOperationalTime: info.totalOperationalTime,
            pausedTime: info.pausedTime,
          },
          agent.context,
        );
      });
    } catch (err) {
      log.error("Failed to emit OperationCompletion", err);
    }
  }
}

/** Write only the values that differ from the current state. */
async function patch(
  endpoint: Endpoint<typeof VacuumDevice>,
  type: Behavior.Type,
  values: Record<string, unknown>,
): Promise<void> {
  const current = endpoint.stateOf(type as never) as unknown as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(value ?? null)) {
      changed[key] = value;
    }
  }
  if (Object.keys(changed).length > 0) {
    await endpoint.setStateOf(type as never, changed as never);
  }
}

function mapsKey(view: VacuumView): string {
  return JSON.stringify(view.layout.maps);
}

function initialState(view: VacuumView, onOff: boolean) {
  const state: Record<string, unknown> = {
    rvcRunMode: { supportedModes: RUN_MODES, currentMode: view.runMode },
    rvcOperationalState: {
      operationalStateList: ALL_OPERATIONAL_STATES,
      operationalState: view.operational.state,
      operationalError: { errorStateId: view.operational.error },
      phaseList: null,
      currentPhase: null,
    },
    rvcCleanMode: {
      supportedModes: view.cleanModes.map(toMatterCleanMode),
      currentMode: view.currentCleanMode.mode,
    },
    serviceArea: {
      supportedMaps: view.layout.maps.map(toMatterMap),
      supportedAreas: view.layout.areas.map(toMatterArea),
      selectedAreas: [],
      currentArea: view.currentAreaId,
      progress: [],
    },
    powerSource: {
      status: PowerSource.PowerSourceStatus.Active,
      order: 0,
      description: "Battery",
      batChargeLevel: view.power.chargeLevel,
      batReplacementNeeded: false,
      batReplaceability: PowerSource.BatReplaceability.Unspecified,
      batPercentRemaining: view.power.percentRemaining,
      batChargeState: view.power.chargeState,
      batFunctionalWhileCharging: false,
      endpointList: [],
    },
  };
  if (onOff) {
    state.onOff = { onOff: view.operational.state === RvcOperationalState.OperationalState.Running };
  }
  return state;
}

function configureMatterLogging(level: LogLevel): void {
  const map: Record<LogLevel, MatterLogLevel> = {
    debug: MatterLogLevel.DEBUG,
    info: MatterLogLevel.NOTICE,
    warn: MatterLogLevel.WARN,
    error: MatterLogLevel.ERROR,
  };
  MatterLogger.level = map[level] ?? MatterLogLevel.NOTICE;
}
