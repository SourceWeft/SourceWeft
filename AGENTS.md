# Repository agent instructions

## Fallback policy

- Do not silently fallback to a different implementation, model, provider, data source, command, test strategy, or dependency.
- If the requested path fails, first report the exact blocker and retry only when the retry addresses the blocker.
- If sandbox, network, permission, auth, or dependency access is missing, request the needed approval instead of inventing a workaround.
- Before using a fallback, state: original plan, failure reason, proposed fallback, behavior difference, and verification impact.
- Prefer failing fast over producing an unverified approximation.

## Global model Provider activation

These rules apply to deployment-level/System model Providers. They do not replace database-backed BYOK state.

- Keep Provider activation and credentials separate.
- A Provider activation environment variable expresses deployment intent; a Provider API-key environment variable supplies only a credential.
- Never activate a Provider because its API key is present.
- Raw global gateway configuration uses an `activation` object:

  ```json
  {
    "activation": {
      "env": "ORCAROUTER_ENABLED",
      "default": false
    },
    "apiKeyEnv": "ORCAROUTER_API_KEY"
  }
  ```

- Remove and reject gateway-level raw `isActive`; no backwards-compatibility parser is required because this configuration format has not been released.
- `activation.env` must name a strict boolean environment variable. Accept only `true`, `false`, `1`, or `0`, ignoring case and surrounding whitespace. Invalid values fail configuration loading.
- If the activation environment variable is absent, use `activation.default`.
- Resolve three distinct states:
  - `enabled`: activation env/default result;
  - `configured`: every global credential declared by the gateway is present, or the gateway declares no global credential;
  - `globalReady`: `enabled && configured`.
- OpenRouter uses `OPENROUTER_ENABLED`, defaults enabled, and uses `OPENROUTER_API_KEY` separately.
- OrcaRouter uses `ORCAROUTER_ENABLED`, defaults disabled, and uses `ORCAROUTER_API_KEY` separately.
- DeepInfra, DeepSeek, and SiliconFlow remain custom global Providers; do not add them back to the shipped default gateway list. Their documentation must state that env variables take effect only when referenced by a custom global gateway entry.
- Profile-level `isActive`, route topology, `isDefault`, and `modelCatalog.enabled` remain configuration concerns and are not replaced by Provider activation env variables.
- Persist global `enabled` in the existing gateway/provider `isActive` database columns. Preserve non-secret configured/readiness diagnostics separately and recompute runtime readiness from persisted enabled state plus actual credential presence.
- GLOBAL routing and authenticated catalog discovery require `globalReady`.
- Disabled or credential-incomplete Providers must not enter GLOBAL routing or authenticated catalog discovery.
- Invalid config fails fast. A globally enabled Provider with a missing optional deployment credential may leave the service running, but must be reported as not configured/not ready and must not silently select an undeclared Provider.
- A catalog failure for a globally ready Provider must not switch data sources or activate a partial configuration version. Abort the sync before activating the new version and retain the previously active version.
- Include resolved base URL, activation source, enabled, configured, and globalReady in the safe configuration fingerprint. Never hash or expose credential contents. Credential absent/present changes the fingerprint; rotation from one non-empty value to another does not.
- Docker and backend env examples expose separate `*_ENABLED` and `*_API_KEY` variables. Docker defaults are `OPENROUTER_ENABLED=true` and `ORCAROUTER_ENABLED=false`.

## BYOK boundary

- BYOK credentials remain encrypted in `model_gateway_byok_credentials`; BYOK models remain in `model_gateway_byok_models`.
- BYOK credential/model `isActive` database values remain their activation controls.
- Global `*_ENABLED` and `*_API_KEY` variables must not activate, deactivate, or satisfy BYOK credentials.
- BYOK readiness depends on an active, authorized database credential/model, successful secret decryption, and complete Provider metadata.
- BYOK may reuse a non-secret System Provider definition even when that Provider is disabled for GLOBAL traffic, but it must never reuse the global activation state or global API key.
- BYOK changes do not alter the global model-gateway configuration hash.
- The existing gateway-level `isBYOK` field is a billing/cost-ownership classification, not BYOK credential storage or Provider activation.

## Verification requirements for Provider activation changes

- Cover strict activation parsing, missing/malformed activation, rejection of raw gateway `isActive`, and every enabled/key readiness combination.
- Cover OpenRouter and OrcaRouter defaults without depending on ambient developer environment variables.
- Cover configuration-hash changes without secret exposure.
- Cover sync persistence, catalog eligibility, atomic catalog failure, GLOBAL route filtering, and safe no-ready-target errors.
- Cover BYOK operation while the same System Provider is globally disabled, and prove that global credentials cannot satisfy BYOK.
- Cover Docker Compose defaults and consistency between shipped config and env examples.
