// 临时脚本：生成横屏（Pad 用）版式模板预览 PDF，不影响正式脚本
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const DIR = __dirname;
const EDGE_CANDIDATES = [
  process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.ProgramFiles + "\\Microsoft\\Edge\\Application\\msedge.exe",
];
const findEdge = () => EDGE_CANDIDATES.find((p) => p && fs.existsSync(p)) || "msedge";
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function highlight(en, word) {
  let html = esc(en).replace(/&lt;vocab&gt;/g, '<b class="hl">').replace(/&lt;\/vocab&gt;/g, "</b>");
  if (html.indexOf('<b class="hl">') === -1 && word) {
    const stem = word.replace(/'s$/i, "");
    const suffix = "(?:s|es|ed|d|ing|'s)?";
    const pattern = "(?<![A-Za-z])" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + suffix + "(?![A-Za-z])";
    try { html = html.replace(new RegExp(pattern, "gi"), (m) => '<b class="hl">' + m + "</b>"); } catch (e) {}
  }
  return html;
}

// 读今天的数据（json 保存在输出目录）
const words = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), "Desktop", "每日新词例句", "2026-09-03.json"), "utf8")
).slice(0, 16);

// 例句重排：第 1 句扇贝普通例句，第 2 句真题例句（最多 2 句）
function orderExs(exs) {
  const reg = exs.filter((e) => e.tag !== "真题").map((e) => ({ ...e, tag: "扇贝" }));
  const ext = exs.filter((e) => e.tag === "真题");
  const out = [];
  if (reg.length) out.push(reg[0]);
  if (ext.length) out.push(ext[0]);
  return out;
}

const cardHtml = words
  .map((w, i) => {
    const ipa = [w.ipa_uk, w.ipa_us].filter(Boolean).join(" / ");
    const senses = (w.senses || []).map((s) => [s.pos, s.definition_cn].filter(Boolean).join(" ")).filter(Boolean).join("；");
    const exs = orderExs(w.exs || []).length
      ? orderExs(w.exs || []).map((e) => `
      <div class="ex">
        <div class="ex-en">${e.tag ? `<span class="tag ${e.tag === "真题" ? "t-ext" : "t-reg"}">${e.tag}</span>` : ""}${highlight(e.en, w.word)}</div>
        <div class="ex-cn">${esc(e.cn)}</div>
      </div>`).join("")
      : `<div class="ex"><div class="ex-cn dim">（暂无例句）</div></div>`;
    return `
    <div class="w">
      <div class="head">
        <span class="idx">${i + 1}.</span><span class="word">${esc(w.word)}</span>
        ${ipa ? `<span class="ipa">/${esc(ipa)}/</span>` : ""}
        ${senses ? `<span class="senses">${esc(senses)}</span>` : ""}
      </div>
      ${exs}
      <div class="ws"></div>
    </div>`;
  })
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1f2328; margin: 0; }
  .note { font-size: 9pt; color: #8a919c; margin-bottom: 4mm; }
  .cols { column-count: 2; column-gap: 9mm; column-rule: 0.5pt solid #e6e9ed; }
  .w { break-inside: avoid; padding: 2.2mm 0 2.8mm; border-bottom: 0.5pt dashed #cfd4da; }
  .head { font-size: 12.5pt; line-height: 1.5; }
  .idx { font-size: 9pt; color: #b0b6bf; margin-right: 1.5mm; }
  .word { font-size: 14pt; font-weight: 700; color: #0d3b66; font-family: "Segoe UI", Arial, sans-serif; }
  .ipa { font-size: 10pt; color: #6e7781; margin: 0 1.5mm; }
  .senses { font-size: 10.5pt; color: #333; }
  .ex { margin-top: 1.6mm; }
  .ex-en { font-size: 10.5pt; line-height: 1.55; color: #24292f; }
  .hl { font-weight: 700; color: #c0392b; }
  .tag { font-size: 7.5pt; color: #fff; border-radius: 1mm; padding: 0.2mm 1.6mm; margin-right: 1.5mm; vertical-align: 2px; }
  .t-ext { background: #c0392b; } .t-reg { background: #6e7781; }
  .ex-cn { font-size: 9.5pt; color: #57606a; line-height: 1.5; margin-top: 0.5mm; }
  .ws { height: 7mm; }
  .dim { color: #b0b6bf; }
</style></head><body>
  <div class="note">横屏模板预览 · 前 ${words.length} 词 · Pad 横屏两栏 · 例句顺序：①扇贝 ②真题</div>
  <div class="cols">
${cardHtml}
  </div>
</body></html>`;

const outPdf = "C:\\Users\\14821\\Desktop\\每日新词例句\\横屏模板预览.pdf";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
});
server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const profile = path.join(os.tmpdir(), "wb-edge-print-ls");
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(findEdge(), [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    "--user-data-dir=" + profile,
    "--print-to-pdf=" + outPdf,
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.on("exit", (code) => {
    server.close();
    setTimeout(() => {
      if (fs.existsSync(outPdf) && fs.statSync(outPdf).size > 1000) console.log("OK " + outPdf);
      else console.log("FAIL " + code + " " + err.slice(0, 200));
    }, 300);
  });
});
