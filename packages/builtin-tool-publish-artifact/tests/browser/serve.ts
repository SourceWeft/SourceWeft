import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { artifactExecutionCsp } from "@sourceweft/contracts/artifact-execution";
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const output = resolve(root, "output/playwright/html-artifact");
await mkdir(output, { recursive: true });
const bundle = await build({
  metafile: true,
  entryPoints: [fileURLToPath(new URL("./index.tsx", import.meta.url))],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  outfile: resolve(output, "app.js"),
  define: { "process.env.NODE_ENV": '"development"' },
});
for (const file of Object.keys(bundle.metafile!.inputs)) {
  if (!resolve(file).startsWith(root + "/"))
    throw new Error("Browser fixture resolved outside the worktree: " + file);
}
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;font-family:sans-serif}body{display:grid;place-items:center;background:#fcfaf5;color:#252922}button{font:inherit;padding:12px}h1{font-size:48px}p{font-size:24px}</style></head><body><main><p>SourceWeft / independent producer</p><h1 id="title">Overview</h1><button id="counter">Count: 0</button></main><script>
let count=0;document.getElementById('counter').onclick=()=>document.getElementById('counter').textContent='Count: '+(++count);
let channel=null,index=0;const state=()=>({slideIndex:index,slideCount:2,fragmentIndex:-1,overview:false});
window.addEventListener('message',e=>{const d=e.data;if(e.source!==parent||!d||d.protocol!=='presentation/v1')return;
if(d.type==='init'){channel=d.channelId;parent.postMessage({protocol:d.protocol,type:'ready',channelId:channel,state:state()},'*');return;}
if(d.channelId!==channel||d.type!=='command')return;
if(d.command==='next')index=Math.min(1,index+1);if(d.command==='prev')index=Math.max(0,index-1);if(d.command==='goto')index=d.slideIndex;
document.getElementById('title').textContent=index?'Details':'Overview';parent.postMessage({protocol:d.protocol,type:'ack',channelId:channel,requestId:d.requestId,state:state()},'*');});
</script></body></html>`;
const index =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script src="/app.js"></script></body></html>';
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/document.html" || url.pathname === "/plain.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      artifactExecutionCsp("sandboxed-html"),
    );
    res.setHeader("Cache-Control", "no-store");
    if (url.searchParams.has("download"))
      res.setHeader("Content-Disposition", 'attachment; filename="index.html"');
    res.end(
      url.pathname === "/plain.html"
        ? html.replace(
            /window.addEventListener\('message'[\s\S]*?<\/script>/,
            "</script>",
          )
        : html,
    );
    return;
  }
  if (url.pathname === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(resolve(output, "app.js")));
    return;
  }
  if (url.pathname === "/styles.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(await readFile(resolve(root, "packages/ui/dist/index.css")));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(index);
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("No address");
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(
    resolve(output, "server.json"),
    JSON.stringify({ url, output }),
  );
  console.log(url);
});
