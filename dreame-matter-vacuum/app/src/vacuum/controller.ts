import { readFileSync, writeFileSync } from "node:fs";
import { ServiceArea } from "@matter/main/clusters";
import type { HomeAssistantClient } from "../ha/client.js";
import type { HassState, ServiceCall } from "../ha/types.js";
import { createLogger } from "../logger.js";
import {
  buildCleanModes,
  CleanSession,
  DEFAULT_PACE,
  learnPace,
  type PaceStats,
  roomsOfExternalJob,
  roomsOnSelectedMap,
  epochSeconds,
  findDefaultMode,
  cleanModeCalls,
  type CleanModeOption,
  getCleaningProgress,
  getCurrentAreaId,
  getCurrentCleanMode,
  getOperationalStatus,
  getPhase,
  type Phase,
  getPowerStatus,
  getRemainingSeconds,
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
  /** Report mop washing / drying and auto emptying as operational states (default true). */
  stationStates?: boolean;
  /** JSON file remembering the cleaning pace between runs. */
  paceFile?: string;
  /** Mode to return to after a job: vacuum | mop | vacuum_and_mop | deep_clean | cleangenius | none. */
  defaultCleanMode?: string;
  /** Suction level to return to after a job (quiet | standard | strong | turbo | keep). */
  defaultSuctionLevel?: string;
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
  /** What the robot or its base is doing (washing, drying, emptying, ...). */
  phase: Phase;
  /** Percent of the running job done (Dreame cleaning progress sensor, else by room estimates). */
  progressPercent: number | null;
  /** Estimated seconds left in the running job. */
  remainingSeconds: number | null;
  /** Estimated end of the job in Unix seconds, null without a running job. */
  estimatedEndTime: number | null;
  /** Room progress of the current / last job with time estimates, null when nothing is known. */
  progress: ServiceArea.Progress[] | null;
}

/** How often time estimates are refreshed while a job runs. */
const TICK_MS = 20_000;

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
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pace: PaceStats;

  constructor(
    private readonly ha: HomeAssistantClient,
    readonly options: ControllerOptions,
  ) {
    this.pace = this.loadPace();
  }

  private loadPace(): PaceStats {
    if (!this.options.paceFile) return DEFAULT_PACE;
    try {
      const parsed = JSON.parse(readFileSync(this.options.paceFile, "utf8")) as Partial<PaceStats>;
      if (typeof parsed.secondsPerRoom === "number" && parsed.secondsPerRoom >= 60 && typeof parsed.jobs === "number") {
        log.info(`Learned pace: ${Math.round(parsed.secondsPerRoom / 60)} min per room over ${parsed.jobs} jobs`);
        return { secondsPerRoom: parsed.secondsPerRoom, jobs: parsed.jobs };
      }
    } catch {
      // first run, or unreadable file: start from the default pace
    }
    return DEFAULT_PACE;
  }

  private savePace(): void {
    if (!this.options.paceFile) return;
    try {
      writeFileSync(this.options.paceFile, JSON.stringify(this.pace));
    } catch (err) {
      log.warn(`Could not save the cleaning pace: ${String(err)}`);
    }
  }

  get helpers(): HelperEntityIds {
    return this.options.helpers;
  }

  start(): void {
    this.refresh(this.ha.getAllStates());
    this.unsubscribe = this.ha.onStates((states) => this.refresh(states));
    const state = this.snapshot.vacuum?.state;
    if (state === VACUUM_STATES.docked || state === VACUUM_STATES.idle) {
      void this.applyDefaultMode("startup");
    }
  }

  /** Put the robot into the configured default mode (if any). */
  async applyDefaultMode(reason: string): Promise<void> {
    const view = this.view();
    const target = findDefaultMode(view.cleanModes, this.options.defaultCleanMode, this.options.defaultSuctionLevel);
    if (!target || target.mode === view.currentCleanMode.mode) return;
    log.info(`Applying default clean mode "${target.label}" (${reason})`);
    try {
      await this.setCleanMode(target);
    } catch (err) {
      log.warn(`Could not apply the default clean mode: ${String(err)}`);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Keep time estimates moving while a job runs, even without state changes. */
  private syncTicker(): void {
    const active = this.jobActive();
    if (active && !this.ticker) {
      this.ticker = setInterval(() => this.notify(), TICK_MS);
    } else if (!active && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private jobActive(): boolean {
    const state = this.snapshot.vacuum?.state;
    return (
      (state === VACUUM_STATES.cleaning || state === VACUUM_STATES.paused) &&
      this.session !== null &&
      !this.session.finished
    );
  }

  /** The session clock: now, minus the pause in progress. */
  private clock(now = Date.now()): number {
    return this.pausedSince === null ? now : this.pausedSince;
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
      currentAreaId: this.currentAreaId(snapshot, layout),
      operational: getOperationalStatus(snapshot, { stationStates: this.options.stationStates }),
      runMode: getRunMode(snapshot),
      cleanModes,
      currentCleanMode: getCurrentCleanMode(snapshot, cleanModes),
      power: getPowerStatus(snapshot),
      session: this.session,
      phase: getPhase(snapshot),
      ...this.estimates(snapshot),
    };
  }

  /** Progress and time estimates: Dreame sensors first, room estimates otherwise. */
  private estimates(snapshot: VacuumSnapshot): Pick<VacuumView, "progressPercent" | "remainingSeconds" | "estimatedEndTime" | "progress"> {
    const now = Date.now();
    const clock = this.clock(now);
    const active = this.jobActive();
    const session = this.session;
    const progressPercent = getCleaningProgress(snapshot) ?? (active && session ? session.percentDone(clock) : null);
    const remainingSeconds = getRemainingSeconds(snapshot) ?? (active && session ? session.remainingSeconds(clock) : null);
    return {
      progressPercent,
      remainingSeconds,
      estimatedEndTime: active && remainingSeconds !== null ? epochSeconds(now + remainingSeconds * 1000) : null,
      progress: session ? session.progress(clock) : null,
    };
  }

  /**
   * Room to report as current: during a room job the session's room (which
   * falls back to the next pending room while the robot reports none, see
   * CleanSession.visit), otherwise whatever the robot reports.
   */
  private currentAreaId(snapshot: VacuumSnapshot, layout: RoomLayout): number | null {
    const reported = getCurrentAreaId(snapshot, layout);
    const state = snapshot.vacuum?.state;
    const active = state === VACUUM_STATES.cleaning || state === VACUUM_STATES.paused;
    if (active && this.session && !this.session.finished) {
      return this.session.currentArea() ?? reported;
    }
    return reported;
  }

  // ------------------------------------------------------------ actions

  /** Start cleaning; `selectedAreaIds` come from the ServiceArea cluster. */
  async startCleaning(selectedAreaIds: number[]): Promise<void> {
    const view = this.view();
    const calls = startCalls(this.snapshot, this.helpers, view.layout, selectedAreaIds);
    const valid = selectedAreaIds.filter((id) => view.layout.areas.some((a) => a.areaId === id));
    const rooms = valid.length > 0 ? valid : roomsOnSelectedMap(this.snapshot, view.layout);
    this.session = new CleanSession(rooms, Date.now(), this.pace.secondsPerRoom);
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
    for (const [index, call] of calls.entries()) {
      if (index > 0 && call.target) {
        // After switching CleanGenius off the Dreame selects need a moment
        // to become available again.
        await this.waitForAvailable(call.target, 6000);
      }
      await this.ha.call(call, this.options.vacuumEntity);
    }
  }

  private async waitForAvailable(entityId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.ha.getState(entityId)?.state;
      if (state && state !== "unavailable" && state !== "unknown") return;
      await new Promise((r) => setTimeout(r, 250));
    }
    log.warn(`${entityId} is still unavailable, sending the command anyway`);
  }

  // ------------------------------------------------------- state updates

  /** Real option lists seen on the Dreame selects, kept while they are locked. */
  private readonly knownOptions = new Map<string, string[]>();

  private refresh(states: Record<string, HassState>): void {
    const pick = (id?: string): HassState | undefined => {
      if (!id) return undefined;
      const state = states[id];
      if (!state) return undefined;
      const options = state.attributes?.options;
      const real = Array.isArray(options)
        ? options.map(String).filter((o) => !["unavailable", "unknown", ""].includes(o.toLowerCase()))
        : [];
      if (real.length > 0) {
        this.knownOptions.set(id, real);
        return state;
      }
      const known = this.knownOptions.get(id);
      if (known) {
        return { ...state, attributes: { ...state.attributes, options: known } };
      }
      return state;
    };
    const next: VacuumSnapshot = {
      vacuum: states[this.options.vacuumEntity],
      cleaningMode: pick(this.helpers.cleaningModeEntity),
      suctionLevel: pick(this.helpers.suctionLevelEntity),
      waterVolume: pick(this.helpers.waterVolumeEntity),
      selectedMap: pick(this.helpers.selectedMapEntity),
      cleanGenius: pick(this.helpers.cleanGeniusEntity),
      stateSensor: pick(this.helpers.stateSensorEntity),
      cleaningProgress: pick(this.helpers.cleaningProgressEntity),
      cleaningTime: pick(this.helpers.cleaningTimeEntity),
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
      next.stateSensor?.state,
      next.cleaningProgress?.state,
      next.cleaningTime?.state,
    ]);
    if (serialized === this.lastSerialized) {
      return;
    }
    const previousState = this.snapshot.vacuum?.state;
    this.snapshot = next;
    this.lastSerialized = serialized;
    this.trackJob(previousState, next.vacuum?.state);
    this.syncTicker();
    this.notify();
  }

  private notify(): void {
    const view = this.view();
    log.debug(
      `Vacuum ${view.snapshot.vacuum?.state ?? "missing"}: op=${view.operational.state} run=${view.runMode} ` +
        `mode=${view.currentCleanMode.label} area=${view.currentAreaId ?? "-"} ` +
        `progress=${view.progressPercent ?? "-"}% battery=${view.power.percentRemaining}`,
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
    const now = Date.now();
    if (current === VACUUM_STATES.paused && this.pausedSince === null) {
      this.pausedSince = now;
    } else if (current !== VACUUM_STATES.paused && this.pausedSince !== null) {
      const paused = now - this.pausedSince;
      this.pausedTotal += paused;
      this.session?.addPause(paused);
      this.pausedSince = null;
    }

    const wasActive = previous !== undefined && ACTIVE_STATES.includes(previous);
    if (current === VACUUM_STATES.cleaning && !wasActive && (this.session === null || this.session.finished)) {
      // A job started outside of Matter (app, HA automation, or a restart mid-job):
      // follow the rooms Dreame says it is doing, or the whole map.
      const layout = getRoomLayout(this.snapshot, this.options.includeUnnamedRooms);
      this.session = new CleanSession(roomsOfExternalJob(this.snapshot, layout), now, this.pace.secondsPerRoom);
      this.pausedTotal = 0;
    }

    if (this.session && !this.session.finished && current === VACUUM_STATES.cleaning) {
      this.session.visit(getCurrentAreaId(this.snapshot, getRoomLayout(this.snapshot, this.options.includeUnnamedRooms)));
    }

    const nowFinished = current !== undefined && (FINISHED_STATES.includes(current) || current === VACUUM_STATES.error);
    if (wasActive && nowFinished) {
      const completed = current !== VACUUM_STATES.error;
      const session = this.session && !this.session.finished ? this.session : null;
      const startedAt = session?.startedAt ?? null;
      session?.finish(completed, now);
      const info: CompletionInfo = {
        totalOperationalTime: startedAt ? Math.round((now - startedAt - this.pausedTotal) / 1000) : null,
        pausedTime: startedAt ? Math.round(this.pausedTotal / 1000) : null,
      };
      log.info(`Cleaning job finished (${current}), total ${info.totalOperationalTime ?? "?"}s`);
      if (completed && session && info.totalOperationalTime !== null) {
        const learned = learnPace(this.pace, info.totalOperationalTime, session.completedCount());
        if (learned !== this.pace) {
          this.pace = learned;
          this.savePace();
          log.info(`Cleaning pace now ${Math.round(this.pace.secondsPerRoom / 60)} min per room (${this.pace.jobs} jobs)`);
        }
      }
      for (const listener of this.completionListeners) {
        try {
          listener(info);
        } catch (err) {
          log.error("Completion listener failed", err);
        }
      }
      if (completed) {
        // Give the Dreame selects a moment to become available again.
        setTimeout(() => void this.applyDefaultMode("job finished"), 5000);
      }
    }
  }
}
