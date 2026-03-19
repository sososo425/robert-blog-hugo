---
title: "当 OpenClaw 内置 LanceDB：为个人 AI 智能体打造超强长期记忆"
source: "https://mp.weixin.qq.com/s/Sx52DN9kktgri77z6cj3vg"
author:
  - "[[微信公众平台]]"
published:
created: 2026-03-20
description:
tags:
  - "clippings"
---
*2026年2月9日 14:03*

  

OpenClaw （原名 Clawdbot/Moltbot）是当下超级火爆的（截止目前Github Star数 161K）、开源、可自托管的个人 AI 智能体（Agent）框架。

  

其官方唯一实现的第三方memory plugin就是——LanceDB！

  

本文将为你剖析 OpenClaw 的 LanceDB memory plugin 的实现。

  

OpenClaw的核心定位是让 AI 成为能实际操作用户设备、拥有持久化记忆并能主动发起任务的“数字助手”，而不只是一个聊天机器人。在过去几周持续爆火：

  

![图片](https://mmbiz.qpic.cn/sz_mmbiz_jpg/iabjiaVKD1l88N8r4ia0NUolkZMV7nF2g1hMo8WghRHe37nhLciaEtXnTanv45zs12iaa4XvYJOLFRP8BZ0IfOr9WJQ/640?wx_fmt=jpeg&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=1)

  

  

## 架构和核心组件

  

OpenClaw的架构图：

  

![图片](https://mmbiz.qpic.cn/mmbiz_png/z7E34Sf57egDibA5Yicia3SgMxkYdN5Um5rxsWXHJ41c5rshichkj2ouMCHaeqTicLpF2j5hlXpYW4zObyQ4tkTJ2vfkIwH1DkrCtibTELEyNErzs/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=2)

  

由架构图可以看出 Agent Runner是其中最关键的组件之一。在与 Agent Runner 交互时，高质量的上下文供给是其能否准确理解意图、完成复杂任务的关键。

  

广义上，Agent Runner 的上下文主要来自四个方面：

**1\. 长期知识 (Durable Knowledge)** ：这是 Agent Runner 关于世界、特定领域或用户的持久化事实与偏好，如同其“固定记忆”，例如用户的技术栈偏好或固有的写作风格。

**2\. 任务记忆 (Task Memory)** ：在执行一个长周期、多步骤任务时，Agent Runner 会产生并记录一系列中间产物、决策和观察，这些构成了任务记忆，确保了复杂工作的连续性。

  

**3\. 会话历史 (Conversational History)** ：即与用户的完整对话记录，它不仅包含显式的指令，也蕴含了需要模型理解的隐式意图，是上下文最直接的来源。

**4\. 外部资源 (External Resources)** ：包括代码库、技术文档、API 规范、网页等 Agent Runner 在执行任务时需要动态查阅的外部资料，为其提供超出自身知识范围的信息。

  

这四类上下文通过不同的机制被检索、注入、持久化或更新，共同构成了 Agent Runner 理解和执行任务的基础。下图已包含各类上下文对应的典型目录位置。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

  

在 OpenClaw 项目中，这四类上下文分别通过不同的文件、目录和代码模块进行管理。

  

**1\. 长期知识（Durable Knowledge）**

**目录/文件位置** ：

**\- 工作区** ： `~/.openclaw/workspace` 是核心工作目录。

**\- 精选记忆** ： `MEMORY.md` 文件用于存放精选的长期记忆，仅在私聊时加载。

**\- 每日记忆** ： `memory/YYYY-MM-DD.md` 文件作为每日记忆日志。

**\- 索引** **存储** ： `~/.openclaw/memory/<agentId>.sqlite` 是内置的 SQLite 索引文件。

**\- QMD 备选** ： `~/.openclaw/agents/<agentId>/qmd/…` 用于存放 QMD 后端的索引与配置。

  

2\. 任务记忆（Task Memory）

  

**目录/文件位置** ： `   `

`memory/YYYY-MM-DD[-slug].md` 文件由钩子生成，作为特定任务或会话的快照。

  

**3\. 会话历史（Conversational History）**

**目录/文件位置** ：

\- 状态目录： `~/.openclaw/agents/<agentId>/sessions/`

`- sessions.json` ：存储会话元数据，如 `sessionId` 、token 计数、 `memoryFlush` 状态等。

\- <sessionId>.jsonl：以仅追加（Append-only）的 JSONL 格式记录完整的对话树，包括消息、工具调用和压缩摘要。

**4\. 外部资源（External Resources）**

**配置与** **挂载** ：

\- agents.defaults.memorySearch.extraPaths：此配置项允许递归地索引外部的 Markdown 文件夹，将其纳入记忆搜索范围。

\- memory.qmd.paths：用于声明 QMD 的集合源，使其可以索引任意位置的文档。

  

  

## Memory

接下来，我们将聚焦于memory模块，解读openclaw在该模块的设计。整体上，我们将memory的实现分为两类：

  

1\. File/backend based：基于文件系统上裸存的markdown文件，以及backend充当索引与检索的存储引擎；

  

2\. LanceDB based：基于面向多模的Lance文件格式而构建的轻量级LanceDB数据库一体化实现；

  

  

## File/Backend Based

### 定义

OpenClaw 的 **Memory** 被明确定义为存储在 Agent 工作区（workspace）中的 **纯文本 Markdown 文件** 。

  

这些文件是记忆的“真实之源”（Source of Truth），模型仅通过读写这些文件来“记忆”信息。

  

其内容来源主要有两种：持久化的 Markdown 文件（ `memory` ）和临时的会话历史记录（ `sessions` ）。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

  

**说明：**

`   `

`- memory` 是OpenClaw记忆系统的持久化核心，通过本地Markdown文件长期存储用户偏好、关键信息等；

  

`- session` 是临时会话层，用于保存单次交互的上下文历史，支持即时对话连续性。

  

两者共同构成OpenClaw的记忆数据来源，分别对应长期记忆与短期会话上下文。

memory 不仅仅是原始文本，其在系统中的表示还包含结构化信息。例如，一次搜索结果 `MemorySearchResult` 会包含文件路径、起止行号、相关度分数、文本片段和来源等元数据，这使得 Agent 可以精确地引用和读取记忆内容。

  

### 分层

  

当前实现：分为两层核心的 Markdown 文件结构：

  

1\. 日常日志层: memory/YYYY-MM-DD.md，用于记录每日的、时序性的信息， bersifat append-only。

  

2\. 核心记忆层: `MEMORY.md` ，用于存放经过提炼的、更为稳定和持久的核心事实与偏好。

```perl
~/.openclaw/workspace/  memory.md                    # small: durable facts + preferences (core-ish)  memory/    YYYY-MM-DD.md
```

  

实验性的研究：扩展出 `bank/` 目录，下设 `world.md` （客观事实）、 `experience.md` （Agent 自身经历）、 `opinions.md` （主观判断）以及 `entities/` （实体信息库）等：

```perl
~/.openclaw/workspace/  memory.md                    # small: durable facts + preferences (core-ish)  memory/    YYYY-MM-DD.md              # daily log (append; narrative)  bank/                        # “typed” memory pages (stable, reviewable)    world.md                   # objective facts about the world    experience.md              # what the agent did (first-person)    opinions.md                # subjective prefs/judgments + confidence + evidence pointers    entities/      Peter.md      The-Castle.md      warelay.md      ...
```

  

### Backend

**Backend** 是指负责处理 Memory 文件 **索引** **、查询和管理** 的底层引擎。

  

它的存在是为了解决直接操作大量、分散的 Markdown 文件在检索效率和语义理解上的不足。

  

通过 backend，系统能将非结构化的文本转化为可快速、精确、甚至语义化查询的结构化索引，核心是为了提升“召回”（Recall）能力。

  

OpenClaw 提供了两种 `backend` 实现：

**`   `**

**`1. builtin`** ：内置的默认后端。它使用 **SQLite** 作为索引数据库，结合 `fts5` 扩展实现全文检索（BM25 算法），并能通过 `sqlite-vec` 扩展支持向量搜索。

**`   `**

**`2. qmd`** (实验性)：一个外部的、本地优先的搜索 sidecar 工具。它提供了更高级的混合搜索能力，集成了 BM25、向量搜索和重排序（reranking）。

  

### 索引

核心流程是：文件扫描与变更检测 → 内容分块（Chunking）→ 文本嵌入（Embedding）→ 数据写入 SQLite。

  

它支持对 `memory` 和 `sessions` 两类源进行索引，通过混合使用向量索引（ `sqlite-vec` ）与关键词索引（FTS5）实现语义加关键词的混合检索。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

  

索引类别和存储的核心设计：

**1\. 基础表** ：

  

\- files: 存储已索引文件的元数据，如路径、哈希值、修改时间等。

\- chunks: 存储文本分块（chunk）的核心信息，包括分块文本内容、来源文件路径、起止行号，以及最重要的 **嵌入** **向量** （以 JSON 字符串形式存储）。

  

**2\. 关键词** **索引** ：

  

\- chunks\_fts：这是一个基于 `chunks` 表创建的 FTS5 (Full-Text Search) 虚拟表，专门用于高效的关键词检索和 BM25 排序。

**3\. 向量** **索引** ：

  

`- chunks_vec` ：这是一个基于 `sqlite-vec` 扩展创建的虚拟表，存储分块的 ID 和其对应的向量数据（通常为 `FLOAT[dims]` 类型），用于快速计算向量间的距离（如余弦相似度）。

  

**4\. 辅助表** ：

  

`- embedding_cache` ：用于缓存文本哈希到嵌入向量的映射，避免对相同内容重复进行嵌入计算。

`- meta` ：存储索引的元信息，如创建索引时使用的模型、分块参数等，用于判断是否需要全量重建。

  

  

## LanceDB Based

LanceDB memory 是一条完全独立的链路：它取代了文件系统存memory原始文件 + backend 这套体系。形成了一套完全独立的实现（自己存储文本内容以及embedding，并提供索引、检索能力）。

  

基于LanceDB实现的memory是以Plugin挂载并让Agent、CLI来识别的。接下来我们先介绍一下什么是plugin。

  

### Plugin

Plugin的作用：决定是否、以及以什么形态把这种查询能力暴露给 agent 和 CLI。

  

目前，提供两个plugin（memory plugin是排他的，当前只能选择一个）：

  

**1\. memory-core：** 是系统内置的基础内存插件。它本身不包含复杂的存储和 embedding 逻辑，而是作为 openclaw 核心内存管理框架的入口，负责将其能力（如基于 SQLite 的搜索）暴露为标准的 Agent 工具和 CLI 命令。

**2\. memory-lancedb：** 是一个 可选的、功能完备的第三方长时记忆解决方案。它自带了独立的存储（ **LanceDB** ）、独立的 embedding 能力（OpenAI API）和一套更高级的记忆操作工具（ `memory_recall`, `memory_store`, `memory_forget` ）。

  

它通过钩子实现了记忆的自动捕获（auto-capture）和自动召回（auto-recall），提供了一种“开箱即用”的智能记忆体验。

  

### LanceDB plugin

其核心思想是将非结构化的文本信息，转换为高维度的向量，并利用向量间的距离来衡量信息的相似度。整个系统的数据流清晰而高效，涵盖了从信息输入、处理、存储到最终利用的全过程。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

  

Memory 插件的定义包含如下要素：

  

1\. Tool：

- memory\_recall：search
	- memory\_store：save
	- memory\_forget：delete

2\. CLI commands：

- list
	- search
	- stats

  

3\. Lifecycle Hooks：

- before\_agent\_start：如果开启自动回忆（autoRecall），在每次对话前自动检索相关记忆，注入到 prompt 上下文；
	- agent\_end：如果开启自动抽取（autoCapture），会在对话结束后自动从消息中抽取“值得记住”的句子并写入 LanceDB；

  

4\. Service：

- start/stop

  

该插件的逻辑主要集中在几个关键文件中，各司其职：

  

`openclaw/extensions/memory-lancedb/` `index.ts`: **插件主入口** 。定义了整个插件的生命周期、工具、CLI 命令和服务。所有核心逻辑的编排都在这里完成。

  
`config.ts`: **配置模型与解析** 。定义了插件所需的配置项（如 OpenAI API Key、数据库路径等）的数据结构、默认值和解析逻辑。

  
`openclaw.plugin.json`: **插件** **元数据** 。向 OpenClaw 核心系统声明插件的 ID、类型、配置 Schema 以及在 UI 上的显示提示（ `uiHints` ），使得插件可以被正确加载和配置。

  
`index.test.ts`: **单元与端到端测试** 。确保插件的各个功能模块（配置解析、工具执行、钩子逻辑等）按预期工作。

  

**LanceDB** **`memories`** **表结构**

所有捕获的记忆最终都存储在 LanceDB 的 `memories` 表中。该表结构为向量化检索和元数据过滤提供了基础。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

**记忆类别（MemoryCategory）**

`MemoryCategory` 是一个预定义的枚举类型，用于对捕获的记忆进行分类。分类主要依赖于对文本内容的启发式规则匹配，也可以在调用 `memory_store` 工具时手动指定。

  

![图片](data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E)

  

  

## Memory跟其他组件的交互

**1\. Agent 工具 (Tools)** ：Agent 在执行任务时，可以主动调用 `memory_search` 和 `memory_get` 工具来查询和读取记忆库。这是最直接的使用方式。

**2\. CLI** **命令行** ：用户可以通过 `openclaw memory` 系列命令手动管理内存，包括查看状态 (`status`)、触发索引 (`index`) 和执行搜索 (`search`)。

**3\. 自动同步/** **索引** **(Auto Sync/Indexing)** ：系统通过文件监视（ `watch` ）和定时任务（ `interval` ）自动检测 Memory 文件的变更，并异步更新索引，确保记忆库的时效性。

**4\. 自动内存刷新 (Auto Memory Flush)** ：在会话历史过长、即将被压缩（compaction）前，系统会自动触发一个静默的 Agent turn，提示模型将当前重要的上下文信息存入 Memory 文件，以防止关键信息因压缩而丢失。

**5\. 钩子 (Hooks)** ：通过 `session-memory` 钩子，在 `/new` 命令执行时，系统会自动将上一个会话的摘要存档到 `memory/` 目录中，实现会话的自动归档

  

  

## 总结

OpenClaw 的 `memory-lancedb` 插件为我们展示了一个优雅而实用的长时记忆系统设计。

  

它不仅提供了强大的基础能力——将文本转化为可检索的向量记忆，更通过巧妙的生命周期钩子设计，实现了记忆的“自动驾驶”，极大地提升了智能体的实用性和用户体验。

  

我们相信 OpenClaw 在众多 memory 库的实现中选择了LanceDB，源于 LanceDB 的一些非常优秀的特性：

  

1\. 本地优先（Local-First）：LanceDB作为一个极其轻量的嵌入式数据库，无服务，安装即可用；

  

2\. 多模态存储：支持各种类型（图片、文档、音视频）知识的存储；

  

3\. 多类别索引与混合检索：支持标量、向量、全文索引以及多索引混合检索；

  

在 Agent 时代，存在海量非结构化的知识需要存储、加工、检索，构建版本管理用于回溯与分析。既可以轻量级本地开发，又可以on cloud无限横向扩展！

  

而 LanceDB/Lance 无疑是非常优秀的选择。另外，大家也可以关注一下，围绕Lance构建的两个生态项目：

  

1\. lance-graph：Lance Graph 是一个支持 Cypher 的图查询引擎，它采用 Rust 语言构建，并配有 Python 绑定，用于构建高性能、可扩展且无服务器的多模态知识图谱；

https://github.com/lance-format/lance-graph

  

2\. lance-context：基于Lance构建的用于智能体工作流的多模态、带版本的上下文存储。

https://github.com/lance-format/lance-context

点击阅读原文，跳转LanceDB GitHub

阅读原文

继续滑动看下一个

字节跳动技术团队

向上滑动看下一个

解释