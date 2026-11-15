#!/usr/bin/env bash
# One-command setup for SphereX (Mac, Linux or WSL; no GPU needed).
# Creates .venv with Python 3.11 and installs the pinned requirements. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for c in python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info[:2] != (3, 11))' 2>/dev/null; then PY=$c; break; fi
done
if [ -z "$PY" ]; then
  echo "ERROR: Python 3.11 not found." >&2
  echo "  Mac:          brew install python@3.11" >&2
  echo "  Ubuntu/WSL:   sudo apt install python3.11 python3.11-venv" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "==> creating .venv with $PY"
  "$PY" -m venv .venv
fi
echo "==> installing pinned requirements"
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt
.venv/bin/python -c 'import astropy, numpy, scipy, fastapi, certifi; assert astropy.__version__ == "7.2.0", astropy.__version__'
echo "OK: $(.venv/bin/python --version), astropy 7.2.0. Next: source .venv/bin/activate"
