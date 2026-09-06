# -*- coding: utf-8 -*-
"""每日英语小短文生成器
读取「英语单词听写工具」文件夹里按日期保存的单词文件，
把当天的新词写成一篇简单短文（用每个词的例句组装），
并在同一个 PDF 里附上单词、音标、释义、例句与例句翻译。
"""
import os
import sys
import re
import html
import glob
import sqlite3

TOOL_DIR = r"C:\Users\14821\Desktop\英语单词听写工具"
DICT_DB = os.path.join(TOOL_DIR, "词典", "ecdict.db")
DEFAULT_OUT = os.path.join(os.path.expanduser("~"), "Desktop", "每日文章")


def parse_line(line):
    parts = line.split("|")
    return {
        "word": parts[0].strip() if len(parts) > 0 else "",
        "meaning": parts[1].strip() if len(parts) > 1 else "",
        "ex_en": parts[2].strip() if len(parts) > 2 else "",
        "ex_cn": parts[3].strip() if len(parts) > 3 else "",
        "phrases": parts[4].strip() if len(parts) > 4 else "",
        "notes": parts[5].strip() if len(parts) > 5 else "",
    }


def load_words(date):
    path = os.path.join(TOOL_DIR, date + ".txt")
    if not os.path.exists(path):
        alt = os.path.join(os.path.dirname(os.path.abspath(__file__)), date + ".txt")
        if os.path.exists(alt):
            path = alt
        else:
            raise SystemExit("找不到单词文件: " + path)
    words = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                words.append(parse_line(line))
    return words


def get_phonetic(word):
    try:
        con = sqlite3.connect(DICT_DB)
        cur = con.execute("SELECT phonetic FROM dict WHERE word = ?", (word.lower(),))
        row = cur.fetchone()
        con.close()
        return (row[0] or "").strip() if row else ""
    except Exception:
        return ""


def esc(s):
    return html.escape(str(s or ""), quote=False)


def bold_word(text, word):
    text = esc(text)
    if not word:
        return text
    pattern = r"(?<![A-Za-z])" + re.escape(word) + r"(?![A-Za-z])"
    return re.sub(pattern, lambda m: "<b>" + m.group(0) + "</b>", text, flags=re.IGNORECASE)


def bold_override(text, words):
    text = esc(text)
    for w in words:
        if not w["word"]:
            continue
        pattern = r"(?<![A-Za-z])" + re.escape(w["word"]) + r"(?![A-Za-z])"
        text = re.sub(pattern, lambda m: "<b>" + m.group(0) + "</b>", text, flags=re.IGNORECASE)
    return text


def build_article(words):
    sentences = []
    for w in words:
        s = w["ex_en"]
        if not s:
            s = 'We learn the word "%s" today.' % w["word"]
        sentences.append(bold_word(s, w["word"]))
    per = 12
    paras = []
    for i in range(0, len(sentences), per):
        paras.append(" ".join(sentences[i:i + per]))
    return paras


def main():
    args = list(sys.argv[1:])
    date = None
    out_dir = DEFAULT_OUT
    i = 0
    while i < len(args):
        if args[i] == "--out" and i + 1 < len(args):
            out_dir = args[i + 1]
            i += 2
        elif not args[i].startswith("-"):
            date = args[i]
            i += 1
        else:
            i += 1

    if not date:
        files = sorted(glob.glob(os.path.join(TOOL_DIR, "????-??-??.txt")), reverse=True)
        if not files:
            raise SystemExit("工具文件夹里没有按日期保存的单词文件")
        date = os.path.splitext(os.path.basename(files[0]))[0]

    words = load_words(date)
    if not words:
        raise SystemExit("没有读取到单词")
    paras = None
    override = os.path.join(TOOL_DIR, date + ".文章.txt")
    if not os.path.exists(override):
        override = os.path.join(os.path.dirname(os.path.abspath(__file__)), date + ".文章.txt")
    if os.path.exists(override):
        with open(override, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        paras = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
        paras = [bold_override(p, words) for p in paras]
    else:
        paras = build_article(words)

    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    )
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib import colors

    font_path = r"C:\Windows\Fonts\msyh.ttc"
    if os.path.exists(font_path):
        pdfmetrics.registerFont(TTFont("MSYH", font_path, subfontIndex=0))
        FONT = "MSYH"
    else:
        FONT = "Helvetica"

    title_st = ParagraphStyle("title", fontName=FONT, fontSize=20, leading=26, alignment=1, spaceAfter=4)
    date_st = ParagraphStyle(
        "date", fontName=FONT, fontSize=11, leading=15, alignment=1,
        textColor=colors.HexColor("#666666"), spaceAfter=14,
    )
    body_st = ParagraphStyle("body", fontName=FONT, fontSize=13, leading=21)
    section_st = ParagraphStyle("section", fontName=FONT, fontSize=16, leading=22, spaceBefore=10, spaceAfter=8)
    cell_st = ParagraphStyle("cell", fontName=FONT, fontSize=9, leading=13)
    head_st = ParagraphStyle("head", fontName=FONT, fontSize=9.5, leading=13, textColor=colors.white)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, date + ".pdf")
    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
        title="每日英语小短文 " + date,
    )

    story = []
    story.append(Paragraph("每日英语小短文", title_st))
    story.append(Paragraph(date + " · " + str(len(words)) + " 个单词 · Daily Reading", date_st))
    story.append(Paragraph(esc("今天的新词写成了一篇小短文，试着读出来并猜一猜单词的意思。"), body_st))
    story.append(Spacer(1, 8))
    for p in paras:
        story.append(Paragraph(p, body_st))
        story.append(Spacer(1, 8))

    story.append(PageBreak())
    story.append(Paragraph("单词与翻译", section_st))
    story.append(Paragraph(esc("每个单词附音标、释义、例句与例句翻译。"), body_st))
    story.append(Spacer(1, 6))

    header = [
        Paragraph("<b>单词</b>", head_st),
        Paragraph("<b>释义</b>", head_st),
        Paragraph("<b>例句</b>", head_st),
        Paragraph("<b>例句翻译</b>", head_st),
    ]
    rows = [header]
    for w in words:
        ph = get_phonetic(w["word"])
        word_cell = w["word"]
        if ph:
            word_cell += "<br/><font size=8 color='#666666'>" + esc(ph) + "</font>"
        rows.append([
            Paragraph(word_cell, cell_st),
            Paragraph(esc(w["meaning"]), cell_st),
            Paragraph(bold_word(w["ex_en"], w["word"]) if w["ex_en"] else "—", cell_st),
            Paragraph(esc(w["ex_cn"]) if w["ex_cn"] else "—", cell_st),
        ])

    col_w = [36 * mm, 40 * mm, 56 * mm, 42 * mm]
    table = Table(rows, colWidths=col_w, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2563eb")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f6fb")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(table)
    doc.build(story)
    print("已生成: " + out_path)
    print("单词数: %d" % len(words))


if __name__ == "__main__":
    main()
