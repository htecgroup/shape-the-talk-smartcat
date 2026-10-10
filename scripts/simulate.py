"""Headless live run: replays the mock meeting through the real agents, saves a run, prints the boards.

uv run python scripts/simulate.py --speed 4
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from whiteboard.recording import RUNS_DIR  # noqa: E402
from whiteboard.session import Session  # noqa: E402


def describe(path: Path) -> None:
    run = json.loads(path.read_text())
    print("\n================ FINAL BOARDS ================")
    for b in run["final_board"]["boards"]:
        print(f"\n## {b['title']} ({b['kind']}, id={b['id']})")
        for n in b["nodes"].values():
            extra = f"  [{n['status']}: {n.get('note')}]" if n["status"] != "confirmed" else (f"  ({n['note']})" if n.get("note") else "")
            print(f"  - {n['id']:<22} {n['type']:<8} {n['label']}{extra}  <{n['by']} {n['src']}>")
        for e in b["edges"].values():
            extra = f"  [{e['status']}]" if e["status"] != "confirmed" else ""
            print(f"    {e['from']} -> {e['to']}" + (f"  '{e['label']}'" if e.get("label") else "") + extra)
    print("\n## Open questions")
    for q in run["questions"]:
        print(f"  - [{q['status']}] {q['question']} ({q['asked_by']} {q['src']}) {q.get('answer') or ''}")
    print("## Disagreements")
    for d in run["disagreements"]:
        print(f"  - [{d['status']}] {d['topic']}: " + " | ".join(f"{p['who']}: {p['position']}" for p in d["positions"]) + f"  => {d.get('resolution')}")
    print("\nlatency:", json.dumps(run["meta"]["latency"]))


async def main(speed: float) -> None:
    s = Session()
    await s.start("live", speed=speed)
    while s.status != "finished":
        await asyncio.sleep(0.5)
    await asyncio.sleep(0.2)
    describe(RUNS_DIR / s.run_file)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=4)
    ap.add_argument("--describe", help="only print an existing run file")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if a.describe:
        describe(Path(a.describe))
    else:
        asyncio.run(main(a.speed))
