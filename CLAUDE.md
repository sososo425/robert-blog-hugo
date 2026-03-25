# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development server (includes drafts)
hugo server -D
# Access at http://localhost:1313

# Build static site (output to public/)
hugo

# Create a new article
hugo new content tech/my-new-post.md
hugo new content tech/reference-news/my-article.md
hugo new content life/my-thoughts.md

# Convert a URL to a blog post (see URL-to-Post section below)
./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]
```

## Architecture

This is a **Hugo static site** deployed on **Vercel**, with Vercel Serverless Functions providing the backend API.

### Key configuration files
- `hugo.toml` — site-wide config: base URL, theme, navigation menus, output formats
- `hugo.local.toml` — local override (`baseURL = 'http://localhost:3000'`)
- `themes/PaperMod/` — upstream theme (git submodule, do not modify directly)

### Content structure
```
content/
├── tech/                    # 技术 (mainSections = ["tech"])
│   ├── ai-agents/           # AI 智能体子栏
│   ├── bigdata-storage/     # 大数据存储子栏
│   ├── reference-news/      # 参考资讯子栏
│   └── *.md                 # Flat tech articles
├── life/                    # 人生
├── music/                   # 兴趣/音乐
└── literature/              # 文学
```

Article images go in `static/images/<slug>/` and are referenced in Markdown as `![](/images/<slug>/1.jpg)`.

Hugo `ignoreFiles` excludes `copilot/`, `Excalidraw/`, `textgenerator/`, `.obsidian/`, `private/` directories from building.

### Custom layouts (override PaperMod defaults)
- `layouts/_default/single.html` — article page template; includes AI chat widget
- `layouts/partials/ai_chat.html` — AI chat widget (floating button, chat window, user auth modals)
- `layouts/partials/extend_head.html` — injects MathJax when `math: true` in frontmatter
- `layouts/_default/_markup/render-image.html` — image render hook
- `layouts/_default/_markup/render-link.html` — link render hook

### Vercel Serverless API (`api/`)
- `api/chat.js` — proxies messages to Kimi AI (Moonshot), logs conversations to Vercel Blob
- `api/auth/login.js`, `register.js`, `me.js`, `change-password.js` — JWT-based user auth stored in Vercel Blob
- `api/chat/history.js`, `save.js` — per-user chat history stored in Vercel Blob

Required environment variables on Vercel:
- `KIMI_API_KEY` — Moonshot API key
- `JWT_SECRET` — secret for signing auth tokens

### URL-to-Post workflow (`tools/url-to-blog-post/`)
The script `./scripts/url_to_blog_post.sh` invokes `tools/url-to-blog-post/url_to_hugo_post.py` (which depends on `url_to_markdown.py`). It fetches a webpage, downloads images, generates frontmatter, and writes `content/<section>/[subsection/]<slug>.md` + `static/images/<slug>/`.

Supports `FETCH_MODE=playwright` to bypass anti-scraping (e.g. WeChat articles).

### Article frontmatter conventions
- `draft: false` — required to publish
- `math: true` — enables MathJax rendering
- `disableAIChat: true` — hides the AI chat widget on that page
- `categories` — mapped from section (`tech`, `life`, etc.)
- `tags` — free-form tags

### Obsidian integration
Two workflows described in `docs/obsidian-blog.md`:
1. Sync from a separate Obsidian Vault using `scripts/sync_obsidian_to_blog.py`
2. Open the blog repo itself as an Obsidian Vault and edit `content/` directly (symlink `images → static/images` for path compatibility)
