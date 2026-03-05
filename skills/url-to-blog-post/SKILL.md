---
name: url-to-blog-post
description: Converts a web URL to a Hugo blog post and places it in the repo. Use when the user wants to save an article from a URL (e.g. WeChat, blog) as a new post, or import an article into the blog with images and frontmatter.
---

# URL 转博客文章 (url-to-blog-post)

将网页 URL 转为 Hugo 博客文章：抓取正文、下载图片、生成 frontmatter，并写入 `content/<section>/[subsection>/]<slug>.md` 与 `static/images/<slug>/`。

## 前置条件

- **工具代码**：已包含在本仓库 `tools/url-to-blog-post/` 中的 `url_to_hugo_post.py`（内部依赖 `url_to_markdown.py`）。
- **Python 依赖**：见 `tools/url-to-blog-post/requirements.txt`。推荐在该目录下创建虚拟环境并安装依赖（云端 agent 可按此自动安装）。
- **运行环境**：在博客仓库根目录执行脚本（即包含 `hugo.toml`、`content/`、`static/` 的目录）。

## 推荐方式：使用脚本

在博客仓库根目录执行：

```bash
# 参数：URL [section] [subsection] [slug]
./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]
```

- **section**：默认 `tech`，可选 `tech`、`life`、`music`、`literature`。
- **subsection**：可选。例如 `tech` + `reference-news` 时，文章落在 `content/tech/reference-news/<slug>.md`（对应本站「参考资讯」子栏）。
- **slug**：不填则由页面标题生成。

**示例：**

```bash
# 转为 tech 下 flat 文章（如 AI 与智能体、大数据与存储 等，需手动在 tech/_index.md 归类）
./scripts/url_to_blog_post.sh "https://mp.weixin.qq.com/s/xxx"

# 指定为「参考资讯」子栏（content/tech/reference-news/）
./scripts/url_to_blog_post.sh "https://example.com/article" tech reference-news 2026-ai-data-industry

# 指定 section 与 slug
./scripts/url_to_blog_post.sh "https://example.com/article" life "" my-post-slug
```

**栏目与 content 对应：** `tech` → `content/tech/`；`tech` + `reference-news` → `content/tech/reference-news/`；`life` → `content/life/`；`music`、`literature` 同理。

## 手动流程（脚本不可用时）

1. 在仓库根目录或 `tools/url-to-blog-post/` 目录下，使用安装了依赖的 Python 环境执行：  
   `python tools/url-to-blog-post/url_to_hugo_post.py "<URL>" "<博客仓库绝对路径>" [section] [subsection] [slug]`
2. 或先用 `url_to_markdown.py` 得到 md + images，再手动复制图片到 `static/images/<slug>/`、替换正文中 `images/` 为 `/images/<slug>/`、添加 frontmatter 与「原文来源」块，保存到 `content/<section>/[subsection>/]<slug>.md`。

## 输出约定

- 文章路径：`content/<section>/<slug>.md` 或 `content/<section>/<subsection>/<slug>.md`
- 图片目录：`static/images/<slug>/`，文中引用形如 `![](/images/<slug>/1.jpg)`
- Frontmatter 含：`title`、`date`、`draft: false`、`description`、`categories`（由 section 映射）、`tags`（可后续编辑）

## 更多说明

见 [reference.md](reference.md)：工具路径、Cursor/OpenClaw 复用、本仓库无需 Python 环境。
