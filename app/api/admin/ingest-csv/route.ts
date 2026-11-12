import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import { ingestAccidentsIntoH3Grid, CsvAccidentInputRow } from '@/lib/h3-store';

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let rowsToIngest: CsvAccidentInputRow[] = [];

    if (contentType.includes('application/json')) {
      const body = await req.json();
      if (Array.isArray(body.rows)) {
        rowsToIngest = body.rows;
      } else if (typeof body.csv === 'string') {
        const parsed = Papa.parse<Record<string, string>>(body.csv, {
          header: true,
          skipEmptyLines: true,
        });
        rowsToIngest = parsed.data.map((r) => ({
          lat: parseFloat(r.lat || r.latitude || r.LAT || ''),
          lng: parseFloat(r.lng || r.lon || r.longitude || r.LNG || ''),
          occurred_at: r.occurred_at || r.date || r.timestamp,
          is_wet_road: parseInt(r.is_wet_road || r.wet || '0', 10) || 0,
          severity: r.severity || 'light',
          osm_tram_tracks:
            r.osm_tram_tracks !== undefined ? parseInt(r.osm_tram_tracks, 10) : undefined,
          osm_intersection_count:
            r.osm_intersection_count !== undefined
              ? parseInt(r.osm_intersection_count, 10)
              : undefined,
          label: r.label || r.location,
        }));
      }
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json(
          { ok: false, error: 'Nincs CSV fájl mellékelve.' },
          { status: 400 }
        );
      }
      const text = await file.text();
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
      });
      rowsToIngest = parsed.data.map((r) => ({
        lat: parseFloat(r.lat || r.latitude || r.LAT || ''),
        lng: parseFloat(r.lng || r.lon || r.longitude || r.LNG || ''),
        occurred_at: r.occurred_at || r.date || r.timestamp,
        is_wet_road: parseInt(r.is_wet_road || r.wet || '0', 10) || 0,
        severity: r.severity || 'light',
        osm_tram_tracks:
          r.osm_tram_tracks !== undefined ? parseInt(r.osm_tram_tracks, 10) : undefined,
        osm_intersection_count:
          r.osm_intersection_count !== undefined
            ? parseInt(r.osm_intersection_count, 10)
            : undefined,
        label: r.label || r.location,
      }));
    } else {
      const text = await req.text();
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
      });
      rowsToIngest = parsed.data.map((r) => ({
        lat: parseFloat(r.lat || r.latitude || r.LAT || ''),
        lng: parseFloat(r.lng || r.lon || r.longitude || r.LNG || ''),
        occurred_at: r.occurred_at || r.date || r.timestamp,
        is_wet_road: parseInt(r.is_wet_road || r.wet || '0', 10) || 0,
        severity: r.severity || 'light',
      }));
    }

    const validRows = rowsToIngest.filter(
      (r) => !Number.isNaN(r.lat) && !Number.isNaN(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180
    );

    if (validRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Nem található érvényes (lat, lng) koordináta sor a CSV-ben.' },
        { status: 400 }
      );
    }

    const result = await ingestAccidentsIntoH3Grid(validRows);

    return NextResponse.json({
      ok: true,
      processed_rows: result.processed_rows,
      affected_hexagons: result.affected_hexagons,
      new_hexagons_created: result.new_hexagons_created,
      updated_cells: result.updated_cells,
      storage_mode: result.storage_mode,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

