import type { YouTubeUrlTarget } from "../url";

export type YouTubeVideoInfo = {
  videoId: string;
  title: string;
  titleSource: "oembed" | "fallback";
  channelTitle?: string;
  channelUrl?: string;
  thumbnailUrl?: string;
};

export type YouTubeCollectionVideo = {
  videoId: string;
  title: string;
  url: string;
  publishedAt?: string;
  thumbnailUrl?: string;
};

export type YouTubeCollection = {
  kind: "playlist" | "channel";
  title: string;
  channelTitle?: string;
  videos: YouTubeCollectionVideo[];
};

export interface YouTubeCatalogProvider {
  readonly id: string;
  getVideo(videoId: string): Promise<YouTubeVideoInfo>;
  listCollection(
    target: Extract<YouTubeUrlTarget, { kind: "playlist" | "channel" }>,
  ): Promise<YouTubeCollection>;
}
