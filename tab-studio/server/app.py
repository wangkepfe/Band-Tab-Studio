"""
Bass Studio backend — FastAPI.

Runs SOTA models locally and serves the static editor from one origin:
  * Demucs v4          — isolate instrument stems from a full song.
  * YourMT3+ (default)  — multi-instrument transcription (synths/bass/guitar/keys);
                          validated 10-16x better than basic-pitch on synths. Optional,
                          out-of-process; see setup_yourmt3.py. Falls back to basic-pitch.
  * Spotify basic-pitch — transcription fallback when YourMT3 is not installed.
  * ADTOF (neural) / librosa — drum transcription → drums.json + drums.mid.

Endpoints (all under /api):
  GET  /api/health                         -> model availability + device
  POST /api/jobs   (multipart)             -> {job_id}; runs in a background thread
        fields: file, pipeline, stem, model, min_freq, max_freq, min_note_len,
                onset_threshold, frame_threshold, shifts
        pipeline values:
          song-to-midi  (=song-to-bass)  — YourMT3+ on the full song, extract `stem`
                                            (falls back to Demucs `stem` + basic-pitch)
          song-to-multitrack              — YourMT3+ on the full song → bass/guitar/piano/
                                            keys MIDIs at once + ADTOF drums
          separate                        — Demucs only
          transcribe                      — YourMT3+ (or basic-pitch) on the given audio
          song-to-drums                   — Demucs drums + ADTOF
          drum-transcribe                 — ADTOF only (input = drum stem/audio)
  GET  /api/jobs/{id}                       -> {status, stage, progress, elapsed, error, artifacts}
  GET  /api/jobs/{id}/artifacts/{name}      -> stem.wav | notes.mid | drums.json | drums.mid

Static:
  /        -> the editor   (tab-studio/web, served at the root)

Heavy deps (demucs, basic-pitch, torch) are imported lazily so the server still
starts — and /api/health still reports — when they are not installed yet.

Run:  cd tab-studio/server  &&  uvicorn app:app --port 8000
"""
import os
import re
import sys
import json
import time
import uuid
import shutil
import tempfile
import threading
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

import yourmt3_backend  # YourMT3+ default melodic transcriber (subprocess; basic-pitch fallback)

HERE = Path(__file__).resolve().parent
WEB_DIR = (HERE.parent / "web").resolve()
ROOT_DIR = (HERE.parent.parent).resolve()          # repo root
PROJECTS_DIR = ROOT_DIR / "projects"                # the project library (committed) — this app edits it in place
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
WORK_DIR = Path(tempfile.gettempdir()) / "tab-studio-jobs"
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Bass Studio")

# Local desktop app: uvicorn binds 127.0.0.1 and serves the SPA + API same-origin,
# so the backend is reachable only from this machine. CORS is limited to the
# loopback origins the app is served from. There is no public exposure, auth, or
# tunnel any more (that was removed in the web/desktop redesign — see README).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["*"], allow_headers=["*"],
)

# Robustness knobs for the local pipeline (safe defaults; rarely need changing).
MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_MAX_UPLOAD_MB", "1024")) * 1024 * 1024
DEMUCS_TIMEOUT = int(os.environ.get("STUDIO_DEMUCS_TIMEOUT", "1800"))   # 30 min
YT_TIMEOUT = int(os.environ.get("STUDIO_YT_TIMEOUT", "600"))           # 10 min


def _safe_ext(filename, default=".wav"):
    """A sanitized file extension (alnum, short) from an untrusted upload name."""
    ext = Path(filename or "").suffix.lower()
    return ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else default


def _save_upload(upload, dst, max_bytes=MAX_UPLOAD_BYTES):
    """Stream an UploadFile to disk, aborting (and deleting) if it exceeds
    max_bytes — an unbounded write would let a public endpoint fill the disk."""
    written = 0
    with open(dst, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                try:
                    f.close()
                    os.remove(dst)
                except OSError:
                    pass
                raise HTTPException(413, "file too large (max %d MB)" % (max_bytes // (1024 * 1024)))
            f.write(chunk)
    return written


@app.middleware("http")
async def static_no_cache(request, call_next):
    """Without Cache-Control, Chrome heuristically caches the editor pages and
    keeps serving stale copies after edits; no-cache forces revalidation (cheap
    304s via StaticFiles' Last-Modified) while API responses stay untouched."""
    response = await call_next(request)
    if not request.url.path.lower().startswith("/api"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response

# -----------------------------------------------------------------------------
# job registry (in-memory; fine for a single-user local tool)
# -----------------------------------------------------------------------------
JOBS = {}            # id -> dict
JOBS_LOCK = threading.Lock()


def _new_job():
    jid = uuid.uuid4().hex[:12]
    d = WORK_DIR / jid
    d.mkdir(parents=True, exist_ok=True)
    job = {"id": jid, "status": "queued", "stage": "queued", "progress": 0.0,
           "started": time.time(), "error": None, "artifacts": [], "dir": str(d)}
    with JOBS_LOCK:
        JOBS[jid] = job
    return job


def _set(job, **kw):
    with JOBS_LOCK:
        job.update(kw)


def _art_kind(name):
    if name.endswith(".mid"):
        return "midi"
    if name.endswith(".json"):
        return "json"
    return "audio"


def _public(job):
    return {
        "id": job["id"], "status": job["status"], "stage": job["stage"],
        "progress": job["progress"], "elapsed": round(time.time() - job["started"], 1),
        "error": job["error"], "title": job.get("title"),
        "artifacts": [{"name": a, "kind": _art_kind(a)} for a in job["artifacts"]],
    }


# -----------------------------------------------------------------------------
# model availability
# -----------------------------------------------------------------------------
def _have(mod):
    import importlib.util
    return importlib.util.find_spec(mod) is not None


def _device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


# -----------------------------------------------------------------------------
# pipelines
# -----------------------------------------------------------------------------
ALLOWED_STEMS = {"bass", "drums", "vocals", "other", "piano", "guitar"}
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft", "htdemucs_6s", "mdx", "mdx_extra", "mdx_q", "mdx_extra_q"}
SIX_STEM = {"piano", "guitar"}          # only htdemucs_6s has these sources

# GM drum map (channel 10 / program 0 percussion)
GM_DRUM = {
    "kick":       36,   # Bass Drum 1
    "snare":      38,   # Acoustic Snare
    "hihat":      42,   # Closed Hi-Hat
    "hihat_open": 46,   # Open Hi-Hat
    "crash":      49,   # Crash Cymbal 1
    "ride":       51,   # Ride Cymbal 1
    "tom1":       48,   # Hi-Mid Tom
    "tom2":       45,   # Low-Mid Tom
    "floor_tom":  41,   # Low Floor Tom
}

# --- ADTOF neural drum transcription ---------------------------------------
# 5-class CRNN (Zehren et al.), torch-only port (github.com/xavriley/ADTOF-pytorch),
# vendored under ./adtof_pytorch. Validated on MDB Drums at F≈0.90 on a Demucs drum
# stem vs ≈0.60 for the old librosa fallback (see ../../research/RESULTS.md).
# Its LABELS_5 GM notes map onto the app's event `type` strings (drum-tab-core LANES).
ADTOF_GM_TO_TYPE = {35: "kick", 38: "snare", 47: "tom2", 42: "hihat", 49: "crash"}
_ADTOF = None
_ADTOF_LOCK = threading.Lock()


def _adtof_model():
    """Lazily build + cache the ADTOF model + device (thread-safe)."""
    global _ADTOF
    if _ADTOF is None:
        with _ADTOF_LOCK:
            if _ADTOF is None:
                import torch
                import adtof_pytorch as ap
                dev = "cuda" if torch.cuda.is_available() else "cpu"
                model = ap.create_frame_rnn_model(ap.calculate_n_bins())
                model.eval()
                w = ap.get_default_weights_path()
                if w:
                    model = ap.load_pytorch_weights(model, str(w), strict=False)
                model.to(dev)
                _ADTOF = (model, dev, ap)
    return _ADTOF


def _adtof_transcribe(audio_path):
    """Run ADTOF on an audio file -> [{time_sec, type, velocity}] (velocity filled later)."""
    import torch
    import numpy as np
    model, dev, ap = _adtof_model()
    x = ap.load_audio_for_model(str(audio_path)).to(dev)
    with torch.no_grad():
        pred = model(x).cpu().numpy()
    picker = ap.PeakPicker(thresholds=ap.FRAME_RNN_THRESHOLDS, fps=100)
    peaks = picker.pick(pred, labels=ap.LABELS_5, label_offset=0)[0]   # {gm_note: [times]}
    events = []
    for gm, times in peaks.items():
        dtype = ADTOF_GM_TO_TYPE.get(int(gm))
        if not dtype:
            continue
        for t in np.asarray(times, dtype=float).flatten():
            events.append({"time_sec": float(t), "type": dtype, "velocity": 100})
    return events


def resolve_model(stem, model):
    if stem in SIX_STEM:
        return "htdemucs_6s"            # piano/guitar require the 6-source model
    return model or "htdemucs"


def run_separate(job, in_path, stem, model, shifts="2"):
    """Demucs --two-stems=<stem> via the CLI (robust across versions).

    `shifts` = random-shift test-time augmentation (better SDR, ~linear slowdown;
    cheap on a capable GPU). `--overlap 0.5` also lifts quality a touch.
    """
    model = resolve_model(stem, model)
    try:
        nshift = max(0, min(4, int(float(shifts))))   # clamp: shifts scale runtime ~linearly
    except (TypeError, ValueError):
        nshift = 2
    _set(job, status="running",
         stage="separating " + stem + " (Demucs " + model + ", shifts=" + str(nshift) + ")…", progress=0.0)
    out = Path(job["dir"]) / "demucs"
    out.mkdir(exist_ok=True)
    cmd = [sys.executable, "-m", "demucs", "--two-stems", stem, "-n", model,
           "--shifts", str(nshift), "--overlap", "0.5", "-o", str(out), str(in_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=DEMUCS_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Demucs timed out after %ds" % DEMUCS_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError("Demucs failed: " + (proc.stderr or proc.stdout or "unknown error")[-600:])
    # demucs writes  <out>/<model>/<track>/<stem>.wav
    found = list(out.glob("**/" + stem + ".wav"))
    if not found:
        raise RuntimeError("Demucs produced no '" + stem + "' stem (output not found).")
    dst = Path(job["dir"]) / "stem.wav"
    shutil.copyfile(found[0], dst)
    arts = job["artifacts"] + ["stem.wav"]
    _set(job, artifacts=list(dict.fromkeys(arts)), progress=1.0)
    return dst


def run_transcribe(job, audio_path, min_freq, max_freq, min_note_len, onset="", frame="", instrument=None):
    """Transcribe audio -> notes.mid.

    Default engine is YourMT3+ (multi-instrument SOTA; validated 10-16x better than
    basic-pitch on synths — research/synth-voice-separation/RESULTS.md). It is run on
    the given audio and filtered to `instrument` by GM program. If YourMT3 is not
    installed (or STUDIO_TRANSCRIBER=basicpitch), we fall back to Spotify basic-pitch.

    basic-pitch: lower onset_threshold / frame_threshold = more (and softer) notes —
    useful for polyphonic piano, at the cost of a few more spurious notes to clean up.
    """
    mid = Path(job["dir"]) / "notes.mid"
    if yourmt3_backend.available():
        try:
            _set(job, status="running", stage="transcribing to MIDI (YourMT3+)…", progress=0.05)
            raw = Path(job["dir"]) / "yourmt3_raw.mid"
            yourmt3_backend.transcribe(audio_path, raw)
            yourmt3_backend.extract_instrument(
                raw, mid, instrument, int(float(min_note_len)) if min_note_len else 60)
            arts = job["artifacts"] + ["notes.mid"]
            _set(job, artifacts=list(dict.fromkeys(arts)), progress=1.0)
            return mid
        except Exception as e:  # noqa: BLE001 — degrade gracefully to basic-pitch
            _set(job, stage="YourMT3 unavailable (%s); using basic-pitch…" % str(e)[:120])

    _set(job, status="running", stage="transcribing to MIDI (basic-pitch)…", progress=0.0)
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH
    _, midi_data, _ = predict(
        str(audio_path), ICASSP_2022_MODEL_PATH,
        onset_threshold=float(onset) if onset else 0.5,
        frame_threshold=float(frame) if frame else 0.3,
        minimum_frequency=float(min_freq) if min_freq else None,
        maximum_frequency=float(max_freq) if max_freq else None,
        minimum_note_length=float(min_note_len) if min_note_len else 80.0,
    )
    mid = Path(job["dir"]) / "notes.mid"
    midi_data.write(str(mid))
    arts = job["artifacts"] + ["notes.mid"]
    _set(job, artifacts=list(dict.fromkeys(arts)), progress=1.0)
    return mid


def _events_to_drum_midi(events, path, tempo=120.0):
    """Write drum events to a GM MIDI file (channel 10) using pretty_midi."""
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(initial_tempo=float(tempo))
    drums = pretty_midi.Instrument(program=0, is_drum=True)
    for ev in sorted(events, key=lambda e: e["time_sec"]):
        note_num = GM_DRUM.get(ev.get("type", "snare"), 38)
        vel = max(1, min(127, int(ev.get("velocity", 100))))
        start = float(ev["time_sec"])
        note = pretty_midi.Note(velocity=vel, pitch=note_num, start=start, end=start + 0.05)
        drums.notes.append(note)
    pm.instruments.append(drums)
    pm.write(str(path))


def _librosa_drum_transcribe(y, sr):
    """Band-pass onset detection fallback when ADTLib is unavailable."""
    import numpy as np
    import librosa
    from scipy.signal import butter, sosfilt

    events = []
    nyq = sr / 2

    def band_onset(lo_hz, hi_hz, wait_ms=40, delta=0.05):
        lo_n = max(0.002, lo_hz / nyq)
        hi_n = min(0.998, hi_hz / nyq)
        if lo_n >= hi_n:
            return np.array([])
        sos = butter(4, [lo_n, hi_n], btype="band", output="sos")
        y_b = sosfilt(sos, y)
        wait_frames = max(1, int(wait_ms * sr / (512 * 1000)))
        frames = librosa.onset.onset_detect(
            y=y_b, sr=sr, hop_length=512,
            pre_max=3, post_max=3, pre_avg=5, post_avg=5,
            delta=delta, wait=wait_frames,
        )
        return librosa.frames_to_time(frames, sr=sr, hop_length=512)

    for dtype, lo, hi, wait, delta in [
        ("kick",  40,    200,   60, 0.06),
        ("snare", 200,   8000,  40, 0.05),
        ("hihat", 6000,  20000, 25, 0.04),
    ]:
        for t in band_onset(lo, hi, wait, delta):
            events.append({"time_sec": float(t), "type": dtype, "velocity": 100})
    return events


def run_drum_transcribe(job, audio_path):
    """ADTLib (with librosa fallback) → drums.json + drums.mid."""
    import json
    import numpy as np
    import librosa

    _set(job, status="running", stage="loading drum audio…", progress=0.05)
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    duration = float(len(y) / sr)

    tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.round(float(np.atleast_1d(tempo_arr)[0]), 1))

    # --- drum transcription ----------------------------------------------------
    # Primary: ADTOF neural model (5-class CRNN). Fallback: librosa band-pass onset.
    method = "librosa"
    events = []
    try:
        _set(job, stage="transcribing drums (ADTOF)…", progress=0.15)
        events = _adtof_transcribe(audio_path)
        method = "adtof"
    except Exception as e:  # noqa: BLE001 — degrade gracefully to the DSP fallback
        _set(job, stage="transcribing drums (librosa fallback: %s)…" % type(e).__name__,
             progress=0.15)
        events = _librosa_drum_transcribe(y, sr)
        method = "librosa"

    # --- velocity estimation from local RMS ------------------------------------
    win = int(0.025 * sr)
    for ev in events:
        s = int(ev["time_sec"] * sr)
        chunk = y[s: s + win]
        if len(chunk) > 0:
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            ev["velocity"] = min(127, max(30, int(rms * 1800 + 35)))

    events = sorted(events, key=lambda e: e["time_sec"])

    # --- save JSON -------------------------------------------------------------
    _set(job, stage="saving results…", progress=0.85)
    payload = {"events": events, "tempo": tempo, "duration": duration,
               "method": method}
    out_json = Path(job["dir"]) / "drums.json"
    out_json.write_text(json.dumps(payload))

    # --- save MIDI -------------------------------------------------------------
    out_mid = Path(job["dir"]) / "drums.mid"
    _events_to_drum_midi(events, out_mid, tempo)

    arts = job["artifacts"] + ["drums.json", "drums.mid"]
    if Path(job["dir"]).joinpath("stem.wav").exists():
        arts = list(dict.fromkeys(["stem.wav"] + arts))
    _set(job, artifacts=list(dict.fromkeys(arts)), progress=1.0)
    return out_json


def run_youtube(job, url):
    """yt-dlp: download a video's audio and convert it to mp3 (artifact song.mp3).

    Needs ffmpeg on PATH for the mp3 transcode (already required by Demucs)."""
    _set(job, status="running", stage="downloading audio (yt-dlp)…", progress=0.15)
    out_tmpl = str(Path(job["dir"]) / "song.%(ext)s")
    title_file = Path(job["dir"]) / "title.txt"
    cmd = [sys.executable, "-m", "yt_dlp", "-x", "--audio-format", "mp3",
           "--audio-quality", "0", "--no-playlist", "--no-warnings",
           "--print-to-file", "%(title)s", str(title_file),
           "-o", out_tmpl, url]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=YT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError("yt-dlp timed out after %ds" % YT_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError("yt-dlp failed: " + (proc.stderr or proc.stdout or "unknown error")[-600:])
    dst = Path(job["dir"]) / "song.mp3"
    if not dst.exists():                                  # forced mp3, but be defensive
        alt = list(Path(job["dir"]).glob("song.*"))
        if not alt:
            raise RuntimeError("yt-dlp produced no audio file.")
        alt[0].rename(dst)
    if title_file.exists():
        try:
            _set(job, title=title_file.read_text(encoding="utf-8", errors="ignore").strip())
        except Exception:
            pass
    arts = job["artifacts"] + ["song.mp3"]
    _set(job, artifacts=list(dict.fromkeys(arts)), progress=1.0)
    return dst


def yt_worker(job, url):
    try:
        run_youtube(job, url)
        _set(job, status="done", stage="done", progress=1.0)
    except Exception as e:  # noqa: BLE001
        _set(job, status="error", stage="error", error=str(e))


def run_multitrack(job, in_path, model="htdemucs_6s", shifts="2"):
    """YourMT3+ on the full song -> a combined multi-instrument MIDI plus per-instrument
    melodic MIDIs (bass / guitar / piano / keys-and-synths), plus ADTOF drums from the
    Demucs drum stem. One transcription pass yields all the pitched voices as separate
    tracks — the validated 'On the Fly' workflow, in-app."""
    if not yourmt3_backend.available():
        raise RuntimeError("song-to-multitrack needs YourMT3 (run setup_yourmt3.py)")
    import pretty_midi
    _set(job, status="running", stage="transcribing all instruments (YourMT3+)…", progress=0.1)
    raw = Path(job["dir"]) / "yourmt3_multi.mid"
    yourmt3_backend.transcribe(in_path, raw)
    arts = job["artifacts"] + ["yourmt3_multi.mid"]
    for inst_name in ("bass", "guitar", "piano", "keys"):
        out = Path(job["dir"]) / (inst_name + ".mid")
        yourmt3_backend.extract_instrument(raw, out, inst_name)
        if pretty_midi.PrettyMIDI(str(out)).instruments[0].notes:
            arts.append(inst_name + ".mid")
        else:
            out.unlink(missing_ok=True)
    _set(job, artifacts=list(dict.fromkeys(arts)), progress=0.7)
    try:  # drums via ADTOF on the isolated drum stem (best drum method)
        drum_audio = run_separate(job, in_path, "drums", model, shifts)
        run_drum_transcribe(job, drum_audio)
    except Exception as e:  # noqa: BLE001 — drums are best-effort here
        _set(job, stage="drums skipped (%s)" % str(e)[:80])
    _set(job, progress=1.0)


def worker(job, in_path, pipeline, stem, model, min_freq, max_freq, min_note_len, onset, frame, shifts):
    try:
        if pipeline == "separate":
            run_separate(job, in_path, stem, model, shifts)
        elif pipeline == "transcribe":
            run_transcribe(job, in_path, min_freq, max_freq, min_note_len, onset, frame, instrument=stem)
        elif pipeline == "drum-transcribe":
            run_drum_transcribe(job, in_path)
        elif pipeline == "song-to-drums":
            audio = run_separate(job, in_path, "drums", model, shifts)
            run_drum_transcribe(job, audio)
        elif pipeline == "song-to-multitrack":
            run_multitrack(job, in_path, model, shifts)
        else:  # song-to-midi (song-to-bass kept as an alias)
            if yourmt3_backend.available():
                # YourMT3 is strongest on the full mix — transcribe the song directly and
                # pull out the requested instrument (no per-stem Demucs needed).
                run_transcribe(job, in_path, min_freq, max_freq, min_note_len, onset, frame, instrument=stem)
            else:
                audio = run_separate(job, in_path, stem, model, shifts)
                run_transcribe(job, audio, min_freq, max_freq, min_note_len, onset, frame)
        _set(job, status="done", stage="done", progress=1.0)
    except Exception as e:  # noqa: BLE001 — report any failure to the UI
        _set(job, status="error", stage="error", error=str(e))


# -----------------------------------------------------------------------------
# API routes  (declared BEFORE the static mounts so they take precedence)
# -----------------------------------------------------------------------------
@app.get("/api/health")
def health():
    ymt3 = yourmt3_backend.available()
    return {
        "ok": True,
        "demucs": _have("demucs"),
        "basic_pitch": _have("basic_pitch"),
        "adtof": _have("adtof_pytorch"),
        "yt_dlp": _have("yt_dlp"),
        "yourmt3": ymt3,
        "transcriber": "yourmt3" if ymt3 else "basic-pitch",
        "device": _device(),
    }


@app.post("/api/youtube")
async def create_youtube_job(url: str = Form(...)):
    if not _have("yt_dlp"):
        raise HTTPException(503, "yt-dlp is not installed (pip install yt-dlp).")
    u = (url or "").strip()
    if not (u.startswith("http://") or u.startswith("https://")):
        raise HTTPException(400, "Provide a full http(s) link.")
    job = _new_job()
    t = threading.Thread(target=yt_worker, args=(job, u), daemon=True)
    t.start()
    return {"job_id": job["id"]}


@app.post("/api/jobs")
async def create_job(
    file: UploadFile = File(...),
    pipeline: str = Form("song-to-midi"),
    stem: str = Form("bass"),
    model: str = Form("htdemucs"),
    min_freq: str = Form("30"),
    max_freq: str = Form("400"),
    min_note_len: str = Form("80"),
    onset_threshold: str = Form(""),
    frame_threshold: str = Form(""),
    shifts: str = Form("2"),
):
    DRUM_PIPELINES = {"song-to-drums", "drum-transcribe"}
    VALID_PIPELINES = {"song-to-midi", "song-to-bass", "separate", "transcribe",
                       "song-to-multitrack"} | DRUM_PIPELINES
    if pipeline not in VALID_PIPELINES:
        raise HTTPException(400, "unknown pipeline")
    if stem not in ALLOWED_STEMS:
        raise HTTPException(400, "unknown stem '%s'" % stem)
    if model not in ALLOWED_MODELS:
        raise HTTPException(400, "unknown model '%s'" % model)
    ymt3 = yourmt3_backend.available()
    # YourMT3 transcribes the full song directly, so the melodic paths only fall back to
    # Demucs + basic-pitch when YourMT3 is unavailable.
    needs_demucs = pipeline in ("separate", "song-to-drums") or (
        pipeline in ("song-to-midi", "song-to-bass") and not ymt3)
    needs_bp = pipeline in ("song-to-midi", "song-to-bass", "transcribe") and not ymt3
    if pipeline == "song-to-multitrack" and not ymt3:
        raise HTTPException(503, "song-to-multitrack requires YourMT3 (run setup_yourmt3.py).")
    if needs_demucs and not _have("demucs"):
        raise HTTPException(503, "Demucs is not installed (pip install -r requirements.txt).")
    if needs_bp and not _have("basic_pitch"):
        raise HTTPException(503, "basic-pitch is not installed (pip install -r requirements.txt).")

    job = _new_job()
    in_path = Path(job["dir"]) / ("input" + _safe_ext(file.filename))
    # Off the event loop (a 200MB upload would otherwise stall job polling); clean
    # up the just-registered job + temp dir if the upload is rejected (e.g. 413).
    try:
        await run_in_threadpool(_save_upload, file, in_path)
    except Exception:
        with JOBS_LOCK:
            JOBS.pop(job["id"], None)
        shutil.rmtree(job["dir"], ignore_errors=True)
        raise

    t = threading.Thread(target=worker,
                         args=(job, in_path, pipeline, stem, model, min_freq, max_freq,
                               min_note_len, onset_threshold, frame_threshold, shifts),
                         daemon=True)
    t.start()
    return {"job_id": job["id"]}


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "no such job")
    return _public(job)


@app.get("/api/jobs/{jid}/artifacts/{name}")
def job_artifact(jid: str, name: str):
    job = JOBS.get(jid)
    if not job or name not in job["artifacts"]:
        raise HTTPException(404, "no such artifact")
    # Defense-in-depth: resolve + contain within the job dir (parity with the
    # project-audio guard) rather than trusting the artifacts-list invariant alone.
    base = Path(job["dir"]).resolve()
    path = (base / name).resolve()
    try:
        inside = os.path.commonpath([str(base), str(path)]) == str(base)
    except ValueError:
        inside = False
    if not inside or not path.is_file():
        raise HTTPException(404, "artifact missing on disk")
    media = ({".mid": "audio/midi", ".mp3": "audio/mpeg", ".wav": "audio/wav",
              ".json": "application/json"}).get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(str(path), media_type=media, filename=name)


# -----------------------------------------------------------------------------
# projects  (the app's "database": each project = a folder under PROJECTS_DIR with
# project.json + song/stem audio). A project bundles a YouTube link, the song
# audio, isolated stems, editable MIDI/drum tracks, and per-track view options.
# -----------------------------------------------------------------------------
def _safe_pid(pid):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pid or ""):
        raise HTTPException(400, "bad project id")
    return pid


def _proj_dir(pid):
    return PROJECTS_DIR / _safe_pid(pid)


def _read_meta(d):
    try:
        return json.loads((d / "project.json").read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(d, obj):
    """Write project.json atomically so a crash mid-write can't destroy a saved
    project (write to a temp file in the same dir, then os.replace)."""
    tmp = d / ("project.json.tmp." + uuid.uuid4().hex[:8])
    tmp.write_text(json.dumps(obj), encoding="utf-8")
    os.replace(str(tmp), str(d / "project.json"))


# projects/ IS the project library: one committed folder of projects/<id>/project.json
# that this backend reads and writes in place (auto-save persists here) and that the
# web build ships. There is no separate "seed"/"example" type and no first-run copy —
# editing a project here is what gets released.


@app.get("/api/projects")
def list_projects():
    out = []
    if PROJECTS_DIR.is_dir():
        for d in PROJECTS_DIR.iterdir():
            if not d.is_dir():
                continue
            meta = _read_meta(d)
            if not meta:
                continue
            tracks = meta.get("tracks", []) or []
            out.append({
                "id": meta.get("id", d.name),
                "name": meta.get("name", d.name),
                "updated": meta.get("updated", 0),
                "youtubeUrl": meta.get("youtubeUrl", ""),
                "hasSong": bool(meta.get("song")),
                "instruments": [t.get("instrument") for t in tracks],
                "trackCount": len(tracks),
            })
    out.sort(key=lambda x: x.get("updated", 0), reverse=True)
    return {"projects": out}


@app.post("/api/projects")
async def create_project(name: str = Form("Untitled")):
    pid = uuid.uuid4().hex[:12]
    d = _proj_dir(pid)
    (d / "stems").mkdir(parents=True, exist_ok=True)
    # tempo / ppq / time-sig live per-track (the client owns them); the project
    # document is just id/name/youtubeUrl/song/tracks/activeTrackId.
    meta = {"id": pid, "name": (name or "Untitled").strip() or "Untitled",
            "youtubeUrl": "", "song": None, "tracks": [],
            "activeTrackId": None, "updated": time.time()}
    _write_meta(d, meta)
    return {"id": pid, "project": meta}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    d = _proj_dir(pid)
    meta = _read_meta(d) if d.is_dir() else None
    if not meta:
        raise HTTPException(404, "no such project")
    return meta


@app.put("/api/projects/{pid}")
async def save_project(pid: str, request: Request):
    d = _proj_dir(pid)
    if not d.is_dir():
        raise HTTPException(404, "no such project")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "project body must be an object")
    body["id"] = pid
    body["updated"] = time.time()
    _write_meta(d, body)
    return {"ok": True, "updated": body["updated"]}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    d = _proj_dir(pid)
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


@app.post("/api/projects/{pid}/audio")
async def upload_project_audio(pid: str, file: UploadFile = File(...),
                               role: str = Form("stem"), instrument: str = Form("")):
    """Store the song (role=song) or a stem (role=stem, instrument=bass/drums/…)
    inside the project folder. Returns the relative path stored in project.json."""
    d = _proj_dir(pid)
    if not d.is_dir():
        raise HTTPException(404, "no such project")
    ext = _safe_ext(file.filename)
    if role == "song":
        rel = "song" + ext
    else:
        inst = re.sub(r"[^a-z0-9]+", "", (instrument or "stem").lower()) or "stem"
        rel = "stems/" + inst + ext
    dst = d / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    await run_in_threadpool(_save_upload, file, dst)
    return {"file": rel}


@app.get("/api/projects/{pid}/audio/{name:path}")
def get_project_audio(pid: str, name: str):
    d = _proj_dir(pid).resolve()
    target = (d / name).resolve()
    try:
        inside = os.path.commonpath([str(d), str(target)]) == str(d)
    except ValueError:                       # different drive/anchor (Windows) → not inside
        inside = False
    if not inside or not target.is_file():
        raise HTTPException(404, "no such file")
    media = ({".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
              ".flac": "audio/flac", ".m4a": "audio/mp4"}).get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(str(target), media_type=media)


@app.get("/api")
def api_root():
    return JSONResponse({"name": "Studio API", "app": "/", "health": "/api/health"})


# Old entry points now live inside the single unified app — redirect for any
# stale bookmarks / .bat files.
@app.get("/studio")
@app.get("/studio/")
@app.get("/drums")
@app.get("/drums/")
def _legacy_redirect():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/")


# -----------------------------------------------------------------------------
# static mounts (LAST). The unified app (web/) is served at the root. The project
# library lives in projects/ and is exposed via the /api/projects routes above, not
# served as static assets.
# -----------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="app")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
