import { NextResponse } from 'next/server';
import { getGridCellsAndStats, ingestAccidentsIntoH3Grid } from '@/lib/h3-store';
import { hasOnnxModelBinary } from '@/lib/onnx-inference';
import { readOsmInfrastructure } from '@/lib/osm-overpass';
import {
  fetchTomTomBudapestIncidents,
  fetchBkkGtfsRtAccidentAlerts,
} from '@/lib/live-incidents';

export const dynamic = 'force-dynamic';

let lastAutoSyncTime = 0;

export async function GET() {
  try {
    // Auto-sync live TomTom v5 & BKK GTFS-RT incidents once every 10 minutes when API keys are present in .env.local
    const nowMs = Date.now();
    const hasLiveKeys = Boolean(
      process.env.TOMTOM_API_KEY ||
        process.env.NEXT_PUBLIC_TOMTOM_API_KEY ||
        process.env.BKK_API_KEY ||
        process.env.NEXT_PUBLIC_BKK_API_KEY
    );

    if (hasLiveKeys && nowMs - lastAutoSyncTime > 10 * 60 * 1000) {
      lastAutoSyncTime = nowMs;
      try {
        const [ttReport, bkkReport] = await Promise.all([
          fetchTomTomBudapestIncidents(),
          fetchBkkGtfsRtAccidentAlerts(),
        ]);
        const combined = [...ttReport.rows, ...bkkReport.rows];
        if (combined.length > 0) {
          await ingestAccidentsIntoH3Grid(combined);
        }
      } catch {
        // Ignore transient external API errors
      }
    }

    const data = await getGridCellsAndStats();
    const modelStatus = hasOnnxModelBinary();
    const infrastructure = readOsmInfrastructure();

    const totalVehicles = data.cells.reduce((acc, c) => acc + (c.bkk_vehicle_count || 0), 0);
    const avgRisk =
      data.cells.length > 0
        ? data.cells.reduce((acc, c) => acc + c.risk_score, 0) / data.cells.length
        : 0;

    return NextResponse.json({
      ok: true,
      cells: data.cells,
      weather: data.weather,
      prediction_runs: data.prediction_runs,
      storage_mode: data.storage_mode,
      model_status: modelStatus,
      infrastructure,
      summary: {
        total_cells: data.cells.length,
        active_bkk_vehicles: totalVehicles,
        avg_risk_score: Number(avgRisk.toFixed(4)),
        high_risk_cells: data.cells.filter((c) => c.risk_score >= 0.45).length,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

