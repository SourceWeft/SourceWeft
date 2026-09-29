import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import type { AIMessage } from "@langchain/core/messages";
import { ModelGatewayError } from "../errors";
import {
  planStructuredOutput,
  type StructuredOutputPlan,
} from "../model-capabilities";
import {
  defaultStrictJsonSchemaSupport,
  type StrictJsonSchemaSupportCache,
} from "../strict-json-schema-support";
import { unparsedFinishReason } from "../structured-output-errors";
import type {
  LangChainChatModelLike,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
  StrictJsonSchemaFallbackReason,
  StructuredOutputConfig,
  StructuredOutputDiagnostics,
  StructuredOutputMechanism,
} from "../types";
import {
  extractFinishReason,
  extractObjectRecord,
  extractReasoning,
  extractResponseMetadata,
  langChainInvokeOptions,
} from "./chat";
import {
  classifyStrictJsonSchemaRejection,
  strictJsonSchemaEligibility,
} from "./strict-json-schema";

const STRUCTURED_OUTPUT_PREVIEW_LENGTH = 500;

/** A gateway-vocabulary structured-output method (before mapping to LangChain). */
export type StructuredOutputMethod = NonNullable<StructuredOutputConfig["method"]>;

/** Map a gateway structured-output method to LangChain's `withStructuredOutput` name. */
export function langChainStructuredOutputMethod(
  method: StructuredOutputMethod,
): "jsonSchema" | "jsonMode" | "functionCalling" {
  if (method === "json_schema") return "jsonSchema";
  if (method === "json_mode") return "jsonMode";
  return "functionCalling";
}

function assertStructuredOutputSupported(input: {
  schema: Record<string, unknown>;
  name: string;
  model: LangChainChatModelLike;
  target: ResolvedRequestTarget;
}) {
  // Provider-level `supports` declarations proved unreliable in practice (a
  // gateway that declared `json_schema` still rejected it), so we do not gate on
  // them. Only validate the request shape locally, then let the provider be the
  // authority on capability — its error is as clear as anything we could raise.
  if (input.schema.type !== "object") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "Structured output schemas must use an object root",
      retryable: false,
    });
  }
  if (!input.name.trim()) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "Structured output name is required",
      retryable: false,
    });
  }
  if (typeof input.model.withStructuredOutput !== "function") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider adapter '${input.target.providerKind}' does not support structured output`,
      retryable: false,
      provider: input.target.provider,
    });
  }
}

function responseTextForDiagnostics(rawMessage: unknown) {
  const raw = extractObjectRecord(rawMessage);
  if (!raw) {
    return undefined;
  }
  const content = raw?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = extractObjectRecord(part);
      return typeof record?.text === "string"
        ? record.text
        : typeof record?.content === "string"
          ? record.content
          : "";
    })
    .join("");
}

/**
 * Diagnostics that turn "empty structured output" from a mystery into a
 * diagnosis: a `finishReason` of "length" plus a non-zero `reasoningLength`
 * on zero content is the thinking-ate-the-budget signature, and
 * `invalidToolCalls` entries mean the model DID call the schema tool but its
 * arguments failed strict JSON parsing (DeepSeek's unescaped inner quotes).
 */
function structuredOutputResponseDiagnostics(rawMessage: unknown) {
  const record = extractObjectRecord(rawMessage);
  if (!record) {
    return {};
  }
  const responseMetadata = extractResponseMetadata(
    record as { response_metadata?: unknown },
  );
  const finishReason = extractFinishReason(responseMetadata);
  const reasoning = extractReasoning(record as unknown as AIMessage);
  const invalidToolCalls = (
    Array.isArray(record.invalid_tool_calls) ? record.invalid_tool_calls : []
  ).flatMap((call) => {
    const callRecord = extractObjectRecord(call);
    if (!callRecord) {
      return [];
    }
    return [
      {
        name: typeof callRecord.name === "string" ? callRecord.name : undefined,
        argsLength:
          typeof callRecord.args === "string"
            ? callRecord.args.length
            : undefined,
        error:
          typeof callRecord.error === "string"
            ? callRecord.error.slice(0, 200)
            : undefined,
      },
    ];
  });
  return {
    ...(finishReason ? { finishReason } : {}),
    ...(typeof reasoning === "string"
      ? { reasoningLength: reasoning.length }
      : {}),
    ...(invalidToolCalls.length > 0 ? { invalidToolCalls } : {}),
  };
}

type SalvagedStructuredOutput = {
  args: Record<string, unknown>;
  source: "invalid_tool_calls" | "additional_kwargs";
  repaired: boolean;
};

function parsePossiblyBrokenJson(
  text: string,
  allowRepair: boolean,
): { value: unknown; repaired: boolean } | undefined {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    if (!allowRepair) {
      return undefined;
    }
    try {
      return { value: JSON.parse(jsonrepair(text)), repaired: true };
    } catch {
      return undefined;
    }
  }
}

/**
 * Last-resort recovery of a structured tool call the strict parser rejected.
 *
 * DeepSeek V4 routinely emits tool arguments whose *content* embeds unescaped
 * ASCII double quotes (Chinese copy quoting terms: `没有"表面"`), which is
 * invalid JSON. LangChain's `parseToolCall` does a strict `JSON.parse`, files
 * the whole call under `invalid_tool_calls`, and leaves `tool_calls` empty —
 * the model did its job and the answer was thrown away. This salvages those
 * arguments from `invalid_tool_calls` or the raw wire kwargs.
 *
 * Two distinct rungs, LiteLLM-style:
 * - a plain re-parse (arguments were valid JSON all along, just never lifted
 *   into `tool_calls`) is lossless and runs for every model;
 * - the `jsonrepair` rung actually rewrites model output, so it runs only for
 *   models whose capability declares the quirk (`toolCallArgumentJsonRepair`
 *   in the model DB / deployment config) — a well-behaved model's malformed
 *   output should fail loudly, not be silently patched.
 *
 * Safe by construction either way: every structured caller schema-validates
 * the parsed object downstream (the gateway's own zod parse or the caller's
 * validate/repair loop), so a mis-repair is rejected there rather than
 * propagated.
 */
function salvageStructuredToolCall(input: {
  rawMessage: unknown;
  toolName: string;
  allowJsonRepair: boolean;
}): SalvagedStructuredOutput | undefined {
  const record = extractObjectRecord(input.rawMessage);
  if (!record) {
    return undefined;
  }
  const candidates: Array<{
    argsText: string;
    source: SalvagedStructuredOutput["source"];
  }> = [];
  for (const call of Array.isArray(record.invalid_tool_calls)
    ? record.invalid_tool_calls
    : []) {
    const callRecord = extractObjectRecord(call);
    if (
      callRecord?.name === input.toolName &&
      typeof callRecord.args === "string"
    ) {
      candidates.push({
        argsText: callRecord.args,
        source: "invalid_tool_calls",
      });
    }
  }
  const kwargs = extractObjectRecord(record.additional_kwargs);
  for (const call of Array.isArray(kwargs?.tool_calls)
    ? kwargs.tool_calls
    : []) {
    const fn = extractObjectRecord(extractObjectRecord(call)?.function);
    if (fn?.name === input.toolName && typeof fn.arguments === "string") {
      candidates.push({ argsText: fn.arguments, source: "additional_kwargs" });
    }
  }
  for (const candidate of candidates) {
    const parsed = parsePossiblyBrokenJson(
      candidate.argsText,
      input.allowJsonRepair,
    );
    if (
      parsed &&
      parsed.value &&
      typeof parsed.value === "object" &&
      !Array.isArray(parsed.value)
    ) {
      return {
        args: parsed.value as Record<string, unknown>,
        source: candidate.source,
        repaired: parsed.repaired,
      };
    }
  }
  return undefined;
}

function invalidStructuredOutputError(
  rawMessage: unknown,
  diagnostics: StructuredOutputDiagnostics,
) {
  const content = responseTextForDiagnostics(rawMessage);
  if (content === undefined) {
    return new ModelGatewayError({
      code: "STRUCTURED_OUTPUT",
      message: "Provider returned invalid structured output",
      retryable: true,
      metadata: {
        structuredOutputDiagnostics: {
          contentAvailable: false,
          ...structuredOutputResponseDiagnostics(rawMessage),
          ...diagnostics,
        },
      },
    });
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const contentPreview = content
    .replace(/[ -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, STRUCTURED_OUTPUT_PREVIEW_LENGTH);
  return new ModelGatewayError({
    code: "STRUCTURED_OUTPUT",
    message: `Provider returned invalid structured output (length=${content.length}, sha256=${contentSha256})`,
    retryable: true,
    metadata: {
      structuredOutputDiagnostics: {
        contentLength: content.length,
        contentSha256,
        ...(contentPreview ? { contentPreview } : {}),
        ...structuredOutputResponseDiagnostics(rawMessage),
        ...diagnostics,
      },
    },
  });
}

function isStructuredOutputParseError(error: unknown) {
  return (
    error instanceof SyntaxError ||
    extractObjectRecord(error)?.name === "SyntaxError"
  );
}

/**
 * A native structured call's failure, classified: an unparseable answer, or
 * one the Provider cut off, is a retryable STRUCTURED_OUTPUT failure (the model
 * answered; the caller's retry loop applies) rather than an opaque upstream
 * error that would fail over to another channel of the same model. With a
 * `json_schema` response format the OpenAI SDK parses the answer itself and
 * throws before the raw message reaches the gateway, so no salvage or JSON
 * repair is possible on this path; strict mode's constrained decoding is what
 * keeps the answer valid JSON.
 */
function classifyNativeStructuredOutputError(
  error: unknown,
  diagnostics: StructuredOutputDiagnostics,
): unknown {
  if (isStructuredOutputParseError(error)) {
    return invalidStructuredOutputError(undefined, diagnostics);
  }
  const finishReason = unparsedFinishReason(error);
  if (finishReason) {
    return new ModelGatewayError({
      code: "STRUCTURED_OUTPUT",
      message: `Provider returned incomplete structured output (finish_reason=${finishReason})`,
      retryable: true,
      metadata: {
        structuredOutputDiagnostics: {
          contentAvailable: false,
          finishReason,
          ...diagnostics,
        },
      },
    });
  }
  return error;
}

/**
 * Structured output by binding the schema as an *available* tool — the strategy
 * {@link planStructuredOutput} selects for models that disable a forced
 * `tool_choice` via `disabled_params: { tool_choice: null }` (e.g. DeepSeek).
 *
 * This is the JS equivalent of what Python LangChain's
 * `ChatOpenAI.with_structured_output(method="function_calling")` produces once a
 * disabled `tool_choice` is filtered out (`disabled_params`): bind the schema as
 * a single tool with `parallel_tool_calls: false` and *no* `tool_choice` (the
 * API default, auto, applies), then take the first matching tool call — the
 * `JsonOutputKeyToolsParser(key_name=..., first_tool_only=True)` behavior.
 * `@langchain/openai` (JS) ships no `disabled_params`, so the bridge assembles
 * it here. The decision is the planner's; this only executes it. The model may
 * occasionally answer without calling the tool; the caller's repair loop covers
 * that turn.
 */
async function invokeStructuredViaAvailableTool(input: {
  model: LangChainChatModelLike;
  schema: Record<string, unknown>;
  name: string;
  messages: unknown;
  target: ResolvedRequestTarget;
  options?: RequestOptions;
  strict?: boolean;
  allowJsonRepair: boolean;
  diagnostics: StructuredOutputDiagnostics;
  logger?: ResolvedModelGatewayConfig["logger"];
}): Promise<{ rawMessage: AIMessage; structuredOutput: Record<string, unknown> }> {
  if (typeof input.model.bindTools !== "function") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider adapter '${input.target.providerKind}' cannot bind tools for structured output`,
      retryable: false,
      provider: input.target.provider,
    });
  }
  const tool = {
    type: "function",
    function: {
      name: input.name,
      ...(typeof input.schema.description === "string"
        ? { description: input.schema.description }
        : {}),
      parameters: input.schema,
    },
  };
  // No tool_choice (Python filters the forced one out; the API defaults to
  // auto); parallel_tool_calls: false to keep it to a single structured call.
  const bound = input.model.bindTools([tool], {
    parallel_tool_calls: false,
    ...(typeof input.strict === "boolean" ? { strict: input.strict } : {}),
  });
  const rawMessage = (await bound.invoke(
    input.messages,
    langChainInvokeOptions(input.options),
  )) as AIMessage;
  // first_tool_only, keyed by the schema tool name.
  const call = rawMessage.tool_calls?.find(
    (toolCall) => toolCall.name === input.name,
  );
  if (
    !call ||
    !call.args ||
    typeof call.args !== "object" ||
    Array.isArray(call.args)
  ) {
    const salvaged = salvageStructuredToolCall({
      rawMessage,
      toolName: input.name,
      allowJsonRepair: input.allowJsonRepair,
    });
    if (salvaged) {
      input.logger?.warn?.("model-gateway.structured-output-repaired", {
        toolName: input.name,
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        source: salvaged.source,
        repaired: salvaged.repaired,
        mechanism: input.diagnostics.mechanism,
      });
      return { rawMessage, structuredOutput: salvaged.args };
    }
    throw invalidStructuredOutputError(rawMessage, input.diagnostics);
  }
  return { rawMessage, structuredOutput: call.args as Record<string, unknown> };
}

export interface ExecuteStructuredOutputInput {
  model: LangChainChatModelLike;
  /** Final JSON schema (any caller-side description already merged in). */
  schema: Record<string, unknown>;
  /** The schema/tool name the model calls and the parser keys on. */
  name: string;
  /** Invoke-time messages (chat payload, or withStructuredOutput's invoke input). */
  messages: unknown;
  target: ResolvedRequestTarget;
  /**
   * Whether a forced `tool_choice` may be sent for THIS request — the negation
   * of `forcedToolChoiceDisabled(disabledParams)` (the langchain-python
   * `disabled_params` mirror; false when `{ tool_choice: null }` is declared).
   * Drives the availableTool-vs-native strategy via {@link planStructuredOutput}.
   */
  supportsForcedToolChoice: boolean;
  /**
   * Caller-pinned method (authoritative — capability plays no part). Forces the
   * native `structured` strategy and is passed to `withStructuredOutput`.
   */
  method?: StructuredOutputMethod;
  /**
   * Native-branch fallback method used only when no method is pinned AND the
   * plan chose the native path — the model capability's `structuredOutputMethod`
   * (DeepSeek → function_calling), mirroring its first-party class. Never
   * influences the availableTool-vs-native decision, and never replaces a
   * strict JSON-schema plan.
   */
  fallbackMethod?: StructuredOutputMethod;
  strict?: boolean;
  allowJsonRepair: boolean;
  options?: RequestOptions;
  logger?: ResolvedModelGatewayConfig["logger"];
  /** Memory of (Provider, model) pairs that refused strict output; process-wide by default. */
  strictJsonSchemaSupport?: StrictJsonSchemaSupportCache;
}

export interface ExecuteStructuredOutputResult {
  parsed: Record<string, unknown>;
  rawMessage: AIMessage;
  diagnostics: StructuredOutputDiagnostics;
}

/** The mechanism a plan resolves to, for logs and observation. */
function mechanismForPlan(
  plan: StructuredOutputPlan,
  fallbackMethod: StructuredOutputMethod | undefined,
): StructuredOutputMechanism {
  if (plan.strategy === "strictJsonSchema") return "json_schema_strict";
  if (plan.strategy === "availableTool") return "available_tool";
  return `native:${plan.method ?? fallbackMethod ?? "auto"}`;
}

/**
 * The single structured-output executor shared by `chat.complete`
 * (runBridgeChatComplete) and the observed model's `withStructuredOutput`.
 *
 * Without a pinned method it first asks for a strict `json_schema` response
 * format when the target's Provider declares `json_schema_strict`, the schema
 * is strict-compatible and the (Provider, model) has not refused it recently.
 * If the Provider refuses it (see `classifyStrictJsonSchemaRejection`), the
 * pair is remembered as unsupported and the same call is retried exactly once
 * through the path below; any other error propagates unchanged.
 *
 * Otherwise it applies the JS mirror of langchain-python's `disabled_params`:
 * for a model whose effective capabilities disable a forced `tool_choice`, it
 * binds the schema as an *available* tool (drop-forced) with salvage; otherwise
 * it uses native `withStructuredOutput` with the caller-pinned method, falling
 * back to the capability's method (DeepSeek → function_calling). Always
 * requests the raw message so callers get both the parsed object and the
 * underlying response (for billing/observation, salvage, and diagnostics), and
 * reports the mechanism it used — never prompts or outputs.
 */
export async function executeStructuredOutput(
  input: ExecuteStructuredOutputInput,
): Promise<ExecuteStructuredOutputResult> {
  const support =
    input.strictJsonSchemaSupport ?? defaultStrictJsonSchemaSupport;
  const eligibility = strictJsonSchemaEligibility({
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.strict !== undefined ? { strict: input.strict } : {}),
    supports: input.target.supports,
    schema: input.schema,
    knownUnsupported: support.isUnsupported(input.target),
  });
  // Resolve the strategy ahead of execution so the branch follows a plan
  // instead of judging inline. The pinned `method` is authoritative.
  const planInput = {
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.strict !== undefined ? { strict: input.strict } : {}),
    supportsForcedToolChoice: input.supportsForcedToolChoice,
  };
  const plan = planStructuredOutput({
    ...planInput,
    strictJsonSchema: eligibility.eligible,
  });

  let result: ExecuteStructuredOutputResult;
  if (plan.strategy !== "strictJsonSchema") {
    result = await runStructuredOutputPlan(input, plan);
  } else {
    try {
      result = await runStructuredOutputPlan(input, plan);
    } catch (error) {
      const reason = classifyStrictJsonSchemaRejection(error);
      if (!reason) {
        throw error;
      }
      support.markUnsupported(input.target);
      // Today's path for this request; never strict, so this retries once.
      const fallbackPlan = planStructuredOutput({
        ...planInput,
        strictJsonSchema: false,
      });
      input.logger?.warn?.("model-gateway.structured-output-fallback", {
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        reason,
        fallbackMechanism: mechanismForPlan(fallbackPlan, input.fallbackMethod),
      });
      result = await runStructuredOutputPlan(input, fallbackPlan, reason);
    }
  }
  input.logger?.debug?.("model-gateway.structured-output", {
    toolName: input.name,
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    ...result.diagnostics,
    ...(eligibility.eligible
      ? {}
      : { strictIneligibleReason: eligibility.reason }),
  });
  return result;
}

/** Runs one resolved plan, once. */
async function runStructuredOutputPlan(
  input: ExecuteStructuredOutputInput,
  plan: StructuredOutputPlan,
  fallbackReason?: StrictJsonSchemaFallbackReason,
): Promise<ExecuteStructuredOutputResult> {
  const diagnostics: StructuredOutputDiagnostics = {
    mechanism: mechanismForPlan(plan, input.fallbackMethod),
    ...(fallbackReason ? { fallbackReason } : {}),
  };

  if (plan.strategy === "availableTool") {
    const structured = await invokeStructuredViaAvailableTool({
      model: input.model,
      schema: input.schema,
      name: input.name,
      messages: input.messages,
      target: input.target,
      allowJsonRepair: input.allowJsonRepair,
      diagnostics,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
      ...(plan.strict !== undefined ? { strict: plan.strict } : {}),
    });
    return {
      parsed: structured.structuredOutput,
      rawMessage: structured.rawMessage,
      diagnostics,
    };
  }

  assertStructuredOutputSupported({
    schema: input.schema,
    name: input.name,
    model: input.model,
    target: input.target,
  });

  // A strict plan sends `json_schema` with `strict: true`; the answer arrives
  // as message content JSON, which the SDK/LangChain jsonSchema path parses.
  // Otherwise the pinned method drives the plan and is used verbatim; when
  // none is pinned the native call falls back to the capability method
  // (DeepSeek → function_calling). `strict` only travels alongside a method.
  // `method` undefined lets LangChain select per model.
  let nativeMethod: StructuredOutputMethod | undefined;
  let nativeStrict: boolean | undefined;
  if (plan.strategy === "strictJsonSchema") {
    nativeMethod = "json_schema";
    nativeStrict = true;
  } else {
    nativeMethod = plan.method ?? input.fallbackMethod;
    nativeStrict =
      plan.method !== undefined
        ? plan.strict
        : nativeMethod !== undefined
          ? input.strict
          : undefined;
  }
  const structuredModel = input.model.withStructuredOutput!(input.schema, {
    includeRaw: true,
    name: input.name,
    ...(nativeMethod
      ? {
          method: langChainStructuredOutputMethod(nativeMethod),
          ...(nativeStrict !== undefined ? { strict: nativeStrict } : {}),
        }
      : {}),
  });

  let structuredResult: unknown;
  try {
    structuredResult = await structuredModel.invoke(
      input.messages,
      langChainInvokeOptions(input.options),
    );
  } catch (error) {
    throw classifyNativeStructuredOutputError(error, diagnostics);
  }
  const result = extractObjectRecord(structuredResult);
  const rawMessage = result?.raw as AIMessage;
  const parsed = result?.parsed;
  if (
    !rawMessage ||
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    // The strict parser may have discarded a real tool call over invalid JSON
    // in its arguments — salvage before failing.
    const salvaged = rawMessage
      ? salvageStructuredToolCall({
          rawMessage,
          toolName: input.name,
          allowJsonRepair: input.allowJsonRepair,
        })
      : undefined;
    if (!salvaged || !rawMessage) {
      throw invalidStructuredOutputError(result?.raw, diagnostics);
    }
    input.logger?.warn?.("model-gateway.structured-output-repaired", {
      toolName: input.name,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      source: salvaged.source,
      repaired: salvaged.repaired,
      mechanism: diagnostics.mechanism,
    });
    return { parsed: salvaged.args, rawMessage, diagnostics };
  }
  return { parsed: parsed as Record<string, unknown>, rawMessage, diagnostics };
}
