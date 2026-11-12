import * as h3 from 'h3-js';

export interface H3CellRecord {
  h3_index: string;
  resolution: number;
  center_lat: number;
  center_lng: number;
  label: string;
  free_flow_kmh: number;
  osm_tram_tracks: number;
  osm_intersection_count: number;
  total_accidents: number;
  wet_accidents: number;
  hist_accident_density: number;
  hist_wet_accident_ratio: number;
  risk_score: number;
  bkk_vehicle_count: number;
  bkk_avg_speed: number;
  bkk_speed_std: number;
  neighbor_speed_ratio: number;
  top_risk_factor: string;
  updated_at: string;
}

export interface WeatherTelemetry {
  temp_c: number;
  precip_mm: number;
  wind_speed_kmh: number;
  fetched_at: string;
  source: string;
}

export const FEATURE_NAMES = [
  'hour_sin',
  'hour_cos',
  'is_weekend',
  'bkk_speed_ratio',
  'bkk_speed_std',
  'neighbor_speed_ratio',
  'bkk_delay_avg',
  'precip_mm',
  'wind_speed_kmh',
  'temp_c',
  'osm_tram_tracks',
  'osm_intersection_count',
  'hist_accident_density',
  'hist_wet_accident_ratio',
] as const;

export const MONOTONE_CONSTRAINTS = [0, 0, 0, -1, 1, -1, 1, 1, 1, 0, 1, 1, 1, 1] as const;

/**
 * Computes the k=1 ring neighbor speed ratio for every cell in the grid using h3.gridDisk(h, 1).
 */
export function computeNeighborSpeedRatios(cells: H3CellRecord[]): Map<string, number> {
  const speedRatioMap = new Map<string, number>();

  for (const c of cells) {
    const freeFlow = Math.max(10, c.free_flow_kmh || 50);
    const ratio = Math.min(1.2, Math.max(0, (c.bkk_avg_speed || 0) / freeFlow));
    speedRatioMap.set(c.h3_index, ratio);
  }

  const neighborMap = new Map<string, number>();
  for (const c of cells) {
    try {
      const disk = h3.gridDisk(c.h3_index, 1);
      const neighborRatios: number[] = [];
      for (const nIdx of disk) {
        if (nIdx !== c.h3_index && speedRatioMap.has(nIdx)) {
          neighborRatios.push(speedRatioMap.get(nIdx)!);
        }
      }
      if (neighborRatios.length > 0) {
        const avg = neighborRatios.reduce((a, b) => a + b, 0) / neighborRatios.length;
        neighborMap.set(c.h3_index, Number(Math.min(1.2, Math.max(0, avg)).toFixed(4)));
      } else {
        neighborMap.set(c.h3_index, Number((speedRatioMap.get(c.h3_index) ?? 0.85).toFixed(4)));
      }
    } catch {
      neighborMap.set(c.h3_index, 0.85);
    }
  }

  return neighborMap;
}

/**
 * Builds the exact 14-feature Float32Array vector for a single H3 cell.
 */
export function buildCellFeatureVector(
  cell: H3CellRecord,
  weather: WeatherTelemetry,
  timestamp: Date = new Date()
): Float32Array {
  const hour = timestamp.getHours() + timestamp.getMinutes() / 60.0;
  const day = timestamp.getDay(); // 0 = Sun, 6 = Sat

  const hour_sin = Math.sin((2 * Math.PI * hour) / 24.0);
  const hour_cos = Math.cos((2 * Math.PI * hour) / 24.0);
  const is_weekend = day === 0 || day === 6 ? 1.0 : 0.0;

  const freeFlow = Math.max(10.0, cell.free_flow_kmh || 50.0);
  const bkk_speed_ratio = Math.min(1.2, Math.max(0.0, (cell.bkk_avg_speed || 42.0) / freeFlow));
  const bkk_speed_std = Math.min(50.0, Math.max(0.0, cell.bkk_speed_std || 3.5));
  const neighbor_speed_ratio = Math.min(
    1.2,
    Math.max(0.0, cell.neighbor_speed_ratio ?? bkk_speed_ratio)
  );
  const bkk_delay_avg = Math.min(
    1800.0,
    Math.max(0.0, (1.0 - Math.min(1.0, bkk_speed_ratio)) * 300.0)
  );

  const precip_mm = Math.min(50.0, Math.max(0.0, weather.precip_mm || 0.0));
  const wind_speed_kmh = Math.min(120.0, Math.max(0.0, weather.wind_speed_kmh || 0.0));
  const temp_c = Math.min(45.0, Math.max(-25.0, weather.temp_c ?? 12.0));

  const osm_tram_tracks = cell.osm_tram_tracks ? 1.0 : 0.0;
  const osm_intersection_count = Math.min(50.0, Math.max(0.0, cell.osm_intersection_count || 4));
  const hist_accident_density = Math.min(1.0, Math.max(0.0, cell.hist_accident_density || 0.05));
  const hist_wet_accident_ratio = Math.min(
    1.0,
    Math.max(0.0, cell.hist_wet_accident_ratio || 0.1)
  );

  return new Float32Array([
    hour_sin,
    hour_cos,
    is_weekend,
    bkk_speed_ratio,
    bkk_speed_std,
    neighbor_speed_ratio,
    bkk_delay_avg,
    precip_mm,
    wind_speed_kmh,
    temp_c,
    osm_tram_tracks,
    osm_intersection_count,
    hist_accident_density,
    hist_wet_accident_ratio,
  ]);
}

/**
 * Builds the flat [N * 14] Float32Array batch matrix for all cells.
 */
export function buildBatchFeatureMatrix(
  cells: H3CellRecord[],
  weather: WeatherTelemetry,
  timestamp: Date = new Date()
): Float32Array {
  const batch = new Float32Array(cells.length * 14);
  for (let i = 0; i < cells.length; i++) {
    const vec = buildCellFeatureVector(cells[i], weather, timestamp);
    batch.set(vec, i * 14);
  }
  return batch;
}

/**
 * Explainability Heuristic (`top_risk_factor`) per specification Section 4.
 */
export function determineTopRiskFactor(
  cell: H3CellRecord,
  weather: WeatherTelemetry
): string {
  const freeFlow = Math.max(10.0, cell.free_flow_kmh || 50.0);
  const bkk_speed_ratio = Math.min(1.2, Math.max(0.0, (cell.bkk_avg_speed || 42.0) / freeFlow));

  if (weather.temp_c <= 2.0 && weather.precip_mm > 0) {
    return 'Jegesedés / ónos eső veszély';
  }
  if (weather.precip_mm > 0.5 && cell.osm_tram_tracks === 1) {
    return 'Csúszós villamossínek és csapadék';
  }
  if (cell.bkk_speed_std >= 11.0) {
    return 'Hirtelen torlódási hullám (Shockwave)';
  }
  if (bkk_speed_ratio < 0.45) {
    return 'Súlyos forgalmi torlódás';
  }
  if (cell.hist_accident_density >= 0.55) {
    return 'Magas historikus baleseti gócpont';
  }
  return 'Normál forgalmi alapzaj';
}

/**
 * Calibrated logistic risk model over the 14 features (respecting monotone constraints)
 * used as fallback or calibrated inference scorer.
 */
export function predictCalibratedRiskFromFeatures(features: Float32Array): number {
  const [
    hour_sin,
    hour_cos,
    is_weekend,
    bkk_speed_ratio,
    bkk_speed_std,
    neighbor_speed_ratio,
    bkk_delay_avg,
    precip_mm,
    wind_speed_kmh,
    temp_c,
    osm_tram_tracks,
    osm_intersection_count,
    hist_accident_density,
    hist_wet_accident_ratio,
  ] = Array.from(features);

  const rushHourBoost = -0.35 * hour_cos + 0.15 * hour_sin - 0.25 * is_weekend;

  const congestionTerm =
    -1.85 * (bkk_speed_ratio - 0.8) +
    0.085 * bkk_speed_std +
    -0.95 * (neighbor_speed_ratio - 0.8) +
    0.0018 * bkk_delay_avg;

  const icingInteraction = temp_c <= 2.0 && precip_mm > 0 ? 0.85 : 0.0;
  const weatherTerm =
    0.14 * precip_mm + 0.012 * wind_speed_kmh + icingInteraction;

  const wetInteraction = precip_mm > 0.2 ? 0.65 * hist_wet_accident_ratio : 0.15 * hist_wet_accident_ratio;
  const infraHistoryTerm =
    0.42 * osm_tram_tracks +
    0.065 * osm_intersection_count +
    2.45 * hist_accident_density +
    wetInteraction;

  const logit = -2.65 + rushHourBoost + congestionTerm + weatherTerm + infraHistoryTerm;
  const prob = 1.0 / (1.0 + Math.exp(-logit));

  return Number(Math.min(0.99, Math.max(0.01, prob)).toFixed(4));
}

