# url-to-blog-post 参考

## 外部工具路径与环境

- **默认**：`~/Documents/workspace/my_tools`（需包含 `url_to_hugo_post.py` 与 `url_to_markdown.py`）
- **覆盖**：设置环境变量 `MY_TOOLS_PATH` 指向该目录
- **Python 环境**：**本博客仓库不包含 Python 依赖与 venv**。`url_to_blog_post.sh` 会调用 my_tools 下的 `venv/bin/python`（若存在）或系统 `python3` 执行 `url_to_hugo_post.py`，所有第三方依赖（如 requests、beautifulsoup4、markdownify）仅在 my_tools 的 venv 中安装即可。

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
