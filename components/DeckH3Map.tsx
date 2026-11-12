'use client';

import React, { useState, useMemo, useCallback } from 'react';
import MapComponent, { NavigationControl, useControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as h3 from 'h3-js';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import {
  PolygonLayer,
  TextLayer,
  PathLayer,
  ScatterplotLayer,
} from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import type { H3CellRecord } from '@/lib/feature-engineering';
import type {
  BudapestOsmInfrastructure,
  OsmRoadLine,
  OsmTramLine,
  OsmIntersectionNode,
} from '@/lib/osm-overpass';
import {
  Layers,
  Box,
  Compass,
  Hash,
  Route,
  TrainTrack,
  GitFork,
} from 'lucide-react';

const CARTO_DARK_MATTER =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

function DeckGLOverlay(props: { layers: unknown[] }) {
  const overlay = useControl<MapboxOverlay>(
    () => new MapboxOverlay({ interleaved: false })
  );
  overlay.setProps({ layers: props.layers as never[] });
  return null;
}

export function riskToRgba(
  risk: number,
  isSelected: boolean
): [number, number, number, number] {
  const alpha = isSelected ? 240 : 185;
  if (risk >= 0.65) return [239, 68, 68, alpha]; // Critical Red
  if (risk >= 0.45) return [249, 115, 22, alpha]; // High Orange
  if (risk >= 0.25) return [234, 179, 8, alpha]; // Elevated Amber
  return [16, 185, 129, alpha]; // Low Emerald
}

interface DeckH3MapProps {
  cells: H3CellRecord[];
  infrastructure?: BudapestOsmInfrastructure | null;
  selectedCell: H3CellRecord | null;
  onSelectCell: (cell: H3CellRecord | null) => void;
  extruded3D: boolean;
  onToggle3D: () => void;
}

export default function DeckH3Map({
  cells,
  infrastructure,
  selectedCell,
  onSelectCell,
  extruded3D,
  onToggle3D,
}: DeckH3MapProps) {
  const [viewState, setViewState] = useState({
    longitude: 19.054,
    latitude: 47.498,
    zoom: 12.4,
    pitch: extruded3D ? 45 : 0,
    bearing: extruded3D ? -10 : 0,
  });

  const [showRiskLabels, setShowRiskLabels] = useState<boolean>(true);
  const [showRoadNetwork, setShowRoadNetwork] = useState<boolean>(true);
  const [showTramNetwork, setShowTramNetwork] = useState<boolean>(true);
  const [showIntersections, setShowIntersections] = useState<boolean>(true);

  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    object: H3CellRecord;
  } | null>(null);

  const handleToggleExtrusion = useCallback(() => {
    const next3D = !extruded3D;
    onToggle3D();
    setViewState((prev) => ({
      ...prev,
      pitch: next3D ? 45 : 0,
      bearing: next3D ? -10 : 0,
    }));
  }, [extruded3D, onToggle3D]);

  const resetCamera = useCallback(() => {
    setViewState({
      longitude: 19.054,
      latitude: 47.498,
      zoom: 12.4,
      pitch: extruded3D ? 45 : 0,
      bearing: extruded3D ? -10 : 0,
    });
  }, [extruded3D]);

  // Lookup map from h3_index -> cell risk/speed for dynamic road & intersection coloring
  const cellLookup = useMemo(() => {
    const map = new Map<string, H3CellRecord>();
    for (const c of cells) {
      map.set(c.h3_index, c);
    }
    return map;
  }, [cells]);

  const cellsWithBoundaries = useMemo(() => {
    return cells.map((cell) => {
      let polygon: [number, number][] = [];
      try {
        polygon = h3.cellToBoundary(cell.h3_index, true) as [number, number][];
      } catch {
        polygon = [];
      }
      return {
        ...cell,
        polygon,
      };
    });
  }, [cells]);

  const labelCells = useMemo(() => {
    if (!showRiskLabels) return [];
    if (viewState.zoom >= 12.3 && cellsWithBoundaries.length <= 380) {
      return cellsWithBoundaries;
    }
    return cellsWithBoundaries.filter(
      (c, idx) =>
        idx < 45 ||
        c.risk_score >= 0.35 ||
        c.h3_index === selectedCell?.h3_index
    );
  }, [cellsWithBoundaries, showRiskLabels, viewState.zoom, selectedCell]);

  const layers = useMemo(() => {
    const activeLayers: unknown[] = [
      new H3HexagonLayer<H3CellRecord>({
        id: 'budapest-h3-risk-layer',
        data: cells,
        pickable: true,
        wireframe: extruded3D,
        filled: true,
        extruded: extruded3D,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) =>
          riskToRgba(d.risk_score, selectedCell?.h3_index === d.h3_index),
        getLineColor: (d) =>
          selectedCell?.h3_index === d.h3_index
            ? [255, 255, 255, 255]
            : [15, 23, 42, 180],
        lineWidthMinPixels: 1.5,
        getElevation: (d) => (extruded3D ? Math.max(25, d.risk_score * 850) : 0),
        elevationScale: 1,
        updateTriggers: {
          getFillColor: [selectedCell?.h3_index, cells],
          getLineColor: [selectedCell?.h3_index],
          getElevation: [extruded3D, cells],
        },
        onHover: (info: PickingInfo) => {
          if (info.object) {
            setHoverInfo({
              x: info.x,
              y: info.y,
              object: info.object as H3CellRecord,
            });
          } else {
            setHoverInfo(null);
          }
        },
        onClick: (info: PickingInfo) => {
          if (info.object) {
            const cell = info.object as H3CellRecord;
            onSelectCell(cell);
            setViewState((prev) => ({
              ...prev,
              longitude: cell.center_lng,
              latitude: cell.center_lat,
              zoom: Math.max(prev.zoom, 13.2),
            }));
          }
        },
      }),
      new PolygonLayer<(typeof cellsWithBoundaries)[number]>({
        id: 'budapest-h3-polygon-fallback-layer',
        data: cellsWithBoundaries,
        pickable: true,
        stroked: true,
        filled: true,
        wireframe: extruded3D,
        extruded: extruded3D,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) =>
          riskToRgba(d.risk_score, selectedCell?.h3_index === d.h3_index),
        getLineColor: (d) =>
          selectedCell?.h3_index === d.h3_index
            ? [255, 255, 255, 255]
            : [15, 23, 42, 195],
        lineWidthMinPixels: 1.5,
        getElevation: (d) => (extruded3D ? Math.max(25, d.risk_score * 850) : 0),
        elevationScale: 1,
        updateTriggers: {
          getFillColor: [selectedCell?.h3_index, cellsWithBoundaries],
          getLineColor: [selectedCell?.h3_index],
          getElevation: [extruded3D, cellsWithBoundaries],
        },
        onHover: (info: PickingInfo) => {
          if (info.object) {
            setHoverInfo({
              x: info.x,
              y: info.y,
              object: info.object as H3CellRecord,
            });
          } else {
            setHoverInfo(null);
          }
        },
        onClick: (info: PickingInfo) => {
          if (info.object) {
            const cell = info.object as H3CellRecord;
            onSelectCell(cell);
            setViewState((prev) => ({
              ...prev,
              longitude: cell.center_lng,
              latitude: cell.center_lat,
              zoom: Math.max(prev.zoom, 13.2),
            }));
          }
        },
      }),
    ];

    // 1. OSM Road Network LineStrings colored by BKK speed / H3 risk
    if (showRoadNetwork && infrastructure?.roads?.length) {
      activeLayers.push(
        new PathLayer<OsmRoadLine>({
          id: 'budapest-osm-roads-layer',
          data: infrastructure.roads,
          pickable: false,
          widthScale: 1,
          widthMinPixels: 3,
          widthMaxPixels: 7,
          jointRounded: true,
          capRounded: true,
          getPath: (d) => d.path,
          getWidth: (d) => (d.highway === 'trunk' ? 5 : 3.5),
          getColor: (d) => {
            const cell = cellLookup.get(d.h3_index);
            const risk = cell?.risk_score ?? 0.25;
            if (risk >= 0.65) return [248, 113, 113, 235]; // Red congested/high-risk road
            if (risk >= 0.45) return [251, 146, 60, 230]; // Orange road
            return [56, 189, 248, 215]; // Cyan-blue free-flowing arterial
          },
          updateTriggers: {
            getColor: [cells],
          },
        })
      );
    }

    // 2. OSM Tram Tracks (`railway=tram`) highlighted in bright gold/cyan
    if (showTramNetwork && infrastructure?.trams?.length) {
      activeLayers.push(
        new PathLayer<OsmTramLine>({
          id: 'budapest-osm-trams-layer',
          data: infrastructure.trams,
          pickable: false,
          widthScale: 1,
          widthMinPixels: 2.5,
          widthMaxPixels: 5,
          jointRounded: true,
          capRounded: true,
          getPath: (d) => d.path,
          getWidth: 3,
          getColor: [250, 204, 21, 245], // Tram yellow
        })
      );
    }

    // 3. OSM Intersections & Traffic Signals (`ScatterplotLayer`)
    if (showIntersections && infrastructure?.intersections?.length) {
      activeLayers.push(
        new ScatterplotLayer<OsmIntersectionNode>({
          id: 'budapest-osm-intersections-layer',
          data: infrastructure.intersections,
          pickable: false,
          filled: true,
          stroked: true,
          radiusMinPixels: 4.5,
          radiusMaxPixels: 9,
          lineWidthMinPixels: 1.5,
          getPosition: (d) => [
            d.lng,
            d.lat,
            extruded3D
              ? Math.max(30, (cellLookup.get(d.h3_index)?.risk_score ?? 0.2) * 850 + 12)
              : 4,
          ],
          getRadius: 35,
          getFillColor: (d) => {
            const risk = cellLookup.get(d.h3_index)?.risk_score ?? 0.3;
            return risk >= 0.55
              ? [239, 68, 68, 255]
              : [255, 255, 255, 240];
          },
          getLineColor: [14, 165, 233, 255],
          updateTriggers: {
            getPosition: [extruded3D, cells],
            getFillColor: [cells],
          },
        })
      );
    }

    // 4. Risk Percentage Value Labels on Hexagons (`TextLayer`)
    if (showRiskLabels && labelCells.length > 0) {
      activeLayers.push(
        new TextLayer<(typeof cellsWithBoundaries)[number]>({
          id: 'budapest-h3-risk-value-labels',
          data: labelCells,
          pickable: false,
          getPosition: (d) => [
            d.center_lng,
            d.center_lat,
            extruded3D ? Math.max(25, d.risk_score * 850) + 22 : 8,
          ],
          getText: (d) => `${Math.round(d.risk_score * 100)}%`,
          getSize: (d) =>
            selectedCell?.h3_index === d.h3_index || d.risk_score >= 0.45 ? 13 : 11,
          getColor: [255, 255, 255, 245],
          fontWeight: 'bold',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          background: true,
          getBackgroundColor: (d) =>
            d.risk_score >= 0.65
              ? [127, 29, 29, 220]
              : d.risk_score >= 0.45
              ? [124, 45, 18, 220]
              : d.risk_score >= 0.25
              ? [113, 63, 18, 210]
              : [6, 78, 59, 200],
          backgroundPadding: [4, 2],
          updateTriggers: {
            getPosition: [extruded3D, labelCells],
            getText: [labelCells],
            getSize: [selectedCell?.h3_index, labelCells],
            getBackgroundColor: [labelCells],
          },
        })
      );
    }

    return activeLayers;
  }, [
    cells,
    cellsWithBoundaries,
    cellLookup,
    infrastructure,
    labelCells,
    extruded3D,
    selectedCell,
    showRiskLabels,
    showRoadNetwork,
    showTramNetwork,
    showIntersections,
    onSelectCell,
  ]);

  return (
    <div className="relative w-full h-full bg-[#090d16] overflow-hidden select-none">
      <MapComponent
        {...viewState}
        onMove={(evt: { viewState: typeof viewState }) =>
          setViewState(evt.viewState)
        }
        mapStyle={CARTO_DARK_MATTER}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckGLOverlay layers={layers} />
        <NavigationControl position="bottom-right" />
      </MapComponent>

      {/* Top-Left Floating Layer & View Controls */}
      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-2 max-w-[92%]">
        <button
          onClick={handleToggleExtrusion}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            extruded3D
              ? 'bg-indigo-600/90 border-indigo-400 text-white'
              : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:bg-slate-800'
          }`}
        >
          {extruded3D ? <Box className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
          <span>{extruded3D ? '3D Extrudált' : '2D Sík'}</span>
        </button>

        <button
          onClick={() => setShowRiskLabels((prev) => !prev)}
          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            showRiskLabels
              ? 'bg-emerald-600/90 border-emerald-400 text-white'
              : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Hash className="w-3.5 h-3.5" />
          <span>% Értékek</span>
        </button>

        <button
          onClick={() => setShowRoadNetwork((prev) => !prev)}
          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            showRoadNetwork
              ? 'bg-sky-600/90 border-sky-400 text-white'
              : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
          title="OSM főúthálózat színezése kockázat és BKK sebesség szerint"
        >
          <Route className="w-3.5 h-3.5" />
          <span>Főutak ({infrastructure?.roads?.length ?? 0})</span>
        </button>

        <button
          onClick={() => setShowTramNetwork((prev) => !prev)}
          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            showTramNetwork
              ? 'bg-amber-500/90 border-amber-300 text-slate-950'
              : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
          title="OSM villamossínek (railway=tram)"
        >
          <TrainTrack className="w-3.5 h-3.5" />
          <span>Villamossínek ({infrastructure?.trams?.length ?? 0})</span>
        </button>

        <button
          onClick={() => setShowIntersections((prev) => !prev)}
          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            showIntersections
              ? 'bg-cyan-600/90 border-cyan-400 text-white'
              : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
          title="OSM jelzőlámpás csomópontok (highway=traffic_signals)"
        >
          <GitFork className="w-3.5 h-3.5" />
          <span>Csomópontok ({infrastructure?.intersections?.length ?? 0})</span>
        </button>

        <button
          onClick={resetCamera}
          className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 backdrop-blur-md shadow-lg transition"
          title="Budapest középpont visszaállítása"
        >
          <Compass className="w-4 h-4 text-sky-400" />
          <span>Centrum</span>
        </button>
      </div>

      {/* Bottom-Left Risk & Infrastructure Legend */}
      <div className="absolute bottom-5 left-4 z-10 bg-slate-900/90 border border-slate-800 backdrop-blur-md rounded-xl p-3 shadow-xl text-xs space-y-2">
        <div className="font-semibold text-slate-300 flex items-center justify-between gap-4">
          <span>Baleseti Kockázat &amp; OSM Infrastruktúra</span>
          <span className="text-[10px] font-mono text-slate-400">
            {cells.length} H3 Res-8 hex
          </span>
        </div>
        <div className="grid grid-cols-2 sm:flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" />
            <span className="text-slate-300">&lt; 25%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-yellow-500 inline-block" />
            <span className="text-slate-300">25–45%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-orange-500 inline-block" />
            <span className="text-slate-300">45–65%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-500 inline-block" />
            <span className="text-slate-300">&ge; 65%</span>
          </div>
          <div className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
            <span className="w-3 h-1 bg-yellow-400 inline-block rounded" />
            <span className="text-amber-300">Villamos</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-white border border-sky-400 inline-block" />
            <span className="text-cyan-300">Csomópont</span>
          </div>
        </div>
      </div>

      {/* Hover Tooltip */}
      {hoverInfo && hoverInfo.object && (
        <div
          className="pointer-events-none absolute z-20 w-72 bg-slate-950/95 border border-slate-700/90 rounded-xl p-3.5 shadow-2xl text-xs backdrop-blur-md"
          style={{
            left: Math.min(
              hoverInfo.x + 14,
              typeof window !== 'undefined'
                ? window.innerWidth - 300
                : hoverInfo.x + 14
            ),
            top: Math.max(hoverInfo.y - 20, 12),
          }}
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
            <div>
              <p className="font-semibold text-white text-sm leading-tight">
                {hoverInfo.object.label}
              </p>
              <p className="font-mono text-[10px] text-sky-400 mt-0.5">
                H3: {hoverInfo.object.h3_index}
              </p>
            </div>
            <div
              className={`px-2 py-1 rounded-md font-bold text-xs ${
                hoverInfo.object.risk_score >= 0.65
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                  : hoverInfo.object.risk_score >= 0.45
                  ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
                  : hoverInfo.object.risk_score >= 0.25
                  ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/40'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
              }`}
            >
              {(hoverInfo.object.risk_score * 100).toFixed(1)}%
            </div>
          </div>

          <div className="space-y-1 text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-400">Fő kockázati tényező:</span>
              <span className="font-medium text-amber-300 text-right max-w-[155px] truncate">
                {hoverInfo.object.top_risk_factor}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">BKK átlagsebesség:</span>
              <span className="font-mono">
                {hoverInfo.object.bkk_avg_speed} / {hoverInfo.object.free_flow_kmh} km/h
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Sebesség szórás (Shockwave):</span>
              <span className="font-mono">±{hoverInfo.object.bkk_speed_std} km/h</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">OSM Csomópont / Villamos:</span>
              <span className="font-mono">
                {hoverInfo.object.osm_intersection_count} db /{' '}
                {hoverInfo.object.osm_tram_tracks ? 'Igen' : 'Nem'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Historikus balesetek:</span>
              <span className="font-mono">
                {hoverInfo.object.total_accidents} db (nedves: {hoverInfo.object.wet_accidents})
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
