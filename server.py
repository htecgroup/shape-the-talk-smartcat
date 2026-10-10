"""Live Whiteboard POC server.

Run:  uv run uvicorn server:app --port 8010
Open: http://localhost:8010            (simulated meeting or talk live; agents use the Anthropic API, mic transcription uses OpenAI)
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

from whiteboard.recording import list_runs  # noqa: E402
from whiteboard.session import Session  # noqa: E402
from whiteboard.sources import MicSource  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpx2").setLevel(logging.WARNING)
logging.getLogger("anthropic").setLevel(logging.WARNING)

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
        if msg.get("mode") == "mic":
            return {"ok": False, "error": "talk-live sessions start over /ws/mic (they need an audio stream)"}
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


@app.websocket("/ws/mic")
async def mic_endpoint(ws: WebSocket) -> None:
    """Talk-live audio in. Protocol:

    client -> server  text   {"type": "start", "speaker": "You", "topic": "...", "resume": false}
                             resume: true reconnects after an upstream error or continues a stopped session
                      binary PCM16 LE mono 24 kHz chunks (any size; the browser sends ~50 ms)
                      text   {"type": "stop"}            flush the last utterance and finish the session
    server -> client  text   {"type": "mic_state", "state": connecting|listening|stopping|stopped|error, "error": ...}
                      text   {"type": "error", "error": "..."}  (start refused)
    Transcripts and board updates go to every viewer over /ws. Closing this socket (tab closed)
    stops the mic: the last utterance is flushed and the upstream OpenAI socket is closed.
    """
    await ws.accept()
    s = get_session()
    mic: MicSource | None = None

    async def tell(state: dict) -> None:
        try:
            await ws.send_text(json.dumps({"type": "mic_state", **state}))
        except Exception:
            pass

    async def refuse(error: str) -> None:
        await ws.send_text(json.dumps({"type": "error", "error": error}))

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if mic is not None:
                    await mic.feed(msg["bytes"])
                continue
            data = json.loads(msg.get("text") or "{}")
            if data.get("type") == "start":
                cur = s.source if isinstance(s.source, MicSource) else None
                if data.get("resume") and cur and s.status == "running" and cur.state in ("error", "idle"):
                    mic = cur                       # reconnect after an upstream error, same board
                elif data.get("resume") and cur and s.mode == "mic" and s.status == "finished":
                    res = await s.continue_mic()    # continue after Stop, same board
                    if not res.get("ok"):
                        await refuse(res.get("error", "could not continue"))
                        continue
                    mic = cur
                elif cur and s.status == "running" and cur.state in ("connecting", "listening", "stopping"):
                    await refuse("Another browser is already talking live. Stop it or press Reset.")
                    continue
                else:
                    res = await s.start("mic", speaker=data.get("speaker"), topic=data.get("topic"))
                    if not res.get("ok"):
                        await refuse(res.get("error", "could not start"))
                        continue
                    mic = s.source
                mic.on_state = tell
                await mic.connect()
            elif data.get("type") == "stop":
                if mic is not None:
                    await mic.stop()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if mic is not None and mic.on_state is tell:
            mic.on_state = None
            if mic.state not in ("stopping", "stopped"):
                # tab closed or socket lost: flush what was said and close the upstream socket
                await mic.stop()
