'use client';

import React, { useState, useMemo, useCallback } from 'react';
import MapComponent, { NavigationControl, useControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as h3 from 'h3-js';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
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
  Flame,
  Hexagon,
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

/**
 * Refined, softer RGBA palette for H3 hexagons with configurable opacity.
 */
export function riskToRgba(
  risk: number,
  isSelected: boolean,
  baseOpacity: number = 0.42
): [number, number, number, number] {
  const alpha = isSelected
    ? 220
    : Math.round(Math.min(240, Math.max(15, baseOpacity * 255)));
  if (risk >= 0.65) return [239, 68, 68, alpha]; // Critical Red
  if (risk >= 0.45) return [249, 115, 22, alpha]; // High Orange
  if (risk >= 0.25) return [234, 179, 8, alpha]; // Elevated Amber
  return [16, 185, 129, alpha]; // Low Emerald
}

const HEATMAP_COLOR_RANGE: [number, number, number, number][] = [
  [16, 185, 129, 15],   // Subtle Emerald ambient glow
  [52, 211, 153, 55],   // Soft Teal transition
  [250, 204, 21, 95],   // Translucent Amber-Yellow
  [251, 146, 60, 125],  // Soft Orange
  [239, 68, 68, 150],   // Translucent High-Risk Red (streets stay visible underneath!)
  [185, 28, 28, 175],   // Translucent Crimson Core
];

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
  // Default to Heatmap ON and subtle/toggleable Hexagons OFF (or subtle overlay) per user preference
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);
  const [showHexagons, setShowHexagons] = useState<boolean>(false);
  const [hexOpacity, setHexOpacity] = useState<number>(0.38);
  const [heatmapRadius, setHeatmapRadius] = useState<number>(115);

  const [viewState, setViewState] = useState({
    longitude: 19.054,
    latitude: 47.498,
    zoom: 12.4,
    pitch: 0,
    bearing: 0,
  });

  const [showRiskLabels, setShowRiskLabels] = useState<boolean>(false);
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
    if (next3D && !showHexagons) {
      setShowHexagons(true);
    }
    setViewState((prev) => ({
      ...prev,
      pitch: next3D ? 45 : 0,
      bearing: next3D ? -10 : 0,
    }));
  }, [extruded3D, showHexagons, onToggle3D]);

  const resetCamera = useCallback(() => {
    setViewState({
      longitude: 19.054,
      latitude: 47.498,
      zoom: 12.4,
      pitch: extruded3D && showHexagons ? 45 : 0,
      bearing: extruded3D && showHexagons ? -10 : 0,
    });
  }, [extruded3D, showHexagons]);

  const cellLookup = useMemo(() => {
    const map = new Map<string, H3CellRecord>();
    for (const c of cells) {
      map.set(c.h3_index, c);
    }
    return map;
  }, [cells]);

  // Shrink polygon vertices slightly toward center (coverage = 0.88) for a sleek, refined gap between hexagons
  const cellsWithBoundaries = useMemo(() => {
    const coverage = 0.88;
    return cells.map((cell) => {
      let polygon: [number, number][] = [];
      try {
        const rawBoundary = h3.cellToBoundary(cell.h3_index, true) as [
          number,
          number
        ][];
        polygon = rawBoundary.map(([lng, lat]) => [
          cell.center_lng + (lng - cell.center_lng) * coverage,
          cell.center_lat + (lat - cell.center_lat) * coverage,
        ]);
      } catch {
        polygon = [];
      }
      return {
        ...cell,
        polygon,
      };
    });
  }, [cells]);

  // Sub-sample 19 points per H3 hexagon (center + 6 mid-ring + 6 vertices + 6 edge midpoints)
  // so even when deeply zoomed in (zoom 14–16), adjacent cells form a completely seamless, silky-smooth surface!
  const smoothedHeatmapPoints = useMemo(() => {
    const pts: Array<{ position: [number, number]; weight: number }> = [];
    for (const cell of cellsWithBoundaries) {
      const baseWeight = Math.max(0.05, cell.risk_score);
      // 1. Center point
      pts.push({
        position: [cell.center_lng, cell.center_lat],
        weight: baseWeight,
      });

      const poly = cell.polygon;
      for (let i = 0; i < poly.length; i++) {
        const [vLng, vLat] = poly[i];
        const [nextLng, nextLat] = poly[(i + 1) % poly.length];

        // 2. Inner mid-ring point (50% from center to vertex)
        pts.push({
          position: [
            (cell.center_lng + vLng) * 0.5,
            (cell.center_lat + vLat) * 0.5,
          ],
          weight: baseWeight * 0.9,
        });

        // 3. Outer vertex point
        pts.push({
          position: [vLng, vLat],
          weight: baseWeight * 0.75,
        });

        // 4. Outer edge midpoint
        pts.push({
          position: [(vLng + nextLng) * 0.5, (vLat + nextLat) * 0.5],
          weight: baseWeight * 0.75,
        });
      }
    }
    return pts;
  }, [cellsWithBoundaries]);

  // Automatically scale heatmap pixel radius with zoom so it stays connected when zooming in,
  // and fade intensity slightly at street level (zoom >= 14) so street names & buildings remain crisp.
  const effectiveHeatmapRadius = useMemo(() => {
    const zoomDelta = Math.max(0, viewState.zoom - 12.2);
    return Math.round(
      Math.min(260, heatmapRadius * Math.pow(1.26, Math.min(3.5, zoomDelta)))
    );
  }, [heatmapRadius, viewState.zoom]);

  const effectiveHeatmapIntensity = useMemo(() => {
    if (viewState.zoom >= 14.5) return 0.55;
    if (viewState.zoom >= 13.5) return 0.68;
    return 0.82;
  }, [viewState.zoom]);

  const labelCells = useMemo(() => {
    if (!showRiskLabels) return [];
    if (viewState.zoom >= 12.6 && cellsWithBoundaries.length <= 380) {
      return cellsWithBoundaries;
    }
    return cellsWithBoundaries.filter(
      (c, idx) =>
        idx < 25 ||
        c.risk_score >= 0.45 ||
        c.h3_index === selectedCell?.h3_index
    );
  }, [cellsWithBoundaries, showRiskLabels, viewState.zoom, selectedCell]);

  const layers = useMemo(() => {
    const activeLayers: unknown[] = [];

    // 1. Smooth Continuous Risk Heatmap Layer (MEAN aggregation + zoom-adaptive radius prevents spotty blobs on zoom-in)
    if (showHeatmap && smoothedHeatmapPoints.length > 0) {
      activeLayers.push(
        new HeatmapLayer<(typeof smoothedHeatmapPoints)[number]>({
          id: 'budapest-risk-heatmap-layer',
          data: smoothedHeatmapPoints,
          pickable: false,
          getPosition: (d) => d.position,
          getWeight: (d) => d.weight,
          radiusPixels: effectiveHeatmapRadius,
          intensity: effectiveHeatmapIntensity,
          threshold: 0.02,
          colorRange: HEATMAP_COLOR_RANGE,
          aggregation: 'MEAN',
          weightsTextureSize: 512,
          updateTriggers: {
            getWeight: [smoothedHeatmapPoints],
          },
        })
      );
    }

    // 2. Invisible or Visible Interactive H3 Hexagon Pick Layer
    // Even when showHexagons is OFF (Heatmap-only mode), we keep a nearly-transparent pickable polygon layer
    // so hovering & clicking on the Heatmap still shows the exact H3 cell tooltip & selects the zone!
    const effectiveExtruded = showHexagons && extruded3D;

    if (showHexagons) {
      activeLayers.push(
        new H3HexagonLayer<H3CellRecord>({
          id: 'budapest-h3-risk-layer',
          data: cells,
          pickable: true,
          wireframe: effectiveExtruded,
          filled: true,
          extruded: effectiveExtruded,
          coverage: 0.88,
          getHexagon: (d) => d.h3_index,
          getFillColor: (d) =>
            riskToRgba(
              d.risk_score,
              selectedCell?.h3_index === d.h3_index,
              hexOpacity
            ),
          getLineColor: (d) =>
            selectedCell?.h3_index === d.h3_index
              ? [255, 255, 255, 240]
              : [148, 163, 184, 70],
          lineWidthMinPixels: 1,
          getElevation: (d) =>
            effectiveExtruded ? Math.max(18, d.risk_score * 650) : 0,
          elevationScale: 1,
          updateTriggers: {
            getFillColor: [selectedCell?.h3_index, hexOpacity, cells],
            getLineColor: [selectedCell?.h3_index],
            getElevation: [effectiveExtruded, cells],
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
        })
      );
    }

    activeLayers.push(
      new PolygonLayer<(typeof cellsWithBoundaries)[number]>({
        id: 'budapest-h3-interactive-polygon-layer',
        data: cellsWithBoundaries,
        pickable: true,
        stroked: showHexagons || Boolean(selectedCell),
        filled: true,
        wireframe: effectiveExtruded,
        extruded: effectiveExtruded,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => {
          const isSel = selectedCell?.h3_index === d.h3_index;
          if (!showHexagons) {
            // In Heatmap mode: invisible fill unless selected, so hover/click works seamlessly over the heatmap
            return isSel ? [255, 255, 255, 45] : [0, 0, 0, 1];
          }
          return riskToRgba(d.risk_score, isSel, hexOpacity);
        },
        getLineColor: (d) => {
          const isSel = selectedCell?.h3_index === d.h3_index;
          if (isSel) return [255, 255, 255, 235];
          return showHexagons ? [148, 163, 184, 80] : [0, 0, 0, 0];
        },
        lineWidthMinPixels: 1,
        getElevation: (d) =>
          effectiveExtruded ? Math.max(18, d.risk_score * 650) : 0,
        elevationScale: 1,
        updateTriggers: {
          getFillColor: [
            showHexagons,
            hexOpacity,
            selectedCell?.h3_index,
            cellsWithBoundaries,
          ],
          getLineColor: [showHexagons, selectedCell?.h3_index],
          getElevation: [effectiveExtruded, cellsWithBoundaries],
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
      })
    );

    // 3. OSM Road Network LineStrings colored by BKK speed / H3 risk
    if (showRoadNetwork && infrastructure?.roads?.length) {
      activeLayers.push(
        new PathLayer<OsmRoadLine>({
          id: 'budapest-osm-roads-layer',
          data: infrastructure.roads,
          pickable: false,
          widthScale: 1,
          widthMinPixels: 2.5,
          widthMaxPixels: 6,
          jointRounded: true,
          capRounded: true,
          getPath: (d) => d.path,
          getWidth: (d) => (d.highway === 'trunk' ? 4.5 : 3),
          getColor: (d) => {
            const cell = cellLookup.get(d.h3_index);
            const risk = cell?.risk_score ?? 0.25;
            if (risk >= 0.65) return [248, 113, 113, 220];
            if (risk >= 0.45) return [251, 146, 60, 210];
            return [56, 189, 248, 185];
          },
          updateTriggers: {
            getColor: [cells],
          },
        })
      );
    }

    // 4. OSM Tram Tracks (`railway=tram`)
    if (showTramNetwork && infrastructure?.trams?.length) {
      activeLayers.push(
        new PathLayer<OsmTramLine>({
          id: 'budapest-osm-trams-layer',
          data: infrastructure.trams,
          pickable: false,
          widthScale: 1,
          widthMinPixels: 2,
          widthMaxPixels: 4.5,
          jointRounded: true,
          capRounded: true,
          getPath: (d) => d.path,
          getWidth: 2.5,
          getColor: [250, 204, 21, 225],
        })
      );
    }

    // 5. OSM Intersections & Traffic Signals (`ScatterplotLayer`)
    if (showIntersections && infrastructure?.intersections?.length) {
      activeLayers.push(
        new ScatterplotLayer<OsmIntersectionNode>({
          id: 'budapest-osm-intersections-layer',
          data: infrastructure.intersections,
          pickable: false,
          filled: true,
          stroked: true,
          radiusMinPixels: 4,
          radiusMaxPixels: 8,
          lineWidthMinPixels: 1.5,
          getPosition: (d) => [
            d.lng,
            d.lat,
            effectiveExtruded
              ? Math.max(
                  24,
                  (cellLookup.get(d.h3_index)?.risk_score ?? 0.2) * 650 + 10
                )
              : 4,
          ],
          getRadius: 30,
          getFillColor: (d) => {
            const risk = cellLookup.get(d.h3_index)?.risk_score ?? 0.3;
            return risk >= 0.55
              ? [239, 68, 68, 245]
              : [255, 255, 255, 230];
          },
          getLineColor: [14, 165, 233, 245],
          updateTriggers: {
            getPosition: [effectiveExtruded, cells],
            getFillColor: [cells],
          },
        })
      );
    }

    // 6. Optional Risk Percentage Labels (`TextLayer`)
    if (showRiskLabels && labelCells.length > 0) {
      activeLayers.push(
        new TextLayer<(typeof cellsWithBoundaries)[number]>({
          id: 'budapest-h3-risk-value-labels',
          data: labelCells,
          pickable: false,
          getPosition: (d) => [
            d.center_lng,
            d.center_lat,
            effectiveExtruded ? Math.max(20, d.risk_score * 650) + 18 : 8,
          ],
          getText: (d) => `${Math.round(d.risk_score * 100)}%`,
          getSize: (d) =>
            selectedCell?.h3_index === d.h3_index || d.risk_score >= 0.45 ? 12 : 10,
          getColor: [255, 255, 255, 240],
          fontWeight: 'bold',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          background: true,
          getBackgroundColor: (d) =>
            d.risk_score >= 0.65
              ? [127, 29, 29, 200]
              : d.risk_score >= 0.45
              ? [124, 45, 18, 200]
              : d.risk_score >= 0.25
              ? [113, 63, 18, 190]
              : [6, 78, 59, 180],
          backgroundPadding: [3, 1.5],
          updateTriggers: {
            getPosition: [effectiveExtruded, labelCells],
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
    smoothedHeatmapPoints,
    effectiveHeatmapRadius,
    effectiveHeatmapIntensity,
    cellLookup,
    infrastructure,
    labelCells,
    showHeatmap,
    showHexagons,
    hexOpacity,
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
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 max-w-[94%]">
        <div className="flex flex-wrap items-center gap-2">
          {/* Heatmap Toggle (Default Active) */}
          <button
            onClick={() => setShowHeatmap((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
              showHeatmap
                ? 'bg-rose-600/95 border-rose-400 text-white'
                : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            title="Folytonos baleseti kockázati hőtérkép (Heatmap) be/kikapcsolása"
          >
            <Flame className="w-4 h-4" />
            <span>Kockázati Heatmap</span>
          </button>

          {/* H3 Hexagon Grid Toggle */}
          <button
            onClick={() => setShowHexagons((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
              showHexagons
                ? 'bg-indigo-600/90 border-indigo-400 text-white'
                : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            title="Finomított Uber H3 Res-8 hexagon rács be/kikapcsolása"
          >
            <Hexagon className="w-4 h-4" />
            <span>H3 Hexagon Rács {showHexagons ? '(Be)' : '(Ki)'}</span>
          </button>

          {/* 3D Extrusion Toggle (when Hexagons enabled) */}
          {showHexagons && (
            <button
              onClick={handleToggleExtrusion}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
                extruded3D
                  ? 'bg-violet-600/90 border-violet-400 text-white'
                  : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:bg-slate-800'
              }`}
            >
              {extruded3D ? <Box className="w-3.5 h-3.5" /> : <Layers className="w-3.5 h-3.5" />}
              <span>{extruded3D ? '3D Oszlopok' : '2D Sík'}</span>
            </button>
          )}

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
          >
            <Route className="w-3.5 h-3.5" />
            <span>Főutak</span>
          </button>

          <button
            onClick={() => setShowTramNetwork((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
              showTramNetwork
                ? 'bg-amber-500/90 border-amber-300 text-slate-950'
                : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <TrainTrack className="w-3.5 h-3.5" />
            <span>Villamos</span>
          </button>

          <button
            onClick={() => setShowIntersections((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
              showIntersections
                ? 'bg-cyan-600/90 border-cyan-400 text-white'
                : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <GitFork className="w-3.5 h-3.5" />
            <span>Csomópontok</span>
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

        {/* Compact Sliders for Heatmap Radius & Hexagon Opacity */}
        <div className="flex flex-wrap items-center gap-4 bg-slate-900/85 border border-slate-800/90 backdrop-blur-md px-3.5 py-2 rounded-xl text-[11px] text-slate-300 shadow-lg w-fit">
          {showHeatmap && (
            <div className="flex items-center gap-2">
              <span className="text-rose-300 font-medium">Heatmap összemosás:</span>
              <input
                type="range"
                min={50}
                max={180}
                step={5}
                value={heatmapRadius}
                onChange={(e) => setHeatmapRadius(parseInt(e.target.value, 10))}
                className="w-24 accent-rose-500 cursor-pointer h-1 bg-slate-700 rounded-lg"
              />
              <span className="font-mono text-slate-400">{heatmapRadius}px</span>
            </div>
          )}

          {showHexagons && (
            <div className="flex items-center gap-2">
              <span className="text-indigo-300 font-medium">Hexagon áttetszőség:</span>
              <input
                type="range"
                min={0.12}
                max={0.85}
                step={0.05}
                value={hexOpacity}
                onChange={(e) => setHexOpacity(parseFloat(e.target.value))}
                className="w-20 accent-indigo-500 cursor-pointer h-1 bg-slate-700 rounded-lg"
              />
              <span className="font-mono text-slate-400">
                {Math.round(hexOpacity * 100)}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom-Left Risk & Infrastructure Legend */}
      <div className="absolute bottom-5 left-4 z-10 bg-slate-900/90 border border-slate-800 backdrop-blur-md rounded-xl p-3 shadow-xl text-xs space-y-2">
        <div className="font-semibold text-slate-300 flex items-center justify-between gap-4">
          <span>
            {showHeatmap ? 'Baleseti Kockázati Hőtérkép (Heatmap)' : 'Uber H3 Res-8 Kockázat'}
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            {cells.length} zóna
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

      {/* Hover Tooltip (Works seamlessly over both Heatmap and Hexagons!) */}
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
