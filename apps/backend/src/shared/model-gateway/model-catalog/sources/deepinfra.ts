import {
  canonicalModelId,
  type ModelPricingInfo,
  type NormalizedModelInfo,
} from "../types";

/**
 * DeepInfra's public model list, used for the speech prices no community
 * price book carries: neither LiteLLM nor models.dev lists DeepInfra's Whisper
 * or TTS models. The list needs no key.
 *
 * Only speech models priced by what the gateway measures are adapted: TTS by
 * input characters, ASR by seconds of audio. A model billed by compute time
 * cannot be costed from a request's usage and is left out.
 */
const DEEPINFRA_MODEL_LIST_URL = "https://api.deepinfra.com/models/list";
const REQUEST_TIMEOUT_MS = 20_000;
const CENTS_PER_DOLLAR = 100;

type DeepInfraModel = {
  model_name?: unknown;
  type?: unknown;
  pricing?: {
    type?: unknown;
    cents_per_input_chars?: unknown;
    cents_per_input_sec?: unknown;
  } | null;
};

function centsToDollars(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  // Avoid binary noise such as 3.3300000000000004e-6.
  return Number((value / CENTS_PER_DOLLAR).toPrecision(12));
}

function speechPricing(
  model: DeepInfraModel,
): { modality?: "tts"; pricing: ModelPricingInfo } | null {
  const pricing = model.pricing;
  if (!pricing) return null;
  if (
    model.type === "text-to-speech" &&
    pricing.type === "input_character_length"
  ) {
    const perCharacter = centsToDollars(pricing.cents_per_input_chars);
    return perCharacter === null
      ? null
      : { modality: "tts", pricing: { inputPerCharacter: perCharacter } };
  }
  if (
    model.type === "automatic-speech-recognition" &&
    pricing.type === "input_length"
  ) {
    const perSecond = centsToDollars(pricing.cents_per_input_sec);
    // The catalog has no speech-recognition modality; the price is what matters.
    return perSecond === null
      ? null
      : { pricing: { inputPerSecond: perSecond } };
  }
  return null;
}

/**
 * Fetch DeepInfra's model list and adapt its speech models. A network failure
 * or a body that is not a list of models rejects, so a refresh keeps the
 * previous prices instead of treating the provider as having none.
 */
export async function loadDeepInfraSpeechModels(
  options: { fetchImpl?: typeof fetch; url?: string } = {},
): Promise<NormalizedModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url ?? DEEPINFRA_MODEL_LIST_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to fetch the DeepInfra model list: ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("The DeepInfra model list must be an array of models");
  }

  const models: NormalizedModelInfo[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The DeepInfra model list contains an invalid entry");
    }
    const model = entry as DeepInfraModel;
    if (typeof model.model_name !== "string" || !model.model_name.trim()) {
      continue;
    }
    const speech = speechPricing(model);
    if (!speech) continue;
    models.push({
      id: canonicalModelId(model.model_name),
      provider: "deepinfra",
      ...(speech.modality ? { modality: speech.modality } : {}),
      reasoning: false,
      reasoningEfforts: [],
      toolCall: false,
      structuredOutput: false,
      vision: false,
      pricing: speech.pricing,
      sources: ["deepinfra"],
    });
  }
  return models;
}
