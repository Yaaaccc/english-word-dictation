#!/usr/bin/env node
/*
 * word-quota.js —— 每日词量配额切分（抓取脚本与 PDF 脚本共用）
 *
 * 背景：扇贝的「今日任务」会把前几天没学完的词一起带进来。此时一次抓取可能拿到
 *       200 词（昨天 100 + 今天 100），直接整包保存就会出现「一天两组、共 200 词」。
 * 规则：每天固定 DAILY_QUOTA（默认 100）词为一个单元。
 *       1) 抓到的词 ≤ 配额 → 全部算今天；
 *       2) 抓到的词 > 配额 → 优先用「今天已存档的词」当锚点切出今天那批（与接口顺序无关）；
 *          没有锚点时才按顺序取前 100 个；
 *       3) 多出来的词逐词检查是否已存在于更早日期的存档：
 *          已存在 → 不动（它本来就属于那天）；从未出现 → 另存为「<日期>-补.txt」补课组。
 *
 * 可用环境变量 DAILY_QUOTA 覆盖配额（默认 100）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DAILY_QUOTA = parseInt(process.env.DAILY_QUOTA || "100", 10) || 100;

// 存档文件名：2026-09-20.txt / 2026-09-20-2.txt / 2026-09-20-补.txt
const ARCHIVE_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+|补))?\.txt$/;

function wordKey(w) {
  return String(w || "").trim().toLowerCase();
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch (e) {
    return [];
  }
}

// 读取某个存档文件里的词（小写集合）
function readDailyFileWords(file) {
  const set = new Set();
  for (const line of readLines(file)) {
    const w = wordKey(String(line).split("|")[0]);
    if (w) set.add(w);
  }
  return set;
}

// 读取「早于 dateStr」的所有存档词（含根目录历史文件；跳过备份目录）
function readEarlierWordSet(baseDir, dateStr) {
  const set = new Set();
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(ARCHIVE_RE);
      if (!m) continue;
      if (m[1] >= dateStr) continue; // 只要更早的日期
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).isDirectory()) continue;
      } catch (e) {
        continue;
      }
      for (const w of readDailyFileWords(p)) set.add(w);
    }
  };
  scan(path.join(baseDir, "今日单词"));
  scan(baseDir);
  return set;
}

// 按配额切分：返回 { today, overflow, quota, anchored }
// anchorKeys：今天已存档词的集合（可选，作为"今天"的锚点）
function splitDailySmart(items, opts) {
  const quota = (opts && opts.quota) || DAILY_QUOTA;
  const list = (items || []).filter((it) => it && it.word);
  if (list.length <= quota) {
    return { today: list, overflow: [], quota: quota, anchored: false };
  }
  const anchor = opts && opts.anchorKeys;
  if (anchor && anchor.size) {
    const today = list.filter((it) => anchor.has(wordKey(it.word)));
    const overflow = list.filter((it) => !anchor.has(wordKey(it.word)));
    // 锚点命中太少说明今天的存档文件不可信（例如被旧版本写成了混合包），退回按顺序切
    if (today.length >= Math.min(20, Math.ceil(quota / 2)) && today.length <= quota) {
      return { today: today, overflow: overflow, quota: quota, anchored: true };
    }
  }
  return { today: list.slice(0, quota), overflow: list.slice(quota), quota: quota, anchored: false };
}

// 溢出词里，哪些在更早的存档中从未出现过（这些才需要另存为补课组）
function pickUnarchived(overflow, earlierSet) {
  return (overflow || []).filter((it) => !earlierSet.has(wordKey(it.word)));
}

module.exports = {
  DAILY_QUOTA: DAILY_QUOTA,
  ARCHIVE_RE: ARCHIVE_RE,
  wordKey: wordKey,
  readDailyFileWords: readDailyFileWords,
  readEarlierWordSet: readEarlierWordSet,
  splitDailySmart: splitDailySmart,
  pickUnarchived: pickUnarchived,
};
