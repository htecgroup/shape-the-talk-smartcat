"""LLM agents. All use Anthropic `claude-sonnet-5-5` via the Messages API + structured outputs (json_schema).

In talk-live mode (meeting["source"] == "mic") the extractor and modeller prompts get an
extra LIVE SPEECH section for ASR text: one speaker, fillers, fragments, long utterances.

All three agents run at effort "low" (output_config.effort). Override with LW_*_EFFORT env vars.
Refusals fall back server-side (fallbacks="default") so the live loop keeps getting answers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

from anthropic import AsyncAnthropic
from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, RetryPolicy

log = logging.getLogger("agents")

MODEL = os.getenv("LW_MODEL", "claude-sonnet-5-5")
EXTRACTOR_EFFORT = os.getenv("LW_EXTRACTOR_EFFORT", "low")
MODELLER_EFFORT = os.getenv("LW_MODELLER_EFFORT", "low")
ANALYST_EFFORT = os.getenv("LW_ANALYST_EFFORT", "low")
# The modeller is on the live path (utterance -> board), so its model and thinking can be tuned alone.
# LW_MODELLER_THINKING: "adaptive" (default) or "between_tools" (no thinking; Sonnet 5.5 only, effort <= high).
MODELLER_MODEL = os.getenv("LW_MODELLER_MODEL", MODEL)
MODELLER_THINKING = os.getenv("LW_MODELLER_THINKING", "adaptive")
EXTRACTOR_MODEL = os.getenv("LW_EXTRACTOR_MODEL", MODEL)
EXTRACTOR_THINKING = os.getenv("LW_EXTRACTOR_THINKING", "adaptive")
# LW_EXTRACTOR_BACKEND: "claude" (default) or "jev" (TypeSafe System One classifier, key in JEV_API_KEY).
EXTRACTOR_BACKEND = os.getenv("LW_EXTRACTOR_BACKEND", "claude")
JEV_MODEL = os.getenv("LW_JEV_MODEL", "jev-latest")
MAX_TOKENS = 16000

KINDS = ["new_info", "correction", "disagreement", "resolution", "question", "undo", "chit_chat"]

_client: AsyncAnthropic | None = None


def client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(timeout=30, max_retries=1)
    return _client


@dataclass
class CallResult:
    data: dict | None
    latency_ms: int
    tokens_in: int = 0
    tokens_out: int = 0
    error: str | None = None
    confidence: float | None = None  # Jev only: confidence of the chosen kind


async def call_json(name: str, system: str, user: str, schema: dict, effort: str,
                    model: str = MODEL, thinking: str = "adaptive") -> CallResult:
    start = time.perf_counter()
    extra: dict[str, Any] = {}
    if thinking != "adaptive":
        extra["thinking"] = {"type": thinking}
    if not model.startswith("claude-haiku"):  # Haiku has no server-side refusal fallback
        extra.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = await client().beta.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            **extra,
        )
        ms = int((time.perf_counter() - start) * 1000)
        usage = resp.usage
        if resp.stop_reason in ("refusal", "max_tokens"):
            return CallResult(None, ms, usage.input_tokens, usage.output_tokens,
                              error=f"stop_reason={resp.stop_reason}")
        content = next((b.text for b in resp.content if b.type == "text"), "{}")
        return CallResult(json.loads(content), ms, usage.input_tokens, usage.output_tokens)
    except Exception as exc:  # network, refusal, bad JSON: never crash the live loop
        ms = int((time.perf_counter() - start) * 1000)
        log.warning("%s call failed after %sms: %s", name, ms, type(exc).__name__)
        return CallResult(None, ms, error=f"{type(exc).__name__}: {str(exc)[:200]}")


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props,
            "required": required if required is not None else list(props), "additionalProperties": False}


S = {"type": "string"}
NS = {"type": ["string", "null"]}


def _participants(meeting: dict) -> str:
    return "\n".join(f"- {p['name']}: {p['role']}" for p in meeting["participants"])


def _line(u: dict) -> str:
    return f'[{u["id"]}] {u["speaker"]}: {u["text"]}'


def is_live_speech(meeting: dict) -> bool:
    return meeting.get("source") == "mic"


# Extra instructions when utterances come from the microphone (talk-live mode) instead of the
# clean, speaker-labelled mock transcript. Empty for the scripted meeting, so its tuned prompts are unchanged.
EXTRACTOR_SPEECH_NOTES = """

LIVE SPEECH (this session): the utterances are automatic speech recognition of someone thinking out loud, usually ONE speaker (several people in the room may share the microphone and then all appear under one name). Expect fillers ("um", "you know", "like", "I mean"), false starts, half sentences, run-on sentences and the odd misheard word. Read for meaning, ignore the fillers, never invent content.
- One speaker correcting themselves ("actually, no, wait, that's wrong: X") is a correction of their own earlier statement, not a disagreement.
- A long utterance can contain several statements: list every design fact in claims, in the order spoken. If the speaker corrects themselves inside the same utterance, keep only the final version.
- A retraction ("scratch that", "forget the SMS") is kind undo, even when the same utterance also says what to do instead; put that replacement into claims.
- Pure thinking noises or facilitation with no design content ("okay so", "let me think", "where was I", "I think that's it") are chit_chat.
- Utterance boundaries come from pauses, so one sentence can be split over two utterances; use the context to understand a fragment, and give it kind new_info if it adds design content.
- If no topic was given, the first design statements define it; that is not a topic shift."""

MODELLER_SPEECH_NOTES = """

LIVE SPEECH (this session): utterances are speech recognition of someone thinking out loud (usually one speaker, possibly a few people sharing one microphone). They contain fillers, fragments and run-on sentences.
- Model the meaning, not the words. Never create nodes from filler words or garbled fragments that make no sense in context.
- Utterance boundaries come from pauses: a fragment that continues the previous utterance ("...and then it goes to the kitchen") extends what is already on the board.
- A long utterance: apply its statements in order; where the speaker corrects themselves inside it, draw only the final version. Keep the diff readable (a long ramble rarely needs more than 6-8 ops); details go into notes.
- kind=undo whose claims also state a replacement: emit the undo first, then model the replacement.
- A self-correction by the single speaker is a correction (fix in place), never a dispute."""

FIRST_BOARD_SCRIPTED = 'If there is no board yet, your first op must be new_board (for this meeting the first board is the process flow, e.g. id "order_flow").'
FIRST_BOARD_LIVE = ('If there is no board yet, your first op must be new_board: kind process for a flow of steps, architecture for '
                    'systems talking to each other; a short title naming the subject (e.g. "Mobile ordering flow") and a matching snake_case id.')


# ======================================================================= Extractor
EXTRACTOR_SCHEMA = _obj({
    "kind": {"type": "string", "enum": KINDS},
    "claims": {"type": "array", "items": S},
    "refers_to": NS,
    "topic_shift": {"type": "boolean"},
})

EXTRACTOR_SYSTEM = """You are the Extractor in "Live Whiteboard", a tool that turns a live meeting into a diagram.
You read ONE new utterance (with a little preceding context) and classify it. Be fast and literal.

Meeting: {title}
Topic: {topic}
Participants:
{participants}{speech_notes}

kind (pick exactly one):
- new_info: adds facts about the process/system being designed (steps, actors, systems, data, flows, ownership). Also proposals and suggestions.
- correction: says something said earlier (or on the board) is wrong and replaces it ("no, it goes through X first", "actually the other way around", "they don't use X anymore").
- disagreement: objects to someone else's statement/proposal without the group settling it ("I don't agree", "but then...").
- resolution: settles an earlier disagreement or confirms a proposal ("yes, that works", "deal", "agreed").
- question: asks something about the design. If the same utterance also states facts, still use question only if the question is the main point.
- undo: the speaker retracts something they said ("scratch that", "forget what I said", "ignore that").
- chit_chat: anything not about the design: audio/video checks, coffee, greetings, logistics, people leaving, small talk, pure facilitation ("let's park that", "let's wrap up").
A topic shift ("let me switch gears and map the systems behind it") is new_info with the claim "Topic shift: ...", never chit_chat.

claims: short, self-contained factual statements about the design, written so they make sense without the context, naming actors/systems explicitly (e.g. "Payment goes from checkout to the payment gateway, not directly to the bank"). For a topic switch, include a claim like "Topic shift: now mapping the systems architecture". For questions, the question itself. For undo and chit_chat: empty list unless there is real content.
refers_to: for correction/disagreement/resolution/undo, the id of the earlier utterance it reacts to (from the context), else null.
topic_shift: true ONLY when the speaker explicitly moves the discussion to a different diagram or subject (e.g. "let me switch gears and map the systems behind it", "now let's look at who the stakeholders are"). Mentioning a system or service inside the current discussion is NOT a topic shift."""


async def extract(meeting: dict, context: list[dict], utt: dict) -> CallResult:
    if EXTRACTOR_BACKEND == "jev":
        return await extract_jev(meeting, context, utt)
    system = EXTRACTOR_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                     participants=_participants(meeting),
                                     speech_notes=EXTRACTOR_SPEECH_NOTES if is_live_speech(meeting) else "")
    ctx = "\n".join(_line(u) for u in context[-6:]) or "(meeting just started)"
    user = f"Recent context:\n{ctx}\n\nNEW utterance to classify:\n{_line(utt)}"
    return await call_json("extraction", system, user, EXTRACTOR_SCHEMA, EXTRACTOR_EFFORT,
                           model=EXTRACTOR_MODEL, thinking=EXTRACTOR_THINKING)


# ============================================================ Extractor (Jev backend)
# Jev answers typed questions (choice / noul) about a `state`; it cannot write text, so claims are the
# utterance itself. Jev reads instructions literally: definitions and boundary cases live in the criteria.
JEV_KIND_CRITERIA = {
    "new_info": "States facts, steps, actors, systems, data, flows or ownership of the process/system being designed, "
                "or proposes/suggests something. Also an answer to an earlier question. Also an explicit move to a new "
                "diagram or subject (\"let me switch gears and map the systems\").",
    "correction": "Says that something said earlier is wrong and replaces it with the right version (\"no, it goes through "
                  "X first\", \"actually the other way around\", \"they don't use X anymore\"). Answering a question with "
                  "\"no\" is not a correction.",
    "disagreement": "Objects to another person's statement or proposal and the group has not settled it (\"I don't agree\", "
                    "\"but then...\"). Not a correction: it does not settle what is right.",
    "resolution": "Accepts the correction, proposal or position of someone else, or settles an earlier disagreement "
                  "(\"yes, that works\", \"right, fair\", \"deal\", \"agreed\"), even if it then adds details.",
    "question": "Its main point is asking something about the design. An utterance that answers a question is not a question.",
    "undo": "The speaker retracts something they themselves said (\"scratch that\", \"forget what I said\", \"ignore that\").",
    "chit_chat": "Not about the design at all: audio/video checks, coffee, greetings, logistics, people leaving or coming "
                 "back, small talk, pure facilitation without design content (\"let's park that\", \"let's wrap up\").",
}
JEV_REFERS_KINDS = {"correction", "disagreement", "resolution", "undo"}
JEV_TOPIC_SHIFT_THRESHOLD = 0.5
JEV_SPEECH_NOTE = ("Automatic speech recognition of someone thinking out loud: ignore fillers, false starts and "
                   "fragments. A speaker fixing their own earlier statement is a correction, not a disagreement.")

_jev_client: AsyncTypeSafeClient | None = None


def jev_client() -> AsyncTypeSafeClient:
    global _jev_client
    if _jev_client is None:
        _jev_client = AsyncTypeSafeClient(api_key=os.getenv("JEV_API_KEY"), model=JEV_MODEL,
                                          retry=RetryPolicy(max_retries=1, timeout=15))
    return _jev_client


def build_jev_request(meeting: dict, context: list[dict], utt: dict) -> tuple[dict, dict]:
    """state + questions (kind, refers_to, topic_shift) for one Jev System One call."""
    ctx = context[-6:]
    state: dict[str, Any] = {
        "meeting": {"title": meeting["title"], "topic": meeting["topic"], "participants": _participants(meeting)},
        "context": [_line(u) for u in ctx],
        "new_utterance": _line(utt),
    }
    if is_live_speech(meeting):
        state["speech_note"] = JEV_SPEECH_NOTE
    questions: dict[str, Any] = {
        "kind": Choice(instructions="Classify `new_utterance` in this design meeting (use `context` for what came "
                                    "before). Pick the one kind that is its main point.",
                       criteria=JEV_KIND_CRITERIA),
        "topic_shift": Noul(
            instructions="Does `new_utterance` explicitly move the discussion to a different diagram or subject?",
            criteria={"true": "The speaker explicitly switches to another diagram or subject (\"let me switch gears "
                              "and map the systems behind it\", \"now let's look at who the stakeholders are\").",
                      "false": "It continues the current discussion. Mentioning a system, service or detail inside "
                               "the current discussion is NOT a topic shift. Opening the meeting is NOT a topic shift."}),
    }
    if ctx:
        questions["refers_to"] = Choice(
            instructions="Which line of `context` does `new_utterance` react to (correct, object to, agree with, "
                         "retract or answer)? Pick a line only if `new_utterance` is about the same thing that line "
                         "says; a line that merely mentions a related subject does not count.",
            criteria={**{u["id"]: _line(u) for u in ctx},
                      "none": "It does not react to any line of `context` (for example it corrects something said "
                              "earlier than `context`)."})
    return state, questions


def jev_to_extraction(utt: dict, kind: str, refers_to: str | None, topic_shift_p: float) -> dict:
    """Map Jev answers to the Claude extractor's shape."""
    if kind not in KINDS:
        kind = "new_info"
    return {"kind": kind,
            "claims": [] if kind == "chit_chat" else [utt["text"]],
            "refers_to": refers_to if kind in JEV_REFERS_KINDS and refers_to not in (None, "none") else None,
            "topic_shift": topic_shift_p >= JEV_TOPIC_SHIFT_THRESHOLD}


async def extract_jev(meeting: dict, context: list[dict], utt: dict) -> CallResult:
    start = time.perf_counter()
    try:
        state, questions = build_jev_request(meeting, context, utt)
        resp = await jev_client().system_one(state=state, questions=questions)
        ms = int((time.perf_counter() - start) * 1000)
        kind = resp.choices["kind"]
        ref = resp.choices["refers_to"].choice if "refers_to" in questions else None
        data = jev_to_extraction(utt, kind.choice, ref, resp.nouls["topic_shift"].noul)
        return CallResult(data, ms, resp.usage.input_tokens or 0, resp.usage.output_tokens or 0,
                          confidence=round(kind.confidence, 3))
    except Exception as exc:  # network, auth, bad answer: never crash the live loop
        ms = int((time.perf_counter() - start) * 1000)
        log.warning("extraction (jev) failed after %sms: %s", ms, type(exc).__name__)
        return CallResult(None, ms, error=f"{type(exc).__name__}: {str(exc)[:200]}")


# ======================================================================== Modeller
def _op(name: str, props: dict) -> dict:
    return _obj({"op": {"type": "string", "enum": [name]}, "src": S, **props})


NODE_TYPE = {"type": "string", "enum": ["actor", "system", "step", "decision", "data"]}
NEW_STATUS = {"type": "string", "enum": ["confirmed", "ghost"]}
MARK_STATUS = {"type": "string", "enum": ["confirmed", "ghost", "disputed", "resolved"]}

# Per-op fields. The Anthropic grammar compiler rejects a 12-way anyOf of op objects (and also
# many nullable or optional fields) as too complex, so the schema is one flat op object with every
# field required and "" meaning "not used for this op". _clean_ops turns that back into the per-op
# shape (only that op's fields, "" -> null); Board.normalize still rejects ops missing a required field.
OP_SCHEMAS = {
    "add_node": {"id": S, "label": S, "type": NODE_TYPE, "status": NEW_STATUS, "group": NS, "note": NS},
    "update_node": {"id": S, "label": NS, "type": NODE_TYPE, "note": NS},
    "remove_node": {"id": S},
    "connect": {"from": S, "to": S, "label": NS, "status": NEW_STATUS},
    "disconnect": {"edge": S},
    "reroute": {"edge": S, "via": NS, "new_from": NS, "new_to": NS, "label": NS},
    "mark": {"target": S, "status": MARK_STATUS, "note": NS},
    "add_group": {"id": S, "label": S},
    "set_group": {"node": S, "group": NS},
    "new_board": {"id": S, "title": S, "kind": {"type": "string", "enum": ["process", "architecture", "stakeholder", "mindmap"]}},
    "switch_board": {"board": S},
    "undo": {"target_src": S},
}


def _or_empty(prop: dict) -> dict:
    return {"type": "string", "enum": [*prop["enum"], ""]} if "enum" in prop else {"type": "string"}


def _signature(name: str, props: dict) -> str:
    def one(k: str, v: dict) -> str:
        optional = v is NS or (name == "update_node" and k != "id")  # update_node changes only what is given
        values = "|".join(v["enum"]) + ("|\"\"" if optional else "") if "enum" in v else ("or \"\"" if optional else "")
        return f"{k} ({values})" if values else k
    return f"{name}: " + ", ".join(one(k, v) for k, v in props.items())


# The descriptions carry what the per-op schemas used to say: which fields each op uses.
OP_HELP = ("Fill only the fields this op uses; every other field is \"\". "
           + "; ".join(_signature(n, p) for n, p in OP_SCHEMAS.items()))
_OP_FIELDS: dict[str, dict] = {}
for _props in OP_SCHEMAS.values():
    for _k, _v in _props.items():
        _OP_FIELDS[_k] = _or_empty(MARK_STATUS if _k == "status" else _v)
for _k, _v in _OP_FIELDS.items():
    _v["description"] = "used by " + ", ".join(n for n, p in OP_SCHEMAS.items() if _k in p) + "; else \"\""
FLAT_OP = {**_obj({"op": {"type": "string", "enum": list(OP_SCHEMAS)}, "src": S, **_OP_FIELDS}),
           "description": OP_HELP}


def _clean_ops(data: dict | None) -> dict | None:
    """Give each op only its own fields, with "" (not used) as null: the shape Board expects."""
    if not data or not isinstance(data.get("ops"), list):
        return data
    ops = []
    for op in data["ops"]:
        fields = OP_SCHEMAS.get(op.get("op"))
        if fields is None:
            ops.append(op)
            continue
        ops.append({"op": op["op"], "src": op.get("src"),
                    **{k: (op.get(k) if op.get(k) != "" else None) for k in fields}})
    return {**data, "ops": ops}


MODELLER_SCHEMA = _obj({
    "summary": S,
    "ops": {"type": "array", "items": FLAT_OP},
})


MODELLER_SYSTEM = """You are the Board Modeller in "Live Whiteboard". While a meeting is happening you keep a whiteboard diagram in sync with what people say. You never draw: you emit a short list of edit operations (a diff) against the current board JSON. A deterministic renderer animates them, so keep diffs minimal and keep ids stable.

Meeting: {title}
Topic: {topic}
Participants:
{participants}

BOARDS. Each board is one diagram (a tab). kind: process (steps in order), architecture (systems and how they talk), stakeholder, mindmap.
{first_board}

NODE TYPES
- actor: person, role or organisation (Customer, Restaurant, Courier, Finance team).
- system: software, service, app or external provider (Payment gateway, Order service, Customer app, POS integration).
- step: an action in a process. Short verb phrase ("Browse restaurants", "Assign courier").
- decision: a yes/no branch in a process ("Payment OK?"). Only when a branch is actually described.
- data: stored data or a data store (Payment token, Analytics warehouse).

LABELS & IDS: labels 1-4 words; details go in note (max 12 words). ids are short snake_case nouns, unique per board (e.g. "payment_gateway"). Reuse existing ids exactly as shown in the board JSON; never add a node that already exists. Edge ids are "<from>-><to>".

EDGES: from -> to in the direction of flow. Process boards: step order (actor -> first step it does, step -> next step, step -> system it uses). Architecture boards: caller -> callee, or the direction data is sent/pushed. Edge labels only when they add meaning ("pays via", "on success", "push", "events", "websocket"), 1-3 words.

KEEP IT READABLE (a whiteboard for humans, typically 8-20 nodes per board)
- Attributes and details of a step (what the user picks, timing, "while the food cooks") go into that node's note, not into extra nodes. "At checkout they pick address and time slot" = one Checkout step with note "pick address + time slot".
- Never fan out: a statement like "everything goes to X" or "notify at every status change" gets ONE or TWO edges from the most central node(s), with the rest in a note. Never connect more than 2 existing nodes to a new node in one utterance.
- Do not invent steps, systems or edges nobody mentioned.

HOW TO REACT
1. new_info: add what is newly stated and connect it to the existing diagram (ideally every new node gets at least one edge). Statements of how it works or what is needed (including requirements from the client) are "confirmed". Use "ghost" only for hedged, tentative proposals ("I'd do...", "what if...", "maybe we could...", "I'd go with..."). When someone else accepts a ghost proposal, mark it (and its ghost edges) "confirmed".
2. correction: FIX the existing diagram in place. Use reroute (via = insert a node into an edge; new_from/new_to = change ends or reverse direction; set label when the old label no longer fits, e.g. "pulls" -> "pushes"), update_node (rename/retype keeps the node's position), disconnect, remove_node. Never leave the wrong version standing next to the right one. Example: "No, payment goes through the gateway first, never to the bank directly" when checkout->bank exists => add_node payment_gateway, reroute checkout->bank via payment_gateway (or disconnect + connect), and remove the bank node if it is no longer part of the flow.
3. disagreement: when someone objects to an element on the board, keep the element and mark it "disputed" with note "<Name>: <position> vs <Name>: <position>" (max ~16 words). If the objection is about an edge/ordering, mark the node or edge it is about.
4. resolution: only resolve a dispute when the people in THAT dispute agree on THAT topic (check the OPEN DISPUTES list and the extractor's refers_to); agreement about something else ("agreed, push only") never resolves an unrelated dispute. Apply the agreed change to the structure: if they agree a step happens after a different step, reroute its old incoming edge with new_from (do not leave the old edge next to the new one) and mark the previously disputed element "resolved" (not "confirmed") with note "Agreed: <decision>". Remove or disconnect ghost elements of the rejected alternative. A ghost proposal that gets accepted becomes "confirmed".
5. undo ONLY for explicit retractions of one's own words ("scratch that", "forget what I said", "forget the X"); a correction is never an undo. If the retracted utterance's changes are on the board (its id appears as "src" in the board JSON), emit exactly {{"op":"undo","target_src":"<that utterance id>"}}; this reverts everything that utterance added, so do not also remove things manually. If the retracted utterance is in the same NEW batch, simply do not model it and emit no undo.
6. question: no nodes for questions (another agent tracks them). If an answer states facts, model the facts (e.g. a data node).
7. chit_chat never reaches you; if an utterance has no design content, return no ops for it.
8. Boards/tabs: stay on the current board unless an utterance is flagged TOPIC_SHIFT. Systems, apps and services mentioned while discussing the process belong on the process board as "system" nodes. On TOPIC_SHIFT (e.g. "let me map the systems behind it"): emit new_board (kind architecture, title like "System map") and build the new diagram there; elements that also exist on another board can be re-added on the new board with the same id. Going back to an earlier diagram: switch_board.
9. Ops apply in order to the active board; later ops may reference nodes added earlier in the same list. Every op's "src" is the id of the utterance that caused it (one of the NEW utterances).
10. Keep each utterance to the few ops it really needs (typically 1-5). Unknown fields are null.

summary: max 12 words describing what you changed, e.g. "Rerouted payment through the gateway" or "No board change".{speech_notes}"""


def build_modeller_user(board_compact: dict, window: list[dict], new_items: list[dict]) -> str:
    lines = []
    for item in new_items:
        u, ex = item["utt"], item.get("extraction") or {}
        claims = "; ".join(ex.get("claims") or []) or "-"
        ref = f" refers_to={ex['refers_to']}" if ex.get("refers_to") else ""
        shift = " TOPIC_SHIFT" if ex.get("topic_shift") else ""
        lines.append(f"{_line(u)}\n    extractor: kind={ex.get('kind', '?')}{ref}{shift} | claims: {claims}")
    ctx = "\n".join(_line(u) for u in window) or "(none)"
    disputes = [f'{b["id"]}/{x["id"]}: {x.get("note") or ""}' for b in board_compact["boards"]
                for x in (b.get("nodes", []) + b.get("edges", [])) if isinstance(x, dict) and x.get("status") == "disputed"]
    return (f"CURRENT BOARD JSON:\n{json.dumps(board_compact, ensure_ascii=False)}\n\n"
            f"OPEN DISPUTES: {'; '.join(disputes) or 'none'}\n\n"
            f"RECENT TRANSCRIPT (already reflected on the board):\n{ctx}\n\n"
            f"NEW UTTERANCES to apply now (in order):\n" + "\n".join(lines))


async def model(meeting: dict, board_compact: dict, window: list[dict], new_items: list[dict]) -> CallResult:
    live = is_live_speech(meeting)
    system = MODELLER_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                    participants=_participants(meeting),
                                    first_board=FIRST_BOARD_LIVE if live else FIRST_BOARD_SCRIPTED,
                                    speech_notes=MODELLER_SPEECH_NOTES if live else "")
    user = build_modeller_user(board_compact, window, new_items)
    res = await call_json("board_ops", system, user, MODELLER_SCHEMA, MODELLER_EFFORT,
                          model=MODELLER_MODEL, thinking=MODELLER_THINKING)
    res.data = _clean_ops(res.data)
    return res


# ========================================================================= Analyst
ANALYST_SCHEMA = _obj({
    "open_questions": {"type": "array", "items": _obj({
        "question": S, "asked_by": S, "src": S,
        "status": {"type": "string", "enum": ["open", "answered", "parked"]},
        "answer": NS,
    })},
    "disagreements": {"type": "array", "items": _obj({
        "topic": S,
        "positions": {"type": "array", "items": _obj({"who": S, "position": S})},
        "status": {"type": "string", "enum": ["open", "resolved"]},
        "resolution": NS, "src": S,
    })},
    "suggested_marks": {"type": "array", "items": _obj({
        "board": S, "target": S, "status": {"type": "string", "enum": ["resolved"]},
        "note": S, "src": S,
    })},
})

ANALYST_SYSTEM = """You are the Analyst, a background agent in "Live Whiteboard". You read the meeting transcript so far and the current whiteboard, and maintain two lists that are shown next to the board, plus optional corrections of dispute markers.

Meeting: {title}
Topic: {topic}
Participants:
{participants}

open_questions: every design question raised in the meeting (not small talk like "can you hear me"). status: "answered" if someone answered it later (give the answer in <= 12 words), "parked" if the group explicitly postponed it, else "open". Questions asked implicitly as an undecided choice ("events or a nightly export?") count too. src = id of the utterance that asked it. Keep earlier entries and update their status; phrase questions in <= 14 words.

disagreements: only real disagreements, where two participants argue for conflicting positions (someone objects, pushes back, or says "I'm not sure we need..."). A correction of a fact that is simply accepted ("No, it goes through the gateway" / "Right, fair") is NOT a disagreement. positions: one short entry per side (who + position, <= 12 words). status "resolved" only if they explicitly agreed later, with the resolution (<= 14 words); postponing ("let's not decide today") keeps it open. src = utterance where the disagreement started.

suggested_marks: only to close stale dispute markers: for a RESOLVED disagreement whose board element is still "disputed", suggest "resolved" (note: "Agreed: <decision>"). Never mark elements that are not the subject of a disagreement in your list. target must be an existing node or edge id from the board JSON, board its board id, src the utterance id that justifies it. Usually this list is empty."""


async def analyse(meeting: dict, transcript: list[dict], board_compact: dict,
                  prev_questions: list, prev_disagreements: list) -> CallResult:
    system = ANALYST_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                   participants=_participants(meeting))
    user = (f"TRANSCRIPT SO FAR:\n" + "\n".join(_line(u) for u in transcript) +
            f"\n\nCURRENT BOARDS:\n{json.dumps(board_compact, ensure_ascii=False)}"
            f"\n\nYOUR PREVIOUS LISTS:\nopen_questions={json.dumps(prev_questions, ensure_ascii=False)}"
            f"\ndisagreements={json.dumps(prev_disagreements, ensure_ascii=False)}")
    return await call_json("analysis", system, user, ANALYST_SCHEMA, ANALYST_EFFORT)


async def warmup() -> None:
    """Open the HTTP connection early so the first live call is not slower."""
    try:
        await asyncio.wait_for(client().models.retrieve(MODELLER_MODEL), timeout=10)
    except Exception:
        pass
    if EXTRACTOR_BACKEND == "jev":
        try:
            await asyncio.wait_for(jev_client().models.list(), timeout=10)
        except Exception:
            pass


def jsonable(x: Any) -> Any:
    return json.loads(json.dumps(x, default=str))
