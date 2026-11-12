import { NextResponse } from 'next/server';
import { resetAndSeedGrid } from '@/lib/h3-store';

export async function POST() {
  try {
    const result = await resetAndSeedGrid();
    return NextResponse.json({
      ok: true,
      message: `Budapest H3 Resolution-8 rács alaphelyzetbe állítva (${result.cells.length} cella).`,
      cells_count: result.cells.length,
      storage_mode: result.storage_mode,
      cells: result.cells,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

