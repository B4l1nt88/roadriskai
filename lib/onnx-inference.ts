import fs from 'fs';
import path from 'path';
import * as ort from 'onnxruntime-node';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  H3CellRecord,
  WeatherTelemetry,
  buildBatchFeatureMatrix,
  buildCellFeatureVector,
  predictCalibratedRiskFromFeatures,
} from './feature-engineering';

const LOCAL_MODEL_PATH = path.join(
  process.cwd(),
  'public',
  'models',
  'budapest_risk_model.onnx'
);
const TMP_MODEL_PATH = path.join(
  process.cwd(),
  '.data',
  'cached_budapest_risk_model.onnx'
);

let cachedSession: ort.InferenceSession | null = null;
let cachedSessionSource: string = 'none';
let cachedModelMtimeMs: number = 0;

export function invalidateOnnxSessionCache(): void {
  cachedSession = null;
  cachedSessionSource = 'none';
  cachedModelMtimeMs = 0;
}

export function hasOnnxModelBinary(): {
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
} {
  try {
    if (fs.existsSync(LOCAL_MODEL_PATH)) {
      const stat = fs.statSync(LOCAL_MODEL_PATH);
      return {
        exists: stat.size > 0,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    }
    if (fs.existsSync(TMP_MODEL_PATH)) {
      const stat = fs.statSync(TMP_MODEL_PATH);
      return {
        exists: stat.size > 0,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    }
  } catch {
    // Ignore filesystem errors
  }
  return { exists: false, sizeBytes: 0, updatedAt: null };
}

/**
 * Loads or returns a singleton onnxruntime-node InferenceSession.
 * Priority:
 *  1. Supabase Storage `models/budapest_risk_model.onnx` (if Supabase is configured and bucket exists)
 *  2. Local `public/models/budapest_risk_model.onnx`
 */
async function getOrLoadOnnxSession(): Promise<{
  session: ort.InferenceSession | null;
  source: string;
}> {
  // Check if local file changed on disk since last load
  try {
    if (fs.existsSync(LOCAL_MODEL_PATH)) {
      const stat = fs.statSync(LOCAL_MODEL_PATH);
      if (cachedSession && stat.mtimeMs !== cachedModelMtimeMs && cachedSessionSource === 'onnx-local') {
        cachedSession = null;
      }
    }
  } catch {
    // Ignore stat errors
  }

  if (cachedSession) {
    return { session: cachedSession, source: cachedSessionSource };
  }

  // 1. Try loading from Supabase Storage `models` bucket if configured
  const supabase = getSupabaseClient();
  if (supabase && isSupabaseConfigured()) {
    try {
      const { data, error } = await supabase.storage
        .from('models')
        .download('budapest_risk_model.onnx');
      if (!error && data) {
        const arrayBuf = await data.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuf);
        try {
          const dir = path.dirname(TMP_MODEL_PATH);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(TMP_MODEL_PATH, Buffer.from(uint8));
        } catch {
          // Ignore write cache error
        }
        cachedSession = await ort.InferenceSession.create(uint8);
        cachedSessionSource = 'onnx-supabase-storage';
        return { session: cachedSession, source: cachedSessionSource };
      }
    } catch {
      // Fall through to local model file
    }
  }

  // 2. Load from `public/models/budapest_risk_model.onnx`
  try {
    if (fs.existsSync(LOCAL_MODEL_PATH)) {
      const stat = fs.statSync(LOCAL_MODEL_PATH);
      const buf = fs.readFileSync(LOCAL_MODEL_PATH);
      cachedSession = await ort.InferenceSession.create(new Uint8Array(buf));
      cachedSessionSource = 'onnx-lightgbm (budapest_risk_model.onnx)';
      cachedModelMtimeMs = stat.mtimeMs;
      return { session: cachedSession, source: cachedSessionSource };
    }
  } catch {
    // Fall through to deterministic fallback
  }

  return { session: null, source: 'calibrated-14f-monotone-fallback' };
}

/**
 * Runs batch inference on the [N, 14] Float32Array feature matrix using `onnxruntime-node`.
 * Falls back cleanly to deterministic calibrated 14-feature scoring if ONNX fails.
 */
export async function runRiskInferenceBatch(
  cells: H3CellRecord[],
  weather: WeatherTelemetry,
  timestamp: Date = new Date()
): Promise<{
  probabilities: number[];
  modelSource: string;
}> {
  const N = cells.length;
  if (N === 0) {
    return { probabilities: [], modelSource: 'empty-grid' };
  }

  const featureMatrix = buildBatchFeatureMatrix(cells, weather, timestamp);
  const { session, source } = await getOrLoadOnnxSession();

  if (session) {
    try {
      const inputName = session.inputNames[0] || 'float_input';
      const inputTensor = new ort.Tensor('float32', featureMatrix, [N, 14]);
      const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };

      const results = await session.run(feeds);

      // With zipmap=False, LightGBM ONNX outputs `label` (int64 [N]) and `probabilities` (float32 [N, 2])
      const probOutputName =
        session.outputNames.find((n) => n.toLowerCase().includes('prob')) ||
        session.outputNames[1] ||
        session.outputNames[0];

      const probTensor = results[probOutputName];
      if (probTensor && probTensor.data) {
        const rawData = probTensor.data as Float32Array | number[];
        const probabilities: number[] = [];

        if (rawData.length === N * 2) {
          for (let i = 0; i < N; i++) {
            const p1 = Number(rawData[i * 2 + 1]);
            probabilities.push(
              Number(Math.min(0.99, Math.max(0.01, Number.isFinite(p1) ? p1 : 0.08)).toFixed(4))
            );
          }
          return { probabilities, modelSource: source };
        } else if (rawData.length === N) {
          for (let i = 0; i < N; i++) {
            const p1 = Number(rawData[i]);
            probabilities.push(
              Number(Math.min(0.99, Math.max(0.01, Number.isFinite(p1) ? p1 : 0.08)).toFixed(4))
            );
          }
          return { probabilities, modelSource: source };
        }
      }
    } catch {
      // Fallback to calibrated formula if tensor shape or runtime encounters an error
    }
  }

  const fallbackProbs = cells.map((cell) => {
    const vec = buildCellFeatureVector(cell, weather, timestamp);
    return predictCalibratedRiskFromFeatures(vec);
  });

  return {
    probabilities: fallbackProbs,
    modelSource: 'calibrated-14f-monotone-fallback',
  };
}
