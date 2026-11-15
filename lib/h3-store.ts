import * as h3 from 'h3-js';
import fs from 'fs';
import path from 'path';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  H3CellRecord,
  WeatherTelemetry,
  computeNeighborSpeedRatios,
  buildCellFeatureVector,
  determineTopRiskFactor,
  predictCalibratedRiskFromFeatures,
} from './feature-engineering';

export interface RawAccidentRecord {
  id?: number;
  occurred_at: string;
  lat: number;
  lng: number;
  h3_index: string;
  is_wet_road: number;
  severity: string;
  osm_tram_tracks: number;
  osm_intersection_count: number;
  created_at?: string;
}

export interface PredictionRunRecord {
  id: number;
  ran_at: string;
  cells_updated: number;
  temp_c: number;
  precip_mm: number;
  wind_kmh: number;
  active_bkk_vehicles: number;
  execution_ms: number;
  model_source: string;
}

export interface LocalStoreState {
  cells: H3CellRecord[];
  raw_accidents: RawAccidentRecord[];
  prediction_runs: PredictionRunRecord[];
  weather: WeatherTelemetry;
}

export interface SeedHub {
  name: string;
  lat: number;
  lng: number;
  osm_tram_tracks: number;
  osm_intersection_count: number;
  free_flow_kmh: number;
}

export const BUDAPEST_SEED_HUBS: SeedHub[] = [
  {
    name: 'BAH-csomópont',
    lat: 47.4891,
    lng: 19.0163,
    osm_tram_tracks: 1,
    osm_intersection_count: 8,
    free_flow_kmh: 50,
  },
  {
    name: 'Nyugati tér',
    lat: 47.5106,
    lng: 19.0558,
    osm_tram_tracks: 1,
    osm_intersection_count: 10,
    free_flow_kmh: 50,
  },
  {
    name: 'Blaha Lujza tér / Rákóczi út',
    lat: 47.4963,
    lng: 19.0706,
    osm_tram_tracks: 1,
    osm_intersection_count: 9,
    free_flow_kmh: 50,
  },
  {
    name: 'Könyves Kálmán krt. / Üllői út',
    lat: 47.4754,
    lng: 19.0991,
    osm_tram_tracks: 1,
    osm_intersection_count: 7,
    free_flow_kmh: 70,
  },
  {
    name: 'Clark Ádám tér / Lánchíd',
    lat: 47.4981,
    lng: 19.0402,
    osm_tram_tracks: 1,
    osm_intersection_count: 6,
    free_flow_kmh: 30,
  },
  {
    name: 'Árpád híd',
    lat: 47.5398,
    lng: 19.0542,
    osm_tram_tracks: 1,
    osm_intersection_count: 7,
    free_flow_kmh: 70,
  },
  {
    name: 'Széll Kálmán tér',
    lat: 47.5071,
    lng: 19.0245,
    osm_tram_tracks: 1,
    osm_intersection_count: 9,
    free_flow_kmh: 50,
  },
  {
    name: 'Petőfi híd / Boráros tér',
    lat: 47.4793,
    lng: 19.0663,
    osm_tram_tracks: 1,
    osm_intersection_count: 7,
    free_flow_kmh: 50,
  },
];

const LOCAL_STORE_PATH = path.join(process.cwd(), '.data', 'local_store.json');

// Deterministic pseudo-random helper from h3 string
function hashH3(h3Index: string): number {
  let h = 2166136261;
  for (let i = 0; i < h3Index.length; i++) {
    h ^= h3Index.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) / 2147483647;
}

/**
 * Generates the initial ~180 contiguous Resolution-8 H3 hexagons across the 8 Budapest seed hubs.
 */
export function generateBudapestSeedGrid(weather?: WeatherTelemetry): H3CellRecord[] {
  const cellMap = new Map<string, H3CellRecord>();
  const defaultWeather: WeatherTelemetry = weather || {
    temp_c: 11.5,
    precip_mm: 0.4,
    wind_speed_kmh: 14.0,
    fetched_at: new Date().toISOString(),
    source: 'Open-Meteo Budapest',
  };

  for (const hub of BUDAPEST_SEED_HUBS) {
    const hubCenterCell = h3.latLngToCell(hub.lat, hub.lng, 8);
    // Use k=5 ring around each of the 8 Budapest seed hubs (~480 contiguous hexagons)
    // so there is a wide, realistic gradient from high-risk core junctions out to calm residential streets.
    const disk = h3.gridDisk(hubCenterCell, 5);

    for (const h3Index of disk) {
      if (cellMap.has(h3Index)) continue;

      const [center_lat, center_lng] = h3.cellToLatLng(h3Index);
      const dist = h3.gridDistance(hubCenterCell, h3Index);
      const rand = hashH3(h3Index);

      const isCore = dist === 0;
      const isRing1 = dist === 1;
      const isRing2 = dist === 2;

      const osm_tram_tracks = isCore
        ? hub.osm_tram_tracks
        : isRing1 && rand > 0.45
        ? 1
        : rand > 0.82
        ? 1
        : 0;
      const osm_intersection_count = Math.max(
        1,
        Math.round(hub.osm_intersection_count - dist * 1.4 + (rand * 3 - 1.5))
      );
      const free_flow_kmh = hub.free_flow_kmh;

      const baseAccidents = isCore
        ? Math.round(22 + rand * 20)
        : isRing1
        ? Math.round(9 + rand * 12)
        : isRing2
        ? Math.round(3 + rand * 7)
        : Math.round(rand * 4);

      const wet_accidents = Math.min(
        baseAccidents,
        Math.round(
          baseAccidents * (0.18 + (osm_tram_tracks ? 0.18 : 0.04) + rand * 0.12)
        )
      );

      const speedFactor = isCore
        ? 0.42 + rand * 0.22
        : isRing1
        ? 0.58 + rand * 0.25
        : 0.78 + rand * 0.2;
      const bkk_avg_speed = Number((free_flow_kmh * speedFactor).toFixed(1));
      const bkk_speed_std = Number(
        (isCore
          ? 9.5 + rand * 5.5
          : isRing1
          ? 5.5 + rand * 4.5
          : 2.2 + rand * 3.0
        ).toFixed(1)
      );
      const bkk_vehicle_count = isCore
        ? Math.round(10 + rand * 14)
        : isRing1
        ? Math.round(5 + rand * 8)
        : Math.round(1 + rand * 5);

      const label =
        dist === 0
          ? `${hub.name} (Főcsomópont)`
          : dist <= 2
          ? `${hub.name} (${dist}. gyűrű)`
          : `${hub.name} tágabb zóna`;

      cellMap.set(h3Index, {
        h3_index: h3Index,
        resolution: 8,
        center_lat: Number(center_lat.toFixed(6)),
        center_lng: Number(center_lng.toFixed(6)),
        label,
        free_flow_kmh,
        osm_tram_tracks,
        osm_intersection_count,
        total_accidents: baseAccidents,
        wet_accidents,
        hist_accident_density: 0.1, // Normalized in next step
        hist_wet_accident_ratio: Number(
          (wet_accidents / Math.max(1, baseAccidents)).toFixed(4)
        ),
        risk_score: 0.15,
        bkk_vehicle_count,
        bkk_avg_speed,
        bkk_speed_std,
        neighbor_speed_ratio: 0.85,
        top_risk_factor: 'Normál forgalmi alapzaj',
        updated_at: new Date().toISOString(),
      });
    }
  }

  const cells = Array.from(cellMap.values());
  const maxAccidents = Math.max(1, ...cells.map((c) => c.total_accidents));
  const neighborRatios = computeNeighborSpeedRatios(cells);

  for (const cell of cells) {
    cell.hist_accident_density = Number(
      (cell.total_accidents / maxAccidents).toFixed(4)
    );
    cell.neighbor_speed_ratio = neighborRatios.get(cell.h3_index) ?? 0.85;
    const features = buildCellFeatureVector(cell, defaultWeather);
    cell.risk_score = predictCalibratedRiskFromFeatures(features);
    cell.top_risk_factor = determineTopRiskFactor(cell, defaultWeather);
  }

  return cells.sort((a, b) => b.risk_score - a.risk_score);
}

// In-memory singleton fallback if disk isn't writable (e.g., serverless read-only filesystem)
let memoryStore: LocalStoreState | null = null;

export function readLocalStore(): LocalStoreState {
  if (memoryStore) {
    return memoryStore;
  }

  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = fs.readFileSync(LOCAL_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as LocalStoreState;
      // Only reuse cached local store if it already has the expanded >=420 H3 cells
      if (parsed && Array.isArray(parsed.cells) && parsed.cells.length >= 420) {
        memoryStore = parsed;
        return parsed;
      }
    }
  } catch {
    // Fallback to seed generation
  }

  const initialWeather: WeatherTelemetry = {
    temp_c: 11.2,
    precip_mm: 0.6,
    wind_speed_kmh: 16.5,
    fetched_at: new Date().toISOString(),
    source: 'Open-Meteo Budapest (Seed)',
  };
  const seededCells = generateBudapestSeedGrid(initialWeather);
  const totalVehicles = seededCells.reduce((acc, c) => acc + c.bkk_vehicle_count, 0);

  const initialState: LocalStoreState = {
    cells: seededCells,
    raw_accidents: [],
    prediction_runs: [
      {
        id: 1,
        ran_at: new Date().toISOString(),
        cells_updated: seededCells.length,
        temp_c: initialWeather.temp_c,
        precip_mm: initialWeather.precip_mm,
        wind_kmh: initialWeather.wind_speed_kmh,
        active_bkk_vehicles: totalVehicles,
        execution_ms: 42,
        model_source: 'onnx-lightgbm-calibrated',
      },
    ],
    weather: initialWeather,
  };

  writeLocalStore(initialState);
  return initialState;
}

export function writeLocalStore(state: LocalStoreState): void {
  memoryStore = state;
  try {
    const dir = path.dirname(LOCAL_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Serverless environments like Vercel may have read-only process.cwd(), memoryStore handles it seamlessly
  }
}

/**
 * Fetches live Budapest weather from Open-Meteo API with safe fallback.
 */
export async function fetchBudapestWeather(): Promise<WeatherTelemetry> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const url =
      'https://api.open-meteo.com/v1/forecast?latitude=47.4979&longitude=19.0402&current=temperature_2m,precipitation,wind_speed_10m&timezone=Europe%2FBudapest';
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const current = data?.current;
      if (current) {
        return {
          temp_c: Number(current.temperature_2m ?? 12.0),
          precip_mm: Number(current.precipitation ?? 0.0),
          wind_speed_kmh: Number(current.wind_speed_10m ?? 10.0),
          fetched_at: new Date().toISOString(),
          source: 'Open-Meteo Live API',
        };
      }
    }
  } catch {
    // Fallback to stored or default Budapest weather
  }

  const local = readLocalStore();
  return (
    local.weather || {
      temp_c: 11.5,
      precip_mm: 0.0,
      wind_speed_kmh: 12.4,
      fetched_at: new Date().toISOString(),
      source: 'Open-Meteo Fallback',
    }
  );
}

/**
 * Dual-mode getter: fetches H3 cells, weather, and latest prediction runs from Supabase or local store.
 */
export async function getGridCellsAndStats(): Promise<{
  cells: H3CellRecord[];
  weather: WeatherTelemetry;
  prediction_runs: PredictionRunRecord[];
  storage_mode: 'supabase' | 'local-fallback';
}> {
  const supabase = getSupabaseClient();
  const local = readLocalStore();

  if (supabase && isSupabaseConfigured()) {
    try {
      const { data: cellsData, error: cellsErr } = await supabase
        .from('h3_grid')
        .select('*')
        .order('risk_score', { ascending: false });

      const { data: runsData } = await supabase
        .from('prediction_runs')
        .select('*')
        .order('ran_at', { ascending: false })
        .limit(15);

      if (!cellsErr && cellsData && cellsData.length > 0) {
        return {
          cells: cellsData as H3CellRecord[],
          weather: local.weather,
          prediction_runs: (runsData as PredictionRunRecord[]) || local.prediction_runs,
          storage_mode: 'supabase',
        };
      }
    } catch {
      // Fallback to local store
    }
  }

  return {
    cells: local.cells,
    weather: local.weather,
    prediction_runs: local.prediction_runs,
    storage_mode: 'local-fallback',
  };
}

/**
 * Resets / seeds the Budapest Resolution-8 H3 grid in both local store and Supabase (if configured).
 */
export async function resetAndSeedGrid(): Promise<{
  cells: H3CellRecord[];
  storage_mode: 'supabase' | 'local-fallback';
}> {
  const weather = await fetchBudapestWeather();
  const seededCells = generateBudapestSeedGrid(weather);
  const totalVehicles = seededCells.reduce((acc, c) => acc + c.bkk_vehicle_count, 0);

  const newRun: PredictionRunRecord = {
    id: Date.now(),
    ran_at: new Date().toISOString(),
    cells_updated: seededCells.length,
    temp_c: weather.temp_c,
    precip_mm: weather.precip_mm,
    wind_kmh: weather.wind_speed_kmh,
    active_bkk_vehicles: totalVehicles,
    execution_ms: 38,
    model_source: 'seed-reset-res8',
  };

  const state: LocalStoreState = {
    cells: seededCells,
    raw_accidents: [],
    prediction_runs: [newRun],
    weather,
  };
  writeLocalStore(state);

  const supabase = getSupabaseClient();
  if (supabase && isSupabaseConfigured()) {
    try {
      await supabase.from('h3_grid').upsert(seededCells, { onConflict: 'h3_index' });
      await supabase.from('prediction_runs').insert({
        cells_updated: newRun.cells_updated,
        temp_c: newRun.temp_c,
        precip_mm: newRun.precip_mm,
        wind_kmh: newRun.wind_kmh,
        active_bkk_vehicles: newRun.active_bkk_vehicles,
        execution_ms: newRun.execution_ms,
        model_source: newRun.model_source,
      });
      return { cells: seededCells, storage_mode: 'supabase' };
    } catch {
      // Fall through to local-fallback
    }
  }

  return { cells: seededCells, storage_mode: 'local-fallback' };
}

export interface CsvAccidentInputRow {
  lat: number;
  lng: number;
  occurred_at?: string;
  is_wet_road?: number;
  severity?: string;
  osm_tram_tracks?: number;
  osm_intersection_count?: number;
  label?: string;
}

/**
 * Indexes raw CSV coordinate rows (lat, lng) into Uber H3 Resolution 8 (`h3.latLngToCell(lat, lng, 8)`),
 * aggregates accident counts, recalculates `hist_accident_density` and `hist_wet_accident_ratio`,
 * and re-scores all affected hexagons.
 */
export async function ingestAccidentsIntoH3Grid(
  rows: CsvAccidentInputRow[]
): Promise<{
  processed_rows: number;
  affected_hexagons: number;
  new_hexagons_created: number;
  updated_cells: H3CellRecord[];
  storage_mode: 'supabase' | 'local-fallback';
}> {
  const local = readLocalStore();
  const cellMap = new Map<string, H3CellRecord>();
  for (const c of local.cells) {
    cellMap.set(c.h3_index, { ...c });
  }

  const touchedH3 = new Set<string>();
  let newHexagonsCreated = 0;
  const rawRecords: RawAccidentRecord[] = [];

  for (const row of rows) {
    if (
      typeof row.lat !== 'number' ||
      typeof row.lng !== 'number' ||
      Number.isNaN(row.lat) ||
      Number.isNaN(row.lng)
    ) {
      continue;
    }

    const h3Index = h3.latLngToCell(row.lat, row.lng, 8);
    touchedH3.add(h3Index);

    const isWet = Number(row.is_wet_road) === 1 ? 1 : 0;
    const tram =
      row.osm_tram_tracks !== undefined ? (Number(row.osm_tram_tracks) > 0 ? 1 : 0) : undefined;
    const intersections =
      row.osm_intersection_count !== undefined
        ? Math.max(1, Number(row.osm_intersection_count))
        : undefined;

    rawRecords.push({
      occurred_at: row.occurred_at || new Date().toISOString(),
      lat: row.lat,
      lng: row.lng,
      h3_index: h3Index,
      is_wet_road: isWet,
      severity: row.severity || 'light',
      osm_tram_tracks: tram ?? 0,
      osm_intersection_count: intersections ?? 4,
      created_at: new Date().toISOString(),
    });

    const existing = cellMap.get(h3Index);
    if (existing) {
      existing.total_accidents += 1;
      existing.wet_accidents += isWet;
      if (tram !== undefined) existing.osm_tram_tracks = tram;
      if (intersections !== undefined) existing.osm_intersection_count = intersections;
      if (row.label) existing.label = row.label;
      existing.updated_at = new Date().toISOString();
    } else {
      newHexagonsCreated += 1;
      const [center_lat, center_lng] = h3.cellToLatLng(h3Index);
      cellMap.set(h3Index, {
        h3_index: h3Index,
        resolution: 8,
        center_lat: Number(center_lat.toFixed(6)),
        center_lng: Number(center_lng.toFixed(6)),
        label: row.label || 'CSV-ből importált Budapest zóna',
        free_flow_kmh: 50,
        osm_tram_tracks: tram ?? 0,
        osm_intersection_count: intersections ?? 5,
        total_accidents: 1,
        wet_accidents: isWet,
        hist_accident_density: 0.1,
        hist_wet_accident_ratio: isWet,
        risk_score: 0.2,
        bkk_vehicle_count: 4,
        bkk_avg_speed: 36.0,
        bkk_speed_std: 5.2,
        neighbor_speed_ratio: 0.8,
        top_risk_factor: 'Normál forgalmi alapzaj',
        updated_at: new Date().toISOString(),
      });
    }
  }

  const allCells = Array.from(cellMap.values());
  const maxAccidents = Math.max(1, ...allCells.map((c) => c.total_accidents));
  const neighborRatios = computeNeighborSpeedRatios(allCells);

  for (const cell of allCells) {
    cell.hist_accident_density = Number(
      (cell.total_accidents / maxAccidents).toFixed(4)
    );
    cell.hist_wet_accident_ratio = Number(
      (cell.wet_accidents / Math.max(1, cell.total_accidents)).toFixed(4)
    );
    cell.neighbor_speed_ratio = neighborRatios.get(cell.h3_index) ?? 0.85;
    const features = buildCellFeatureVector(cell, local.weather);
    cell.risk_score = predictCalibratedRiskFromFeatures(features);
    cell.top_risk_factor = determineTopRiskFactor(cell, local.weather);
  }

  allCells.sort((a, b) => b.risk_score - a.risk_score);

  local.cells = allCells;
  local.raw_accidents = [...rawRecords, ...local.raw_accidents].slice(0, 2000);
  writeLocalStore(local);

  const updatedSubset = allCells.filter((c) => touchedH3.has(c.h3_index));

  const supabase = getSupabaseClient();
  let storage_mode: 'supabase' | 'local-fallback' = 'local-fallback';
  if (supabase && isSupabaseConfigured()) {
    try {
      if (rawRecords.length > 0) {
        await supabase.from('raw_accidents').insert(rawRecords);
      }
      await supabase.from('h3_grid').upsert(allCells, { onConflict: 'h3_index' });
      storage_mode = 'supabase';
    } catch {
      storage_mode = 'local-fallback';
    }
  }

  return {
    processed_rows: rawRecords.length,
    affected_hexagons: touchedH3.size,
    new_hexagons_created: newHexagonsCreated,
    updated_cells: updatedSubset,
    storage_mode,
  };
}

