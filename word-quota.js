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
 *       3) **对比去重**：把今天这批里「近 RECENT_DAYS 天（默认 7）已出现过」的词换出去
 *          （它们属于那几天），再从多出来的词里补进等量的"那几天没出现过的词"
 *          （优先从未存档的），使两天不重复、且今天仍然满配额；
 *          缺口词不够时才把重复词放回来凑满；
 *       4) 剩余多出的词逐词检查是否存在于更早日期存档：
 *          已存在 → 丢掉（本来就属于那天）；从未出现 → 另存为「<日期>-补.txt」补课组。
 *
 * 可用环境变量 DAILY_QUOTA 覆盖配额（默认 100）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DAILY_QUOTA = parseInt(process.env.DAILY_QUOTA || "100", 10) || 100;
// 「近几天」窗口：落在窗口内的存档词算"前几天已经给过"，重复出现的要从今天剔掉
const RECENT_DAYS = parseInt(process.env.QUOTA_RECENT_DAYS || "7", 10) || 7;

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

// 日期字符串减若干天（YYYY-MM-DD）
function dateMinus(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

// 读取「最近 RECENT_DAYS 天内」的存档词（不含当天）。当天抓到的词若出现在这里，
// 说明它属于前几天（重复带出来的），不该再算进今天。
function readRecentWordSet(baseDir, dateStr, days) {
  const from = dateMinus(dateStr, days || RECENT_DAYS);
  const set = new Set();
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(ARCHIVE_RE);
      if (!m) continue;
      if (m[1] >= dateStr || m[1] < from) continue;
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

// 按配额切分：返回 { today, overflow, quota, anchored, swapped, filled }
// anchorKeys：今天已存档词的集合（可选，作为"今天"的锚点）
function splitDailySmart(items, opts) {
  const quota = (opts && opts.quota) || DAILY_QUOTA;
  const list = (items || []).filter((it) => it && it.word);
  if (list.length <= quota) {
    return { today: list, overflow: [], quota: quota, anchored: false, swapped: 0, filled: 0 };
  }

  const anchor = opts && opts.anchorKeys;
  const recent = (opts && opts.recentKeys) || new Set(); // 近 RECENT_DAYS 天出现过的词
  const earlierAll = (opts && opts.allEarlierKeys) || new Set(); // 历史上所有出现过的词
  let anchored = false;
  let today;
  let overflow;

  if (anchor && anchor.size) {
    today = list.filter((it) => anchor.has(wordKey(it.word)));
    overflow = list.filter((it) => !anchor.has(wordKey(it.word)));
    // 锚点命中太少说明今天的存档文件不可信（例如被旧版本写成了混合包），退回按顺序切
    if (today.length >= Math.min(20, Math.ceil(quota / 2)) && today.length <= quota) {
      anchored = true;
    }
  }
  if (!anchored) {
    today = list.slice(0, quota);
    overflow = list.slice(quota);
  }

  // ---- 对比去重：与「前几天」真正比对，重复的归那天，今天的缺口用"没出现过的新词"补齐 ----
  let swapped = 0;
  let filled = 0;
  const dup = today.filter((it) => recent.has(wordKey(it.word))); // 前几天已出现过 → 不该算今天
  if (dup.length && recent.size) {
    let kept = today.filter((it) => !recent.has(wordKey(it.word)));
    const need = quota - kept.length;
    if (need > 0) {
      const pool = overflow.filter((it) => !recent.has(wordKey(it.word)));
      // 优先补"从未在任何存档出现"的词，其次补"只在很早以前出现过"的词
      const fresh = pool.filter((it) => !earlierAll.has(wordKey(it.word)));
      const older = pool.filter((it) => earlierAll.has(wordKey(it.word)));
      const fill = fresh.concat(older).slice(0, need);
      if (fill.length) {
        kept = kept.concat(fill);
        filled = fill.length;
        const fillKeys = new Set(fill.map((it) => wordKey(it.word)));
        overflow = overflow.filter((it) => !fillKeys.has(wordKey(it.word)));
      }
    }
    if (kept.length < quota) {
      // 实在补不满（缺口词不够），把重复词放回来凑满配额，避免某天数量缩水
      const back = dup.slice(0, quota - kept.length);
      kept = kept.concat(back);
      const backKeys = new Set(back.map((it) => wordKey(it.word)));
      overflow = overflow.concat(dup.filter((it) => !backKeys.has(wordKey(it.word))));
      swapped = dup.length - back.length;
    } else {
      overflow = overflow.concat(dup); // 被换出的重复词归更早的日期
      swapped = dup.length;
    }
    today = kept;
  }

  return { today: today, overflow: overflow, quota: quota, anchored: anchored, swapped: swapped, filled: filled };
}

// 溢出词里，哪些在更早的存档中从未出现过（这些才需要另存为补课组）
function pickUnarchived(overflow, earlierSet) {
  return (overflow || []).filter((it) => !earlierSet.has(wordKey(it.word)));
}

module.exports = {
  DAILY_QUOTA: DAILY_QUOTA,
  RECENT_DAYS: RECENT_DAYS,
  ARCHIVE_RE: ARCHIVE_RE,
  wordKey: wordKey,
  readDailyFileWords: readDailyFileWords,
  readEarlierWordSet: readEarlierWordSet,
  readRecentWordSet: readRecentWordSet,
  dateMinus: dateMinus,
  splitDailySmart: splitDailySmart,
  pickUnarchived: pickUnarchived,
};
