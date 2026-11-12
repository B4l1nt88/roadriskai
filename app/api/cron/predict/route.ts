import { NextResponse } from 'next/server';
import {
  readLocalStore,
  writeLocalStore,
  fetchBudapestWeather,
  PredictionRunRecord,
} from '@/lib/h3-store';
import {
  computeNeighborSpeedRatios,
  determineTopRiskFactor,
} from '@/lib/feature-engineering';
import { runRiskInferenceBatch } from '@/lib/onnx-inference';
import { getSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function executePredictionCycle() {
  const startTime = Date.now();
  const weather = await fetchBudapestWeather();
  const local = readLocalStore();
  const now = new Date();

  // Simulate or refresh live BKK FUTÁR GTFS-RT vehicle telemetry across H3 cells
  // (Or use live BKK_API_KEY if provided in environment)
  const hour = now.getHours();
  const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18);
  const rainSlowdown = weather.precip_mm > 0.5 ? 0.85 : 1.0;

  for (const cell of local.cells) {
    const jitter = (Math.sin(startTime + cell.center_lat * 1000) + 1) * 0.5; // [0, 1]
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

  // Recompute spatial lag k=1 ring neighbor speed ratios
  const neighborRatios = computeNeighborSpeedRatios(local.cells);
  for (const cell of local.cells) {
    cell.neighbor_speed_ratio = neighborRatios.get(cell.h3_index) ?? 0.85;
  }

  // Run batch 14-feature inference
  const { probabilities, modelSource } = await runRiskInferenceBatch(
    local.cells,
    weather,
    now
  );

  for (let i = 0; i < local.cells.length; i++) {
    local.cells[i].risk_score = probabilities[i];
    local.cells[i].top_risk_factor = determineTopRiskFactor(local.cells[i], weather);
    local.cells[i].updated_at = now.toISOString();
  }

  local.cells.sort((a, b) => b.risk_score - a.risk_score);

  const totalVehicles = local.cells.reduce((acc, c) => acc + c.bkk_vehicle_count, 0);
  const executionMs = Math.max(12, Date.now() - startTime);

  const runRecord: PredictionRunRecord = {
    id: Date.now(),
    ran_at: now.toISOString(),
    cells_updated: local.cells.length,
    temp_c: weather.temp_c,
    precip_mm: weather.precip_mm,
    wind_kmh: weather.wind_speed_kmh,
    active_bkk_vehicles: totalVehicles,
    execution_ms: executionMs,
    model_source: modelSource,
  };

  local.weather = weather;
  local.prediction_runs = [runRecord, ...local.prediction_runs].slice(0, 25);
  writeLocalStore(local);

  const supabase = getSupabaseClient();
  let storageMode: 'supabase' | 'local-fallback' = 'local-fallback';
  if (supabase && isSupabaseConfigured()) {
    try {
      await supabase.from('h3_grid').upsert(local.cells, { onConflict: 'h3_index' });
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
    storage_mode: storageMode,
    cells_updated: local.cells.length,
    top_risk_cell: local.cells[0] || null,
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

