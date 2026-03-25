---
title: "09-Storage-Schema 详细设计"
date: 2026-03-23T23:30:00+08:00
draft: true
tags: ["agent-memory", "schema", "ddl", "migration", "详细设计", "版本B"]
---

# Storage Schema 详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: 完整的 DDL、初始化脚本与数据迁移策略

---

## 1. PostgreSQL 完整 DDL

### 1.1 初始化脚本（顺序执行）

```sql
-- 0. 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- 文本相似度（可选）

-- ============================================================
-- 1. episodes 表
-- ============================================================
CREATE TABLE episodes (
    episode_id       VARCHAR(64) PRIMARY KEY,
    agent_id         VARCHAR(64) NOT NULL,
    session_id       VARCHAR(64),
    event_time       TIMESTAMPTZ NOT NULL,
    ingestion_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    title            TEXT NOT NULL,
    content_preview  TEXT,                  -- 前512字预览
    content_oss_key  VARCHAR(512),          -- OSS路径（内容>4KB时）
    importance       DECIMAL(4,1),
    outcome          VARCHAR(20)
                     CHECK (outcome IN ('success','failure','partial')),
    tags             TEXT[],
    consolidated     BOOLEAN DEFAULT FALSE,
    visibility       VARCHAR(20) NOT NULL DEFAULT 'private'
                     CHECK (visibility IN ('private','team','org')),
    team_id          VARCHAR(64),
    org_id           VARCHAR(64),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_episodes_agent_time
    ON episodes(agent_id, event_time DESC);

CREATE INDEX idx_episodes_unconsolidated
    ON episodes(consolidated, importance DESC)
    WHERE consolidated = FALSE;

CREATE INDEX idx_episodes_tags
    ON episodes USING GIN(tags);

CREATE INDEX idx_episodes_visibility
    ON episodes(visibility, team_id, org_id);

-- ============================================================
-- 2. skills 表
-- ============================================================
CREATE TABLE skills (
    skill_id         VARCHAR(64) PRIMARY KEY,
    name             VARCHAR(200) NOT NULL,
    version          INT NOT NULL DEFAULT 1,
    description      TEXT NOT NULL,
    trigger_intent   TEXT NOT NULL,
    workflow_steps   JSONB NOT NULL,
    preconditions    TEXT[],

    -- 质量指标
    success_rate     DECIMAL(5,4) DEFAULT 0,   -- 0.0000 ~ 1.0000
    usage_count      INT DEFAULT 0,
    avg_turns        DECIMAL(6,2),
    p95_latency_ms   DECIMAL(10,2),
    recent_results   JSONB,                    -- 最近20次结果（滑动窗口）

    -- 关系
    derived_from     TEXT[],                   -- 来源 Episode IDs
    supersedes       VARCHAR(64)
                     REFERENCES skills(skill_id) ON DELETE SET NULL,

    -- 状态 & 可见性
    status           VARCHAR(20) NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','active','deprecated')),
    visibility       VARCHAR(20) NOT NULL DEFAULT 'org'
                     CHECK (visibility IN ('private','team','org')),
    team_id          VARCHAR(64),
    org_id           VARCHAR(64),

    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_skills_name_active
    ON skills(name)
    WHERE status = 'active';

CREATE INDEX idx_skills_name_status
    ON skills(name, status);

CREATE INDEX idx_skills_success_rate
    ON skills(success_rate DESC)
    WHERE status = 'active';

-- ============================================================
-- 3. semantic_summaries 表
-- ============================================================
CREATE TABLE semantic_summaries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary_type     VARCHAR(30) NOT NULL
                     CHECK (summary_type IN ('section_l1','section_l2','community')),
    title            TEXT,
    content          TEXT NOT NULL,
    embedding        VECTOR(1536),

    -- 来源
    source_block_ids  TEXT[],        -- section_l1：来源 Block IDs
    source_summary_ids TEXT[],       -- section_l2：来源 l1 summary IDs
    community_id      VARCHAR(64),   -- community：对应 Neo4j community ID
    member_phrases    TEXT[],        -- community：成员实体名称

    agent_id         VARCHAR(64),    -- 私有知识归属，公共知识为 NULL
    doc_id           VARCHAR(64),
    visibility       VARCHAR(20) NOT NULL DEFAULT 'org'
                     CHECK (visibility IN ('private','team','org')),
    team_id          VARCHAR(64),
    org_id           VARCHAR(64),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    meta             JSONB
);

CREATE INDEX idx_summaries_type
    ON semantic_summaries(summary_type);

CREATE INDEX idx_summaries_community_id
    ON semantic_summaries(community_id)
    WHERE community_id IS NOT NULL;

CREATE INDEX idx_summaries_doc_id
    ON semantic_summaries(doc_id)
    WHERE doc_id IS NOT NULL;

-- pgvector 近似索引（IVF Flat）
CREATE INDEX idx_summaries_embedding
    ON semantic_summaries
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 200);

-- ============================================================
-- 4. semantic_blocks 表（Block 元数据，向量在 Milvus）
-- ============================================================
CREATE TABLE semantic_blocks (
    block_id         VARCHAR(64) PRIMARY KEY,
    doc_id           VARCHAR(64),
    agent_id         VARCHAR(64),
    block_type       VARCHAR(20) NOT NULL
                     CHECK (block_type IN ('text','table','img')),
    chunk_index      INT,
    content          TEXT,           -- < 4KB 直存；否则存 OSS
    content_oss_key  VARCHAR(512),
    tags             TEXT[],
    source_url       TEXT,
    visibility       VARCHAR(20) NOT NULL DEFAULT 'org'
                     CHECK (visibility IN ('private','team','org')),
    team_id          VARCHAR(64),
    org_id           VARCHAR(64),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    meta             JSONB
);

CREATE INDEX idx_blocks_doc_id
    ON semantic_blocks(doc_id);

CREATE INDEX idx_blocks_agent_id
    ON semantic_blocks(agent_id)
    WHERE agent_id IS NOT NULL;
```

---

## 2. Milvus Collection 初始化

### 2.1 初始化脚本（Python）

```python
from pymilvus import (
    connections, Collection, CollectionSchema,
    FieldSchema, DataType, utility
)

MILVUS_HOST = "milvus.middleware.svc"
MILVUS_PORT = 19530

def init_milvus_collections():
    connections.connect(host=MILVUS_HOST, port=MILVUS_PORT)

    # ── Collection 1: episodes ───────────────────────────────
    if not utility.has_collection("episodes"):
        schema = CollectionSchema(fields=[
            FieldSchema("episode_id",   DataType.VARCHAR,       max_length=64, is_primary=True),
            FieldSchema("agent_id",     DataType.VARCHAR,       max_length=64),
            FieldSchema("visibility",   DataType.VARCHAR,       max_length=20),
            FieldSchema("team_id",      DataType.VARCHAR,       max_length=64),
            FieldSchema("outcome",      DataType.VARCHAR,       max_length=20),
            FieldSchema("importance",   DataType.FLOAT),
            FieldSchema("event_time",   DataType.INT64),        # Unix timestamp
            FieldSchema("consolidated", DataType.BOOL),
            FieldSchema("embedding",    DataType.FLOAT_VECTOR,  dim=1536),
        ])
        col = Collection("episodes", schema)
        col.create_index("embedding", {
            "index_type": "HNSW",
            "metric_type": "COSINE",
            "params": {"M": 16, "efConstruction": 200}
        })
        col.load()
        print("Collection 'episodes' created.")

    # ── Collection 2: semantic_blocks ────────────────────────
    if not utility.has_collection("semantic_blocks"):
        schema = CollectionSchema(fields=[
            FieldSchema("block_id",        DataType.VARCHAR,       max_length=64, is_primary=True),
            FieldSchema("agent_id",        DataType.VARCHAR,       max_length=64),
            FieldSchema("doc_id",          DataType.VARCHAR,       max_length=64),
            FieldSchema("block_type",      DataType.VARCHAR,       max_length=20),
            FieldSchema("chunk_index",     DataType.INT32),
            FieldSchema("has_oss_content", DataType.BOOL),
            FieldSchema("visibility",      DataType.VARCHAR,       max_length=20),
            FieldSchema("team_id",         DataType.VARCHAR,       max_length=64),
            FieldSchema("created_at",      DataType.INT64),
            FieldSchema("embedding",       DataType.FLOAT_VECTOR,  dim=1536),
        ])
        col = Collection("semantic_blocks", schema)

        # 按 agent_id 分区（公共知识 + 各 Agent 私有知识）
        col.create_partition("public")

        col.create_index("embedding", {
            "index_type": "IVF_HNSW",
            "metric_type": "COSINE",
            "params": {"nlist": 4096, "M": 16, "efConstruction": 200}
        })
        col.load()
        print("Collection 'semantic_blocks' created.")

    # ── Collection 3: skills ─────────────────────────────────
    if not utility.has_collection("skills"):
        schema = CollectionSchema(fields=[
            FieldSchema("skill_id",     DataType.VARCHAR,       max_length=64, is_primary=True),
            FieldSchema("status",       DataType.VARCHAR,       max_length=20),
            FieldSchema("success_rate", DataType.FLOAT),
            FieldSchema("embedding",    DataType.FLOAT_VECTOR,  dim=1536),
        ])
        col = Collection("skills", schema)
        col.create_index("embedding", {
            "index_type": "HNSW",
            "metric_type": "COSINE",
            "params": {"M": 16, "efConstruction": 200}
        })
        col.load()
        print("Collection 'skills' created.")

    print("Milvus initialization complete.")

if __name__ == "__main__":
    init_milvus_collections()
```

---

## 3. Neo4j 初始化

### 3.1 约束与索引

```cypher
// ── 唯一约束 ──────────────────────────────────────────────
CREATE CONSTRAINT phrase_node_id IF NOT EXISTS
    FOR (n:PhraseNode) REQUIRE n.node_id IS UNIQUE;

CREATE CONSTRAINT community_node_id IF NOT EXISTS
    FOR (n:CommunityNode) REQUIRE n.community_id IS UNIQUE;

CREATE CONSTRAINT skill_node_id IF NOT EXISTS
    FOR (n:SkillNode) REQUIRE n.skill_id IS UNIQUE;

// ── 查询索引 ──────────────────────────────────────────────
CREATE INDEX phrase_node_phrase IF NOT EXISTS
    FOR (n:PhraseNode) ON (n.phrase);

CREATE INDEX phrase_node_type IF NOT EXISTS
    FOR (n:PhraseNode) ON (n.phrase_type);

CREATE INDEX phrase_node_agent IF NOT EXISTS
    FOR (n:PhraseNode) ON (n.agent_id);

CREATE INDEX skill_node_name IF NOT EXISTS
    FOR (n:SkillNode) ON (n.name);
```

### 3.2 初始数据（公共核心概念）

```cypher
// 预置几个基础实体，避免第一次聚类时图过于稀疏
MERGE (:PhraseNode {
    node_id:       "pn_python",
    phrase:        "python",
    phrase_type:   "LANGUAGE",
    canonical_form:"python",
    mention_count: 0,
    agent_id:      null
});

MERGE (:PhraseNode {
    node_id:       "pn_pandas",
    phrase:        "pandas",
    phrase_type:   "LIBRARY",
    canonical_form:"pandas",
    mention_count: 0,
    agent_id:      null
});
```

---

## 4. ClickHouse 建表

```sql
-- 执行顺序：先建库，再建表
CREATE DATABASE IF NOT EXISTS agent_telemetry;

USE agent_telemetry;

-- （DDL 见 06-Agent-TES.md 第4节，此处不重复）
-- 确保 TTL 配置正确：
--   agent_spans:          TTL start_time + INTERVAL 90 DAY
--   agent_skill_sessions: TTL event_time + INTERVAL 180 DAY
```

---

## 5. 数据迁移策略

### 5.1 版本管理

使用 **Flyway**（或 Liquibase）管理 PostgreSQL Schema 迁移：

```
db/migrations/
├── V1__init_schema.sql               # 初始建表（本文档 DDL）
├── V2__add_team_id_to_episodes.sql   # 后续新增字段示例
└── V3__add_pgvector_index.sql        # 后续新增索引示例
```

```sql
-- V2__add_team_id_to_episodes.sql 示例（向后兼容）
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS team_id VARCHAR(64);
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS org_id  VARCHAR(64);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_episodes_team
    ON episodes(team_id) WHERE team_id IS NOT NULL;
```

> **原则**：迁移脚本只做 `ADD COLUMN` / `CREATE INDEX CONCURRENTLY`，不做 `DROP COLUMN` / `ALTER COLUMN TYPE`（破坏性变更）。破坏性变更需单独评审。

### 5.2 Milvus Collection 迁移

Milvus 不支持在线 Schema 变更（如增加 field）。迁移步骤：

```
1. 创建新 Collection（如 episodes_v2）
2. 双写：新数据同时写 episodes 和 episodes_v2
3. 历史数据迁移脚本：从 episodes 读取，写入 episodes_v2
4. 切换：AMS 配置切换到 episodes_v2
5. 确认无流量后，删除 episodes（旧）
```

### 5.3 嵌入模型升级

若升级 Embedding 模型（如从 text-embedding-3-small 升级到 text-embedding-3-large，维度从 1536 变化），需要全量重新嵌入：

```python
# 重新嵌入脚本（离线批处理）
async def reembed_all_blocks(batch_size: int = 100):
    offset = 0
    while True:
        rows = await pg.fetch("""
            SELECT block_id, content FROM semantic_blocks
            ORDER BY created_at LIMIT $1 OFFSET $2
        """, batch_size, offset)

        if not rows:
            break

        for row in rows:
            content = row["content"] or await load_from_oss(row["block_id"])
            new_embedding = await new_embedding_model.encode(content)
            await milvus_upsert(row["block_id"], new_embedding)

        offset += batch_size
        await asyncio.sleep(0.1)   # 限速，避免打满 Embedding API
```

---

## 6. 数据初始化验证

系统上线后，执行以下验证脚本确认 Schema 正确：

```bash
#!/bin/bash
# scripts/validate-schema.sh

echo "=== PostgreSQL Schema Check ==="
psql $DATABASE_URL -c "\dt" | grep -E "episodes|skills|semantic"

psql $DATABASE_URL -c "
SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass)) AS size
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
"

echo "=== Milvus Collection Check ==="
python3 - <<'EOF'
from pymilvus import connections, utility
connections.connect(host="milvus.middleware.svc", port=19530)
for col in ["episodes", "semantic_blocks", "skills"]:
    exists = utility.has_collection(col)
    print(f"  {col}: {'OK' if exists else 'MISSING'}")
EOF

echo "=== Neo4j Constraint Check ==="
cypher-shell -u neo4j -p $NEO4J_PASSWORD \
    "SHOW CONSTRAINTS YIELD name, type WHERE name CONTAINS 'phrase' RETURN name, type;"

echo "=== All checks done ==="
```

---

*下一步：[10-Deployment 部署与运维](./10-Deployment.md)*
