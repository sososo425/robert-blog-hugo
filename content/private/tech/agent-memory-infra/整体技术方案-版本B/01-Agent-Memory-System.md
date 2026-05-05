---
title: "01-Agent-Memory-System 详细设计"
date: 2026-03-23T18:00:00+08:00
draft: true
tags: ["agent-memory", "AMS", "core-service", "详细设计", "版本B"]
---

# Agent Memory System（AMS）详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心地位**: 本服务是整个 Agent Infra 的记忆核心，所有记忆的读写、检索、整合均经由此服务

---

## 1. 模块定位与职责

### 1.1 在系统中的位置

Agent Memory System（以下简称 AMS）是独立部署的核心后端服务，所有与记忆相关的操作都必须通过 AMS 完成。

```
┌───────────────────────────────────────────────────────┐
│         调用方（上游）                                  │
│  ┌─────────────────┐    ┌────────────────────────────┐ │
│  │  Agent Framework │    │  Memory Processing Pipeline│ │
│  │  (同步 HTTP/gRPC)│    │  (同步 HTTP 写入)           │ │
│  └────────┬─────────┘    └──────────────┬─────────────┘ │
└───────────┼──────────────────────────────┼───────────────┘
            │ Memory API                   │ Ingest API
            ▼                              ▼
┌───────────────────────────────────────────────────────┐
│                Agent Memory System                     │
│                                                        │
│   MemoryGateway（统一入口）                             │
│      │                                                 │
│      ├── WorkingMemoryManager ── Redis                 │
│      ├── EpisodeStore         ── Milvus + OSS          │
│      ├── SkillStore           ── PostgreSQL + Milvus   │
│      └── SemanticMemoryStore  ── Neo4j + Milvus        │
│                                                        │
│   MultiPathRetriever（多路检索）                        │
│   ConsolidationEngine（整合触发器）                     │
│   EmbeddingService（向量化）                            │
└───────────────────────────────────────────────────────┘
            │
            ▼  依赖（下游存储）
   Redis / Milvus / PostgreSQL / Neo4j / OSS
```

**AMS 对外暴露的服务边界：**
- 对上游提供：REST API（版本B中使用 HTTP，后续可扩展 gRPC）
- 对下游依赖：直接访问各存储层，不经过其他服务

### 1.2 AMS 的核心职责

| 职责         | 说明                                               | 涉及接口                                                     |
| ---------- | ------------------------------------------------ | -------------------------------------------------------- |
| **记忆存储**   | 将内容写入对应的记忆层（Working/Episode/Procedural/Semantic） | `/memory/working`、`/memory/episodes`、`/memory/knowledge` |
| **记忆检索**   | 跨4层并行检索，融合排序后返回                                  | `/memory/search`                                         |
| **工作记忆管理** | 读写当前任务的活跃状态（Agent生命周期内）                          | `/memory/working/{agent_id}`                             |
| **整合触发**   | 根据规则触发 Episode → Semantic/Procedural 的整合         | `/memory/consolidate`                                    |
| **记忆统计**   | 查询各层记忆的使用统计                                      | `/memory/stats`                                          |

### 1.3 谁调用 AMS？怎么调用？

**上游调用方1：Agent Framework**
- 调用时机：Agent 启动时加载上下文、执行中检索、任务结束时刷写 Episode
- 调用方式：同步 HTTP（延迟敏感，要求 P95 < 200ms）
- 使用接口：`/memory/search`、`/memory/working/*`、`/memory/episodes`

**上游调用方2：Memory Processing Pipeline**
- 调用时机：Kafka 消费到一条 Evidence 后，完成提取/嵌入处理，再写入 AMS
- 调用方式：同步 HTTP POST（写操作）
- 使用接口：`/memory/episodes`（写入 Episode）、`/memory/knowledge`（写入 Block/实体）

**AMS 调用的下游：**

| 下游服务 | 用途 | 协议 |
|---------|------|------|
| Redis | Working Memory KV 读写 | Redis Protocol |
| Milvus | Episode/Block/Skill 向量检索 | gRPC (Milvus SDK) |
| PostgreSQL | Skill、Community Summary、元数据 | SQL (asyncpg) |
| Neo4j | 实体关系图谱查询 | Bolt (neo4j-driver) |
| OSS | 大型 Episode 原始内容存储 | OSS SDK (HTTP) |

---

## 2. 内部模块架构

### 2.1 模块划分

```
agent_memory_system/
├── api/                    # HTTP API 路由层
│   ├── routes_memory.py    # 记忆读写接口
│   ├── routes_search.py    # 检索接口
│   └── routes_admin.py     # 管理接口
├── gateway/
│   └── memory_gateway.py   # MemoryGateway：路由分发到各层
├── stores/
│   ├── working_memory.py   # WorkingMemoryManager（Redis）
│   ├── episode_store.py    # EpisodeStore（Milvus + OSS）
│   ├── skill_store.py      # SkillStore（PostgreSQL + Milvus）
│   └── semantic_store.py   # SemanticMemoryStore（Neo4j + Milvus）
├── retrieval/
│   ├── multi_path.py       # MultiPathRetriever（5路并行检索）
│   ├── reranker.py         # 重排序（BGE Cross-Encoder）
│   └── scorer.py           # 混合评分（相关性+时效性+重要性）
├── consolidation/
│   └── engine.py           # ConsolidationEngine（整合触发逻辑）
├── embedding/
│   └── service.py          # EmbeddingService（向量化，统一入口）
└── models/
    ├── memory_types.py     # 数据模型（MemoryLayer、MemoryResult 等）
    └── schemas.py          # Pydantic 请求/响应 Schema
```

### 2.2 请求处理流程（以检索为例）

以 Agent Framework 调用 `POST /api/v1/memory/search` 为例：

```
Agent Framework
    │
    │  POST /api/v1/memory/search
    │  { "query": "如何处理CSV文件中的缺失值", "agent_id": "agent_001",
    │    "layers": ["working", "episode", "procedural", "semantic"] }
    │
    ▼
MemoryGateway.search()
    │
    ├──→ WorkingMemoryManager.get(agent_id)        # Redis HGETALL，<1ms
    │         → 返回：当前任务状态（如已知 pandas 可处理 CSV）
    │
    ├──→ EpisodeStore.search(query_vec, top_k=5)   # Milvus ANN，~20ms
    │         → 返回：3条历史类似任务的执行过程
    │
    ├──→ SkillStore.search(query_vec, top_k=3)      # Milvus + PG filter，~15ms
    │         → 返回：2个相关技能（"pandas-fillna-skill"、"csv-clean-skill"）
    │
    └──→ SemanticMemoryStore.search(query_vec)      # Milvus + Neo4j，~40ms
              → Block检索：找到 pandas.fillna() 用法文档
              → Community Summary：找到"数据清洗技术"社区摘要
    │
    ▼
MultiPathRetriever.fuse(results)
    → 合并4路结果，去重
    │
    ▼
Reranker.rerank(query, candidates)
    → BGE Cross-Encoder 精排（可选，top_k较小时）
    │
    ▼
Scorer.score(results)
    → 混合评分：0.6×相关性 + 0.3×时效性 + 0.1×重要性
    │
    ▼
返回 MemorySearchResponse（含 top 10 结果）
```

---

## 3. 四层记忆详细设计

### 3.1 Working Memory（工作记忆）

**定位**：Agent 执行当前任务期间的活跃上下文。任务结束（或超时）后自动失效。

**类比**：等同于人类"手头正在想的事情"，如"我现在要解决 pandas 读取 CSV 乱码的问题，已经尝试过指定 encoding 参数"。

**存储介质**：Redis（Hash 结构）

**数据结构**：

```python
# key: working_memory:{agent_id}
# type: Redis Hash
{
    "agent_id":       "agent_001",
    "session_id":     "sess_abc123",
    "task_summary":   "帮用户分析 sales.csv，找出 Q3 异常数据",
    "current_plan":   '["step1: 加载CSV", "step2: 检查空值", "step3: 绘图"]',
    "completed_steps":'["step1"]',
    "known_facts":    '{"file_path": "/data/sales.csv", "rows": 12000}',
    "tool_results":   '{"read_csv": "success, 12000 rows loaded"}',
    "context_tokens": "3420",
    "created_at":     "2026-03-23T10:00:00Z",
    "updated_at":     "2026-03-23T10:05:30Z",
    "ttl_seconds":    "3600"
}
```

**WorkingMemoryManager 核心操作**：

```python
class WorkingMemoryManager:
    async def get(self, agent_id: str) -> WorkingMemory | None:
        """加载 Agent 的当前工作记忆"""

    async def set(self, agent_id: str, memory: WorkingMemory) -> None:
        """覆盖写入工作记忆（带 TTL）"""

    async def update_fields(self, agent_id: str, updates: dict) -> None:
        """更新部分字段（HSET），避免全量读写"""

    async def delete(self, agent_id: str) -> None:
        """任务结束时清理"""

    async def extend_ttl(self, agent_id: str, seconds: int = 3600) -> None:
        """长时间任务续期"""
```

**TTL 策略**：
- 默认 TTL：3600 秒（1小时）
- 长时任务每次工具调用后自动 extend_ttl
- 任务完成（Episode flush）后主动 delete

---

### 3.2 Episode Memory（情景记忆）

**定位**：Agent 经历过的具体任务事件流。**回答"我做过什么、遇到什么情况"**。

**类比**：人类的"昨天下午我修了一个 pandas 读 CSV 乱码的 bug，用了 encoding='gbk' 解决的"这类具体经历。

**存储介质**：Milvus（向量检索）+ OSS（原始内容）+ PostgreSQL（元数据/索引）

**Episode 数据结构**：

```python
@dataclass
class EpisodeRecord:
    # 标识
    episode_id:     str          # 唯一ID，格式：ep_{uuid4}
    agent_id:       str          # 所属 Agent
    session_id:     str          # 所属会话

    # 时间（双时间模型）
    event_time:     datetime     # 事件实际发生时间
    ingestion_time: datetime     # 写入系统的时间（用于审计）

    # 内容
    title:          str          # 简短标题，用于快速浏览（如"pandas CSV 乱码修复"）
    content:        str          # 完整内容（可能较长，存 OSS，content 存摘要或前512字）
    content_oss_key: str | None  # 若原始内容超过阈值，存 OSS，这里存路径

    # 语义信息
    embedding:      list[float]  # 512 或 1536 维向量（由 EmbeddingService 生成）

    # 评分与标签
    importance:     float        # 重要性分数 1.0-10.0（由 LLM 评估）
    tags:           list[str]    # 标签，如 ["pandas", "csv", "encoding"]
    outcome:        str          # "success" / "failure" / "partial"

    # 状态
    consolidated:   bool         # 是否已被 Consolidation 处理
    visibility:     str          # "private" / "team" / "org"
```

**写入流程（Memory Pipeline 调用 AMS）**：

```python
# Memory Pipeline 处理完一条 Evidence 后，调用：
POST /api/v1/memory/episodes
{
    "agent_id": "agent_001",
    "session_id": "sess_abc123",
    "event_time": "2026-03-23T10:05:00Z",
    "title": "CSV 乱码修复",
    "content": "用户反馈 pandas.read_csv 读取 sales.csv 出现乱码...",
    "importance": 7.5,
    "tags": ["pandas", "csv", "encoding"],
    "outcome": "success"
}
```

**检索流程（Agent Framework 调用 AMS）**：

```python
# Agent 执行新任务时，检索历史相似经历
POST /api/v1/memory/search
{
    "query": "pandas 读取 CSV 出现编码问题",
    "layers": ["episode"],
    "top_k": 5,
    "filters": {
        "agent_id": "agent_001",    # 可按 Agent 过滤
        "outcome": "success",       # 只看成功案例
        "time_range": "90d"         # 最近90天
    }
}
```

**EpisodeStore 核心操作**：

```python
class EpisodeStore:
    async def write(self, episode: EpisodeRecord) -> str:
        """写入一条 Episode，返回 episode_id

        内部流程：
        1. 若 content > 4KB，将原始内容存 OSS，记录 oss_key
        2. 将摘要/标题/embedding 写入 Milvus episode collection
        3. 将元数据（id、agent_id、time、tags等）写入 PostgreSQL episodes 表
        """

    async def search(
        self,
        query_vec: list[float],
        top_k: int = 10,
        filters: EpisodeFilter | None = None
    ) -> list[EpisodeRecord]:
        """向量检索 + 元数据过滤

        内部流程：
        1. Milvus ANN 检索（带 filters 作为 partition 或 boolean expr）
        2. 若需要 outcome/time_range 过滤，先 PostgreSQL 拿 id 列表，再 Milvus in 过滤
        3. 若需要原始内容（top 结果），从 OSS fetch
        """

    async def get_unconsolidated(
        self,
        agent_id: str,
        importance_threshold: float = 8.0
    ) -> list[EpisodeRecord]:
        """获取待整合的高重要性 Episode，供 ConsolidationEngine 使用"""

    async def mark_consolidated(self, episode_ids: list[str]) -> None:
        """整合完成后标记，避免重复处理"""
```

---

### 3.3 Procedural Memory（程序性记忆 / Skill 库）

**定位**：从历史 Episode 中提炼出的**可复用技能**。**回答"怎么处理这类问题"**。

**类比**：人类学会了"骑自行车"后，每次骑车不再需要回忆学习过程，而是直接调用技能。

**存储介质**：PostgreSQL（技能定义、版本、指标）+ Milvus（技能语义向量，用于匹配检索）

**Skill 数据结构**：

```python
@dataclass
class SkillRecord:
    # 标识
    skill_id:       str          # 格式：skill_{uuid4}
    name:           str          # 技能名，如 "pandas-encoding-fix"
    version:        int          # 版本号（自动递增）

    # 描述
    description:    str          # 自然语言描述，用于 LLM 理解该技能的用途
    trigger_intent: str          # 触发该技能的意图描述（用于向量匹配）

    # 执行定义
    workflow_steps: list[dict]   # 步骤列表，每步包含 action/tool/condition
    preconditions:  list[str]    # 使用该技能的前提条件

    # 质量指标
    success_rate:   float        # 历史成功率（0.0-1.0）
    usage_count:    int          # 被调用总次数
    avg_turns:      float        # 平均执行轮次
    p95_latency_ms: float        # P95 执行耗时（毫秒）

    # 关系
    derived_from:   list[str]    # 来源 Episode ID 列表
    supersedes:     str | None   # 替代了哪个旧版技能

    # 状态
    status:         str          # "active" / "deprecated" / "candidate"
    created_at:     datetime
    updated_at:     datetime

    # 向量（供 Milvus 检索）
    embedding:      list[float]  # 基于 description + trigger_intent 生成
```

**SkillStore 核心操作**：

```python
class SkillStore:
    async def search(
        self,
        query_vec: list[float],
        top_k: int = 5,
        status: str = "active"
    ) -> list[SkillRecord]:
        """技能语义检索

        先在 Milvus 中用 query_vec ANN，再用 PostgreSQL 补充元数据
        """

    async def get_by_name(self, name: str) -> SkillRecord | None:
        """精确查询（版本A已有该能力，取最新 active 版本）"""

    async def upsert(self, skill: SkillRecord) -> str:
        """写入或更新技能

        若 name 已存在：version+1，旧版 status 改为 deprecated
        若不存在：新建 skill_id，version=1
        """

    async def update_metrics(
        self,
        skill_id: str,
        success: bool,
        turns: int,
        latency_ms: float
    ) -> None:
        """每次技能执行后更新统计指标（PostgreSQL UPDATE）"""
```

**技能检索与使用示例**：

```python
# 场景：Agent 遇到 "CSV encoding error" 任务
# Agent Framework 在 Think Node 中会自动检索相关技能：

skills = await memory_client.search_memory(
    query="pandas 读 CSV 编码问题",
    layers=[MemoryLayer.PROCEDURAL],
    top_k=3
)

# 返回：
# [
#   SkillRecord(name="pandas-encoding-fix",
#               description="...",
#               workflow_steps=[
#                 {"step": 1, "action": "检测文件编码", "tool": "chardet.detect"},
#                 {"step": 2, "action": "用检测到的编码重新读取", "tool": "pd.read_csv"},
#               ],
#               success_rate=0.92, usage_count=37),
#   ...
# ]

# Agent 将技能步骤注入到 system prompt 中，直接按步骤执行
```

---

### 3.4 Semantic Memory（语义记忆）

**定位**：领域事实性知识库，采用 5 层 GraphRAG 结构。**回答"这是什么、事物间什么关系"**。

**类比**：教科书和百科全书——不是"我做过什么"，而是"客观上是什么"。

**存储介质**：
- **Block 向量**：Milvus（`semantic_blocks` collection）
- **Section/Community Summary**：PostgreSQL（`semantic_summaries` 表）
- **实体节点 + 关系**：Neo4j
- **Block 原始内容**：OSS（大文档）

**5层结构与存储映射**：

```
┌──────────────────────────────────────────────────────────────────┐
│  Community Summary（社区综合摘要）                                 │
│  存储：PostgreSQL semantic_summaries（type='community'）           │
│  产生：Leiden 聚类后，LLM 对社区内所有实体及关联内容生成摘要         │
│  用于：宏观问题检索（"介绍一下XX相关的整体情况"）                   │
├──────────────────────────────────────────────────────────────────┤
│  Section Summary（章节摘要）                                       │
│  存储：PostgreSQL semantic_summaries（type='section'）            │
│  产生：多个相邻 Block 汇聚后 LLM 摘要                              │
│  用于：主题检索，中等粒度问答                                       │
├──────────────────────────────────────────────────────────────────┤
│  Block（内容块）⬅ 核心，真实内容存放层                              │
│  存储：Milvus semantic_blocks + OSS（原文）                       │
│  产生：文档切片（512~1024 tokens）+ Embedding                     │
│  用于：精确局部检索（传统 RAG 场景）                                │
├──────────────────────────────────────────────────────────────────┤
│  Phrase Node（实体节点）                                           │
│  存储：Neo4j（:PhraseNode 节点）                                   │
│  产生：从 Block 中 NER 提取实体（人物、地点、概念、产品等）           │
│  用于：实体查询、关系遍历、构建 Community                           │
├──────────────────────────────────────────────────────────────────┤
│  Community Node（实体社区）                                        │
│  存储：Neo4j（:CommunityNode 节点）                                │
│  产生：对 Phrase Node 图运行 Leiden 算法聚类                       │
│  用于：为 Community Summary 提供结构骨架                           │
└──────────────────────────────────────────────────────────────────┘
```

**PostgreSQL 表：semantic_summaries**

```sql
CREATE TABLE semantic_summaries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary_type VARCHAR(20) NOT NULL,  -- 'section' | 'community'
    title        TEXT,
    content      TEXT NOT NULL,         -- 摘要正文
    embedding    vector(1536),          -- pgvector（用于摘要级检索，补充 Milvus）
    source_ids   JSONB,                 -- 来源 block_ids 或 community_node_ids
    agent_id     VARCHAR(100),          -- 若是 Agent 特有知识，记录归属
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    meta         JSONB
);
```

**Neo4j Schema**：

```cypher
// 实体节点
(:PhraseNode {
    node_id:       "pn_abc123",
    phrase:        "pandas",
    phrase_type:   "LIBRARY",     // PERSON / ORG / CONCEPT / LIBRARY / ...
    canonical_form:"pandas",
    aliases:       ["pd", "pandas库"],
    community_id:  "cn_xyz",
    mention_count: 42,
    source_block_ids: ["blk_001", "blk_002"]
})

// 实体间关系
(:PhraseNode)-[:RELATED_TO {weight: 0.8, relation_type: "USED_WITH"}]->(:PhraseNode)
(:PhraseNode)-[:BELONGS_TO]->(:CommunityNode)

// 社区节点
(:CommunityNode {
    community_id:    "cn_xyz",
    level:           1,            // 层级，0=叶子社区, 1=上级社区
    member_count:    8,
    summary:         "数据处理与分析工具社区...",
    summary_embedding: [...]       // 1536维
})
```

**SemanticMemoryStore 核心操作**：

```python
class SemanticMemoryStore:
    async def search_blocks(
        self,
        query_vec: list[float],
        top_k: int = 10,
        filters: dict | None = None
    ) -> list[BlockResult]:
        """Block 层精确向量检索（Milvus）"""

    async def search_summaries(
        self,
        query_vec: list[float],
        summary_type: str = "section",
        top_k: int = 5
    ) -> list[SummaryResult]:
        """摘要层检索（Milvus 或 PostgreSQL pgvector）"""

    async def search_graph(
        self,
        entity_name: str,
        hops: int = 2
    ) -> list[GraphResult]:
        """Neo4j 图遍历，返回实体及其关联关系"""

    async def ingest_block(self, block: BlockRecord) -> str:
        """写入一个 Block（Memory Pipeline 调用）

        内部流程：
        1. 生成 Block embedding
        2. 写入 Milvus semantic_blocks collection
        3. 原始内容 > 4KB 时存 OSS，block 记录 oss_key
        4. 写入 PostgreSQL blocks 元数据表
        5. 触发异步任务：NER 提取 → Neo4j 写入
        """

    async def ingest_entities(
        self,
        entities: list[PhraseNode],
        relations: list[EntityRelation]
    ) -> None:
        """写入实体和关系到 Neo4j（Memory Pipeline 在 NER 后调用）"""

    async def build_community_summary(
        self,
        community_id: str
    ) -> SummaryRecord:
        """为指定 Community 生成摘要（由 Community 检测后触发）

        内部流程：
        1. 从 Neo4j 查询 community 的所有 Phrase Node
        2. 从 Milvus/OSS 获取关联 Block 内容
        3. 调用 LLM 生成综合摘要
        4. 写入 PostgreSQL semantic_summaries
        """
```

---

## 4. 多路检索设计

### 4.1 检索路径总览

AMS 对每次 `search` 请求，并行执行最多5条检索路径（按请求的 `layers` 参数选择）：

| 路径 | 数据源 | 检索方式 | 适合场景 | 延迟 |
|------|--------|---------|---------|------|
| **路径1：Block 向量检索** | Milvus `semantic_blocks` | ANN | 精确局部知识 | ~15ms |
| **路径2：摘要检索** | PostgreSQL `semantic_summaries` | pgvector ANN | 主题概述、宏观问题 | ~25ms |
| **路径3：图遍历** | Neo4j | Cypher MATCH | 实体关系推理 | ~30ms |
| **路径4：技能检索** | Milvus `skills` | ANN + PG filter | 已知处理方法 | ~15ms |
| **路径5：Episode 检索** | Milvus `episodes` | ANN + time filter | 历史经验 | ~20ms |

### 4.2 并行执行与融合

```python
class MultiPathRetriever:
    async def search(
        self,
        query: str,
        layers: list[MemoryLayer],
        top_k: int = 10,
        agent_id: str | None = None,
        filters: dict | None = None
    ) -> list[MemorySearchResult]:
        """并行多路检索，结果融合后返回"""

        # 1. 生成查询向量（EmbeddingService，缓存10分钟）
        query_vec = await self.embedding_svc.embed(query)

        # 2. 根据 layers 决定并发任务
        tasks = []
        if MemoryLayer.SEMANTIC in layers:
            tasks.append(self.semantic_store.search_blocks(query_vec, top_k))
            tasks.append(self.semantic_store.search_summaries(query_vec, top_k=3))
        if MemoryLayer.PROCEDURAL in layers:
            tasks.append(self.skill_store.search(query_vec, top_k=5))
        if MemoryLayer.EPISODE in layers:
            tasks.append(self.episode_store.search(query_vec, top_k=5,
                         filters={"agent_id": agent_id}))
        if MemoryLayer.WORKING in layers and agent_id:
            tasks.append(self.working_memory.get(agent_id))  # 不需要向量

        # 3. 并发执行（asyncio.gather，统一超时 500ms）
        raw_results = await asyncio.gather(*tasks, return_exceptions=True)

        # 4. 过滤异常，合并去重
        merged = self._merge_and_dedup(raw_results)

        # 5. 混合评分（相关性 + 时效性 + 重要性）
        scored = self.scorer.score(merged, query_vec)

        # 6. 按分数排序，取 top_k
        return sorted(scored, key=lambda x: x.score, reverse=True)[:top_k]
```

### 4.3 混合评分公式

```python
def score(self, result: RawResult, query_vec: list[float]) -> float:
    """
    混合评分 = 0.6 × relevance + 0.3 × recency + 0.1 × importance

    relevance：向量余弦相似度（来自 Milvus 的 distance 转换）
    recency：时效性衰减，半衰期24小时：exp(-λt)，λ = ln(2)/24
    importance：归一化的重要性分数（原始 1-10，归一化到 0-1）
    """
    relevance  = result.vector_score         # 0.0 - 1.0
    recency    = self._recency_decay(result.created_at)
    importance = (result.importance - 1) / 9  # 1-10 → 0-1

    return 0.6 * relevance + 0.3 * recency + 0.1 * importance
```

---

## 5. 整合引擎（ConsolidationEngine）

### 5.1 整合的作用

整合（Consolidation）是将 Episode Memory 中的具体经历提炼为更高层次知识的过程：

```
高重要性 Episode（importance >= 8）
        ↓ 整合
新的 Skill（如果发现可复用的处理模式）   →  写入 Procedural Memory
新的 Section/Community Summary          →  写入 Semantic Memory
```

### 5.2 触发条件

| 触发类型 | 条件 | 处理方式 |
|---------|------|---------|
| **即时触发** | Episode importance >= 8.0（高价值经历）| 5分钟内异步处理 |
| **批量触发** | 每100条 Episode 累积（周期计数）| 批量整合 |
| **定时触发** | 每日 02:00（定时任务）| 全量扫描未整合的 Episode |

### 5.3 整合流程

```python
class ConsolidationEngine:
    async def run_consolidation(
        self,
        agent_id: str,
        time_window: str = "7d"
    ) -> ConsolidationResult:
        """
        整合流程：
        1. 从 EpisodeStore 取出 consolidated=False 且 importance >= threshold 的 Episode
        2. 对 Episode 列表调用 LLM 进行模式分析：
           - 是否存在可复用的处理模式？→ 生成 Skill 候选
           - 是否有新的知识点？→ 生成 Knowledge Block 候选
           - 成功经验与失败原因？
        3. 质量门禁（Quality Gate）：
           - Skill 候选：success_rate >= 0.75 才写入 Procedural Memory
           - Knowledge Block：相似度 < 0.9（不重复）才写入 Semantic Memory
        4. 写入对应记忆层
        5. 标记 Episode 为 consolidated=True
        """
```

**整合示例**：

```python
# Agent 连续3次遇到 CSV 编码问题，都用 chardet + gbk 解决（importance 均 > 8）
# ConsolidationEngine 在批量触发时：
#   发现共同模式 → 生成技能候选：
#   {
#       "name": "csv-encoding-diagnosis",
#       "description": "诊断并修复 CSV 文件编码问题",
#       "workflow_steps": [
#           {"step": 1, "action": "用 chardet.detect() 检测编码"},
#           {"step": 2, "action": "用检测到的编码调用 pd.read_csv(encoding=...)"},
#           {"step": 3, "action": "验证读取结果的行数是否符合预期"}
#       ],
#       "success_rate": 1.0,   # 3次全部成功
#       "derived_from": ["ep_001", "ep_002", "ep_003"]
#   }
#   → 通过 Quality Gate，写入 SkillStore
```

---

## 6. REST API 完整设计

### 6.1 接口总览

| 方法 | 路径 | 说明 | 调用方 |
|------|------|------|--------|
| GET  | `/api/v1/memory/working/{agent_id}` | 获取工作记忆 | Agent Framework |
| PUT  | `/api/v1/memory/working/{agent_id}` | 更新工作记忆 | Agent Framework |
| DELETE | `/api/v1/memory/working/{agent_id}` | 清除工作记忆 | Agent Framework |
| POST | `/api/v1/memory/episodes` | 写入一条 Episode | Memory Pipeline |
| POST | `/api/v1/memory/knowledge` | 写入 Block/实体 | Memory Pipeline |
| POST | `/api/v1/memory/search` | 多层记忆检索 | Agent Framework |
| POST | `/api/v1/memory/consolidate` | 触发整合 | 定时任务 / 管理接口 |
| GET  | `/api/v1/memory/stats/{agent_id}` | 记忆统计 | 运维监控 |
| GET  | `/health` | 健康检查 | K8s liveness probe |

### 6.2 核心接口详细定义

#### POST `/api/v1/memory/search`

**请求**：

```json
{
  "query": "pandas 读 CSV 出现乱码怎么处理",
  "agent_id": "agent_001",
  "layers": ["working", "episode", "procedural", "semantic"],
  "top_k": 10,
  "filters": {
    "time_range": "90d",
    "outcome": "success",
    "visibility": ["private", "team"]
  },
  "options": {
    "enable_rerank": true,
    "include_working_memory": true
  }
}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "results": [
      {
        "memory_id": "ep_abc123",
        "layer": "episode",
        "title": "CSV 乱码修复（gbk编码）",
        "content": "用户反馈 pandas.read_csv 读 sales.csv 出现乱码，经 chardet 检测为 gbk 编码，用 encoding='gbk' 参数解决",
        "score": 0.91,
        "importance": 8.5,
        "created_at": "2026-03-20T14:30:00Z",
        "metadata": {
          "tags": ["pandas", "csv", "encoding", "gbk"],
          "outcome": "success"
        }
      },
      {
        "memory_id": "skill_xyz456",
        "layer": "procedural",
        "title": "csv-encoding-diagnosis 技能",
        "content": "步骤1: chardet.detect()检测编码; 步骤2: pd.read_csv(encoding=...); 步骤3: 验证行数",
        "score": 0.87,
        "importance": 9.2,
        "created_at": "2026-03-21T02:00:00Z",
        "metadata": {
          "success_rate": 0.94,
          "usage_count": 12
        }
      }
    ],
    "total": 2,
    "latency_ms": 68,
    "paths_used": ["episode", "procedural", "semantic_block"]
  }
}
```

#### PUT `/api/v1/memory/working/{agent_id}`

**请求**：

```json
{
  "task_summary": "帮用户分析 sales.csv 中 Q3 的异常数据",
  "current_plan": ["加载CSV", "检查空值", "统计Q3数据", "绘制箱型图"],
  "completed_steps": ["加载CSV"],
  "known_facts": {
    "file_path": "/data/sales.csv",
    "rows": 12000,
    "encoding": "gbk"
  },
  "ttl_seconds": 7200
}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "agent_id": "agent_001",
    "updated_at": "2026-03-23T10:05:30Z",
    "ttl_expires_at": "2026-03-23T12:05:30Z"
  }
}
```

#### POST `/api/v1/memory/episodes`

**请求（Memory Pipeline 调用）**：

```json
{
  "agent_id": "agent_001",
  "session_id": "sess_abc123",
  "event_time": "2026-03-23T10:05:00Z",
  "title": "CSV 乱码修复",
  "content": "完整的执行过程描述...(可能较长)",
  "importance": 8.5,
  "tags": ["pandas", "csv", "encoding"],
  "outcome": "success",
  "visibility": "private"
}
```

#### POST `/api/v1/memory/knowledge`

**请求（Memory Pipeline 写入 Block/实体）**：

```json
{
  "type": "block",           // "block" | "entities" | "section_summary" | "community_summary"
  "agent_id": "agent_001",
  "content": "pandas.read_csv() 函数支持通过 encoding 参数指定字符编码...",
  "source_url": "https://pandas.pydata.org/docs/...",
  "metadata": {
    "chunk_index": 3,
    "source_doc_id": "doc_pandas_guide"
  }
}
```

### 6.3 错误码规范

| 错误码 | HTTP状态码 | 含义 |
|--------|-----------|------|
| 0 | 200 | 成功 |
| 1001 | 400 | 请求参数错误（缺少必填字段等）|
| 1002 | 404 | 资源不存在（agent_id 无对应记忆）|
| 2001 | 503 | Milvus 不可用 |
| 2002 | 503 | PostgreSQL 不可用 |
| 2003 | 503 | Redis 不可用 |
| 5001 | 500 | 内部处理异常 |

---

## 7. 跨服务交互完整说明

### 7.1 Agent Framework → AMS 的典型调用序列

以一次完整的 Agent 任务执行为例：

```
时间轴            Agent Framework                 AMS
────────────────────────────────────────────────────────────
T=0   任务启动    GET /working/{agent_id}      →  返回：无（新任务）
                  POST /memory/search           →  返回：相关历史经验、相关技能
                  PUT /working/{agent_id}       →  写入初始任务状态

T=5s  执行中      PUT /working/{agent_id}       →  更新 completed_steps
（每次工具调用）   PUT /working/{agent_id}       →  更新 known_facts

T=30s 任务完成    DELETE /working/{agent_id}    →  清除工作记忆
（Episode flush） （通知 Memory Pipeline 处理）   →  （Pipeline 异步写入 Episode）
────────────────────────────────────────────────────────────
```

### 7.2 Memory Pipeline → AMS 的调用序列

```
Memory Pipeline（Kafka Consumer）
    │
    │  消费到一条 Evidence 消息
    │  ↓ 处理（NER、Embedding、重要性打分）
    │
    ├──→ POST /api/v1/memory/episodes     # 写入 Episode
    │         （内容过长时 AMS 内部自动存 OSS）
    │
    └──→ POST /api/v1/memory/knowledge    # 写入 Block（知识文档场景）
              （AMS 内部触发异步：NER → Neo4j 写入）
              （AMS 内部异步检查整合条件）
```

### 7.3 AMS 内部异步任务

某些操作 AMS 会在后台异步执行（不阻塞API响应）：

| 触发事件 | 异步任务 | 执行时机 |
|---------|---------|---------|
| 写入 Block | NER 实体提取 → Neo4j 写入 | 写入后 < 5s |
| 积累100个实体 | Leiden 社区检测 | 批量触发 |
| 社区检测完成 | Community Summary 生成 | 社区检测后 |
| Episode importance >= 8 | 即时整合触发 | 写入后 < 5min |

---

## 8. 数据库索引与 Milvus Collection 设计

### 8.1 Milvus Collections

**Collection 1：`episodes`**

```python
episode_collection = CollectionSchema(fields=[
    FieldSchema("episode_id",   DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("agent_id",     DataType.VARCHAR, max_length=64),
    FieldSchema("embedding",    DataType.FLOAT_VECTOR, dim=1536),
    FieldSchema("importance",   DataType.FLOAT),
    FieldSchema("event_time",   DataType.INT64),   # Unix timestamp
    FieldSchema("outcome",      DataType.VARCHAR,  max_length=20),
    FieldSchema("consolidated", DataType.BOOL),
])
# 索引：embedding 字段使用 HNSW，M=16, efConstruction=200
```

**Collection 2：`semantic_blocks`**

```python
block_collection = CollectionSchema(fields=[
    FieldSchema("block_id",    DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("agent_id",    DataType.VARCHAR, max_length=64),  # 可为空（公共知识库）
    FieldSchema("embedding",   DataType.FLOAT_VECTOR, dim=1536),
    FieldSchema("source_type", DataType.VARCHAR, max_length=20),  # "doc" | "episode_derived"
    FieldSchema("created_at",  DataType.INT64),
])
```

**Collection 3：`skills`**

```python
skill_collection = CollectionSchema(fields=[
    FieldSchema("skill_id",    DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("embedding",   DataType.FLOAT_VECTOR, dim=1536),  # trigger_intent embedding
    FieldSchema("status",      DataType.VARCHAR, max_length=20),
    FieldSchema("success_rate",DataType.FLOAT),
])
```

### 8.2 PostgreSQL 核心表索引

```sql
-- episodes 表（存元数据，Milvus 存向量）
CREATE INDEX idx_episodes_agent_id ON episodes(agent_id);
CREATE INDEX idx_episodes_event_time ON episodes(event_time DESC);
CREATE INDEX idx_episodes_consolidated ON episodes(consolidated) WHERE consolidated = FALSE;
CREATE INDEX idx_episodes_importance ON episodes(importance DESC);

-- skills 表
CREATE INDEX idx_skills_name_status ON skills(name, status);
CREATE INDEX idx_skills_success_rate ON skills(success_rate DESC);

-- semantic_summaries 表
CREATE INDEX idx_summaries_type ON semantic_summaries(summary_type);
-- pgvector 索引（用于摘要级语义检索，数据量有限，可用 pg 而非 Milvus）
CREATE INDEX idx_summaries_embedding ON semantic_summaries
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

---

## 9. 部署与配置

### 9.1 服务部署规格

| 环境 | 副本数 | CPU | 内存 | 说明 |
|------|--------|-----|------|------|
| 开发/测试 | 1 | 0.5c | 512Mi | 单机即可 |
| 生产（小规模）| 2 | 2c | 2Gi | 支持~100 QPS |
| 生产（中规模）| 4 | 4c | 4Gi | 支持~500 QPS |

### 9.2 环境变量配置

```yaml
# agent-memory-system ConfigMap
REDIS_URL: "redis://redis.storage:6379/0"
MILVUS_HOST: "milvus-proxy.storage.svc.cluster.local"
MILVUS_PORT: "19530"
POSTGRES_DSN: "postgresql://ams_user:xxx@pg.storage:5432/agent_memory"
NEO4J_URI: "bolt://neo4j.storage:7687"
NEO4J_USER: "neo4j"
NEO4J_PASSWORD: "${NEO4J_PASSWORD}"
OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com"
OSS_BUCKET: "agent-memory-store"
EMBEDDING_MODEL: "text-embedding-3-small"   # OpenAI / 本地模型
EMBEDDING_DIM: "1536"
RERANKER_MODEL: "BAAI/bge-reranker-large"
LOG_LEVEL: "INFO"
```

### 9.3 健康检查与 SLA

**Liveness Probe**：`GET /health` 返回200（仅检查进程存活）

**Readiness Probe**：`GET /health/ready` 检查所有下游连接（Redis、Milvus、PostgreSQL、Neo4j 均可达才 Ready）

**SLA 目标**：
- API 可用性：99.9%
- `/memory/search` P95 延迟：< 200ms
- `/memory/working/*` P95 延迟：< 20ms（Redis 操作）
- 吞吐量：1000 QPS（水平扩展可线性提升）

---

## 10. 开发者快速上手

### 10.1 本地开发启动

```bash
# 启动依赖（Docker Compose）
docker-compose up redis milvus postgresql neo4j

# 启动 AMS
cd agent_memory_system
pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

### 10.2 Python Client SDK 示例

```python
from agent_memory_client import MemoryAPIClient, MemoryLayer

# 初始化（Agent Framework 内部使用）
client = MemoryAPIClient(
    base_url="http://agent-memory-system.agent-apps.svc:8080",
    agent_id="agent_001"
)

# 1. 任务开始：检索相关记忆
results = await client.search(
    query="如何处理 CSV 编码问题",
    layers=[MemoryLayer.EPISODE, MemoryLayer.PROCEDURAL],
    top_k=5
)
for r in results:
    print(f"[{r.layer}] {r.title} (score={r.score:.2f})")

# 2. 更新工作记忆
await client.update_working_memory({
    "task_summary": "修复 CSV 乱码问题",
    "current_plan": ["检测编码", "重新读取", "验证"],
    "known_facts": {"file": "sales.csv"}
})

# 3. 任务完成：清理工作记忆（Episode 由 Pipeline 异步处理）
await client.clear_working_memory()
```

---

*下一步：[02-Agent-Framework 详细设计](./02-Agent-Framework.md) — 了解 Agent Framework 如何集成并调用 AMS*
