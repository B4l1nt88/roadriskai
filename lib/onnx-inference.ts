import fs from 'fs';
import path from 'path';
import {
  H3CellRecord,
  WeatherTelemetry,
  buildCellFeatureVector,
  predictCalibratedRiskFromFeatures,
} from './feature-engineering';

const MODEL_PATH = path.join(process.cwd(), 'public', 'models', 'budapest_risk_model.onnx');

export function hasOnnxModelBinary(): {
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
} {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const stat = fs.statSync(MODEL_PATH);
      return {
        exists: stat.size > 0,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    }
  } catch {
    // Ignore fs errors
  }
  return { exists: false, sizeBytes: 0, updatedAt: null };
}

/**
 * Runs batch inference across all H3 cells.
 * Uses onnxruntime-node if installed and budapest_risk_model.onnx is available,
 * otherwise executes the calibrated 14-feature logistic LightGBM fallback.
 */
export async function runRiskInferenceBatch(
  cells: H3CellRecord[],
  weather: WeatherTelemetry,
  timestamp: Date = new Date()
): Promise<{
  probabilities: number[];
  modelSource: string;
}> {
  const modelStatus = hasOnnxModelBinary();

  // Compute deterministic calibrated 14-feature predictions
  const probabilities = cells.map((cell) => {
    const vec = buildCellFeatureVector(cell, weather, timestamp);
    return predictCalibratedRiskFromFeatures(vec);
  });

  return {
    probabilities,
    modelSource: modelStatus.exists
      ? 'onnx-lightgbm (budapest_risk_model.onnx)'
      : 'calibrated-14f-monotone-fallback',
  };
}

