import {
  type Connection,
  callService,
  createConnection,
  createLongLivedTokenAuth,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  getStates,
  subscribeEntities,
} from "home-assistant-js-websocket";
import WebSocket from "ws";
import { createLogger } from "../logger.js";
import type { DeviceRegistryEntry, EntityRegistryEntry, HassState, ServiceCall } from "./types.js";

const log = createLogger("ha");

type Listener = (states: Record<string, HassState>) => void;

/**
 * Thin wrapper around home-assistant-js-websocket for Node.js.
 * Keeps an always-current map of entity states and reconnects automatically.
 */
export class HomeAssistantClient {
  private connection?: Connection;
  private states: Record<string, HassState> = {};
  private readonly listeners = new Set<Listener>();
  private unsubscribe?: () => void;
  private ready = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  async connect(): Promise<void> {
    if (typeof globalThis.WebSocket === "undefined") {
      // Node < 22 or disabled experimental global: fall back to `ws`.
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
    }
    const auth = createLongLivedTokenAuth(this.url, this.token);
    for (let attempt = 1; ; attempt++) {
      try {
        this.connection = await createConnection({ auth });
        break;
      } catch (err) {
        const reason =
          err === ERR_INVALID_AUTH
            ? "invalid token"
            : err === ERR_CANNOT_CONNECT
              ? "cannot connect"
              : String(err);
        const delay = Math.min(30, attempt * 5);
        log.warn(`Home Assistant connection failed (${reason}), retrying in ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
    const connection = this.connection!;
    connection.addEventListener("disconnected", () => {
      log.warn("Disconnected from Home Assistant, waiting for reconnect");
      this.ready = false;
    });
    connection.addEventListener("ready", () => {
      log.info("Connected to Home Assistant");
      this.ready = true;
    });

    const initial = await getStates(connection);
    this.states = Object.fromEntries(initial.map((s) => [s.entity_id, s as HassState]));
    this.unsubscribe = subscribeEntities(connection, (entities) => {
      const next: Record<string, HassState> = {};
      for (const [entityId, entity] of Object.entries(entities)) {
        next[entityId] = {
          entity_id: entityId,
          state: entity.state,
          attributes: entity.attributes as Record<string, unknown>,
          last_changed: entity.last_changed,
          last_updated: entity.last_updated,
        };
      }
      this.states = next;
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch (err) {
          log.error("State listener failed", err);
        }
      }
    });
    this.ready = true;
    log.info(`Connected to Home Assistant at ${this.url} (${initial.length} entities)`);
  }

  onStates(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(entityId: string): HassState | undefined {
    return this.states[entityId];
  }

  getAllStates(): Record<string, HassState> {
    return this.states;
  }

  async getEntityRegistry(): Promise<EntityRegistryEntry[]> {
    return this.send<EntityRegistryEntry[]>({ type: "config/entity_registry/list" });
  }

  async getDeviceRegistry(): Promise<DeviceRegistryEntry[]> {
    return this.send<DeviceRegistryEntry[]>({ type: "config/device_registry/list" });
  }

  async hasService(domain: string, service: string): Promise<boolean> {
    const services = await this.send<Record<string, Record<string, unknown>>>({ type: "get_services" });
    return Boolean(services[domain]?.[service]);
  }

  async call(call: ServiceCall, defaultTarget: string): Promise<void> {
    const connection = this.requireConnection();
    const target = call.target ?? defaultTarget;
    log.info(`Calling ${call.domain}.${call.service} on ${target} ${JSON.stringify(call.data ?? {})}`);
    await callService(connection, call.domain, call.service, call.data, { entity_id: target });
  }

  private async send<T>(message: { type: string } & Record<string, unknown>): Promise<T> {
    return this.requireConnection().sendMessagePromise<T>(message);
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error("Not connected to Home Assistant");
    }
    return this.connection;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.connection?.close();
  }
}
