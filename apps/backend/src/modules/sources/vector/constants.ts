import { config } from "../../../shared/config";

export const MAX_VECTOR_DIMENSIONS = config.vectorSearch.maxDimensions;
export const VECTOR_DISTANCE_OPS = ["cosine"] as const;
