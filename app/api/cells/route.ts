import { NextResponse } from 'next/server';
import { getGridCellsAndStats } from '@/lib/h3-store';
import { hasOnnxModelBinary } from '@/lib/onnx-inference';
import { readOsmInfrastructure } from '@/lib/osm-overpass';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
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

