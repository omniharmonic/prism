#!/bin/bash
set -euo pipefail
cd /Users/benjaminlife/dev/omniharmonic_agent
exec venv/bin/python scripts/omni_cli.py sweep-owed --context-only --commit
