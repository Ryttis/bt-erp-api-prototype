export interface VehicleTelemetry {
  request_id: string;
  endpoint: '/vehicles';
  view: string;
  operation: string;
  duration_ms: number;
  outcome: 'success' | 'error' | 'timeout' | 'busy';
  timeout: boolean;
  busy: boolean;
  result_count?: number;
  category_count?: number;
  metric_count?: number;
  page_size?: number;
}

type Logger = { info: (event: VehicleTelemetry, message: string) => void; warn: (event: VehicleTelemetry, message: string) => void };

/** Emits identifiers and counts only; filter values, SQL, records, and DB diagnostics stay out of telemetry. */
export function logVehicleTelemetry(logger: Logger, slowQueryMs: number, event: VehicleTelemetry) {
  if (event.duration_ms >= slowQueryMs) logger.warn(event, 'Slow vehicle database request');
  else logger.info(event, 'Vehicle database request');
}
