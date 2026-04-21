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
> 本文档基于 AMS（Agent Memory System）架构图，梳理核心技术模块、工作细节及团队的分工建议。
> 主要目标：实现 **Tree + Graph 双层结构**的长期记忆（过程记忆、语义记忆、情景记忆）的**转化、存储与检索**。

---

## 一、项目背景与目标
![[Pasted image 20260325111351.png]]
![[Pasted image 20260329172202.png]]
### 1.1 背景

- AMS 团队的核心职责是为 Agent 提供**长期记忆能力**，**Agent Framework** 由北美团队负责。
- 与 Agent Framework 团队的接口：
  - 通过 **Langfuse** 获取 Agent 行为数据（输入输出、工具调用链等）
  - 对外提供**记忆检索服务**（Retrieval API），供 Agent 访问长期记忆
  - AMS 优先侧重长期记忆，Working Memory 归属暂定（需要与Agent Framework 团队沟通确定）

### 1.2 核心目标

| 目标         | 说明                                          |
| ---------- | ------------------------------------------- |
| **记忆转化**   | 将 Agent 行为数据、知识文档、代码等转化为结构化记忆（Tree + Graph） |
| **记忆存储**   | 持久化存储多类型记忆，支持向量/全文/图谱多路索引                   |
| **记忆检索**   | 提供轻量级与 Agentic 两种检索模式，支持多路融合与重排序            |
| **记忆管理**   | 支持时序失效、遗忘机制、记忆更新与合并                         |
| **RAG 底座** | 构建高质量 RAG 基础能力，作为所有检索的底层支撑                  |

### 1.3 记忆类型定义

```
长期记忆
├── 过程记忆（Procedural Memory）   → 技能、工作流、经验（skill.md、SOP）
├── 语义记忆（Semantic Memory）     → 知识、概念、事实（文档、代码、KG triples）
└── 情景记忆（Episodic Memory）     → 事件、对话、时序上下文（Agent 行为轨迹）
```

---

## 二、整体架构模块划分

架构由以下五大模块组成，各模块相对独立、可并行设计&开发：

```
┌─────────────────────────────────────────────────────┐
│                   AMS 整体架构                        │
│                                                       │
│  ① 数据采集层      → Langfuse / TES / 知识库          │
│  ② ETL处理层       → Ray + Bert/LLM/VLM Pipeline      │
│  ③ 记忆构建层      → Tree Builder + Graph Builder     │
│  ④ 存储引擎层      → Milvus / Neo4j / LanceDB         │
│  ⑤ 检索服务层      → Retrieval API（轻量+Agentic）    │
└─────────────────────────────────────────────────────┘
```

---

## 三、核心模块技术方案详解

### 模块 A：数据采集 & ETL 流水线

> **负责把原始数据转化为可处理的 Raw Block**

#### A1. 数据源接入

| 数据源        | 采集方式                          | 数据类型              |
| ---------- | ----------------------------- | ----------------- |
| Agent 行为数据 | Langfuse SDK / API 订阅 → Kafka | 对话轮次、工具调用、推理链     |
| 企业知识文档     | 离线批量导入 / 增量同步                 | PDF、Markdown、Wiki |
| 源代码        | Git Hook / 定期同步               | Python、Java 等代码文件 |
| 技能文件       | 人工维护 + 自动更新                   | skill.md          |

**关键工作：**
- [ ] Langfuse 数据订阅与格式化（对接 Agent-TES sidecar 数据）
- [ ] Kafka Topic 设计（online vs offline 分流）
- [ ] 数据去重、清洗、格式归一化

#### A2. ETL 处理 Pipeline（基于 Ray）

**Online Pipeline（实时）：**
```
Kafka → Ray Streaming → 文本切分 → Embedding → 写入 Milvus/LanceDB
```

**Offline Pipeline（批量）：**
```
OSS/知识库 → Ray Batch → 文档解析(PDF/Code/MD) → 分块 →
  ├── Bert/LLM 摘要提取
  ├── LLM 三元组抽取（triples）
  ├── VLM 图片/表格理解
  └── Tree/Graph 构建 → 写入存储层
```

**关键工作：**
- [ ] Ray 集群部署/fuyao对接，相关调优
- [ ] 文档解析：PDF解析（表格、图片）、代码结构解析
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

#### B2. Tree 索引策略

| 索引类型 | 存储位置 | 用途 |
|----------|----------|------|
| Topic/Outline/Insight | 独立向量集合 | 高层语义导航 |
| Vector Cluster（仅文档） | Milvus | 文档级粗筛 |
| Block/Section/Summary 向量 | Milvus | 精细检索 |
| 全文倒排索引 | LanceDB / Milvus | BM25 关键词检索 |
| BTree 索引 | LanceDB | 元数据过滤 |

#### 业界前沿映射：RAPTOR（Stanford, 2024）

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

---

### 模块 D：存储引擎层

> **多存储系统协同，满足不同检索需求**

#### D1. 存储选型对比

| 存储系统 | 主要用途 | 索引类型 |
|----------|----------|----------|
| **Milvus** | 向量检索（Block/Section/Node 向量） | Vector Index + 倒排索引 |
| **Neo4j** | 图谱存储与图遍历 | Graph Index + Full-text |
| **LanceDB** | 多模态数据（文本/图片/视频）+ 元数据 | BTree + Vector + Text |
| **OSS** | 原始文件存储（PDF/图片/代码） | 对象存储 |
| **Memory Lake（未来）** | 统一数据湖 | Lance + Graph + Arrow/DataFusion |

#### D2. 数据 Schema 设计

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

**关键工作：**
- [ ] Milvus Schema 设计与 Collection 管理
- [ ] Neo4j 数据模型设计与索引优化
- [ ] LanceDB 多模态数据 Schema
- [ ] 跨系统数据一致性保证（ID 映射、事务性）
- [ ] 数据版本管理与回滚方案
- [ ] 存储容量规划与分片策略
- [ ] Memory Lake 技术预研（LanceDB + Arrow/DataFusion）

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

## 四、人员分工建议（4组，共8~9人）

> [!tip] 分组原则
> 每组负责一个相对完整的纵向切面，减少跨组依赖；组内两人互为 backup。
> 建议设 1 名整体 Tech Lead 统筹接口对齐与架构决策（可兼任某组）。

### 分组方案

```
Tech Lead（1人，兼任 Group3&4）
├── Group 1: 数据采集 & ETL Pipeline      (2人) 王宇+景峰
├── Group 2: 记忆构建 — Tree              (2人) 郑棋+杰宁
├── Group 3: 记忆构建 — Graph + 存储       (2.5人) 露阳+吕鑫+彬彬
└── Group 4: 检索服务 & 评估               (2.5人) 赵龙+文纬+彬彬
```
```Plain
Tech Lead（1人，兼任 Group3&4）
├── Group 1(模块A):   数据采集 & ETL Pipeline      (2人) 王宇+景峰
├── Group 2(模块B):   记忆构建 — Tree              (2人) 郑棋+杰宁
├── Group 3(模块C+D): 记忆构建 — Graph + 存储       (2.5人) 露阳+吕鑫+彬彬
└── Group 4(模块E):   检索服务 & 评估               (2.5人) 赵龙+文纬+彬彬
```
---

### Group 1：数据采集 & ETL Pipeline

**核心职责：** 数据从各来源流入系统，产出干净的 Raw Block

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Langfuse 数据订阅 & Kafka 接入 | P0 | M |
| 在线 Pipeline（Ray Streaming） | P0 | L |
| 离线 Pipeline（Ray Batch） | P0 | L |
| 文档解析（PDF/代码/Markdown） | P0 | M |
| Chunking 策略调研与实验 | P1 | M |
| VLM 图片/表格理解集成 | P1 | M |
| 数据质量监控 | P2 | S |

**技术栈：** Kafka, Ray, Langfuse SDK, PyMuPDF/Unstructured, Sentence-Transformers

**对外输出：** 标准化 Raw Block（含 text, source_type, metadata, embedding）

---

### Group 2：记忆构建 — Tree 结构

**核心职责：** 构建文档/代码/技能的层次化 Tree，产出可检索的 Section/Block

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Tree 数据结构设计 & Schema 定义 | P0 | S |
| 自动分层算法实现 | P0 | L |
| Block 摘要生成（LLM） | P0 | M |
| Block 类型分类器 | P1 | M |
| Triples 提取（三元组，供 Graph 消费） | P1 | L |
| Tree 增量更新机制 | P1 | M |
| Section 层级摘要聚合 | P2 | M |
| Topic/Outline/Insight 提取 | P2 | M |

**技术栈：** LLM API, Milvus, LanceDB, spaCy/OpenIE

**对外输出：** Tree 结构数据（写入 Milvus）+ Triples（供 Group 3 消费）

---

### Group 3：记忆构建 — Graph + 存储引擎

**核心职责：** 构建知识图谱，设计并维护多存储系统

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| Neo4j 数据模型设计 | P0 | M |
| 实体链接 & 消歧方案选型 | P0 | L |
| 关系抽取流程实现 | P0 | L |
| 社区发现算法集成（Louvain/Leiden） | P1 | M |
| 社区摘要生成 | P1 | M |
| Temporal KG 设计与实现 | P1 | L |
| 遗忘机制（temporal invalidation/decay） | P1 | M |
| Milvus/LanceDB Schema 与运维 | P0 | M |
| 跨存储 ID 映射与一致性保证 | P1 | M |
| Memory Lake 预研（Lance+DataFusion） | P2 | L |

**技术栈：** Neo4j, Milvus, LanceDB, NetworkX, LLM API

**对外输出：** Graph 结构（写入 Neo4j + Milvus）+ 统一存储层接口

---

### Group 4：检索服务 & 评估体系

**核心职责：** 构建检索 API，建立评估闭环

| 工作项 | 优先级 | 工作量 |
|--------|--------|--------|
| 检索服务框架搭建（FastAPI/gRPC） | P0 | M |
| 各检索路径实现（BM25/Vector/Tree/Graph） | P0 | L |
| RRF 融合实现与调优 | P0 | M |
| Query Expansion（LLM）实现 | P1 | M |
| Multi-round Retrieval 策略 | P1 | L |
| Reranker 模型选型 & 集成 | P1 | M |
| 检索质量评估体系（Eval Dataset + 指标） | P0 | L |
| 检索性能优化（缓存/并发/预计算） | P2 | M |
| 与 Agent Framework 接口联调 | P1 | M |

**技术栈：** FastAPI/gRPC, Milvus, Neo4j PPR, Sentence-Transformers, FlagEmbedding

**对外输出：** `/api/v1/memory/retrieve` 统一检索接口

---

## 五、整体排期建议（3个阶段）

### Phase 1：基础底座（第 1~4 周）

**目标：** 跑通数据从接入到存储的完整链路（以文档类数据为主）

| Group   | 里程碑                             |
| ------- | ------------------------------- |
| Group 1 | Kafka 接入 + 离线 Pipeline MVP      |
| Group 2 | Tree 构建 MVP（支持 Markdown/文档）     |
| Group 3 | Neo4j + Milvus 部署 + 基础 Graph 写入 |
| Group 4 | 基础向量检索 + BM25 检索 Demo           |

### Phase 2：核心功能（第 5~10 周）

**目标：** Tree + Graph 双层结构完整实现，检索服务可用

| Group | 里程碑 |
|-------|--------|
| Group 1 | 在线 Pipeline + 代码/技能文件支持 |
| Group 2 | Tree 增量更新 + 摘要/Triples 完善 |
| Group 3 | 社区发现 + Temporal KG + 遗忘机制 |
| Group 4 | 多路检索融合 + Reranker + 评估体系 |

### Phase 3：优化 & 集成（第 11~14 周）

**目标：** 与 Agent Framework 联调，性能优化，生产就绪

| Group | 里程碑 |
|-------|--------|
| Group 1 | Langfuse 实时数据接入（Agent 行为数据）|
| Group 2 | 情景记忆（Episodic）支持 |
| Group 3 | Memory Lake 预研结论 + 存储优化 |
| Group 4 | Agentic 检索模式 + Agent Framework 联调 |

---

## 六、关键技术难点 & 待调研项

> [!warning] 高风险技术点
> 以下问题需要尽早立项调研，避免后期返工

### 🔬 必须调研的技术选型

| 问题 | 选项 | 建议负责方 |
|------|------|------------|
| Chunking 策略 | Fixed-size / Semantic / AST-based | Group 1 |
| 三元组抽取方案 | OpenIE / LLM Prompt / Fine-tuned RE | Group 2 |
| 实体链接 & 消歧 | BLINK / REL / LLM-based | Group 3 |
| 社区发现算法 | Louvain / Leiden / 分层聚类 | Group 3 |
| Reranker 选型 | BGE Reranker / Cohere / LLM-based | Group 4 |
| 向量模型 | BGE / E5 / text-embedding-3 | 全组对齐 |
| 摘要生成模型 | 本地小模型 vs API 调用 | Group 2 |

### 🧪 需要实验验证的策略

- [ ] Tree 层次划分的最优粒度（Block 大小 vs 检索质量）
- [ ] Graph 稀疏度控制（边太多会降低 PPR 效果）
- [ ] RRF vs 学习型 Fusion 的效果对比
- [ ] 遗忘机制参数调优（decay rate, threshold）
- [ ] Query Expansion 对不同查询类型的收益分析

### 🔗 跨组接口约定（需尽早对齐）

| 接口 | 生产方 | 消费方 | 格式 |
|------|--------|--------|------|
| Raw Block | Group 1 | Group 2, 3 | JSON Schema（待定） |
| Triples | Group 2 | Group 3 | `(subject, relation, object, metadata)` |
| 存储层 SDK | Group 3 | Group 2, 4 | Python 封装 |
| Retrieval API | Group 4 | Agent Framework | REST / gRPC（待定）|

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

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Langfuse 数据格式变更 | Group 1 Pipeline 重构 | 增加数据适配层，解耦格式 |
| LLM API 延迟/成本 | ETL 吞吐量下降 | 本地部署小模型作 Fallback |
| Neo4j 性能瓶颈 | 大规模图谱检索慢 | 提前做分片规划 + PPR 预计算 |
| Working Memory 归属变更 | 影响在线 Pipeline 设计 | 保持接口抽象，降低耦合 |
| Agent Framework 接口不稳定 | 联调延期 | 先用 Mock 数据，独立开发 |
