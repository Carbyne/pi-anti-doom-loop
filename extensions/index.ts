/**
 * anti-doom-loop — pi extension that detects and breaks agent doom loops.
 *
 * Cheap models sometimes repeat the same cheap tool call (grep, read, ls)
 * without progress, silently burning tokens. This extension watches every
 * tool call and blocks loops before they cost anything:
 *
 *  - identical (tool, args) repeated `PI_ANTI_LOOP_REPEATS` times (default 3)
 *    in the last `PI_ANTI_LOOP_WINDOW` calls → block with an instructive reason
 *  - the same tool failing `PI_ANTI_LOOP_FAILS` consecutive times (default 3)
 *    → block with a "stop retrying, fix the root cause" reason
 *  - the model repeating text: verbatim, near-identical (token similarity),
 *    or a sentence repeated inside ONE message → steer first, abort as
 *    escalation, then a bounded auto-resume so work continues
 *
 * Escalation (message loops): detection #1 steers the agent mid-run; #2
 * aborts the turn and queues one fresh-resume directive; #3+ aborts for real
 * and hands control back to the user. Tool-call blocks hand the model an
 * instructive reason (that is the steer); re-issuing the exact same blocked
 * call aborts the turn.
 *
 * On a detected loop the guard also *reduces reasoning* for the single corrective
 * request that follows, since repetition collapses breed in reasoning output — a
 * request that reasons nothing is cheaper and far less likely to re-collapse. It
 * rewrites that one request's outgoing provider payload on `before_provider_request`
 * (pi's `setThinkingLevel` can't affect an in-progress run — the loop caches the
 * level at run start), so exactly the corrective request is touched and nothing
 * bleeds into the turns that follow. Disable with PI_ANTI_LOOP_THINK_ON_LOOP_DISABLE=1;
 * the target level is PI_ANTI_LOOP_THINK_ON_LOOP (default `off`).
 *
 * Counters reset on every user prompt, so a task legitimately repeated later
 * in the session is never a false positive. Disable with PI_ANTI_LOOP_DISABLE=1.
 *
 * All logic lives in `controller.ts` (pure, pi-free, unit-tested); this file
 * is a thin adapter wiring it to pi's event loop. The pi API is consumed
 * structurally so the wiring stays testable and import-light.
 */
import {
  createController,
  createThinkingGovernor,
  type AntiLoopController,
  type CommandCtxLite,
  type CtxLite,
  type MessageContent,
  type MessageEndEventLite,
  type MessageStartEventLite,
  type MessageUpdateEventLite,
  type ProviderRequest,
  type ToolCallEventLite,
  type ToolResultEventLite,
} from "./controller.ts";
import { readOptions, type ToolInput } from "./detector.ts";

/** The subset of pi's ExtensionAPI this extension uses (structural). */
export interface PiLike {
  on<E = unknown, C = unknown>(event: string, handler: (event: E, ctx: C) => unknown): void;
  registerCommand(
    name: string,
    opts: {
      description?: string;
      handler: (args: string, ctx: CommandCtxLite) => Promise<void> | void;
    },
  ): void;
  sendMessage?(
    content: { customType?: string; content?: string; display?: boolean },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  /** Only the getter is used — the setter can't influence an in-progress run. */
  getThinkingLevel?(): string;
}

/** Injected on the first loop detection — steer the agent back on track. */
const STEER_TEXT =
  "Anti-doom-loop steering: you are repeating the same action or text without making progress. " +
  "Stop. Re-read the actual error output, pick ONE different action, and execute it. " +
  "If you are stuck, ask the user instead of retrying.";

/** Queued once after an abort so the work can continue with a fresh approach. */
const RESUME_TEXT =
  "Anti-doom-loop: the previous run was aborted because it looped. " +
  "Start over with a genuinely different approach: do not repeat the previous investigation steps. " +
  "Re-read the task, choose one new action, execute it, then report results.";

/** Only the `input` event's presence matters here; its payload is ignored. */
interface InputEventLite {
  type?: string;
}

/** The provider-request hook only needs the outgoing request payload. */
interface PayloadEventLite {
  payload?: ProviderRequest;
}

export default function (pi: PiLike): void {
  if (process.env.PI_ANTI_LOOP_DISABLE === "1") return;

  let controller: AntiLoopController = createController(readOptions());

  // On a detected loop we reduce reasoning for the ONE corrective request that
  // follows, by rewriting its outgoing provider payload (see ThinkingGovernor —
  // pi.setThinkingLevel can't affect an in-progress run). Cheaper and far less
  // prone to re-collapsing, since the collapse lives in reasoning output.
  // Disable with PI_ANTI_LOOP_THINK_ON_LOOP_DISABLE=1; the target level is
  // PI_ANTI_LOOP_THINK_ON_LOOP (default "off"); the wire value for "off" is
  // PI_ANTI_LOOP_THINK_OFF_WIRE (default "none", the value this model family honours).
  const VALID_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const rawTarget = (process.env.PI_ANTI_LOOP_THINK_ON_LOOP ?? "off").trim().toLowerCase();
  const thinking = createThinkingGovernor({
    enabled: process.env.PI_ANTI_LOOP_THINK_ON_LOOP_DISABLE !== "1",
    target: VALID_LEVELS.has(rawTarget) ? rawTarget : "off",
    alreadyLow: new Set(["off", "minimal"]),
    offWireValue: (process.env.PI_ANTI_LOOP_THINK_OFF_WIRE ?? "none").trim(),
  });

  pi.on("session_start", () => {
    reset();
    thinking.onSessionStart();
  });

  // Fresh counters per user prompt: only the loop happening *right now* counts.
  // Internal reset keeps session-scoped steers/aborts; the auto-resume budget is
  // re-armed separately on the genuine user `input` event below.
  pi.on("before_agent_start", () => controller.reset());

  // A real user prompt is fresh intent → re-arm the single auto-resume, so an
  // explicit "continue" gets the steer→abort→resume treatment every time (not
  // just the first). The model's own auto-resume continuations are custom
  // messages that never fire `input`, so a stuck model still can't auto-cycle.
  // It is also where we undo a thinking reduction left over from a prior loop.
  pi.on("input", (_e: InputEventLite, ctx: CtxLite) => {
    controller.resetPromptBudget();
    thinking.onPrompt(ctx?.ui); // clear an arm whose corrective request never came
  });

  // The reduction is applied here, one-shot, on the actual outgoing request of
  // the corrective turn — the only point in the lifecycle that reliably sees it
  // (config.reasoning is cached at run start, so the turn boundary is too late).
  // pi hands this hook an untyped payload; the governor copies it forward
  // untouched except for the reasoning fields (index is the I/O boundary).
  pi.on("before_provider_request", (event: PayloadEventLite) =>
    thinking.beforeRequest(event.payload),
  );

  pi.on("tool_call", (event: ToolCallEventLite, ctx: CtxLite) => {
    // The pi event delivers untyped tool arguments; decode them into the
    // ToolInput domain type at this I/O boundary before the controller sees them.
    const outcome = controller.onToolCall(
      event.toolName,
      event.input as ToolInput,
      event.toolCallId,
    );
    if (outcome === null) return;
    if (outcome.escalate) {
      ctx.ui.notify("Anti-doom-loop: identical call blocked again — aborting turn", "error");
      ctx.abort();
    }
    return { block: true, reason: outcome.reason };
  });

  pi.on("tool_result", (event: ToolResultEventLite) => {
    controller.onToolResult(event.toolName, event.toolCallId, event.isError === true);
  });

  // Text-only doom loops (model re-emits/rephrases the same thing with no
  // tool calls) never reach tool_call. Steer first, abort as escalation,
  // then a bounded auto-resume so the work continues.
  pi.on("message_end", (event: MessageEndEventLite, ctx: CtxLite) => {
    // Decode the untyped message content into MessageContent at this boundary.
    const outcome = controller.onMessageEnd(
      event.message.role,
      event.message.content as MessageContent,
    );
    if (outcome === null) return;

    if (outcome.action === "steer") {
      ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "warning");
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: STEER_TEXT, display: true },
        { deliverAs: "steer", triggerTurn: true },
      );
      return;
    }

    ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "error");
    ctx.abort();
    if (outcome.resume) {
      thinking.onLoop(pi, ctx.ui); // reduce reasoning for the corrective request we're queuing
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: RESUME_TEXT, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  });

  // Mid-stream intra-turn repetition ("duct duct…"): the model streams one
  // never-terminating turn, so message_end never fires and the cross-message
  // text signals are blind to it. Watch the streaming deltas instead. Only
  // text/thinking deltas are scanned — tool-call arg deltas (a consolidator
  // legitimately writing a large file) are NEVER treated as a doom loop.
  pi.on("message_start", (event: MessageStartEventLite) => {
    const role = event.message?.role;
    if (role === undefined || role === "assistant") controller.onMessageStart();
  });

  pi.on("message_update", (event: MessageUpdateEventLite, ctx: CtxLite) => {
    const ae = event.assistantMessageEvent;
    if (!ae) return;
    const deltaType =
      ae.type === "text_delta" ? "text" : ae.type === "thinking_delta" ? "thinking" : null;
    if (deltaType === null) return; // toolcall_delta etc. is not generated prose
    const outcome = controller.onMessageUpdate("assistant", deltaType, ae.delta ?? "");
    if (outcome === null) return;
    // Mid-stream returns only "abort": a live repetition can't be steered out
    // (a steer message would only be seen once this never-ending turn ended).
    ctx.ui?.notify?.(`Anti-doom-loop: ${outcome.reason}`, "error");
    ctx.abort();
    if (outcome.resume) {
      thinking.onLoop(pi, ctx.ui); // reduce reasoning for the corrective request we're queuing
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: RESUME_TEXT, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  });

  pi.registerCommand("loopcheck", {
    description: "Anti-doom-loop status; `/loopcheck reset` clears counters",
    handler: async (args: string, ctx: CommandCtxLite) => {
      const arg = args.trim().toLowerCase();
      if (arg === "reset") {
        reset();
        thinking.onSessionStart();
        ctx.ui.notify("Anti-doom-loop: counters reset", "info");
        return;
      }
      if (arg === "suspend") {
        controller.suspend();
        ctx.ui.notify("Anti-doom-loop: suspended until the next prompt", "info");
        return;
      }
      if (arg === "resume") {
        controller.resume();
        ctx.ui.notify("Anti-doom-loop: resumed", "info");
        return;
      }
      ctx.ui.notify(controller.status(), "info");
    },
  });

  function reset(): void {
    controller = createController(readOptions());
  }
}
