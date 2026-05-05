---
title: AMS 技术方案大纲 & 团队分工
date: 2026-03-27
tags:
  - AMS
  - 技术方案
  - 团队分工
  - Agent记忆
status: 草稿
---

> [!info] 文档说明
> 本文档基于 AMS（Agent Memory System）架构图，梳理核心技术模块、工作细节及 团队的分工建议。
> 主要目标：实现**Tree + Graph 双层结构**的长期记忆（过程记忆、语义记忆、情景记忆）的**转化、存储与检索**。
>         注： 实现  **Working Memory 管理（模块 X，待确认）**

---

## 一、项目背景与目标
![[Pasted image 20260325111351.png]]
![[Pasted image 20260329172202.png]]
### 1.1 背景

- AMS 团队的核心职责是为 Agent 提供**完整记忆能力**（Working Memory + Long-term Memory），**Agent Framework** 由北美团队负责。
- 与 Agent Framework 团队的接口：
  1. 通过 **Agent-TES**（Sidecar-based telemetry）获取 Agent 行为数据（会话轮次、工具调用链、推理链等）
  2. 通过 **Redis** 管理 Working Memory（短期活跃上下文，**模块 X，归属待确认**），结合 **Compact** 机制压缩上下文信息
  3. 组合 Working Memory（模块 X）会话数据与长期记忆检索结果，生成完整 Prompt（❶）
  4. 对外提供**记忆检索服务**（Retrieval API），供 Agent 访问长期记忆
- 【注】AMS **优先侧重长期记忆**，Working Memory 归属(2&3)暂定（需要与Agent Framework 团队沟通确定）
### 1.2 核心目标

| 目标               | 说明                                          |
| ---------------- | ------------------------------------------- |
| **Working Memory** | 管理短期活跃上下文（Redis），支持上下文压缩（Compact）与 Prompt 组装 |
| **记忆转化**         | 将 Agent 行为数据、知识文档、代码等转化为结构化记忆（Tree + Graph） |
| **记忆存储**         | 持久化存储多类型记忆，支持向量/全文/图谱多路索引                   |
| **记忆检索**         | 提供轻量级与 Agentic 两种检索模式，支持多路融合与重排序            |
| **记忆管理**         | 支持时序失效、遗忘机制、记忆更新与合并                         |
| **RAG 底座**       | 构建高质量 RAG 基础能力，作为所有检索的底层支撑                  |

### 1.3 记忆类型定义

```
Working Memory（短期）
└── 活跃上下文（Active Context）    → 当前会话状态、Redis KV、Compact 压缩

长期记忆（Long-term Memory）
├── 过程记忆（Procedural Memory）   → 技能、工作流、经验（skill.md、SOP）
│   └── Graph 全三层构建（full three-layer）
├── 语义记忆（Semantic Memory）     → 知识、概念、事实（文档、代码、KG triples）
│   └── Graph+Tree 双层构建（double-layer for multi-hop retrieval）
└── 情景记忆（Episodic Memory）     → 事件、对话、时序上下文（Agent 行为轨迹）
    └── Temporal KG（timeline + facts + insights）
```

---

## 二、整体架构模块划分

架构由以下七大模块组成，各模块相对独立、可并行设计&开发：

```
┌──────────────────────────────────────────────────────────────────┐
│                       AMS 整体架构                                │
│                                                                    │
│  模块 X  Working Memory 层   → Redis + Compact（上下文管理&压缩） │
│  模块 A  数据采集 & ETL 层   → Agent-TES / 知识库 / External Zone  │
│  ─────  共享推理引擎         → Ray + SGLang + Bert/LLM/VLM        │
│  模块 B  记忆构建 — Tree     → Tree Builder（层次化结构）          │
│  模块 C  记忆构建 — Graph    → Graph Builder（知识图谱）           │
│  模块 D  存储抽象层（公共层） → Storage Abstraction Layer           │
│  ─────  存储引擎            → Milvus / Neo4j / LanceDB            │
│  模块 E  检索服务层          → Retrieval API（轻量+Agentic）       │
└──────────────────────────────────────────────────────────────────┘
```

**架构中的四条核心数据流（对应架构图标注）：**

| 标注 | 数据流 | 说明 |
|------|--------|------|
| ❶ | Working Memory + Long-term Retrieval → Prompt | 组合当前会话上下文与长期记忆检索结果，生成完整 Prompt |
| ❷ | Working Memory → Compact | 压缩 Working Memory 上下文信息 |
| ❸ | Session/Traces → Streaming Pipeline → 长期记忆 | 准实时归并对话会话和 Agent 执行轨迹到长期记忆（目标延迟 < 30s）|
| ❹ | 文档/代码 → Batch Pipeline → 知识库 | LLM 驱动的文档和代码语义分析，生成结构化知识 |

**端到端 Pipeline 三阶段分解：**

```
┌── Stage 1: 数据采集（模块 A）──────────────────────────────────┐
│  Data Source → Parse → Chunk → Raw Block                       │
│  ┌─────────────┐   ┌────────────┐   ┌────────┐   ┌─────────┐  │
│  │ Agent-TES   │──→│ Doc Parser │──→│Chunker │──→│Raw Block│  │
│  │ 知识库/OSS  │   │ PDF/MD/Code│   │Semantic│   │ ·text   │  │
│  │ External    │   │ VLM(img)   │   │AST     │   │ ·embed  │  │
│  │ Zone        │   │ SGLang     │   │Fixed   │   │ ·meta   │  │
│  └─────────────┘   └────────────┘   └────────┘   └─────────┘  │
└─────────────────────────┬──────────────────────────────────────┘
                          │ Raw Block（JSON Schema）
                ┌─────────┴─────────┐
                ▼                   ▼
┌── Stage 2: Tree Builder ──┐ ┌── Stage 3: Graph Builder ──────┐
│  （模块 B）                │ │  （模块 C）                     │
│  Raw Block → Tree Memory  │ │  Raw Block → Graph Memory      │
│  ·自动分层（标题/语义）     │ │  ·NER + RE → 实体链接消歧      │
│  ·Section 摘要聚合         │ │  ·社区发现 + 社区摘要           │
│  ·Topic/Outline/Insight   │ │  ·Temporal KG + 遗忘机制        │
└────────────┬──────────────┘ └──────────────┬──────────────────┘
             └──────────┬───────────────────┘
                        ▼
         ┌── Storage Abstraction Layer ──┐
         │  （模块 D，公共层）             │
         │  Milvus │ Neo4j │ LanceDB     │
         └──────────────────────────────┘
```

---

## 三、核心模块技术方案详解

### 模块 A：数据采集 & ETL 流水线

> **负责把原始数据转化为可处理的 Raw Block**

#### A1. 数据源接入

| 数据源 | 采集方式 | 数据类型 | Pipeline |
|--------|---------|---------|----------|
| Agent 行为数据 | Agent-TES（Sidecar telemetry）→ Kafka | 会话轮次、工具调用、推理链 | Streaming |
| Working Memory 溢出 | Redis → flat KV → Raw Block | 活跃上下文快照 | Streaming |
| 企业知识文档 | 离线批量导入 / 增量同步 | PDF、Markdown、Wiki | Batch |
| 源代码 | Git Hook / 定期同步 | Python、Java 等代码文件 | Batch |
| 技能文件 | 人工维护 + 自动更新 | skill.md | Batch |
| External Zone | 用户上传 / URL Fetch | 外部文档、网页内容 | Batch |

**关键工作：**
- [ ] Agent-TES 数据订阅与格式化（Sidecar → Kafka）
- [ ] Kafka Topic 设计（streaming vs batch 分流）
- [ ] External Zone 接入（用户上传 + URL 抓取 → OSS / 知识库）
- [ ] 数据去重、清洗、格式归一化

#### A2. ETL 处理 Pipeline（基于 Ray + SGLang）

**共享推理引擎：** Bert / LLM / VLM，通过 Ray + SGLang 统一调度，同时为 Streaming 和 Batch Pipeline 提供推理能力。

**Agentic Streaming Pipeline（实时，对应❸）：**
```
Kafka(session/traces) → Ray Streaming → 文本切分 → Embedding →
  ├── 准实时归并到长期记忆（Tree/Graph 增量更新，延迟目标 < 30s）
  └── 写入 Storage Abstraction Layer
```

**Agentic Batch Pipeline（批量，对应❹）：**
```
OSS/知识库 → Ray Batch → 文档解析(PDF/Code/MD) → 分块 →
  ├── Bert/LLM 摘要提取
  ├── LLM 三元组抽取（triples）
  ├── VLM 图片/表格理解
  └── Tree/Graph 构建 → 写入 Storage Abstraction Layer
```

**关键工作：**
- [ ] Ray 集群部署 / fuyao 对接，相关调优
- [ ] SGLang 推理引擎集成与性能优化
- [ ] 文档解析：PDF 解析（表格、图片）、代码结构解析
- [ ] Chunking 策略选型（semantic chunking vs fixed-size vs AST-based）
- [ ] 摘要生成模型选型（本地 vs API）
- [ ] 三元组抽取实验（NER + RE vs LLM prompt）
- [ ] VLM 集成（图片 OCR、表格理解）

#### 业界前沿映射

| AMS 设计 | 业界对应方案 | 评价 |
|---------|------------|------|
| Semantic / AST-based Chunking | LlamaIndex Semantic Splitter、LangChain RecursiveCharacterSplitter | ✅ 正确方向，AST-based 对代码是最优解 |
| VLM 图片/表格理解 | Unstructured.io、GPT-4V multimodal pipeline | ✅ 对齐 Multimodal RAG 前沿，工程复杂度较高 |
| LLM 三元组抽取 | OpenIE、REBEL、Microsoft GraphRAG entity extraction | ✅ 标准做法，抽取质量是整个 Graph 的命门 |
| Online + Offline 双 Pipeline | 主流生产 RAG 系统标配设计 | ✅ 工程成熟，必要设计 |

> [!warning] 注意盲点
> 缺少 **Document-level Deduplication** 设计：同一知识在不同来源重复时的合并策略，知识库规模增大后会成为显性问题。

---

### 模块 B：记忆构建 — Tree 结构

> **将文档/代码/技能构建为层次化 Tree 结构，支持树形检索**

#### B1. Tree 逻辑模型

```
Document Root
└── Section Level 2（主题摘要 + metadata + refer sections）
    └── Section Level 1（section name + summary + metadata + refer blocks）
        ├── Block 1: text   [prev ← → next]  Session/DocID
        ├── Block 2: code   [prev ← → next]
        ├── Block 3: img    [prev ← → next]
        └── Block 4: table  [prev ← → next]  Session/DocID
```

每个 **Block** 包含字段：
- `text`（原始内容）
- `source_type`（text/code/img/table）
- `block_name`、`metadata`
- `summary`（LLM 生成摘要）
- `triples`（三元组，用于 Graph 联动）
- `belonging_sections`（所属层级路径）
- `prev/next`（双向链表，支持上下文扩展）
- `session_id / doc_id`

**关键工作：**
- [ ] Tree 数据结构设计与 Schema 定义
- [ ] 自动分层算法：基于标题层级 / 语义聚类
- [ ] Block 类型识别与分类（代码/图片/表格/文本）
- [ ] Block 摘要与 Triples 生成
- [ ] Tree 增量更新机制（文档修改时的局部重建）
- [ ] Section 摘要层级聚合（bottom-up summary propagation）

**Triples 传输机制（Group 2 → Group 3）：**
```
Group 2 (Tree Builder)
    ↓ 写入
Milvus ams_blocks collection (triples 字段)
    ↓ Storage SDK 订阅变更 / 定时批量同步
Group 3 (Graph Builder) 消费并构建图谱
```
- Triples 随 Block 数据写入 Milvus，通过 Storage SDK 提供变更订阅接口
- Group 3 可选择**实时订阅**（低延迟，高资源消耗）或**批量同步**（分钟级延迟，资源友好）
- Phase 1 建议采用批量同步，Phase 2 视性能需求引入实时订阅

#### B2. Tree 索引策略

| 索引类型 | 存储位置 | 用途 |
|----------|----------|------|
| Topic/Outline/Insight | 独立向量集合 | 高层语义导航 |
| Vector Cluster（仅文档） | Milvus | 文档级粗筛 |
| Block/Section/Summary 向量 | Milvus | 精细检索 |
| 全文倒排索引 | LanceDB / Milvus | BM25 关键词检索 |
| BTree 索引 | LanceDB | 元数据过滤 |

#### 业界前沿映射：RAPTOR（Stanford, 2024）

> [!note] 职责边界说明
> Tree 构建模块（模块 B）**只负责数据构建与写入**，不提供查询接口。
>
> 具体边界划分：
> - **模块 B（Tree Builder）**：构建 Tree 结构 → 写入 Milvus → 对外输出 Schema 定义
> - **模块 D（Storage SDK）**：提供基础存储访问能力（向量搜索、元数据过滤）
> - **模块 E（Retrieval Service）**：实现业务层 Tree 检索策略（层级导航、上下文扩展、RRF融合）
>
> Tree 检索的逻辑（如先查 Section 再查 Block、利用 prev/next 扩展上下文）由检索服务层实现，而非 Tree Builder 层。

AMS Tree 结构与 RAPTOR（Recursive Abstractive Processing for Tree-Organized Retrieval）高度对齐，并在工程上做了多处超越：

| 维度 | RAPTOR | AMS Tree |
|------|--------|----------|
| 层级构建 | 语义聚类，自底向上递归 | 标题层级 + 语义聚类双模式 |
| 节点类型 | 纯文本 chunk | text / code / img / table 多类型 Block ✅ |
| 上下文扩展 | 无 | prev/next 双向链表 ✅ |
| 索引粒度 | 层级摘要向量 | Topic / Outline / Insight 三层独立索引 ✅ |
| 增量更新 | 无 | 局部子树重建机制 ✅ |

> [!tip] 注意
> RAPTOR 的层级聚类是纯语义驱动的，对无结构文档（如会话记录）效果更好。AMS 在依赖标题层级分层时，需要为无结构文档（对话、日志等）准备 fallback 策略（降级为语义聚类模式）。

---

### 模块 C：记忆构建 — Graph 结构

> **构建知识图谱，支持多跳推理与关联检索**

#### C1. Graph 逻辑模型

**节点类型：**
- `Phrase Node`：实体/概念节点
- `Community Node`：社区摘要节点（节点聚类后的高层抽象）

**边类型：**

| 边类型 | 说明 |
|--------|------|
| `Relation Edge` | 实体间语义关系（来自三元组） |
| `Synonym Edge` | 同义词/别名关系 |
| `Temporal Edge` | 时序关系（事件先后、版本迭代） |
| `Context Edge` | 同文档/同会话共现关系（带 importance score） |
| `Belongs_to Edge` | 节点归属社区 |

**Temporal KG：**
- 支持时序事件（episode/events timeline）
- 支持事实/画像（facts/profiles）
- 支持前瞻/洞察/元认知（foresight/insights/metacognitions）
- 写入 Agent-DOM → skill.md（过程记忆闭环）

#### C2. Graph 构建流程

```
Raw Blocks（triples字段）
    ↓
实体识别（NER）→ 关系抽取（RE）
    ↓
节点/边 归一化（实体链接、消歧）
    ↓
社区发现（Community Detection，e.g. Louvain）
    ↓
社区摘要生成（LLM）
    ↓
写入 Neo4j
```

**关键工作：**
- [ ] 实体抽取与链接（Entity Linking）方案选型
- [ ] 关系抽取方案：规则 vs 模型 vs LLM
- [ ] 实体消歧与合并策略
- [ ] 社区发现算法选型与调参（Louvain / Leiden）
- [ ] 图谱增量更新机制
- [ ] Temporal KG 设计（时间戳、有效期、衰减）
- [ ] 遗忘机制（temporal invalidation + temporal decay）

#### C3. Graph 索引策略

| 索引 | 存储 | 用途 |
|------|------|------|
| Node/Edge 向量 | Milvus | 语义相似实体检索 |
| 全文倒排 | Neo4j Full-text / Milvus | 关键词匹配 |
| Graph 结构索引 | Neo4j | 图遍历、PPR |
| 社区摘要向量 | Milvus | 粗粒度主题检索 |

#### 业界前沿映射

**① 社区发现 + 社区摘要 → Microsoft GraphRAG（2024）**

GraphRAG 是目前最具影响力的图谱增强 RAG 方案，AMS Graph 与其核心流程高度对齐，并在边类型和时序能力上做了扩展：

| 维度 | Microsoft GraphRAG | AMS Graph |
|------|-------------------|-----------|
| 实体 / 关系抽取 | LLM prompt-based | NER + RE + LLM 三元组 |
| 社区发现算法 | Leiden | Louvain / Leiden（待选型）|
| 社区摘要 | LLM 生成 | LLM 生成 ✅ |
| 检索策略 | Local Search / Global Search | PPR + 向量 + 全文多路融合 |
| 边类型丰富度 | 仅 Relation Edge | + Temporal / Synonym / Context Edge ✅ |
| 时序支持 | 无 | Temporal KG（有效期 + 衰减）✅ |

**② PPR 检索 → HippoRAG（2024）**

HippoRAG 受人类海马体记忆机制启发，核心思路：Query → 实体识别 → 图中种子节点 → PPR 扩散 → 返回相关节点，在多跳问答任务上显著优于传统 RAG。AMS 的 `Graph 检索 / PPR`（Neo4j + Personalized PageRank）与其机制高度一致。

**③ Temporal KG → Zep（2024）**

| 维度 | Zep | AMS Temporal KG |
|------|-----|----------------|
| 时间戳与有效期 | ✅ | ✅ |
| 事实衰减机制 | ✅ | ✅（temporal decay）|
| episodic → semantic 记忆转化 | ✅ | ✅ |
| 过程记忆（skill.md 闭环）| ❌ | ✅ 额外扩展 |

> [!tip] 整体评价
> Graph 模块是 AMS 中与业界前沿对齐最深的部分，在 GraphRAG 基础上融合了 HippoRAG 的 PPR 检索和 Zep 的 Temporal KG，具备明显的技术领先性。**核心风险在于实体消歧（Entity Linking）的工程难度**——这是整个 Graph 质量的天花板，需在 Phase 1 结束前完成方案选型并验证可行性。

> [!note] 职责边界说明
> Graph 构建模块（模块 C）**只负责知识图谱构建与写入**，不提供查询接口。
>
> 具体边界划分：
> - **模块 C（Graph Builder）**：构建 Graph 结构 → 写入 Neo4j → 对外输出 Schema 定义
> - **模块 D（Storage SDK）**：提供基础存储访问能力（Cypher 查询执行、节点/边属性读取）
> - **模块 E（Retrieval Service）**：实现业务层 Graph 检索策略（PPR 扩散、种子节点选择、多跳遍历）
>
> Graph 检索的逻辑（如 Query 实体识别 → 种子节点选择 → PPR 扩散 → 结果排序）由检索服务层实现，而非 Graph Builder 层。

---

### 模块 D：Storage Abstraction Layer（公共层）

> **提供统一存储抽象接口，屏蔽多存储系统差异，由 TL 统筹、各 Group 协同维护**

#### D1. 设计理念

Storage Abstraction Layer 位于 Pipeline 与存储引擎之间，所有数据写入/读取均通过该层，不直接操作底层存储。

```
Pipeline (A/B/C) → Storage Abstraction Layer → Milvus / Neo4j / LanceDB
                          │
                   统一 write() / read() / search() 接口
```

#### D2. 存储引擎选型 & 归属

| 存储系统                | 主要用途                                  | 索引类型                             | 运维归属                |
| ------------------- | ------------------------------------- | -------------------------------- | ------------------- |
| **Milvus**          | 向量检索 + BM25 全文（Block/Section/Node 向量） | Vector Index + 倒排索引              | Group 2（Tree 是最大用户） |
| **Neo4j**           | 图谱存储与图遍历                              | Graph Index + Full-text          | Group 3（Graph 独占）   |
| **LanceDB**         | 多模态数据（文本/图片/视频）+ 元数据                  | BTree + Vector + Text            | Group 1（多模态原始数据）    |
| **OSS**             | 原始文件存储（PDF/图片/代码）                     | 对象存储                             | Group 1             |
| **Memory Lake（未来）** | 统一数据湖                                 | Lance + Graph + Arrow/DataFusion |                     |

#### D3. 数据 Schema 设计

**Milvus Collections：**
```
- ams_blocks          : block_id, embedding, summary, metadata, doc_id
- ams_sections        : section_id, embedding, summary, tree_path
- ams_nodes           : node_id, embedding, node_type, community_id
- ams_communities     : community_id, embedding, summary
- ams_topics          : topic_id, embedding, outline, insight
```

**Neo4j Node Labels & Relationships：**
```cypher
(:PhraseNode {id, name, type, embedding, importance})
(:CommunityNode {id, summary, embedding})
-[:RELATION {type, weight, source}]->
-[:SYNONYM {confidence}]->
-[:TEMPORAL {timestamp, valid_from, valid_to}]->
-[:CONTEXT {importance_score, session_id}]->
-[:BELONGS_TO]->
```

#### D4. 公共层关键工作（TL 统筹）

| 工作项                                   | 负责方               | 优先级 |
| ------------------------------------- | ----------------- | --- |
| Storage SDK 统一接口设计（write/read/search） | TL 主导(融合各方需求)     | P0  |
| Milvus Schema 设计与 Collection 管理       | Group 2 提需求，TL 评审 | P0  |
| Neo4j 数据模型设计与索引优化                     | Group 3 负责        | P0  |
| LanceDB 多模态数据 Schema                  | Group 1 提需求，TL 评审 | P1  |
| 跨系统 ID 映射与数据一致性保证                     | TL 主导(ALL)        | P1  |
| 数据版本管理与回滚方案                           | TL 主导(ALL)        | P1  |
| 存储容量规划与分片策略                           | TL 协调各组           | P2  |

---

### 模块 E：记忆检索服务

> **对外提供统一 Retrieval API，支持轻量与 Agentic 两种模式**

#### E1. 检索模式

**轻量级模式（Lightweight Mode）：**

| 检索方式 | 实现 | 适用场景 |
|----------|------|----------|
| BM25 全文检索 | Milvus BM25 / LanceDB FTS | 关键词精确匹配 |
| 向量检索 | Milvus ANN | 语义相似检索 |
| Tree 检索 | 层次化 Section 导航 | 结构化文档检索 |
| Graph 检索 / PPR | Neo4j + Personalized PageRank | 多跳关联检索 |
| RRF 融合 | Reciprocal Rank Fusion | 多路结果融合 |

**Agentic 模式（Agentic Mode）：**

| 步骤 | 实现 |
|------|------|
| Query Expansion（LLM） | 同义扩展、子问题分解 |
| Multi-round Retrieval | 基于中间结果迭代检索 |
| Intelligent Fusion | LLM 判断相关性，智能合并 |

**Reranking（可选）：**
- Cross-Encoder 精排
- LLM-based Reranker

#### E1.5 各检索路径实现细节

> [!info] Tree 检索 vs Tree Builder 的职责边界
> Tree Builder（模块 B）只负责构建和写入数据，**Tree 检索的业务逻辑完全在检索服务层实现**。

**Tree 检索实现细节：**
```
用户 Query
    ↓
向量检索 Milvus (ams_sections collection) → 获取候选 Section
    ↓
根据 tree_path 层级导航（Section → 下属 Block）
    ↓
利用 prev/next 指针进行上下文扩展
    ↓
返回完整的 Tree 路径 + 相关 Block
```
- **调用 Storage SDK**：`search(collection="ams_sections", vector=query_emb)`
- **业务层逻辑（本模块实现）**：层级导航、上下文扩展、结果组装

**Graph 检索实现细节：**
```
用户 Query
    ↓
NER 识别 Query 中的实体 → 映射到 Graph 种子节点
    ↓
调用 Neo4j PPR (Personalized PageRank) 从种子节点扩散
    ↓
获取相关节点 + 边 + 社区信息
    ↓
与向量检索结果进行 RRF 融合
    ↓
返回多跳关联结果
```
- **调用 Storage SDK**：`execute_cypher(ppr_query, seed_nodes=[...])`
- **业务层逻辑（本模块实现）**：实体识别→种子节点选择、PPR 参数调优、结果重排序

**向量/BM25 检索：**
- 直接调用 Storage SDK 封装的 Milvus/LanceDB 接口
- 本层只负责参数封装和结果格式化

#### E2. 检索服务 API 设计

```python
# 统一检索接口
POST /api/v1/memory/retrieve
{
  "query": "string",
  "mode": "lightweight | agentic",
  "memory_types": ["procedural", "semantic", "episodic"],
  "retrieval_methods": ["bm25", "vector", "graph", "tree"],
  "top_k": 10,
  "rerank": true,
  "session_context": {...}  # 可选：注入当前会话上下文
}
```

**关键工作：**
- [ ] 检索服务框架设计（FastAPI / gRPC）
- [ ] 各检索路径实现与单测
- [ ] RRF 融合参数调优
- [ ] Query Expansion Prompt 设计与实验
- [ ] Multi-round Retrieval 策略设计
- [ ] Reranker 模型选型与评测
- [ ] 检索质量评估体系（Recall@K, NDCG, MRR）
- [ ] 检索延迟优化（缓存、并行、预计算）

#### 业界前沿映射

| AMS 设计 | 业界对应方案 | 评价 |
|---------|------------|------|
| BM25 + 向量 + RRF 融合 | 所有主流 RAG 框架标配（LlamaIndex、LangChain、Haystack）| ✅ 必要，成熟 |
| Tree 层级导航检索 | RAPTOR 检索策略 | ✅ 对齐 |
| Graph PPR 检索 | HippoRAG | ✅ 前沿 |
| Query Expansion（LLM）| HyDE（Hypothetical Document Embeddings）、Step-Back Prompting | ⚠️ 可补充 HyDE，对语义漂移的 Query 效果更好 |
| Multi-round Retrieval | FLARE、IRCoT（Interleaved Retrieval CoT）、Self-RAG | ✅ 方向正确，具体触发策略待细化 |
| Reranker | BGE Reranker、Cohere Rerank、LLM-based Reranker | ✅ 标配 |

> [!warning] 评估体系盲点
> 当前指标（Recall@K / NDCG / MRR）属于**检索层指标**，缺少记忆系统层面的任务导向指标：
> - **Agent 任务完成率**：记忆是否真正帮助 Agent 完成了任务
> - **记忆准确率**：Temporal 事实的版本正确性
> - **跨会话记忆利用率**：Agent 实际调用长期记忆的频率与质量
>
> 建议在 Phase 1 结束时就引入任务完成率评估，不要等到 Phase 3 联调阶段才开始。

---

### 模块 X：Working Memory 管理

> **管理 Agent 短期活跃上下文，提供 Prompt 组装与上下文压缩能力**

#### X1. 架构位置

```
Agent Framework ←→ IO ←→ Redis（Working Memory）→ context → Compact
                    ↑                                         │
                    │          ❶ 组装完整 Prompt               │
                    ├──── long-term memory retrieval ←─────────┤
                    │                                         │
                    └─── ❷ 上下文压缩后回写 ←─────────────────┘
```

Working Memory 是 Agent Framework 与 AMS 之间的桥梁：
- **上行**：接收 Agent IO，存入 Redis 作为活跃上下文
- **下行**：结合长期记忆检索结果，组装完整 Prompt 返回给 Agent
- **压缩**：当上下文超长时，Compact 机制压缩并回写

#### X2. 核心组件

| 组件 | 职责 | 技术方案 |
|------|------|---------|
| **Redis KV Store** | 存储当前会话状态（short-term, active context） | Redis Cluster + TTL 过期 |
| **Compact** | 压缩过长的上下文信息（❷），保留关键信息 | LLM-based summarization / 滑动窗口 |
| **Prompt Assembler** | 组合 Working Memory + Long-term Retrieval 结果（❶） | 模板拼装 + 优先级排序 |
| **Memory Consolidation** | 将 Working Memory 中有价值的信息归并到长期记忆 | 触发条件：会话结束 / 上下文溢出 |

#### X3. Working Memory → Long-term Memory 转化

```
Working Memory (Redis)
    │
    ├── flat KV → Raw Block → Streaming Pipeline → Tree/Graph 增量更新
    │   （准实时：会话进行中的关键信息同步到长期记忆，延迟目标 < 30s）
    │
    └── consolidate & update memories online（Agent-TES 触发）
        （会话结束后：批量归并到 Procedural/Declarative Memory）
```

**关键工作：**
- [ ] Redis 数据结构设计（会话状态 Schema）
- [ ] Compact 压缩策略选型（LLM summary vs 滑动窗口 vs token 截断）
- [ ] Prompt Assembler：Working Memory + Retrieval 结果的优先级排序与拼装
- [ ] Memory Consolidation 触发机制（会话结束 / 溢出 / 定时）
- [ ] Working Memory → Raw Block 转化逻辑
- [ ] 与 Agent Framework 的 IO 接口定义（Redis 读写协议）

#### 业界前沿映射

| AMS 设计 | 业界对应方案 | 评价 |
|---------|------------|------|
| Redis Working Memory + Compact | MemGPT（2023）的分层内存管理 | ✅ MemGPT 用 main context + archival storage 实现类似分层 |
| Memory Consolidation（WM → LTM）| MemGPT 的 "pause and reflect" 机制 | ✅ 将短期记忆主动巩固为长期记忆 |
| Prompt Assembly（WM + Retrieval）| A-MEM（2024）的 Agentic Memory 组装 | ✅ 多来源上下文的智能融合 |

> [!tip] 注意
> Working Memory 模块是 AMS 与 Agent Framework 耦合最紧的部分，Redis IO 协议和 Prompt 格式需要双方尽早对齐。建议 Phase 1 第一周就完成接口定义。

---

## 四、人员分工建议（3组，共9人）

> [!tip] 分组原则
> - 建议设 1 名整体 Tech Lead 进行项目管理与协调、统筹接口对齐、架构决策。
> - 每组负责一个相对完整的纵向切面，减少跨组依赖；组内两人互为 backup
> - 模块 D（Storage Abstraction Layer）为**公共层**，由 TL 统筹，集体共同维护，各组按就近原则分担运维
> - 模块 X（Working Memory）由 Group 1 兼任（数据流与 ETL Pipeline 紧密相关：IO → Redis → Kafka → Streaming Pipeline）
> - **模块 X 为低优先级**：AMS 优先侧重长期记忆，WM 归属仍待与 Agent Framework 团队确认。Group 1 前期专注 ETL，WM 在 Phase 2 末启动，必要时可从其他 Group 调人支援


### 分组方案
```

├── Group 1:        数据采集(TES) + Working Memory + Context Management(Compact)  王宇+景峰+文纬

├── Group 2:        知识库构建(doc+code)          郑棋+杰宁+赵龙

├── Group 3:        记忆构建                      露阳+吕鑫+彬彬

```


```
Tech Lead（1人，兼任 Group 3 & 4）
├── Group 1(模块A+X):      数据采集 & ETL + Working Memory  (2人) 王宇+景峰
│   └── 兼管: LanceDB 运维 + WM（低优先级，Phase 2 末启动）
├── Group 2(模块B):        记忆构建 — Tree                  (2人) 郑棋+杰宁
│   └── 兼管: Milvus 运维
├── Group 3(模块C):        记忆构建 — Graph                 (2.5人) 露阳+吕鑫+彬彬
│   └── 兼管: Neo4j 运维
└── Group 4(模块E):        检索服务 & 评估                   (2.5人) 赵龙+文纬+彬彬
```
```
公共层（模块 D，TL 统筹）:
├── Storage SDK 统一接口设计 → TL 主导
├── 跨存储 ID 映射与一致性   → TL 主导
└── 各存储 Schema 设计       → 各 Group 提需求，TL 评审
```
---

### Group 1：数据采集 & ETL Pipeline + Working Memory（模块 A + X）

**核心职责：** 数据从各来源流入系统，产出干净的 Raw Block；兼管 LanceDB 运维 + Working Memory（低优先级）

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Agent-TES 数据订阅 & Kafka 接入 | P0 | M |
| Agentic Streaming Pipeline（Ray Streaming） | P0 | L |
| Agentic Batch Pipeline（Ray Batch） | P0 | L |
| 文档解析（PDF/代码/Markdown） | P0 | M |
| External Zone 接入（用户上传 + URL 抓取） | P1 | M |
| Chunking 策略调研与实验 | P1 | M |
| SGLang 推理引擎集成 | P1 | M |
| VLM 图片/表格理解集成 | P1 | M |
| LanceDB 多模态数据 Schema 与运维 | P1 | M |
| 数据质量监控 | P2 | S |
| **以下为模块 X（低优先级，Phase 2 末启动）** | | |
| Redis Working Memory 数据结构设计 | P2 | M |
| Compact 上下文压缩策略 | P2 | M |
| Memory Consolidation（WM → LTM 触发机制） | P2 | M |
| WM API（GET /working-memory/{session_id}） | P2 | M |
| 与 Agent Framework 的 Redis IO 协议定义 | P2 | M |

> [!info] 模块 X 优先级说明
> Working Memory 归属仍待与 Agent Framework 团队确认，当前为**低优先级**。Group 1 前期专注模块 A（ETL），Phase 2 末视需求启动模块 X。如 WM 工作量增大，可从其他 Group 调人支援。

**技术栈：** Kafka, Ray, SGLang, Agent-TES SDK, PyMuPDF/Unstructured, LanceDB, Redis, Sentence-Transformers

**对外输出：**
- 标准化 Raw Block（含 text, source_type, metadata, embedding）
- Working Memory API（低优先级，待启动）

---

### Group 2：记忆构建 — Tree 结构（模块 B）

**核心职责：** 构建文档/代码/技能的层次化 Tree，产出可检索的 Section/Block；兼管 Milvus 运维

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Tree 数据结构设计 & Schema 定义 | P0 | S |
| 自动分层算法实现 | P0 | L |
| Block 摘要生成（LLM） | P0 | M |
| Milvus Schema 设计与 Collection 管理 | P0 | M |
| Block 类型分类器 | P1 | M |
| Triples 提取（三元组，供 Graph 消费） | P1 | L |
| Tree 增量更新机制 | P1 | M |
| Section 层级摘要聚合 | P2 | M |
| Topic/Outline/Insight 提取 | P2 | M |

**技术栈：** LLM API, Milvus, spaCy/OpenIE

**对外输出：** Tree 结构数据（写入 Milvus）+ Triples（供 Group 3 消费）

---

### Group 3：记忆构建 — Graph（模块 C）

**核心职责：** 构建知识图谱（Procedural + Declarative Memory）；兼管 Neo4j 运维

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Neo4j 数据模型设计与索引优化 | P0 | M |
| 实体链接 & 消歧方案选型 | P0 | L |
| 关系抽取流程实现 | P0 | L |
| 社区发现算法集成（Louvain/Leiden） | P1 | M |
| 社区摘要生成 | P1 | M |
| Temporal KG 设计与实现 | P1 | L |
| 遗忘机制（temporal invalidation/decay） | P1 | M |

**技术栈：** Neo4j, NetworkX, LLM API

**对外输出：** Graph 结构（写入 Neo4j）+ Node/Edge 向量（写入 Milvus via Storage SDK）

---

### Group 4：检索服务 & 评估（模块 E）

**核心职责：** 构建检索 API，建立评估闭环

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| 检索服务框架搭建（FastAPI/gRPC） | P0 | M |
| 各检索路径实现（BM25/Vector/Tree/Graph） | P0 | L |
| RRF 融合实现与调优 | P0 | M |
| 检索质量评估体系（Eval Dataset + 指标） | P0 | L |
| Query Expansion（LLM）实现 | P1 | M |
| Multi-round Retrieval 策略 | P1 | L |
| Reranker 模型选型 & 集成 | P1 | M |
| Retrieval API 支持 session_context 参数（接收 WM 数据） | P1 | S |
| 检索性能优化（缓存/并发/预计算） | P2 | M |
| 与 Agent Framework 接口联调 | P1 | M |

**技术栈：** FastAPI/gRPC, Milvus, Neo4j PPR, Sentence-Transformers, FlagEmbedding

**对外输出：** `/api/v1/memory/retrieve` 统一检索接口

---

## 五、整体排期建议（3个阶段）

### Phase 1：基础底座（第 1~4 周）

**目标：** 跑通数据从接入到存储的完整链路（以文档类数据为主）；Storage SDK 基础版就绪

| Group   | 里程碑                                                       |
| ------- | --------------------------------------------------------- |
| ALL     | Storage SDK 基础版（write/read 接口）+ 跨组 Schema 对齐 + 统一 ID 生成策略 |
| Group 1 | Kafka 接入 + Batch Pipeline MVP（模块 X 暂不启动，仅定义 Mock 接口）      |
| Group 2 | Tree 构建 MVP（支持 Markdown/文档）+ Milvus 部署                    |
| Group 3 | Neo4j 部署 + 基础 Graph 写入                                    |
| Group 4 | 基础向量检索 + BM25 检索 Demo + Mock Working Memory 接口（支持框架独立开发）  |

### Phase 2：核心功能（第 5~10 周）

**目标：** Tree + Graph 双层结构完整实现，检索服务可用，Working Memory 基础可用

| Group   | 里程碑                                                       |
| ------- | --------------------------------------------------------- |
| ALL     | Storage SDK search 接口 + 跨存储 ID 映射                         |
| Group 1 | Streaming Pipeline + External Zone 支持；Phase 2 末启动 WM 接口定义 |
| Group 2 | Tree 增量更新 + 摘要/Triples 完善                                 |
| Group 3 | 社区发现 + Temporal KG + 遗忘机制                                 |
| Group 4 | 多路检索融合 + Reranker + 评估体系                                  |

### Phase 3：优化 & 集成（第 11~14 周）

**目标：** 与 Agent Framework 联调，性能优化，生产就绪

| Group   | 里程碑                                                       |
| ------- | --------------------------------------------------------- |
| Group 1 | Agent-TES 实时数据接入 + WM 实现（Redis + Compact + Consolidation） |
| Group 2 | 情景记忆（Episodic）支持                                          |
| Group 3 | Graph 质量优化 + 遗忘机制调参                                       |
| Group 4 | Agentic 检索模式 + Agent Framework 联调                         |

---

## 六、关键技术难点 & 待调研项

> [!warning] 高风险技术点
> 以下问题需要尽早立项调研，避免后期返工

### 🔬 必须调研的技术选型

| 问题               | 选项                                  | 建议负责方         |
| ---------------- | ----------------------------------- | ------------- |
| Chunking 策略      | Fixed-size / Semantic / AST-based   | Group 1       |
| 三元组抽取方案          | OpenIE / LLM Prompt / Fine-tuned RE | Group 2       |
| 实体链接 & 消歧        | BLINK / REL / LLM-based             | Group 3       |
| 社区发现算法           | Louvain / Leiden / 分层聚类             | Group 3       |
| Reranker 选型      | BGE Reranker / Cohere / LLM-based   | Group 4       |
| Compact 压缩策略     | LLM summary / 滑动窗口 / Token 截断       | Group 1（模块 X） |
| 向量模型             | BGE / E5 / text-embedding-3         | 全组对齐          |
| 摘要生成模型           | 本地小模型 vs API 调用                     | Group 2       |


### 🧪 需要实验验证的策略

- [ ] Tree 层次划分的最优粒度（Block 大小 vs 检索质量）
- [ ] Graph 稀疏度控制（边太多会降低 PPR 效果）
- [ ] RRF vs 学习型 Fusion 的效果对比
- [ ] 遗忘机制参数调优（decay rate, threshold）
- [ ] Query Expansion 对不同查询类型的收益分析
- [ ] Compact 压缩对 Prompt 质量的影响（信息损失 vs Token 节省）
- [ ] Memory Consolidation 触发时机对长期记忆质量的影响

### 🔗 跨组接口约定（需尽早对齐）

| 接口             | 生产方           | 消费方                         | 格式                                      |
| -------------- | ------------- | --------------------------- | --------------------------------------- |
| Raw Block      | Group 1       | Group 2, 3                  | JSON Schema（Phase 1 第 2 周冻结）            |
| Triples        | Group 2       | Group 3                     | `(subject, relation, object, metadata)` |
| Storage SDK    | ALL（公共层）      | Group 1, 2, 3, 4            | Python 封装                               |
| Retrieval API  | Group 4       | Agent Framework             | REST / gRPC（待定）                         |
| Redis IO 协议    | Group 1（模块 X） | Agent Framework             | Redis KV Schema（待定）                     |
| WM → Raw Block | Group 1（模块 X） | Group 1（Streaming Pipeline） | JSON Schema                             |

**接口分层说明（重要）：**

| 接口层级 | 接口 | 生产方 | 消费方 | 说明 |
|--------|------|--------|--------|------|
| **基础存储层** | Tree 原始查询 | Storage SDK (D) | Retrieval Service (E) | Milvus 向量搜索、元数据过滤 |
| **基础存储层** | Graph 原始查询 | Storage SDK (D) | Retrieval Service (E) | Neo4j Cypher 查询执行 |
| **业务检索层** | Tree/Graph 业务检索 | Retrieval Service (E) | Agent Framework | 封装策略的检索 API（层级导航、PPR 等）|

> [!note] 分层原则
> 1. **基础存储层**：Storage SDK (D) 只提供原始数据访问能力，不感知业务检索策略
> 2. **业务检索层**：Retrieval Service (E) 封装 Tree/Graph 的检索策略，对上层暴露统一接口
> 3. **边界清晰**：B/C 只负责写入，D 负责存储抽象，E 负责检索策略，避免职责交叉

---

## 七、评估指标体系

### 检索质量指标

| 指标 | 说明 | 目标值 |
|------|------|--------|
| Recall@10 | Top-10 结果召回率 | > 0.85 |
| NDCG@10 | 排序质量 | > 0.75 |
| MRR | 首个相关结果平均倒数排名 | > 0.70 |
| 端到端延迟 | P99 检索延迟 | < 500ms |

### 记忆质量指标

| 指标 | 说明 |
|------|------|
| Triple Precision | 抽取三元组准确率 |
| Graph Connectivity | 图谱连通性（孤立节点占比）|
| Summary Quality | 摘要 ROUGE / LLM 评分 |
| Temporal Consistency | 时序关系逻辑一致性 |

---

## 八、依赖与风险

| 风险 | 影响 | 缓解措施                            |
| -------------------------------- | ---------------------- | ------------------------------- |
| Agent-TES 数据格式变更 | Group 1 Pipeline 重构 | 增加数据适配层，解耦格式                    |
| LLM API 延迟/成本 | ETL 吞吐量下降 | 本地部署小模型作 Fallback；SGLang 批量推理优化 |
| Neo4j 性能瓶颈 | 大规模图谱检索慢 | 提前做分片规划 + PPR 预计算               |
| Redis IO 协议与 Agent Framework 不对齐 | Working Memory 无法上线 | Phase 1 第一周完成接口定义，双方签字确认        |
| Agent Framework 接口不稳定 | 联调延期 | 先用 Mock 数据，独立开发                 |
| Storage SDK 抽象层设计不当 | 各组写入/读取方式不一致 | 在 Phase 1 完成基础版，各组 Code Review  |
| Compact 压缩信息损失 | Prompt 质量下降影响 Agent 表现 | 多策略 A/B 测试，设置信息保留率阈值            |
