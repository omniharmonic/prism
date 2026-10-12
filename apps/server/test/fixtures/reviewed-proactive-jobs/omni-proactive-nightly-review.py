#!/Users/benjaminlife/.hermes/hermes-agent/venv/bin/python
import os
from pathlib import Path
from dotenv import dotenv_values
repo=Path('/Users/benjaminlife/dev/omniharmonic_agent')
home=Path('/Users/benjaminlife/.hermes')
for file in (repo/'.env',home/'.env'):
    for key,value in dotenv_values(file).items():
        if value is not None: os.environ.setdefault(key,value)
os.chdir(repo/'scripts')
os.execv('/Users/benjaminlife/.hermes/hermes-agent/venv/bin/python',['/Users/benjaminlife/.hermes/hermes-agent/venv/bin/python', '-m', 'proactive_intelligence', '--state', '/Users/benjaminlife/dev/omniharmonic_agent/state/proactive.sqlite3', '--reason', '--live', '--hermes-path', '/Users/benjaminlife/.hermes/hermes-agent', '--hermes-python', '/Users/benjaminlife/.hermes/hermes-agent/venv/bin/python', '--model', 'gpt-5.6-sol', '--provider', 'openai-codex', '--routine', 'nightly-review'])
