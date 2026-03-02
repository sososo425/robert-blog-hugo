# Robert Blog - Hugo 版本

这是我的个人博客 Hugo 版本，使用 PaperMod 主题。

## 快速开始

### 1. 安装 Hugo

**macOS:**
```bash
brew install hugo
```

**或使用二进制文件：**
```bash
# 下载最新版本
wget https://github.com/gohugoio/hugo/releases/download/v0.142.0/hugo_0.142.0_darwin-universal.tar.gz
tar -xzf hugo_0.142.0_darwin-universal.tar.gz
sudo mv hugo /usr/local/bin/
```

验证安装：
```bash
hugo version
```

### 2. 安装主题

```bash
cd robert-blog-hugo
git init
git submodule add --depth=1 https://github.com/adityatelange/hugo-PaperMod.git themes/PaperMod
```

### 3. 本地预览

```bash
hugo server -D
# 访问 http://localhost:1313
```

### 4. 构建

```bash
hugo
# 生成的静态文件在 public/ 目录
```

## 部署到 Vercel

### 方式 1：GitHub + Vercel（推荐）

1. 创建 GitHub 仓库并推送代码
```bash
git init
git add .
git commit -m "Initial Hugo site"
git remote add origin git@github.com:sososo425/robert-blog-hugo.git
git push -u origin main
```

2. 在 Vercel 导入项目
   - 访问 https://vercel.com/new
   - 导入 `robert-blog-hugo` 仓库
   - 框架预设选择 **Hugo**
   - 部署

### 方式 2：手动部署

```bash
# 构建
hugo

# 进入 public 目录
cd public

# 提交到 gh-pages 分支或部署到 Vercel
```

## 项目结构

```
robert-blog-hugo/
├── archetypes/          # 文章模板
├── assets/              # 资源文件
├── content/             # 网站内容
│   ├── life/           # 人生栏目
│   ├── music/          # 音乐栏目
│   ├── tech/           # 技术栏目
│   └── literature/     # 文学栏目
├── layouts/            # HTML 模板（自定义）
├── static/             # 静态资源
├── themes/             # 主题
│   └── PaperMod/       # PaperMod 主题
└── hugo.toml           # 站点配置
```

## 创建新文章

```bash
# 创建技术文章
hugo new content tech/my-new-post.md

# 创建人生随笔
hugo new content life/my-thoughts.md
```

## 自定义配置

编辑 `hugo.toml` 修改：
- 网站标题、描述
- 导航菜单
- 主题参数
- 个人信息

## AI 助手功能 🤖

博客已集成 Kimi AI 助手，每篇文章右下角会显示 AI 聊天按钮。

### 功能特点

- 💬 **文章问答** — 读者可以针对当前文章内容提问
- 📝 **智能总结** — 一键总结文章核心观点
- 🔍 **概念解释** — 解释文中的技术概念
- 🎨 **深色模式适配** — 自动适配博客的深色/浅色主题

### 如何工作

1. 读者点击右下角的 **「AI助手」** 按钮
2. 输入问题或选择快捷提问
3. AI 基于文章内容实时回答

### 配置说明

部署前需要设置 Kimi API Key：

```bash
# 在 Vercel 环境变量中设置
KIMI_API_KEY=sk-your-api-key-here
```

获取 API Key：
1. 访问 [Moonshot AI 平台](https://platform.moonshot.cn)
2. 注册/登录账号
3. 创建 API Key

### 关闭 AI 助手

在文章 frontmatter 中添加：

```yaml
---
title: "某篇文章"
disableAIChat: true
---
```

## 搜索功能

PaperMod 主题内置 Fuse.js 搜索，已开启。点击右上角 🔍 图标即可搜索。

## URL 转博客文章

可将网页（如公众号、博客）转为本站文章并写入 `content/` 与 `static/images/`。

- **依赖**：本地工具 [my_tools](https://github.com)（需包含 `url_to_hugo_post.py` 与 `url_to_markdown.py`），默认路径 `~/Documents/workspace/my_tools`，可用环境变量 `MY_TOOLS_PATH` 覆盖。**本仓库无需 Python 环境**，脚本会调用 my_tools 的 venv 执行。
- **脚本**：在仓库根目录执行  
  `./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]`  
  section 默认 `tech`，可选 `life`、`music`、`literature`；subsection 可选，如 `reference-news` 时文章落在 `content/tech/reference-news/`（参考资讯子栏）；slug 不填则由页面标题生成。
- **Skill**：Cursor / OpenClaw 可用项目内 skill「url-to-blog-post」（见 `.cursor/skills/url-to-blog-post/` 与 `skills/url-to-blog-post/`），按 skill 说明在对话中让助手执行上述流程。
- **.gitignore**：若在本仓库使用 Python 虚拟环境，已忽略 `venv/`、`.venv/`、`__pycache__/` 等，仅可提交 `requirements.txt`（当前脚本为 shell，无此文件）。

## Obsidian 与博客联动

在 Obsidian 里维护 Markdown、一键发布到本站的用法（图片路径与同步方式）见：[docs/obsidian-blog.md](docs/obsidian-blog.md)。

## 参考

- [Hugo 官方文档](https://gohugo.io/documentation/)
- [PaperMod 主题文档](https://github.com/adityatelange/hugo-PaperMod/wiki)
- [Moonshot AI 文档](https://platform.moonshot.cn/docs)
