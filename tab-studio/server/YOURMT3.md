# YourMT3+ melodic transcriber (optional, default when installed)

tab-studio's **default melodic transcriber** is [YourMT3+](https://github.com/mimbres/YourMT3)
(YPTF.MoE+Multi) — a multi-instrument transcription model. On our ground-truth benchmark
(babyslakh / Slakh2100, `mir_eval` onset-F) it beats Spotify basic-pitch on every pitched
instrument and is **10–16× better on synths**:

| | Synth Lead | Synth Pad | Guitar | Piano | Organ | Bass |
|---|---|---|---|---|---|---|
| **YourMT3+** | 0.90 | 0.57 | 0.96 | 0.99 | 0.90 | ~0.98 |
| basic-pitch | 0.06 | 0.06 | 0.61 | 0.77 | 0.35 | 0.27 |

(full method + numbers: `research/synth-voice-separation/RESULTS.md`)

## Setup (one time)

```bash
python tab-studio/server/setup_yourmt3.py        # GPU (cu124); add --cpu for CPU wheels
```

This clones the model code, makes an isolated venv, and downloads the 561 MB checkpoint
into `tab-studio/server/yourmt3/`. After that the app auto-detects it and the
`/api/health` response shows `"transcriber": "yourmt3"`.

Override locations / force the old engine with env vars:

| var | meaning |
|---|---|
| `STUDIO_YOURMT3_DIR` | install dir (default `tab-studio/server/yourmt3`) |
| `STUDIO_YOURMT3_PYTHON` | python for the YourMT3 venv (default `<dir>/.venv`) |
| `STUDIO_TRANSCRIBER` | `yourmt3` (default) or `basicpitch` to force the fallback |
| `STUDIO_YOURMT3_TIMEOUT` | per-call subprocess timeout, seconds (default 1800) |

If YourMT3 is not installed, the app **transparently falls back to basic-pitch** — nothing
else is required.

## How it's wired

- Runs **out-of-process** in its own venv (`yourmt3_backend.py` shells out), so the main
  app venv stays small and the model's heavy deps don't mix with it.
- `transcribe` / `song-to-midi` run YourMT3 on the audio and filter to the requested
  instrument by GM program. Because YourMT3 is strongest on a full mix, `song-to-midi`
  transcribes the **whole song** and extracts the instrument (no per-stem Demucs needed).
- `song-to-multitrack` (new) runs one pass → `bass/guitar/piano/keys` MIDIs + a combined
  `yourmt3_multi.mid`, plus ADTOF drums from the Demucs drum stem.

## ⚠️ License

YourMT3 is **GPL-3.0**. It is intentionally kept as a **separately-installed, out-of-process
tool** (not bundled, not imported in-process) so the app itself is not a derivative work.
**Before shipping YourMT3 inside the packaged desktop app, review the GPL-3.0 obligations** —
distributing the model code/weights with a proprietary app would impose them. The default
distribution should ship without it (basic-pitch fallback) unless that review is done.
