import { defineConfig } from "wxt";

function apiHostPermission() {
  const base = process.env.VITE_API_BASE_URL || "http://localhost:3001";
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return "http://localhost:3001/*";
  }
}

export default defineConfig({
  browser: "chrome",
  dev: {
    server: {
      port: 3002,
    },
  },
  targetBrowsers: ["chrome", "edge"],
  manifestVersion: 3,
  manifest: {
    name: "VelaMind",
    description: "VelaMind browser extension",
    permissions: ["storage", "activeTab", "scripting", "identity"],
    host_permissions: [apiHostPermission()],
    icons: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
    action: {
      default_icon: {
        16: "icon-16.png",
        32: "icon-32.png",
        48: "icon-48.png",
        128: "icon-128.png",
      },
    },
  },
});
