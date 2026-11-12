CREATE TABLE IF NOT EXISTS h3_grid (
  h3_index TEXT PRIMARY KEY,
  resolution INT NOT NULL DEFAULT 8,
  center_lat DOUBLE PRECISION NOT NULL,
  center_lng DOUBLE PRECISION NOT NULL,
  label TEXT DEFAULT 'Budapest zóna',
  free_flow_kmh DOUBLE PRECISION DEFAULT 50.0,
  osm_tram_tracks INT DEFAULT 0,
  osm_intersection_count INT DEFAULT 4,
  total_accidents INT DEFAULT 0,
  wet_accidents INT DEFAULT 0,
  hist_accident_density DOUBLE PRECISION DEFAULT 0.05,
  hist_wet_accident_ratio DOUBLE PRECISION DEFAULT 0.10,
  risk_score DOUBLE PRECISION DEFAULT 0.08,
  bkk_vehicle_count INT DEFAULT 0,
  bkk_avg_speed DOUBLE PRECISION DEFAULT 42.0,
  bkk_speed_std DOUBLE PRECISION DEFAULT 3.5,
  neighbor_speed_ratio DOUBLE PRECISION DEFAULT 0.85,
  top_risk_factor TEXT DEFAULT 'Normál forgalmi alapzaj',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_accidents (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  h3_index TEXT NOT NULL,
  is_wet_road INT DEFAULT 0,
  severity TEXT DEFAULT 'light',
  osm_tram_tracks INT DEFAULT 0,
  osm_intersection_count INT DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_accidents_h3 ON raw_accidents(h3_index);

CREATE TABLE IF NOT EXISTS prediction_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ DEFAULT NOW(),
  cells_updated INT NOT NULL,
  temp_c DOUBLE PRECISION,
  precip_mm DOUBLE PRECISION,
  wind_kmh DOUBLE PRECISION,
  active_bkk_vehicles INT,
  execution_ms INT,
  model_source TEXT DEFAULT 'onnx-lightgbm'
);

