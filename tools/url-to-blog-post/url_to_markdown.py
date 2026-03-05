#!/usr/bin/env python3
"""
将网页 URL 转为本地 Markdown 文件。
支持多种抓取模式：requests（快速）、playwright（绕过风控）、代理（走本地IP）
- 只抓取正文区域内的图片，按在正文中的出现顺序下载并编号，与正文位置一致。
- 转换时保留标题层级、段落与列表结构，生成便于阅读的 Markdown。
"""
import os
import re
import sys
import time
import random
from pathlib import Path
from typing import Optional, Literal
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md

# 请求头池，随机选择以模拟不同浏览器
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
]


def get_headers():
    """获取随机请求头。"""
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    }


def sanitize_filename(name: str, max_len: int = 80) -> str:
    """将字符串转为安全的文件名（去掉非法字符、截断长度）。"""
    name = re.sub(r'[<>"/\\|?*]', "_", name)
    name = name.strip().strip(".") or "page"
    return name[:max_len]


def get_extension_from_url(url: str) -> str:
    """从 URL 或 Content-Type 推断图片扩展名。"""
    path = urlparse(url).path.lower()
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"):
        if ext in path or path.endswith(ext):
            return ext.lstrip(".")
    return "jpg"


def download_image(url: str, save_path: Path, session: requests.Session, headers: dict) -> bool:
    """下载图片到 save_path，成功返回 True。"""
    try:
        r = session.get(url, timeout=15, headers=headers, stream=True)
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


def fetch_with_requests(page_url: str, proxy: Optional[str] = None) -> str:
    """使用 requests 抓取页面，可选代理。"""
    session = requests.Session()
    headers = get_headers()
    session.headers.update(headers)
    
    proxies = {"http": proxy, "https": proxy} if proxy else None
    
    print(f"使用 requests 抓取: {page_url}")
    if proxy:
        print(f"通过代理: {proxy}")
    
    resp = session.get(page_url, timeout=30, proxies=proxies)
    resp.raise_for_status()
    
    # 优先从 HTML meta 标签获取编码
    html_for_encoding = resp.content[:2048].decode('ascii', errors='ignore')
    meta_charset_match = re.search(r'<meta[^>]+charset=["\']?([^"\'>\s]+)', html_for_encoding, re.IGNORECASE)
    if meta_charset_match:
        resp.encoding = meta_charset_match.group(1)
    else:
        resp.encoding = resp.apparent_encoding or "utf-8"
    
    return resp.text


def fetch_with_playwright(page_url: str, headless: bool = True, wait_time: int = 3) -> str:
    """使用 Playwright 浏览器抓取页面，可绕过大部分风控。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright 未安装，请先安装: pip install playwright && playwright install chromium")
        raise
    
    print(f"使用 Playwright 抓取: {page_url}")
    print(f"等待页面渲染 {wait_time} 秒...")
    
    # 查找系统 Chrome/Chromium
    import shutil
    chrome_path = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    
    with sync_playwright() as p:
        launch_args = {"headless": headless}
        if chrome_path:
            print(f"使用系统浏览器: {chrome_path}")
            launch_args["executable_path"] = chrome_path
        
        browser = p.chromium.launch(**launch_args)
        context = browser.new_context(
            user_agent=random.choice(USER_AGENTS),
            viewport={"width": 1920, "height": 1080},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = context.new_page()
        
        # 设置额外的请求头
        page.set_extra_http_headers({
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "DNT": "1",
        })
        
        page.goto(page_url, wait_until="networkidle")
        time.sleep(wait_time)  # 等待 JS 渲染
        
        html = page.content()
        
        browser.close()
        return html


def is_wechat_verification_page(html: str) -> bool:
    """检查是否是微信验证页面。"""
    verification_markers = [
        "环境异常",
        "完成验证后即可继续访问",
        "secitptpage/verify",
        "var PAGE_MID",
    ]
    return any(marker in html for marker in verification_markers)


def url_to_markdown(
    page_url: str,
    output_dir: Optional[Path] = None,
    output_name: Optional[str] = None,
    images_subdir: str = "images",
    fetch_mode: Literal["auto", "requests", "playwright"] = "auto",
    proxy: Optional[str] = None,
    headless: bool = True,
) -> Path:
    """
    抓取网页，转成 Markdown，图片下载到 output_dir/images_subdir/ 并修正引用。

    :param page_url: 网页 URL
    :param output_dir: 输出目录，默认当前目录
    :param output_name: 输出 md 文件名（不含路径），默认用页面 title 或 URL 生成
    :param images_subdir: 图片子目录名
    :param fetch_mode: 抓取模式 - auto(自动选择), requests(快速), playwright(浏览器)
    :param proxy: 代理地址，如 http://localhost:8080
    :param headless: Playwright 是否使用无头模式
    :return: 生成的 .md 文件路径
    """
    output_dir = output_dir or Path.cwd()
    output_dir = Path(output_dir).resolve()
    images_dir = output_dir / images_subdir
    images_dir.mkdir(parents=True, exist_ok=True)

    # 抓取页面
    html = None
    used_mode = None
    
    if fetch_mode == "auto":
        # 先尝试 requests
        try:
            html = fetch_with_requests(page_url, proxy=proxy)
            used_mode = "requests"
            # 检查是否是微信验证页
            if is_wechat_verification_page(html):
                print("检测到验证页面，切换到 Playwright 模式...")
                html = fetch_with_playwright(page_url, headless=headless)
                used_mode = "playwright"
        except Exception as e:
            print(f"requests 模式失败: {e}，尝试 Playwright...")
            html = fetch_with_playwright(page_url, headless=headless)
            used_mode = "playwright"
    elif fetch_mode == "requests":
        html = fetch_with_requests(page_url, proxy=proxy)
        used_mode = "requests"
    elif fetch_mode == "playwright":
        html = fetch_with_playwright(page_url, headless=headless)
        used_mode = "playwright"
    else:
        raise ValueError(f"未知的 fetch_mode: {fetch_mode}")
    
    print(f"使用 {used_mode} 模式成功获取页面")

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
    
    # 使用 requests session 下载图片
    session = requests.Session()
    headers = get_headers()
    session.headers.update(headers)
    
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
        if download_image(abs_url, local_path, session, headers):
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

    # 将"单独一行的短标题"转为 ##（公众号等常用 p 做小节标题：上一行为空且本行较短）
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
        print("环境变量:")
        print("  FETCH_MODE=auto|requests|playwright  抓取模式 (默认: auto)")
        print("  PROXY=http://host:port               代理地址")
        print("  HEADLESS=0|1                         Playwright 无头模式 (默认: 1)")
        print("示例:")
        print("  python url_to_markdown.py https://mp.weixin.qq.com/s/xxx ./output")
        print("  FETCH_MODE=playwright python url_to_markdown.py https://mp.weixin.qq.com/s/xxx")
        sys.exit(1)

    page_url = sys.argv[1].strip()
    if not page_url.startswith(("http://", "https://")):
        page_url = "https://" + page_url

    output_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path.cwd()
    output_name = sys.argv[3] if len(sys.argv) > 3 else None
    
    # 从环境变量读取配置
    fetch_mode = os.environ.get("FETCH_MODE", "auto")
    proxy = os.environ.get("PROXY")
    headless = os.environ.get("HEADLESS", "1") != "0"

    try:
        url_to_markdown(
            page_url, 
            output_dir=output_dir, 
            output_name=output_name,
            fetch_mode=fetch_mode,
            proxy=proxy,
            headless=headless,
        )
    except requests.RequestException as e:
        print(f"请求失败: {e}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(3)


if __name__ == "__main__":
    main()
