/**
 * Integration tests — the extension wiring end-to-end without pi.
 *
 * Two layers:
 *  1. controller.ts driven with plain objects (the event logic).
 *  2. index.ts default export driven through a fake `PiLike` — capturing the
 *     registered `pi.on` handlers and invoking them with realistic events,
 *     asserting blocks, escalations, aborts, resets and the /loopcheck command.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createController, extractText } from "../extensions/controller.ts";
import { DEFAULT_OPTIONS } from "../extensions/detector.ts";
import indexDefault from "../extensions/index.ts";
import type { PiLike } from "../extensions/index.ts";

// Pin the text-loop threshold the controller message tests exercise, so the
// shipped (conservative) default does not change what these assert.
const pinned = { ...DEFAULT_OPTIONS, textRepeatThreshold: 3 };

function makeFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: any) => unknown }
  >();
  const sent: Array<{ content: any; options?: any }> = [];
  const pi: PiLike = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    sendMessage(content, options) {
      sent.push({ content, options });
    },
    getThinkingLevel: () => "medium",
  };
  return {
    pi,
    handlers,
    commands,
    sent,
    fire: (event: string, e: any, c: any = {}) => {
      const h = handlers.get(event);
      assert.ok(h, `no handler registered for ${event}`);
      return h(e, c);
    },
  };
}

const fakeCtx = () => ({
  ui: { notify: (_msg: string, _level: string) => {} },
  abort: () => {},
});

describe("controller: tool-call lifecycle", () => {
  it("blocks identical calls and skips the blocked result in failure counting", () => {
    const c = createController(pinned);
    // Two identical allowed calls.
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c1"), null);
    c.onToolResult("bash", "c1", false);
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c2"), null);
    c.onToolResult("bash", "c2", false);
    // Third identical call blocks.
    const outcome = c.onToolCall("bash", { command: "grep foo" }, "c3");
    assert.ok(outcome !== null && outcome.block === true);
    // The blocked call's result (even error) must not count as a failure.
    c.onToolResult("bash", "c3", true);
    assert.equal(
      c.onToolCall("bash", { command: "other" }, "c3b"),
      null,
      "different command is not blocked (blocked error not counted)",
    );
    // A fresh identical signature still blocks via repeat counting, and the
    // blocked error did not create a 3-failure streak.
    assert.ok(c.onToolCall("bash", { command: "grep foo" }, "c4") !== null, "still blocked");
  });

  it("blocked-result exclusion matters: without it, one blocked error would seed the failure streak", () => {
    const c = createController(pinned);
    // Three DIFFERENT commands failing (repeat signal never fires) — the
    // next bash call must block by the failure streak, not by repetition.
    const cmds = ["npm test", "npm run lint", "npm run build"];
    for (let i = 0; i < 3; i++) {
      assert.equal(c.onToolCall("bash", { command: cmds[i] }, `t${i}`), null);
      c.onToolResult("bash", `t${i}`, true);
    }
    const outcome = c.onToolCall("bash", { command: "npm test" }, "t3");
    assert.ok(outcome !== null && /failed 3 consecutive times/.test(outcome.reason));
  });
});

describe("controller: message lifecycle", () => {
  it("returns an abort reason for a verbatim assistant loop", () => {
    const c = createController(pinned);
    const msg = (t: string) => [{ type: "text", text: t }];
    assert.equal(c.onMessageEnd("assistant", msg("Let me fetch the merge ref:")), null);
    assert.equal(c.onMessageEnd("assistant", msg("Let me fetch the merge ref:")), null);
    const hit = c.onMessageEnd("assistant", msg("Let me fetch the merge ref:"));
    assert.ok(hit !== null && /identical text 3 times/.test(hit.reason));
  });

  it("aborts on duplicate identical tool calls batched in ONE assistant message", () => {
    const c = createController(pinned);
    const spam = (n: number, command = "true") =>
      Array.from({ length: n }, () => ({ type: "toolCall", name: "bash", arguments: { command } }));
    const hit = c.onMessageEnd("assistant", spam(3) as any);
    assert.ok(hit !== null && hit.action === "abort" && !hit.resume);
    assert.match(hit!.reason, /identical "bash" calls/);
  });

  it("allows parallel calls with distinct args or below-threshold duplicates", () => {
    const c = createController(pinned);
    const distinct = [
      { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", name: "read", arguments: { path: "b.ts" } },
      { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    ];
    assert.equal(c.onMessageEnd("assistant", distinct as any), null);
    const two = [
      { type: "toolCall", name: "bash", arguments: { command: "true" } },
      { type: "toolCall", name: "bash", arguments: { command: "true" } },
    ];
    assert.equal(c.onMessageEnd("assistant", two as any), null);
  });

  it("ignores non-assistant roles and non-text content", () => {
    const c = createController(pinned);
    assert.equal(c.onMessageEnd("user", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("toolResult", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("assistant", [{ type: "image" }]), null);
    assert.equal(c.onMessageEnd("assistant", []), null);
  });

  it("extractText joins text blocks and skips non-text", () => {
    assert.equal(
      extractText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
      "a  b",
    );
    assert.equal(extractText([]), "");
    assert.equal(extractText([{ type: "image" }]), "");
  });
});

describe("controller: steer → abort → bounded resume", () => {
  it("steers once, then aborts with a resume twice (budget), then for real", () => {
    const c = createController(pinned);
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));

    fire();
    fire();
    const steer = fire();
    assert.ok(steer, "third identical message must detect");
    assert.equal(steer?.action, "steer", "first detection steers");
    assert.equal(steer?.resume, false);
    assert.match(steer?.reason ?? "", /identical text 3 times within the last/);

    assert.equal(fire()?.resume, true, "abort #1 queues a resume");
    assert.equal(fire()?.resume, true, "abort #2 still has budget (RESUME_BUDGET=2)");
    assert.equal(fire()?.resume, false, "resume budget spent");
  });

  it("reset clears the steer flag but keeps the resume budget (session-scoped)", () => {
    const c = createController(pinned);
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));

    // consume the whole (2-resume) budget: a steer then two resumed aborts
    fire();
    fire();
    fire(); // steer
    fire(); // abort + resume (1)
    fire(); // abort + resume (2) → budget spent

    c.reset(); // new user prompt — steer flag cleared, budget kept spent

    fire();
    fire();
    const steerAgain = fire();
    assert.equal(steerAgain?.action, "steer", "reset re-arms the steer flag");
    const abortAgain = fire();
    assert.equal(abortAgain?.action, "abort");
    assert.equal(abortAgain?.resume, false, "budget not restored by reset()");
  });
});

describe("controller: counters + suspend", () => {
  it("status reports steers and aborts for the session", () => {
    const c = createController(pinned);
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));
    fire();
    fire();
    fire(); // steer
    fire(); // abort
    fire(); // abort
    const s = c.status();
    assert.match(s, /steers=1/);
    assert.match(s, /aborts=2/);
  });

  it("suspend disables detection until reset", () => {
    const c = createController(pinned);
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    // build a streak so detection would fire
    c.onMessageEnd("assistant", msg(loop));
    c.onMessageEnd("assistant", msg(loop));
    c.onMessageEnd("assistant", msg(loop)); // steer
    c.onMessageEnd("assistant", msg(loop)); // abort

    c.suspend();
    assert.ok(c.isSuspended());
    assert.match(c.status(), /suspended/);
    assert.equal(c.onMessageEnd("assistant", msg(loop)), null, "suspended: no detection");
    assert.equal(
      c.onToolCall("bash", { command: "grep foo" }, "c1"),
      null,
      "suspended: no tool blocking",
    );

    c.resume();
    assert.ok(!c.isSuspended());
    // streak persists after resume — next message still detects
    const hit = c.onMessageEnd("assistant", msg(loop));
    assert.ok(hit !== null, "resumed: detection active again");

    c.reset(); // next prompt clears suspend
    c.suspend();
    c.reset();
    assert.ok(!c.isSuspended(), "reset clears the suspend flag");
  });
});

describe("controller: reset", () => {
  it("clears streaks and blocked ids", () => {
    const c = createController(pinned);
    c.onToolCall("bash", { command: "grep foo" }, "c1");
    c.onToolCall("bash", { command: "grep foo" }, "c2");
    assert.ok(c.onToolCall("bash", { command: "grep foo" }, "c3") !== null);
    c.reset();
    assert.equal(
      c.onToolCall("bash", { command: "grep foo" }, "c4"),
      null,
      "reset clears repeat window",
    );
    // Blocked id bookkeeping cleared too: a late result for a pre-reset id
    // must not throw or corrupt state.
    c.onToolResult("bash", "c3", true);
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c5"), null);
  });

  it("status exposes thresholds and counters", () => {
    const c = createController(pinned);
    const s = c.status();
    assert.match(s, /repeats>=3\/window 10/);
    assert.match(s, /fails>=3/);
    assert.match(s, /text>=3/);
    assert.match(s, /calls\[0\]/);
  });
});

describe("index.ts adapter (fake PiLike)", () => {
  it("wires tool_call → block with reason, escalate → abort", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);

    const ctx = fakeCtx();
    const aborts: string[] = [];
    const withAbort = { ...ctx, abort: () => aborts.push("abort") };

    fire(
      "tool_call",
      { toolName: "bash", toolCallId: "1", input: { command: "grep foo" } },
      withAbort,
    );
    fire(
      "tool_call",
      { toolName: "bash", toolCallId: "2", input: { command: "grep foo" } },
      withAbort,
    );
    const r = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "3", input: { command: "grep foo" } },
      withAbort,
    ) as { block: true; reason: string } | undefined;
    assert.ok(r, "third identical call must be blocked");
    if (r) {
      assert.equal(r.block, true);
      assert.match(r.reason, /identical arguments 3 times/);
    }
    assert.equal(aborts.length, 0, "first block must not abort");

    // Re-issue → escalate → abort fires.
    const r2 = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "4", input: { command: "grep foo" } },
      withAbort,
    ) as { block: true; reason: string } | undefined;
    assert.ok(r2 && r2.block === true, "re-issue is still blocked");
    assert.equal(aborts.length, 1, "escalation aborts the turn");
  });

  it("wires message_end → steer first, then abort + bounded resume", () => {
    // The adapter builds its controller from env; pin the text threshold this
    // test exercises so the shipped (conservative) default does not change it.
    const prev = process.env.PI_ANTI_LOOP_TEXT_REPEATS;
    process.env.PI_ANTI_LOOP_TEXT_REPEATS = "3";
    try {
      const { pi, fire, sent } = makeFakePi();
      indexDefault(pi);
      const aborts: string[] = [];
      const ctx = { ...fakeCtx(), abort: () => aborts.push("abort") };
      const msg = (t: string) => [{ type: "text", text: t }];
      const loop = "Let me fetch the merge ref:";
      const fireMsg = () =>
        fire("message_end", { message: { role: "assistant", content: msg(loop) } }, ctx);

      fireMsg(); // streak 1 — nothing
      fireMsg(); // streak 2 — nothing
      fireMsg(); // streak 3 — STEER (no abort, agent continues)
      assert.equal(aborts.length, 0, "first detection steers, does not abort");
      assert.equal(sent.length, 1, "a steer message was sent");
      assert.equal(sent[0].options?.deliverAs, "steer");
      assert.equal(sent[0].options?.triggerTurn, true);

      fireMsg(); // streak 4 — ABORT + resume (1)
      assert.equal(aborts.length, 1, "persistent loop aborts");
      assert.equal(sent.length, 2, "a resume directive is queued after the abort");
      assert.equal(sent[1].options?.deliverAs, "followUp");

      fireMsg(); // streak 5 — ABORT + resume (2): the corrective turn re-collapsed
      assert.equal(aborts.length, 2, "looping again aborts again");
      assert.equal(sent.length, 3, "budget=2 → a second resume is allowed");
      assert.equal(sent[2].options?.deliverAs, "followUp");

      fireMsg(); // streak 6 — abort for real (resume budget spent)
      assert.equal(aborts.length, 3, "still looping aborts again");
      assert.equal(sent.length, 3, "no third resume — the budget is bounded");
    } finally {
      if (prev === undefined) delete process.env.PI_ANTI_LOOP_TEXT_REPEATS;
      else process.env.PI_ANTI_LOOP_TEXT_REPEATS = prev;
    }
  });

  it("resets counters on before_agent_start", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);
    const ctx = fakeCtx();
    fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "grep foo" } }, ctx);
    fire("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "grep foo" } }, ctx);
    fire("before_agent_start", {}, ctx);
    const r = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "3", input: { command: "grep foo" } },
      ctx,
    );
    assert.equal(r, undefined, "after reset the same call passes again");
  });

  it("registers the /loopcheck command with status, reset, suspend, resume", async () => {
    const { pi, commands } = makeFakePi();
    indexDefault(pi);
    const cmd = commands.get("loopcheck");
    assert.ok(cmd, "/loopcheck must be registered");

    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } };

    await cmd!.handler("", ctx as any);
    assert.match(notices[0], /anti-doom-loop: repeats>=3/);
    assert.match(notices[0], /steers=0 aborts=0/);

    await cmd!.handler("suspend", ctx as any);
    assert.match(notices[1], /suspended/);

    await cmd!.handler("resume", ctx as any);
    assert.match(notices[2], /resumed/);

    await cmd!.handler("reset", ctx as any);
    assert.match(notices[3], /counters reset/);
  });
});

describe("controller: mid-stream intra-turn guard", () => {
  const stream = { ...DEFAULT_OPTIONS };
  it("aborts a duct collapse in one shot (a sustained burst is a single abort)", () => {
    const c = createController(stream);
    c.onMessageStart();
    const duct = "duct".repeat(300);
    const o = c.onMessageUpdate("assistant", "text", duct);
    assert.ok(o && o.action === "abort", "first hit aborts immediately (no steer)");
    assert.ok(o && o.resume === true, "first abort queues a resume");
    const o2 = c.onMessageUpdate("assistant", "text", duct);
    assert.equal(o2, null, "sustained same-turn burst is single-shot (not double-charged)");
  });
  it("ignores non-assistant roles and tool-call text below the strict collapse bar", () => {
    const c = createController(stream);
    c.onMessageStart();
    // A non-assistant role is never scanned.
    assert.equal(c.onMessageUpdate("user", "text", "duct".repeat(400)), null);
    // 1200 chars of "duct" in tool args is BELOW the strict 1600-char bar → not aborted.
    assert.equal(c.onMessageUpdate("assistant", "toolcall", "duct".repeat(300)), null);
  });
  it("does not fire on ordinary prose", () => {
    const c = createController(stream);
    c.onMessageStart();
    let prose = "";
    for (let i = 0; i < 400; i++) prose += `w${i} `;
    assert.equal(c.onMessageUpdate("assistant", "text", prose), null);
  });
  it("is a no-op when the guard is disabled", () => {
    const c = createController({ ...DEFAULT_OPTIONS, streamEnabled: false });
    c.onMessageStart();
    assert.equal(c.onMessageUpdate("assistant", "text", "duct".repeat(400)), null);
  });
  it("aborts an over-char-cap turn in one shot", () => {
    const c = createController({ ...DEFAULT_OPTIONS, streamMaxTurnChars: 1000 });
    c.onMessageStart();
    let prose = "";
    for (let i = 0; i < 400; i++) prose += `w${i} `;
    const o = c.onMessageUpdate("assistant", "text", prose);
    assert.ok(o && o.action === "abort", "over-cap aborts immediately");
    assert.ok(o && o.resume === true, "queues a resume");
    assert.equal(c.onMessageUpdate("assistant", "text", prose), null, "single-shot");
  });
});

describe("index adapter: message_update mid-stream guard", () => {
  it("aborts a streamed duct loop and queus a fresh-approach resume", () => {
    const { pi, fire, sent } = makeFakePi();
    indexDefault(pi);
    let aborts = 0;
    const ctx = {
      ...fakeCtx(),
      abort: () => {
        aborts++;
      },
    };
    fire("message_start", { message: { role: "assistant" } }, ctx);
    const duct = "duct".repeat(300);
    fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: duct } }, ctx);
    assert.equal(aborts, 1, "first hit aborts immediately");
    assert.equal(sent.length, 1, "a fresh-approach resume was queud");
    assert.equal(sent[0].options?.deliverAs, "followUp");
    fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: duct } }, ctx);
    assert.equal(aborts, 1, "sustained burst is single-shot (not double-charged)");
  });
  it("reduces reasoning on the corrective request after a mid-stream abort + resume", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);
    const ctx = {
      ...fakeCtx(),
      abort: () => {},
    };
    fire("message_start", { message: { role: "assistant" } }, ctx);
    fire(
      "message_update",
      { assistantMessageEvent: { type: "text_delta", delta: "duct".repeat(300) } },
      ctx,
    ); // aborts + arms the reduction for the corrective request
    const out = fire(
      "before_provider_request",
      { payload: { reasoning_effort: "medium" } },
      ctx,
    ) as { reasoning_effort?: string; enable_thinking?: boolean } | undefined;
    assert.ok(out, "the corrective request payload was rewritten");
    assert.equal(out?.reasoning_effort, "none");
    assert.equal(out?.enable_thinking, false);
    // one-shot: the very next request is left alone again
    assert.equal(
      fire("before_provider_request", { payload: { reasoning_effort: "high" } }, ctx),
      undefined,
    );
  });
  it("does not abort a legitimate (diverse) tool-call write", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);
    let aborts = 0;
    const ctx = {
      ...fakeCtx(),
      abort: () => {
        aborts++;
      },
    };
    fire("message_start", { message: { role: "assistant" } }, ctx);
    let big = '{"path":"src/gen.ts","content":"';
    for (let i = 0; i < 2000; i++) big += `line${i} = value${(i * 7) % 1000};\n`;
    big += '"}';
    fire(
      "message_update",
      { assistantMessageEvent: { type: "toolcall_delta", delta: big } },
      ctx,
    );
    assert.equal(aborts, 0, "a big but diverse write is never mistaken for a collapse");
  });
  it("aborts a collapse hidden in the tool-call argument stream", () => {
    const { pi, fire, sent } = makeFakePi();
    indexDefault(pi);
    let aborts = 0;
    const ctx = {
      ...fakeCtx(),
      abort: () => {
        aborts++;
      },
    };
    fire("message_start", { message: { role: "assistant" } }, ctx);
    fire(
      "message_update",
      { assistantMessageEvent: { type: "toolcall_delta", delta: "duct".repeat(600) } },
      ctx,
    );
    assert.equal(aborts, 1, "a perfect short-unit collapse in tool args aborts");
    assert.equal(sent.length, 1, "a fresh-approach resume was queud");
    assert.equal(sent[0].options?.deliverAs, "followUp");
  });
});
