---
title: "03-Storage-and-Retrieval 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "storage", "retrieval", "milvus", "neo4j", "详细设计", "版本C"]
---

# Storage & Retrieval 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: AMS 的存储引擎协调层和多路融合检索实现，是"搜索即核心"设计哲学的落地。

---

## 1. 存储架构总览

### 1.1 版本C 存储引擎选型

| 职责                              | 引擎            | 版本   | 选型理由                                                    |
| ------------------------------- | ------------- | ---- | ------------------------------------------------------- |
| **Working Memory**              | Redis         | 7.2  | 亚毫秒延迟；原生 Hash + List + Sorted Set；TTL 支持；Pub/Sub 用于事件推送 |
| **段落级向量（block_embeddings）**     | Milvus        | 2.4  | 企业级向量数据库，支持千万级向量水平扩展；HNSW 索引高召回率                        |
| **章节级向量（section_embeddings）**   | Milvus        | 2.4  | 同上；section 量级（万~百万），与 block 共用一个 Milvus 集群              |
| **实体级向量（node_embeddings）**      | Milvus        | 2.4  | Graph 检索入口的语义种子                                         |
| **社区级向量（community_embeddings）** | Milvus        | 2.4  | 全局主题问题的粗召回                                              |
| **全文检索（BM25）**                  | Elasticsearch | 8.14 | IK 分析器中文分词；BM25 参数可调（k1/b）                              |
| **知识图谱（实体 + 关系）**               | Neo4j         | 5.20 | 图遍历原生支持；GDS 插件集成 Leiden 算法 + PPR                        |
| **记忆元数据**                       | PostgreSQL    | 16   | 结构化查询、ACID、JSONB（structures_status）、RLS（多租户）            |
| **原始内容大对象**                     | OSS           | —    | 超过 4KB 的文档正文/代码存对象存储，PG 只存 OSS Key                      |

### 1.2 各引擎的数据量估算（中等规模：100 Agent，日活）

| 存储 | 集合/表 | 预估规模 | 向量维度 |
|---|---|---|---|
| Redis | Working Memory | ~1K 并发 session | — |
| Milvus | block_embeddings | ~146M/年（work_document + source_code）| 1536 |
| Milvus | section_embeddings | ~15M/年 | 1536 |
| Milvus | node_embeddings | ~50M/年 | 1536 |
| Milvus | community_embeddings | ~500K/年 | 1536 |
| Elasticsearch | ams_memories | ~10M 记录/年 | — |
| Neo4j | PhraseNode + Edge | ~50M 节点，~200M 边/年 | — |
| PostgreSQL | memory_records | ~10M 记录/年 | — |
| OSS | raw content | ~5TB/年 | — |

> **capacity 推导**：70% 的记忆（user_interaction + agent_trace）是 Graph-only，不产生 block 向量。有效产生 block 向量的只有 work_document（25%）和 source_code（5%）。详见 AMS 设计文档 §11.2。

### 1.3 版本C 四集合 Milvus 设计的核心逻辑

版本 C 对版本 B 的 Milvus 设计做了重要升级：从 3 个集合（episodes/blocks/skills）扩展为 **4 个专用集合**，每个集合对应一种查询意图：

| Collection | 粒度 | 对应的查询意图 | 在检索流程中的触发位置 |
|---|---|---|---|
| `block_embeddings` | 段落级（~200-1500 tokens）| 精准语义匹配，召回最直接的证据 | Vector Channel 主力召回 |
| `section_embeddings` | 章节级（3-5个block的摘要）| 快速定位内容大方向 | Tree Channel 粗召回入口 |
| `node_embeddings` | 实体级（单个 PhraseNode）| Graph 检索的语义种子节点 | Graph Channel 入口 |
| `community_embeddings` | 社区级（10-200个实体的摘要）| 全局主题性问题（"这个系统的总体设计是什么"）| Agentic Mode 高层召回 |

---

## 2. Milvus Schema 设计

### 2.1 Collection 1：block_embeddings

段落级向量，是 Vector 检索通道的主力召回源。

```python
from pymilvus import CollectionSchema, FieldSchema, DataType, Collection, connections

# 连接 Milvus
connections.connect("default", host=MILVUS_HOST, port=MILVUS_PORT)

block_fields = [
    FieldSchema("block_id",        DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id",       DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id",        DataType.VARCHAR, max_length=64),
    FieldSchema("memory_id",       DataType.VARCHAR, max_length=64),
    FieldSchema("section_id",      DataType.VARCHAR, max_length=64),
    FieldSchema("block_type",      DataType.VARCHAR, max_length=20),   # text/code/table/img
    FieldSchema("position",        DataType.INT32),                    # 在文档中的序号
    FieldSchema("content_preview", DataType.VARCHAR, max_length=500),  # 前 500 字用于展示
    FieldSchema("source_type",     DataType.VARCHAR, max_length=30),   # work_document/source_code
    FieldSchema("importance",      DataType.FLOAT),
    FieldSchema("decay_weight",    DataType.FLOAT),
    FieldSchema("created_at",      DataType.INT64),                    # Unix timestamp
    FieldSchema("embedding",       DataType.FLOAT_VECTOR, dim=1536),
]

block_schema = CollectionSchema(
    fields=block_fields,
    description="Paragraph-level block embeddings for semantic retrieval"
)

block_collection = Collection(name="block_embeddings", schema=block_schema)

# HNSW 索引（高召回率，适合精度要求高的语义匹配）
block_collection.create_index(
    field_name="embedding",
    index_params={
        "index_type": "HNSW",
        "metric_type": "COSINE",
        "params": {
            "M": 16,                # 每个节点的最大连接数，越大召回率越高但内存越多
            "efConstruction": 200   # 构建时的搜索深度，越大索引质量越高
        }
    }
)

# 标量字段索引（用于过滤）
block_collection.create_index(field_name="tenant_id", index_name="idx_block_tenant")
block_collection.create_index(field_name="agent_id",  index_name="idx_block_agent")
block_collection.create_index(field_name="memory_id", index_name="idx_block_memory")

# 检索示例
def search_blocks(query_embedding: list[float], agent_id: str,
                   tenant_id: str, top_k: int = 50) -> list[dict]:
    results = block_collection.search(
        data=[query_embedding],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": 100}},
        limit=top_k,
        expr=f'tenant_id == "{tenant_id}" && (agent_id == "{agent_id}" || agent_id == "")',
        output_fields=["block_id", "memory_id", "section_id", "block_type",
                        "content_preview", "importance", "decay_weight", "created_at"]
    )
    return [dict(hit.fields, score=hit.score) for hit in results[0]]
```

### 2.2 Collection 2：section_embeddings

章节级向量，存储 Section Summary 的 Embedding，用于 Tree Channel 粗召回。

```python
section_fields = [
    FieldSchema("section_id",   DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id",    DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id",     DataType.VARCHAR, max_length=64),
    FieldSchema("memory_id",    DataType.VARCHAR, max_length=64),
    FieldSchema("level",        DataType.INT32),     # 层级：1=L1 Section, 2=L2 Section
    FieldSchema("heading",      DataType.VARCHAR, max_length=500),
    FieldSchema("summary",      DataType.VARCHAR, max_length=2000),
    FieldSchema("child_count",  DataType.INT32),     # 子 block 数量
    FieldSchema("importance",   DataType.FLOAT),
    FieldSchema("created_at",   DataType.INT64),
    FieldSchema("embedding",    DataType.FLOAT_VECTOR, dim=1536),
]

section_schema = CollectionSchema(
    fields=section_fields,
    description="Chapter-level section summary embeddings for tree navigation"
)

section_collection = Collection(name="section_embeddings", schema=section_schema)
section_collection.create_index(
    field_name="embedding",
    index_params={"index_type": "HNSW", "metric_type": "COSINE",
                   "params": {"M": 16, "efConstruction": 200}}
)
```

### 2.3 Collection 3：node_embeddings

实体级向量，每个 PhraseNode 对应一条记录，是 Graph Channel 的语义入口。

```python
node_fields = [
    FieldSchema("entity_id",    DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id",    DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id",     DataType.VARCHAR, max_length=64),
    FieldSchema("name",         DataType.VARCHAR, max_length=300),    # 规范化实体名
    FieldSchema("entity_type",  DataType.VARCHAR, max_length=30),     # person/tool/concept/...
    FieldSchema("description",  DataType.VARCHAR, max_length=1000),
    FieldSchema("community_id", DataType.VARCHAR, max_length=64),     # 所属社区
    FieldSchema("importance",   DataType.FLOAT),
    FieldSchema("decay_weight", DataType.FLOAT),
    FieldSchema("created_at",   DataType.INT64),
    FieldSchema("embedding",    DataType.FLOAT_VECTOR, dim=1536),     # embed(name + " " + description)
]

node_schema = CollectionSchema(
    fields=node_fields,
    description="Entity-level node embeddings as semantic seeds for graph traversal"
)

node_collection = Collection(name="node_embeddings", schema=node_schema)
node_collection.create_index(
    field_name="embedding",
    index_params={"index_type": "HNSW", "metric_type": "COSINE",
                   "params": {"M": 16, "efConstruction": 200}}
)
```

### 2.4 Collection 4：community_embeddings

社区级向量，每个 CommunityNode 的摘要 Embedding，用于 Agentic Mode 高层召回。

```python
community_fields = [
    FieldSchema("community_id",  DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id",     DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id",      DataType.VARCHAR, max_length=64),
    FieldSchema("level",         DataType.INT32),     # 社区层级
    FieldSchema("summary",       DataType.VARCHAR, max_length=3000),
    FieldSchema("member_count",  DataType.INT32),
    FieldSchema("created_at",    DataType.INT64),
    FieldSchema("embedding",     DataType.FLOAT_VECTOR, dim=1536),
]

community_schema = CollectionSchema(
    fields=community_fields,
    description="Community-level topic summaries for global thematic retrieval"
)

community_collection = Collection(name="community_embeddings", schema=community_schema)
community_collection.create_index(
    field_name="embedding",
    index_params={"index_type": "HNSW", "metric_type": "COSINE",
                   "params": {"M": 8, "efConstruction": 100}}  # 社区量少，参数可适当降低
)
```

---

## 3. Neo4j Schema（完整版）

版本C 对版本B 的 Neo4j Schema 进行了扩展，增加了 Block 节点（Tree↔Graph 桥接层）和时序属性。

```cypher
// ═══════════════════════════════════════════════════
// 约束与索引（Neo4j 5.x 语法）
// ═══════════════════════════════════════════════════

// --- Block Node（Tree 层的叶节点，同时桥接到 Graph）---
CREATE CONSTRAINT block_id_unique FOR (b:Block) REQUIRE b.block_id IS UNIQUE;
CREATE INDEX block_memory_idx FOR (b:Block) ON (b.memory_id);
CREATE INDEX block_section_idx FOR (b:Block) ON (b.section_id);
CREATE INDEX block_tenant_idx  FOR (b:Block) ON (b.tenant_id);

// --- Section Node（Tree 层的章节节点）---
CREATE CONSTRAINT section_id_unique FOR (s:Section) REQUIRE s.section_id IS UNIQUE;
CREATE INDEX section_memory_idx FOR (s:Section) ON (s.memory_id);

// --- PhraseNode（Graph 层的实体节点）---
CREATE CONSTRAINT phrase_entity_unique FOR (p:PhraseNode) REQUIRE p.entity_id IS UNIQUE;
CREATE INDEX phrase_name_idx   FOR (p:PhraseNode) ON (p.tenant_id, p.name);
CREATE INDEX phrase_type_idx   FOR (p:PhraseNode) ON (p.entity_type);
CREATE INDEX phrase_decay_idx  FOR (p:PhraseNode) ON (p.decay_weight);
CREATE INDEX phrase_temporal   FOR (p:PhraseNode) ON (p.valid_from, p.valid_until);

// --- CommunityNode（Graph 层的社区节点）---
CREATE CONSTRAINT community_id_unique FOR (c:CommunityNode) REQUIRE c.community_id IS UNIQUE;
CREATE INDEX community_agent_idx FOR (c:CommunityNode) ON (c.agent_id);


// ═══════════════════════════════════════════════════
// 节点属性 Schema
// ═══════════════════════════════════════════════════

// ── Block Node ────────────────────────────────────
// (:Block {
//   block_id:        "blk_uuid_001",
//   tenant_id:       "tenant_acme",
//   agent_id:        "agent_001",
//   memory_id:       "mem_uuid_001",
//   section_id:      "sec_uuid_001",   // 所属 Section（空字符串表示无归属）
//   block_type:      "text",           // "text" | "code" | "table" | "img"
//   position:        3,                // 在文档中的序号
//   content_preview: "前200字...",      // 用于图遍历时展示
//   summary:         "本段描述...",
//   tags:            ["pandas", "csv"],
//   decay_weight:    1.0,
//   created_at:      datetime("2026-03-26T00:00:00"),
//   updated_at:      datetime("2026-03-26T00:00:00")
// })

// ── Section Node ──────────────────────────────────
// (:Section {
//   section_id:   "sec_uuid_001",
//   tenant_id:    "tenant_acme",
//   agent_id:     "agent_001",
//   memory_id:    "mem_uuid_001",
//   heading:      "1.1 背景与动机",
//   level:        2,          // 1=L1, 2=L2
//   summary:      "本章节介绍...",
//   child_count:  4,          // 子 Block 或子 Section 数量
//   created_at:   datetime(),
//   updated_at:   datetime()
// })

// ── PhraseNode ────────────────────────────────────
// (:PhraseNode {
//   entity_id:       "ent_uuid_001",
//   tenant_id:       "tenant_acme",
//   agent_id:        "agent_001",     // null = 公共实体
//   name:            "pandas",        // 规范化名称（lowercase）
//   original_text:   "Pandas",
//   description:     "Python 数据分析与处理库",
//   entity_type:     "tool",          // person/org/tool/concept/action/event
//   importance:      0.8,
//   access_count:    42,
//   decay_weight:    0.95,
//   // 时序属性（Temporal KG，仅 full_three_layer 写入）
//   valid_from:      datetime("2026-01-01T00:00:00"),
//   valid_until:     null,            // null = 当前仍有效
//   source_memory_id: "mem_uuid_001",
//   source_block_id:  "blk_uuid_001",
//   created_at:      datetime(),
//   updated_at:      datetime()
// })

// ── CommunityNode ─────────────────────────────────
// (:CommunityNode {
//   community_id: "cn_uuid_001",
//   tenant_id:    "tenant_acme",
//   agent_id:     "agent_001",
//   level:        0,             // 0=叶子社区, 1=上层社区
//   name:         "数据处理工具链",    // LLM 生成的社区名称
//   summary:      "该社区包含 pandas、numpy、read_csv 等数据处理相关工具...",
//   member_count: 15,
//   created_at:   datetime(),
//   updated_at:   datetime()
// })


// ═══════════════════════════════════════════════════
// 边（Relationship）Schema
// ═══════════════════════════════════════════════════

// ── Tree 层内部关系 ───────────────────────────────
// Block 归属 Section
// (:Block)-[:BELONGS_TO_SECTION {weight: 1.0, created_at: datetime()}]->(:Section)

// Section 层级关系（子 Section 到父 Section）
// (:Section)-[:CHILD_OF {created_at: datetime()}]->(:Section)

// ── Tree ↔ Graph 桥接关系 ─────────────────────────
// Block 为 PhraseNode 提供上下文（写 Tree + Graph 路径时建立）
// (:Block)-[:HAS_CONTEXT {
//   weight:         0.9,           // 上下文相关性权重
//   chunk_position: 2,             // 实体在 Block 中出现的位置
//   created_at:     datetime()
// }]->(:PhraseNode)

// ── Graph 层内部关系 ─────────────────────────────
// 语义关系
// (:PhraseNode)-[:RELATES_TO {
//   edge_id:         "edge_uuid",
//   relation_type:   "depends_on",   // calls/depends_on/contains/causes/follows/...
//   description:     "read_csv 依赖 pandas",
//   weight:          0.85,
//   importance:      0.7,
//   valid_from:      datetime(),
//   valid_until:     null,
//   source_memory_id: "mem_uuid_001",
//   created_at:      datetime()
// }]->(:PhraseNode)

// 同义关系（规范化发现的别名）
// (:PhraseNode)-[:SYNONYM_OF {
//   confidence:  0.95,
//   valid_from:  datetime(),
//   created_at:  datetime()
// }]->(:PhraseNode)

// 实体归属社区
// (:PhraseNode)-[:BELONGS_TO {
//   membership_score: 0.92,    // 归属该社区的置信度
//   created_at:       datetime()
// }]->(:CommunityNode)

// 社区层级
// (:CommunityNode)-[:PARENT_COMMUNITY {created_at: datetime()}]->(:CommunityNode)
```

---

## 4. PostgreSQL 补充 Schema

（`memory_records` 表已在 AMS 设计文档 §3.2 中完整定义，此处补充检索相关的辅助表）

### 4.1 block_content 表（Block 原始内容）

```sql
-- Block 内容表：content < 4KB 直存，>= 4KB 存 OSS
CREATE TABLE block_content (
    block_id        UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    memory_id       UUID NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
    section_id      UUID,

    block_type      VARCHAR(20) NOT NULL,  -- 'text' | 'code' | 'table' | 'img'
    position        INT NOT NULL,
    raw_text        TEXT,                  -- < 4KB 时直存；否则 null
    content_oss_key VARCHAR(512),          -- >= 4KB 时的 OSS 路径

    summary         TEXT,                  -- LLM 生成的摘要
    tags            TEXT[],

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bc_memory ON block_content(memory_id);
CREATE INDEX idx_bc_section ON block_content(section_id);
CREATE INDEX idx_bc_tenant ON block_content(tenant_id);
```

### 4.2 section_content 表（Section 摘要）

```sql
CREATE TABLE section_content (
    section_id      UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    memory_id       UUID NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
    parent_section_id UUID REFERENCES section_content(section_id),

    heading         VARCHAR(500),
    level           SMALLINT NOT NULL,     -- 1 or 2
    summary         TEXT,
    child_count     INT DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sc_memory ON section_content(memory_id);
CREATE INDEX idx_sc_parent ON section_content(parent_section_id);
```

---

## 5. 检索架构总览

### 5.1 双模式检索架构

```
用户/Agent Query
      │
      ├─ mode = lightweight ──→ § 6. Lightweight 检索流程
      │                           ├─ BM25 Channel (ES)
      │                           ├─ Vector Channel (Milvus block_embeddings)
      │                           ├─ Tree Channel (Milvus section_embeddings → PG 树路径)
      │                           └─ Graph Channel (Milvus node_embeddings → Neo4j PPR)
      │                                     ↓
      │                             RRF 融合 → Cross-Encoder Reranking → 上下文组装
      │
      └─ mode = agentic ──→ § 7. Agentic 检索流程
                              ① LLM Query Expansion (子查询分解)
                              ② 多轮 Lightweight 检索 (满足度阈值控制)
                              ③ LLM Intelligent Fusion (语义去重 + 信息整合)
                              ④ Cross-Encoder Reranking + 上下文组装
```

### 5.2 检索模式选择指南

| 选择 lightweight 当... | 选择 agentic 当... |
|---|---|
| 单跳事实性问题（"什么是 X"）| 多跳推理问题（"X 和 Y 的关系，以及对 Z 的影响"）|
| 延迟敏感（目标 < 200ms p95）| 复杂语义问题（查询语义模糊，需要扩展）|
| 检索结果有明确关键词 | 检索结果分散在多个来源，需要综合 |
| 简单 RAG 场景 | 深度研究型任务，1-3s 延迟可接受 |

---

## 6. Lightweight 检索流程详解

### 6.1 四路检索并行执行

```
Lightweight Retrieval（总预算 p95 < 200ms）

┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ① 并行 4 路检索（asyncio.gather，统一超时 120ms）                    │
│  │                                                                    │
│  ├─ BM25 Channel (ES)             ← 关键词精确匹配，优势：低延迟      │
│  │  目标延迟: < 20ms p95                                              │
│  │  召回数: top_k × 3                                                 │
│  │                                                                    │
│  ├─ Vector Channel (Milvus)       ← 语义相似匹配，优势：泛化性强      │
│  │  查询: block_embeddings（主）+ section_embeddings（辅）            │
│  │  目标延迟: < 40ms p95                                              │
│  │  召回数: top_k × 3                                                 │
│  │                                                                    │
│  ├─ Tree Channel                  ← 结构化层次导航，优势：上下文完整  │
│  │  查询: section_embeddings 定位章节 → 展开子 Block               │
│  │  目标延迟: < 60ms p95                                              │
│  │  召回数: top_k × 2                                                 │
│  │                                                                    │
│  └─ Graph Channel (PPR)           ← 实体关系图谱，优势：多跳推理     │
│     查询: node_embeddings 定位种子 → Neo4j PPR 展开                  │
│     目标延迟: < 80ms p95                                              │
│     召回数: top_k × 2                                                 │
│                                                                      │
│  ② RRF 融合（< 10ms）                                                │
│     + importance^0.3 × decay_weight^0.2 加权                         │
│                                                                      │
│  ③ Cross-Encoder Reranking（< 60ms，bge-reranker-v2-m3）             │
│     输入: top min(100, total_candidates)                              │
│     输出: top_k 结果                                                  │
│                                                                      │
│  ④ 上下文组装（< 20ms）                                              │
│     拉取 Tree 路径 + Graph 上下文（可选）                              │
│                                                                      │
│  总延迟：20 + 80 + 10 + 60 + 20 = 190ms ≤ 200ms p95                 │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 BM25 检索通道

```python
class BM25Channel:
    """
    通过 Elasticsearch BM25 实现关键词精确匹配检索。
    优势：对专有名词、术语、代码符号敏感；延迟极低。
    """

    async def search(self, query: str, agent_id: str, tenant_id: str,
                      filters: dict, top_k: int) -> list[dict]:
        es_query = {
            "query": {
                "bool": {
                    "must": [
                        {
                            "multi_match": {
                                "query": query,
                                "fields": [
                                    "title^3",       # 标题权重 3x
                                    "summary^2",     # 摘要权重 2x
                                    "content_text"   # 正文权重 1x
                                ],
                                "type": "best_fields",
                                "operator": "OR"
                            }
                        }
                    ],
                    "filter": self._build_filters(agent_id, tenant_id, filters)
                }
            },
            "_source": ["memory_id", "title", "summary", "source_type",
                         "memory_type", "importance", "decay_weight", "created_at"],
            "size": top_k * 3
        }

        resp = await self.es_client.search(
            index="ams_memories",
            body=es_query,
            request_timeout=15   # 15ms 超时，ES BM25 应该足够
        )

        return [
            {
                "memory_id": hit["_source"]["memory_id"],
                "title": hit["_source"]["title"],
                "summary": hit["_source"].get("summary", ""),
                "bm25_score": hit["_score"],
                "importance": hit["_source"].get("importance", 0.5),
                "decay_weight": hit["_source"].get("decay_weight", 1.0),
                "source": "bm25",
                "channel_rank": i + 1
            }
            for i, hit in enumerate(resp["hits"]["hits"])
        ]

    def _build_filters(self, agent_id: str, tenant_id: str,
                        filters: dict) -> list[dict]:
        """构建 ES filter 子句（不影响 BM25 评分，只过滤）"""
        f = [
            {"term": {"tenant_id": tenant_id}},
            # agent_id 过滤：显示该 Agent 的私有记忆 + 公共记忆
            # 注：tenant-level 共享记忆 agent_id 为空
        ]
        if filters.get("memory_types"):
            f.append({"terms": {"memory_type": filters["memory_types"]}})
        if filters.get("source_types"):
            f.append({"terms": {"source_type": filters["source_types"]}})
        if filters.get("time_range"):
            f.append({"range": {"created_at": {
                "gte": filters["time_range"]["start"],
                "lte": filters["time_range"]["end"]
            }}})
        if filters.get("min_importance"):
            f.append({"range": {"importance": {"gte": filters["min_importance"]}}})
        return f
```

### 6.3 Vector 检索通道

```python
class VectorChannel:
    """
    通过 Milvus 向量相似度检索。
    主查询：block_embeddings（段落级精准匹配）
    辅助查询：section_embeddings（章节级语义定位）
    """

    async def search(self, query_embedding: list[float],
                      agent_id: str, tenant_id: str,
                      filters: dict, top_k: int) -> list[dict]:
        # 主查询：block_embeddings
        block_expr = self._build_expr(agent_id, tenant_id, filters)
        block_results = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: block_collection.search(
                data=[query_embedding],
                anns_field="embedding",
                param={"metric_type": "COSINE", "params": {"ef": 100}},
                limit=top_k * 2,
                expr=block_expr,
                output_fields=["block_id", "memory_id", "section_id",
                                "content_preview", "importance", "decay_weight",
                                "block_type", "source_type"]
            )
        )

        results = []
        for i, hit in enumerate(block_results[0]):
            results.append({
                "memory_id": hit.fields["memory_id"],
                "block_id": hit.fields["block_id"],
                "section_id": hit.fields["section_id"],
                "content_preview": hit.fields["content_preview"],
                "vector_score": hit.score,
                "importance": hit.fields["importance"],
                "decay_weight": hit.fields["decay_weight"],
                "source": "vector_block",
                "channel_rank": i + 1
            })

        return results

    def _build_expr(self, agent_id: str, tenant_id: str,
                     filters: dict) -> str:
        """构建 Milvus filter expression"""
        parts = [f'tenant_id == "{tenant_id}"']
        # Agent 隔离：只搜自己的 + 公共（agent_id == ""）
        parts.append(f'(agent_id == "{agent_id}" || agent_id == "")')

        if filters.get("source_types"):
            types_str = ", ".join([f'"{t}"' for t in filters["source_types"]])
            parts.append(f"source_type in [{types_str}]")
        if filters.get("min_importance"):
            parts.append(f"importance >= {filters['min_importance']}")

        return " && ".join(parts)
```

### 6.4 Tree 检索通道

Tree 通道通过两步实现"从摘要定位到原文块"：

```python
class TreeChannel:
    """
    Tree 层级检索：
    Step 1: 在 section_embeddings 中找到语义最近的章节
    Step 2: 展开该章节下的所有 Block（通过 PG 查询树路径）
    优势：返回的内容具有上下文完整性（同章节的相邻 Block 一起返回）
    """

    async def search(self, query_embedding: list[float],
                      agent_id: str, tenant_id: str,
                      filters: dict, top_k: int) -> list[dict]:
        # Step 1: 在 section_embeddings 中检索最相关的章节
        section_results = section_collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param={"metric_type": "COSINE", "params": {"ef": 64}},
            limit=min(top_k, 10),  # 最多展开 10 个章节
            expr=f'tenant_id == "{tenant_id}" && '
                 f'(agent_id == "{agent_id}" || agent_id == "")',
            output_fields=["section_id", "memory_id", "heading", "level",
                            "summary", "child_count"]
        )

        if not section_results[0]:
            return []

        # Step 2: 对每个匹配的 Section，获取其下的 Blocks
        section_ids = [hit.fields["section_id"] for hit in section_results[0]]
        blocks = await self._expand_sections(section_ids)

        results = []
        for i, (hit, block_list) in enumerate(
            zip(section_results[0], [blocks.get(sid, []) for sid in section_ids])
        ):
            # 把 section_hit 和它下面的 blocks 一起作为结果返回
            result = {
                "memory_id": hit.fields["memory_id"],
                "section_id": hit.fields["section_id"],
                "section_heading": hit.fields["heading"],
                "section_summary": hit.fields["summary"],
                "tree_score": hit.score,
                "child_blocks": block_list,   # 展开的子 Block 列表
                "source": "tree",
                "channel_rank": i + 1
            }
            results.append(result)

        return results

    async def _expand_sections(self, section_ids: list[str]) -> dict:
        """从 PG 获取各 Section 下的 Block 列表"""
        rows = await self.pg_client.fetch("""
            SELECT section_id, block_id, position, block_type,
                   raw_text, summary, tags
            FROM block_content
            WHERE section_id = ANY($1::uuid[])
            ORDER BY section_id, position
        """, section_ids)

        result = {}
        for row in rows:
            sid = str(row["section_id"])
            if sid not in result:
                result[sid] = []
            result[sid].append(dict(row))
        return result

    async def get_tree_path(self, block_id: str) -> dict:
        """
        获取单个 Block 的完整树路径（用于上下文组装）。
        返回：Block → Section L2 → Section L1 → Memory 的层级链。
        """
        rows = await self.pg_client.fetch("""
            WITH RECURSIVE tree_path AS (
                -- 起点：找到 block 所属的 section
                SELECT s.section_id, s.parent_section_id, s.heading, s.level,
                       s.summary, 0 as depth
                FROM block_content b
                JOIN section_content s ON b.section_id = s.section_id
                WHERE b.block_id = $1

                UNION ALL

                -- 向上递归到父 section
                SELECT s.section_id, s.parent_section_id, s.heading, s.level,
                       s.summary, tp.depth + 1
                FROM section_content s
                JOIN tree_path tp ON s.section_id = tp.parent_section_id
                WHERE tp.depth < 10  -- 防止无限循环
            )
            SELECT * FROM tree_path ORDER BY depth DESC
        """, block_id)

        return {
            "block_id": block_id,
            "path": [dict(r) for r in rows]
        }
```

### 6.5 Graph 检索通道（PPR 实现）

Graph 通道通过 Personalized PageRank（PPR）实现图谱遍历，是版本C对版本B最显著的检索创新之一：

```python
class GraphChannel:
    """
    Graph 层级检索：
    Step 1: 在 node_embeddings 中找到语义最近的 PhraseNode 作为种子
    Step 2: 从种子节点出发，在 Neo4j 中运行 PPR 算法，找到相关实体集合
    Step 3: 从相关实体溯源到对应的 Block/Memory

    PPR vs 简单图遍历的优势：
    - 考虑全局图结构，不只是局部邻居
    - 通过重启概率平衡"贴近种子"和"探索图"的权衡
    - 对噪声和稀疏连接有更强的鲁棒性
    """
    PPR_DAMPING = 0.85           # 重启概率（1 - damping）= 0.15
    PPR_MAX_ITERATIONS = 50
    PPR_TOLERANCE = 1e-6
    PPR_TOP_NODES = 20           # PPR 返回的顶部节点数

    async def search(self, query_embedding: list[float],
                      query: str,
                      agent_id: str, tenant_id: str,
                      filters: dict, top_k: int) -> list[dict]:
        # Step 1: 找到语义最近的 PhraseNode 作为 PPR 种子
        seed_nodes = node_collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param={"metric_type": "COSINE", "params": {"ef": 64}},
            limit=5,  # 最多 5 个种子节点
            expr=f'tenant_id == "{tenant_id}" && '
                 f'(agent_id == "{agent_id}" || agent_id == "")',
            output_fields=["entity_id", "name", "entity_type", "description",
                            "community_id", "importance"]
        )

        if not seed_nodes[0]:
            return []

        seed_entity_ids = [hit.fields["entity_id"] for hit in seed_nodes[0]]
        seed_scores = {hit.fields["entity_id"]: hit.score
                        for hit in seed_nodes[0]}

        # Step 2: 在 Neo4j 中运行 PPR（使用 GDS 的 pageRank 个性化版本）
        ppr_results = await self._run_ppr(
            seed_entity_ids=seed_entity_ids,
            seed_scores=seed_scores,
            tenant_id=tenant_id,
            agent_id=agent_id
        )

        # Step 3: 从高分实体溯源到对应的 Block/Memory
        blocks_and_memories = await self._resolve_to_memories(
            entity_ids=[r["entity_id"] for r in ppr_results[:self.PPR_TOP_NODES]],
            tenant_id=tenant_id
        )

        results = []
        for i, item in enumerate(blocks_and_memories[:top_k * 2]):
            results.append({
                "memory_id": item["memory_id"],
                "block_id": item.get("block_id"),
                "content_preview": item.get("content_preview", ""),
                "graph_entities": item.get("entities", []),    # 触发此结果的实体
                "graph_score": item.get("ppr_score", 0.0),
                "importance": item.get("importance", 0.5),
                "decay_weight": item.get("decay_weight", 1.0),
                "source": "graph",
                "channel_rank": i + 1
            })

        return results

    async def _run_ppr(self, seed_entity_ids: list[str],
                        seed_scores: dict, tenant_id: str,
                        agent_id: str) -> list[dict]:
        """
        在 Neo4j 中运行 Personalized PageRank。
        使用 GDS Library 的 pageRank 算法，通过 sourceNodes 参数实现个性化。
        """
        # 构建 GDS 图投影（仅投影该 tenant/agent 的子图）
        projection_query = """
        CALL gds.graph.project.cypher(
            'ppr_subgraph_{tenant}_{agent}',
            'MATCH (n:PhraseNode) WHERE n.tenant_id = $tenant_id
             AND (n.agent_id = $agent_id OR n.agent_id IS NULL)
             AND n.valid_until IS NULL
             RETURN id(n) AS id',
            'MATCH (a:PhraseNode)-[r:RELATES_TO]-(b:PhraseNode)
             WHERE a.tenant_id = $tenant_id
             RETURN id(a) AS source, id(b) AS target, r.weight AS weight'
        )
        """.format(tenant=tenant_id[:8], agent=agent_id[:8])

        # 运行 PPR（GDS pageRank with personalization）
        ppr_query = """
        MATCH (seed:PhraseNode) WHERE seed.entity_id IN $seed_ids
        WITH collect(seed) AS seedNodes
        CALL gds.pageRank.stream(
            'ppr_subgraph_{tenant}_{agent}',
            {{
                maxIterations: $max_iter,
                dampingFactor: $damping,
                sourceNodes: seedNodes,
                relationshipWeightProperty: 'weight'
            }}
        )
        YIELD nodeId, score
        WITH gds.util.asNode(nodeId) AS node, score
        WHERE node.decay_weight > 0.1
        RETURN node.entity_id AS entity_id,
               node.name AS name,
               node.entity_type AS entity_type,
               score
        ORDER BY score DESC
        LIMIT $top_n
        """.format(tenant=tenant_id[:8], agent=agent_id[:8])

        results = await self.neo4j_client.run(
            ppr_query,
            seed_ids=seed_entity_ids,
            max_iter=self.PPR_MAX_ITERATIONS,
            damping=self.PPR_DAMPING,
            top_n=self.PPR_TOP_NODES
        )

        # 清理临时图投影（避免内存泄漏）
        await self.neo4j_client.run(
            f"CALL gds.graph.drop('ppr_subgraph_{tenant_id[:8]}_{agent_id[:8]}')"
        )

        return [dict(r) for r in results]

    async def _resolve_to_memories(self, entity_ids: list[str],
                                    tenant_id: str) -> list[dict]:
        """
        通过 HAS_CONTEXT 关系，从实体溯源到对应的 Block 和 Memory。
        """
        cypher = """
        MATCH (b:Block)-[:HAS_CONTEXT]->(n:PhraseNode)
        WHERE n.entity_id IN $entity_ids
          AND b.tenant_id = $tenant_id
        WITH b, collect(n.name) AS entities, max(n.importance) AS max_importance
        MATCH (mr:MemoryRecord {memory_id: b.memory_id})
        WHERE mr.status = 'active'
        RETURN b.block_id AS block_id,
               b.memory_id AS memory_id,
               b.content_preview AS content_preview,
               entities,
               max_importance AS importance,
               mr.decay_weight AS decay_weight
        ORDER BY max_importance DESC
        LIMIT 50
        """

        results = await self.neo4j_client.run(
            cypher,
            entity_ids=entity_ids,
            tenant_id=tenant_id
        )
        return [dict(r) for r in results]

    async def get_graph_context(self, entity_ids: list[str],
                                  depth: int = 1) -> dict:
        """
        获取实体的 N 跳图上下文（用于上下文组装）。
        depth=1：直接相关实体；depth=2：二跳相关实体。
        """
        cypher = f"""
        MATCH path = (seed:PhraseNode)-[:RELATES_TO*1..{depth}]-(related:PhraseNode)
        WHERE seed.entity_id IN $entity_ids
          AND related.valid_until IS NULL
        WITH related, relationships(path) AS rels, length(path) AS hops
        ORDER BY related.importance DESC, hops ASC
        LIMIT 30
        RETURN related.name AS name,
               related.entity_type AS entity_type,
               related.description AS description,
               [r in rels | r.relation_type] AS relation_path,
               hops
        """
        results = await self.neo4j_client.run(cypher, entity_ids=entity_ids)
        return {
            "related_entities": [dict(r) for r in results],
            "depth": depth
        }
```

### 6.6 RRF 融合算法

```python
def rrf_fusion(
    channel_results: dict[str, list[dict]],
    channel_weights: dict[str, float],
    k: int = 60
) -> list[dict]:
    """
    Reciprocal Rank Fusion with channel weights.

    公式: rrf_score = Σ_i (channel_weight_i / (k + rank_i))
    然后乘以 importance^0.3 × decay_weight^0.2 做生命周期加权。

    channel_weights 默认值（可通过 API 覆盖）：
      bm25:   1.2  (关键词精确匹配权重略高)
      vector: 1.0
      tree:   0.8
      graph:  0.9
    """
    DEFAULT_WEIGHTS = {"bm25": 1.2, "vector": 1.0, "tree": 0.8, "graph": 0.9}
    weights = {**DEFAULT_WEIGHTS, **channel_weights}

    fused_scores: dict[str, float] = {}
    candidate_map: dict[str, dict] = {}

    for channel_name, candidates in channel_results.items():
        w = weights.get(channel_name, 1.0)
        for rank, candidate in enumerate(candidates, start=1):
            # 去重粒度：memory_id（同一 memory 的不同 block 合并）
            mid = candidate["memory_id"]
            fused_scores[mid] = fused_scores.get(mid, 0.0) + w / (k + rank)

            if mid not in candidate_map:
                candidate_map[mid] = candidate
            else:
                # 合并同一 memory 的多个来源信息
                existing = candidate_map[mid]
                existing["sources"] = existing.get("sources", [candidate.get("source", "")])
                if candidate.get("source") not in existing["sources"]:
                    existing["sources"].append(candidate.get("source", ""))
                # 保留最高分的 content_preview
                if candidate.get("vector_score", 0) > existing.get("vector_score", 0):
                    existing["content_preview"] = candidate.get("content_preview", "")

    # 应用 importance × decay_weight 加权
    for mid in fused_scores:
        candidate = candidate_map[mid]
        importance = candidate.get("importance", 0.5)
        decay_weight = candidate.get("decay_weight", 1.0)
        fused_scores[mid] *= (importance ** 0.3) * (decay_weight ** 0.2)

    # 按融合分数排序
    sorted_mids = sorted(fused_scores, key=lambda m: fused_scores[m], reverse=True)
    return [
        {**candidate_map[mid], "final_score": fused_scores[mid]}
        for mid in sorted_mids
    ]
```

### 6.7 Cross-Encoder Reranking

```python
class CrossEncoderReranker:
    """
    使用 Cross-Encoder 模型对融合后的结果进行精排。
    模型：bge-reranker-v2-m3（支持中英双语）
    触发条件：候选数 > top_k 时才启用（避免小数据集额外延迟）
    """
    MODEL = "BAAI/bge-reranker-v2-m3"
    BATCH_SIZE = 32

    async def rerank(self, query: str, candidates: list[dict],
                      top_k: int) -> list[dict]:
        if len(candidates) <= top_k:
            return candidates

        # 构建 (query, passage) 对
        pairs = [
            (query, c.get("summary", "") or c.get("content_preview", ""))
            for c in candidates
        ]

        # 批量调用 Cross-Encoder（可本地部署或通过 API）
        scores = []
        for i in range(0, len(pairs), self.BATCH_SIZE):
            batch = pairs[i:i + self.BATCH_SIZE]
            batch_scores = await self.reranker_client.score(batch)
            scores.extend(batch_scores)

        # 将 reranker 分数与 RRF 融合分数加权合并
        for candidate, reranker_score in zip(candidates, scores):
            candidate["reranker_score"] = reranker_score
            # 最终分数：60% reranker + 40% rrf（保留 rrf 的生命周期加权影响）
            candidate["final_score"] = (
                0.6 * reranker_score +
                0.4 * candidate.get("final_score", 0.0)
            )

        # 按最终分数排序，返回 top_k
        candidates.sort(key=lambda c: c["final_score"], reverse=True)
        return candidates[:top_k]
```

---

## 7. Agentic 检索流程详解

### 7.1 Query Expansion（LLM 查询扩展）

```python
class AgenticRetriever:
    """
    Agentic Mode 检索：在 Lightweight 基础上增加 LLM 驱动的智能层。
    总延迟目标：p95 < 1500ms（1轮迭代）/ < 3000ms（最多 2 轮）
    """

    async def retrieve(self, query: str, agent_id: str, tenant_id: str,
                        filters: dict, config: dict) -> list[dict]:
        max_rounds = config.get("max_rounds", 2)
        satisfaction_threshold = config.get("satisfaction_threshold", 0.8)

        # Step 1: LLM 查询扩展
        expanded_queries = await self._expand_query(query)

        # Step 2: 多轮迭代检索
        accumulated_results = {}
        all_queries = [query] + expanded_queries

        for round_num in range(max_rounds):
            # 对所有查询并行执行 Lightweight 检索
            round_results = await asyncio.gather(*[
                self.lightweight_retriever.retrieve(
                    query=q, agent_id=agent_id, tenant_id=tenant_id,
                    filters=filters, top_k=20
                )
                for q in all_queries
            ])

            # 合并到累积结果集（按 memory_id 去重，保留最高分）
            for results in round_results:
                for r in results:
                    mid = r["memory_id"]
                    if mid not in accumulated_results or \
                       r["final_score"] > accumulated_results[mid]["final_score"]:
                        accumulated_results[mid] = r

            # 计算满足度分数
            satisfaction = await self._compute_satisfaction(
                query=query,
                results=list(accumulated_results.values())
            )

            if satisfaction >= satisfaction_threshold:
                break  # 已满足，不需要更多轮次

            if round_num < max_rounds - 1:
                # 还有剩余轮次：LLM 分析信息缺口，生成补充查询
                gap_queries = await self._identify_gaps(
                    original_query=query,
                    current_results=list(accumulated_results.values())
                )
                all_queries = gap_queries  # 下一轮只跑补充查询

        # Step 3: LLM 智能融合（语义去重 + 冲突消解）
        fused = await self._intelligent_fusion(
            query=query,
            results=list(accumulated_results.values())
        )

        # Step 4: Cross-Encoder 精排
        return await self.reranker.rerank(query=query, candidates=fused,
                                           top_k=config.get("max_results", 10))

    async def _expand_query(self, query: str) -> list[str]:
        """LLM 将原始查询分解为多个子查询"""
        prompt = f"""请将以下查询分解为 2-4 个更具体的子查询，用于多角度检索。

原始查询：{query}

要求：
- 每个子查询从不同角度覆盖原始查询的不同方面
- 子查询应比原始查询更具体（便于精确匹配）
- 避免简单重复原始查询的措辞

请以 JSON 数组格式返回子查询列表。示例：
["子查询1", "子查询2", "子查询3"]

只返回 JSON，不要任何前言。"""

        try:
            resp = await self.llm_client.chat_completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=300,
                temperature=0.3
            )
            import json
            queries = json.loads(resp)
            return queries[:4] if isinstance(queries, list) else []
        except Exception:
            return []

    async def _compute_satisfaction(self, query: str,
                                     results: list[dict]) -> float:
        """
        计算当前检索结果对原始查询的满足度（0.0 - 1.0）。
        简化版：基于最高 final_score 和结果数量启发式计算。
        完整版：调用 LLM 评估信息充分性。
        """
        if not results:
            return 0.0

        top_scores = sorted(
            [r.get("final_score", 0) for r in results], reverse=True
        )[:5]

        # 启发式：top-5 平均分超过 0.7 且有 5 条以上结果，认为基本满足
        avg_top5 = sum(top_scores) / len(top_scores)
        coverage = min(len(results) / 10, 1.0)  # 10 条视为完整覆盖

        return avg_top5 * 0.7 + coverage * 0.3

    async def _intelligent_fusion(self, query: str,
                                   results: list[dict]) -> list[dict]:
        """
        LLM 对累积结果集进行语义去重、冲突消解、重要性重排。
        """
        # 只对 top-30 结果进行 LLM 融合（控制 token 消耗）
        top_results = sorted(
            results, key=lambda r: r.get("final_score", 0), reverse=True
        )[:30]

        summaries = [
            f"[{i+1}] {r.get('title', 'Untitled')}: {r.get('summary', '')[:200]}"
            for i, r in enumerate(top_results)
        ]

        prompt = f"""针对以下查询，对检索结果进行整理：
1. 去除语义高度重复的结果（相似度 > 90%）
2. 标记信息冲突（同一事实的不同说法）
3. 对结果按与查询的相关性重新排序

查询：{query}

检索结果：
{chr(10).join(summaries)}

请返回保留结果的索引列表（按相关性降序），格式：
{{"keep_indices": [1, 3, 5, ...], "conflicts": [["idx_a", "idx_b", "reason"]]}}"""

        try:
            resp = await self.llm_client.chat_completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500,
                temperature=0.1
            )
            import json
            fusion_result = json.loads(resp)
            keep_indices = [i - 1 for i in fusion_result.get("keep_indices", [])]
            return [top_results[i] for i in keep_indices if 0 <= i < len(top_results)]
        except Exception:
            return top_results  # 融合失败时直接返回原列表
```

---

## 8. 降级策略

当某个存储引擎不可用时，检索流程的降级行为：

| 故障组件 | 影响 | 降级策略 | 对检索质量的影响 |
|---|---|---|---|
| **Elasticsearch 不可用** | BM25 通道失效 | 跳过 BM25，使用其余 3 路检索 + 调整 RRF 权重 | 关键词精确匹配能力下降，对专有名词召回率降低 |
| **Milvus 不可用** | Vector/Tree/Graph 通道均失效 | 仅 BM25 通道 + 降级提示警告 | 语义匹配完全失效；严重降级，立即告警 |
| **Neo4j 不可用** | Graph 通道失效 + 上下文组装中的图路径 | 跳过 Graph 通道；`include_graph_context=false` 强制关闭 | 多跳推理能力失效；图谱上下文丢失 |
| **LLM 不可用（Agentic）** | Query Expansion + 智能融合失效 | 自动降级为 Lightweight 模式 | Agentic 降为 Lightweight，延迟大幅降低 |
| **PostgreSQL 不可用** | Tree 展开失效（Block 内容无法读取）| 返回 Section 摘要代替 Block 内容；memory 元数据从 Redis 缓存读取 | 内容详情丢失，只返回摘要级结果 |

```python
class DegradationManager:
    """统一管理检索降级逻辑"""

    async def execute_with_degradation(self,
                                        channels: dict,
                                        query_embedding: list[float],
                                        **kwargs) -> dict[str, list[dict]]:
        """
        并行执行所有检索通道，失败的通道返回空列表（不阻塞其他通道）。
        """
        results = {}
        tasks = {
            name: asyncio.create_task(channel.search(query_embedding, **kwargs))
            for name, channel in channels.items()
        }

        for name, task in tasks.items():
            try:
                results[name] = await asyncio.wait_for(task, timeout=0.12)  # 120ms
            except asyncio.TimeoutError:
                results[name] = []
                logger.warning(f"Channel {name} timed out, degraded to empty")
                self.metrics.increment(f"mmp_channel_timeout_total",
                                        labels={"channel": name})
            except Exception as e:
                results[name] = []
                logger.error(f"Channel {name} failed: {e}, degraded to empty")
                self.metrics.increment(f"mmp_channel_error_total",
                                        labels={"channel": name})

        # 至少要有一个通道有结果，否则返回降级响应
        non_empty = sum(1 for r in results.values() if r)
        if non_empty == 0:
            raise RetrievalDegradedException(
                "All retrieval channels failed or timed out"
            )

        return results
```

---

## 9. 性能优化

### 9.1 Embedding 缓存

```python
class EmbeddingCache:
    """
    对相同查询的 Embedding 结果进行缓存，避免重复调用 Embedding API。
    缓存 Key：SHA256(model + "|" + text)
    TTL：1 小时（查询 Embedding 的时效性足够）
    """
    TTL_SECONDS = 3600

    async def get_or_embed(self, text: str, model: str) -> list[float]:
        import hashlib
        cache_key = f"emb:{hashlib.sha256(f'{model}|{text}'.encode()).hexdigest()[:32]}"

        cached = await self.redis.get(cache_key)
        if cached:
            import json
            return json.loads(cached)

        embedding = await self.embedding_svc.embed_single(text, model=model)
        await self.redis.set(cache_key, json.dumps(embedding), ex=self.TTL_SECONDS)
        return embedding
```

### 9.2 Milvus 连接池与批量操作

```python
# Milvus 连接管理（pymilvus 内部维护连接池）
connections.connect(
    alias="default",
    host=MILVUS_HOST,
    port=MILVUS_PORT,
    pool_size=10,              # 连接池大小
    timeout=30
)

# 批量 upsert（比逐条 insert 快 5-10x）
async def batch_upsert_blocks(records: list[dict]) -> None:
    BATCH_SIZE = 1000
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        block_collection.upsert(data=batch)
    block_collection.flush()  # 确保数据可查
```

### 9.3 Neo4j 连接池与查询优化

```python
# Neo4j 驱动配置（neo4j Python driver）
neo4j_driver = AsyncGraphDatabase.driver(
    NEO4J_URL,
    auth=(NEO4J_USER, NEO4J_PASSWORD),
    max_connection_pool_size=50,      # 最大连接数
    connection_timeout=30,
    max_transaction_retry_time=15
)

# PPR 查询优化：预先创建 GDS 图投影（在服务启动时，而非每次查询时）
# 对于静态图数据（不频繁更新）可以缓存 GDS 图投影
# 对于动态数据，每日凌晨重新构建投影
```

---

## 10. 可观测性

### 10.1 关键 Prometheus 指标

```yaml
# 检索通道延迟
- name: ams_retrieval_channel_duration_seconds
  type: histogram
  labels: [channel, mode]  # channel: bm25/vector/tree/graph; mode: lightweight/agentic
  buckets: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0]

# 检索通道可用性
- name: ams_retrieval_channel_errors_total
  type: counter
  labels: [channel, error_type]  # error_type: timeout/exception/empty

# RRF 融合后候选数量
- name: ams_retrieval_candidates_after_fusion
  type: histogram
  labels: [mode]

# Reranking 延迟
- name: ams_reranking_duration_seconds
  type: histogram
  labels: [model]

# PPR 图遍历节点数
- name: ams_graph_ppr_nodes_explored
  type: histogram
  labels: [agent_id]

# 检索结果质量（通过 feedback 反向计算）
- name: ams_retrieval_feedback_score
  type: histogram
  labels: [mode]
```

---

*下一步：[04-Agent-TES 详细设计](./04-Agent-TES.md) — 非侵入式遥测采集（Sidecar/eBPF/字节码插桩）、OTel Span Schema、Trace→Kafka 数据契约*
