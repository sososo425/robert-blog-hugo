# url-to-blog-post 参考

## 工具路径与 Python 环境

- **工具代码内置**：仓库根目录下的 `tools/url-to-blog-post/` 已包含 `url_to_hugo_post.py` 与 `url_to_markdown.py`。
- **Python 依赖**：`tools/url-to-blog-post/requirements.txt`（如 requests、beautifulsoup4、markdownify）。
- **虚拟环境建议**：可在 `tools/url-to-blog-post/` 下创建 venv（本仓库 `.gitignore` 已忽略 `venv/`、`.venv/`，不会被提交），示例：
  ```bash
  cd tools/url-to-blog-post
  python3 -m venv venv
  ./venv/bin/pip install -r requirements.txt
  ```
  `scripts/url_to_blog_post.sh` 会优先使用 `tools/url-to-blog-post/venv/bin/python`，找不到时回退到系统 `python3`。

## Cursor 与 OpenClaw 的 Skill 复用

**Skill 结构通用**：两者均使用「目录 + `SKILL.md`（YAML frontmatter + Markdown）」的约定，同一份 skill 可被 Cursor 与 OpenClaw 复用。

| 平台     | 项目内 skill 路径           | 用户级 skill 路径        |
|----------|-----------------------------|----------------------------|
| Cursor   | `.cursor/skills/`           | `~/.cursor/skills/`        |
| OpenClaw | 工作区 `skills/`           | `~/.openclaw/skills/`     |

本仓库同时提供 `.cursor/skills/url-to-blog-post/` 与 `skills/url-to-blog-post/`，便于两种环境加载。

## 二级目录（subsection）

本站「专业」下除 flat 文章外，有子栏如 **参考资讯**（`content/tech/reference-news/`）。转换「参考资讯」类文章时请传入 subsection：  
`./scripts/url_to_blog_post.sh "<URL>" tech reference-news [slug]`。
