'use client';

import React, { useState, useMemo, useCallback } from 'react';
import Map, { NavigationControl, useControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { PickingInfo } from '@deck.gl/core';
import type { H3CellRecord } from '@/lib/feature-engineering';
import { Layers, Box, Compass } from 'lucide-react';

const CARTO_DARK_MATTER =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

function DeckGLOverlay(props: { layers: unknown[] }) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: true }));
  overlay.setProps({ layers: props.layers as never[] });
  return null;
}

export function riskToRgba(risk: number, isSelected: boolean): [number, number, number, number] {
  const alpha = isSelected ? 235 : 185;
  if (risk >= 0.65) return [239, 68, 68, alpha]; // Critical Red
  if (risk >= 0.45) return [249, 115, 22, alpha]; // High Orange
  if (risk >= 0.25) return [234, 179, 8, alpha]; // Elevated Amber
  return [16, 185, 129, alpha]; // Low Emerald
}

interface DeckH3MapProps {
  cells: H3CellRecord[];
  selectedCell: H3CellRecord | null;
  onSelectCell: (cell: H3CellRecord | null) => void;
  extruded3D: boolean;
  onToggle3D: () => void;
}

export default function DeckH3Map({
  cells,
  selectedCell,
  onSelectCell,
  extruded3D,
  onToggle3D,
}: DeckH3MapProps) {
  const [viewState, setViewState] = useState({
    longitude: 19.054,
    latitude: 47.498,
    zoom: 12.2,
    pitch: extruded3D ? 48 : 0,
    bearing: extruded3D ? -12 : 0,
  });

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
      pitch: next3D ? 48 : 0,
      bearing: next3D ? -12 : 0,
    }));
  }, [extruded3D, onToggle3D]);

  const resetCamera = useCallback(() => {
    setViewState({
      longitude: 19.054,
      latitude: 47.498,
      zoom: 12.2,
      pitch: extruded3D ? 48 : 0,
      bearing: extruded3D ? -12 : 0,
    });
  }, [extruded3D]);

  const layers = useMemo(() => {
    return [
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
            : [15, 23, 42, 160],
        lineWidthMinPixels: 1.5,
        getElevation: (d) => (extruded3D ? Math.max(25, d.risk_score * 950) : 0),
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
    ];
  }, [cells, extruded3D, selectedCell, onSelectCell]);

  return (
    <div className="relative w-full h-full bg-[#090d16] overflow-hidden select-none">
      <Map
        {...viewState}
        onMove={(evt: { viewState: typeof viewState }) => setViewState(evt.viewState)}
        mapStyle={CARTO_DARK_MATTER}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckGLOverlay layers={layers} />
        <NavigationControl position="bottom-right" />
      </Map>

      {/* Top-Left Floating Controls (2D / 3D Extrusion Toggle & Reset) */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <button
          onClick={handleToggleExtrusion}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold border backdrop-blur-md transition-all shadow-lg ${
            extruded3D
              ? 'bg-indigo-600/90 border-indigo-400 text-white'
              : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:bg-slate-800'
          }`}
        >
          {extruded3D ? <Box className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
          <span>{extruded3D ? '3D Extrudált H3 Nézet' : '2D Sík H3 Nézet'}</span>
        </button>

        <button
          onClick={resetCamera}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 backdrop-blur-md shadow-lg transition"
          title="Budapest középpont visszaállítása"
        >
          <Compass className="w-4 h-4 text-sky-400" />
          <span>Budapest Centrum</span>
        </button>
      </div>

      {/* Bottom-Left Risk Legend */}
      <div className="absolute bottom-5 left-4 z-10 bg-slate-900/90 border border-slate-800 backdrop-blur-md rounded-xl p-3 shadow-xl text-xs">
        <div className="font-semibold text-slate-300 mb-2 flex items-center justify-between gap-4">
          <span>Baleseti Kockázat (Uber H3 Res-8)</span>
          <span className="text-[10px] font-mono text-slate-400">{cells.length} hex</span>
        </div>
        <div className="grid grid-cols-2 sm:flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" />
            <span className="text-slate-300">&lt; 25% Alacsony</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-yellow-500 inline-block" />
            <span className="text-slate-300">25–45% Mérsékelt</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-orange-500 inline-block" />
            <span className="text-slate-300">45–65% Magas</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-500 inline-block" />
            <span className="text-slate-300">&ge; 65% Kritikus</span>
          </div>
        </div>
      </div>

      {/* Hover Tooltip */}
      {hoverInfo && hoverInfo.object && (
        <div
          className="pointer-events-none absolute z-20 w-72 bg-slate-950/95 border border-slate-700/90 rounded-xl p-3.5 shadow-2xl text-xs backdrop-blur-md"
          style={{
            left: Math.min(hoverInfo.x + 14, typeof window !== 'undefined' ? window.innerWidth - 300 : hoverInfo.x + 14),
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

