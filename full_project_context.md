# FULL_CONTEXT.md — Budapest Spatio-Temporal Accident Risk Platform

## 1. Executive Summary & Core Rules
We are building a full-stack geospatial predictive web application in **Next.js (App Router, TypeScript, Tailwind CSS)** backed by **Supabase**, **MapLibre GL JS**, **Deck.gl (`H3HexagonLayer`)**, and **ONNX Runtime (`onnxruntime-node`)**.
The platform predicts traffic accident probabilities across Budapest in 15-minute intervals using **Uber H3 (Resolution 8)** hexagonal spatial indexing, live **BKK FUTÁR GTFS-RT** vehicle telemetry, live **Open-Meteo** weather data, and historical accident CSV uploads via an **Admin Portal (`/admin`)**.

### Strict Architectural Constraints
1. **NO Bloat / NO HUD:** Do NOT build mobile driving HUD overlays, browser voice synthesis (`speechSynthesis`), or Leaflet maps.
2. **Spatial Indexing Standard:** Every coordinate (`lat`, `lng`) is indexed into **Uber H3 Resolution 8** (`h3-js` in TypeScript, `h3` in Python). Primary key is `h3_index` (e.g., `"881ec936bdfffff"`).
3. **Map Engine:** **MapLibre GL JS** with the free Carto Dark Matter basemap (`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json` — no API key needed) + **Deck.gl `H3HexagonLayer`**. Map components must be dynamically imported with `ssr: false`.
4. **Zero-Config Fallback:** Every API route (`/api/cells`, `/api/admin/*`, `/api/cron/predict`) MUST include a local fallback store (`.data/local_store.json` or in-memory seed of ~180 Budapest H3 hexagons) so the app builds (`npm run build`) and runs on Vercel immediately even before `.env.local` keys (`SUPABASE_*`, `BKK_API_KEY`) are added.
5. **Node.js Runtime for Inference:** `/api/cron/predict` must specify `export const runtime = 'nodejs';`.

---

## 2. Agent Roles (Antigravity Swarm)
- **Agent 1 (Frontend & Geospatial UI):** Owns `app/page.tsx`, `app/admin/page.tsx`, `components/DeckH3Map.tsx`, and `components/AnalyticsSidebar.tsx`. Ensures zero SSR hydration issues and clean dark-mode Tailwind UI.
- **Agent 2 (Backend, H3 Engine & Supabase):** Owns `lib/h3-store.ts`, `lib/supabase.ts`, `lib/feature-engineering.ts`, `supabase/schema.sql`, and all Next.js API routes (`app/api/**`).
- **Agent 3 (ML & ONNX Pipeline):** Owns `scripts/train_model.py`, `public/models/budapest_risk_model.onnx`, and `lib/onnx-inference.ts`.

---

## 3. Target Directory Structure
```text
├── FULL_CONTEXT.md                     # This master specification file
├── app/
│   ├── page.tsx                        # Main interactive H3 Map & Analytics Sidebar
│   ├── admin/
│   │   └── page.tsx                    # Admin Portal (CSV upload -> H3, ONNX upload, manual trigger)
│   └── api/
│       ├── cells/route.ts              # GET: Returns H3 grid cells, weather, and latest run stats
│       ├── admin/
│       │   ├── init-grid/route.ts      # POST: Resets/seeds Budapest Resolution-8 H3 grid
│       │   ├── ingest-csv/route.ts     # POST: Parses CSV rows (lat,lng) -> H3 -> updates accidents & density
│       │   ├── export-training/route.ts# GET: Exports joined H3 dataset as CSV for local Python training
│       │   └── upload-model/route.ts   # POST: Uploads new .onnx model to Supabase Storage / local fallback
│       └── cron/
│           └── predict/route.ts        # POST/GET: Open-Meteo + BKK GTFS-RT -> 14 features -> ONNX -> upsert
├── components/
│   ├── DeckH3Map.tsx                   # Client-only MapLibre + Deck.gl H3HexagonLayer (2D/3D toggle)
│   └── AnalyticsSidebar.tsx            # Weather badge, BKK vehicle counter, Risk filter, Cell Inspector, Top 10
├── lib/
│   ├── h3-store.ts                     # Dual-mode store (Supabase if env vars set, else local Budapest H3 seed)
│   ├── feature-engineering.ts          # Builds exact 14-feature Float32Array & Spatial Lag (h3.gridDisk)
│   └── onnx-inference.ts               # Singleton onnxruntime-node session + deterministic fallback
├── scripts/
│   └── train_model.py                  # Python LightGBM trainer & ONNX exporter (opset 12, zipmap=False)
├── public/
│   └── models/
│       └── budapest_risk_model.onnx    # Trained LightGBM ONNX binary
└── supabase/
    └── schema.sql                      # PostgreSQL schema for Supabase
```

---

## 4. Machine Learning & 14-Feature Contract (`Float32Array`)
We predict calibrated accident probability $P(Y_{h,t} = 1) \in [0, 1]$ for H3 cell $h$ during 15-minute window $t$:

$$\hat{y}_{h,t} = \sigma \left( \sum_{k=1}^{K} f_k(x_{h,t}) \right)$$

Both `scripts/train_model.py` and `lib/feature-engineering.ts` MUST use this exact 14-feature order (`shape: [N, 14]`, `dtype: float32`):

| Index | Feature Name | Range | Formula / Source | Monotone Constraint |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `hour_sin` | `[-1, 1]` | $\sin(2\pi \cdot \text{hour} / 24.0)$ | `0` |
| `1` | `hour_cos` | `[-1, 1]` | $\cos(2\pi \cdot \text{hour} / 24.0)$ | `0` |
| `2` | `is_weekend` | `{0, 1}` | `1.0` if Saturday/Sunday else `0.0` | `0` |
| `3` | `bkk_speed_ratio` | `[0, 1.2]` | $\min(1.2, \text{bkk\_avg\_speed} / \text{free\_flow\_kmh})$ | `-1` (Slower = riskier) |
| `4` | `bkk_speed_std` | `[0, 50]` | Speed standard deviation (km/h) in cell $h$ (Shockwave index) | `+1` (Higher std = riskier) |
| `5` | `neighbor_speed_ratio` | `[0, 1.2]` | Mean `bkk_speed_ratio` of $k=1$ ring via `h3.gridDisk(h, 1)` | `-1` |
| `6` | `bkk_delay_avg` | `[0, 1800]` | Average delay in seconds or `(1 - bkk_speed_ratio) * 300` | `+1` |
| `7` | `precip_mm` | `[0, 50]` | Live precipitation (mm/h) from Open-Meteo API | `+1` |
| `8` | `wind_speed_kmh` | `[0, 120]` | Live 10m wind speed (km/h) from Open-Meteo API | `+1` |
| `9` | `temp_c` | `[-25, 45]` | Live 2m temperature (°C) from Open-Meteo API | `0` |
| `10` | `osm_tram_tracks` | `{0, 1}` | `1.0` if tram tracks cross cell $h$, else `0.0` | `+1` |
| `11` | `osm_intersection_count`| `[0, 50]` | Road intersections inside cell $h$ | `+1` |
| `12` | `hist_accident_density` | `[0, 1]` | Normalized historical accidents (`total_accidents / max_accidents`) | `+1` |
| `13` | `hist_wet_accident_ratio`| `[0, 1]` | `wet_accidents / max(1, total_accidents)` | `+1` |

- **LightGBM Monotone Constraints:** `[0, 0, 0, -1, 1, -1, 1, 1, 1, 0, 1, 1, 1, 1]`
- **ONNX Export Settings:** Input name `"float_input"`, `FloatTensorType([None, 14])`, `target_opset=12`, `zipmap=False` so output `probabilities` is a flat `Float32Array` of `[P(0), P(1)]`.
- **Explainability Heuristic (`top_risk_factor`):**
  1. `temp_c <= 2.0 && precip_mm > 0` -> `"Jegesedés / ónos eső veszély"`
  2. `precip_mm > 0.5 && osm_tram_tracks === 1` -> `"Csúszós villamossínek és csapadék"`
  3. `bkk_speed_std >= 11.0` -> `"Hirtelen torlódási hullám (Shockwave)"`
  4. `bkk_speed_ratio < 0.45` -> `"Súlyos forgalmi torlódás"`
  5. `hist_accident_density >= 0.55` -> `"Magas historikus baleseti gócpont"`
  6. Else -> `"Normál forgalmi alapzaj"`

---

## 5. Database Schema (`supabase/schema.sql`)
```sql
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
```

---

## 6. Budapest H3 Seed Hubs (`lib/h3-store.ts`)
When initializing the grid or running in zero-config mode, generate Resolution-8 H3 disks (`h3.gridDisk(hubCell, 4)`) around these 8 Budapest hubs (~180 contiguous hexagons):
1. **BAH-csomópont** (`47.4891, 19.0163`, `osm_tram_tracks: 1, osm_intersection_count: 8, free_flow_kmh: 50`)
2. **Nyugati tér** (`47.5106, 19.0558`, `osm_tram_tracks: 1, osm_intersection_count: 10, free_flow_kmh: 50`)
3. **Blaha Lujza tér / Rákóczi út** (`47.4963, 19.0706`, `osm_tram_tracks: 1, osm_intersection_count: 9, free_flow_kmh: 50`)
4. **Könyves Kálmán krt. / Üllői út** (`47.4754, 19.0991`, `osm_tram_tracks: 1, osm_intersection_count: 7, free_flow_kmh: 70`)
5. **Clark Ádám tér / Lánchíd** (`47.4981, 19.0402`, `osm_tram_tracks: 1, osm_intersection_count: 6, free_flow_kmh: 30`)
6. **Árpád híd** (`47.5398, 19.0542`, `osm_tram_tracks: 1, osm_intersection_count: 7, free_flow_kmh: 70`)
7. **Széll Kálmán tér** (`47.5071, 19.0245`, `osm_tram_tracks: 1, osm_intersection_count: 9, free_flow_kmh: 50`)
8. **Petőfi híd / Boráros tér** (`47.4793, 19.0663`, `osm_tram_tracks: 1, osm_intersection_count: 7, free_flow_kmh: 50`)