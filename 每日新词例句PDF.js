#!/usr/bin/env node
/*
 * 每日新词 · 例句精读 PDF 生成器
 * ============================================
 * 抓取扇贝【今日新词】，配上真题例句（优先）与普通例句，
 * 生成一张张双栏词卡，打印成 PDF 方便背诵。
 *
 * 用法（在「英语单词听写工具」文件夹里）：
 *   node 每日新词例句PDF.js                抓取今天的新词并生成 PDF
 *   node 每日新词例句PDF.js --date 2026-08-30   用当天已保存的 txt 生成 PDF（补历史，不联网抓取）
 *   node 每日新词例句PDF.js --out D:\xx     指定 PDF 输出目录（默认 桌面\每日新词例句）
 *
 * 依赖：同目录 bays4.js（解密）、shanbay-auth.json（登录态）、.shanbay-profile（登录用浏览器配置）
 * 首次运行会弹出 Edge 窗口，登录一次扇贝，之后不再需要。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn, exec } = require("child_process");

const bays4 = require("./bays4.js");

const DIR = __dirname;
const AUTH_FILE = path.join(DIR, "shanbay-auth.json");
const PROFILE_DIR = path.join(DIR, ".shanbay-profile");
const PRINT_PROFILE = path.join(os.tmpdir(), "wb-edge-print");
const API_HOST = "apiv3.shanbay.com";
const CDP_PORT = 9223;
const TARGET_URL = "https://web.shanbay.com/wordsweb/#/words-table";
const DEFAULT_OUT = path.join(os.homedir(), "Desktop", "每日新词例句");

const EDGE_CANDIDATES = [
  process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.ProgramFiles + "\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return "msedge";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {}
class SyncError extends Error {}

/* ---------------- HTTP + 解密（与 grab-shanbay.js 同款） ---------------- */

// 网络层错误码：这些属于 DNS/连接抖动，值得自动重试
const NET_RETRY_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function httpsGet(apiPath, token, method) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: apiPath,
        method: method || "GET",
        family: 4, // 强制 IPv4，跳过 AAAA 查询——IPv6 解析超时会整体报 ENOTFOUND
        headers: {
          Cookie: "auth_token=" + token,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
      },
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

// DNS/网络抖动自动重试（最多 4 次，间隔递增）。重试耗尽给出友好提示。
async function httpsGetRetry(apiPath, token, method) {
  const MAX = 4;
  let lastErr;
  for (let i = 1; i <= MAX; i++) {
    try {
      return await httpsGet(apiPath, token, method);
    } catch (e) {
      lastErr = e;
      if (!NET_RETRY_CODES.has(e.code)) throw e; // 非网络错误（如证书问题）直接抛
      if (i < MAX) {
        console.log("  网络波动（" + e.code + "），" + i + " 秒后重试（" + i + "/" + (MAX - 1) + "）…");
        await sleep(1000 * i);
      }
    }
  }
  throw new Error(
    "网络/DNS 异常（" + (lastErr && lastErr.code) + "）：请检查网络连接，或暂时关闭代理/加速器/VPN 后重试"
  );
}

async function fetchApi(apiPath, params, token, method) {
  const qs = new URLSearchParams(params).toString();
  // 扇贝服务端偶发 500（负载均衡下部分节点故障/维护），自动等待重试最多约 1 分钟，
  // 服务器一旦恢复即可自动继续，无需手动反复运行。
  let resp;
  const MAX_500 = 12;
  const GAP_500 = 5000;
  for (let i = 0; i < MAX_500; i++) {
    resp = await httpsGetRetry(apiPath + "?" + qs, token, method);
    if (resp.status !== 500) break;
    if (i < MAX_500 - 1) {
      const sec = Math.round(GAP_500 / 1000);
      console.log("  扇贝服务器繁忙（HTTP 500），" + sec + " 秒后重试（" + (i + 1) + "/" + (MAX_500 - 1) + "）…");
      await sleep(GAP_500);
    }
  }
  const { status, body } = resp;
  if (status === 401 || status === 403) throw new AuthError("登录已失效（HTTP " + status + "）");
  if (status === 412) throw new SyncError("今日任务尚未生成（HTTP 412）");
  if (status === 500)
    throw new Error("扇贝服务器繁忙（HTTP 500）：扇贝服务端目前故障，网页版同样无法加载，请过几分钟再运行一次");
  if (status !== 200) throw new Error("接口返回 HTTP " + status);
  let j;
  try {
    j = JSON.parse(body);
  } catch (e) {
    throw new Error("接口返回无法解析：" + body.slice(0, 120));
  }
  if (j.code !== undefined && j.code !== 0 && String(j.code) !== "0" && String(j.code) !== "200") {
    throw new Error("接口错误 code=" + j.code + (j.msg ? " " + j.msg : ""));
  }
  let data = j && j.data !== undefined ? j.data : j;
  if (typeof data === "string") {
    data = JSON.parse(bays4.d(data));
  }
  return data;
}

async function fetchWithSync(apiPath, params, token, mid) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await fetchApi(apiPath, params, token);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      if (mid) {
        try {
          await fetchApi("/wordsapp/user_material_books/" + mid + "/learning/items/sync", {}, token);
        } catch (e2) {}
      }
      await sleep(800);
    }
  }
  if (mid) {
    try {
      await fetchApi("/wordsapp/user_material_books/" + mid + "/learning/next_turn", {}, token, "POST");
    } catch (e3) {}
    await sleep(1200);
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await fetchApi(apiPath, params, token);
      } catch (e4) {
        if (!(e4 instanceof SyncError)) throw e4;
        await sleep(1000);
      }
    }
  }
  throw new Error("今日任务生成超时（接口多次返回 412）");
}

/* ---------------- 登录信息 ---------------- */

function loadAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return j && j.auth_token ? j.auth_token : null;
  } catch (e) {
    return null;
  }
}
function saveAuth(token) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ auth_token: token, saved_at: new Date().toISOString() }, null, 2), "utf8");
}
async function checkToken(token) {
  try {
    await fetchApi("/wordscollection/learning/words/today_learning_items", { page: 1, type_of: "NEW", ipp: 1 }, token);
    return true;
  } catch (e) {
    if (e instanceof AuthError) return false;
    if (e instanceof SyncError) return true;
    throw e;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}
function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      reject(e);
      return;
    }
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => {
      for (const p of pending.values()) p({ error: true });
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params) {
          return new Promise((res) => {
            const id = nextId++;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() {
          try {
            ws.close();
          } catch (e) {}
        },
      });
  });
}
async function getAuthTokenViaBrowser() {
  console.log("正在打开扇贝页面，第一次需要你在弹出的窗口中登录一次…");
  const child = spawn(findEdge(), ["--remote-debugging-port=" + CDP_PORT, "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + PROFILE_DIR, TARGET_URL], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  let page = null;
  for (let i = 0; i < 150; i++) {
    try {
      const list = await getJson("http://127.0.0.1:" + CDP_PORT + "/json/list");
      page = list.find((t) => t.type === "page");
      if (page) break;
    } catch (e) {}
    await sleep(1000);
  }
  if (!page) throw new Error("无法连接浏览器调试端口（" + CDP_PORT + "），请关闭占用该端口的程序后重试");
  const cdp = await cdpSession(page.webSocketDebuggerUrl);
  console.log("等待登录（最多 5 分钟），登录成功后会自动继续…");
  for (let i = 0; i < 150; i++) {
    const r = await cdp.send("Network.getAllCookies");
    const cookies = (r.result && r.result.cookies) || [];
    const tok = cookies.find((c) => c.name === "auth_token");
    if (tok && tok.value) {
      cdp.close();
      try {
        child.kill();
      } catch (e) {}
      console.log("检测到登录成功。");
      return tok.value;
    }
    if (i > 0 && i % 30 === 0) console.log("  还没检测到登录状态，请在弹出的浏览器窗口完成登录…");
    await sleep(2000);
  }
  throw new Error("等待登录超时（5 分钟）");
}

/* ---------------- 抓词 ---------------- */

async function getCurrentBook(token) {
  const data = await fetchApi("/wordsapp/user_material_books", {}, token);
  const book = data && data.objects && data.objects[0];
  const mb = (book && book.materialbook) || {};
  if (!mb.id) throw new Error("没有找到当前单词书");
  return { mid: mb.id, dictId: mb.dictionary_id || "" };
}

async function fetchTodayNew(token, mid) {
  const words = [];
  let page = 1;
  while (page <= 10) {
    const data = await fetchWithSync(
      "/wordsapp/user_material_books/" + mid + "/learning/words/today_learning_items",
      { page, type_of: "NEW", ipp: 50 },
      token,
      mid
    );
    words.push(...(data.objects || []));
    if (!data.objects || data.objects.length === 0) break;
    page++;
  }
  return words;
}

async function fetchFallback(token, mid) {
  const objects = [];
  let page = 1;
  while (page <= 30) {
    const data = await fetchWithSync(
      "/wordsapp/user_material_books/" + mid + "/learning/words/unlearned_items",
      { page, ipp: 50, order: "DESC" },
      token,
      mid
    );
    objects.push(...(data.objects || []));
    if (!data.objects || data.objects.length === 0) break;
    page++;
  }
  return objects;
}

/* ---------------- 例句 ---------------- */

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

async function fetchExtExamples(ids, dictId, token) {
  // 真题例句：/wordsapp/words/ext_examples，响应 {data: "<混淆串>"}
  const byId = {};
  const map = {};
  for (const id of ids) {
    byId[id] = [];
    map[id] = 1;
  }
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).join(",");
    let data;
    try {
      data = await fetchApi("/wordsapp/words/ext_examples", { vocab_ids: chunk, dict_id: dictId }, token);
    } catch (e) {
      continue;
    }
    for (const o of data.objects || []) {
      if (!map[o.vocab_id]) continue;
      for (const ex of o.examples || []) {
        if (!ex || !ex.content_en) continue;
        byId[o.vocab_id].push({
          en: ex.content_en,
          cn: ex.content_cn || "",
          source: ex.source_name || "",
        });
      }
    }
  }
  return byId;
}

async function fetchVocabExamples(ids, dictId, token) {
  const byId = {};
  const map = {};
  for (const id of ids) {
    byId[id] = [];
    map[id] = 1;
  }
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).join(",");
    let data;
    try {
      data = await fetchApi("/wordsapp/words/vocab_examples", { vocab_ids: chunk, dict_id: dictId }, token);
    } catch (e) {
      continue;
    }
    for (const o of data.objects || []) {
      if (!map[o.vocab_id]) continue;
      for (const ex of o.examples || []) {
        if (!ex || !ex.content_en) continue;
        byId[o.vocab_id].push({ en: ex.content_en, cn: ex.content_cn || "", source: "" });
      }
    }
  }
  return byId;
}

/* ---------------- HTML 生成 ---------------- */

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// 例句里的 <vocab> 标签转红色加粗；没有标签的用正则按单词（含常见变体）高亮
function highlight(en, word) {
  let html = esc(en).replace(/&lt;vocab&gt;/g, '<b class="hl">').replace(/&lt;\/vocab&gt;/g, "</b>");
  if (html.indexOf('<b class="hl">') === -1 && word) {
    const stem = word.replace(/'s$/i, "");
    const suffix = "(?:s|es|ed|d|ing|'s)?";
    const pattern = "(?<![A-Za-z])" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + suffix + "(?![A-Za-z])";
    try {
      html = html.replace(new RegExp(pattern, "gi"), (m) => '<b class="hl">' + m + "</b>");
    } catch (e) {}
  }
  return html;
}

function buildHtml(words, { title, subtitle }) {
  const cards = words
    .map((w, i) => {
      const ipaUk = w.ipa_uk ? `英 /${w.ipa_uk}/` : "";
      const ipaUs = w.ipa_us ? `美 /${w.ipa_us}/` : "";
      const ipa = [ipaUk, ipaUs].filter(Boolean).join("  ");
      const senses = (w.senses || []).map((s) => [s.pos, s.definition_cn].filter(Boolean).join(" ")).filter(Boolean);
      return {
        idx: i + 1,
        word: w.word,
        ipa,
        senses,
        exs: w.exs || [],
      };
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
      <div class="ex-cn">${esc(e.cn)}</div>
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
  /* 单栏 · 一行一行 · 行距留足书写空间 */
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
  .write-space { height: 12mm; }
  .dim { color: #b0b6bf; }
</style>
</head>
<body>
  <div class="cover">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle)}</div>
    <div><span class="badge">共 ${cards.length} 词</span><span class="badge">①例句 ②真题例句</span></div>
    <div class="meta">数据来源：扇贝单词 · 今日新词<br>生成日期：${new Date().toLocaleDateString("zh-CN")}</div>
  </div>
  <div class="rows">
${cardHtml}
  </div>
</body>
</html>`;
}

/* ---------------- Edge 打印 ---------------- */

function printPdf(html, outPdf) {
  return new Promise((resolve, reject) => {
    // 把 HTML 写入临时文件，用 file:// 加载 —— 彻底避开本地 HTTP 服务与 Edge
    // 打印子进程之间的竞态（服务提前关闭会让 Edge 打印出「拒绝连接」错误页 PDF，
    // 文件照样生成，极难察觉）。
    const tmpHtml = path.join(os.tmpdir(), "wb-edge-print-" + Date.now() + ".html");
    fs.writeFileSync(tmpHtml, html, "utf8");
    // 打印前删除旧 PDF，避免轮询命中上一次残留的错误页文件
    if (fs.existsSync(outPdf)) fs.unlinkSync(outPdf);
    // 每次用全新配置目录，避免 Edge 单例/锁干扰
    const profile = path.join(os.tmpdir(), "wb-edge-print-profile-" + Date.now());
    fs.mkdirSync(profile, { recursive: true });
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--user-data-dir=" + profile,
      "--print-to-pdf=" + outPdf,
      require("url").pathToFileURL(tmpHtml).href,
    ];
    const child = spawn(findEdge(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const cleanup = () => fs.existsSync(tmpHtml) && fs.unlink(tmpHtml, () => {});
    child.on("error", (e) => {
      cleanup();
      reject(new Error("无法启动 Edge：" + e.message));
    });
    child.on("exit", (code) => {
      // Edge 主进程可能提前退出、PDF 稍后才落盘，轮询最多等 30 秒
      const t0 = Date.now();
      const check = () => {
        if (fs.existsSync(outPdf) && fs.statSync(outPdf).size > 1000) {
          cleanup();
          return resolve(outPdf);
        }
        if (Date.now() - t0 > 30000) {
          cleanup();
          return reject(new Error("PDF 生成失败（" + code + "）" + (err ? " " + err.slice(0, 200) : "")));
        }
        setTimeout(check, 300);
      };
      check();
    });
  });
}

/* ---------------- 数据组装 ---------------- */

function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

// 从 learning_items 对象提取单词信息
function extractWord(obj) {
  const v = (obj && (obj.vocab_with_senses || obj.vocabulary || obj)) || {};
  const word = String(v.word || v.content || "").trim();
  if (!word) return null;
  const senses = (v.senses || []).map((s) => ({ pos: s.pos || "", definition_cn: s.definition_cn || "" })).filter((s) => s.definition_cn);
  const snd = v.sound || {};
  return { word, vocab_id: v.id || v.vocab_id || obj.vocab_id || "", ipa_uk: snd.ipa_uk || v.ipa_uk || "", ipa_us: snd.ipa_us || v.ipa_us || "", senses };
}

function dedupe(words) {
  const seen = new Set();
  return words.filter((w) => {
    const k = w.word.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 组装例句（用户规则）：每个词至多两条，结构固定为——
//   第①条：扇贝普通例句（真题永远不占第①条）
//   第②条：真题例句；没有真题时用第②条扇贝例句顶上
// 真题例句最多出现一条；若该词完全没有扇贝普通例句，才用真题补第①条。
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

  // 第①条：普通例句（标签统一为「例句」，不标来源）
  push(reg[0], "例句");
  // 第②条：真题优先；没有真题用第 2 条普通例句顶上
  if (out.length < 2) {
    if (ext.length) push(ext[0], "真题");
    else push(reg[1], "例句");
  }
  // 兜底：完全没有普通例句的词，用真题撑起（最多两条，逐条标真题）
  if (out.length === 0) {
    push(ext[0], "真题");
    push(ext[1], "真题");
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const args = process.argv.slice(2);
  let outDir = DEFAULT_OUT;
  let dateArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) outDir = args[i + 1];
    else if (args[i] === "--date" && args[i + 1]) dateArg = args[i + 1];
  }

  console.log("== 每日新词 · 例句精读 PDF ==");

  // ---- 模式 A：读取已有日期文件（补历史，不联网） ----
  if (dateArg) {
    const txt = path.join(DIR, dateArg + ".txt");
    if (!fs.existsSync(txt)) throw new Error("找不到文件：" + txt);
    console.log("读取已保存的单词文件：" + path.basename(txt));
    const lines = fs.readFileSync(txt, "utf8").split(/\r?\n/).filter(Boolean);
    const words = lines.map((line) => {
      const p = line.split("|");
      return {
        word: (p[0] || "").trim(),
        vocab_id: "",
        ipa_uk: "",
        ipa_us: "",
        senses: p[1] ? [{ pos: "", definition_cn: p[1].trim() }] : [],
        exs: p[2]
          ? [{ en: p[2].trim(), cn: (p[3] || "").trim(), source: "", tag: "例句" }]
          : [],
      };
    });
    fs.mkdirSync(outDir, { recursive: true });
    const pdfPath = path.join(outDir, dateArg + ".pdf");
    await printPdf(buildHtml(words, { title: "每日新词 · 例句精读", subtitle: dateArg + " · 扇贝单词 · 例句背诵手册" }), pdfPath);
    console.log("PDF 已生成：" + pdfPath);
    exec('start "" "' + pdfPath + '"');
    return;
  }

  // ---- 模式 B：抓取今天新词 ----
  let token = loadAuth();
  if (!token) {
    token = await getAuthTokenViaBrowser();
    saveAuth(token);
    console.log("登录信息已保存（仅本机使用）");
  } else {
    console.log("使用已保存的登录信息…");
    if (!(await checkToken(token))) {
      console.log("登录已过期，需要重新登录。");
      token = await getAuthTokenViaBrowser();
      saveAuth(token);
    }
  }

  console.log("正在拉取今日新词…");
  const book = await getCurrentBook(token);
  let objects = await fetchTodayNew(token, book.mid);
  if (objects.length === 0) {
    console.log("今日任务暂无单词，改用「正在学习 + 未学习」词表…");
    objects = await fetchFallback(token, book.mid);
  }
  let words = dedupe(objects.map(extractWord).filter(Boolean));
  if (words.length === 0) throw new Error("没有获取到任何单词（可能今天还没有学习任务）");
  console.log("获取到 " + words.length + " 个新词，正在拉取真题例句…");

  const ids = words.map((w) => w.vocab_id).filter(Boolean);
  const extMap = await fetchExtExamples(ids, book.dictId, token);
  console.log("正在拉取普通例句（真题不足时兜底）…");
  const regMap = await fetchVocabExamples(ids, book.dictId, token);

  words.forEach((w) => {
    w.exs = assembleExamples(extMap, regMap, w.vocab_id);
  });

  const today = todayStr();
  const title = "每日新词 · 例句精读";
  const subtitle = today + " · " + words.length + " 词 · " + (book.dictId ? "完全版四级考纲词汇" : "扇贝单词");
  const html = buildHtml(words, { title, subtitle });

  fs.mkdirSync(outDir, { recursive: true });
  const pdfPath = path.join(outDir, today + ".pdf");
  console.log("正在渲染 PDF…");
  await printPdf(html, pdfPath);
  console.log("完成！PDF 已生成：" + pdfPath);

  // 附带保存一份结构化数据（备用）
  try {
    fs.writeFileSync(path.join(outDir, today + ".json"), JSON.stringify(words, null, 1), "utf8");
  } catch (e) {}

  const stat = fs.statSync(pdfPath);
  console.log("大小: " + (stat.size / 1024 / 1024).toFixed(2) + " MB");
  console.log("正在打开 PDF…");
  exec('start "" "' + pdfPath + '"');
})().catch((e) => {
  if (e instanceof AuthError) console.error("登录失效：" + e.message);
  else console.error("出错：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
