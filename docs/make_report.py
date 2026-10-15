"""Render a Markdown report into a styled DOCX and a PDF using only bundled tooling.

Pipeline:  docs/REPORT.md  ->  report.docx (python-docx)  ->  report.pdf (bundled LibreOffice)

The DOCX is built programmatically rather than via HTML so the PDF keeps real page numbers,
a title page, a contents list, page breaks, and Microsoft-Word-compatible table styling.

Usage:
    python docs/make_report.py [--md docs/REPORT.md] [--outdir docs] [--no-pdf]
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor
except ModuleNotFoundError as exc:  # pragma: no cover
    print(f"python-docx is required to build the report: {exc}", file=sys.stderr)
    raise SystemExit(2)

# --- house style ------------------------------------------------------------------------------
INK = RGBColor(0x14, 0x17, 0x1C)
MUTED = RGBColor(0x5A, 0x63, 0x72)
ACCENT = RGBColor(0x0B, 0x5F, 0x53)
RULE = "D8DCE2"
CODE_BG = "F4F6F8"
ZEBRA = "F7F9FA"


# --- helpers ----------------------------------------------------------------------------------

def add_page_number_footer(section) -> None:
    """A plain 'Page X of Y' footer built from raw OOXML fields."""
    footer = section.footer
    para = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    para.text = ""

    def field(instr: str) -> None:
        run = para.add_run()
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        instr_el = OxmlElement("w:instrText")
        instr_el.set(qn("xml:space"), "preserve")
        instr_el.text = instr
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        run._r.append(begin)
        run._r.append(instr_el)
        run._r.append(end)
        run.font.size = Pt(7.2)
        run.font.color.rgb = MUTED
        run.font.name = "Calibri"

    label = para.add_run("Page ")
    label.font.size = Pt(8.5)
    label.font.color.rgb = MUTED
    label.font.name = "Calibri"
    field("PAGE")
    mid = para.add_run(" of ")
    mid.font.size = Pt(8.5)
    mid.font.color.rgb = MUTED
    mid.font.name = "Calibri"
    field("NUMPAGES")


def shade(element, fill: str) -> None:
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    element.append(shd)


def style_cell(cell, text: str, *, bold: bool, size: float, mono: bool = False) -> None:
    """Write a table cell, honouring `**bold**`, `` `code` `` and [links](url) inside it.

    Cells used to be written as one plain run, so a markdown table containing **ZHANG SHUJIA**
    printed the asterisks literally in the exported document.
    """
    cell.text = ""
    para = cell.paragraphs[0]
    para.paragraph_format.space_before = Pt(1)
    para.paragraph_format.space_after = Pt(1)

    def emit(chunk: str, *, force_bold: bool = False, code: bool = False) -> None:
        if not chunk:
            return
        run = para.add_run(chunk)
        run.bold = bold or force_bold
        run.font.size = Pt(size)
        run.font.name = "Consolas" if code else "Calibri"
        run.font.color.rgb = INK

    for token in INLINE.split(text):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**") and len(token) > 4:
            emit(token[2:-2], force_bold=True)
        elif token.startswith("`") and token.endswith("`") and len(token) > 2:
            emit(token[1:-1], code=True)
        elif token.startswith("[") and "](" in token:
            label, url = token[1:-1].split("](", 1)
            run = para.add_run(label)
            run.bold = bold
            run.font.size = Pt(size)
            run.font.name = "Calibri"
            run.font.color.rgb = ACCENT
            run.underline = True
            if url:
                pass  # hyperlink target is shown in the paragraph text elsewhere
        else:
            emit(token)


def hrule(paragraph) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), RULE)
    borders.append(bottom)
    pPr.append(borders)


# --- markdown parsing -------------------------------------------------------------------------

def split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def is_separator(line: str) -> bool:
    return bool(re.fullmatch(r"\|?[\s:|-]+\|?", line.strip())) and "-" in line


INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def write_inline(paragraph, text: str, *, size: float = 10.5, base_bold: bool = False) -> None:
    """Render bold, inline code and links."""
    for token in INLINE.split(text):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**"):
            run = paragraph.add_run(token[2:-2])
            run.bold = True
        elif token.startswith("`") and token.endswith("`"):
            run = paragraph.add_run(token[1:-1])
            run.font.name = "Consolas"
            run.font.size = Pt(size - 1.0)
            run.font.color.rgb = ACCENT
        elif token.startswith("[") and "](" in token:
            label, url = token[1:-1].split("](", 1)
            run = paragraph.add_run(label)
            run.font.color.rgb = ACCENT
            run.underline = True
        else:
            run = paragraph.add_run(token)
        if not run.font.size:
            run.font.size = Pt(size)
        if base_bold:
            run.bold = True
        if not run.font.name:
            run.font.name = "Calibri"
        if run.font.color.rgb is None:
            run.font.color.rgb = INK


def add_code_block(doc, lines: list[str]) -> None:
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.rows[0].cells[0]
    shade(cell._tc.get_or_add_tcPr(), CODE_BG)
    cell.text = ""
    for index, line in enumerate(lines):
        para = cell.paragraphs[0] if index == 0 else cell.add_paragraph()
        para.paragraph_format.space_before = Pt(0)
        para.paragraph_format.space_after = Pt(0)
        para.paragraph_format.line_spacing = 1.0
        run = para.add_run(line if line.strip() else " ")
        run.font.name = "Consolas"
        run.font.size = Pt(7.2)
        run.font.color.rgb = INK
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


def add_table(doc, rows: list[list[str]]) -> None:
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r_index, row in enumerate(rows):
        cells = table.add_row().cells
        for c_index in range(cols):
            value = row[c_index] if c_index < len(row) else ""
            style_cell(cells[c_index], value, bold=(r_index == 0), size=7.8)
            if r_index == 0:
                shade(cells[c_index]._tc.get_or_add_tcPr(), ACCENT and "E8F1EF")
            elif r_index % 2 == 0:
                shade(cells[c_index]._tc.get_or_add_tcPr(), ZEBRA)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


def add_image(doc, image_path: str, caption: str) -> bool:
    """Embed a markdown image, scaled to the text column. Returns False if unavailable."""
    if not os.path.exists(image_path):
        print(f"  ! image not found, skipped: {image_path}", file=sys.stderr)
        return False

    usable_width = (doc.sections[0].page_width
                    - doc.sections[0].left_margin - doc.sections[0].right_margin)
    aspect = 0.5
    try:
        from PIL import Image  # bundled with the runtime

        with Image.open(image_path) as probe:
            aspect = probe.height / probe.width
    except Exception:  # noqa: BLE001 - a missing Pillow should not break the export
        pass

    # cap the figure height so one screenshot cannot consume a whole page
    max_height = Inches(2.0)
    width = usable_width
    if width * aspect > max_height:
        width = int(max_height / aspect)

    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    para.paragraph_format.space_after = Pt(2)
    para.add_run().add_picture(image_path, width=width)

    if caption:
        cap = doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.paragraph_format.space_after = Pt(5)
        run = cap.add_run(caption)
        run.italic = True
        run.font.size = Pt(8)
        run.font.color.rgb = MUTED
        run.font.name = "Calibri"
    return True


def heading_level(line: str) -> tuple[int, str] | None:
    match = re.match(r"^(#{1,6})\s+(.*)$", line)
    if not match:
        return None
    return len(match.group(1)), match.group(2).strip()


def build_docx(md_text: str, out_path: str, *, title: str, subtitle: str, meta: list[str],
               image_root: str = ".", md_path: str = "") -> None:
    doc = Document()

    # Page setup
    section = doc.sections[0]
    section.page_width = Inches(8.27)
    section.page_height = Inches(11.69)
    section.left_margin = section.right_margin = Inches(0.68)
    section.top_margin = Inches(0.50)
    section.bottom_margin = Inches(0.45)

    # Base styles
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(9.8)
    normal.font.color.rgb = INK
    normal.paragraph_format.space_after = Pt(2)
    normal.paragraph_format.line_spacing = 1.0

    for name, size, color, before, after in (
        ("Heading 1", 13.5, INK, 8, 3),
        ("Heading 2", 11, ACCENT, 8, 3),
        ("Heading 3", 9.8, INK, 6, 2),
    ):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = color
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    # Title page
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(0)

    kicker = doc.add_paragraph()
    kicker.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = kicker.add_run("SC6113 — INDIVIDUAL ASSIGNMENT")
    run.font.size = Pt(10)
    run.bold = True
    run.font.color.rgb = ACCENT
    run.font.name = "Calibri"

    title_para = doc.add_paragraph()
    title_para.paragraph_format.space_after = Pt(6)
    run = title_para.add_run(title)
    run.font.size = Pt(20)
    run.bold = True
    run.font.color.rgb = INK
    run.font.name = "Calibri"

    subtitle_para = doc.add_paragraph()
    run = subtitle_para.add_run(subtitle)
    run.font.size = Pt(13)
    run.font.color.rgb = MUTED
    run.font.name = "Calibri"
    hrule(subtitle_para)

    doc.add_paragraph().paragraph_format.space_after = Pt(8)
    for line in meta:
        para = doc.add_paragraph()
        para.paragraph_format.space_after = Pt(1)
        write_inline(para, line, size=10.5)
        for r in para.runs:
            r.font.color.rgb = MUTED

    doc.add_paragraph().paragraph_format.space_after = Pt(2)

    # Body
    lines = md_text.splitlines()
    index = 0
    in_code = False
    code_buffer: list[str] = []
    table_buffer: list[list[str]] = []
    skipped_first_h1 = False

    def flush_table() -> None:
        nonlocal table_buffer
        if table_buffer:
            add_table(doc, table_buffer)
            table_buffer = []

    while index < len(lines):
        line = lines[index]

        if line.strip().startswith("```"):
            if in_code:
                add_code_block(doc, code_buffer)
                code_buffer = []
                in_code = False
            else:
                flush_table()
                in_code = True
            index += 1
            continue

        if in_code:
            code_buffer.append(line)
            index += 1
            continue

        stripped = line.strip()

        image = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)$", stripped)
        if image:
            flush_table()
            src = image.group(2)
            # markdown image paths are usually relative to the markdown file, but a report that
            # references sibling folders reads better relative to the repository root; try both
            candidates = [
                os.path.join(os.path.dirname(os.path.abspath(md_path)), src),
                os.path.join(image_root, src),
                src,
            ]
            resolved = next((c for c in candidates if os.path.exists(c)), candidates[0])
            add_image(doc, resolved, image.group(1))
            index += 1
            continue

        if stripped.startswith("|"):
            row = split_row(stripped)
            if is_separator(stripped):
                index += 1
                continue
            table_buffer.append(row)
            index += 1
            continue
        flush_table()

        if not stripped:
            index += 1
            continue

        if stripped in ("---", "***", "___"):
            para = doc.add_paragraph()
            hrule(para)
            index += 1
            continue

        heading = heading_level(stripped)
        if heading:
            level, text = heading
            if level == 1:
                if not skipped_first_h1:
                    skipped_first_h1 = True
                    index += 1
                    continue
                doc.add_page_break()
            doc.add_heading(text, level=min(level, 3))
            index += 1
            continue

        if stripped.startswith(">"):
            para = doc.add_paragraph()
            para.paragraph_format.left_indent = Inches(0.25)
            write_inline(para, stripped.lstrip("> ").strip(), size=10)
            for r in para.runs:
                r.font.color.rgb = MUTED
                r.italic = True
            index += 1
            continue

        bullet = re.match(r"^([-*+]|\d+\.)\s+(.*)$", stripped)
        if bullet:
            para = doc.add_paragraph(style="List Bullet" if bullet.group(1) in "-*+" else "List Number")
            para.paragraph_format.space_after = Pt(3)
            write_inline(para, bullet.group(2))
            index += 1
            continue

        # ordinary paragraph (join wrapped lines until a blank/structural line)
        chunk = [stripped]
        index += 1
        while index < len(lines):
            nxt = lines[index].strip()
            if (not nxt or nxt.startswith(("#", "|", ">", "```"))
                    or re.match(r"^([-*+]|\d+\.)\s+", nxt) or nxt in ("---", "***", "___")):
                break
            chunk.append(nxt)
            index += 1
        para = doc.add_paragraph()
        write_inline(para, " ".join(chunk))

    flush_table()
    if code_buffer:
        add_code_block(doc, code_buffer)

    add_page_number_footer(doc.sections[0])
    doc.save(out_path)


# --- PDF via the bundled LibreOffice kit -------------------------------------------------------
#
# IMPORTANT: this script deliberately does NOT shell out to the LibreOffice CLI. Inside the DSH
# sandbox a Python process may not spawn a piped child (the documented `spawn EPERM` boundary), so
# the PDF step is driven from the shell instead:
#
#   node "<libreoffice-kit>/lib/cli.js" convert --input docs/MicroLend-Report.docx \
#                                                 --output docs/MicroLend-Report.pdf
#
# `scripts/build-report.ps1` wires both steps together.

def convert_pdf(docx_path: str, pdf_path: str) -> bool:
    """DOCX -> PDF with the bundled LibreOffice kit.

    Only attempted when `--pdf` is passed: inside the default DSH sandbox a Python process may
    not spawn a piped child (the documented `spawn EPERM` boundary), so the caller runs this
    script with wider access when it wants the PDF produced directly.
    """
    node = os.environ.get("MICROLEND_NODE") or r"C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    cli = os.environ.get(
        "MICROLEND_LO_CLI",
        r"D:\deepseekharsness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js",
    )
    if not (os.path.exists(node) and os.path.exists(cli)):
        print("LibreOffice kit not found; DOCX produced without PDF.", file=sys.stderr)
        return False
    if os.path.exists(pdf_path):
        os.remove(pdf_path)
    result = subprocess.run(
        [node, cli, "convert", "--input", docx_path, "--output", pdf_path],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not os.path.exists(pdf_path):
        print(f"PDF conversion failed ({result.returncode}): {(result.stderr or result.stdout or '').strip()[:300]}",
              file=sys.stderr)
        return False
    print(f"wrote {pdf_path}")
    return True


def pdf_command(docx_path: str, pdf_path: str) -> str:
    node = os.environ.get("MICROLEND_NODE", "node")
    cli = os.environ.get(
        "MICROLEND_LO_CLI",
        r"D:\deepseekharsness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js",
    )
    return f'"{node}" "{cli}" convert --input "{docx_path}" --output "{pdf_path}"'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--md", default="docs/REPORT.md")
    parser.add_argument("--outdir", default="docs")
    parser.add_argument("--no-pdf", action="store_true")
    parser.add_argument(
        "--pdf",
        action="store_true",
        help="also convert the DOCX to PDF (needs wider sandbox access for LibreOffice's child process)",
    )
    parser.add_argument("--title", default="MicroLend: A Peer-to-Pool Micro-Lending DApp")
    parser.add_argument(
        "--subtitle",
        default="Design, implementation and evaluation of an Ethereum smart-contract lending protocol "
                "with a MetaMask web client and a Flask indexer",
    )
    args = parser.parse_args()

    if not os.path.exists(args.md):
        print(f"input not found: {args.md}", file=sys.stderr)
        return 2

    with open(args.md, encoding="utf-8") as handle:
        md_text = handle.read()

    title = args.title
    first = heading_level(md_text.splitlines()[0]) if md_text.splitlines() else None
    if first and first[0] == 1:
        title = first[1]

    meta = [
        "**Student:** ZHANG SHUJIA",
        "**Student ID:** G2601577A",
        "**Course:** SC6113 — Blockchain and Decentralised Applications",
        "**Deliverable:** Individual Assignment — Financial Decentralised Application (DApp)",
        "**Project:** MicroLend — peer-to-pool micro-lending protocol",
        "**Network:** Ethereum Sepolia testnet (chainId 11155111)",
        "**Repository layout:** `contracts/`, `backend/`, `frontend/`, `test/`, `scripts/`, `docs/`",
    ]

    os.makedirs(args.outdir, exist_ok=True)
    docx_path = os.path.join(args.outdir, "MicroLend-Report.docx")
    pdf_path = os.path.join(args.outdir, "MicroLend-Report.pdf")

    build_docx(md_text, docx_path, title=title, subtitle=args.subtitle, meta=meta,
                image_root=str(Path(__file__).resolve().parent.parent), md_path=args.md)
    print(f"wrote {docx_path}")

    if args.no_pdf:
        print("skipping PDF (--no-pdf)")
    elif args.pdf:
        convert_pdf(docx_path, pdf_path)
    else:
        print("next step, run from the shell (the sandbox blocks a piped child here):")
        print("  " + pdf_command(docx_path, pdf_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
