# RoadRiskAI — Budapest Spatio-Temporal Accident Risk Platform

🌐 **Élő alkalmazás (Live Demo):** [https://roadriskai-five.vercel.app/](https://roadriskai-five.vercel.app/)  
📄 **Fejlesztési Promptok Dokumentációja:** A projekt felépítéséhez, architektúrájához és iteratív fejlesztéséhez használt teljes prompt-történet a repó gyökerében található **`prompts.pdf`** fájlban érhető el.

---

## 1. Projekt Áttekintés

A **RoadRiskAI** egy valós idejű, tér-időbeli (spatio-temporal) gépi tanulási webalkalmazás, amely **15 perces időablakokban** becsüli meg a közúti közlekedési balesetek bekövetkezési valószínűségét $P(Y_{h,t} = 1) \in [0, 1]$ Budapest teljes úthálózatán.

A rendszer az **Uber H3 (Resolution 8)** hexagonális térbeli indexelést kombinálja a **BKK FUTÁR GTFS-RT** élő járműtelemetriával, a **TomTom Traffic Incidents API v5** valós idejű baleseti és torlódási adataival, az **Open-Meteo** meteorológiai adataival, az **OpenStreetMap (Overpass API)** infrastruktúra-topológiájával, valamint egy **LightGBM ONNX** (`onnxruntime-node`) következtető motorral.

### Főbb funkciók
- **Folytonos Kockázati Hőtérkép (`HeatmapLayer`) & Finomhangolható H3 Hexagon Rács (`H3HexagonLayer`)**: Zoom-adaptív, `MEAN` aggregációjú hőtérkép, valamint egyetlen kattintással be- és kikapcsolható 2D/3D extrudált Uber H3 Resolution-8 hexagon réteg.
- **OpenStreetMap Infrastruktúra Rétegek**: Külön kapcsolható budapesti főúthálózat (`PathLayer` dinamikus kockázatszínezéssel), villamosvonalak (`railway=tram`) és jelzőlámpás csomópontok (`ScatterplotLayer`).
- **Élő Telemetria & Baleseti Adatszinkron**:
  - **BKK FUTÁR GTFS-RT** (`VehiclePositions.pb` és `Alerts.pb`) dekódolás: cellánkénti átlagsebesség, szabad áramláshoz viszonyított arány, és **Shockwave index ($\sigma$)** (hirtelen fékezési hullámok detektálása).
  - **TomTom Traffic Incidents API v5**: valós idejű budapesti balesetek és útlezárások automatikus H3 cellákba sorolása.
  - **Open-Meteo API**: élő budapesti hőmérséklet, csapadék és szélsebesség.
- **Magyarázható AI (XAI) & „Hogyan működik a modell?” fül**: Minden H3 cellához szövegesen is megjelenik a domináns kockázati tényező (pl. *„Csúszós villamossínek és csapadék”*, *„Hirtelen torlódási hullám (Shockwave)”*), a jobb oldali sávban pedig részletes dokumentációs fül magyarázza el a 14 bemeneti változót.
- **Admin & MLOps Portál (`/admin`)**:
  - Élő TomTom v5, BKK Alerts és ORFK/KSH baleseti gócpont szinkronizáló,
  - Teljes Budapest lefedettség generálás (`h3.polygonToCells` — ~1 000 db H3 Res-8 cella),
  - Drag-and-drop CSV baleset-feltöltő (`lat, lng` $\rightarrow$ `h3_index`),
  - 14-jellemzős tanító CSV export és `.onnx` modell bináris feltöltés,
  - Manuális 15 perces predikció indító és futásnapló (`prediction_runs`).

---

## 2. Gépi Tanulási Modell & 14-Jellemzős Szerződés (`Float32Array[14]`)

A predikciót egy monotonitási kényszerekkel (`monotone_constraints`) tanított **LightGBM** osztályozó végzi, amelyet `target_opset=12` és `zipmap=False` beállítással exportálunk ONNX formátumba (`public/models/budapest_risk_model.onnx`):

$$\hat{y}_{h,t} = \sigma \left( \sum_{k=1}^{K} f_k(x_{h,t}) \right)$$

| Index | Jellemző neve | Tartomány | Forrás / Képlet | Monoton korlát |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `hour_sin` | `[-1, 1]` | $\sin(2\pi \cdot \text{óra} / 24.0)$ | `0` |
| `1` | `hour_cos` | `[-1, 1]` | $\cos(2\pi \cdot \text{óra} / 24.0)$ | `0` |
| `2` | `is_weekend` | `{0, 1}` | `1.0` szombat/vasárnap, különben `0.0` | `0` |
| `3` | `bkk_speed_ratio` | `[0, 1.2]` | $\min(1.2, \text{bkk\_avg\_speed} / \text{free\_flow\_kmh})$ | `-1` (Lassabb = kockázatosabb) |
| `4` | `bkk_speed_std` | `[0, 50]` | Sebesség szórása (km/h) a cellában (Shockwave index) | `+1` (Nagyobb szórás = kockázatosabb) |
| `5` | `neighbor_speed_ratio` | `[0, 1.2]` | A $k=1$ szomszédos H3 gyűrű (`h3.gridDisk(h, 1)`) átlagos sebességaránya | `-1` |
| `6` | `bkk_delay_avg` | `[0, 1800]` | Becsült torlódási késés másodpercben | `+1` |
| `7` | `precip_mm` | `[0, 50]` | Élő csapadék (mm/h) — Open-Meteo API | `+1` |
| `8` | `wind_speed_kmh` | `[0, 120]` | Élő 10m szélsebesség (km/h) — Open-Meteo API | `+1` |
| `9` | `temp_c` | `[-25, 45]` | Élő 2m hőmérséklet (°C) — Open-Meteo API | `0` |
| `10` | `osm_tram_tracks` | `{0, 1}` | `1.0` ha villamossín halad át a cellán (`railway=tram`), különben `0.0` | `+1` |
| `11` | `osm_intersection_count`| `[0, 50]` | Jelzőlámpás csomópontok és kereszteződések száma a cellában | `+1` |
| `12` | `hist_accident_density` | `[0, 1]` | Normalizált baleseti sűrűség (`total_accidents / max_accidents`) | `+1` |
| `13` | `hist_wet_accident_ratio`| `[0, 1]` | Nedves útfelületen történt balesetek aránya | `+1` |

---

## 3. Hogyan futtatható a projekt?

### 3.1. Éles (Production) verzió
Az alkalmazás élőben fut a Vercelen, és azonnal kipróbálható:  
👉 **[https://roadriskai-five.vercel.app/](https://roadriskai-five.vercel.app/)**

### 3.2. Lokális futtatás (Fejlesztői környezet)

1. **Függőségek telepítése:**
   ```bash
   npm install
   ```

2. **Környezeti változók beállítása (`.env.local`):**
   Másold le a `.env.example` fájlt `.env.local` néven. (Az alkalmazás **Zero-Config Fallback** móddal is rendelkezik, így `.env.local` nélkül is azonnal elindul egy helyi `.data/local_store.json` tárolóval!)
   ```env
   BKK_API_KEY=your-bkk-futar-api-key
   TOMTOM_API_KEY=your-tomtom-developer-api-key
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-secret-key
   ADMIN_USER=admin
   ADMIN_PASSWORD=your-admin-password
   CRON_SECRET=your-cron-secret
   ```

3. **Fejlesztői szerver indítása:**
   ```bash
   npm run dev
   ```
   Ezután nyisd meg a [http://localhost:3000](http://localhost:3000) (főoldal) vagy a [http://localhost:3000/admin](http://localhost:3000/admin) (Admin Portál) címet.

4. **LightGBM ONNX modell újratanítása (Opcionális, Python 3):**
   ```bash
   pip install lightgbm scikit-learn onnxmltools skl2onnx numpy pandas h3 packaging
   python scripts/train_model.py
   # Vagy az Admin Portálról exportált CSV-vel:
   python scripts/train_model.py --csv budapest_h3_training_dataset.csv
   ```

---

## 4. Könyvtárszerkezet & Dokumentáció

```text
├── prompts.pdf                         # A projekt elkészítéséhez használt összes prompt dokumentációja
├── FULL_CONTEXT.md                     # Architektúra és gépi tanulási specifikáció
├── middleware.ts                       # HTTP Basic Auth (/admin) és Bearer token (/api/cron) védelem
├── app/
│   ├── page.tsx                        # Főoldal: Interaktív H3 Heatmap/Hexagon térkép + Analitikai oldalsáv
│   ├── admin/page.tsx                  # Admin & MLOps Portál
│   └── api/
│       ├── cells/route.ts              # GET: H3 cellák, időjárás, infrastruktúra és automatikus 10p szinkron
│       ├── admin/
│       │   ├── init-grid/route.ts      # POST: Budapest H3 Res-8 rács alaphelyzetbe állítása
│       │   ├── ingest-csv/route.ts     # POST: CSV (lat, lng) -> H3 Res-8 aggregáció
│       │   ├── sync-incidents/route.ts # POST: Élő TomTom v5 + BKK Alerts + ORFK gócpont szinkron
│       │   ├── osm-network/route.ts    # POST: Élő OSM Overpass API + Teljes Budapest H3 lefedettség
│       │   ├── export-training/route.ts# GET: 14-jellemzős tanító adathalmaz exportálása CSV-be
│       │   └── upload-model/route.ts   # POST: Új .onnx modell feltöltése (Supabase Storage + local)
│       └── cron/
│           └── predict/route.ts        # GET/POST: 15-perces BKK GTFS-RT + Open-Meteo + ONNX predikció
├── components/
│   ├── DeckH3Map.tsx                   # MapLibre GL + Deck.gl (HeatmapLayer, H3HexagonLayer, PathLayer)
│   └── AnalyticsSidebar.tsx            # Élő telemetria, Top 10 lista és "Hogyan működik a modell?" fül
├── lib/
│   ├── h3-store.ts                     # Dual-mode tároló (Supabase + Zero-Config helyi fallback)
│   ├── feature-engineering.ts          # 14-feature Float32Array építő, h3.gridDisk térbeli lag és XAI
│   ├── onnx-inference.ts               # Singleton onnxruntime-node következtető motor
│   ├── live-incidents.ts               # TomTom Traffic Incidents v5 & BKK GTFS-RT Alerts kliens
│   └── osm-overpass.ts                 # OpenStreetMap Overpass API és h3.polygonToCells motor
├── scripts/
│   └── train_model.py                  # Python LightGBM tanító és ONNX exportáló (opset 12, zipmap=False)
├── public/models/
│   └── budapest_risk_model.onnx        # Tanított LightGBM ONNX bináris modell
└── supabase/
    └── schema.sql                      # PostgreSQL adatbázis séma (h3_grid, raw_accidents, prediction_runs)
```

