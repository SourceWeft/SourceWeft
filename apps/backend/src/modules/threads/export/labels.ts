import type {
  artifactTypeSchema,
  ExportThreadLocale,
} from "@sourceweft/contracts";
import type { z } from "zod";

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export type ExportLabels = {
  exportedFrom: string;
  user: string;
  assistant: string;
  source: string;
  image: string;
  imageUnavailable: string;
  stopped: string;
  file: string;
  artifactKinds: Record<ArtifactType, string>;
};

const LABELS: Record<ExportThreadLocale, ExportLabels> = {
  en: {
    exportedFrom: "Exported from SourceWeft",
    user: "User",
    assistant: "Assistant",
    source: "Source",
    image: "Image",
    imageUnavailable: "Image unavailable",
    stopped: "Stopped",
    file: "File",
    artifactKinds: {
      file: "File",
      html: "Page",
      report: "Report",
      slides: "Slides",
      mindmap: "Mind map",
      podcast: "Podcast",
      audio_overview: "Audio overview",
      video_overview: "Video overview",
      video_presentation: "Video presentation",
      flashcards: "Flashcards",
      quiz: "Quiz",
      table: "Table",
      infographic: "Infographic",
      image: "Image",
    },
  },
  "zh-CN": {
    exportedFrom: "导出自 SourceWeft",
    user: "用户",
    assistant: "助手",
    source: "来源",
    image: "图片",
    imageUnavailable: "图片无法获取",
    stopped: "已停止",
    file: "文件",
    artifactKinds: {
      file: "文件",
      html: "网页",
      report: "报告",
      slides: "幻灯片",
      mindmap: "思维导图",
      podcast: "播客",
      audio_overview: "音频概览",
      video_overview: "视频概览",
      video_presentation: "视频演示",
      flashcards: "闪卡",
      quiz: "测验",
      table: "表格",
      infographic: "信息图",
      image: "图片",
    },
  },
  "zh-TW": {
    exportedFrom: "匯出自 SourceWeft",
    user: "使用者",
    assistant: "助理",
    source: "來源",
    image: "圖片",
    imageUnavailable: "無法取得圖片",
    stopped: "已停止",
    file: "檔案",
    artifactKinds: {
      file: "檔案",
      html: "網頁",
      report: "報告",
      slides: "簡報",
      mindmap: "心智圖",
      podcast: "Podcast",
      audio_overview: "音訊概覽",
      video_overview: "影片概覽",
      video_presentation: "影片簡報",
      flashcards: "閃卡",
      quiz: "測驗",
      table: "表格",
      infographic: "資訊圖表",
      image: "圖片",
    },
  },
};

export function exportLabels(locale: ExportThreadLocale): ExportLabels {
  return LABELS[locale];
}
