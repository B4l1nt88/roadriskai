import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { ok: false, error: 'Nincs .onnx modell fájl kiválasztva.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let savedLocal = false;
    const modelDir = path.join(process.cwd(), 'public', 'models');
    const modelPath = path.join(modelDir, 'budapest_risk_model.onnx');

    try {
      if (!fs.existsSync(modelDir)) {
        fs.mkdirSync(modelDir, { recursive: true });
      }
      fs.writeFileSync(modelPath, buffer);
      savedLocal = true;
    } catch {
      savedLocal = false;
    }

    let savedSupabase = false;
    const supabase = getSupabaseClient();
    if (supabase && isSupabaseConfigured()) {
      try {
        const { error } = await supabase.storage
          .from('models')
          .upload('budapest_risk_model.onnx', buffer, {
            contentType: 'application/octet-stream',
            upsert: true,
          });
        if (!error) savedSupabase = true;
      } catch {
        savedSupabase = false;
      }
    }

    return NextResponse.json({
      ok: true,
      filename: file.name,
      size_bytes: buffer.length,
      saved_local: savedLocal,
      saved_supabase: savedSupabase,
      message: `ONNX modell sikeresen feltöltve (${(buffer.length / 1024).toFixed(1)} KB).`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

