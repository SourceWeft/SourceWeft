export {
  AssetPlanItemSchema,
  AssetPlanSchema,
  ContentBriefSchema,
  DeckDesignSystemSchema,
  DeckStrategySchema,
  EditablePrimitiveCountsSchema,
  LayoutRegionSchema,
  LayoutSpecSchema,
  PRESENTATION_SOURCE_V1_SCHEMA_VERSION,
  PresentationSourceV1Schema,
  QaIssueSchema,
  QaReportSchema,
  RenderMetadataSchema,
  RequirementAnalysisSchema,
  SlideInstructionSchema,
  SlideEditablePrimitiveCountsSchema,
  TypographyTokenSchema,
  assetKinds,
  deckAspectRatios,
  deckDensities,
  deckLanguages,
  editableCompatibilityVersions,
  layoutKinds,
  qaSeverities,
  renderEngines,
  slideRoles,
} from "./domain/schemas";
export type {
  AssetPlan,
  ContentBrief,
  DeckDesignSystem,
  DeckStrategy,
  EditablePrimitiveCounts,
  LayoutSpec,
  PresentationSourceV1,
  QaReport,
  RenderMetadata,
  RequirementAnalysis,
  SlideEditablePrimitiveCounts,
  SlideInstruction,
} from "./domain/schemas";
export {
  deriveLayoutId,
  getLayoutFamilyDefinition,
  layoutFamilyIds,
  resolveLayoutSpec,
  validateLayoutSequence,
  validateLayoutSpec,
} from "./domain/layout-system";
export type {
  LayoutFamilyDefinition,
  LayoutFamilyId,
  LayoutIssue,
  LayoutIssueCode,
  LayoutSequenceItem,
  LayoutSequenceValidationResult,
  LayoutValidationResult,
  ResolveLayoutSpecResult,
  ValidateLayoutOptions,
} from "./domain/layout-system";
export {
  contrastRatio,
  getVisualSystemPreset,
  repairVisualSystemTokens,
  resolveVisualSystem,
  validateVisualSystemTokens,
  visualSystemPresetIds,
} from "./domain/visual-system";
export type {
  ResolveVisualSystemInput,
  ResolveVisualSystemResult,
  VisualSystemIssue,
  VisualSystemIssueCode,
  VisualSystemPresetId,
  VisualSystemTokens,
} from "./domain/visual-system";
export {
  presentationSourceValidationIssueCodes,
  validatePresentationSourceV1,
} from "./domain/validation";
export {
  PRE_RENDER_QA_MAX_ISSUES,
  preRenderQaContentIssueCodes,
  validatePreRenderQa,
  validatePreRenderQaInput,
} from "./domain/pre-render-qa-validator";
export type {
  PreRenderQaContentIssueCode,
  PreRenderQaInput,
  PreRenderQaUnknownInput,
  PreRenderQaValidationOptions,
} from "./domain/pre-render-qa-validator";
export type {
  PresentationSourceValidationIssue,
  PresentationSourceValidationIssueCode,
  PresentationSourceValidationResult,
} from "./domain/validation";
export type {
  ComposerObservabilityEvent,
  ObservabilityPort,
  PptxRendererPort,
  PptxRenderOptions,
  PptxRenderResult,
} from "./ports";
export {
  createComposePresentationSourceUseCase,
  PresentationComposerQaError,
  REPAIR_LOOP_MAX_ATTEMPTS,
  repairFailureCodes,
  repairPresentationSource,
} from "./use-cases";
export type {
  ComposePresentationSourceDependencies,
  ComposePresentationSourceInput,
  ComposePresentationSourceResult,
  PresentationComposerQaPhase,
  RepairAttemptReport,
  RepairFailure,
  RepairFailureCategory,
  RepairFailureCode,
  RepairPresentationSourceInput,
  RepairPresentationSourceResult,
  SourceMutationSummary,
} from "./use-cases";
export { PptxGenJsRendererAdapter } from "./adapters";
export {
  RENDER_QA_MAX_ISSUES,
  RENDER_QA_MIN_BYTE_LENGTH,
  inspectOoxmlPptx,
  validateRenderQa,
} from "./inspection";
export type { RenderQaInput, RenderQaValidationOptions } from "./inspection";
