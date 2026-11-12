import { NextRequest, NextResponse } from 'next/server';
import {
  readOsmInfrastructure,
  syncLiveOsmOverpassBudapest,
  expandToFullBudapestPolygonGrid,
} from '@/lib/osm-overpass';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const infra = readOsmInfrastructure();
    return NextResponse.json({
      ok: true,
      infrastructure: infra,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action: 'sync-osm' | 'expand-full-budapest' = body.action || 'sync-osm';

    if (action === 'expand-full-budapest') {
      const res = await expandToFullBudapestPolygonGrid();
      return NextResponse.json({
        ok: true,
        action,
        total_cells: res.total_cells,
        new_cells_added: res.new_cells_added,
        message: `Teljes Budapest közigazgatási H3 Res-8 lefedettség aktiválva (${res.total_cells} hexagon, +${res.new_cells_added} új cella via h3.polygonToCells)!`,
      });
    }

    const res = await syncLiveOsmOverpassBudapest();
    return NextResponse.json({
      ok: true,
      action,
      infrastructure: res.infra,
      enriched_cells_count: res.enriched_cells_count,
      message: `${res.infra.source} szinkronizálva (${res.enriched_cells_count} H3 cella infrastruktúra-adatai frissítve)!`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
