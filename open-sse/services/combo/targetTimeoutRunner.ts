/**
 * Wrap a single-model dispatch with a per-target timeout that aborts and falls back.
 *
 * Extracted from handleComboChat's `handleSingleModelWithTimeout` closure (combo.ts).
 * A locally expired timer aborts that target and returns a typed 504 response so the Combo
 * can fall back without treating OmniRoute's own deadline as a provider-connection failure.
 * The per-model abort signal still comes from the target (`target.modelAbortSignal`), so
 * the outer request signal is intentionally NOT a dependency here.
 *
 * See _tasks/superpowers/plans/2026-07-03-blocoJ-combo-hotpath-decomposition.md (Task 1).
 */
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../../utils/error.ts";
import {
  COMBO_HEDGE_CANCELLED_REASON,
  COMBO_PER_MODEL_TIMEOUT_REASON,
} from "./comboAbortReasons.ts";
import type { HandleSingleModel, SingleModelTarget, ComboLogger } from "./types.ts";
import { getSettings } from "../../../src/lib/db/settings.ts";
import { parseModel } from "../model.ts";
import { applyStrictZeroCostRequestGuard } from "../autoCombo/strictZeroCostRequestGuard.ts";

/** Stable internal classification for OmniRoute's own combo per-target timer. */
export const COMBO_TARGET_TIMEOUT_CODE = "combo_target_timeout";

/**
 * Diagnostic: track recent combo-per-model-timeout abort errors so an
 * unhandledRejection handler can attribute the stack trace to a specific model
 * and timeout value. Ring buffer of 4 — concurrent per-model timeouts are rare
 * but possible (e.g. hedge + per-target timeout on different targets).
 */
const CONTEXT_RING_SIZE = 4;
const lastTimeoutContexts: Array<{
  modelStr: string;
  timeoutMs: number;
  abortError: Error;
  timestamp: number;
}> = [];
let contextRingIndex = 0;

function recordTimeoutContext(ctx: {
  modelStr: string;
  timeoutMs: number;
  abortError: Error;
  timestamp: number;
}): void {
  if (lastTimeoutContexts.length < CONTEXT_RING_SIZE) {
    lastTimeoutContexts.push(ctx);
  } else {
    lastTimeoutContexts[contextRingIndex] = ctx;
    contextRingIndex = (contextRingIndex + 1) % CONTEXT_RING_SIZE;
  }
}

/** Retrieve (and clear) all pending combo-per-model-timeout diagnostic contexts. */
export function drainLastTimeoutContexts(): typeof lastTimeoutContexts {
  const out = lastTimeoutContexts.splice(0);
  contextRingIndex = 0;
  return out;
}

let diagnosticInstalled = false;
function ensureDiagnosticListener(): void {
  if (diagnosticInstalled) return;
  diagnosticInstalled = true;
  process.on("unhandledRejection", (reason: unknown) => {
    try {
      const isComboTimeout =
        reason instanceof Error && reason.message === COMBO_PER_MODEL_TIMEOUT_REASON;
      if (!isComboTimeout) return;
      const contexts = drainLastTimeoutContexts();
      const summary =
        contexts.length > 0
          ? contexts.map((c) => `  model=${c.modelStr} timeout=${c.timeoutMs}ms`).join("\n")
          : "  (no context recorded)";
      console.error(
        "[COMBO-TIMEOUT-DIAGNOSTIC] unhandledRejection from combo per-model timeout.\n" +
          `${summary}\n` +
          `  abortError stack:\n${reason.stack ?? reason}`
      );
    } catch {
      // Diagnostic logging failed — never let this break the process.
    }
  });
}

async function guardStrictZeroCostDispatch(
  body: Record<string, unknown>,
  modelStr: string,
  target?: SingleModelTarget
): Promise<Record<string, unknown>> {
  // Do not cache a negative setting read. A just-enabled Strict policy must never
  // have a window in which an old false value could permit a paid dispatch.
  let strictZeroCost = false;
  try {
    const settings = await getSettings();
    strictZeroCost = settings.freeAccessPolicy === "strict";
  } catch {
    // Settings lookup failure while we cannot prove Strict is enabled must not alter
    // legacy combo behavior. Economic fail-closed happens earlier in Strict pool prep.
  }
  if (!strictZeroCost) return body;

  const targetProvider =
    target && "provider" in target && typeof target.provider === "string"
      ? target.provider
      : parseModel(modelStr).provider;
  return applyStrictZeroCostRequestGuard(body, targetProvider, true);
}

export function buildTargetTimeoutRunner(deps: {
  handleSingleModel: HandleSingleModel;
  comboTargetTimeoutMs: number;
  log: ComboLogger;
  resolveTargetTimeoutMs?: (
    target?: SingleModelTarget
  ) => Promise<number | undefined> | number | undefined;
}): (
  b: Record<string, unknown>,
  modelStr: string,
  target?: SingleModelTarget
) => Promise<Response> {
  const { handleSingleModel, comboTargetTimeoutMs, log, resolveTargetTimeoutMs } = deps;
  ensureDiagnosticListener();
  return async (
    b: Record<string, unknown>,
    modelStr: string,
    target?: SingleModelTarget
  ): Promise<Response> => {
    const guardedBody = await guardStrictZeroCostDispatch(b, modelStr, target);
    const resolvedTimeoutMs = await resolveTargetTimeoutMs?.(target);
    const effectiveTimeoutMs =
      typeof resolvedTimeoutMs === "number" && Number.isFinite(resolvedTimeoutMs)
        ? resolvedTimeoutMs
        : comboTargetTimeoutMs;
    if (effectiveTimeoutMs <= 0) {
      log.warn(
        "COMBO",
        `Per-model combo timeout is DISABLED (effectiveTimeoutMs=${effectiveTimeoutMs}) for ${modelStr} — a hung upstream will hang this target until the combo loop safety timeout`
      );
      return handleSingleModel(guardedBody, modelStr, target).catch((err) =>
        errorResponse(502, err?.message ?? "Upstream model error")
      );
    }

    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<Response>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        const abortErr = new Error(COMBO_PER_MODEL_TIMEOUT_REASON);
        recordTimeoutContext({
          modelStr,
          timeoutMs: effectiveTimeoutMs,
          abortError: abortErr,
          timestamp: Date.now(),
        });
        log.warn(
          "COMBO",
          `Model ${modelStr} exceeded ${effectiveTimeoutMs}ms timeout — falling back`
        );
        timeoutController.abort(abortErr);
        resolve(
          new Response(
            JSON.stringify(
              buildErrorBody(504, sanitizeErrorMessage(`Model ${modelStr} timed out`), undefined, {
                type: COMBO_TARGET_TIMEOUT_CODE,
                code: COMBO_TARGET_TIMEOUT_CODE,
              })
            ),
            {
              status: 504,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }, effectiveTimeoutMs);
    });
    const targetWithSignal = {
      ...(target ?? {}),
      modelAbortSignal: timeoutController.signal,
    };
    const parentHedgeSignal = target?.modelAbortSignal ?? null;
    let onParentHedgeAbort: (() => void) | null = null;
    if (parentHedgeSignal) {
      if (parentHedgeSignal.aborted) {
        timeoutController.abort(new Error(COMBO_HEDGE_CANCELLED_REASON));
      } else {
        onParentHedgeAbort = () => {
          timeoutController.abort(new Error(COMBO_HEDGE_CANCELLED_REASON));
        };
        parentHedgeSignal.addEventListener("abort", onParentHedgeAbort, { once: true });
      }
    }
    try {
      return await Promise.race([
        handleSingleModel(guardedBody, modelStr, targetWithSignal).catch((err) => {
          if (timedOut) {
            return new Response(null, { status: 599 });
          }
          return errorResponse(502, err?.message ?? "Upstream model error");
        }),
        timeoutPromise,
      ]).catch((raceErr) => {
        const detail = raceErr instanceof Error ? raceErr.message : String(raceErr);
        log.error?.("COMBO", `Unexpected rejection in combo timeout race for ${modelStr}: ${detail}`);
        return errorResponse(502, `Combo timeout dispatch error: ${detail}`);
      });
    } finally {
      clearTimeout(timeoutId);
      if (parentHedgeSignal && onParentHedgeAbort) {
        parentHedgeSignal.removeEventListener("abort", onParentHedgeAbort);
      }
    }
  };
}
