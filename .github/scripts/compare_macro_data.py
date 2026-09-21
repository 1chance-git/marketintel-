# Used only by .github/workflows/macro-ticker.yml's commit step.
#
# macro_adapter.py's poll_once() always writes a fresh "generatedAt"
# timestamp into macro_data.json (see macro_adapter.py), so a plain
# byte/git diff on the whole file reports "changed" on every single
# scheduled run even when the real SPY/QQQ data is identical - defeating
# the point of a no-op check (every run would commit). This compares only
# the fields that actually matter (marketSession/instruments), ignoring
# generatedAt.
#
# Exit code 0 = meaningfully changed (commit it), 1 = unchanged (skip).
import json
import sys


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def meaningful(payload):
    if payload is None:
        return None
    return {"marketSession": payload.get("marketSession"), "instruments": payload.get("instruments")}


if __name__ == "__main__":
    prev_path, current_path = sys.argv[1], sys.argv[2]
    changed = meaningful(load(prev_path)) != meaningful(load(current_path))
    sys.exit(0 if changed else 1)
