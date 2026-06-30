"""Headless YourMT3+ inference wrapper (YPTF.MoE+Multi, noPS — the HF-Space best model).
setup_yourmt3.py copies this into the YourMT3 install dir as infer_headless.py, where it
runs from the repo root and writes ./model_output/<track_name>.mid (multi-instrument).

This wrapper is part of tab-studio (same license as the app); the YourMT3 model code it
imports is GPL-3.0 and lives only in the separately-installed YourMT3 dir.
"""
import sys, os
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'amt', 'src'))
import torch
from model_helper import load_model_checkpoint, transcribe

ARGS = ["mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt",
        '-p', '2024', '-tk', 'mc13_full_plus_256', '-dec', 'multi-t5', '-nl', '26',
        '-enc', 'perceiver-tf', '-sqr', '1', '-ff', 'moe', '-wf', '4', '-nmoe', '8',
        '-kmoe', '2', '-act', 'silu', '-epe', 'rope', '-rp', '1', '-ac', 'spec',
        '-hop', '300', '-atc', '1', '-pr', '16']

_model = None


def get_model():
    global _model
    if _model is None:
        m = load_model_checkpoint(args=ARGS, device='cpu')
        if torch.cuda.is_available():
            m.to('cuda')
        _model = m
    return _model


def infer(wav_path, track_name):
    return transcribe(get_model(), {'filepath': wav_path, 'track_name': track_name})


if __name__ == "__main__":
    wav, name = sys.argv[1], sys.argv[2]
    out = infer(wav, name)
    print("OK ->", out)
