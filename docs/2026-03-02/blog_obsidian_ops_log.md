### 一、本次会话里做过的主要事情

- **URL → Hugo 文章自动化链路完善**
  - 在 `my_tools` 里重构并增强：
    - `url_to_markdown.py`  
      - 修复微信文章 Markdown 格式问题：  
        - 处理 `- • xxx`、`• xxx` 变成标准列表。  
        - 优化“自动提升为小节标题”的规则，避免把完整句子误变 `##`。  
        - 抓正文主标题（优先 `activity-name` / 正文第一个 h1/h2），作为文件名基础。
    - `url_to_hugo_post.py`  
      - 新增 slug 生成逻辑：  
        - 优先使用你传入的 `slug` 参数；  
        - 否则根据中文标题自动生成英文 kebab-case slug（仅字母数字连字符，避免中文与空格路径问题）。  
      - 使用该 slug 统一驱动：  
        - Hugo 文章文件名：`<section>/<subsection>/<slug>.md`  
        - 图片目录：`static/images/<slug>/...`  
        - frontmatter `url: "/<section>/<slug>/"`  
        - 自动更新的 `_index.md` / `index_obsidian.md` 链接。  
      - 生成正文时：  
        - 把 `images/xxx` 统一替换为 `images/<slug>/xxx`（配合 Hugo render hook + Obsidian）。

- **技能 / 脚本联动**
  - 博客仓库新增脚本：`scripts/url_to_blog_post.sh`  
    - 作用：在博客工程内一键调用 `my_tools/url_to_hugo_post.py`。  
    - 自动解析 `MY_TOOLS_PATH` 或使用默认 `~/Documents/workspace/my_tools`，优先使用 `my_tools` 的虚拟环境 Python。  
  - Cursor/OpenClaw 的 Skill：
    - `.cursor/skills/url-to-blog-post/SKILL.md` 与 `skills/url-to-blog-post/SKILL.md` 已配置成调用 `scripts/url_to_blog_post.sh`。  
    - 支持参数：  
      - `url`（必填）  
      - `section`（可选，默认 `tech`）  
      - `subsection`（可选，如 `ai-agents` / `bigdata-storage` / `reference-news`）  
      - `slug`（可选，如不填则自动从标题生成英文 slug）。

- **tech 栏目结构调整 & 索引自动维护**
  - 物理目录改造：
    - `content/tech/ai-agents/`：  
      - `openclaw-clawdbot-architecture.md`  
      - `agent-design-patterns.md`  
      - `llm-memory-engineering-memos.md`  
      - `agent-infra-memory.md`  
      - `memgpt-letta-guide.md`  
      - `memgpt-paper-translation.md`
    - `content/tech/bigdata-storage/`：  
      - `autonomous-driving-big-data.md`  
      - `multimodal-data-lake.md`  
      - `storage-fusion-analysis.md`
    - `content/tech/reference-news/`：  
      - `2026-ai-data-industry.md`  
      - `ai-agents-mit-report.md`（本次新增的参考资讯文）。  
  - `content/tech/_index.md`：  
    - 仍然是 Hugo 用的目录页，URL 保持 `/tech/<slug>/` 不变。  
    - `url_to_hugo_post.py` 在 section=tech 时，会自动按 subsection 把新文章插入对应小节列表。
  - 新增 Obsidian 导航：`content/tech/index_obsidian.md`  
    - 用 wikilink 维护 tech 目录的文章导航：  
      - `[[ai-agents/...|标题]]` / `[[bigdata-storage/...|标题]]` / `[[reference-news/...|标题]]`。  
    - 由 `url_to_hugo_post.py` 在 section=tech 时自动追加对应链接。

- **Obsidian 与 Hugo 的图片路径统一**
  - 目录与路径约定：
    - 物理图片：`static/images/<slug>/*.jpg`。  
    - Markdown 中统一写：`![](images/<slug>/1.jpg)`（相对路径）。  
  - 在博客根创建软链接：`images -> static/images`  
    - 让 Obsidian 在 vault=博客根时，可以直接解析 `images/...`。  
  - Hugo 渲染钩子：`layouts/_default/_markup/render-image.html`
    - 自动把 `images/...`、`./images/...` 渲染为站点路径 `/images/...`，保证线上访问正确。  

- **Obsidian 环境与忽略配置**
  - `.gitignore` 更新：
    - 忽略本地 Obsidian 索引：`*_obsidian.md`。  
    - 忽略工作空间配置：`.obsidian/`、`content/.obsidian/`。  
  - `_index.md` 在 Obsidian 中的处理：
    - 通过 Obsidian 设置里的“忽略文件”将 `_index.md` 排除出搜索/自动补全等；  
    - 浏览使用 `index_obsidian.md` 作为导航，避免误点 `_index.md`。

- **参考资讯新文章全流程打通**
  - 以 `https://mp.weixin.qq.com/s/ELL82iAQSkLhOTMQ_lj46A` 为例：
    - 使用 skill / 脚本命令：  
      ```bash
      ./scripts/url_to_blog_post.sh "https://mp.weixin.qq.com/s/ELL82iAQSkLhOTMQ_lj46A" tech reference-news
      # 或在 skill 里传 section=tech, subsection=reference-news
      ```
    - 工具链会自动完成：
      1. 抓取正文与图片 → 生成中间 markdown。  
      2. 从正文标题产生英文 slug（这篇最终是 `ai-agents-mit-report`）。  
      3. 写 Hugo 文章：`content/tech/reference-news/ai-agents-mit-report.md`，frontmatter 带 `url: "/tech/ai-agents-mit-report/"`。  
      4. 图片保存到 `static/images/ai-agents-mit-report/`。  
      5. 正文里的所有图片改为 `images/ai-agents-mit-report/*.jpg`。  
      6. 自动在：  
         - `content/tech/_index.md` 的「参考资讯」下追加：  
           `- [恐慌的核心逻辑只有一句话：**Agent 不是 SaaS 的用户，Agent 是 SaaS 的替代者。**](/tech/ai-agents-mit-report/)`  
         - `content/tech/index_obsidian.md` 追加：  
           `- [[reference-news/ai-agents-mit-report|恐慌的核心逻辑只有一句话：**Agent 不是 SaaS 的用户，Agent 是 SaaS 的替代者。**]]`。  

- **Git 与部署**
  - 把上述所有结构调整、新文章、图片、`.gitignore` 更新等，整理为一次提交：  
    - 提交信息：`feat: tech 分栏与引用资讯自动化`  
  - 推送到 GitHub `main`，Vercel 继续自动部署；你已确认线上与本地 Obsidian 预览都正常。

---

### 最终使用方式小抄

- **从 URL 一键生成博客文章（含图片、索引、Obsidian 导航）**  
  1. 在博客仓库根执行：  
     ```bash
     ./scripts/url_to_blog_post.sh "<URL>" [section] [subsection] [slug]
     ```
     - 常用：
       - `section=tech`
       - `subsection` 可选：`ai-agents` / `bigdata-storage` / `reference-news`
       - `slug` 可省略，让脚本自动从标题生成英文 slug；需要特定 URL 时可以手动指定，如 `ai-agents-memgpt-os`。  
  2. 脚本会自动：
     - 放文章到正确目录；  
     - 复制图片到 `static/images/<slug>/`；  
     - 修正文中图片路径；  
     - 更新 `tech/_index.md` 与 `tech/index_obsidian.md`。  

- **在 Obsidian 中日常写作 / 浏览**
  - 打开 vault：`robert-blog-hugo`；  
  - 使用：
    - `content/tech/index_obsidian.md` 作为 tech 导航；  
    - 每篇文章内部使用 `images/<slug>/xxx.jpg` 引用图片；  
  - `_index.md` 文件在 Obsidian 的搜索和自动补全中会被忽略，主要由 Hugo 使用。