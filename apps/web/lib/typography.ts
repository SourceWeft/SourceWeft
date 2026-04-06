import {
  Geist,
  Geist_Mono,
  Noto_Sans_Arabic,
  Noto_Sans_Devanagari,
  Noto_Sans_Hebrew,
  Noto_Sans_JP,
  Noto_Sans_KR,
  Noto_Sans_SC,
  Noto_Sans_TC,
  Noto_Sans_Thai,
  Sora,
} from "next/font/google";

const fontUiLatin = Geist({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-ui-latin",
  weight: ["400", "500", "600", "700"],
});

const fontMonoLatin = Geist_Mono({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-mono-latin",
  weight: ["400", "500", "600", "700"],
});

const fontBrandLatin = Sora({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-brand-sora",
  weight: ["600", "700"],
});

const fontUiSC = Noto_Sans_SC({
  display: "swap",
  preload: false,
  variable: "--font-ui-cjk-sc",
  weight: ["400", "500", "700"],
});

const fontUiTC = Noto_Sans_TC({
  display: "swap",
  preload: false,
  variable: "--font-ui-cjk-tc",
  weight: ["400", "500", "700"],
});

const fontUiJP = Noto_Sans_JP({
  display: "swap",
  preload: false,
  variable: "--font-ui-cjk-jp",
  weight: ["400", "500", "700"],
});

const fontUiKR = Noto_Sans_KR({
  display: "swap",
  preload: false,
  variable: "--font-ui-cjk-kr",
  weight: ["400", "500", "700"],
});

const fontUiArabic = Noto_Sans_Arabic({
  display: "swap",
  preload: false,
  subsets: ["arabic"],
  variable: "--font-ui-arabic",
  weight: ["400", "500", "700"],
});

const fontUiHebrew = Noto_Sans_Hebrew({
  display: "swap",
  preload: false,
  subsets: ["hebrew"],
  variable: "--font-ui-hebrew",
  weight: ["400", "500", "700"],
});

const fontUiDevanagari = Noto_Sans_Devanagari({
  display: "swap",
  preload: false,
  subsets: ["devanagari"],
  variable: "--font-ui-devanagari",
  weight: ["400", "500", "700"],
});

const fontUiThai = Noto_Sans_Thai({
  display: "swap",
  preload: false,
  subsets: ["thai"],
  variable: "--font-ui-thai",
  weight: ["400", "500", "700"],
});

export const typographyVariableClassName = [
  fontUiLatin.variable,
  fontMonoLatin.variable,
  fontBrandLatin.variable,
  fontUiSC.variable,
  fontUiTC.variable,
  fontUiJP.variable,
  fontUiKR.variable,
  fontUiArabic.variable,
  fontUiHebrew.variable,
  fontUiDevanagari.variable,
  fontUiThai.variable,
].join(" ");
