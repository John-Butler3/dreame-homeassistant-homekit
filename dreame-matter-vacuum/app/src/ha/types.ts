/** Minimal Home Assistant data shapes used by the app. */

export interface HassState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface EntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  platform?: string;
  translation_key?: string | null;
  unique_id?: string;
  original_device_class?: string | null;
  device_class?: string | null;
  disabled_by?: string | null;
}

export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  model_id?: string | null;
  serial_number?: string | null;
  sw_version?: string | null;
  hw_version?: string | null;
}

export interface ServiceCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  /** Target entity id (defaults to the vacuum). */
  target?: string;
}
