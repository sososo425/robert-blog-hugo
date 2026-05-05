---
title: "04-Storage-and-Retrieval 详细设计"
date: 2026-03-23T20:00:00+08:00
draft: true
tags: ["agent-memory", "storage", "retrieval", "milvus", "neo4j", "详细设计", "版本B"]
---

# Storage & Retrieval 详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: AMS 的存储实现细节，以及多路融合检索策略

---

## 1. 存储架构总览

### 1.1 技术栈选型

| 存储职责 | 技术 | 版本 | 理由 |
|---------|------|------|------|
| Working Memory | **Redis** | 7.x | 亚毫秒延迟，原生 Hash + TTL，支持 Pub/Sub |
| Episode 向量检索 | **Milvus** | 2.4+ | 企业级向量数据库，支持大规模分布式部署，与业务基础设施对齐 |
| Semantic Block 向量检索 | **Milvus** | 2.4+ | 同上；Block 量大，需水平扩展 |
| Skill 语义检索 | **Milvus** | 2.4+ | 统一在 Milvus 管理向量，简化运维 |
| Episode 原始内容 | **OSS** | — | 大文件存储，与现有基础设施对齐（非 S3） |
| Skill 元数据、指标 | **PostgreSQL** | 15.x | 结构化查询、ACID、复杂条件过滤 |
| Section/Community Summary | **PostgreSQL + pgvector** | 15.x | 摘要数量有限（千~万级），pgvector 足够；复杂查询需要关系型 |
| 知识图谱（实体+关系） | **Neo4j** | 5.x | 图遍历、Leiden 社区检测算法原生支持 |
| 执行轨迹时序 | **ClickHouse** | 24.x | 列式存储，时序聚合查询高效 |
| 消息队列 | **Kafka** | 3.x | 解耦 Agent Framework 与 MPP |

> **关于 LanceDB 的说明**：版本B中 LanceDB 不用于主存储路径。但如果将来有多模态（视频帧、图像向量）的 lance file 格式原始数据需要处理（与之前多模态数据湖工作衔接），可在 multimodal lake 层引入 LanceDB，不影响核心 AMS 存储架构。

### 1.2 各存储层的数据量估算

| 存储 | 数据类型 | 条目规模（中等场景）| 向量维度 |
|------|---------|--------------|---------|
| Redis | Working Memory | ~1K 并发 Agent | — |
| Milvus `episodes` | Episode 向量 | 百万级 | 1536 |
| Milvus `semantic_blocks` | Block 向量 | 千万级 | 1536 |
| Milvus `skills` | Skill 向量 | 万级 | 1536 |
| PostgreSQL `skills` | Skill 元数据 | 万级 | — |
| PostgreSQL `semantic_summaries` | Section + Community 摘要 | 万~百万级 | 1536 (pgvector) |
| Neo4j | Phrase Node + Edge | 百万节点，千万边 | — |
| OSS | Episode 原始内容 | TB级 | — |
| ClickHouse | 执行轨迹 | 亿级行 | — |

---

## 2. Redis — Working Memory

### 2.1 数据结构

Working Memory 使用 Redis Hash 结构，每个 Agent 一个 key。

```
key:   working_memory:{agent_id}
type:  Redis Hash
TTL:   默认 3600 秒，执行中每轮续期
```

**Hash Fields**：

```
agent_id         VARCHAR   所属 Agent ID
session_id       VARCHAR   当前会话 ID
task_summary     TEXT      任务摘要（< 500 chars）
current_plan     JSON      计划步骤列表
completed_steps  JSON      已完成步骤
known_facts      JSON      执行中积累的事实（键值对）
tool_results     JSON      最近几次工具调用结果
context_tokens   INT       当前 context window 占用量
created_at       DATETIME  创建时间
updated_at       DATETIME  最近更新时间
```

### 2.2 操作模式

```
读：HGETALL working_memory:{agent_id}      <1ms
写：HSET working_memory:{agent_id} field value + EXPIRE ... 3600   <1ms
清：DEL working_memory:{agent_id}
```

### 2.3 高可用配置

生产环境建议 Redis Sentinel（3节点）或 Redis Cluster，避免单点：
- 主从复制延迟 < 1ms
- 故障转移时间 < 30s
- Working Memory 数据允许短暂丢失（Agent 可重新初始化）

---

## 3. Milvus — 向量检索

### 3.1 Collection 设计

#### Collection 1：`episodes`

用于存储 Episode 的向量表示，支持语义检索历史经历。

```python
from pymilvus import CollectionSchema, FieldSchema, DataType

episode_fields = [
    FieldSchema("episode_id",    DataType.VARCHAR,  max_length=64,  is_primary=True),
    FieldSchema("agent_id",      DataType.VARCHAR,  max_length=64),
    FieldSchema("visibility",    DataType.VARCHAR,  max_length=20),  # private/team/org
    FieldSchema("outcome",       DataType.VARCHAR,  max_length=20),  # success/failure/partial
    FieldSchema("importance",    DataType.FLOAT),                    # 1.0-10.0
    FieldSchema("event_time",    DataType.INT64),                    # Unix timestamp
    FieldSchema("consolidated",  DataType.BOOL),
    FieldSchema("embedding",     DataType.FLOAT_VECTOR, dim=1536),
]

# 索引策略：HNSW（高召回率，适合需要精度的检索场景）
# M=16, efConstruction=200, ef=100
```

**查询示例**（按 agent_id 过滤 + 时间范围过滤）：

```python
# 检索某 Agent 最近90天的成功 Episode，语义相似 TOP 5
results = collection.search(
    data=[query_embedding],
    anns_field="embedding",
    param={"metric_type": "COSINE", "params": {"ef": 100}},
    limit=10,
    expr='agent_id == "agent_001" and outcome == "success" '
         'and event_time > 1700000000',  # 90天前的 unix timestamp
    output_fields=["episode_id", "importance", "event_time", "outcome"]
)
```

#### Collection 2：`semantic_blocks`

用于存储知识文档切片（Block）的向量，是 RAG 检索的核心。

```python
block_fields = [
    FieldSchema("block_id",     DataType.VARCHAR,  max_length=64,  is_primary=True),
    FieldSchema("agent_id",     DataType.VARCHAR,  max_length=64),   # 可为空（公共知识）
    FieldSchema("doc_id",       DataType.VARCHAR,  max_length=64),   # 来源文档
    FieldSchema("block_type",   DataType.VARCHAR,  max_length=20),   # text/table/img
    FieldSchema("chunk_index",  DataType.INT32),                     # 在文档中的序号
    FieldSchema("has_oss_content", DataType.BOOL),                   # 内容是否在 OSS
    FieldSchema("created_at",   DataType.INT64),
    FieldSchema("embedding",    DataType.FLOAT_VECTOR, dim=1536),
]

# 索引：IVF_HNSW，适合大规模（千万级）Block 的高效检索
# nlist=4096, M=16, efConstruction=200
```

**多模态 Block 处理说明**（基于图3实际内容）：

| Block 类型 | 内容 | Embedding 生成方式 |
|-----------|------|-----------------|
| `text` | raw text | 直接文本 embedding |
| `table` | 表格（CSV/Markdown格式）| 将表格序列化为文本后 embedding；同时可触发 vector clustering（图3中的 `cluster 1..n`）|
| `img` | 图像 | 使用多模态 embedding 模型（如 CLIP）生成向量；alt text 也做文本 embedding |

#### Collection 3：`skills`

用于技能的语义检索。

```python
skill_fields = [
    FieldSchema("skill_id",      DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("status",        DataType.VARCHAR, max_length=20),  # active/deprecated
    FieldSchema("success_rate",  DataType.FLOAT),
    FieldSchema("embedding",     DataType.FLOAT_VECTOR, dim=1536),  # trigger_intent embedding
]
```

### 3.2 分区策略

对于 `semantic_blocks`（数据量最大），按 `agent_id` 做分区（Milvus Partition）：

```python
# 创建分区：公共知识库 + 各 Agent 私有知识
collection.create_partition("public")        # 公共知识（无 agent_id）
collection.create_partition("agent_001")     # agent_001 的私有知识
collection.create_partition("agent_002")
# ...

# 检索时指定分区范围（减少检索范围，提升性能）
results = collection.search(
    ...,
    partition_names=["public", "agent_001"]  # 同时搜公共和私有
)
```

---

## 4. PostgreSQL — 结构化元数据与摘要

### 4.1 核心表结构

#### episodes 表（Episode 元数据）

```sql
CREATE TABLE episodes (
    episode_id       VARCHAR(64) PRIMARY KEY,
    agent_id         VARCHAR(64) NOT NULL,
    session_id       VARCHAR(64),
    event_time       TIMESTAMPTZ NOT NULL,
    ingestion_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    title            TEXT NOT NULL,
    content_preview  TEXT,            -- 前512字预览（完整内容在 OSS）
    content_oss_key  VARCHAR(512),    -- OSS 路径（内容 > 4KB 时）
    importance       DECIMAL(4,1),
    outcome          VARCHAR(20),
    tags             TEXT[],          -- PostgreSQL 数组类型
    consolidated     BOOLEAN DEFAULT FALSE,
    visibility       VARCHAR(20) DEFAULT 'private',
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_episodes_agent_time ON episodes(agent_id, event_time DESC);
CREATE INDEX idx_episodes_unconsolidated ON episodes(consolidated, importance)
    WHERE consolidated = FALSE;
CREATE INDEX idx_episodes_tags ON episodes USING GIN(tags);
```

#### skills 表（技能库）

```sql
CREATE TABLE skills (
    skill_id         VARCHAR(64) PRIMARY KEY,
    name             VARCHAR(200) UNIQUE NOT NULL,
    version          INT NOT NULL DEFAULT 1,
    description      TEXT NOT NULL,
    trigger_intent   TEXT NOT NULL,    -- 触发意图描述（用于 Milvus embedding）
    workflow_steps   JSONB NOT NULL,   -- 步骤定义数组
    preconditions    TEXT[],

    -- 质量指标
    success_rate     DECIMAL(4,3) DEFAULT 0,
    usage_count      INT DEFAULT 0,
    avg_turns        DECIMAL(6,2),
    p95_latency_ms   DECIMAL(10,2),
    recent_results   JSONB,            -- 最近20次结果（滑动窗口，用于降级检测）

    -- 关系
    derived_from     TEXT[],           -- 来源 Episode IDs
    supersedes       VARCHAR(64),      -- 被替代的旧 skill_id

    -- 状态
    status           VARCHAR(20) DEFAULT 'candidate',  -- candidate/active/deprecated
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skills_name_status ON skills(name, status);
CREATE INDEX idx_skills_success_rate ON skills(success_rate DESC) WHERE status = 'active';
```

#### semantic_summaries 表（Section / Community 摘要）

```sql
CREATE TABLE semantic_summaries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary_type     VARCHAR(30) NOT NULL,
    -- 'section_l1'：Level 1 Section Summary（汇聚若干 Block）
    -- 'section_l2'：Level 2 Section Summary（汇聚若干 Level 1 Summary）
    -- 'community'：Community Node Summary（实体社区摘要）

    title            TEXT,
    content          TEXT NOT NULL,       -- 摘要正文
    embedding        VECTOR(1536),        -- pgvector 索引，供摘要级检索

    -- 来源
    source_block_ids  TEXT[],             -- 对于 section 摘要：来源 Block IDs
    source_summary_ids TEXT[],            -- 对于 level 2：来源 level 1 summary IDs
    community_id      VARCHAR(64),        -- 对于 community：对应的 Neo4j community ID
    member_phrases    TEXT[],             -- 对于 community：成员实体名称列表

    agent_id         VARCHAR(64),         -- 私有知识时记录归属，公共知识为 NULL
    doc_id           VARCHAR(64),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    meta             JSONB
);

CREATE INDEX idx_summaries_type ON semantic_summaries(summary_type);
CREATE INDEX idx_summaries_community_id ON semantic_summaries(community_id);
-- pgvector 近似索引（摘要量级在万~百万，ivfflat 足够）
CREATE INDEX idx_summaries_embedding ON semantic_summaries
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);
```

#### semantic_blocks 表（Block 元数据，向量在 Milvus）

```sql
CREATE TABLE semantic_blocks (
    block_id         VARCHAR(64) PRIMARY KEY,
    doc_id           VARCHAR(64),
    agent_id         VARCHAR(64),
    block_type       VARCHAR(20) NOT NULL,  -- text/table/img
    chunk_index      INT,
    content          TEXT,                  -- < 4KB 直存；否则存 OSS
    content_oss_key  VARCHAR(512),
    tags             TEXT[],
    source_url       TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    meta             JSONB
);

CREATE INDEX idx_blocks_doc_id ON semantic_blocks(doc_id);
CREATE INDEX idx_blocks_agent_id ON semantic_blocks(agent_id);
```

---

## 5. Neo4j — 知识图谱

### 5.1 Schema 设计

```cypher
// ── 实体节点 ──────────────────────────────────────────
CREATE CONSTRAINT phrase_node_id ON (n:PhraseNode) ASSERT n.node_id IS UNIQUE;

// PhraseNode 属性：
// node_id:        "pn_abc123"
// phrase:         "pandas"
// phrase_type:    "LIBRARY" | "CONCEPT" | "PERSON" | "ORG" | "PRODUCT" | "EVENT"
// canonical_form: "pandas"        -- 标准化形式
// aliases:        ["pd", "pandas库"]
// mention_count:  42
// source_block_ids: ["blk_001", "blk_002"]  -- 出现过的 Block
// community_id:   "cn_xyz"
// agent_id:       "agent_001" | null

// ── 社区节点 ──────────────────────────────────────────
CREATE CONSTRAINT community_id ON (n:CommunityNode) ASSERT n.community_id IS UNIQUE;

// CommunityNode 属性（对应图3的 Community Node Summary）：
// community_id:   "cn_xyz"
// level:          0 | 1 | 2   -- 0=叶子社区, 1=上级社区
// member_count:   8
// summary_id:     "uuid..."    -- 对应 PostgreSQL semantic_summaries.id

// ── 边类型（基于图3实际标注）────────────────────────────────
// Context Edge：Block 为 PhraseNode 提供上下文
//   (:BlockRef)-[:CONTEXT_OF]->(:PhraseNode)
//   属性: block_id, weight（出现次数/共现强度）

// Relation Edge：实体间语义关系（双向）
//   (:PhraseNode)-[:RELATED_TO]->(:PhraseNode)
//   属性: relation_type ("USED_WITH"|"PART_OF"|"CAUSES"|...), weight, source_block_id

// Synonym Edge：同义词（双向）
//   (:PhraseNode)-[:SYNONYM_OF]->(:PhraseNode)
//   属性: weight

// Belongs_to Edge：实体归属社区
//   (:PhraseNode)-[:BELONGS_TO]->(:CommunityNode)
//   属性: confidence（该实体属于该社区的置信度）
```

### 5.2 常用查询

```cypher
-- 查询实体的1-2跳关联实体（图3 Relation Edge 遍历）
MATCH (n:PhraseNode {phrase: "pandas"})-[:RELATED_TO*1..2]-(related)
RETURN related.phrase, related.phrase_type LIMIT 20;

-- 查询一个社区的所有成员实体
MATCH (p:PhraseNode)-[:BELONGS_TO]->(c:CommunityNode {community_id: "cn_xyz"})
RETURN p.phrase, p.mention_count ORDER BY p.mention_count DESC;

-- 查找实体在哪些 Block 中出现（Context Edge 反向）
MATCH (b:BlockRef)-[:CONTEXT_OF]->(p:PhraseNode {phrase: "read_csv"})
RETURN b.block_id, b.weight ORDER BY b.weight DESC LIMIT 10;

-- Leiden 社区检测（通过 Graph Data Science 库）
CALL gds.leiden.write('phrase_graph', {
    writeProperty: 'community_id',
    maxLevels: 3
});
```

### 5.3 图数据科学（GDS）插件

Neo4j GDS（Graph Data Science）插件用于：
- **Leiden 算法**：社区检测（Louvain 的改进版，更稳定）
- **PageRank**：识别高价值实体节点（重要性排序）
- **相似度计算**：实体相似度（用于 Synonym 边自动发现）

---

## 6. OSS — 大内容存储

### 6.1 存储结构

```
agent-memory-store/          (Bucket)
├── episodes/
│   ├── agent_001/
│   │   ├── ep_abc123.json   (完整 Episode 内容，>4KB 时存这里)
│   │   └── ep_xyz456.json
│   └── agent_002/
├── blocks/
│   ├── public/
│   │   └── doc_pandas_guide/
│   │       ├── blk_001.txt
│   │       ├── blk_002.md   (表格内容)
│   │       └── blk_003.jpg  (图像)
│   └── agent_001/
└── exports/                  (批量导出、备份)
```

### 6.2 访问策略

- **写入**：AMS EpisodeStore / SemanticMemoryStore 在内容 > 4KB 时自动存 OSS，记录 `oss_key`
- **读取**：检索时若需要完整内容，用 `oss_key` 从 OSS 拉取（异步，不在检索关键路径上）
- **生命周期**：Episode 内容按重要性设置 OSS 生命周期：
  - importance >= 7：永久保留
  - importance 4~7：保留1年
  - importance < 4：保留3个月

---

## 7. 多路融合检索策略

### 7.1 五路检索与并行执行

AMS 的 `MultiPathRetriever` 并行执行5条检索路径（根据请求的 `layers` 参数选择）：

```
查询请求（query="如何处理CSV乱码"）
        │
        ├──→ 路径1: Milvus semantic_blocks ANN      → Block 内容片段
        ├──→ 路径2: PostgreSQL semantic_summaries   → Section/Community 摘要
        ├──→ 路径3: Neo4j Cypher 图遍历              → 实体关系链
        ├──→ 路径4: Milvus skills ANN + PG filter   → 匹配技能
        └──→ 路径5: Milvus episodes ANN + time filter → 历史 Episode

asyncio.gather(*paths, timeout=0.5)  // 统一超时 500ms

        │（合并5路结果）
        ▼
   去重（按 memory_id）
        │
        ▼
   Reranker（BGE Cross-Encoder 精排，top_k 较大时可选）
        │
        ▼
   Scorer（混合评分）
        │
        ▼
   返回 top_k 结果
```

### 7.2 各路径详细实现

#### 路径1：Block 向量检索（精确局部匹配）

```python
# Milvus 检索
results = milvus_client.search(
    collection_name="semantic_blocks",
    data=[query_embedding],
    anns_field="embedding",
    search_params={"metric_type": "COSINE", "params": {"ef": 100}},
    limit=top_k * 2,  # 多取一些，后续重排序会筛选
    expr=f'agent_id in ["", "{agent_id}"]',  # 公共 + 私有
    output_fields=["block_id", "block_type", "doc_id", "created_at"]
)

# 若需要完整内容，从 PostgreSQL 或 OSS 获取
```

#### 路径2：摘要检索（主题/宏观匹配）

```python
# 先搜 Section 摘要（level 1 + level 2）
section_results = await pg.fetch("""
    SELECT id, summary_type, title, content,
           1 - (embedding <=> $1::vector) AS similarity
    FROM semantic_summaries
    WHERE summary_type IN ('section_l1', 'section_l2')
    AND (agent_id = $2 OR agent_id IS NULL)
    ORDER BY similarity DESC
    LIMIT $3
""", query_embedding_str, agent_id, top_k)

# 再搜 Community 摘要（宏观问题优先）
community_results = await pg.fetch("""
    SELECT id, summary_type, title, content,
           1 - (embedding <=> $1::vector) AS similarity
    FROM semantic_summaries
    WHERE summary_type = 'community'
    AND (agent_id = $2 OR agent_id IS NULL)
    ORDER BY similarity DESC
    LIMIT 5
""", query_embedding_str, agent_id)
```

#### 路径3：图遍历（关系推理）

```python
# 先从查询中提取实体
entities = spacy_ner.extract(query)  # 快速提取，不用 LLM

# 对每个实体查图
for entity in entities[:3]:  # 最多3个实体，避免图查询过慢
    cypher_results = neo4j.run("""
        MATCH (n:PhraseNode {phrase: $phrase})-[r:RELATED_TO|SYNONYM_OF*1..2]-(related)
        RETURN related.phrase, related.phrase_type, r
        LIMIT 10
    """, phrase=entity)

# 将图查询结果转为关系描述文本
```

#### 路径4：技能检索

```python
# Milvus 向量检索
skill_ids = milvus_client.search("skills", [query_embedding], limit=10,
                                  expr='status == "active"')

# PostgreSQL 获取完整元数据
skills = await pg.fetch("""
    SELECT skill_id, name, description, workflow_steps,
           success_rate, usage_count, avg_turns
    FROM skills
    WHERE skill_id = ANY($1) AND status = 'active'
    ORDER BY success_rate DESC
""", [r.id for r in skill_ids])
```

#### 路径5：Episode 检索

```python
# Milvus 向量 + 时间过滤
time_90d = int((datetime.now() - timedelta(days=90)).timestamp())
episode_ids = milvus_client.search(
    "episodes", [query_embedding], limit=10,
    expr=f'agent_id == "{agent_id}" and event_time > {time_90d}'
)

# PostgreSQL 获取内容预览
episodes = await pg.fetch("""
    SELECT episode_id, title, content_preview, importance,
           outcome, event_time, tags
    FROM episodes
    WHERE episode_id = ANY($1)
    ORDER BY importance DESC, event_time DESC
""", [r.id for r in episode_ids])
```

### 7.3 混合评分公式

```python
def mixed_score(
    vector_similarity: float,  # 来自 Milvus/pgvector，COSINE 相似度
    created_at: datetime,
    importance: float,         # 1.0-10.0
    layer_boost: dict          # 不同层的加成系数
) -> float:
    """
    最终得分 = w_rel × relevance + w_rec × recency + w_imp × importance

    默认权重：relevance=0.6, recency=0.3, importance=0.1
    可按 layer 调整（如 Skill 检索中 importance 权重更高）
    """
    # 相关性（直接使用向量相似度）
    relevance = vector_similarity  # 0.0-1.0

    # 时效性（指数衰减，半衰期 24h）
    hours_ago = (datetime.now(tz=timezone.utc) - created_at).total_seconds() / 3600
    recency = math.exp(-math.log(2) / 24 * hours_ago)

    # 重要性（归一化 1-10 → 0-1）
    importance_norm = (importance - 1.0) / 9.0

    # 按层加权（可配置）
    w = layer_boost.get(layer, {"rel": 0.6, "rec": 0.3, "imp": 0.1})
    return w["rel"] * relevance + w["rec"] * recency + w["imp"] * importance_norm
```

**各层权重推荐值**：

| 层 | 相关性 | 时效性 | 重要性 | 说明 |
|----|--------|--------|--------|------|
| Episode | 0.5 | 0.4 | 0.1 | 近期经历权重高 |
| Procedural (Skill) | 0.7 | 0.1 | 0.2 | 技能以相关性和质量为主 |
| Semantic Block | 0.7 | 0.1 | 0.2 | 知识库内容时效性弱 |
| Community Summary | 0.8 | 0.1 | 0.1 | 宏观摘要以相关性为主 |

### 7.4 重排序（Reranker）

当 `top_k > 20` 或 `enable_rerank=true` 时，对合并后的候选进行精排：

```python
# BGE Cross-Encoder 精排
# 输入：query + 每个候选的 (title + content_preview)
# 输出：更精准的相关性分数

from sentence_transformers import CrossEncoder

reranker = CrossEncoder("BAAI/bge-reranker-large")

pairs = [(query, f"{r.title}\n{r.content[:300]}") for r in candidates]
scores = reranker.predict(pairs)  # 精排分数覆盖原始向量相似度分数
```

**触发条件**：
- 候选结果 > 20 条（避免 reranker 对大量候选的性能开销）
- 请求明确传 `enable_rerank: true`

**延迟代价**：BGE-reranker-large 对20条候选约需 50-100ms（GPU），对5条约需 15ms。

---

## 8. 检索意图路由

针对不同类型的问题，AMS 自动选择最优的检索路径组合（无需调用方指定）：

```python
def route_search_intent(query: str, layers: list[str]) -> SearchStrategy:
    """
    根据 query 特征和请求的 layers，自动决定检索策略

    - 若 query 包含 "怎么做"、"如何处理"、"步骤" → 优先 Skill 检索
    - 若 query 包含 "上次"、"之前"、"历史" → 优先 Episode 检索
    - 若 query 包含 "总结"、"整体"、"概述" → 优先 Community Summary
    - 若 query 包含具体实体名词 → 先图遍历获取关联，再 Block 检索
    - 否则 → 标准5路并行检索
    """
```

---

## 9. 性能优化要点

### 9.1 Embedding 缓存

查询 Embedding 生成是检索的前置步骤（约 20-50ms），对相同 query 进行缓存：

```python
# Redis 缓存，TTL 10分钟
cache_key = f"emb:{hashlib.md5(query.encode()).hexdigest()}"
cached = await redis.get(cache_key)
if cached:
    return json.loads(cached)

embedding = await embedding_model.encode(query)
await redis.setex(cache_key, 600, json.dumps(embedding))
```

### 9.2 Milvus 连接池

Milvus gRPC 连接建立有开销，使用连接池：

```python
milvus_pool = MilvusConnectionPool(
    host=MILVUS_HOST, port=MILVUS_PORT,
    pool_size=10,         # 根据并发量调整
    max_overflow=5,
    timeout=30
)
```

### 9.3 PostgreSQL 查询优化

- 使用 `asyncpg` 异步驱动（非阻塞）
- 连接池大小：min=5, max=20
- `semantic_summaries.embedding` 使用 `ivfflat` 索引，`lists=200`（数据量越大，lists 调大）
- 对大查询使用 `EXPLAIN ANALYZE` 监控慢查询

---

*下一步：[05-Skill-Mining-and-Discovery 详细设计](./05-Skill-Mining-and-Discovery.md)*
