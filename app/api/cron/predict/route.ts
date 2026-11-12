import { NextResponse } from 'next/server';
import * as h3 from 'h3-js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import {
  readLocalStore,
  writeLocalStore,
  fetchBudapestWeather,
  PredictionRunRecord,
} from '@/lib/h3-store';
import {
  H3CellRecord,
  computeNeighborSpeedRatios,
  determineTopRiskFactor,
} from '@/lib/feature-engineering';
import { runRiskInferenceBatch } from '@/lib/onnx-inference';
import { getSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BkkCellTelemetry {
  speedsKmh: number[];
  vehicleCount: number;
}

/**
 * Fetches and decodes live BKK FUTÁR GTFS-RT `VehiclePositions.pb` protobuf feed
 * when `BKK_API_KEY` is configured, mapping vehicle coordinates to Uber H3 Resolution-8 cells.
 */
async function fetchLiveBkkGtfsRtTelemetry(): Promise<{
  cellTelemetry: Map<string, BkkCellTelemetry>;
  liveFeedUsed: boolean;
}> {
  const bkkApiKey = process.env.BKK_API_KEY || process.env.NEXT_PUBLIC_BKK_API_KEY;
  const cellTelemetry = new Map<string, BkkCellTelemetry>();

  if (!bkkApiKey) {
    return { cellTelemetry, liveFeedUsed: false };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key=${encodeURIComponent(
      bkkApiKey
    )}`;

    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { cellTelemetry, liveFeedUsed: false };
    }

    const arrayBuffer = await res.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(arrayBuffer)
    );

    for (const entity of feed.entity) {
      const pos = entity.vehicle?.position;
      if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') {
        continue;
      }

      const h3Index = h3.latLngToCell(pos.latitude, pos.longitude, 8);
      // GTFS-RT position.speed is in m/s; convert to km/h
      const rawSpeedMs = typeof pos.speed === 'number' && pos.speed >= 0 ? pos.speed : 8.5;
      const speedKmh = Math.min(110.0, Math.max(0.0, rawSpeedMs * 3.6));

      const existing = cellTelemetry.get(h3Index);
      if (existing) {
        existing.speedsKmh.push(speedKmh);
        existing.vehicleCount += 1;
      } else {
        cellTelemetry.set(h3Index, {
          speedsKmh: [speedKmh],
          vehicleCount: 1,
        });
      }
    }

    return {
      cellTelemetry,
      liveFeedUsed: cellTelemetry.size > 0,
    };
  } catch {
    return { cellTelemetry, liveFeedUsed: false };
  }
}

function computeMeanAndStd(values: number[], fallbackMean: number, fallbackStd: number): {
  mean: number;
  std: number;
} {
  if (values.length === 0) {
    return { mean: fallbackMean, std: fallbackStd };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) {
    return { mean: Number(mean.toFixed(1)), std: fallbackStd };
  }
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return {
    mean: Number(mean.toFixed(1)),
    std: Number(Math.min(50.0, Math.max(1.5, Math.sqrt(variance))).toFixed(1)),
  };
}

async function executePredictionCycle() {
  const startTime = Date.now();
  const weather = await fetchBudapestWeather();
  const local = readLocalStore();
  const supabase = getSupabaseClient();
  const now = new Date();

  // Pull current grid from Supabase if configured, else use local store
  let cells: H3CellRecord[] = local.cells;
  if (supabase && isSupabaseConfigured()) {
    try {
      const { data } = await supabase.from('h3_grid').select('*');
      if (data && data.length > 0) {
        cells = data as H3CellRecord[];
      }
    } catch {
      cells = local.cells;
    }
  }

  // 1. Decode BKK GTFS-RT VehiclePositions.pb or fall back to realistic spatio-temporal telemetry
  const { cellTelemetry, liveFeedUsed } = await fetchLiveBkkGtfsRtTelemetry();

  const hour = now.getHours();
  const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18);
  const rainSlowdown = weather.precip_mm > 0.5 ? 0.85 : 1.0;

  for (const cell of cells) {
    const liveCell = cellTelemetry.get(cell.h3_index);
    if (liveCell && liveCell.vehicleCount > 0) {
      const { mean, std } = computeMeanAndStd(
        liveCell.speedsKmh,
        cell.bkk_avg_speed,
        cell.bkk_speed_std
      );
      cell.bkk_avg_speed = mean;
      cell.bkk_speed_std = std;
      cell.bkk_vehicle_count = liveCell.vehicleCount;
    } else {
      const jitter = (Math.sin(startTime + cell.center_lat * 1000) + 1) * 0.5;
      const congestionFactor = isRushHour ? 0.68 : 0.88;
      const targetSpeed =
        cell.free_flow_kmh * congestionFactor * rainSlowdown * (0.85 + jitter * 0.25);

      cell.bkk_avg_speed = Number(
        Math.max(8.0, Math.min(cell.free_flow_kmh * 1.1, targetSpeed)).toFixed(1)
      );
      cell.bkk_speed_std = Number(
        Math.max(
          2.0,
          Math.min(
            25.0,
            (isRushHour ? 8.5 : 4.5) +
              (weather.precip_mm > 0 ? 3.2 : 0) +
              (jitter * 5.0 - 2.0)
          )
        ).toFixed(1)
      );
      cell.bkk_vehicle_count = Math.max(
        1,
        Math.round(
          (cell.osm_tram_tracks ? 8 : 4) *
            (isRushHour ? 1.5 : 1.0) *
            (0.75 + jitter * 0.5)
        )
      );
    }
  }

  // 2. Recompute spatial lag k=1 ring neighbor speed ratios via h3.gridDisk(h, 1)
  const neighborRatios = computeNeighborSpeedRatios(cells);
  for (const cell of cells) {
    cell.neighbor_speed_ratio = neighborRatios.get(cell.h3_index) ?? 0.85;
  }

  // 3. Run real ONNX Runtime inference on the [N, 14] Float32Array feature matrix
  const { probabilities, modelSource } = await runRiskInferenceBatch(
    cells,
    weather,
    now
  );

  for (let i = 0; i < cells.length; i++) {
    cells[i].risk_score = probabilities[i];
    cells[i].top_risk_factor = determineTopRiskFactor(cells[i], weather);
    cells[i].updated_at = now.toISOString();
  }

  cells.sort((a, b) => b.risk_score - a.risk_score);

  const totalVehicles = cells.reduce((acc, c) => acc + c.bkk_vehicle_count, 0);
  const executionMs = Math.max(8, Date.now() - startTime);

  const runRecord: PredictionRunRecord = {
    id: Date.now(),
    ran_at: now.toISOString(),
    cells_updated: cells.length,
    temp_c: weather.temp_c,
    precip_mm: weather.precip_mm,
    wind_kmh: weather.wind_speed_kmh,
    active_bkk_vehicles: totalVehicles,
    execution_ms: executionMs,
    model_source: liveFeedUsed ? `${modelSource} + BKK-GTFS-RT` : modelSource,
  };

  local.cells = cells;
  local.weather = weather;
  local.prediction_runs = [runRecord, ...local.prediction_runs].slice(0, 25);
  writeLocalStore(local);

  // 4. Upsert to Supabase (`h3_grid` and `prediction_runs`) when configured
  let storageMode: 'supabase' | 'local-fallback' = 'local-fallback';
  if (supabase && isSupabaseConfigured()) {
    try {
      await supabase.from('h3_grid').upsert(cells, { onConflict: 'h3_index' });
      await supabase.from('prediction_runs').insert({
        cells_updated: runRecord.cells_updated,
        temp_c: runRecord.temp_c,
        precip_mm: runRecord.precip_mm,
        wind_kmh: runRecord.wind_kmh,
        active_bkk_vehicles: runRecord.active_bkk_vehicles,
        execution_ms: runRecord.execution_ms,
        model_source: runRecord.model_source,
      });
      storageMode = 'supabase';
    } catch {
      storageMode = 'local-fallback';
    }
  }

  return {
    ok: true,
    run: runRecord,
    weather,
    bkk_gtfs_rt_live: liveFeedUsed,
    storage_mode: storageMode,
    cells_updated: cells.length,
    top_risk_cell: cells[0] || null,
  };
}

export async function GET() {
  try {
    const res = await executePredictionCycle();
    return NextResponse.json(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const res = await executePredictionCycle();
    return NextResponse.json(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
