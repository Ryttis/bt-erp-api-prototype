import dotenv from 'dotenv';

// Local defaults only: deployment environment variables retain precedence.
dotenv.config({ override: false, quiet: true });

export interface ReplicaConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  connectionLimit: number;
}

export interface AppConfig {
  port: number;
  auth: {
    serviceToken: string;
  };
  replica: ReplicaConfig;
  safety: {
    queryTimeoutMs: number;
    analyticsConcurrency: number;
    analyticsQueueLimit: number;
    analyticsQueueTimeoutMs: number;
    slowQueryMs: number;
    maxRequestUrlLength: number;
  };
  fixedCosts: {
    /** Temporary MP-8 Slice 6P pilot: enables only the locked truck summary. */
    truckSummaryPilotEnabled: boolean;
    /** Temporary MP-8 pilot: enables only the single-trailer summary and breakdown. */
    trailerPilotEnabled?: boolean;
  };
}

export class ConfigurationError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new ConfigurationError(`Missing required configuration: ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, max: number): number => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
      throw new ConfigurationError(`${name} must be an integer between 1 and ${max}`);
    }
    return Number(value);
  };
  const boolean = (name: string): boolean => {
    const value = env[name] ?? 'false';
    if (value !== 'true' && value !== 'false') throw new ConfigurationError(`${name} must be true or false`);
    return value === 'true';
  };
  const ssl = boolean('ERP_REPLICA_SSL');
  const serviceToken = required('ERP_ANALYTICS_API_TOKEN');
  if (serviceToken.length < 32) {
    throw new ConfigurationError('ERP_ANALYTICS_API_TOKEN must be at least 32 characters');
  }
  return {
    port: integer('PORT', 3000, 65535),
    auth: { serviceToken },
    replica: {
      host: required('ERP_REPLICA_HOST'),
      port: integer('ERP_REPLICA_PORT', 3306, 65535),
      database: required('ERP_REPLICA_DATABASE'),
      user: required('ERP_REPLICA_USER'),
      password: required('ERP_REPLICA_PASSWORD'),
      ssl,
      connectionLimit: integer('ERP_REPLICA_CONNECTION_LIMIT', 4, 100),
    },
    safety: {
      queryTimeoutMs: integer('ERP_REPLICA_QUERY_TIMEOUT_MS', 30000, 120000),
      analyticsConcurrency: integer('ERP_ANALYTICS_CONCURRENCY', 3, 16),
      analyticsQueueLimit: integer('ERP_ANALYTICS_QUEUE_LIMIT', 6, 100),
      analyticsQueueTimeoutMs: integer('ERP_ANALYTICS_QUEUE_TIMEOUT_MS', 1000, 30000),
      slowQueryMs: integer('ERP_SLOW_QUERY_MS', 1000, 120000),
      maxRequestUrlLength: integer('MAX_REQUEST_URL_LENGTH', 4096, 16384),
    },
    fixedCosts: {
      // Fail closed: absent means disabled, and anything but exact true/false is rejected.
      truckSummaryPilotEnabled: boolean('ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED'),
      trailerPilotEnabled: boolean('ERP_FIXED_COST_TRAILER_PILOT_ENABLED'),
    },
  };
}
