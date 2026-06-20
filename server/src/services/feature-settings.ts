import { getSetting, setSetting } from '../db/index.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FeatureSettingDef {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'number';
  default: boolean | number;
  min?: number;
  max?: number;
  envVar?: string;
  effect: 'live' | 'restart';
  group: string;
  /** For number settings paired with a boolean toggle: the toggle's key. */
  parentToggle?: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

export const REGISTRY: FeatureSettingDef[] = [
  // ── Resilience ──
  {
    key: 'provider_fastfail_enabled',
    label: 'Provider-Outage Fast-Fail',
    description:
      'When ≥N distinct models on the same provider return 5xx within one request, skip all remaining models from that provider.',
    type: 'boolean',
    default: true,
    envVar: 'PROVIDER_FASTFAIL_ENABLED',
    effect: 'restart',
    group: 'Resilience',
  },
  {
    key: 'provider_fastfail_threshold',
    label: 'Fast-Fail Threshold',
    description:
      'Number of distinct models on one provider that must 5xx before the provider is skipped. Set to 0 to disable.',
    type: 'number',
    default: 2,
    min: 0,
    max: 10,
    envVar: 'PROVIDER_FASTFAIL_THRESHOLD',
    effect: 'restart',
    group: 'Resilience',
    parentToggle: 'provider_fastfail_enabled',
  },
  {
    key: 'heartbeat_enabled',
    label: 'Provider Health Heartbeat',
    description:
      'Send periodic health-check pings to each provider. Feeds the degradation engine so the router avoids sick providers proactively.',
    type: 'boolean',
    default: false,
    envVar: 'HEARTBEAT_ENABLED',
    effect: 'restart',
    group: 'Resilience',
  },
  {
    key: 'heartbeat_interval_min',
    label: 'Heartbeat Interval',
    description: 'Minutes between health-check ping cycles.',
    type: 'number',
    default: 10,
    min: 1,
    max: 60,
    envVar: 'HEARTBEAT_INTERVAL_MIN',
    effect: 'restart',
    group: 'Resilience',
    parentToggle: 'heartbeat_enabled',
  },
  {
    key: 'heartbeat_activity_window_min',
    label: 'Activity Window',
    description:
      'Maximum minutes since the last user request for heartbeat pings to fire. Prevents pinging when nobody is using the system.',
    type: 'number',
    default: 15,
    min: 5,
    max: 60,
    envVar: 'HEARTBEAT_ACTIVITY_WINDOW_MIN',
    effect: 'restart',
    group: 'Resilience',
    parentToggle: 'heartbeat_enabled',
  },
  // ── Sessions ──
  {
    key: 'sticky_session_enabled',
    label: 'Sticky Sessions',
    description:
      'Route all requests in a conversation to the same model to prevent mid-conversation model switches and hallucination.',
    type: 'boolean',
    default: false,
    envVar: 'STICKY_SESSION_ENABLED',
    effect: 'live',
    group: 'Sessions',
  },
];

// ── Resolution ─────────────────────────────────────────────────────────────

function resolveSetting(def: FeatureSettingDef): boolean | number {
  // Priority: DB → env var → default
  const dbValue = getSetting(def.key);
  if (dbValue !== undefined) {
    return def.type === 'boolean' ? dbValue === 'true' : parseFloat(dbValue);
  }

  if (def.envVar && process.env[def.envVar] !== undefined) {
    const raw = process.env[def.envVar]!;
    return def.type === 'boolean' ? raw === 'true' : parseFloat(raw);
  }

  return def.default;
}

// ── Running-value snapshot (for restart detection) ─────────────────────────

const runningValues = new Map<string, boolean | number>();

/** Snapshot all resolved values at startup. Called once from index.ts. */
export function captureRunningValues(): void {
  for (const def of REGISTRY) {
    runningValues.set(def.key, resolveSetting(def));
  }
}

/** True when any restart-effect setting's saved value differs from its running value. */
export function hasPendingRestart(): boolean {
  for (const def of REGISTRY) {
    if (def.effect === 'restart') {
      const running = runningValues.get(def.key);
      const saved = resolveSetting(def);
      if (running !== saved) return true;
    }
  }
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Resolve current value for a setting key (DB → env → default). */
export function getFeatureSetting(key: string): boolean | number {
  const def = REGISTRY.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown feature setting: ${key}`);
  return resolveSetting(def);
}

/** Get all settings with full metadata for the API response. */
export function getAllFeatureSettings(): Array<FeatureSettingDef & { value: boolean | number }> {
  return REGISTRY.map((def) => ({ ...def, value: resolveSetting(def) }));
}

/** Validate and write a partial update of settings to the DB. */
export function saveFeatureSettings(updates: Record<string, boolean | number>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const def = REGISTRY.find((d) => d.key === key);
    if (!def) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    if (def.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${key}: expected boolean, got ${typeof value}`);
    }
    if (def.type === 'number') {
      if (typeof value !== 'number' || isNaN(value)) {
        errors.push(`${key}: expected number`);
      } else if (def.min !== undefined && value < def.min) {
        errors.push(`${key}: must be ≥ ${def.min}`);
      } else if (def.max !== undefined && value > def.max) {
        errors.push(`${key}: must be ≤ ${def.max}`);
      }
    }
  }
  if (errors.length > 0) return errors;

  for (const [key, value] of Object.entries(updates)) {
    setSetting(key, String(value));
  }
  return [];
}
