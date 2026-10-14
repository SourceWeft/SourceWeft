import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMailTemplate } from "../modules/mail/templates";

// Generates local examples only. No provider is imported and no email is sent.
const output = resolve(
  process.argv[2] ||
    resolve(import.meta.dirname, "../../../../.docs/mail-preview"),
);
mkdirSync(output, { recursive: true });
copyFileSync(
  resolve(import.meta.dirname, "../../../web/public/icon-512.png"),
  resolve(output, "icon-512.png"),
);
const ids = readdirSync(
  resolve(import.meta.dirname, "../modules/mail/templates"),
)
  .filter(
    (name) =>
      /^(auth|org|workspace)\./.test(name) &&
      name.endsWith(".html") &&
      !/\.zh-(CN|TW)\.html$/.test(name),
  )
  .map((name) => name.replace(/\.html$/, ""));
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const entries: {
  id: string;
  locale: string;
  subject: string;
  filename: string;
}[] = [];
for (const locale of ["zh-CN", "zh-TW", "en"]) {
  for (const id of ids) {
    const rendered = renderMailTemplate(
      id,
      {
        baseUrl: "https://sourceweft.example",
        imageUrl: "./icon-512.png",
        url: "https://sourceweft.example/preview-action?token=example",
        dashboardUrl: "https://sourceweft.example/dashboard",
        docsUrl: "https://sourceweft.example/docs",
        discordUrl: "https://discord.gg/KNqTGh2qrk",
        greeting: locale === "en" ? "Hi Alex," : "Alex，你好！",
        otp: "028491",
        inviterLabel: "Alex",
        organizationName: locale === "en" ? "Research team" : "研究团队",
        workspaceName: locale === "en" ? "Product research" : "产品研究",
      },
      locale,
    );
    const filename = `${id}.${locale}.html`;
    writeFileSync(resolve(output, filename), rendered.html);
    writeFileSync(
      resolve(output, filename.replace(/\.html$/, ".txt")),
      `${rendered.subject}\n\n${rendered.text}\n`,
    );
    entries.push({ id, locale, subject: rendered.subject, filename });
  }
}
writeFileSync(
  resolve(output, "index.html"),
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SourceWeft 邮件预览</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#edeef0;color:#17191c;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:#fff;border-bottom:1px solid #dfe1e5;padding:24px 32px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.7px}p{margin:0;color:#666}nav{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px;align-items:center}select,button,a{font:inherit}select,button{background:#fff;border:1px solid #ccc;border-radius:6px;padding:8px 12px}button[aria-pressed=true]{background:#17191c;color:#fff}a{color:#444}main{max-width:960px;margin:24px auto;padding:0 16px}.subject{font-size:14px;margin-bottom:12px}iframe{display:block;border:0;width:100%;height:850px;margin:auto;background:#fff;border-radius:10px}iframe.mobile{width:375px;max-width:100%}@media(max-width:600px){header{padding:20px}nav select{max-width:100%}main{padding:0 8px}}
</style></head><body><header><h1>SourceWeft · 用户邮件</h1><p>实际模板渲染 · 示例数据 · 不会发送邮件</p><nav>
<label>语言 <select id="locale"><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option></select></label>
<label>邮件 <select id="template">${ids.map((id) => `<option value="${escape(id)}"${id === "auth.welcome" ? " selected" : ""}>${escape(id)}</option>`).join("")}</select></label>
<button id="desktop" aria-pressed="true">桌面</button><button id="mobile" aria-pressed="false">手机</button><a id="text" target="_blank">纯文本</a>
</nav></header><main><div class="subject" id="subject"></div><iframe id="mail" title="邮件内容预览"></iframe></main>
<script>
const entries=${JSON.stringify(entries).replace(/</g, "\\u003c")};
const locale=document.getElementById('locale'),template=document.getElementById('template'),mail=document.getElementById('mail');
function update(){const entry=entries.find(e=>e.locale===locale.value&&e.id===template.value);mail.src=entry.filename;document.getElementById('subject').textContent='主题：'+entry.subject;document.getElementById('text').href=entry.filename.replace(/html$/,'txt');}
locale.onchange=template.onchange=update;
for(const mode of ['desktop','mobile'])document.getElementById(mode).onclick=()=>{mail.classList.toggle('mobile',mode==='mobile');for(const m of ['desktop','mobile'])document.getElementById(m).setAttribute('aria-pressed',String(m===mode));};
update();
</script></body></html>`,
);
console.log(
  `Generated ${entries.length} user emails: ${resolve(output, "index.html")}`,
);
