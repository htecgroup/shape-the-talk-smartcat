"""Jev extractor texts: the criteria and instructions of the typed questions sent to Jev System One.

Jev reads instructions literally: definitions and boundary cases live in the criteria.
"""

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
JEV_SPEECH_NOTE = ("Automatic speech recognition of someone thinking out loud: ignore fillers, false starts and "
                   "fragments. A speaker fixing their own earlier statement is a correction, not a disagreement.")

JEV_KIND_INSTRUCTIONS = ("Classify `new_utterance` in this design meeting (use `context` for what came "
                         "before). Pick the one kind that is its main point.")
JEV_TOPIC_SHIFT_INSTRUCTIONS = ("Does `new_utterance` move the discussion to a subject that belongs on a different diagram "
                                "than `current_board` (use `context` for what was just said)?")
JEV_TOPIC_SHIFT_CRITERIA = {
    "true": "The speaker starts on a subject that does not belong on `current_board`: a different system, problem, "
            "plan or agenda item, or the next person's update about something else. Explicit (\"let me switch gears "
            "and map the systems behind it\", \"next topic\", \"moving on to the release\") or implicit: no "
            "transition phrase, but what it talks about has nothing to do with `current_board` or the last lines of "
            "`context`. Going back to the subject of one of `other_boards` counts too. A phrase that hands over to the "
            "next subject or person (\"okay, next one\", \"Filip, you can continue\") counts even without design "
            "content.",
    "false": "It continues the subject of `current_board` or of the last lines of `context`: more detail, a related "
             "system, step or task, a question, correction or agreement about it. Mentioning a system, service or "
             "detail inside the current discussion is NOT a topic shift. Small talk, greetings and logistics are NOT a "
             "topic shift by themselves. When `current_board` is none yet, opening the meeting and the first design "
             "statements are NOT a topic shift.",
}
JEV_REFERS_TO_INSTRUCTIONS = ("Which line of `context` does `new_utterance` react to (correct, object to, agree with, "
                              "retract or answer)? Pick a line only if `new_utterance` is about the same thing that line "
                              "says; a line that merely mentions a related subject does not count.")
JEV_REFERS_TO_NONE = ("It does not react to any line of `context` (for example it corrects something said "
                      "earlier than `context`).")
