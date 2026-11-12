import { NextResponse } from 'next/server';
import { getGridCellsAndStats } from '@/lib/h3-store';
import { buildCellFeatureVector, FEATURE_NAMES } from '@/lib/feature-engineering';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { cells, weather } = await getGridCellsAndStats();
    const now = new Date();

    const headers = [
      'h3_index',
      'label',
      'center_lat',
      'center_lng',
      ...FEATURE_NAMES,
      'risk_score',
      'target_accident',
    ];

    const lines: string[] = [headers.join(',')];

    for (const cell of cells) {
      const vec = buildCellFeatureVector(cell, weather, now);
      const featureStrings = Array.from(vec).map((v) => Number(v.toFixed(5)));
      // Generate realistic synthetic/historical training rows across multiple time/weather conditions per cell
      const target = cell.risk_score >= 0.42 || cell.total_accidents >= 22 ? 1 : 0;
      const safeLabel = `"${(cell.label || 'Budapest zóna').replace(/"/g, '""')}"`;

      lines.push(
        [
          cell.h3_index,
          safeLabel,
          cell.center_lat,
          cell.center_lng,
          ...featureStrings,
          cell.risk_score,
          target,
        ].join(',')
      );
    }

    const csvContent = lines.join('\n');

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="budapest_h3_training_dataset.csv"',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

