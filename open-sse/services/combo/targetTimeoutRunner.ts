/**
 * Wrap a single-model dispatch with a per-target timeout that aborts and falls back.
 *
 * Extracted from handleComboChat's `handleSingleModelWithTimeout` closure (combo.ts).
 * A locally expired timer aborts that target and returns a typed 504 response so the Combo
 * can fall back without treating OmniRoute's own deadline as a provider-connection failure.
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
import { invalidateZeroSpendEvidence } from "../autoCombo/zeroSpendEvidenceResolver.ts";

/** Stable internal classification for OmniRoute's own combo per-target timer. */
export const COMBO_TARGET_TIMEOUT_CODE = "combo_target_timeout";

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

function resolveTargetProvider(modelStr: string, target?: SingleModelTarget): string | undefined {
  return target && "provider" in target && typeof target.provider === "string"
    ? target.provider
    : parseModel(modelStr).provider;
}

async function guardStrictZeroCostDispatch(
  body: Record<string, unknown>,
  modelStr: string,
  target?: SingleModelTarget
): Promise<Record<string, unknown>> {
  let strictZeroCost = false;
  try {
    const settings = await getSettings();
    strictZeroCost = settings.freeAccessPolicy === "strict";
  } catch {
    // Pool preparation is the primary fail-closed gate. If settings become unreadable
    // after preparation, this leaf cannot infer that an unrelated legacy combo was
    // Strict; leave its historical behavior unchanged rather than globally blocking it.
  }
  if (!strictZeroCost) return body;
  return applyStrictZeroCostRequestGuard(body, resolveTargetProvider(modelStr, target), true);
}

function maybeInvalidateEconomicEvidence(
  response: Response,
  modelStr: string,
  target?: SingleModelTarget
): Response {
  if (response.status !== 402 && response.status !== 403 && response.status !== 429) {
    return response;
  }
  const connectionId = target && "connectionId" in target ? target.connectionId : null;
  if (!connectionId) return response;
  const provider = resolveTargetProvider(modelStr, target);
  if (!provider) return response;
  const model = parseModel(modelStr).model || modelStr;
  invalidateZeroSpendEvidence(provider, connectionId, model);
  return response;
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
      const response = await handleSingleModel(guardedBody, modelStr, target).catch((err) =>
        errorResponse(502, err?.message ?? "Upstream model error")
      );
      return maybeInvalidateEconomicEvidence(response, modelStr, target);
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
      const response = await Promise.race([
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
      return maybeInvalidateEconomicEvidence(response, modelStr, target);
    } finally {
      clearTimeout(timeoutId);
      if (parentHedgeSignal && onParentHedgeAbort) {
        parentHedgeSignal.removeEventListener("abort", onParentHedgeAbort);
      }
    }
  };
}
