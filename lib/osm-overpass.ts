import * as h3 from 'h3-js';
import fs from 'fs';
import path from 'path';
import {
  readLocalStore,
  writeLocalStore,
  fetchBudapestWeather,
} from './h3-store';
import {
  H3CellRecord,
  computeNeighborSpeedRatios,
  buildCellFeatureVector,
  determineTopRiskFactor,
  predictCalibratedRiskFromFeatures,
} from './feature-engineering';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';

export interface OsmRoadLine {
  id: string;
  name: string;
  highway: string;
  maxspeed: number;
  h3_index: string;
  path: [number, number][]; // [lng, lat][]
}

export interface OsmTramLine {
  id: string;
  name: string;
  h3_index: string;
  path: [number, number][]; // [lng, lat][]
}

export interface OsmIntersectionNode {
  id: string;
  lat: number;
  lng: number;
  h3_index: string;
  kind: 'traffic_signals' | 'junction' | 'crossing';
  label: string;
}

export interface BudapestOsmInfrastructure {
  updated_at: string;
  source: string;
  roads: OsmRoadLine[];
  trams: OsmTramLine[];
  intersections: OsmIntersectionNode[];
}

const INFRA_STORE_PATH = path.join(process.cwd(), '.data', 'osm_infrastructure.json');

// Outer administrative polygon of Greater Budapest ([lat, lng] pairs for h3.polygonToCells)
export const BUDAPEST_BOUNDARY_LATLNG: [number, number][] = [
  [47.613, 19.04],
  [47.595, 19.14],
  [47.55, 19.245],
  [47.48, 19.265],
  [47.415, 19.225],
  [47.385, 19.11],
  [47.39, 18.98],
  [47.445, 18.925],
  [47.52, 18.935],
  [47.585, 18.985],
  [47.613, 19.04],
];

/**
 * Built-in seed road, tram, and junction network across Budapest's primary corridors
 * so the map layers render immediately even before hitting Overpass API.
 */
export function getDefaultBudapestInfrastructure(): BudapestOsmInfrastructure {
  const roads: OsmRoadLine[] = [
    {
      id: 'road-nagykorut',
      name: 'Nagykörút (Szent István – Teréz – Erzsébet – József – Ferenc krt.)',
      highway: 'primary',
      maxspeed: 50,
      h3_index: h3.latLngToCell(47.4963, 19.0706, 8),
      path: [
        [19.0478, 47.5142],
        [19.0558, 47.5106],
        [19.0634, 47.5052],
        [19.0701, 47.4998],
        [19.0706, 47.4963],
        [19.0702, 47.4892],
        [19.0663, 47.4793],
        [19.0598, 47.4772],
        [19.0468, 47.4773],
      ],
    },
    {
      id: 'road-rakoczi-kossuth',
      name: 'Hegyalja út – Erzsébet híd – Kossuth Lajos u. – Rákóczi út – Kerepesi út',
      highway: 'primary',
      maxspeed: 50,
      h3_index: h3.latLngToCell(47.4946, 19.0602, 8),
      path: [
        [19.0163, 47.4891],
        [19.0352, 47.4902],
        [19.0492, 47.4918],
        [19.0602, 47.4946],
        [19.0706, 47.4963],
        [19.0819, 47.5004],
        [19.1085, 47.5018],
        [19.1362, 47.5034],
      ],
    },
    {
      id: 'road-ulloi',
      name: 'Üllői út (Kálvin tér – Klinikák – Nagyvárad tér – Népliget – Határ út)',
      highway: 'primary',
      maxspeed: 60,
      h3_index: h3.latLngToCell(47.4754, 19.0991, 8),
      path: [
        [19.0618, 47.4897],
        [19.0702, 47.4858],
        [19.0894, 47.4791],
        [19.0991, 47.4754],
        [19.1155, 47.4665],
        [19.1282, 47.4595],
      ],
    },
    {
      id: 'road-hungaria-konyves',
      name: 'Árpád híd – Róbert Károly krt. – Hungária krt. – Könyves Kálmán krt. – Rákóczi híd',
      highway: 'trunk',
      maxspeed: 70,
      h3_index: h3.latLngToCell(47.5398, 19.0542, 8),
      path: [
        [19.0402, 47.5415],
        [19.0542, 47.5398],
        [19.0685, 47.5335],
        [19.0895, 47.5212],
        [19.1045, 47.5082],
        [19.1095, 47.4922],
        [19.0991, 47.4754],
        [19.0795, 47.4692],
        [19.0585, 47.4698],
      ],
    },
    {
      id: 'road-vaci',
      name: 'Váci út (Nyugati tér – Lehel tér – Árpád híd – Újpest)',
      highway: 'primary',
      maxspeed: 60,
      h3_index: h3.latLngToCell(47.5106, 19.0558, 8),
      path: [
        [19.0558, 47.5106],
        [19.0604, 47.5182],
        [19.0652, 47.5328],
        [19.0688, 47.5455],
        [19.0735, 47.5612],
      ],
    },
    {
      id: 'road-buda-alkotas-margit',
      name: 'Budaörsi út – BAH-csomópont – Alkotás u. – Széll Kálmán tér – Margit krt.',
      highway: 'primary',
      maxspeed: 50,
      h3_index: h3.latLngToCell(47.5071, 19.0245, 8),
      path: [
        [18.995, 47.4725],
        [19.0163, 47.4891],
        [19.0238, 47.4978],
        [19.0245, 47.5071],
        [19.0358, 47.5138],
        [19.0478, 47.5142],
      ],
    },
    {
      id: 'road-lanchid-kiskorut',
      name: 'Alagút – Clark Ádám tér – Lánchíd – Deák Ferenc tér – Kiskörút',
      highway: 'secondary',
      maxspeed: 40,
      h3_index: h3.latLngToCell(47.4981, 19.0402, 8),
      path: [
        [19.0325, 47.4978],
        [19.0402, 47.4981],
        [19.0475, 47.4992],
        [19.0545, 47.4978],
        [19.0602, 47.4946],
        [19.0618, 47.4897],
        [19.0568, 47.4865],
      ],
    },
  ];

  const trams: OsmTramLine[] = [
    {
      id: 'tram-4-6',
      name: '4-6-os Villamos fővonal (Széll Kálmán tér – Nagykörút – Móricz Zsigmond körtér)',
      h3_index: h3.latLngToCell(47.4963, 19.0706, 8),
      path: [
        [19.0245, 47.5071],
        [19.0358, 47.5138],
        [19.0558, 47.5106],
        [19.0634, 47.5052],
        [19.0706, 47.4963],
        [19.0663, 47.4793],
        [19.0468, 47.4773],
      ],
    },
    {
      id: 'tram-1',
      name: '1-es Villamos (Bécsi út – Árpád híd – Hungária krt. – Könyves Kálmán krt. – Kelenföld)',
      h3_index: h3.latLngToCell(47.5398, 19.0542, 8),
      path: [
        [19.0345, 47.5442],
        [19.0542, 47.5398],
        [19.0895, 47.5212],
        [19.1095, 47.4922],
        [19.0991, 47.4754],
        [19.0585, 47.4698],
        [19.0225, 47.4645],
      ],
    },
    {
      id: 'tram-2',
      name: '2-es Villamos (Jászai Mari tér – Lánchíd pesti hídfő – Fővám tér – Boráros tér)',
      h3_index: h3.latLngToCell(47.4981, 19.0402, 8),
      path: [
        [19.0478, 47.5125],
        [19.0465, 47.5015],
        [19.0478, 47.4955],
        [19.0558, 47.4872],
        [19.0663, 47.4793],
      ],
    },
    {
      id: 'tram-17-61',
      name: '17/61-es Villamos (Széll Kálmán tér – Alkotás u. – BAH-csomópont – Móricz Zs. körtér)',
      h3_index: h3.latLngToCell(47.4891, 19.0163, 8),
      path: [
        [19.0245, 47.5071],
        [19.0238, 47.4978],
        [19.0163, 47.4891],
        [19.0315, 47.4812],
        [19.0468, 47.4773],
      ],
    },
  ];

  const rawJunctions: Array<[number, number, string, OsmIntersectionNode['kind']]> = [
    [47.4891, 19.0163, 'BAH-csomópont jelzőlámpás csomópont', 'traffic_signals'],
    [47.5106, 19.0558, 'Nyugati tér főcsomópont', 'traffic_signals'],
    [47.4963, 19.0706, 'Blaha Lujza tér csomópont', 'traffic_signals'],
    [47.4754, 19.0991, 'Népliget / Könyves Kálmán krt. – Üllői út', 'traffic_signals'],
    [47.4981, 19.0402, 'Clark Ádám tér körforgalom', 'junction'],
    [47.5398, 19.0542, 'Árpád híd – Váci út / Róbert Károly krt.', 'traffic_signals'],
    [47.5071, 19.0245, 'Széll Kálmán tér csomópont', 'traffic_signals'],
    [47.4793, 19.0663, 'Boráros tér / Petőfi híd csomópont', 'traffic_signals'],
    [47.4946, 19.0602, 'Astoria csomópont', 'traffic_signals'],
    [47.4773, 19.0468, 'Móricz Zsigmond körtér', 'traffic_signals'],
    [47.5034, 19.1362, 'Örs vezér tere főcsomópont', 'traffic_signals'],
    [47.5004, 19.0819, 'Keleti pályaudvar / Baross tér', 'traffic_signals'],
    [47.5052, 19.0634, 'Oktogon (Nagykörút – Andrássy út)', 'traffic_signals'],
    [47.4897, 19.0618, 'Kálvin tér csomópont', 'traffic_signals'],
    [47.4978, 19.0545, 'Deák Ferenc tér csomópont', 'traffic_signals'],
    [47.5142, 19.0478, 'Jászai Mari tér / Margit híd', 'traffic_signals'],
    [47.5212, 19.0895, 'Kacsóh Pongrác út / Hungária krt.', 'traffic_signals'],
    [47.4922, 19.1095, 'Stadionok / Hungária krt. – Kerepesi út', 'traffic_signals'],
  ];

  const intersections: OsmIntersectionNode[] = rawJunctions.map(
    ([lat, lng, label, kind], idx) => ({
      id: `junc-${idx}`,
      lat,
      lng,
      h3_index: h3.latLngToCell(lat, lng, 8),
      kind,
      label,
    })
  );

  return {
    updated_at: new Date().toISOString(),
    source: 'OSM Budapest Főúthálózat & Villamoshálózat (Alapértelmezett)',
    roads,
    trams,
    intersections,
  };
}

let memoryInfra: BudapestOsmInfrastructure | null = null;

export function readOsmInfrastructure(): BudapestOsmInfrastructure {
  if (memoryInfra) return memoryInfra;
  try {
    if (fs.existsSync(INFRA_STORE_PATH)) {
      const raw = fs.readFileSync(INFRA_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as BudapestOsmInfrastructure;
      if (parsed && Array.isArray(parsed.roads) && parsed.roads.length > 0) {
        memoryInfra = parsed;
        return parsed;
      }
    }
  } catch {
    // Ignore read error
  }
  const def = getDefaultBudapestInfrastructure();
  writeOsmInfrastructure(def);
  return def;
}

export function writeOsmInfrastructure(infra: BudapestOsmInfrastructure): void {
  memoryInfra = infra;
  try {
    const dir = path.dirname(INFRA_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INFRA_STORE_PATH, JSON.stringify(infra, null, 2), 'utf-8');
  } catch {
    // Serverless fallback
  }
}

/**
 * Queries the live OpenStreetMap Overpass API for Budapest major roads (`motorway|trunk|primary`),
 * tram tracks (`railway=tram`), and traffic signals (`highway=traffic_signals`),
 * updates the vector overlay store AND enriches `osm_tram_tracks`, `osm_intersection_count`,
 * and `free_flow_kmh` on the H3 cells!
 */
export async function syncLiveOsmOverpassBudapest(): Promise<{
  infra: BudapestOsmInfrastructure;
  enriched_cells_count: number;
}> {
  const bbox = '47.45,18.99,47.55,19.14'; // Central & Inner-Ring Budapest bbox for fast Overpass response
  const query = `
[out:json][timeout:20];
(
  way["highway"~"trunk|primary"](${bbox});
  way["railway"="tram"](${bbox});
  node["highway"="traffic_signals"](${bbox});
);
out geom 450;
`;

  let infra = getDefaultBudapestInfrastructure();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const elements = Array.isArray(data?.elements) ? data.elements : [];

      const roads: OsmRoadLine[] = [];
      const trams: OsmTramLine[] = [];
      const intersections: OsmIntersectionNode[] = [];

      for (const el of elements) {
        if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
          const pathCoords: [number, number][] = el.geometry.map(
            (pt: { lat: number; lon: number }) => [Number(pt.lon), Number(pt.lat)]
          );
          const mid = el.geometry[Math.floor(el.geometry.length / 2)];
          const h3Idx = h3.latLngToCell(mid.lat, mid.lon, 8);
          const tags = el.tags || {};

          if (tags.railway === 'tram') {
            trams.push({
              id: `osm-tram-${el.id}`,
              name: tags.name || 'OSM Villamossín szakasz',
              h3_index: h3Idx,
              path: pathCoords,
            });
          } else if (tags.highway) {
            const parsedSpeed = parseInt(String(tags.maxspeed || '50'), 10);
            const maxspeed =
              !Number.isNaN(parsedSpeed) && parsedSpeed >= 20 && parsedSpeed <= 130
                ? parsedSpeed
                : tags.highway === 'trunk'
                ? 70
                : 50;

            roads.push({
              id: `osm-road-${el.id}`,
              name: tags.name || `Budapest ${tags.highway} útszakasz`,
              highway: tags.highway,
              maxspeed,
              h3_index: h3Idx,
              path: pathCoords,
            });
          }
        } else if (
          el.type === 'node' &&
          typeof el.lat === 'number' &&
          typeof el.lon === 'number'
        ) {
          const h3Idx = h3.latLngToCell(el.lat, el.lon, 8);
          intersections.push({
            id: `osm-node-${el.id}`,
            lat: el.lat,
            lng: el.lon,
            h3_index: h3Idx,
            kind: 'traffic_signals',
            label: el.tags?.name || 'Jelzőlámpás csomópont (OSM)',
          });
        }
      }

      if (roads.length > 0 || trams.length > 0 || intersections.length > 0) {
        const def = getDefaultBudapestInfrastructure();
        infra = {
          updated_at: new Date().toISOString(),
          source: `OpenStreetMap Overpass API Élő (${roads.length} főút, ${trams.length} villamossín, ${intersections.length} csomópont)`,
          roads: roads.length > 0 ? roads : def.roads,
          trams: trams.length > 0 ? trams : def.trams,
          intersections:
            intersections.length > 0 ? intersections : def.intersections,
        };
      }
    }
  } catch {
    // Keep default enriched Budapest infrastructure if Overpass API times out
    infra = {
      ...getDefaultBudapestInfrastructure(),
      source: 'OSM Budapest Főúthálózat (Overpass gyorsítótár)',
    };
  }

  writeOsmInfrastructure(infra);

  // Enrich H3 cells with the discovered OSM tram tracks, intersection counts, and maxspeed
  const local = readLocalStore();
  const tramH3Set = new Set<string>();
  for (const t of infra.trams) {
    for (const [lng, lat] of t.path) {
      tramH3Set.add(h3.latLngToCell(lat, lng, 8));
    }
  }

  const intersectionCountByH3 = new Map<string, number>();
  for (const node of infra.intersections) {
    intersectionCountByH3.set(
      node.h3_index,
      (intersectionCountByH3.get(node.h3_index) || 0) + 1
    );
  }

  const maxSpeedByH3 = new Map<string, number>();
  for (const r of infra.roads) {
    const prev = maxSpeedByH3.get(r.h3_index) || 0;
    if (r.maxspeed > prev) maxSpeedByH3.set(r.h3_index, r.maxspeed);
  }

  let enrichedCells = 0;
  for (const cell of local.cells) {
    let touched = false;
    if (tramH3Set.has(cell.h3_index)) {
      cell.osm_tram_tracks = 1;
      touched = true;
    }
    if (intersectionCountByH3.has(cell.h3_index)) {
      cell.osm_intersection_count = Math.max(
        cell.osm_intersection_count,
        intersectionCountByH3.get(cell.h3_index)! + 3
      );
      touched = true;
    }
    if (maxSpeedByH3.has(cell.h3_index)) {
      cell.free_flow_kmh = maxSpeedByH3.get(cell.h3_index)!;
      touched = true;
    }
    if (touched) enrichedCells += 1;
  }

  writeLocalStore(local);
  return { infra, enriched_cells_count: enrichedCells };
}

/**
 * Expands the H3 grid across the entire administrative territory of Budapest
 * using `h3.polygonToCells(BUDAPEST_BOUNDARY_LATLNG, 8)` (~950-1,100 contiguous Resolution-8 hexagons).
 */
export async function expandToFullBudapestPolygonGrid(): Promise<{
  total_cells: number;
  new_cells_added: number;
}> {
  const local = readLocalStore();
  const weather = await fetchBudapestWeather();
  const infra = readOsmInfrastructure();

  const existingMap = new Map<string, H3CellRecord>();
  for (const c of local.cells) {
    existingMap.set(c.h3_index, c);
  }

  const tramH3Set = new Set<string>();
  for (const t of infra.trams) {
    for (const [lng, lat] of t.path) {
      tramH3Set.add(h3.latLngToCell(lat, lng, 8));
    }
  }

  const fullPolygonCells = h3.polygonToCells(BUDAPEST_BOUNDARY_LATLNG, 8);
  let newCellsAdded = 0;

  for (const h3Index of fullPolygonCells) {
    if (existingMap.has(h3Index)) continue;
    newCellsAdded += 1;

    const [center_lat, center_lng] = h3.cellToLatLng(h3Index);
    // Distance from central Deák Ferenc tér (47.4979, 19.0545)
    const distKm = Math.hypot(
      (center_lat - 47.4979) * 111.0,
      (center_lng - 19.0545) * 75.0
    );

    const hasTram = tramH3Set.has(h3Index) ? 1 : 0;
    const isInnerDistrict = distKm <= 4.5;
    const free_flow_kmh = distKm > 7.5 ? 70 : isInnerDistrict ? 50 : 60;
    const osm_intersection_count = isInnerDistrict ? 7 : distKm <= 8 ? 5 : 3;
    const total_accidents = isInnerDistrict ? 6 : distKm <= 8 ? 3 : 1;
    const wet_accidents = hasTram ? Math.ceil(total_accidents * 0.35) : 0;

    const zoneName =
      distKm <= 3.0
        ? 'Budapest Belvárosi Zóna'
        : distKm <= 6.5
        ? 'Budapest Átmeneti Főúthálózat'
        : 'Budapest Külső Kerületi Zóna';

    existingMap.set(h3Index, {
      h3_index: h3Index,
      resolution: 8,
      center_lat: Number(center_lat.toFixed(6)),
      center_lng: Number(center_lng.toFixed(6)),
      label: zoneName,
      free_flow_kmh,
      osm_tram_tracks: hasTram,
      osm_intersection_count,
      total_accidents,
      wet_accidents,
      hist_accident_density: 0.08,
      hist_wet_accident_ratio: Number(
        (wet_accidents / Math.max(1, total_accidents)).toFixed(4)
      ),
      risk_score: 0.12,
      bkk_vehicle_count: isInnerDistrict ? 5 : 2,
      bkk_avg_speed: Number((free_flow_kmh * 0.82).toFixed(1)),
      bkk_speed_std: isInnerDistrict ? 5.5 : 3.2,
      neighbor_speed_ratio: 0.85,
      top_risk_factor: 'Normál forgalmi alapzaj',
      updated_at: new Date().toISOString(),
    });
  }

  const allCells = Array.from(existingMap.values());
  const maxAcc = Math.max(1, ...allCells.map((c) => c.total_accidents));
  const neighborRatios = computeNeighborSpeedRatios(allCells);

  for (const cell of allCells) {
    cell.hist_accident_density = Number((cell.total_accidents / maxAcc).toFixed(4));
    cell.neighbor_speed_ratio = neighborRatios.get(cell.h3_index) ?? 0.85;
    const vec = buildCellFeatureVector(cell, weather);
    cell.risk_score = predictCalibratedRiskFromFeatures(vec);
    cell.top_risk_factor = determineTopRiskFactor(cell, weather);
  }

  allCells.sort((a, b) => b.risk_score - a.risk_score);
  local.cells = allCells;
  writeLocalStore(local);

  const supabase = getSupabaseClient();
  if (supabase && isSupabaseConfigured()) {
    try {
      await supabase.from('h3_grid').upsert(allCells, { onConflict: 'h3_index' });
    } catch {
      // Ignore Supabase bulk limit error
    }
  }

  return {
    total_cells: allCells.length,
    new_cells_added: newCellsAdded,
  };
}

