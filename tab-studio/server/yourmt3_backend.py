"""YourMT3+ transcription backend (the validated multi-instrument SOTA — beats
basic-pitch 10-16x on synths; see research/synth-voice-separation/RESULTS.md).

Run OUT-OF-PROCESS in a dedicated environment so the app venv stays small and the
GPL-3.0 YourMT3 code stays isolated in a separate process. The install is discovered
via env vars / conventional locations; if it is not present the app transparently
falls back to basic-pitch.

Setup once:  python tab-studio/server/setup_yourmt3.py   (clones code, makes a venv,
downloads the 561 MB checkpoint).  Override locations with:
    STUDIO_YOURMT3_DIR     directory containing infer_headless.py + amt/  (default: ./yourmt3)
    STUDIO_YOURMT3_PYTHON  python that can import the YourMT3 deps      (default: <dir>/.venv)
    STUDIO_TRANSCRIBER     'yourmt3' (default) or 'basicpitch' to force the old path
"""
import os
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
_CKPT_REL = ("amt/logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops"
             "/checkpoints/last.ckpt")
_TIMEOUT = int(os.environ.get("STUDIO_YOURMT3_TIMEOUT", "1800"))


def install_dir():
    """First directory that looks like a YourMT3 install, or None.
    Override with STUDIO_YOURMT3_DIR; default is ./yourmt3 (created by setup_yourmt3.py)."""
    cands = [os.environ.get("STUDIO_YOURMT3_DIR"), str(HERE / "yourmt3")]
    for c in cands:
        if c and (Path(c) / "infer_headless.py").is_file():
            return Path(c)
    return None


def _python(d):
    env = os.environ.get("STUDIO_YOURMT3_PYTHON")
    if env and Path(env).is_file():
        return env
    for p in (d / ".venv/Scripts/python.exe", d / ".venv/bin/python"):
        if p.is_file():
            return str(p)
    return None


def _checkpoint(d):
    return d / _CKPT_REL


def available():
    """True iff YourMT3 is installed AND not force-disabled via STUDIO_TRANSCRIBER."""
    if os.environ.get("STUDIO_TRANSCRIBER", "yourmt3").lower() == "basicpitch":
        return False
    d = install_dir()
    return bool(d and _python(d) and _checkpoint(d).is_file())


def transcribe(audio_path, out_midi):
    """Transcribe one audio file -> a multi-instrument MIDI written at out_midi.
    Raises on failure so callers can fall back to basic-pitch.
    """
    d = install_dir()
    if not d:
        raise RuntimeError("YourMT3 install not found")
    py = _python(d)
    if not py:
        raise RuntimeError("YourMT3 python/venv not found")
    name = "ymt3_" + Path(audio_path).stem
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
               WANDB_MODE="disabled", WANDB_CONSOLE="off", WANDB_SILENT="true")
    proc = subprocess.run([py, str(d / "infer_headless.py"), str(audio_path), name],
                          cwd=str(d), env=env, capture_output=True, text=True, timeout=_TIMEOUT)
    src = d / "model_output" / (name + ".mid")
    if proc.returncode != 0 or not src.is_file():
        tail = (proc.stderr or proc.stdout or "")[-800:]
        raise RuntimeError(f"YourMT3 inference failed (rc={proc.returncode}): {tail}")
    shutil.copy(str(src), str(out_midi))
    return out_midi


# GM program ranges per app "stem"/instrument, used to pull one instrument out of the
# multi-instrument YourMT3 output.  None -> keep everything pitched.
_PROGRAM_RANGES = {
    "bass":   range(32, 40),
    "guitar": range(24, 32),
    "piano":  range(0, 8),
    "keys":   list(range(16, 24)) + list(range(80, 104)),   # organ + synth lead/pad/fx
    "vocals": range(100, 104),
    "other":  None,
}


def extract_instrument(in_midi, out_midi, instrument=None, min_note_len_ms=60):
    """Filter a multi-instrument MIDI down to one instrument's notes (by GM program),
    flattened into a single melodic track at out_midi. Falls back to all pitched notes
    if the requested instrument yields nothing. Returns out_midi.
    """
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(in_midi))
    rng = _PROGRAM_RANGES.get((instrument or "other").lower(), None)
    keep, allp = [], []
    for ins in pm.instruments:
        if ins.is_drum:
            continue
        for n in ins.notes:
            allp.append(n)
            if rng is None or ins.program in rng:
                keep.append(n)
    notes = keep if keep else allp
    out = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0, name=(instrument or "transcription"))
    minlen = min_note_len_ms / 1000.0
    for n in sorted(notes, key=lambda x: (x.start, x.pitch)):
        inst.notes.append(pretty_midi.Note(velocity=max(1, min(127, n.velocity)),
                                            pitch=n.pitch, start=n.start,
                                            end=max(n.end, n.start + minlen)))
    out.instruments.append(inst)
    out.write(str(out_midi))
    return out_midi
