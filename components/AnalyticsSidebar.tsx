'use client';

import React from 'react';
import Link from 'next/link';
import type { H3CellRecord, WeatherTelemetry } from '@/lib/feature-engineering';
import {
  CloudRain,
  Wind,
  Thermometer,
  Bus,
  AlertTriangle,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Settings,
  MapPin,
  TrendingUp,
  TrainTrack,
  GitFork,
} from 'lucide-react';

interface AnalyticsSidebarProps {
  cells: H3CellRecord[];
  allCellsCount: number;
  weather: WeatherTelemetry | null;
  selectedCell: H3CellRecord | null;
  onSelectCell: (cell: H3CellRecord | null) => void;
  minRiskFilter: number;
  onChangeMinRiskFilter: (val: number) => void;
  onRefreshPredict: () => void;
  isPredicting: boolean;
  storageMode: string;
}

export default function AnalyticsSidebar({
  cells,
  allCellsCount,
  weather,
  selectedCell,
  onSelectCell,
  minRiskFilter,
  onChangeMinRiskFilter,
  onRefreshPredict,
  isPredicting,
  storageMode,
}: AnalyticsSidebarProps) {
  const totalBkkVehicles = cells.reduce((acc, c) => acc + (c.bkk_vehicle_count || 0), 0);
  const top10Cells = cells.slice(0, 10);

  return (
    <aside className="w-full lg:w-[420px] xl:w-[450px] h-full bg-slate-950 border-l border-slate-800/90 flex flex-col overflow-hidden select-none">
      {/* Header */}
      <div className="p-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/50">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h1 className="text-sm font-bold tracking-wide uppercase text-white">
              Budapest H3 Risk Engine
            </h1>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Uber H3 Res-8 • BKK GTFS-RT • Open-Meteo • LightGBM
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshPredict}
            disabled={isPredicting}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition shadow"
            title="15 perces előrejelzés azonnali futtatása"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isPredicting ? 'animate-spin' : ''}`} />
            <span>{isPredicting ? 'Számítás...' : 'Predikció'}</span>
          </button>

          <Link
            href="/admin"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <Settings className="w-3.5 h-3.5 text-sky-400" />
            <span>Admin</span>
          </Link>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Live Weather & BKK Telemetry Bar */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Open-Meteo Budapest</span>
              <Thermometer className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-white">
                {weather ? `${weather.temp_c.toFixed(1)}°C` : '11.5°C'}
              </span>
              <span className="text-xs text-sky-400 flex items-center gap-1">
                <CloudRain className="w-3 h-3" />
                {weather ? `${weather.precip_mm.toFixed(1)} mm` : '0.0 mm'}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
              <Wind className="w-3 h-3 text-slate-500" />
              <span>Szél: {weather ? `${weather.wind_speed_kmh.toFixed(1)} km/h` : '12 km/h'}</span>
            </div>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>BKK FUTÁR Telemetria</span>
              <Bus className="w-3.5 h-3.5 text-sky-400" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-white">{totalBkkVehicles}</span>
              <span className="text-xs text-emerald-400">aktív jármű</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
              <span>Rács: {cells.length} / {allCellsCount} hex</span>
              <span className="font-mono text-[10px] text-slate-500">{storageMode}</span>
            </div>
          </div>
        </div>

        {/* Risk Filter Slider */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-slate-200 flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
              Minimum Kockázati Szűrő
            </span>
            <span className="font-mono font-bold text-indigo-400">
              &ge; {(minRiskFilter * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.75}
            step={0.05}
            value={minRiskFilter}
            onChange={(e) => onChangeMinRiskFilter(parseFloat(e.target.value))}
            className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
          />
          <div className="flex justify-between text-[10px] text-slate-500 mt-1">
            <span>0% (Összes cella)</span>
            <span>25%</span>
            <span>50%</span>
            <span>75% (Kritikus)</span>
          </div>
        </div>

        {/* Selected Cell Inspector */}
        {selectedCell && (
          <div className="bg-indigo-950/30 border border-indigo-500/40 rounded-xl p-3.5 space-y-2.5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-300">
                  <MapPin className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>{selectedCell.label}</span>
                </div>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                  H3 Index: <span className="text-sky-400">{selectedCell.h3_index}</span>
                </p>
              </div>
              <button
                onClick={() => onSelectCell(null)}
                className="text-[11px] text-slate-400 hover:text-white px-1.5 py-0.5 rounded bg-slate-800/80"
              >
                Bezár
              </button>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  Domináns Kockázati Faktor (XAI)
                </div>
                <div className="text-xs font-semibold text-amber-300 mt-0.5 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>{selectedCell.top_risk_factor}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-400">P(Baleset)</div>
                <div className="text-base font-extrabold text-white font-mono">
                  {(selectedCell.risk_score * 100).toFixed(1)}%
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-400">BKK Sebesség</div>
                <div className="font-mono font-semibold text-white mt-0.5">
                  {selectedCell.bkk_avg_speed} km/h
                </div>
                <div className="text-[10px] text-slate-500">
                  Szabad: {selectedCell.free_flow_kmh} km/h
                </div>
              </div>

              <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-400">Shockwave σ</div>
                <div className="font-mono font-semibold text-white mt-0.5">
                  ±{selectedCell.bkk_speed_std} km/h
                </div>
                <div className="text-[10px] text-slate-500">
                  Szomszéd: {(selectedCell.neighbor_speed_ratio * 100).toFixed(0)}%
                </div>
              </div>

              <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-400">Baleset / Nedves</div>
                <div className="font-mono font-semibold text-white mt-0.5">
                  {selectedCell.total_accidents} / {selectedCell.wet_accidents}
                </div>
                <div className="text-[10px] text-slate-500">
                  Sűrűség: {(selectedCell.hist_accident_density * 100).toFixed(0)}%
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
              <span className="flex items-center gap-1">
                <TrainTrack className="w-3.5 h-3.5 text-sky-400" />
                Villamossín: {selectedCell.osm_tram_tracks ? 'Igen (1)' : 'Nem (0)'}
              </span>
              <span className="flex items-center gap-1">
                <GitFork className="w-3.5 h-3.5 text-indigo-400" />
                Csomópontok: {selectedCell.osm_intersection_count} db
              </span>
            </div>
          </div>
        )}

        {/* Top 10 Highest-Risk Hexagons */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-red-400" />
              <span>Top 10 Legkockázatosabb H3 Cella</span>
            </h2>
            <span className="text-[11px] text-slate-500 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> 15p ablak
            </span>
          </div>

          <div className="space-y-2">
            {top10Cells.map((cell, idx) => {
              const isSelected = selectedCell?.h3_index === cell.h3_index;
              const pct = (cell.risk_score * 100).toFixed(1);

              return (
                <button
                  key={cell.h3_index}
                  onClick={() => onSelectCell(cell)}
                  className={`w-full text-left p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-indigo-950/60 border-indigo-400 shadow-md'
                      : 'bg-slate-900/75 border-slate-800/90 hover:bg-slate-900 hover:border-slate-700'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-slate-800 text-slate-300 font-mono text-[11px] font-bold flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <span className="text-xs font-semibold text-white truncate">
                        {cell.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span className="font-mono text-sky-400">{cell.h3_index}</span>
                      <span>•</span>
                      <span className="truncate text-amber-300/90">{cell.top_risk_factor}</span>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-md font-mono text-xs font-bold ${
                        cell.risk_score >= 0.65
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : cell.risk_score >= 0.45
                          ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                          : 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
                      }`}
                    >
                      {pct}%
                    </span>
                    <div className="text-[10px] font-mono text-slate-500 mt-1">
                      {cell.bkk_avg_speed} km/h • {cell.total_accidents} bal.
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}

