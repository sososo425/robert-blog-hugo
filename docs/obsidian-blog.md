# Obsidian 与博客联动

在 Obsidian 里维护 Markdown，同时能一键发布到本站。有两种推荐用法，可按习惯选一种。

---

## 方案一：Vault 为主，同步到博客（适合现有 Vault 不动）

内容继续放在 **Obsidian Vault**（如 `技术文章/大模型记忆工程的架构设计与实践.md` + 同目录下 `images/`），用脚本把指定笔记同步到博客仓库并自动处理图片路径。

### 1. 在 Vault 里的约定

- **文章**：任意文件夹下 `.md`（如 `技术文章/大模型记忆工程的架构设计与实践.md`）。
- **图片**：与文章同目录的 `images/` 下，或与文章同目录；引用用 `![](./images/1.jpg)` 或 `![[1.jpg]]` 均可。
- **可选 frontmatter**：在 Obsidian 的 frontmatter 里可写：
  - `blog_slug: llm-memory-engineering-memos` — 同步到博客后的 URL 段和文件名（不写则用当前文件名）。
  - `slug` 同上。
  - 其他如 `title`、`date`、`tags` 会一并同步，缺的会用默认值。

### 2. 同步命令（在博客仓库根目录执行）

```bash
# 同步单篇（第 4 个参数为 section，不写则按 Vault 父文件夹映射：技术文章→tech）
python scripts/sync_obsidian_to_blog.py "/Users/liangbinbin/Documents/Obsidian Vault" . "技术文章/大模型记忆工程的架构设计与实践.md" tech

# 同步整个文件夹下的所有 .md
python scripts/sync_obsidian_to_blog.py "/Users/liangbinbin/Documents/Obsidian Vault" . "技术文章" tech
```

脚本会：

- 把该 .md 写到 `content/<section>/<slug>.md`（slug 来自 frontmatter 的 `blog_slug`/`slug` 或文件名）。
- 把文内引用的图片复制到 `static/images/<slug>/`，并把引用改成 `![](/images/<slug>/xxx)`。
- 补全/合并 frontmatter（title、date、categories、tags 等）。

### 3. 一键发布

同步后在本仓库执行：

```bash
git add content/ static/images/
git commit -m "publish: 从 Obsidian 同步"
git push origin main
```

可把「同步 + add + commit + push」写成一条 shell 或 Alias，实现一键发布。

### 4. 文件夹 → section 映射

| Vault 内文件夹 | 博客 section |
|----------------|--------------|
| 技术文章、技术调研 | tech |
| 人生 | life |
| 音乐 | music |
| 文学 | literature |

可在 `scripts/sync_obsidian_to_blog.py` 里改 `SECTION_MAP` 调整。

---

## 方案二：博客仓库即编辑源（单源，无需同步）

把 **博客仓库** 当作 Obsidian 的库（或额外 Vault）打开，直接在 `content/` 下用 Obsidian 编辑，图片路径与 Hugo 一致，发布即 `git push`。

### 1. 在 Obsidian 里添加博客仓库

- 设置 → 核心插件 → 允许多个库（或「另一个库」），添加库，选择博客仓库根目录（如 `robert-blog-hugo`）。

### 2. 让 Obsidian 能正确解析 `/images/` 链接

博客里图片在 `static/images/<slug>/`，文中写的是 `![](/images/<slug>/1.jpg)`。Hugo 发布时会把 `static/` 映射到站点的根路径，所以 `/images/` 即 `static/images/`。

Obsidian 里「绝对路径」是相对当前库根目录的，所以需要让「库根下的 `images`」指向实际图片目录，有两种方式：

**方式 A：在仓库根建符号链接（推荐）**

在博客仓库根目录执行一次：

```bash
ln -s static/images images
```

这样库根下会有 `images` → `static/images`，Obsidian 中 `![](/images/xxx/1.jpg)` 会正确找到 `static/images/xxx/1.jpg`。  
若不想把该链接提交到 Git，可把 `images` 加入 `.gitignore`。

**方式 B：文中用相对路径**

在 `content/tech/xxx.md` 里写 `![](../../static/images/xxx/1.jpg)`，Obsidian 能解析，Hugo 也能用，但路径较长且易错，一般不如方式 A。

### 3. 发布

在 Obsidian 里改完保存后，在终端进博客仓库执行：

```bash
git add .
git commit -m "更新文章"
git push origin main
```

即为一键发布（也可用 Obsidian 的 Git 插件或外部快捷方式执行上述命令）。

---

## 对比小结

| 项目         | 方案一（Vault 为主 + 同步）     | 方案二（博客即库）           |
|--------------|----------------------------------|------------------------------|
| 内容所在     | Obsidian Vault                   | 博客仓库 `content/`          |
| 图片引用     | Vault 内随意，由脚本统一改写     | 统一用 `/images/<slug>/xxx`   |
| 发布方式     | 运行同步脚本 → git push          | 直接 git push                |
| 适用场景     | 已有大量笔记在 Vault，不想搬库   | 愿意在「博客库」里写/改文章   |

两种方式可以并存：部分文章在 Vault 里写、用方案一同步；部分在博客库里写、用方案二发布。
