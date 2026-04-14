"""
Shared test setup for games/football/tests/.

Adds the sibling source directories to sys.path so test modules can import
evolution/ and api/ code by plain module names:

    from ga import ...              # games/football/evolution/ga.py
    from physics_py import ...      # games/football/evolution/physics_py.py
    from fallback_py import ...     # games/football/evolution/fallback_py.py
    from build_warm_start import ...# games/football/evolution/build_warm_start.py
    import app as broker            # games/football/api/app.py

The source layout is unchanged; only the tests moved.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FOOTBALL = os.path.abspath(os.path.join(HERE, ".."))

for sub in ("evolution", "api"):
    path = os.path.join(FOOTBALL, sub)
    if path not in sys.path:
        sys.path.insert(0, path)
