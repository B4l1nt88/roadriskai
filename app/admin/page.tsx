'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { H3CellRecord } from '@/lib/feature-engineering';
import type { PredictionRunRecord } from '@/lib/h3-store';
import {
  ArrowLeft,
  Upload,
  Database,
  Download,
  Cpu,
  Play,
  RotateCcw,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Clock,
  Activity,
  Radio,
  KeyRound,
  ShieldAlert,
} from 'lucide-react';

const SAMPLE_BUDAPEST_ACCIDENTS_CSV = `lat,lng,occurred_at,is_wet_road,severity,osm_tram_tracks,osm_intersection_count,label
47.4891,19.0163,2026-11-12T07:45:00Z,1,serious,1,9,BAH-csomópont
47.4894,19.0168,2026-11-12T08:15:00Z,1,light,1,8,BAH-csomópont
47.5106,19.0558,2026-11-12T08:30:00Z,1,serious,1,11,Nyugati tér
47.5109,19.0562,2026-11-12T09:10:00Z,0,light,1,10,Nyugati tér
47.4963,19.0706,2026-11-12T16:40:00Z,1,serious,1,10,Blaha Lujza tér / Rákóczi út
47.4965,19.0711,2026-11-12T17:05:00Z,1,light,1,9,Blaha Lujza tér / Rákóczi út
47.4754,19.0991,2026-11-12T17:20:00Z,1,serious,1,8,Könyves Kálmán krt. / Üllői út
47.4981,19.0402,2026-11-12T18:00:00Z,0,light,1,7,Clark Ádám tér / Lánchíd
47.5398,19.0542,2026-11-12T07:55:00Z,1,serious,1,8,Árpád híd
47.5071,19.0245,2026-11-12T15:30:00Z,1,light,1,9,Széll Kálmán tér
47.4793,19.0663,2026-11-12T19:15:00Z,1,light,1,7,Petőfi híd / Boráros tér
`;

export default function AdminPortalPage() {
  const [cells, setCells] = useState<H3CellRecord[]>([]);
  const [runs, setRuns] = useState<PredictionRunRecord[]>([]);
  const [storageMode, setStorageMode] = useState<string>('local-fallback');
  const [modelStatus, setModelStatus] = useState<{
    exists: boolean;
    sizeBytes: number;
    updatedAt: string | null;
  }>({ exists: false, sizeBytes: 0, updatedAt: null });

  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [isDraggingCsv, setIsDraggingCsv] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [isResettingGrid, setIsResettingGrid] = useState(false);
  const [isRunningCron, setIsRunningCron] = useState(false);
  const [isUploadingModel, setIsUploadingModel] = useState(false);
  const [isSyncingIncidents, setIsSyncingIncidents] = useState(false);
  const [tomtomApiKeyInput, setTomtomApiKeyInput] = useState('');
  const [syncReports, setSyncReports] = useState<
    Array<{ source: string; fetched_count: number; details: string[] }>
  >([]);
  const [recentlyUpdatedH3, setRecentlyUpdatedH3] = useState<Set<string>>(new Set());

  const loadDashboardData = useCallback(async () => {
    try {
      const res = await fetch('/api/cells', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) {
        setCells(data.cells || []);
        setRuns(data.prediction_runs || []);
        setStorageMode(data.storage_mode || 'local-fallback');
        if (data.model_status) setModelStatus(data.model_status);
      }
    } catch {
      // Ignore fetch errors
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const handleDownloadSampleCsv = () => {
    const blob = new Blob([SAMPLE_BUDAPEST_ACCIDENTS_CSV], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budapest_sample_accidents.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleResetGrid = async () => {
    setIsResettingGrid(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/admin/init-grid', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setRecentlyUpdatedH3(new Set());
        setStatusMessage({
          type: 'success',
          text: data.message || `Budapest H3 rács visszaállítva (${data.cells_count} hexagon).`,
        });
        await loadDashboardData();
      } else {
        setStatusMessage({
          type: 'error',
          text: data.error || 'Hiba a rács alaphelyzetbe állításakor.',
        });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Hálózati hiba.',
      });
    } finally {
      setIsResettingGrid(false);
    }
  };

  const uploadCsvFile = async (file: File) => {
    setIsUploadingCsv(true);
    setStatusMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/admin/ingest-csv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        const touched = new Set<string>(
          (data.updated_cells || []).map((c: H3CellRecord) => c.h3_index)
        );
        setRecentlyUpdatedH3(touched);
        setStatusMessage({
          type: 'success',
          text: `${data.processed_rows} baleseti rekord beolvasva -> ${data.affected_hexagons} Uber H3 Res-8 hexagon frissítve (${data.new_hexagons_created} új cella).`,
        });
        await loadDashboardData();
      } else {
        setStatusMessage({
          type: 'error',
          text: data.error || 'CSV feldolgozási hiba.',
        });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'CSV feltöltési hiba.',
      });
    } finally {
      setIsUploadingCsv(false);
    }
  };

  const handleCsvDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingCsv(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await uploadCsvFile(file);
    }
  };

  const handleSyncLiveIncidents = async (
    provider: 'all' | 'tomtom' | 'bkk' | 'historical'
  ) => {
    setIsSyncingIncidents(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/admin/sync-incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          tomtomApiKey: tomtomApiKeyInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (Array.isArray(data.reports)) {
        setSyncReports(data.reports);
      }
      if (data.ok) {
        const touched = new Set<string>(
          (data.updated_cells || []).map((c: H3CellRecord) => c.h3_index)
        );
        setRecentlyUpdatedH3(touched);
        setStatusMessage({
          type: 'success',
          text: data.message,
        });
        await loadDashboardData();
      } else {
        setStatusMessage({
          type: 'error',
          text: data.error || 'Baleseti adatszinkronizáció sikertelen.',
        });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Hálózati hiba.',
      });
    } finally {
      setIsSyncingIncidents(false);
    }
  };

  const handleUploadOnnxModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingModel(true);
    setStatusMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/admin/upload-model', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        setStatusMessage({ type: 'success', text: data.message });
        await loadDashboardData();
      } else {
        setStatusMessage({ type: 'error', text: data.error || 'Modell feltöltési hiba.' });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Hálózati hiba.',
      });
    } finally {
      setIsUploadingModel(false);
    }
  };

  const handleTriggerCronPredict = async () => {
    setIsRunningCron(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/cron/predict', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setStatusMessage({
          type: 'success',
          text: `15 perces predikciós ciklus lefutott ${data.run.execution_ms} ms alatt (${data.cells_updated} H3 cella frissítve, modell: ${data.run.model_source}).`,
        });
        await loadDashboardData();
      } else {
        setStatusMessage({ type: 'error', text: data.error || 'Predikciós hiba.' });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Hálózati hiba.',
      });
    } finally {
      setIsRunningCron(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Top Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 mb-2"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Vissza az Interaktív Budapest H3 Térképhez</span>
            </Link>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Budapest H3 Spatio-Temporal Admin &amp; MLOps Portál
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              TomTom Traffic Incidents v5 + BKK FUTÁR GTFS-RT baleseti szinkron • CSV H3 Res-8 indexelés • LightGBM ONNX MLOps
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="px-3 py-1.5 rounded-lg text-xs font-mono bg-slate-900 border border-slate-800 text-slate-300">
              Tároló: <strong className="text-emerald-400">{storageMode}</strong>
            </span>
            <button
              onClick={handleResetGrid}
              disabled={isResettingGrid}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition disabled:opacity-50"
            >
              <RotateCcw className={`w-4 h-4 ${isResettingGrid ? 'animate-spin' : ''}`} />
              <span>Budapest H3 Rács Reset</span>
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div
            className={`p-4 rounded-xl border flex items-center gap-3 text-sm ${
              statusMessage.type === 'success'
                ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-200'
                : 'bg-red-950/50 border-red-500/40 text-red-200'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Featured Panel: Live TomTom Traffic Incidents v5 + BKK FUTÁR Alerts + Budapest Blackspots */}
        <div className="bg-gradient-to-br from-slate-900 via-slate-900/95 to-indigo-950/30 border border-indigo-500/30 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Radio className="w-5 h-5 text-red-400 animate-pulse" />
                <h2 className="text-base font-bold text-white">
                  Élő Baleseti és Forgalmi Incidens Letöltő (TomTom API v5 + BKK FUTÁR GTFS-RT + ORFK/KSH Gócpontok)
                </h2>
              </div>
              <p className="text-xs text-slate-300 mt-1">
                Közvetlen adatbetöltés Budapest területére (<code className="text-sky-400">bbox: 18.92,47.38,19.25,47.61</code>). Minden letöltött baleset és torlódás automatikusan Uber H3 Resolution-8 hexagonokba kerül és újraszámolja az ONNX kockázatot.
              </p>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto">
              <div className="relative flex-1 md:w-72">
                <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={tomtomApiKeyInput}
                  onChange={(e) => setTomtomApiKeyInput(e.target.value)}
                  placeholder="TomTom API Key (vagy TOMTOM_API_KEY .env)"
                  className="w-full pl-8 pr-3 py-2 rounded-xl bg-slate-950/90 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-400 font-mono"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            <button
              onClick={() => handleSyncLiveIncidents('all')}
              disabled={isSyncingIncidents}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg transition disabled:opacity-50"
            >
              <Radio className="w-4 h-4" />
              <span>
                {isSyncingIncidents
                  ? 'Szinkronizálás...'
                  : 'Összes Forrás Szinkronizálása (Ajánlott)'}
              </span>
            </button>

            <button
              onClick={() => handleSyncLiveIncidents('bkk')}
              disabled={isSyncingIncidents}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold bg-sky-600/90 hover:bg-sky-500 text-white transition disabled:opacity-50"
            >
              <Activity className="w-4 h-4" />
              <span>BKK FUTÁR Alerts.pb + Torlódások</span>
            </button>

            <button
              onClick={() => handleSyncLiveIncidents('tomtom')}
              disabled={isSyncingIncidents}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold bg-emerald-600/90 hover:bg-emerald-500 text-white transition disabled:opacity-50"
            >
              <ShieldAlert className="w-4 h-4" />
              <span>TomTom Traffic Incidents v5 Letöltés</span>
            </button>

            <button
              onClick={() => handleSyncLiveIncidents('historical')}
              disabled={isSyncingIncidents}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition disabled:opacity-50"
            >
              <Database className="w-4 h-4 text-amber-400" />
              <span>Budapest 12 Baleseti Gócpont (~115 db)</span>
            </button>
          </div>

          {syncReports.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
              {syncReports.map((rep, idx) => (
                <div
                  key={idx}
                  className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between font-semibold text-slate-200">
                    <span className="truncate">{rep.source}</span>
                    <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono">
                      +{rep.fetched_count} rekord
                    </span>
                  </div>
                  {rep.details.slice(0, 3).map((d, i) => (
                    <p key={i} className="text-[11px] text-slate-400 truncate">
                      • {d}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3-Column Action Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Card 1: Drag-and-Drop CSV Uploader */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                  <span>1. Baleseti CSV Feltöltés (&rarr; H3 Res-8)</span>
                </h2>
                <button
                  onClick={handleDownloadSampleCsv}
                  className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Minta CSV</span>
                </button>
              </div>
              <p className="text-xs text-slate-400">
                A feltöltött <code className="text-slate-200">lat, lng</code> koordinátákat a rendszer automatikusan <code className="text-sky-400">h3.latLngToCell(lat, lng, 8)</code> hexagonokba sorolja és újraszámolja a kockázatot.
              </p>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingCsv(true);
              }}
              onDragLeave={() => setIsDraggingCsv(false)}
              onDrop={handleCsvDrop}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer ${
                isDraggingCsv
                  ? 'border-emerald-400 bg-emerald-950/30'
                  : 'border-slate-700 hover:border-slate-500 bg-slate-950/50'
              }`}
            >
              <input
                id="csv-file-input"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadCsvFile(f);
                }}
              />
              <label htmlFor="csv-file-input" className="cursor-pointer block space-y-2">
                <Upload className="w-7 h-7 text-emerald-400 mx-auto" />
                <div className="text-xs font-semibold text-slate-200">
                  {isUploadingCsv
                    ? 'CSV indexelése H3 hexagonokba...'
                    : 'Húzd ide a CSV fájlt vagy kattints a tallózáshoz'}
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  Oszlopok: lat, lng, is_wet_road, severity, label
                </div>
              </label>
            </div>
          </div>

          {/* Card 2: ONNX Model Upload & Training Dataset Export */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-indigo-400" />
                  <span>2. LightGBM ONNX Modell &amp; Tanító CSV</span>
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                    modelStatus.exists
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {modelStatus.exists
                    ? `ONNX Aktív (${(modelStatus.sizeBytes / 1024).toFixed(1)} KB)`
                    : 'Kalibrált 14f Fallback'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Exportáld a 14-jellemzős H3 adathalmazt a <code className="text-slate-200">scripts/train_model.py</code> szkripthez, vagy töltsd fel az új <code className="text-indigo-300">.onnx</code> binárist.
              </p>
            </div>

            <div className="space-y-2.5">
              <a
                href="/api/admin/export-training"
                download="budapest_h3_training_dataset.csv"
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 transition"
              >
                <Download className="w-4 h-4 text-sky-400" />
                <span>14-Feature Tanító CSV Letöltése</span>
              </a>

              <label className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer transition shadow">
                <Upload className="w-4 h-4" />
                <span>
                  {isUploadingModel
                    ? 'ONNX Modell Feltöltése...'
                    : 'Új .onnx Modell Feltöltése'}
                </span>
                <input
                  type="file"
                  accept=".onnx,application/octet-stream"
                  className="hidden"
                  onChange={handleUploadOnnxModel}
                />
              </label>
            </div>
          </div>

          {/* Card 3: Manual 15-Minute Prediction Trigger & Latest Telemetry */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-amber-400" />
                  <span>3. 15-Perces Predikciós Cron Motor</span>
                </h2>
                <span className="text-[11px] font-mono text-slate-400">Node.js Runtime</span>
              </div>
              <p className="text-xs text-slate-400">
                Élő Open-Meteo csapadék/szél/hőmérséklet + BKK GTFS-RT sebesség és térbeli késleltetés (<code className="text-sky-400">gridDisk(h, 1)</code>) kiértékelése.
              </p>
            </div>

            <div className="space-y-3">
              {runs[0] && (
                <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-xs space-y-1">
                  <div className="flex justify-between text-slate-400">
                    <span>Utolsó futás:</span>
                    <span className="font-mono text-slate-200">
                      {new Date(runs[0].ran_at).toLocaleTimeString('hu-HU')} ({runs[0].execution_ms} ms)
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Időjárás:</span>
                    <span className="font-mono text-sky-400">
                      {runs[0].temp_c}°C • {runs[0].precip_mm} mm • {runs[0].wind_kmh} km/h
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Modell forrás:</span>
                    <span className="font-mono text-emerald-400 truncate max-w-[180px]">
                      {runs[0].model_source}
                    </span>
                  </div>
                </div>
              )}

              <button
                onClick={handleTriggerCronPredict}
                disabled={isRunningCron}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 transition shadow disabled:opacity-50"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {isRunningCron
                    ? '15-perces predikció futtatása...'
                    : '15-Perces Predikció Azonnali Indítása'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Prediction Run Logs */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-sky-400" />
            <span>Legutóbbi Predikciós Futások Naplója (`prediction_runs`)</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Időbélyeg</th>
                  <th className="py-2 px-3">Frissített H3 Cellák</th>
                  <th className="py-2 px-3">Hőmérséklet</th>
                  <th className="py-2 px-3">Csapadék</th>
                  <th className="py-2 px-3">Szél</th>
                  <th className="py-2 px-3">Aktív BKK Jármű</th>
                  <th className="py-2 px-3">Futásidő</th>
                  <th className="py-2 px-3">Modell</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {runs.slice(0, 8).map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/40">
                    <td className="py-2 px-3 text-slate-300">
                      {new Date(r.ran_at).toLocaleString('hu-HU')}
                    </td>
                    <td className="py-2 px-3 text-white font-semibold">{r.cells_updated}</td>
                    <td className="py-2 px-3 text-amber-300">{r.temp_c?.toFixed(1)}°C</td>
                    <td className="py-2 px-3 text-sky-400">{r.precip_mm?.toFixed(1)} mm</td>
                    <td className="py-2 px-3 text-slate-300">{r.wind_kmh?.toFixed(1)} km/h</td>
                    <td className="py-2 px-3 text-emerald-400">{r.active_bkk_vehicles}</td>
                    <td className="py-2 px-3 text-slate-400">{r.execution_ms} ms</td>
                    <td className="py-2 px-3 text-indigo-300">{r.model_source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Updated Hexagon Table */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>Budapest H3 Resolution-8 Hexagon Tábla ({cells.length} cella)</span>
            </h3>
            {recentlyUpdatedH3.size > 0 && (
              <span className="text-xs text-emerald-400 font-medium">
                {recentlyUpdatedH3.size} cella frissítve az utolsó szinkronból / CSV-ből
              </span>
            )}
          </div>

          <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2.5 px-3">H3 Index (Res-8)</th>
                  <th className="py-2.5 px-3">Zóna Megnevezés</th>
                  <th className="py-2.5 px-3">Kockázat P(Y=1)</th>
                  <th className="py-2.5 px-3">Balesetek (Össz / Nedves)</th>
                  <th className="py-2.5 px-3">Sűrűség</th>
                  <th className="py-2.5 px-3">BKK Sebesség (σ)</th>
                  <th className="py-2.5 px-3">Villamos / Csomópont</th>
                  <th className="py-2.5 px-3">Domináns Faktor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {cells.slice(0, 60).map((cell) => {
                  const isHighlighted = recentlyUpdatedH3.has(cell.h3_index);
                  return (
                    <tr
                      key={cell.h3_index}
                      className={
                        isHighlighted
                          ? 'bg-emerald-950/40 hover:bg-emerald-950/60'
                          : 'hover:bg-slate-800/40'
                      }
                    >
                      <td className="py-2 px-3 font-mono text-sky-400 font-medium">
                        {cell.h3_index}
                        {isHighlighted && (
                          <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-300">
                            FRISSÍTVE
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-medium text-white">{cell.label}</td>
                      <td className="py-2 px-3 font-mono font-bold">
                        <span
                          className={`px-2 py-0.5 rounded ${
                            cell.risk_score >= 0.65
                              ? 'bg-red-500/20 text-red-400'
                              : cell.risk_score >= 0.45
                              ? 'bg-orange-500/20 text-orange-400'
                              : cell.risk_score >= 0.25
                              ? 'bg-yellow-500/20 text-yellow-300'
                              : 'bg-emerald-500/20 text-emerald-400'
                          }`}
                        >
                          {(cell.risk_score * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-200">
                        {cell.total_accidents} db / {cell.wet_accidents} nedves
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-300">
                        {(cell.hist_accident_density * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-300">
                        {cell.bkk_avg_speed} km/h (±{cell.bkk_speed_std})
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-400">
                        {cell.osm_tram_tracks ? 'Villamos' : 'Normál'} • {cell.osm_intersection_count} csp.
                      </td>
                      <td className="py-2 px-3 text-amber-300">{cell.top_risk_factor}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
