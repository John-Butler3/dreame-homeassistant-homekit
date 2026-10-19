import type { HomeAssistantClient } from "../ha/client.js";
import type { HassState, ServiceCall } from "../ha/types.js";
import { createLogger } from "../logger.js";
import {
  buildCleanModes,
  CleanSession,
  cleanModeCalls,
  type CleanModeOption,
  getCurrentAreaId,
  getCurrentCleanMode,
  getOperationalStatus,
  getPowerStatus,
  getRoomLayout,
  getRunMode,
  GO_HOME_CALL,
  type HelperEntityIds,
  LOCATE_CALL,
  type OperationalStatus,
  PAUSE_CALL,
  type PowerStatus,
  RESUME_CALL,
  type RoomLayout,
  startCalls,
  STOP_CALL,
  VACUUM_STATES,
  type VacuumSnapshot,
} from "./model.js";

const log = createLogger("vacuum");

const ACTIVE_STATES: string[] = [VACUUM_STATES.cleaning, VACUUM_STATES.paused, VACUUM_STATES.returning];
const FINISHED_STATES: string[] = [VACUUM_STATES.docked, VACUUM_STATES.idle];

export interface ControllerOptions {
  vacuumEntity: string;
  helpers: HelperEntityIds;
  includeUnnamedRooms: boolean;
}

/** Everything the Matter side needs to render the vacuum. */
export interface VacuumView {
  available: boolean;
  snapshot: VacuumSnapshot;
  layout: RoomLayout;
  currentAreaId: number | null;
  operational: OperationalStatus;
  runMode: number;
  cleanModes: CleanModeOption[];
  currentCleanMode: CleanModeOption;
  power: PowerStatus;
  session: CleanSession | null;
}

export interface CompletionInfo {
  totalOperationalTime: number | null;
  pausedTime: number | null;
}

/**
 * Glue between Home Assistant and the Matter behaviours: keeps a current
 * snapshot of the vacuum and its helper entities, exposes derived values and
 * performs actions.
 */
export class VacuumController {
  private readonly changeListeners = new Set<(view: VacuumView) => void>();
  private readonly completionListeners = new Set<(info: CompletionInfo) => void>();
  private snapshot: VacuumSnapshot = {};
  private lastSerialized = "";
  private session: CleanSession | null = null;
  private pausedSince: number | null = null;
  private pausedTotal = 0;
  private unsubscribe?: () => void;

  constructor(
    private readonly ha: HomeAssistantClient,
    readonly options: ControllerOptions,
  ) {}

  get helpers(): HelperEntityIds {
    return this.options.helpers;
  }

  start(): void {
    this.refresh(this.ha.getAllStates());
    this.unsubscribe = this.ha.onStates((states) => this.refresh(states));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  onChange(listener: (view: VacuumView) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onCompletion(listener: (info: CompletionInfo) => void): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  view(): VacuumView {
    const snapshot = this.snapshot;
    const layout = getRoomLayout(snapshot, this.options.includeUnnamedRooms);
    const cleanModes = buildCleanModes(snapshot);
    return {
      available:
        !!snapshot.vacuum && snapshot.vacuum.state !== "unavailable" && snapshot.vacuum.state !== "unknown",
      snapshot,
      layout,
      currentAreaId: getCurrentAreaId(snapshot, layout),
      operational: getOperationalStatus(snapshot),
      runMode: getRunMode(snapshot),
      cleanModes,
      currentCleanMode: getCurrentCleanMode(snapshot, cleanModes),
      power: getPowerStatus(snapshot),
      session: this.session,
    };
  }

  // ------------------------------------------------------------ actions

  /** Start cleaning; `selectedAreaIds` come from the ServiceArea cluster. */
  async startCleaning(selectedAreaIds: number[]): Promise<void> {
    const view = this.view();
    const calls = startCalls(this.snapshot, this.helpers, view.layout, selectedAreaIds);
    const valid = selectedAreaIds.filter((id) => view.layout.areas.some((a) => a.areaId === id));
    this.session = valid.length > 0 ? new CleanSession(valid) : null;
    this.pausedSince = null;
    this.pausedTotal = 0;
    await this.run(calls);
  }

  /** Forget the current room job (a new selection was made). */
  clearSession(): void {
    this.session = null;
    this.pausedSince = null;
    this.pausedTotal = 0;
  }

  async pause(): Promise<void> {
    await this.run([PAUSE_CALL]);
  }

  async resume(selectedAreaIds: number[]): Promise<void> {
    if (this.snapshot.vacuum?.state === VACUUM_STATES.paused) {
      await this.run([RESUME_CALL]);
      return;
    }
    await this.startCleaning(selectedAreaIds);
  }

  async goHome(): Promise<void> {
    await this.run([GO_HOME_CALL]);
  }

  async stopCleaning(): Promise<void> {
    await this.run([STOP_CALL]);
  }

  async locate(): Promise<void> {
    await this.run([LOCATE_CALL]);
  }

  async setCleanMode(mode: CleanModeOption): Promise<void> {
    await this.run(cleanModeCalls(this.snapshot, this.helpers, mode));
  }

  private async run(calls: ServiceCall[]): Promise<void> {
    for (const call of calls) {
      await this.ha.call(call, this.options.vacuumEntity);
    }
  }

  // ------------------------------------------------------- state updates

  private refresh(states: Record<string, HassState>): void {
    const pick = (id?: string) => (id ? states[id] : undefined);
    const next: VacuumSnapshot = {
      vacuum: states[this.options.vacuumEntity],
      cleaningMode: pick(this.helpers.cleaningModeEntity),
      suctionLevel: pick(this.helpers.suctionLevelEntity),
      waterVolume: pick(this.helpers.waterVolumeEntity),
      selectedMap: pick(this.helpers.selectedMapEntity),
      cleanGenius: pick(this.helpers.cleanGeniusEntity),
    };
    const serialized = JSON.stringify([
      next.vacuum?.state,
      next.vacuum?.attributes,
      next.cleaningMode?.state,
      next.cleaningMode?.attributes?.options,
      next.suctionLevel?.state,
      next.suctionLevel?.attributes?.options,
      next.waterVolume?.state,
      next.waterVolume?.attributes?.options,
      next.selectedMap?.state,
      next.cleanGenius?.state,
      next.cleanGenius?.attributes?.options,
    ]);
    if (serialized === this.lastSerialized) {
      return;
    }
    const previousState = this.snapshot.vacuum?.state;
    this.snapshot = next;
    this.lastSerialized = serialized;
    this.trackJob(previousState, next.vacuum?.state);

    const view = this.view();
    log.debug(
      `Vacuum ${next.vacuum?.state ?? "missing"}: op=${view.operational.state} run=${view.runMode} ` +
        `mode=${view.currentCleanMode.label} area=${view.currentAreaId ?? "-"} battery=${view.power.percentRemaining}`,
    );
    for (const listener of this.changeListeners) {
      try {
        listener(view);
      } catch (err) {
        log.error("Change listener failed", err);
      }
    }
  }

  /** Follow the robot through the rooms and notice when a job has ended. */
  private trackJob(previous: string | undefined, current: string | undefined): void {
    if (current === VACUUM_STATES.paused && this.pausedSince === null) {
      this.pausedSince = Date.now();
    } else if (current !== VACUUM_STATES.paused && this.pausedSince !== null) {
      this.pausedTotal += Date.now() - this.pausedSince;
      this.pausedSince = null;
    }

    if (this.session && !this.session.finished && current === VACUUM_STATES.cleaning) {
      this.session.visit(getCurrentAreaId(this.snapshot, getRoomLayout(this.snapshot, this.options.includeUnnamedRooms)));
    }

    const wasActive = previous !== undefined && ACTIVE_STATES.includes(previous);
    const nowFinished = current !== undefined && (FINISHED_STATES.includes(current) || current === VACUUM_STATES.error);
    if (wasActive && nowFinished) {
      const completed = current !== VACUUM_STATES.error;
      const startedAt = this.session?.startedAt ?? null;
      this.session?.finish(completed);
      const info: CompletionInfo = {
        totalOperationalTime: startedAt ? Math.round((Date.now() - startedAt - this.pausedTotal) / 1000) : null,
        pausedTime: startedAt ? Math.round(this.pausedTotal / 1000) : null,
      };
      log.info(`Cleaning job finished (${current}), total ${info.totalOperationalTime ?? "?"}s`);
      for (const listener of this.completionListeners) {
        try {
          listener(info);
        } catch (err) {
          log.error("Completion listener failed", err);
        }
      }
    }
    if (current === VACUUM_STATES.cleaning && !wasActive && (this.session === null || this.session.finished)) {
      // A job started outside of Matter (app, HA automation): no room session.
      this.session = null;
      this.pausedTotal = 0;
    }
  }
}
