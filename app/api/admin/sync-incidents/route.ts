import { NextRequest, NextResponse } from 'next/server';
import {
  fetchTomTomBudapestIncidents,
  fetchBkkGtfsRtAccidentAlerts,
  generateBudapestHistoricalBlackspotDataset,
  IncidentFetchReport,
} from '@/lib/live-incidents';
import { ingestAccidentsIntoH3Grid, CsvAccidentInputRow } from '@/lib/h3-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const provider: 'all' | 'tomtom' | 'bkk' | 'historical' = body.provider || 'all';
    const tomtomApiKey: string | undefined = body.tomtomApiKey || undefined;

    const reports: IncidentFetchReport[] = [];
    const combinedRows: CsvAccidentInputRow[] = [];

    if (provider === 'tomtom' || provider === 'all') {
      const ttReport = await fetchTomTomBudapestIncidents(tomtomApiKey);
      reports.push(ttReport);
      combinedRows.push(...ttReport.rows);
    }

    if (provider === 'bkk' || provider === 'all') {
      const bkkReport = await fetchBkkGtfsRtAccidentAlerts();
      reports.push(bkkReport);
      combinedRows.push(...bkkReport.rows);
    }

    // If 'historical' was requested, or if 'all' returned 0 live rows, also include calibrated Budapest blackspots
    if (
      provider === 'historical' ||
      (provider === 'all' && combinedRows.length === 0)
    ) {
      const histReport = await generateBudapestHistoricalBlackspotDataset();
      reports.push(histReport);
      combinedRows.push(...histReport.rows);
    }

    if (combinedRows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            reports.map((r) => r.details.join(' ')).join(' | ') ||
            'Nem érkezett baleseti adat a kiválasztott forrásból.',
          reports,
        },
        { status: 400 }
      );
    }

    const ingestResult = await ingestAccidentsIntoH3Grid(combinedRows);

    return NextResponse.json({
      ok: true,
      provider,
      reports,
      processed_rows: ingestResult.processed_rows,
      affected_hexagons: ingestResult.affected_hexagons,
      new_hexagons_created: ingestResult.new_hexagons_created,
      updated_cells: ingestResult.updated_cells,
      storage_mode: ingestResult.storage_mode,
      message: `${ingestResult.processed_rows} valós/historikus baleseti és incidens pont sikeresen szinkronizálva ${ingestResult.affected_hexagons} Uber H3 Res-8 hexagonba!`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

