"""Live Whiteboard POC server.

Run:  uv run uvicorn server:app --port 8010
Open: http://localhost:8010            (live, uses the OpenAI API)
      http://localhost:8010/?replay=latest   (replays the newest recorded run, no API calls)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv(Path(__file__).parent / ".env")

from whiteboard.session import Session, list_runs  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("openai").setLevel(logging.WARNING)

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="Live Whiteboard")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    # Browsers otherwise keep old app.js/board.js after edits (no build step, no hashed names).
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response
session: Session | None = None


def get_session() -> Session:
    global session
    if session is None:
        session = Session()
    return session


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/state")
async def state() -> dict:
    return get_session().snapshot()


@app.get("/api/runs")
async def runs() -> list[dict]:
    return list_runs()


async def handle_command(msg: dict) -> dict:
    s = get_session()
    cmd = msg.get("cmd")
    if cmd == "start":
        return await s.start(msg.get("mode", "live"), msg.get("run"), msg.get("speed"))
    if cmd == "pause":
        await s.pause()
    elif cmd == "resume":
        await s.resume()
    elif cmd == "speed":
        await s.set_speed(float(msg.get("speed", 1)))
    elif cmd == "reset":
        await s.reset()
    else:
        return {"ok": False, "error": f"unknown cmd {cmd!r}"}
    return {"ok": True}


@app.post("/api/control")
async def control(msg: dict = Body(...)) -> dict:
    return await handle_command(msg)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    s = get_session()
    s.clients.add(ws)
    await ws.send_text(json.dumps(s.snapshot(), ensure_ascii=False, default=str))
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            result = await handle_command(msg)
            if not result.get("ok"):
                await ws.send_text(json.dumps({"type": "error", "error": result.get("error")}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        get_session().clients.discard(ws)
