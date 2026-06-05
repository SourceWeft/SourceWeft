import { PresentationSourceV1Schema } from "../domain/schemas";
import type { PreRenderQaInput } from "../domain/pre-render-qa-validator";
import type { PresentationSourceV1, QaReport, RenderMetadata } from "../domain/schemas";
import type { RenderQaInput } from "../inspection";
import type {
  ObservabilityPort,
  PptxRendererPort,
  PptxRenderOptions,
} from "../ports";

type QaValidator = (input: PreRenderQaInput) => Promise<QaReport> | QaReport;
type RenderQaValidator = (input: RenderQaInput) => Promise<QaReport> | QaReport;

export type ComposePresentationSourceDependencies = {
  readonly renderer: PptxRendererPort;
  readonly qaValidator?: QaValidator;
  readonly renderQaValidator?: RenderQaValidator;
  readonly observability?: ObservabilityPort;
};

export type ComposePresentationSourceInput = {
  readonly source: PresentationSourceV1;
  readonly renderOptions?: PptxRenderOptions;
  readonly failOnQaErrors?: boolean;
  readonly failOnRenderQaErrors?: boolean;
};

export type ComposePresentationSourceResult = {
  readonly source: PresentationSourceV1;
  readonly pptxBuffer: Buffer;
  readonly renderMetadata: RenderMetadata;
  readonly qaReport: QaReport;
  readonly renderQaReport: QaReport;
};

export type PresentationComposerQaPhase = "source" | "render";

export class PresentationComposerQaError extends Error {
  readonly phase: PresentationComposerQaPhase;
  readonly qaReport: QaReport;

  constructor(phase: PresentationComposerQaPhase, qaReport: QaReport) {
    super(phase === "source" ? "Presentation source QA failed" : "Rendered presentation QA failed");
    this.name = "PresentationComposerQaError";
    this.phase = phase;
    this.qaReport = qaReport;
  }
}

export function createComposePresentationSourceUseCase(
  dependencies: ComposePresentationSourceDependencies,
) {
  return async function composePresentationSource(
    input: ComposePresentationSourceInput,
  ): Promise<ComposePresentationSourceResult> {
    const source = PresentationSourceV1Schema.parse(input.source);

    await dependencies.observability?.recordEvent({
      name: "pptx_composer.compose_started",
      attributes: { slideCount: source.slides.length },
    });

    const qaReport = await resolveQaReport({
      source,
      qaValidator: dependencies.qaValidator,
    });

    if (input.failOnQaErrors === true && qaReport.status === "failed") {
      await dependencies.observability?.recordEvent({
        name: "pptx_composer.compose_failed",
        attributes: { reason: "qa_error", issueCount: qaReport.issues.length },
      });
      throw new PresentationComposerQaError("source", qaReport);
    }

    const rendered = await dependencies.renderer.renderPresentation({
      source,
      options: input.renderOptions,
    });

    const renderQaReport = await resolveRenderQaReport({
      source,
      pptxBuffer: rendered.pptxBuffer,
      renderQaValidator: dependencies.renderQaValidator,
    });

    if (input.failOnRenderQaErrors === true && renderQaReport.status === "failed") {
      await dependencies.observability?.recordEvent({
        name: "pptx_composer.compose_failed",
        attributes: { reason: "render_qa_error", issueCount: renderQaReport.issues.length },
      });
      throw new PresentationComposerQaError("render", renderQaReport);
    }

    await dependencies.observability?.recordEvent({
      name: "pptx_composer.compose_completed",
      attributes: {
        byteLength: rendered.pptxBuffer.byteLength,
        slideCount: rendered.metadata.slideCount,
      },
    });

    return {
      source,
      pptxBuffer: rendered.pptxBuffer,
      renderMetadata: rendered.metadata,
      qaReport,
      renderQaReport,
    };
  };
}

async function resolveQaReport(input: {
  source: PresentationSourceV1;
  qaValidator?: QaValidator;
}): Promise<QaReport> {
  if (input.qaValidator) {
    return input.qaValidator({ source: input.source });
  }

  return input.source.qaReport;
}

async function resolveRenderQaReport(input: {
  source: PresentationSourceV1;
  pptxBuffer: Buffer;
  renderQaValidator?: RenderQaValidator;
}): Promise<QaReport> {
  if (input.renderQaValidator) {
    return input.renderQaValidator({
      source: input.source,
      pptxBuffer: input.pptxBuffer,
    });
  }

  return { status: "not_run", issues: [], extensions: { phase: "render" } };
}
