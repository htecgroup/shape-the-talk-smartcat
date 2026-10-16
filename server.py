"""Live Whiteboard POC server.

Run:  uv run uvicorn server:app --port 8010
Open: http://localhost:8010            (simulated meeting or talk live; agents use the Anthropic API, mic transcription uses OpenAI)
      http://localhost:8010/?replay=latest   (replays the newest recorded run, no API calls)

Every board lives in a room (?room=<id> on the page, the sockets and the room-scoped endpoints); the page picks a
random one, and sharing its URL shares the board. No room is the "default" room (scripts, curl on /api/control).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

load_dotenv(Path(__file__).parent / ".env")

from whiteboard import agents, export  # noqa: E402
from whiteboard.attendee import AttendeeSource, verify_signature  # noqa: E402
from whiteboard.recording import list_runs  # noqa: E402
from whiteboard.session import Session  # noqa: E402
from whiteboard.sources import MicSource  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpx2").setLevel(logging.WARNING)
logging.getLogger("anthropic").setLevel(logging.WARNING)

log = logging.getLogger("rooms")

STATIC = Path(__file__).parent / "static"

# ------------------------------------------------------------------ rooms
# One Session per room, created when a room is first used. A room nobody is connected to and where nothing runs is
# dropped after ROOM_IDLE_S (its link then opens a fresh board), or after EMPTY_ROOM_IDLE_S if nothing was ever started
# in it (a visitor who opened the page and left). The default room does not count toward the cap.
DEFAULT_ROOM = "default"
ROOM_ID = re.compile(r"^[a-z0-9-]{1,32}$")
MAX_ROOMS = int(os.environ.get("LW_MAX_ROOMS", "20"))
ROOM_IDLE_S = 30 * 60
EMPTY_ROOM_IDLE_S = 60      # a room with no meeting, talk, Teams bot or replay in it has nothing to keep
SWEEP_EVERY_S = 60
rooms: dict[str, Session] = {}


class RoomError(Exception):
    """A room that can't be opened: a malformed id (400) or no free room (503)."""

    def __init__(self, error: str, status: int) -> None:
        super().__init__(error)
        self.error, self.status = error, status


async def get_session(room: str | None = DEFAULT_ROOM) -> Session:
    room = room or DEFAULT_ROOM
    if not ROOM_ID.match(room):
        raise RoomError(f"Invalid room id {room[:40]!r}: use 1-32 characters a-z, 0-9 or -", 400)
    s = rooms.get(room)
    if s is None:
        if room != DEFAULT_ROOM and _counted() >= MAX_ROOMS:
            await sweep_rooms()                 # an idle room may be due anyway; frees its slot before refusing
        if room != DEFAULT_ROOM and _counted() >= MAX_ROOMS:
            raise RoomError(f"All {MAX_ROOMS} rooms are in use. Try again later, or open the link of an existing "
                            "board.", 503)
        s = rooms[room] = Session(room)     # no await between the check and this, so the cap holds
        log.info("room %s opened (%d live)", room, len(rooms))
    s.last_active = time.monotonic()
    return s


def _counted() -> int:
    return sum(r != DEFAULT_ROOM for r in rooms)


async def sweep_rooms(now: float | None = None) -> list[str]:
    """Drop the rooms idle for ROOM_IDLE_S (EMPTY_ROOM_IDLE_S if never used). A busy room (viewer, mic, meeting, final
    summary, spec) counts as active."""
    now = time.monotonic() if now is None else now
    gone = []
    for room, s in list(rooms.items()):
        if s.busy():
            s.last_active = now
        elif now - s.last_active >= (EMPTY_ROOM_IDLE_S if s.mode == "idle" else ROOM_IDLE_S):
            rooms.pop(room, None)
            gone.append(room)
            try:
                await s.reset(broadcast=False)  # closes the source (mic socket, bot) and cancels what is left
            except Exception:
                log.exception("room %s: reset on drop failed", room)
    if gone:
        log.info("idle rooms dropped: %s (%d live)", ", ".join(gone), len(rooms))
    return gone


async def _sweeper() -> None:
    while True:
        await asyncio.sleep(SWEEP_EVERY_S)
        try:
            await sweep_rooms()
        except Exception:
            log.exception("room sweep failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_sweeper())
    yield
    task.cancel()


app = FastAPI(title="Live Whiteboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    # Browsers otherwise keep old app.js/board.js after edits (no build step, no hashed names).
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(RoomError)
async def room_error(_request: Request, exc: RoomError) -> JSONResponse:
    return JSONResponse({"ok": False, "error": exc.error}, exc.status)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/state")
async def state(room: str = DEFAULT_ROOM) -> dict:
    return (await get_session(room)).snapshot()


@app.get("/api/runs")
async def runs() -> list[dict]:
    return list_runs()


# Exports read the client view (view_board / view_transcript), so they work for live, talk-live and replay.
def _attachment(filename: str) -> dict:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@app.get("/api/export/board.json")
async def export_json(room: str = DEFAULT_ROOM) -> JSONResponse:
    s = await get_session(room)
    data = export.board_json(s.meeting, s.view_board)
    return JSONResponse(data, headers=_attachment(f"{export.slug(s.meeting.get('title'))}-board.json"))


@app.get("/api/export/board.mmd")
async def export_mermaid(room: str = DEFAULT_ROOM) -> PlainTextResponse:
    s = await get_session(room)
    return PlainTextResponse(export.all_mermaid(s.meeting, s.view_board), media_type="text/markdown",
                             headers=_attachment(f"{export.slug(s.meeting.get('title'))}-mermaid.md"))


@app.post("/api/export/spec")
async def export_spec(room: str = DEFAULT_ROOM) -> JSONResponse:
    s = await get_session(room)
    boards, transcript = s.spec_inputs()
    if not any(b["nodes"] for b in boards):
        return JSONResponse({"ok": False, "error": "the board is empty, nothing to write a spec about"}, 400)
    if s.spec_running:
        return JSONResponse({"ok": False, "error": "a spec is already being generated"}, 409)
    s.spec_running = True
    try:
        res = await agents.generate_spec(s.meeting, transcript, {"boards": boards}, s.questions, s.disagreements)
    finally:
        s.spec_running = False
    if not res.data:   # call_json never raises; it reports network/refusal/max_tokens in res.error
        return JSONResponse({"ok": False, "error": f"spec generation failed: {res.error or 'no output'}"}, 502)
    return JSONResponse({"ok": True, "title": res.data["title"], "markdown": res.data["markdown"],
                         "filename": f"{export.slug(s.meeting.get('title'))}-spec.md"})


async def handle_command(msg: dict, room: str = DEFAULT_ROOM) -> dict:
    s = await get_session(room)
    cmd = msg.get("cmd")
    if cmd == "start":
        if msg.get("mode") == "mic":
            return {"ok": False, "error": "talk-live sessions start over /ws/mic (they need an audio stream)"}
        return await s.start(msg.get("mode", "live"), msg.get("run"), msg.get("speed"),
                             topic=msg.get("topic"), meeting_url=msg.get("meeting_url"),
                             breakout_room=msg.get("breakout_room"))
    if cmd == "stop":
        await s.stop_meeting()
    elif cmd == "pause":
        await s.pause()
    elif cmd == "resume":
        await s.resume()
    elif cmd == "listen":
        return await s.set_listening(bool(msg.get("on")))
    elif cmd == "speed":
        await s.set_speed(float(msg.get("speed", 1)))
    elif cmd == "reset":
        await s.reset()
    elif cmd == "new_tab":
        return await s.request_new_tab(bool(msg.get("on", True)))
    elif cmd == "approval_mode":
        return await s.set_approval_mode(msg.get("mode"))
    elif cmd == "approval":
        return await s.decide_approval(str(msg.get("id")), bool(msg.get("approve")))
    else:
        return {"ok": False, "error": f"unknown cmd {cmd!r}"}
    return {"ok": True}


@app.post("/api/attendee/webhook")
async def attendee_webhook(request: Request) -> Response:
    """Attendee bot webhooks (transcript, participants, bot state). Signed; answered fast (Attendee times out at 10 s)."""
    try:
        payload = json.loads(await request.body())
    except ValueError:
        return Response("bad json", status_code=400)
    if not isinstance(payload, dict) or not verify_signature(payload, request.headers.get("X-Webhook-Signature")):
        return Response("Invalid signature", status_code=400)
    # Attendee posts every bot's webhooks to this one URL: the room whose bot it is gets them (never creates a room)
    bot_id = payload.get("bot_id")
    for s in list(rooms.values()):
        if bot_id and isinstance(s.source, AttendeeSource) and s.source.bot_id == bot_id:
            await s.source.handle_webhook(payload)
            break
    return Response("ok", status_code=200)


@app.post("/api/control")
async def control(msg: dict = Body(...), room: str = DEFAULT_ROOM) -> dict:
    return await handle_command(msg, room)


async def _join(ws: WebSocket, room: str) -> Session | None:
    """Open the socket's room, or tell the browser why not and close (4400 bad id, 4503 no free room)."""
    try:
        return await get_session(room)
    except RoomError as exc:
        await ws.send_text(json.dumps({"type": "error", "error": exc.error}))
        await ws.close(code=4000 + exc.status)
        return None


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, room: str = DEFAULT_ROOM) -> None:
    await ws.accept()
    if (s := await _join(ws, room)) is None:
        return
    s.clients.add(ws)
    await ws.send_text(json.dumps(s.snapshot(), ensure_ascii=False, default=str))
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            result = await handle_command(msg, room)
            if not result.get("ok"):
                await ws.send_text(json.dumps({"type": "error", "error": result.get("error")}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        s.clients.discard(ws)
        s.last_active = time.monotonic()    # the idle clock starts when the last viewer leaves


@app.websocket("/ws/mic")
async def mic_endpoint(ws: WebSocket, room: str = DEFAULT_ROOM) -> None:
    """Talk-live audio in. Protocol:

    client -> server  text   {"type": "start", "speaker": "You", "topic": "...", "resume": false}
                             resume: true reconnects after an upstream error or continues a stopped session
                      binary PCM16 LE mono 24 kHz chunks (any size; the browser sends ~50 ms)
                      text   {"type": "stop"}            flush the last utterance and finish the session
    server -> client  text   {"type": "mic_state", "state": connecting|listening|stopping|stopped|error, "error": ...}
                      text   {"type": "error", "error": "..."}  (start refused)
    Transcripts and board updates go to every viewer of the room over /ws. Closing this socket (tab closed)
    stops the mic: the last utterance is flushed and the upstream OpenAI socket is closed.
    """
    await ws.accept()
    if (s := await _join(ws, room)) is None:
        return
    s.mic_sockets += 1
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
        s.mic_sockets -= 1
        s.last_active = time.monotonic()
        if mic is not None and mic.on_state is tell:
            mic.on_state = None
            if mic.state not in ("stopping", "stopped"):
                # tab closed or socket lost: flush what was said and close the upstream socket
                await mic.stop()
