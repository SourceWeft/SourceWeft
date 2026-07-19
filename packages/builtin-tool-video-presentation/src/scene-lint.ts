import ts from "typescript";

/**
 * Static layout lint for generated Remotion scene TSX.
 *
 * Catches occlusion/overflow red flags that are visible in literals: text
 * positioned at or beyond canvas edges, oversized fonts, negative margins,
 * missing SafeArea, and on-screen text overload.
 *
 * Severity contract:
 * - errors feed the scene repair loop and may fail the pipeline.
 * - warnings get at most one targeted repair attempt and are then accepted —
 *   they must never hard-fail the pipeline.
 *
 * Deliberately out of scope (needs pixels, left to visual QA): real sibling
 * overlap, contrast, z-index stacking over text, and any style computed at
 * runtime from non-literal expressions.
 */

export type SceneLayoutLintResult = {
  errors: string[];
  warnings: string[];
};

type Canvas = { width: number; height: number };

const HARD_FONT_RATIO = 0.12;
const SOFT_FONT_RATIO = 0.085;
const MAX_SCENE_TEXT_CHARS = 200;
const MAX_TEXT_NODE_CHARS = 90;
const EDGE_PROPS = ["top", "left", "right", "bottom"] as const;

function numericValue(node: ts.Expression): number | null {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property)) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

function jsxElementName(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): string {
  const tag = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : node.tagName;
  return tag.getText();
}

function hasMeaningfulJsxText(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isJsxText(child) && child.text.trim().length > 0) {
      found = true;
      return;
    }
    if (
      ts.isJsxExpression(child) &&
      child.expression &&
      ts.isStringLiteralLike(child.expression) &&
      child.expression.text.trim().length > 0
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function styleObjectOf(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): ts.ObjectLiteralExpression | null {
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
  for (const attribute of attributes.properties) {
    if (
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === "style" &&
      attribute.initializer &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression &&
      ts.isObjectLiteralExpression(attribute.initializer.expression)
    ) {
      return attribute.initializer.expression;
    }
  }
  return null;
}

function interpolateSettledEndpoint(node: ts.Expression): number | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression)) return null;
  if (node.expression.text !== "interpolate") return null;
  const outputRange = node.arguments[2];
  if (!outputRange || !ts.isArrayLiteralExpression(outputRange)) return null;
  const last = outputRange.elements.at(-1);
  if (!last) return null;
  return numericValue(last);
}

export type SceneLayoutLintOptions = {
  /**
   * Image URLs a scene is allowed to reference in Img/AssetImage src.
   * Any other http(s):// or /v1/ string-literal src is an error — generated
   * scenes must never invent image URLs.
   */
  allowedImageUrls?: readonly string[];
};

export function lintSceneLayout(
  code: string,
  canvas: Canvas,
  options?: SceneLayoutLintOptions,
): SceneLayoutLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      "VideoScene.tsx",
      code,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
  } catch {
    // Unparseable code is already covered by the syntax diagnostics.
    return { errors, warnings };
  }

  const hardFontLimit = Math.round(canvas.height * HARD_FONT_RATIO);
  const softFontLimit = Math.round(canvas.height * SOFT_FONT_RATIO);
  let sawSafeArea = false;
  let sawText = false;
  let totalTextChars = 0;

  const recordTextNode = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sawText = true;
    totalTextChars += trimmed.length;
    if (trimmed.length > MAX_TEXT_NODE_CHARS) {
      warnings.push(
        `A single text node has ${trimmed.length} characters (max ~${MAX_TEXT_NODE_CHARS}); split or shorten it: "${trimmed.slice(0, 40)}..."`,
      );
    }
  };

  const checkStyleObject = (
    style: ts.ObjectLiteralExpression,
    elementHasText: boolean,
    elementName: string,
  ) => {
    let isAbsolute = false;
    for (const property of style.properties) {
      const name = propertyName(property);
      if (!ts.isPropertyAssignment(property) || !name) continue;
      if (
        name === "position" &&
        ts.isStringLiteralLike(property.initializer) &&
        property.initializer.text === "absolute"
      ) {
        isAbsolute = true;
      }
    }
    for (const property of style.properties) {
      const name = propertyName(property);
      if (!ts.isPropertyAssignment(property) || !name) continue;
      const value = numericValue(property.initializer);

      if (name === "fontSize" && value !== null) {
        if (value > hardFontLimit) {
          errors.push(
            `<${elementName}> fontSize ${value}px exceeds the hard limit ${hardFontLimit}px (12% of canvas height ${canvas.height}px).`,
          );
        } else if (value > softFontLimit) {
          warnings.push(
            `<${elementName}> fontSize ${value}px exceeds the recommended limit ${softFontLimit}px (8.5% of canvas height).`,
          );
        }
      }

      if (name.startsWith("margin") && value !== null && value < 0) {
        errors.push(
          `<${elementName}> uses a negative margin (${name}: ${value}); negative margins push content off layout.`,
        );
      }

      if (
        (name === "width" || name === "height") &&
        value !== null &&
        value > (name === "width" ? canvas.width : canvas.height)
      ) {
        errors.push(
          `<${elementName}> ${name}: ${value}px exceeds the canvas ${name} (${name === "width" ? canvas.width : canvas.height}px).`,
        );
      }

      if (isAbsolute && (EDGE_PROPS as readonly string[]).includes(name)) {
        const maxExtent = name === "top" || name === "bottom"
          ? canvas.height
          : canvas.width;
        if (value !== null && (value < 0 || value > maxExtent)) {
          const message = `<${elementName}> is absolutely positioned with ${name}: ${value}, which lands at or beyond the canvas edge (${maxExtent}px).`;
          if (elementHasText) {
            errors.push(message);
          } else {
            warnings.push(message);
          }
        }
        const settled = interpolateSettledEndpoint(property.initializer);
        if (settled !== null && (settled < 0 || settled > maxExtent)) {
          warnings.push(
            `<${elementName}> animates ${name} via interpolate and settles at ${settled}, outside the canvas (0..${maxExtent}).`,
          );
        }
      }
    }
  };

  const allowedImageUrls = new Set(options?.allowedImageUrls ?? []);

  const checkImageSrc = (
    node: ts.JsxElement | ts.JsxSelfClosingElement,
    elementName: string,
  ) => {
    const attributes = ts.isJsxElement(node)
      ? node.openingElement.attributes
      : node.attributes;
    for (const attribute of attributes.properties) {
      if (
        !ts.isJsxAttribute(attribute) ||
        !ts.isIdentifier(attribute.name) ||
        attribute.name.text !== "src" ||
        !attribute.initializer
      ) {
        continue;
      }
      let literal: string | null = null;
      if (ts.isStringLiteral(attribute.initializer)) {
        literal = attribute.initializer.text;
      } else if (
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        ts.isStringLiteralLike(attribute.initializer.expression)
      ) {
        literal = attribute.initializer.expression.text;
      }
      if (!literal) {
        continue;
      }
      const looksRemote =
        literal.startsWith("http://") ||
        literal.startsWith("https://") ||
        literal.startsWith("/v1/");
      if (looksRemote && !allowedImageUrls.has(literal)) {
        errors.push(
          `<${elementName}> references an image URL that is not in the provided asset list: ${literal.slice(0, 120)}. Use only the exact asset urls supplied in the prompt, or no images.`,
        );
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      recordTextNode(node.text);
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteralLike(node.expression)
    ) {
      recordTextNode(node.expression.text);
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = jsxElementName(node);
      if (name === "SafeArea") {
        sawSafeArea = true;
      }
      if (name === "Img" || name === "AssetImage") {
        checkImageSrc(node, name);
      }
      const style = styleObjectOf(node);
      if (style) {
        checkStyleObject(style, hasMeaningfulJsxText(node), name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (sawText && !sawSafeArea) {
    errors.push(
      "Scene renders text but contains no <SafeArea>; all text content must live inside one <SafeArea> so it stays within safe margins.",
    );
  }
  if (totalTextChars > MAX_SCENE_TEXT_CHARS) {
    warnings.push(
      `Scene renders ~${totalTextChars} characters of on-screen text (max ~${MAX_SCENE_TEXT_CHARS}); distill to 1-2 high-impact phrases.`,
    );
  }

  return { errors, warnings };
}
