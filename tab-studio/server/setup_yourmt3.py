"""One-time setup for the YourMT3+ transcription backend.

Installs the (GPL-3.0) YourMT3 model code + weights into a self-contained directory and
its own venv, so the main app venv stays small and the GPL code stays isolated.

  python tab-studio/server/setup_yourmt3.py [--dir DIR] [--cpu]

Steps:
  1. clone the HF Space code  (mimbres/YourMT3, code only — LFS skipped)
  2. copy the headless inference wrapper in
  3. create DIR/.venv and install deps (torch cu124 by default; --cpu for CPU wheels)
  4. download the 561 MB checkpoint via the HF resolve URL

After this, the app auto-detects the install (DIR defaults to tab-studio/server/yourmt3)
and uses YourMT3 as the default melodic transcriber. Override with STUDIO_YOURMT3_DIR.
"""
import argparse, os, shutil, subprocess, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPACE = "https://huggingface.co/spaces/mimbres/YourMT3"
CKPT_REL = ("amt/logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops"
            "/checkpoints/last.ckpt")
CKPT_URL = f"{SPACE}/resolve/main/{CKPT_REL}"
CKPT_SIZE = 561544628
DEPS = ["numpy==1.26.4", "transformers==4.45.1", "lightning>=2.2.1", "einops", "mido",
        "deprecated", "python-dotenv", "librosa", "pretty_midi", "soundfile", "pyyaml",
        "mir_eval", "wandb"]


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(HERE / "yourmt3"))
    ap.add_argument("--cpu", action="store_true", help="install CPU torch instead of cu124")
    args = ap.parse_args()
    d = Path(args.dir).resolve()

    # 1. clone code (skip LFS blobs; allow long Windows paths)
    if not (d / "amt").is_dir():
        run(["git", "config", "--global", "core.longpaths", "true"])
        env = dict(os.environ, GIT_LFS_SKIP_SMUDGE="1")
        run(["git", "clone", "--depth", "1", SPACE, str(d)], env=env)

    # 2. wrapper
    shutil.copy(str(HERE / "yourmt3_infer.py"), str(d / "infer_headless.py"))

    # 3. venv + deps
    venv = d / ".venv"
    if not venv.is_dir():
        run([sys.executable, "-m", "venv", str(venv)])
    py = str(venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
    run([py, "-m", "pip", "install", "--upgrade", "pip", "-q"])
    if args.cpu:
        run([py, "-m", "pip", "install", "-q", "torch==2.6.0", "torchaudio==2.6.0"])
    else:
        run([py, "-m", "pip", "install", "-q", "torch==2.6.0", "torchaudio==2.6.0",
             "--index-url", "https://download.pytorch.org/whl/cu124"])
    run([py, "-m", "pip", "install", "-q", *DEPS])

    # 4. checkpoint
    ckpt = d / CKPT_REL
    ckpt.parent.mkdir(parents=True, exist_ok=True)
    if not (ckpt.is_file() and ckpt.stat().st_size == CKPT_SIZE):
        print(f"  downloading checkpoint (561 MB) -> {ckpt}")
        urllib.request.urlretrieve(CKPT_URL, str(ckpt))
    ok = ckpt.is_file() and ckpt.stat().st_size == CKPT_SIZE
    print(f"\nDone. checkpoint={'ok' if ok else 'MISSING/!size'}  install_dir={d}")
    print("The app will now use YourMT3 as the default melodic transcriber.")


if __name__ == "__main__":
    main()
