#!/usr/bin/env python3
"""
将网页 URL 转为本地 Markdown 文件。
- 只抓取正文区域内的图片，按在正文中的出现顺序下载并编号，与正文位置一致。
- 转换时保留标题层级、段落与列表结构，生成便于阅读的 Markdown。
"""
import re
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md

# 请求头，模拟浏览器以减少被拦截
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def sanitize_filename(name: str, max_len: int = 80) -> str:
    """将字符串转为安全的文件名（去掉非法字符、截断长度）。"""
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = name.strip().strip(".") or "page"
    return name[:max_len]


def get_extension_from_url(url: str) -> str:
    """从 URL 或 Content-Type 推断图片扩展名。"""
    path = urlparse(url).path.lower()
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"):
        if ext in path or path.endswith(ext):
            return ext.lstrip(".")
    return "jpg"


def download_image(url: str, save_path: Path, session: requests.Session) -> bool:
    """下载图片到 save_path，成功返回 True。"""
    try:
        r = session.get(url, timeout=15, headers=HEADERS, stream=True)
        r.raise_for_status()
        content_type = r.headers.get("Content-Type", "").lower()
        # 若本地无扩展名，根据 Content-Type 补全
        if not save_path.suffix and "image/" in content_type:
            ext_map = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
            for ct, ext in ext_map.items():
                if ct in content_type:
                    save_path = save_path.with_suffix(ext)
                    break
        save_path.parent.mkdir(parents=True, exist_ok=True)
        with open(save_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return True
    except Exception as e:
        print(f"  [警告] 下载图片失败 {url}: {e}", file=sys.stderr)
        return False


def url_to_markdown(
    page_url: str,
    output_dir: Optional[Path] = None,
    output_name: Optional[str] = None,
    images_subdir: str = "images",
) -> Path:
    """
    抓取网页，转成 Markdown，图片下载到 output_dir/images_subdir/ 并修正引用。

    :param page_url: 网页 URL
    :param output_dir: 输出目录，默认当前目录
    :param output_name: 输出 md 文件名（不含路径），默认用页面 title 或 URL 生成
    :param images_subdir: 图片子目录名
    :return: 生成的 .md 文件路径
    """
    output_dir = output_dir or Path.cwd()
    output_dir = Path(output_dir).resolve()
    images_dir = output_dir / images_subdir
    images_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update(HEADERS)

    print(f"正在抓取: {page_url}")
    resp = session.get(page_url, timeout=20)
    resp.raise_for_status()
    
    # 优先从 HTML meta 标签获取编码，其次 apparent_encoding，最后默认 utf-8
    html_for_encoding = resp.content[:2048].decode('ascii', errors='ignore')
    meta_charset_match = re.search(r'<meta[^>]+charset=["\']?([^"\'>\s]+)', html_for_encoding, re.IGNORECASE)
    if meta_charset_match:
        resp.encoding = meta_charset_match.group(1)
    else:
        resp.encoding = resp.apparent_encoding or "utf-8"
    
    html = resp.text

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")

    # 优先提取正文区域（微信公众号、常见博客等），只处理正文内的内容
    body = (
        soup.find(id="js_content")  # 微信公众号
        or soup.find("article")
        or soup.find(class_=re.compile(r"content|article|post-body", re.I))
        or soup.find("main")
        or soup.find("body")
        or soup
    )

    # 文章主标题（用于文件名）：优先用正文主标题，其次 <title>
    article_title = ""
    # 微信公众号常见标题位置
    wechat_title = soup.find(id=re.compile(r"activity-name", re.I)) or soup.find(
        class_=re.compile(r"rich_media_title", re.I)
    )
    if wechat_title and wechat_title.get_text(strip=True):
        article_title = wechat_title.get_text(strip=True)
    else:
        # 退回正文里的第一个 h1/h2
        heading = body.find(["h1", "h2"])
        if heading and heading.get_text(strip=True):
            article_title = heading.get_text(strip=True)

    # 再退回页面 <title> 或 URL path
    title_tag = soup.find("title")
    raw_title = (title_tag.get_text().strip() if title_tag else "") or urlparse(page_url).path or "page"
    title_for_filename = article_title or raw_title

    default_name = sanitize_filename(title_for_filename)
    if not default_name or default_name == "page":
        default_name = "page_" + re.sub(r"\W+", "_", urlparse(page_url).path)[:50]
    base_name = output_name or default_name
    if not base_name.endswith(".md"):
        base_name = base_name + ".md"
    md_path = output_dir / base_name

    # 只抓取正文区域内的图片，按在正文中的出现顺序编号，保证与正文位置一致
    # 微信公众号等使用懒加载：真实 URL 在 data-src，src 为空或占位符
    imgs = body.find_all("img")
    index = 0
    for img in imgs:
        src = (img.get("src") or "").strip()
        data_src = (img.get("data-src") or img.get("data-srcset") or "").strip()
        # 优先使用 data-src（懒加载真实地址）；若 src 为空或是 data: 占位符则用 data-src
        if data_src and (not src or src.startswith("data:")):
            # data-srcset 可能为 "url1 2x, url2" 形式，取第一个 URL
            img_url = data_src.replace(",", " ").split()[0] if data_src else ""
        else:
            img_url = src
        if not img_url or img_url.startswith("data:"):
            continue
        abs_url = urljoin(page_url, img_url)
        index += 1
        ext = get_extension_from_url(abs_url)
        local_name = f"{index}.{ext}"
        local_path = images_dir / local_name
        rel_path = f"{images_subdir}/{local_name}"
        if download_image(abs_url, local_path, session):
            img["src"] = rel_path
            if img.get("data-src"):
                img["data-src"] = rel_path
            print(f"  已保存图片: {rel_path}")

    # 转 Markdown：保留标题层级、段落与列表结构
    markdown_text = md(
        str(body),
        heading_style="ATX",
        strip=["script", "style", "nav", "iframe"],
        bullets="-",
        newline_style="SPACES",
    )

    # 一些微信公众号文章会在 <li> 里再嵌一个 "•" 字符，markdownify 后变成 "- • xxx"，
    # 这里将其规整成标准列表 "- xxx"；同时处理行首裸 "• xxx"。
    markdown_text = re.sub(r"(?m)^-\s*•\s*", "- ", markdown_text)
    markdown_text = re.sub(r"(?m)^•\s+", "- ", markdown_text)

    # 标题前保留空行
    markdown_text = re.sub(r"(\n)(#{1,6}\s)", r"\n\n\2", markdown_text)

    # 将“单独一行的短标题”转为 ##（公众号等常用 p 做小节标题：上一行为空且本行较短）
    # 但避免把有序列表（如 "1. 默认串行先跑稳"、"1.1 默认串行..."）错误提升为标题。
    lines = markdown_text.split("\n")
    out = []
    for i, line in enumerate(lines):
        s = line.strip()
        prev_empty = i == 0 or not lines[i - 1].strip()
        is_short = 4 <= len(s) <= 60
        looks_like_ordered = bool(re.match(r"\d+(\.\d+)*\s+", s))
        ends_with_sentence_punct = bool(re.search(r"[。？！…]$", s))
        if (
            is_short
            and prev_empty
            and "｜" not in s
            and not s.startswith(("#", "-", "*", "[", "|", "!", ">"))
            and not looks_like_ordered
            and not ends_with_sentence_punct
        ):
            if not s.startswith("作者") and not s.startswith("编辑") and not s.startswith("策划"):
                out.append("## " + s)
                continue
        out.append(line)
    markdown_text = "\n".join(out)

    # 合并过多连续空行
    markdown_text = re.sub(r"\n{3,}", "\n\n", markdown_text)
    markdown_text = markdown_text.strip()

    md_path.write_text(markdown_text, encoding="utf-8")
    print(f"已生成: {md_path}")
    return md_path


def main():
    if len(sys.argv) < 2:
        print("用法: python url_to_markdown.py <网页URL> [输出目录] [输出文件名.md]")
        print("示例: python url_to_markdown.py https://mp.weixin.qq.com/s/xxx ./output")
        sys.exit(1)

    page_url = sys.argv[1].strip()
    if not page_url.startswith(("http://", "https://")):
        page_url = "https://" + page_url

    output_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path.cwd()
    output_name = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        url_to_markdown(page_url, output_dir=output_dir, output_name=output_name)
    except requests.RequestException as e:
        print(f"请求失败: {e}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()

