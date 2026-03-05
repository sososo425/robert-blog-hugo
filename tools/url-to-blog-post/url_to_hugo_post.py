#!/usr/bin/env python3
"""
将网页 URL 转为 Hugo 博客文章并写入指定博客仓库。
依赖同目录下的 url_to_markdown，需在 tools/url-to-blog-post 目录或已安装环境中运行。
用法: python url_to_hugo_post.py <URL> <博客仓库根路径> [section] [subsection] [slug]
"""
import re
import sys
from datetime import datetime
from pathlib import Path

# 保证可导入同目录的 url_to_markdown
if __name__ == "__main__":
    _ROOT = Path(__file__).resolve().parent
    if str(_ROOT) not in sys.path:
        sys.path.insert(0, str(_ROOT))

from url_to_markdown import url_to_markdown

# section -> Hugo categories 显示名
SECTION_TO_CATEGORY = {
    "tech": "技术",
    "life": "人生",
    "music": "兴趣",
    "literature": "文学",
}

# tech 子目录 -> _index / index_obsidian 中使用的小节标题
TECH_SUBSECTION_TO_HEADING = {
    "": "### AI 与智能体",  # 默认归到 AI 与智能体
    "ai-agents": "### AI 与智能体",
    "bigdata-storage": "### 大数据与存储",
    "reference-news": "### 参考资讯",
}


def _append_to_hugo_index(blog_root: Path, section: str, subsection: str, title: str, slug: str) -> None:
    """在对应 section 的 _index.md 里追加一行链接（仅对 tech 做适配）。"""
    if section != "tech":
        return

    index_path = blog_root / "content" / "tech" / "_index.md"
    if not index_path.is_file():
        return

    text = index_path.read_text(encoding="utf-8")
    url = f"/tech/{slug}/"
    if url in text:
        return  # 已存在，无需重复添加

    heading = TECH_SUBSECTION_TO_HEADING.get(subsection or "")
    if not heading:
        return

    lines = text.splitlines()
    try:
        h_idx = next(i for i, line in enumerate(lines) if line.strip() == heading)
    except StopIteration:
        return

    # 在对应小节下现有列表的末尾插入
    insert_pos = len(lines)
    i = h_idx + 1
    last_bullet = h_idx
    while i < len(lines):
        s = lines[i].lstrip()
        if s.startswith("### "):
            break
        if s.startswith("- "):
            last_bullet = i
        i += 1
    insert_pos = last_bullet + 1

    new_line = f'- [{title}]({url})'
    lines.insert(insert_pos, new_line)
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _append_to_obsidian_index(blog_root: Path, section: str, subsection: str, title: str, slug: str) -> None:
    """在 Obsidian 导航 index_obsidian.md 里追加一行 wikilink（仅对 tech 做适配）。"""
    if section != "tech":
        return

    index_path = blog_root / "content" / "tech" / "index_obsidian.md"
    if not index_path.is_file():
        return

    # Obsidian 中的相对路径
    if subsection in ("", "ai-agents"):
        rel_path = f"ai-agents/{slug}"
    elif subsection == "bigdata-storage":
        rel_path = f"bigdata-storage/{slug}"
    elif subsection == "reference-news":
        rel_path = f"reference-news/{slug}"
    else:
        # 未知小节先不自动维护
        return

    text = index_path.read_text(encoding="utf-8")
    marker = f"[[{rel_path}|"
    if marker in text:
        return  # 已存在

    heading = TECH_SUBSECTION_TO_HEADING.get(subsection or "")
    if not heading:
        return

    lines = text.splitlines()
    try:
        h_idx = next(i for i, line in enumerate(lines) if line.strip() == heading)
    except StopIteration:
        return

    last_bullet = h_idx
    i = h_idx + 1
    while i < len(lines):
        s = lines[i].lstrip()
        if s.startswith("### "):
            break
        if s.startswith("- "):
            last_bullet = i
        i += 1
    insert_pos = last_bullet + 1

    new_line = f"- [[{rel_path}|{title}]]"
    lines.insert(insert_pos, new_line)
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    if len(sys.argv) < 3:
        print("用法: python url_to_hugo_post.py <URL> <博客仓库根路径> [section] [subsection] [slug]")
        print("  section 默认 tech，可选: tech, life, music, literature")
        print("  subsection 可选，如 tech 下的 reference-news，则文章落在 content/tech/reference-news/")
        print("  slug 不填则由页面标题生成")
        sys.exit(1)

    url = sys.argv[1].strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    blog_root = Path(sys.argv[2]).resolve()
    if not (blog_root / "hugo.toml").exists() and not (blog_root / "config.toml").exists():
        print(f"错误: 未在 {blog_root} 下找到 hugo.toml 或 config.toml")
        sys.exit(2)

    section = (sys.argv[3].strip().lower() if len(sys.argv) > 3 else "tech")
    subsection = (sys.argv[4].strip() if len(sys.argv) > 4 else "")
    slug_arg = sys.argv[5].strip() if len(sys.argv) > 5 else None

    if section not in SECTION_TO_CATEGORY:
        print(f"无效 section: {section}，可选: {list(SECTION_TO_CATEGORY.keys())}")
        sys.exit(3)

    content_dir = blog_root / "content" / section
    if subsection:
        content_dir = content_dir / subsection
    content_dir.mkdir(parents=True, exist_ok=True)

    static_images = blog_root / "static" / "images"
    static_images.mkdir(parents=True, exist_ok=True)

    import tempfile
    with tempfile.TemporaryDirectory(prefix="url2hugo_") as tmp:
        tmp_path = Path(tmp)
        out_name = f"{slug_arg}.md" if slug_arg else None
        try:
            md_path = url_to_markdown(url, output_dir=tmp_path, output_name=out_name)
        except Exception as e:
            print(f"url_to_markdown 失败: {e}", file=sys.stderr)
            sys.exit(4)

        images_src = tmp_path / "images"
        body = md_path.read_text(encoding="utf-8")

        title = ""
        for line in body.splitlines():
            m = re.match(r"^#+\s+(.+)$", line.strip())
            if m:
                title = m.group(1).strip()
                break
        if not title:
            title = slug_arg or md_path.stem

        # 根据标题/显式 slug 生成稳定的英文 slug（用于 URL、文件名、图片目录）
        def _slugify(text: str) -> str:
            # 只保留字母、数字、空格和连字符，其余去掉，再转为 kebab-case
            cleaned = re.sub(r"[^\w\s-]", " ", text)
            cleaned = re.sub(r"[\s_]+", "-", cleaned).strip("-").lower()
            if not cleaned:
                # 如果全是中文等非 ASCII，退回安全文件名再处理
                fallback = re.sub(r"[^\w\s-]", " ", md_path.stem)
                fallback = re.sub(r"[\s_]+", "-", fallback).strip("-").lower() or "post"
                return fallback
            return cleaned

        if slug_arg:
            slug = slug_arg
        else:
            slug = _slugify(title)

        # 复制图片到 static/images/<slug>/
        images_dst = static_images / slug
        if images_src.is_dir():
            images_dst.mkdir(parents=True, exist_ok=True)
            for f in images_src.iterdir():
                if f.is_file():
                    (images_dst / f.name).write_bytes(f.read_bytes())
            print(f"已复制图片到 static/images/{slug}/")

        # 将正文中的图片路径 images/xxx 规范为相对路径 images/<slug>/xxx
        body = re.sub(r"(!\[.*?\]\()images/", rf"\1images/{slug}/", body)
        source_block = f"> **原文来源**：{url}\n\n"
        if not body.strip().startswith(">"):
            body = source_block + body
        else:
            body = source_block + body

        today = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
        category = SECTION_TO_CATEGORY[section]

        # URL 希望保持为 /<section>/<slug>/，与是否有 subsection 无关
        canonical_url = f"/{section}/{slug}/"

        fm = f"""---
title: "{title.replace(chr(34), chr(92)+chr(34))}"
date: {today}
draft: false
description: ""
categories: ["{category}"]
tags: []
url: "{canonical_url}"
---

"""

        final_md = fm + body
        out_path = content_dir / f"{slug}.md"
        out_path.write_text(final_md, encoding="utf-8")
        rel = out_path.relative_to(blog_root)
        print(f"已写入: {rel}")

        # 更新 tech 下的索引页（Hugo 用的 _index.md & Obsidian 用的 index_obsidian.md）
        try:
            _append_to_hugo_index(blog_root, section, subsection, title, slug)
            _append_to_obsidian_index(blog_root, section, subsection, title, slug)
        except Exception as e:  # 索引更新失败不影响主流程
            print(f"更新索引文件时出错（可忽略，稍后手工维护）: {e}", file=sys.stderr)

        print("请检查 frontmatter（description、tags）后提交。")


if __name__ == "__main__":
    main()

