# pi-anti-doom-loop

Stop agent doom loops in [pi](https://pi.dev/) before they burn tokens.

Cheap models sometimes get stuck repeating the same cheap tool call — `grep`
the same file, re-run the same failing command — with no progress. Each
iteration is so cheap nobody notices until the bill mounts. This extension
watches every tool call and blocks the loop at the source.

> **Fork note.** This is a Carbyne fork of
> [`irfndi/pi-anti-doom-loop`](https://github.com/irfndi/pi-anti-doom-loop). It keeps the
> upstream tool-call / verbatim / duplicate-batch detectors and adds one the original can't
> see: a **mid-stream intra-turn repetition guard** for a single streamed assistant turn that
> never terminates while repeating a short fragment (`…ductductduct…`). That turn never
> reaches `message_end`, so the cross-message text detectors are blind to it — this guard
> evaluates the `message_update` deltas directly instead.
>
> **We removed the upstream *near-identical* (token-similarity) text detectors entirely.** An
> agent making real progress emits many turns that share heavy domain vocabulary, and fuzzy
> similarity matching false-positives on those — it did more harm than good. Detection is now
> strictly **localised and verbatim**: an intra-turn token collapse, or the **exact same**
> message repeating (consecutively, or the same few turns cycling in the window). Nothing with
> less-than-1.0 similarity is ever treated as a loop.

## Install

```bash
# this fork (loads from git)
pi install git:github.com/Carbyne/pi-anti-doom-loop

# upstream original (npm)
pi install npm:pi-anti-doom-loop
```

## What it detects

| Signal                                                  | Default                       | Blocked when                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same `(tool, args)` repeated                            | 3× in the last 10 calls       | The pattern has repeated `3` times with no change                                                                                                    |
| Same tool failing consecutively                         | 3×                            | A tool errored `3` times in a row — stop retrying it blindly                                                                                         |
| Same assistant text verbatim (consecutive)              | 5× in a row                   | The model re-emitted the **identical** message `5` turns in a row                                                                                     |
| Same assistant text verbatim (window cycle)             | 5× within the last N messages | The **identical** message re-appears `5` times inside the sliding window (the same few turns cycling)                                                 |
| Same sentence inside ONE message                        | 5×                            | A sentence repeats `5`+ times within a single message (growing self-concatenation loops)                                                             |
| Mid-stream token collapse (`duct duct…`)                | `on`, ×32 over 320 chars      | One streamed assistant turn repeats a ≤32-char unit ≥`32` times (or exceeds `40000` chars) without ever ending — the shape `message_end` cannot see  |
| Mid-stream collapse in TOOL-CALL args                   | `on`, ×100 over 1600 (zero-noise) | The same collapse shape hidden inside a streamed tool-call's arguments; only a perfect short-unit tiling fires, so a real/diverse file write is never aborted |

Blocks hand the model an instructive reason ("change your approach, use a
different tool, or ask the user"). If the model ignores the block and re-issues
the exact same call, the turn is **aborted**.

### Escalation (text loops): steer → abort → bounded resume

The first text-loop detection **steers** the agent mid-run (injects guidance,
lets it continue). If it persists, the run is **aborted** and a fresh-resume
directive is queued so work continues with a new approach. If it still loops
after the resume, the corrective turn re-collapses and gets a **second** resume
(so a one-off spin on the new attempt still recovers). Only when that second
attempt also spins does the run abort for real and control return to you. The
auto-resume budget is **two per user prompt**: the model's own auto-resume
continuations draw down the budget, so a truly stuck model can't cycle forever,
but when **you** send a new message the budget re-arms to 2 — so typing "continue"
always gets the full steer→abort→resume→resume treatment again, not just the first
time. (Budget `1` was the old setting and made a *second* collapse look "stuck":
it aborted with no resume and never came back.)
Detection counters reset on every user prompt, so a task legitimately repeated
later in the same session is never a false positive.

### Mid-stream guard (single never-ending turn)

The text signals above all evaluate at `message_end`. A model that collapses into an
intra-token loop ("`BSRRductductduct…`") emits **one turn that never ends**, so
`message_end` never fires and none of them can catch it — only a wall-clock timeout would.
The mid-stream guard watches the `message_update` **text/thinking deltas**. Because
this path only fires for a **sustained** burst (a transient blip would end its turn
before the window fills), it **aborts in one shot and queues a fresh-resume** rather
than wasting a steer the same model would just collapse through:

- it fires when the trailing `PI_ANTI_LOOP_STREAM_MIN_CHARS` chars are tiled by a unit of at
  most `PI_ANTI_LOOP_STREAM_MAX_PERIOD` chars, repeated at least `PI_ANTI_LOOP_STREAM_REPEATS`
  whole times (allowing ≤12% per-block noise), or once a turn passes
  `PI_ANTI_LOOP_STREAM_MAX_TURN_CHARS` generated chars;
- it guards **two separate buffers**: generated prose/thinking (the ordinary bar) and the
  streamed **tool-call argument** text. A collapse can hide inside a file write's args, so
  `toolcall_delta` **is** scanned — but with a **far stricter** bar (perfect zero-noise tiling
  of a ≤12-char unit over 1600 chars) and it is **exempt from the char cap**, so a legitimately
  large/diverse write is never mistaken for a loop;
- a candidate unit that is only whitespace/punctuation is ignored, so pasted tables and
  dividers don't false-positive.

Set `PI_ANTI_LOOP_STREAM=0` to disable the whole guard, or `PI_ANTI_LOOP_STREAM_TOOL=0` to
keep the prose guard but stop scanning tool-call arguments. Defaults are deliberately
conservative because it acts on the user's own interactive turn, not just cheap worker
subprocesses.

### Thinking reduction on loop

Repetition collapses almost always live in the model's **reasoning** output — and a
reasoning turn that spins is both expensive and self-reinforcing. So the moment any
loop signal fires, the guard **drops reasoning on the single corrective request**
that follows — the fresh-approach turn that reasons nothing is both cheaper and far
less likely to re-collapse. It rewrites that one request's outgoing provider payload
on pi's `before_provider_request` hook, one-shot: exactly the corrective request is
touched and nothing bleeds into the turns that follow.

Why the payload, not `pi.setThinkingLevel`? pi's low-level loop snapshots
`config.reasoning` from the session level **once at run start** and reuses it for
every turn in that run — and the auto-resume corrective turn is drained *inside the
same run* — so a mid-run `setThinkingLevel` is structurally ignored (and pollutes
the session default). Rewriting the actual wire payload is the only lever that lands
on the corrective request. It is a no-op when reasoning is already `off`/`minimal`
(e.g. an observational-memory worker running `--thinking off`, which is disabled
properly via the gateway's `off → "none"` mapping), so it never touches
non-reasoning runs.

| Var                                  | Default | Meaning                                                                     |
| ------------------------------------ | ------- | --------------------------------------------------------------------------- |
| `PI_ANTI_LOOP_THINK_ON_LOOP`         | `off`   | Level to drop the corrective request to: `off`/`minimal`/`low`/…       |
| `PI_ANTI_LOOP_THINK_ON_LOOP_DISABLE` | —       | Set to `1` to disable the reduction (keep the model's reasoning)      |
| `PI_ANTI_LOOP_THINK_OFF_WIRE`        | `none`  | The `reasoning_effort` wire value meaning "off" (vLLM uses `none`)   |

> Note: workers that already run with reasoning off get no benefit (nothing to reduce).
> The real fix for a model that reasons despite `--thinking off` is the model's
> `thinkingLevelMap.off → "none"` gateway override, not this feature.

## Configuration

Environment variables, read at session/prompt start:

| Variable                             | Default | Meaning                                                                                                                                             |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_ANTI_LOOP_REPEATS`               | `3`     | Identical-call block threshold                                                                                                                      |
| `PI_ANTI_LOOP_FAILS`                 | `3`     | Consecutive-failure block threshold                                                                                                                 |
| `PI_ANTI_LOOP_TEXT_REPEATS`          | `5`     | Repeat threshold for verbatim assistant-text signals (consecutive streak and window cycle)                                                            |
| `PI_ANTI_LOOP_STREAM`                | `1`     | Mid-stream intra-turn repetition guard; set `0` to disable it                                                                                       |
| `PI_ANTI_LOOP_STREAM_REPEATS`        | `32`    | Whole copies of a short unit before the mid-stream guard fires (min 4)                                                                              |
| `PI_ANTI_LOOP_STREAM_MIN_CHARS`      | `320`   | Trailing window that must be tiled to count as a loop (min 40)                                                                                      |
| `PI_ANTI_LOOP_STREAM_MAX_PERIOD`     | `32`    | Largest candidate unit length for the mid-stream guard (min 2)                                                                                      |
| `PI_ANTI_LOOP_STREAM_MAX_TURN_CHARS` | `40000` | Hard per-turn generated-char cap; beyond it the mid-stream guard fires (min 1000)                                                                   |
| `PI_ANTI_LOOP_STREAM_TOOL`             | `1`     | Also guard the streamed tool-call **argument** buffer; set `0` to scan prose/thinking only                                                           |
| `PI_ANTI_LOOP_STREAM_TOOL_REPEATS`     | `100`   | Tool-arg guard: whole copies of a short unit before it fires (far stricter than prose; min 8)                                                       |
| `PI_ANTI_LOOP_STREAM_TOOL_MIN_CHARS`   | `1600`  | Tool-arg guard: trailing window that must tile PERFECTLY (zero noise) to count as a loop (min 200)                                                  |
| `PI_ANTI_LOOP_STREAM_TOOL_MAX_PERIOD`  | `12`    | Tool-arg guard: largest candidate unit length (short on purpose; min 2)                                                                              |
| `PI_ANTI_LOOP_WINDOW`                | `10`    | How many recent calls/results are inspected                                                                                                         |
| `PI_ANTI_LOOP_TIME_WINDOW`           | `0`     | Elapsed-time window in ms (`0` = disabled, count-only): evicts window entries older than this so slow chronic loops over a long session are caught  |
| `PI_ANTI_LOOP_FAIL_RATE`             | `0`     | Fail-rate block threshold `0..1` (`0` = disabled): block when a tool's error share of its in-window calls reaches this                              |
| `PI_ANTI_LOOP_FAIL_RATE_MIN`         | `3`     | Minimum calls before the fail-rate window can block                                                                                                 |
| `PI_ANTI_LOOP_TOOLS_EXCLUDE`         | —       | Comma-separated tool names to disable detection for entirely (never block, never enter the window)                                                  |
| `PI_ANTI_LOOP_DISABLE`               | —       | Set to `1` to disable the extension entirely                                                                                                        |

## Command

- `/loopcheck` — show thresholds, counters (steers/aborts this session), suspend state, the current window contents (most-repeated recent calls and texts), wasted-token count, and the fail-rate/time-window/exclude config when enabled
- `/loopcheck reset` — clear counters
- `/loopcheck suspend` — pause detection until the next prompt (escape hatch for intentional repetition)
- `/loopcheck resume` — re-enable detection early

## Token-cost awareness

The detector estimates tokens burned on redundant repeats (~4 chars/token) and
reports `"~N tokens burned on repeats."` in tool-call block reasons. The
cumulative wasted-token count also appears in `/loopcheck` status, so you can
see how much a loop actually cost before it was stopped.

## How it works

Everything hooks into the `tool_call` / `tool_result` / `message_end` events, plus
`message_start` / `message_update` for the mid-stream guard. Detection is a small
sliding-window counter and the pure `detectRepetition` unit (see `extensions/detector.ts`)
with per-session counters (steers/aborts) and the mid-stream watcher tracked in
`extensions/controller.ts`.
Works with any model — cheap models just trigger it more often.

## Development

Requires Node 22.18+ (plain `node` runs the TS self-check).

```bash
npm install
npm test        # node --test: unit + fixture + fuzz + integration + e2e
npm run check   # npm test + tsc + oxlint --deny-warnings + oxfmt
```

### Test suite (Node built-in runner, no framework)

| Suite       | File                                          | What it proves                                                                                                    |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit.test.ts`                          | detector semantics: repeat/failure/text signals, window eviction, options clamping, helpers                       |
| fixture     | `tests/fixtures.ts` + `tests/fixture.test.ts` | real doom-loop transcripts (CI-log loops, verbatim repeats) are caught; healthy sessions are not                  |
| fuzz        | `tests/fuzz.test.ts`                          | seeded random streams: never throws, no false positives, injected loops always block, canonical stability         |
| integration | `tests/integration.test.ts`                   | controller + `index.ts` adapter driven through a fake `PiLike`: blocks, escalations, aborts, resets, `/loopcheck` |
| e2e         | `tests/e2e.test.ts`                           | real subprocesses: detector self-check, version guard, tarball contents (extensions/scripts ship, tests don't)    |

> `peerDependencies` pins `@earendil-works/pi-coding-agent` at `"*"` on purpose — the
> [pi packages docs](https://pi.dev/docs/latest/packages) require an unbounded range for
> pi-core packages (pi provides them at runtime). The extension loads `.ts` directly via
> jiti, so no build step ships; `prepublishOnly` runs the full quality gate before publish.

> When a call is blocked, escalation still works without recording it in the window:
> re-issuing the identical call increments a per-signature block counter and aborts the
> turn on the second block. Thresholds are clamped to a minimum of 2 so a bad config
> can never brick the agent.

## Releasing

Publishing is handled by the GitHub Actions workflow [`.github/workflows/release.yml`](.github/workflows/release.yml), guarded against version drift:

1. Add an npm **Automation** token as the `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions, or `gh secret set NPM_TOKEN`).
2. Bump `version` in `package.json`, commit, then tag and push:

```bash
git tag v0.0.1
git push origin v0.0.1
```

CI runs the quality gate, then the **version bump guard** (`npm run guard`): it blocks publishing if the version is already on npm or the tag doesn't match `package.json`. After the first publish, the [pi.dev gallery](https://pi.dev/packages) picks the package up automatically via the `pi-package` keyword.

## License

MIT
