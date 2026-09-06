/**
 * Controller — the extension's event logic as a pure, pi-free module.
 *
 * `index.ts` is a thin adapter that wires these methods to pi's event loop;
 * tests drive this controller directly with plain objects. Same behavior,
 * no pi dependency (only `better-result` via the detector).
 *
 * Escalation ladder for message loops:
 *   detection #1 → steer  (inject guidance, let the agent continue)
 *   detection #2 → abort + resume (stop the run, queue one fresh directive)
 *   detection #3+ → abort for real (hand back to the user)
 * The auto-resume budget is re-armed on each genuine user prompt (via the
 * `input` event → `resetPromptBudget()`), so an explicit "continue" always gets
 * a fresh steer→abort→resume; the model's own auto-resume continuations (custom
 * messages that do not fire `input`) stay bounded to RESUME_BUDGET, so a stuck
 * model cannot cycle steer→abort→resume forever. A fresh session starts over.
 */
import { LoopDetector, detectRepetition, readOptions, truncate } from "./detector.ts";
import type { LoopOptions, ToolInput } from "./detector.ts";

/** Minimal shapes of the pi events the controller consumes (structural). */
export interface ToolCallEventLite {
  toolName: string;
  toolCallId: string;
  input: unknown;
}
export interface ToolResultEventLite {
  toolName: string;
  toolCallId: string;
  isError: boolean;
}
export interface MessageEndEventLite {
  message: { role: string; content?: unknown };
}
export interface MessageStartEventLite {
  message?: { role?: string };
}
export interface MessageUpdateEventLite {
  assistantMessageEvent?: { type?: string; delta?: string };
}
export interface CtxLite {
  ui: { notify(message: string, level: string): void };
  abort(): void;
}
export interface CommandCtxLite {
  ui: { notify(message: string, level: string): void };
}

/** One content block of an assistant message; text blocks carry text, tool
 * calls carry name + arguments (pi's AgentMessage block shape). */
export interface MessageContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

/** The list of content blocks of an assistant message. */
export type MessageContent = readonly MessageContentBlock[];

export interface ToolCallOutcome {
  block: true;
  reason: string;
  /** True when this exact call was blocked before — caller should abort the turn. */
  escalate: boolean;
}

export interface TextLoopOutcome {
  reason: string;
  action: "steer" | "abort";
  /** When aborting: also queue a single fresh-resume directive (bounded). */
  resume: boolean;
}

/** Auto-resumes allowed per user prompt before we hand control back for real. */
export const RESUME_BUDGET = 1;

/** Re-evaluate the mid-stream guard only every this many new chars (cheap throttle). */
export const STREAM_CHECK_STRIDE = 256;

export interface AntiLoopController {
  /** Returns a block decision for a tool call, or null to let it run. */
  onToolCall(toolName: string, input: ToolInput, toolCallId: string): ToolCallOutcome | null;
  /** Record a finished tool result (blocked calls' results are ignored). */
  onToolResult(toolName: string, toolCallId: string, isError: boolean): void;
  /** Detect assistant-text loops; returns a steer/abort decision or null. */
  onMessageEnd(role: string, content: MessageContent): TextLoopOutcome | null;
  /** Start tracking a new assistant message for the mid-stream guard. */
  onMessageStart(): void;
  /**
   * Feed one streamed assistant delta to the mid-stream repetition guard. Returns
   * a steer/abort decision (same ladder as onMessageEnd) or null. `deltaType` is
   * "text" | "thinking" — tool-call arg deltas are never passed here.
   */
  onMessageUpdate(role: string, deltaType: string, delta: string): TextLoopOutcome | null;
  /** Full reset (session start, user prompt, /loopcheck reset). */
  reset(): void;
  /** Re-arm the auto-resume budget on a genuine user prompt (keeps lifetime counters). */
  resetPromptBudget(): void;
  /** Suspend detection until the next reset (escape hatch for intentional repetition). */
  suspend(): void;
  resume(): void;
  isSuspended(): boolean;
  /** Human-readable status with thresholds + counters for /loopcheck. */
  status(): string;
}

export function createController(opts: LoopOptions = readOptions()): AntiLoopController {
  let detector = new LoopDetector(opts);
  const blockedIds = new Set<string>();
  let steered = false;
  let resumes = 0;
  let steers = 0;
  let aborts = 0;
  let suspended = false;
  // Mid-stream (single-turn) repetition guard state — its own steered flag so it
  // does not couple with the cross-message onMessageEnd ladder.
  let streamBuf = "";
  let streamTotal = 0;
  let streamSince = 0;
  let streamSteered = false;

  return {
    onToolCall(toolName, input, toolCallId) {
      if (suspended) return null;
      const decision = detector.check(toolName, input);
      if (decision.isErr()) {
        detector.record(toolName, input);
        return null;
      }
      blockedIds.add(toolCallId);
      const block = decision.value;
      return { block: true, reason: block.reason, escalate: block.escalate };
    },

    onToolResult(toolName, toolCallId, isError) {
      // Blocked calls never ran, so their (error) result must not count as a
      // consecutive failure.
      if (blockedIds.has(toolCallId)) {
        blockedIds.delete(toolCallId);
        return;
      }
      detector.recordResult(toolName, isError);
    },

    onMessageEnd(role, content) {
      if (suspended) return null;
      if (role !== "assistant") return null;

      // Within-message duplicate tool-call spam fires first: it aborts (the
      // calls are already emitted, steering cannot retract them), so it must
      // outrank the steer-able text ladder.
      const calls = content
        .filter((c) => c.type === "toolCall")
        .map((c) => ({ toolName: c.name ?? "", input: c.arguments as ToolInput }));
      const batch = detector.checkDuplicateCalls(calls);
      if (batch.isOk()) return { reason: batch.value.reason, action: "abort", resume: false };

      const text = extractText(content);
      if (!text) return null;
      const hit = detector.checkText(text);
      if (!hit.isOk()) return null;

      const reason = hit.value.reason;
      if (!steered) {
        steered = true;
        steers++;
        return { reason, action: "steer", resume: false };
      }
      if (resumes < RESUME_BUDGET) {
        resumes++;
        aborts++;
        return { reason, action: "abort", resume: true };
      }
      aborts++;
      return { reason, action: "abort", resume: false };
    },

    onMessageStart() {
      streamBuf = "";
      streamTotal = 0;
      streamSince = 0;
      streamSteered = false;
    },

    onMessageUpdate(role, deltaType, delta) {
      if (suspended) return null;
      if (role !== "assistant") return null;
      if (opts.streamEnabled === false) return null;
      if (deltaType !== "text" && deltaType !== "thinking") return null;
      if (!delta) return null;

      streamBuf += delta;
      streamTotal += delta.length;
      streamSince += delta.length;
      const keep = Math.max((opts.streamMinChars ?? 320) * 2, 1024);
      if (streamBuf.length > keep) streamBuf = streamBuf.slice(streamBuf.length - keep);
      if (streamSince < STREAM_CHECK_STRIDE) return null;
      streamSince = 0;

      const overCap =
        (opts.streamMaxTurnChars ?? 0) > 0 && streamTotal > (opts.streamMaxTurnChars ?? 0);
      const det = detectRepetition(streamBuf, {
        minRepeats: opts.streamMinRepeats ?? 32,
        minChars: opts.streamMinChars ?? 320,
        maxPeriod: opts.streamMaxPeriod ?? 32,
      });
      if (!det && !overCap) return null;

      const reason = det
        ? `assistant turn is stuck repeating "${truncate(det.sample, 24)}" (${det.periodLength}-char unit) ~${det.repeats} times`
        : `assistant turn ran to ${streamTotal} chars of generated text without stopping`;

      // Same escalation ladder as the message-loop path (shared lifetime counters).
      if (!streamSteered) {
        streamSteered = true;
        steers++;
        return { reason, action: "steer", resume: false };
      }
      if (resumes < RESUME_BUDGET) {
        resumes++;
        aborts++;
        return { reason, action: "abort", resume: true };
      }
      aborts++;
      return { reason, action: "abort", resume: false };
    },

    reset() {
      detector = new LoopDetector(opts);
      blockedIds.clear();
      steered = false;
      suspended = false;
      streamBuf = "";
      streamTotal = 0;
      streamSince = 0;
      streamSteered = false;
      // resumes/steers/aborts are intentionally NOT reset here: they are
      // session-scoped so a stuck model cannot cycle steer→abort forever and
      // /loopcheck can report lifetime counters. The auto-resume budget is
      // re-armed separately by resetPromptBudget() on a genuine user prompt.
    },

    resetPromptBudget() {
      // Fresh user intent re-arms the single auto-resume. The model's own
      // auto-resume continuations never fire `input`, so this stays bounded and
      // cannot re-enable an infinite auto-cycle within a single prompt.
      resumes = 0;
    },

    suspend() {
      suspended = true;
    },

    resume() {
      suspended = false;
    },

    isSuspended() {
      return suspended;
    },

    status() {
      const o = detector.opts;
      const s = suspended ? ", suspended" : "";
      const rate = o.failRateThreshold > 0 ? `, failRate>=${o.failRateThreshold}` : "";
      const time = o.timeWindowMs > 0 ? `, window ${o.timeWindowMs}ms` : "";
      const excl = o.toolExclude.size ? `, exclude[${[...o.toolExclude].join(",")}]` : "";
      const stream =
        o.streamEnabled === false
          ? "stream=off"
          : `stream=on(×${o.streamMinRepeats ?? 32}/${o.streamMaxPeriod ?? 32}ch)`;
      return (
        `anti-doom-loop: repeats>=${o.repeatThreshold}/window ${o.windowSize}, ` +
        `fails>=${o.failThreshold}, text>=${o.textRepeatThreshold}, ` +
        `sim>=${(o.textSimilarityThreshold ?? 0.8).toFixed(2)}, ${stream}${rate}${time}${excl}. ` +
        `${detector.diagnostics()} steers=${steers} aborts=${aborts}${s}`
      );
    },
  };
}

/** Join the text content blocks of an assistant message. */
export function extractText(content: MessageContent): string {
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(" ");
}
