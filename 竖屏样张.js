// 临时样张脚本：竖屏 + 每词「①扇贝 ②真题」规则（用已保存的当日词 + 重新拉取原始例句渲染）
// 与正式脚本 buildHtml 的 CSS 保持一致，只是取当天前 N 个词，方便先看版式。
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const bays4 = require("./bays4.js");
const DIR = __dirname;
const AUTH_FILE = path.join(DIR, "shanbay-auth.json");
const OUT_JSON_DIR = path.join(os.homedir(), "Desktop", "每日新词例句");
const OUT_PDF = path.join(OUT_JSON_DIR, "竖屏样张-两例句.pdf");
const SAMPLE_N = 20;
const DICT_ID = "bkzmdu"; // 完全版四级考纲词汇 词典 id
const API_HOST = "apiv3.shanbay.com";

const EDGE_CANDIDATES = [
  process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.ProgramFiles + "\\Microsoft\\Edge\\Application\\msedge.exe",
];
const findEdge = () => EDGE_CANDIDATES.find((p) => p && fs.existsSync(p)) || "msedge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")).auth_token;

function httpsGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: API_HOST, path: apiPath, family: 4, headers: { Cookie: "auth_token=" + token, "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchExamples(pathName, ids) {
  const byId = {};
  const map = {};
  ids.forEach((id) => { byId[id] = []; map[id] = 1; });
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).join(",");
    let resp;
    try {
      resp = await httpsGet("/wordsapp/words/" + pathName + "?vocab_ids=" + chunk + "&dict_id=" + DICT_ID);
    } catch (e) { continue; }
    if (resp.status !== 200) continue;
    let j;
    try { j = JSON.parse(resp.body); } catch (e) { continue; }
    let d = j.data;
    if (typeof d === "string") { try { d = JSON.parse(bays4.d(d)); } catch (e) { continue; } }
    for (const o of (d && d.objects) || []) {
      if (!map[o.vocab_id]) continue;
      for (const ex of o.examples || []) {
        if (!ex || !ex.content_en) continue;
        byId[o.vocab_id].push({ en: ex.content_en, cn: ex.content_cn || "", source: ex.source_name || "" });
      }
    }
  }
  return byId;
}

// 从今日新词接口补拉音标（vocab_with_senses.sound.ipa_uk / ipa_us，扇贝官方标注）
async function fetchIpaMap(ids) {
  const map = {};
  for (let page = 1; page <= 10; page++) {
    let resp;
    try {
      resp = await httpsGet("/wordsapp/user_material_books/buksun/learning/words/today_learning_items?ipp=50&page=" + page + "&type_of=NEW");
    } catch (e) { break; }
    if (resp.status !== 200) break;
    let d;
    try {
      const j = JSON.parse(resp.body);
      d = j.data;
      if (typeof d === "string") d = JSON.parse(bays4.d(d));
    } catch (e) { break; }
    for (const o of (d && d.objects) || []) {
      const v = o.vocab_with_senses || o.vocabulary || o;
      if (!v || !v.id) continue;
      map[v.id] = {
        uk: (v.sound && v.sound.ipa_uk) || v.ipa_uk || "",
        us: (v.sound && v.sound.ipa_us) || v.ipa_us || "",
      };
    }
    if (!d || !d.objects || d.objects.length < 50) break;
    if (ids.every((id) => map[id])) break;
  }
  return map;
}

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

// 中文翻译里把与释义对应的部分加粗标红（三层匹配：完整释义 → 两字滑窗 → 纯单字释义）
function highlightCn(cn, senses) {
  if (!cn) return "";
  const base = [];
  (senses || []).forEach((s) => {
    String(s.definition_cn || "").split(/[；;，,、]/).forEach((d) => {
      d = d.trim().replace(/（[^）]*）/g, "").trim();
      if (!d) return;
      base.push(d);
      const t = d.replace(/[的地得]$/, "");
      if (t && t !== d) base.push(t);
    });
  });
  const uniq = (a) => [...new Set(a)];
  const A = uniq(base).filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
  const single = uniq(base).filter((c) => c.length === 1);
  const makeRe = (list) => {
    if (!list.length) return null;
    const src = list.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return new RegExp(src, "g");
  };
  const html = esc(cn);
  // 每一层必须真正"匹配到内容"才算命中，否则继续下一层
  const tryLayer = (list) => {
    const re = makeRe(list);
    if (!re || !re.test(html)) return null;
    return new RegExp(re.source, "g");
  };
  let re = tryLayer(A);
  if (!re) {
    const B = uniq(A.flatMap((c) => (c.length > 2 ? c.match(/.{2}/g) || [] : [])))
      .filter((c) => !A.includes(c)).sort((a, b) => b.length - a.length);
    re = tryLayer(B);
  }
  if (!re && !A.length && single.length) re = tryLayer(single);
  // 兜底：实义单字（过滤常见虚词，避免乱命中）
  if (!re && single.length) {
    const stop = new Set("的了是在和有就都不他被这那以而之与及其为个着把很太最".split(""));
    re = tryLayer(single.filter((c) => !stop.has(c)));
  }
  if (!re) return html;
  return html.replace(re, (m) => '<b class="cn-hl">' + m + "</b>");
}

// 与正式脚本一致：①扇贝 ②真题（无真题则扇贝顶上）
function assembleExamples(extMap, regMap, vocabId) {
  const out = [];
  const seen = new Set();
  const push = (e, tag) => {
    if (!e || !e.en) return;
    const key = stripTags(e.en);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ en: e.en, cn: e.cn || "", source: e.source || "", tag });
  };
  const ext = (extMap[vocabId] || []).filter((e) => e.en && e.cn);
  const reg = (regMap[vocabId] || []).filter((e) => e.en && e.cn);
  push(reg[0], "例句");
  if (out.length < 2) {
    if (ext.length) push(ext[0], "真题");
    else push(reg[1], "例句");
  }
  if (out.length === 0) {
    push(ext[0], "真题");
    push(ext[1], "真题");
  }
  return out;
}

function buildHtml(words, title, subtitle) {
  const cards = words
    .map((w, i) => {
      const sensesRaw = (w.senses || []).map((s) => ({ pos: s.pos || "", definition_cn: s.definition_cn || "" }));
      const senses = sensesRaw.map((s) => [s.pos, s.definition_cn].filter(Boolean).join(" ")).filter(Boolean);
      const ipaParts = [];
      if (w.ipa_uk) ipaParts.push("英 /" + w.ipa_uk + "/");
      if (w.ipa_us) ipaParts.push("美 /" + w.ipa_us + "/");
      return { idx: i + 1, word: w.word, ipa: ipaParts.join("  "), senses, sensesRaw, exs: w.exs || [] };
    })
    .filter((c) => c.word);

  const cardHtml = cards
    .map(
      (c) => `
  <div class="w-row">
    <div class="w-head">
      <span class="w-idx">${c.idx}.</span>
      <span class="w-word">${esc(c.word)}</span>
      ${c.ipa ? `<span class="w-ipa">${esc(c.ipa)}</span>` : ""}
      ${c.senses.length ? `<span class="w-senses">${c.senses.map((s) => esc(s)).join("；")}</span>` : ""}
    </div>
    ${c.exs.length
      ? c.exs
          .map(
            (e) => `
    <div class="w-ex">
      <div class="ex-en">${e.tag ? `<span class="ex-tag ${e.tag === "真题" ? "t-ext" : "t-reg"}">${e.tag}</span>` : ""}${highlight(e.en, c.word)}</div>
      <div class="ex-cn">${highlightCn(e.cn, c.sensesRaw)}</div>
    </div>`
          )
          .join("")
      : `<div class="w-ex"><div class="ex-cn dim">（暂无例句）</div></div>`}
    <div class="write-space"></div>
  </div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif; color: #1f2328; margin: 0; }
  .cover { text-align: center; padding-top: 42mm; page-break-after: always; }
  .cover h1 { font-size: 30pt; margin: 0 0 6mm; color: #0d3b66; }
  .cover .sub { font-size: 13pt; color: #57606a; margin-bottom: 14mm; }
  .cover .meta { font-size: 11pt; color: #57606a; line-height: 2; }
  .cover .badge { display: inline-block; background: #0d3b66; color: #fff; border-radius: 999px; padding: 2mm 8mm; margin: 3mm; font-size: 10.5pt; }
  .w-row { break-inside: avoid; margin-bottom: 14mm; border-bottom: 0.5pt dashed #cfd4da; padding-bottom: 3mm; }
  .w-head { font-size: 14.5pt; line-height: 1.6; }
  .w-idx { font-size: 10pt; color: #b0b6bf; margin-right: 2mm; }
  .w-word { font-size: 16pt; font-weight: 700; color: #0d3b66; font-family: "Segoe UI", Arial, sans-serif; }
  .w-ipa { font-size: 11pt; color: #6e7781; margin: 0 2mm; }
  .w-senses { font-size: 12pt; color: #333; margin-left: 1mm; }
  .w-ex { margin-top: 2.5mm; }
  .ex-en { font-size: 12pt; line-height: 1.7; color: #24292f; }
  .hl { font-weight: 700; color: #c0392b; }
  .ex-tag { font-size: 8pt; color: #fff; border-radius: 1mm; padding: 0.3mm 2mm; margin-right: 2mm; vertical-align: 2px; }
  .t-ext { background: #c0392b; }
  .t-reg { background: #6e7781; }
  .ex-cn { font-size: 11pt; color: #57606a; line-height: 1.6; margin-top: 0.8mm; }
  .cn-hl { font-weight: 700; color: #c0392b; }
  .write-space { height: 12mm; }
  .dim { color: #b0b6bf; }
</style>
</head>
<body>
  <div class="cover">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle)}</div>
    <div><span class="badge">样张 · 前 ${cards.length} 词</span><span class="badge">①例句 ②真题例句</span></div>
    <div class="meta">竖屏单栏 · 与正式脚本版式一致<br>数据：扇贝单词 · 2026-09-04 新词</div>
  </div>
  <div class="rows">
${cardHtml}
  </div>
</body>
</html>`;
}

function printPdf(html, outPdf) {
  return new Promise((resolve, reject) => {
    // 把 HTML 写入临时文件，用 file:// 加载 —— 彻底避开本地 HTTP 服务与 Edge
    // 打印子进程之间的竞态（服务提前关闭会让 Edge 打印出「拒绝连接」错误页 PDF，
    // 文件照样生成，极难察觉）。
    const tmpHtml = path.join(os.tmpdir(), "wb-edge-print-sample-" + Date.now() + ".html");
    fs.writeFileSync(tmpHtml, html, "utf8");
    // 打印前删除旧 PDF，避免轮询命中上一次残留的错误页文件
    if (fs.existsSync(outPdf)) fs.unlinkSync(outPdf);
    // 每次用全新配置目录，避免 Edge 单例/锁干扰
    const profile = path.join(os.tmpdir(), "wb-edge-print-sample-" + Date.now());
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(findEdge(), [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      "--user-data-dir=" + profile,
      "--print-to-pdf=" + outPdf,
      require("url").pathToFileURL(tmpHtml).href,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const cleanup = () => fs.existsSync(tmpHtml) && fs.unlink(tmpHtml, () => {});
    child.on("error", (e) => { cleanup(); reject(new Error("无法启动 Edge：" + e.message)); });
    child.on("exit", (code) => {
      // Edge 主进程可能提前退出、PDF 稍后才落盘，轮询最多等 30 秒
      const t0 = Date.now();
      const check = () => {
        if (fs.existsSync(outPdf) && fs.statSync(outPdf).size > 1000) { cleanup(); return resolve(outPdf); }
        if (Date.now() - t0 > 30000)
          { cleanup(); return reject(new Error("PDF 生成失败（" + code + "）" + (err ? " " + err.slice(0, 200) : ""))); }
        setTimeout(check, 300);
      };
      check();
    });
  });
}

(async () => {
  // 读当日已保存的词（含 vocab_id / 音标 / 释义）
  const files = fs.readdirSync(OUT_JSON_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const file = files[files.length - 1];
  console.log("使用当日数据：" + file);
  const allWords = JSON.parse(fs.readFileSync(path.join(OUT_JSON_DIR, file), "utf8"));
  const words = allWords.slice(0, SAMPLE_N);
  const ids = words.map((w) => w.vocab_id).filter(Boolean);

  console.log("补拉扇贝音标…");
  const ipaMap = await fetchIpaMap(ids);
  let ipaOk = 0;
  words.forEach((w) => {
    const m = ipaMap[w.vocab_id];
    if (m) {
      if (!w.ipa_uk) w.ipa_uk = m.uk;
      if (!w.ipa_us) w.ipa_us = m.us;
      if (w.ipa_uk || w.ipa_us) ipaOk++;
    }
  });
  console.log("音标覆盖：" + ipaOk + "/" + words.length);

  console.log("拉取真题例句…");
  const extMap = await fetchExamples("ext_examples", ids);
  console.log("拉取扇贝普通例句…");
  const regMap = await fetchExamples("vocab_examples", ids);

  let two = 0, one = 0;
  words.forEach((w) => {
    w.exs = assembleExamples(extMap, regMap, w.vocab_id);
    if (w.exs.length >= 2) two++; else one++;
  });
  console.log("样张前 " + words.length + " 词：两条例句 " + two + " 词，单条例句 " + one + " 词");

  const html = buildHtml(words, "每日新词 · 例句精读", "竖屏样张（前 " + words.length + " 词）");
  await printPdf(html, OUT_PDF);
  console.log("OK " + OUT_PDF);
})().catch((e) => {
  console.error("出错：", e && e.stack ? e.stack : e);
  process.exit(1);
});
