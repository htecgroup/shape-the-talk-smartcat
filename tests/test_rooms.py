"""Rooms: one session per ?room=, isolated state, commands and viewers; id check, cap, idle cleanup, webhook routing.

Routes are called as plain async functions with fake sockets and requests (no HTTP client, agents faked)."""

import asyncio
import base64
import json
import sys
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from test_sources import fake_pipeline, wait_for  # noqa: E402,F401
from whiteboard import attendee  # noqa: E402
from whiteboard.attendee import AttendeeSource, sign_payload  # noqa: E402

SECRET = base64.b64encode(b"test-secret").decode()


@pytest.fixture(autouse=True)
def no_rooms(monkeypatch):
    monkeypatch.setattr(server, "rooms", {})


class FakeSocket:
    """A /ws or /ws/mic client: sends `incoming` (then disconnects), records what the server sends and the close code."""

    def __init__(self, incoming=(), hold: asyncio.Event | None = None):
        self.incoming = list(incoming)
        self.hold = hold                    # stay connected until this is set
        self.events, self.closed = [], None

    async def accept(self):
        pass

    async def send_text(self, data):
        self.events.append(json.loads(data))

    async def close(self, code=1000):
        self.closed = code

    async def receive_text(self):
        if self.incoming:
            return json.dumps(self.incoming.pop(0))
        if self.hold is not None:
            await self.hold.wait()
        raise WebSocketDisconnect()

    async def receive(self):
        if self.incoming:
            return {"type": "websocket.receive", "text": json.dumps(self.incoming.pop(0))}
        return {"type": "websocket.disconnect"}


class FakeRequest:
    def __init__(self, payload: dict, secret: str = SECRET):
        self._body = json.dumps(payload).encode()
        self.headers = {"X-Webhook-Signature": sign_payload(payload, secret)}

    async def body(self):
        return self._body


def test_rooms_are_isolated(fake_pipeline):
    async def run():
        a, b = await server.get_session("room-a"), await server.get_session("room-b")
        assert a is not b and a.room == "room-a" and set(server.rooms) == {"room-a", "room-b"}
        assert (await server.handle_command({"cmd": "approval_mode", "mode": "ask"}, "room-b"))["ok"]
        assert (await server.handle_command({"cmd": "start", "mode": "live"}, "room-a"))["ok"]
        sa, sb = await server.state("room-a"), await server.state("room-b")
        assert (sa["status"], sa["mode"], sa["approval_mode"]) == ("running", "live", "auto")
        assert (sb["status"], sb["mode"], sb["approval_mode"]) == ("idle", "idle", "ask")
        await wait_for(lambda: a.view_transcript)
        await server.handle_command({"cmd": "reset"}, "room-a")
        assert a.status == "idle" and not a.view_transcript
        assert (await server.state("room-b"))["approval_mode"] == "ask"     # reset in A leaves B alone
        await server.handle_command({"cmd": "start", "mode": "live"}, "room-b")
        await server.handle_command({"cmd": "reset"}, "room-a")
        assert b.status == "running"
        await server.handle_command({"cmd": "reset"}, "room-b")
    asyncio.run(run())


def test_viewers_only_hear_their_room():
    async def run():
        hold = asyncio.Event()
        wa, wb = FakeSocket(hold=hold), FakeSocket([{"cmd": "approval_mode", "mode": "ask"}], hold=hold)
        tasks = [asyncio.create_task(server.ws_endpoint(wa, room="a")),
                 asyncio.create_task(server.ws_endpoint(wb, room="b"))]
        await wait_for(lambda: server.rooms.get("a") and server.rooms["a"].clients and server.rooms.get("b")
                       and server.rooms["b"].approval_mode == "ask")
        assert wa.events[0]["type"] == "snapshot" and wb.events[0]["type"] == "snapshot"
        await server.rooms["a"].emit({"type": "activity", "item": {"agent": "x"}}, record=False)
        assert [e["type"] for e in wa.events] == ["snapshot", "activity"]
        assert all(e["type"] != "activity" for e in wb.events)
        assert any(e["type"] == "approval_mode" for e in wb.events)
        assert not any(e["type"] == "approval_mode" for e in wa.events)
        assert server.rooms["a"].approval_mode == "auto"
        hold.set()
        await asyncio.gather(*tasks)
        assert not server.rooms["a"].clients and not server.rooms["b"].clients
    asyncio.run(run())


def test_no_room_is_the_default_room():
    async def run():
        assert (await server.handle_command({"cmd": "approval_mode", "mode": "ask"}))["ok"]
        assert list(server.rooms) == [server.DEFAULT_ROOM]
        assert (await server.state())["approval_mode"] == "ask"
        assert (await server.get_session("")) is server.rooms[server.DEFAULT_ROOM]   # an empty ?room= too
        ws = FakeSocket()
        await server.ws_endpoint(ws)
        assert ws.events[0]["approval_mode"] == "ask" and ws.closed is None
    asyncio.run(run())


@pytest.mark.parametrize("room", ["Bad", "a b", "x" * 33, "../etc", "ä"])
def test_invalid_room_ids_are_rejected(room):
    async def run():
        with pytest.raises(server.RoomError) as err:
            await server.state(room)
        assert err.value.status == 400
        r = await server.room_error(None, err.value)
        assert r.status_code == 400 and json.loads(r.body)["ok"] is False
        for endpoint in (server.ws_endpoint, server.mic_endpoint):
            ws = FakeSocket()
            await endpoint(ws, room=room)
            assert ws.closed == 4400 and ws.events[0]["type"] == "error" and "Invalid room" in ws.events[0]["error"]
        assert server.rooms == {}
    asyncio.run(run())


def test_room_cap(monkeypatch):
    monkeypatch.setattr(server, "MAX_ROOMS", 2)

    async def run():
        a = await server.get_session("a")
        await server.get_session("b")
        with pytest.raises(server.RoomError) as err:
            await server.get_session("c")
        assert err.value.status == 503 and "All 2 rooms" in err.value.error
        ws = FakeSocket()
        await server.ws_endpoint(ws, room="c")
        assert ws.closed == 4503 and ws.events[0]["type"] == "error"
        await server.get_session("b")                         # an existing room still opens
        await server.get_session()                            # and the default room never counts
        assert set(server.rooms) == {"a", "b", server.DEFAULT_ROOM}
        a.last_active -= server.ROOM_IDLE_S + 1               # an idle room frees its slot when one is needed
        await server.get_session("c")
        assert set(server.rooms) == {"b", "c", server.DEFAULT_ROOM}
    asyncio.run(run())


class FakeSource:
    kind = "mic"

    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True

    def public_state(self):
        return {"state": "stopped"}


def test_idle_rooms_are_dropped_and_released():
    async def run():
        idle, watched, running, recent = [await server.get_session(r) for r in ("idle", "watched", "running", "recent")]
        idle.source = FakeSource()
        idle.status = "finished"
        watched.clients.add(FakeSocket())
        running.status = "running"
        now = idle.last_active + server.ROOM_IDLE_S + 5
        recent.last_active = now - 60
        for s in (watched, running):
            s.last_active -= 10 * server.ROOM_IDLE_S
        assert await server.sweep_rooms(now) == ["idle"]
        assert set(server.rooms) == {"watched", "running", "recent"}
        assert idle.source is None and idle.status == "idle"  # reset: its source was closed, state cleared
        assert watched.last_active == now and running.last_active == now   # busy rooms count as active
        running.status = "finished"                          # finished now, so idle from this moment on
        assert await server.sweep_rooms(now + 60) == []
        assert set(await server.sweep_rooms(now + server.ROOM_IDLE_S + 1)) == {"running", "recent"}
        assert set(server.rooms) == {"watched"}
        assert (await server.get_session("idle")) is not idle    # its link opens a fresh board
    asyncio.run(run())


def test_open_mic_socket_or_spec_keeps_a_room():
    async def run():
        s = await server.get_session("m")
        s.last_active -= 2 * server.ROOM_IDLE_S
        s.mic_sockets = 1
        assert await server.sweep_rooms() == []
        s.mic_sockets, s.spec_running = 0, True
        s.last_active -= 2 * server.ROOM_IDLE_S
        assert await server.sweep_rooms() == []
        s.spec_running = False
        s.last_active -= 2 * server.ROOM_IDLE_S
        assert await server.sweep_rooms() == ["m"]
    asyncio.run(run())


def test_webhooks_go_to_the_room_of_their_bot(monkeypatch):
    monkeypatch.setattr(attendee, "WEBHOOK_SECRET", SECRET)
    got = []

    async def handle(self, payload):
        got.append((self.topic, payload["trigger"]))

    monkeypatch.setattr(AttendeeSource, "handle_webhook", handle)

    async def run():
        for room, bot in (("a", "bot_a"), ("b", "bot_b")):
            s = await server.get_session(room)
            s.source = AttendeeSource("https://teams.microsoft.com/x", topic=room)
            s.source.bot_id = bot
        await server.get_session("c")                         # no bot in this room
        hook = {"idempotency_key": "k", "bot_id": "bot_b", "trigger": "bot.state_change", "data": {}}
        r = await server.attendee_webhook(FakeRequest(hook))
        assert r.status_code == 200 and got == [("b", "bot.state_change")]
        r = await server.attendee_webhook(FakeRequest({**hook, "bot_id": "bot_gone"}))
        assert r.status_code == 200 and len(got) == 1          # no room has that bot: answered, ignored
        r = await server.attendee_webhook(FakeRequest(hook, secret=base64.b64encode(b"wrong").decode()))
        assert r.status_code == 400 and len(got) == 1
        assert set(server.rooms) == {"a", "b", "c"}            # webhooks never create rooms
    asyncio.run(run())
