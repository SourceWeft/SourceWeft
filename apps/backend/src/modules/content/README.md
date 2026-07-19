# content module

Shared kernel for the content domain — types, errors, and cross-cutting utilities
used by all content-domain modules (threads, sources, skills, artifacts, etc.).

## Contents

- `errors.ts` — `ContentError` base error class
- `types.ts` — Domain record types (SourceRecord, ThreadRecord, MessageRecord, etc.)
- `queue.ts` — Job type definitions and enqueue helpers (source-parse, thread-title, etc.)
- `billing-port.ts` — `ContentBillingPort` interface (domain port for billing)
- `model-billing.ts` — `meterBillableModelUsage()`, the billing layer's settlement primitive. Not for direct use: reach models through `withBilledModelGateway`, which settles for you.
- `model-gateway-audit.ts` — Gateway audit metadata and `LlmExecutionConfig` types
- `model-gateway-error.ts` — `toContentError()` gateway error normalization

## Usage

Domain services should be imported directly from their respective modules:

```typescript
import { contentThreadService } from "../threads"
import { contentSourceService } from "../sources"
import { contentSkillsService } from "../skills"
import { contentArtifactsService } from "../artifacts"
import { workingFilesService } from "../working-files"
```

Shared kernel utilities are re-exported from `index.ts`.
