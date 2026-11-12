'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import AnalyticsSidebar from '@/components/AnalyticsSidebar';
import type { H3CellRecord, WeatherTelemetry } from '@/lib/feature-engineering';

const DeckH3Map = dynamic(() => import('@/components/DeckH3Map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex flex-col items-center justify-center bg-[#090d16] text-slate-400">
      <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
      <p className="text-xs font-mono uppercase tracking-widest">
        MapLibre GL + Deck.gl H3HexagonLayer betöltése...
      </p>
    </div>
  ),
});

export default function HomePage() {
  const [cells, setCells] = useState<H3CellRecord[]>([]);
  const [weather, setWeather] = useState<WeatherTelemetry | null>(null);
  const [selectedCell, setSelectedCell] = useState<H3CellRecord | null>(null);
  const [extruded3D, setExtruded3D] = useState<boolean>(true);
  const [minRiskFilter, setMinRiskFilter] = useState<number>(0);
  const [isPredicting, setIsPredicting] = useState<boolean>(false);
  const [storageMode, setStorageMode] = useState<string>('local-fallback');

  const fetchCells = useCallback(async () => {
    try {
      const res = await fetch('/api/cells', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok && Array.isArray(data.cells)) {
        setCells(data.cells);
        setWeather(data.weather || null);
        setStorageMode(data.storage_mode || 'local-fallback');
      }
    } catch {
      // Keep current state on network error
    }
  }, []);

  useEffect(() => {
    fetchCells();
  }, [fetchCells]);

  const handleRunPrediction = async () => {
    setIsPredicting(true);
    try {
      const res = await fetch('/api/cron/predict', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        await fetchCells();
      }
    } finally {
      setIsPredicting(false);
    }
  };

  const filteredCells = useMemo(() => {
    if (minRiskFilter <= 0) return cells;
    return cells.filter((c) => c.risk_score >= minRiskFilter);
  }, [cells, minRiskFilter]);

  return (
    <main className="w-screen h-screen flex flex-col lg:flex-row overflow-hidden bg-[#090d16]">
      <div className="flex-1 h-[55vh] lg:h-full relative">
        <DeckH3Map
          cells={filteredCells}
          selectedCell={selectedCell}
          onSelectCell={setSelectedCell}
          extruded3D={extruded3D}
          onToggle3D={() => setExtruded3D((prev) => !prev)}
        />
      </div>

      <AnalyticsSidebar
        cells={filteredCells}
        allCellsCount={cells.length}
        weather={weather}
        selectedCell={selectedCell}
        onSelectCell={setSelectedCell}
        minRiskFilter={minRiskFilter}
        onChangeMinRiskFilter={setMinRiskFilter}
        onRefreshPredict={handleRunPrediction}
        isPredicting={isPredicting}
        storageMode={storageMode}
      />
    </main>
  );
}

