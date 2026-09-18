# Pantheon — the round-table multi-harness GUI

`skillenv pantheon` opens a local web client where several agent harnesses —
"the gods" — deliberate together. **Every god is a fully isolated harness**:
its own skillenv environment (skills, sessions, memory, mailbox), its own
provider credentials and model, and its own persona. The server is only an
orchestrator; harnesses share nothing except the answers deliberately passed
between them during debate.

## Launch

```bash
skillenv pantheon                                  # default roster: hermes, athena, hephaestus
skillenv pantheon -g hermes -g poseidon            # custom roster
skillenv pantheon --persona "hermes=You are..."    # persona override
skillenv pantheon -p nous -m Hermes-4-405B         # shared provider/model
skillenv pantheon --port 4620 --dir ~/project --no-open
```

Missing god environments are auto-provisioned (zero-config): the first run
creates `~/.skillenv/envs/<god>` with the full standard layout.

## Modes

**圆桌 (round table)** — your prompt streams to every god in parallel; each
god answers using its own tools, skills, and memory; in debate rounds every
god sees the others' answers and responds (agree / correct / add); finally
the chair (first god) synthesizes a conclusion. Debate rounds are
configurable (1–3).

**单神 (solo)** — a private audience with one god: normal agent chat with
streaming, tool cards, and that god's persistent session.

## Per-god provider isolation

All gods inherit the shared `--provider/--model/--base-url/--api-key`, but
each god can run on entirely different credentials:

```bash
SKILLENV_GOD_HERMES_PROVIDER=nous
SKILLENV_GOD_HERMES_MODEL=Hermes-4-405B
SKILLENV_GOD_HERMES_API_KEY=nous-key-...
SKILLENV_GOD_ATHENA_PROVIDER=deepseek
skillenv pantheon
```

Gods without their own variables use the shared settings. The UI also has
provider/model selectors that apply per request (gods with env overrides
keep them).

## Isolation guarantees

| Harness aspect | Location | Shared? |
|---|---|---|
| Skills | `<env>/skills/` | no |
| Sessions | `<env>/sessions/` | no |
| Memory | `<env>/memory/MEMORY.md` | no |
| Mailbox | `<env>/mailbox/` | no (see below) |
| Provider credentials | per-god resolved | no |
| Debate content | passed explicitly by the orchestrator | yes — by design |

The only cross-god data flow is deliberate: the orchestrator shows each god
the other gods' answers during debate, and the chair receives all answers
for synthesis. God-to-god async messaging (outside a round table) uses the
[mailbox bus](agent.md#multi-harness-communication).

## Housekeeping

- The server binds `127.0.0.1` only — nothing is exposed to the network.
- `新会话` (new session) resets the selected god's (or all gods') rolling
  session; transcripts stay on disk in each environment.
- Default personas live in `src/ui/pantheon.ts` (`PERSONAS`); override with
  `--persona "god=..."` for custom characters.
