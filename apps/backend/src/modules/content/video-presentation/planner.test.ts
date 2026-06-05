import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./planner";

test("video presentation fallback theme follows warm academic prompt", () => {
  const spec = testExports.buildFallbackSpec({
    narrationEnabled: true,
    sourceContent:
      "费曼学习法强调用自己的语言解释概念，并通过发现卡壳位置来补足知识漏洞。",
    title: "费曼学习法",
    userPrompt:
      "温暖学术感，深蓝、米白、金色点缀，平静有力的旁白，简洁文字动画，从容节奏。",
  });

  assert.equal(spec.theme.background, "#f6efe2");
  assert.equal(spec.theme.accent, "#b8872b");
  assert.match(spec.theme.fontFamily, /Serif/);
});

test("video presentation fallback avoids generic key point titles and markdown narration", () => {
  const spec = testExports.buildFallbackSpec({
    narrationEnabled: true,
    sourceContent: `
# 费曼学习法：世界最高效的学习方法

## 什么是费曼学习法
费曼学习法强调用自己的语言解释概念。

## 四个步骤
### 第一步：选择目标概念
拿出一张白纸，写下你想学习的主题。

### 第二步：用简单语言解释
假装你在给一个孩子讲解这个概念。
`,
    title: "费曼学习法",
    userPrompt: "简洁现代，中文旁白。",
  });

  assert.equal(spec.slides.some((slide) => /^Key Point/i.test(slide.title)), false);
  assert.equal(
    spec.slides.some((slide) =>
      slide.speakerTranscript.some((line) => line.includes("#")),
    ),
    false,
  );
  assert.equal(
    spec.scenes.some((scene) =>
      scene.bullets.some((bullet) => bullet.includes("#")),
    ),
    false,
  );
});

test("video presentation planner strips creative direction from visible fields", () => {
  const creativeDirection =
    "制作一个面向中文观众的费曼学习法介绍视频，风格偏向温暖学术感，深蓝、米白、金色点缀。";
  const sanitized = testExports.sanitizePlannedContent(
    {
      title: "费曼学习法",
      slides: [
        {
          slideNumber: 1,
          title: creativeDirection,
          contentMarkdown: "费曼学习法强调用简单语言解释复杂概念。",
          speakerTranscript: [creativeDirection],
        },
      ],
      scenes: [
        {
          slideNumber: 1,
          sceneType: "title",
          composition: "cinematic",
          mood: "calm",
          title: creativeDirection,
          subtitle: creativeDirection,
          bullets: [creativeDirection, "用自己的语言讲清楚"],
          metrics: [],
          timeline: [],
          motion: {
            camera: "slow-push",
            emphasis: "spotlight",
            entrance: "rise",
            transition: "fade",
          },
        },
      ],
    },
    {
      title: "费曼学习法",
      userPrompt: creativeDirection,
    },
  );

  assert.equal(sanitized.slides[0]?.title, "费曼学习法");
  assert.equal(
    sanitized.slides[0]?.speakerTranscript[0],
    "费曼学习法强调用简单语言解释复杂概念。",
  );
  assert.equal(sanitized.scenes[0]?.title, "费曼学习法");
  assert.equal(sanitized.scenes[0]?.subtitle, undefined);
  assert.deepEqual(sanitized.scenes[0]?.bullets, ["用自己的语言讲清楚"]);
});

test("video presentation planner accepts common scene and slide aliases", () => {
  const parsed = testExports.plannerResponseSchema.parse({
    title: "费曼学习法",
    narrationEnabled: true,
    slides: [
      {
        slideNumber: 1,
        title: "费曼学习法",
        content: "用教别人的方式检验理解。",
        speakerTranscript: "费曼学习法强调把知识讲给别人听。",
      },
    ],
    scenes: [
      {
        slideNumber: 1,
        type: "title",
        title: "费曼学习法",
        bullets: ["用教别人的方式检验理解"],
      },
    ],
  });

  assert.equal(parsed.slides[0]?.contentMarkdown, "用教别人的方式检验理解。");
  assert.deepEqual(parsed.slides[0]?.speakerTranscript, [
    "费曼学习法强调把知识讲给别人听。",
  ]);
  assert.equal(parsed.scenes[0]?.sceneType, "title");
});

test("video presentation planner sanitizes markdown from visible fields", () => {
  const sanitized = testExports.sanitizePlannedContent(
    {
      title: "费曼学习法",
      slides: [
        {
          slideNumber: 1,
          title: "# 费曼学习法 [citation:c1]",
          contentMarkdown: "## 用教别人的方式学习 [citation:c2]",
          speakerTranscript: [
            "# 费曼学习法 ## 用简单语言讲清楚 [citation:c3]",
          ],
        },
      ],
      scenes: [
        {
          slideNumber: 1,
          sceneType: "title",
          composition: "cinematic",
          mood: "calm",
          title: "# 费曼学习法 [citation:c4]",
          bullets: ["## 用简单语言讲清楚 [citation:c5]"],
          metrics: [],
          timeline: [],
          motion: {
            camera: "slow-push",
            emphasis: "spotlight",
            entrance: "rise",
            transition: "fade",
          },
        },
      ],
    },
    { title: "费曼学习法" },
  );

  assert.equal(sanitized.slides[0]?.title, "费曼学习法");
  assert.equal(
    sanitized.slides[0]?.speakerTranscript[0],
    "费曼学习法 用简单语言讲清楚",
  );
  assert.equal(sanitized.scenes[0]?.title, "费曼学习法");
  assert.deepEqual(sanitized.scenes[0]?.bullets, ["用简单语言讲清楚"]);
});

test("video presentation fallback strips citation markers from visible fields", () => {
  const spec = testExports.buildFallbackSpec({
    narrationEnabled: true,
    sourceContent: `
费曼学习法强调用自己的语言解释概念 [citation:c1]。
为什么有效：它会暴露知识盲区【citation:c2】，并促使学习者回到材料补足缺口。
第一步：选择概念 (citation:c3)。第二步：教给别人。
`,
    title: "费曼学习法",
    userPrompt: "清爽白板风格。",
  });

  const serialized = JSON.stringify({
    slides: spec.slides,
    scenes: spec.scenes,
  });

  assert.equal(serialized.includes("citation:"), false);
  assert.equal(spec.slides.some((slide) => slide.title.endsWith("...")), false);
});
