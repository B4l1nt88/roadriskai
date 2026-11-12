#!/usr/bin/env python3
"""
Budapest Spatio-Temporal Accident Risk Platform — LightGBM Trainer & ONNX Exporter
==================================================================================
Implements the exact 14-feature contract defined in FULL_CONTEXT.md:
  0: hour_sin
  1: hour_cos
  2: is_weekend
  3: bkk_speed_ratio       (monotone: -1)
  4: bkk_speed_std         (monotone: +1)
  5: neighbor_speed_ratio  (monotone: -1)
  6: bkk_delay_avg         (monotone: +1)
  7: precip_mm             (monotone: +1)
  8: wind_speed_kmh        (monotone: +1)
  9: temp_c                (monotone:  0)
 10: osm_tram_tracks       (monotone: +1)
 11: osm_intersection_count(monotone: +1)
 12: hist_accident_density (monotone: +1)
 13: hist_wet_accident_ratio(monotone: +1)

Usage:
  python scripts/train_model.py
  python scripts/train_model.py --csv budapest_h3_training_dataset.csv
"""

import argparse
import os
import sys
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, brier_score_loss

import onnxmltools
from onnxmltools.convert.common.data_types import FloatTensorType

FEATURE_NAMES = [
    "hour_sin",
    "hour_cos",
    "is_weekend",
    "bkk_speed_ratio",
    "bkk_speed_std",
    "neighbor_speed_ratio",
    "bkk_delay_avg",
    "precip_mm",
    "wind_speed_kmh",
    "temp_c",
    "osm_tram_tracks",
    "osm_intersection_count",
    "hist_accident_density",
    "hist_wet_accident_ratio",
]

MONOTONE_CONSTRAINTS = [0, 0, 0, -1, 1, -1, 1, 1, 1, 0, 1, 1, 1, 1]


def generate_synthetic_budapest_dataset(n_samples: int = 8000, seed: int = 42) -> pd.DataFrame:
    """Generates temporally ordered spatio-temporal Budapest H3 Res-8 samples."""
    rng = np.random.default_rng(seed)

    # Simulate sequential 15-minute intervals over several weeks
    time_steps = np.arange(n_samples)
    hours = ((time_steps * 0.25) % 24.0).astype(np.float32)
    days = ((time_steps * 0.25) // 24.0) % 7

    hour_sin = np.sin(2.0 * np.pi * hours / 24.0).astype(np.float32)
    hour_cos = np.cos(2.0 * np.pi * hours / 24.0).astype(np.float32)
    is_weekend = np.isin(days, [5, 6]).astype(np.float32)

    is_rush = (((hours >= 7.0) & (hours <= 9.5)) | ((hours >= 16.0) & (hours <= 18.5))) & (is_weekend == 0)

    # Weather features
    temp_c = rng.normal(loc=11.5, scale=8.5, size=n_samples).clip(-18.0, 39.0).astype(np.float32)
    is_raining = rng.random(n_samples) < 0.24
    precip_mm = np.where(is_raining, rng.exponential(scale=2.2, size=n_samples), 0.0).clip(0.0, 45.0).astype(np.float32)
    wind_speed_kmh = rng.gamma(shape=2.2, scale=6.5, size=n_samples).clip(0.0, 110.0).astype(np.float32)

    # Static infrastructure & historical H3 features
    osm_tram_tracks = (rng.random(n_samples) < 0.55).astype(np.float32)
    osm_intersection_count = rng.integers(1, 16, size=n_samples).astype(np.float32)
    hist_accident_density = rng.beta(a=1.6, b=4.2, size=n_samples).astype(np.float32)
    hist_wet_accident_ratio = (
        (0.15 + 0.20 * osm_tram_tracks + rng.beta(a=1.8, b=4.5, size=n_samples) * 0.55)
        .clip(0.0, 1.0)
        .astype(np.float32)
    )

    # BKK GTFS-RT traffic dynamics
    base_speed_ratio = np.where(is_rush, rng.normal(0.55, 0.18, n_samples), rng.normal(0.84, 0.14, n_samples))
    rain_penalty = np.where(precip_mm > 0.5, 0.10, 0.0)
    bkk_speed_ratio = (base_speed_ratio - rain_penalty).clip(0.12, 1.2).astype(np.float32)

    bkk_speed_std = (
        rng.normal(loc=4.5, scale=2.5, size=n_samples)
        + np.where(is_rush, 4.2, 0.0)
        + np.where(precip_mm > 1.0, 3.0, 0.0)
    ).clip(1.0, 35.0).astype(np.float32)

    neighbor_speed_ratio = (bkk_speed_ratio * 0.75 + rng.normal(0.80, 0.12, n_samples) * 0.25).clip(0.15, 1.2).astype(np.float32)
    bkk_delay_avg = ((1.0 - np.minimum(1.0, bkk_speed_ratio)) * 300.0 + rng.exponential(20.0, n_samples)).clip(0.0, 1800.0).astype(np.float32)

    # Ground-truth calibrated log-odds respecting monotone relationships
    icing_boost = np.where((temp_c <= 2.0) & (precip_mm > 0.0), 0.95, 0.0)
    wet_tram_boost = np.where((precip_mm > 0.5) & (osm_tram_tracks == 1.0), 0.55, 0.0)

    logit = (
        -2.55
        - 0.30 * hour_cos
        + 0.15 * hour_sin
        - 0.25 * is_weekend
        - 1.85 * (bkk_speed_ratio - 0.80)
        + 0.085 * bkk_speed_std
        - 0.90 * (neighbor_speed_ratio - 0.80)
        + 0.0016 * bkk_delay_avg
        + 0.12 * precip_mm
        + 0.010 * wind_speed_kmh
        + icing_boost
        + wet_tram_boost
        + 0.38 * osm_tram_tracks
        + 0.065 * osm_intersection_count
        + 2.35 * hist_accident_density
        + 0.55 * hist_wet_accident_ratio
    )

    probs = 1.0 / (1.0 + np.exp(-logit))
    target = (rng.random(n_samples) < probs).astype(np.int32)

    df = pd.DataFrame(
        {
            "hour_sin": hour_sin,
            "hour_cos": hour_cos,
            "is_weekend": is_weekend,
            "bkk_speed_ratio": bkk_speed_ratio,
            "bkk_speed_std": bkk_speed_std,
            "neighbor_speed_ratio": neighbor_speed_ratio,
            "bkk_delay_avg": bkk_delay_avg,
            "precip_mm": precip_mm,
            "wind_speed_kmh": wind_speed_kmh,
            "temp_c": temp_c,
            "osm_tram_tracks": osm_tram_tracks,
            "osm_intersection_count": osm_intersection_count,
            "hist_accident_density": hist_accident_density,
            "hist_wet_accident_ratio": hist_wet_accident_ratio,
            "target_accident": target,
        }
    )
    return df


def load_or_build_dataset(csv_path: str | None) -> pd.DataFrame:
    if csv_path and os.path.exists(csv_path):
        print(f"[INFO] Loading training CSV from: {csv_path}")
        df = pd.read_csv(csv_path)
        missing = [f for f in FEATURE_NAMES if f not in df.columns]
        if missing:
            raise ValueError(f"CSV is missing required 14-feature columns: {missing}")

        if "target_accident" not in df.columns:
            if "risk_score" in df.columns:
                df["target_accident"] = (df["risk_score"] >= 0.42).astype(np.int32)
            else:
                df["target_accident"] = (df["hist_accident_density"] >= 0.45).astype(np.int32)

        # If exported H3 CSV is small (~180 rows), augment with synthetic temporal slices so LightGBM splits cleanly
        if len(df) < 1000:
            print(f"[INFO] Augmenting {len(df)} CSV rows with synthetic spatio-temporal windows for robust LightGBM splits...")
            synth = generate_synthetic_budapest_dataset(n_samples=6000)
            df = pd.concat([df[FEATURE_NAMES + ["target_accident"]], synth], ignore_index=True)
        return df

    print("[INFO] Generating synthetic Budapest H3 spatio-temporal training dataset (8,000 windows)...")
    return generate_synthetic_budapest_dataset(n_samples=8000)


def main():
    parser = argparse.ArgumentParser(description="Train Budapest H3 LightGBM risk model and export to ONNX.")
    parser.add_argument("--csv", type=str, default=None, help="Optional path to exported training CSV.")
    parser.add_argument(
        "--out",
        type=str,
        default=os.path.join("public", "models", "budapest_risk_model.onnx"),
        help="Output path for ONNX binary.",
    )
    args = parser.parse_args()

    df = load_or_build_dataset(args.csv)
    X = df[FEATURE_NAMES].astype(np.float32).values
    y = df["target_accident"].astype(np.int32).values

    # Validate with TimeSeriesSplit
    tscv = TimeSeriesSplit(n_splits=5)
    aucs = []
    briers = []

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X), start=1):
        X_train, y_train = X[train_idx], y[train_idx]
        X_val, y_val = X[val_idx], y[val_idx]

        clf_fold = lgb.LGBMClassifier(
            n_estimators=120,
            learning_rate=0.05,
            num_leaves=15,
            max_depth=5,
            min_child_samples=20,
            subsample=0.85,
            colsample_bytree=0.9,
            monotone_constraints=MONOTONE_CONSTRAINTS,
            random_state=42 + fold,
            verbose=-1,
        )
        clf_fold.fit(X_train, y_train)
        val_probs = clf_fold.predict_proba(X_val)[:, 1]
        auc = roc_auc_score(y_val, val_probs)
        brier = brier_score_loss(y_val, val_probs)
        aucs.append(auc)
        briers.append(brier)
        print(f"  [TimeSeriesSplit Fold {fold}/5] ROC-AUC: {auc:.4f} | Brier Loss: {brier:.4f}")

    print(f"[INFO] Mean CV ROC-AUC: {np.mean(aucs):.4f} | Mean Brier Loss: {np.mean(briers):.4f}")

    # Train final production model on full dataset
    final_model = lgb.LGBMClassifier(
        n_estimators=140,
        learning_rate=0.05,
        num_leaves=15,
        max_depth=5,
        min_child_samples=20,
        subsample=0.85,
        colsample_bytree=0.9,
        monotone_constraints=MONOTONE_CONSTRAINTS,
        random_state=42,
        verbose=-1,
    )
    final_model.fit(X, y)

    # Export to ONNX with input "float_input", shape [None, 14], target_opset=12, zipmap=False
    initial_types = [("float_input", FloatTensorType([None, 14]))]
    onnx_model = onnxmltools.convert_lightgbm(
        final_model,
        initial_types=initial_types,
        target_opset=12,
        zipmap=False,
    )

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    onnxmltools.utils.save_model(onnx_model, args.out)
    size_kb = os.path.getsize(args.out) / 1024.0
    print(f"[SUCCESS] Exported ONNX model to {args.out} ({size_kb:.1f} KB, opset=12, zipmap=False)")


if __name__ == "__main__":
    main()

