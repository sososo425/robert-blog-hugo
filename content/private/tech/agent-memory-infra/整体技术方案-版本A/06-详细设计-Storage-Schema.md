---
title: "06-详细设计-Storage-Schema"
date: 2026-03-23T14:00:00+08:00
draft: true
tags: ["agent-memory", "storage", "schema", "database", "方案A"]
---

# 06-详细设计-Storage-Schema

## 1. 模块概述

本文档是 Agentic Memory 系统的**数据库 Schema 参考手册**，涵盖所有存储层的完整定义、DDL、初始化脚本及运维指南。Storage Schema 作为系统的"物理层"，将4层记忆模型映射到具体的存储技术栈。

### 1.1 存储技术栈总览

| 记忆层级 | 存储技术 | 数据模型 | 适用场景 |
|---------|---------|---------|---------|
| Working Memory | Redis | Hash | 超高速读写、TTL 过期 |
| Episode Memory | LanceDB + S3 | 向量+文档 | 大规模语义检索、低成本归档 |
| Procedural Memory | PostgreSQL + pgvector | 关系型+向量 | 技能存储、事务一致性 |
| Semantic Memory | Neo4j + PostgreSQL | 图+向量 | 知识图谱、社区摘要 |
| Telemetry | ClickHouse | 列式时序 | 执行轨迹分析、监控告警 |
| Event Streaming | Kafka | 消息流 | 异步处理、解耦 |

### 1.2 存储架构图

```mermaid
flowchart TB
    subgraph "Agent Runtime"
        A[Agent Session]
        B[Context Manager]
    end

    subgraph "Working Layer"
        R[(Redis<br/>Working Memory)]
    end

    subgraph "Vector Layer"
        L[(LanceDB<br/>Episode Memory)]
    end

    subgraph "Relational Layer"
        P[(PostgreSQL<br/>Skills + Communities)]
    end

    subgraph "Graph Layer"
        N[(Neo4j<br/>Knowledge Graph)]
    end

    subgraph "Analytics Layer"
        C[(ClickHouse<br/>Telemetry)]
    end

    A -->|HMGET/HMSET| R
    A -->|ANN Search| L
    A -->|SQL Query| P
    A -->|Cypher| N
    B -.->|Async Flush| C
```

---

## 2. Redis Schema（Working Memory）

### 2.1 设计理念

- **数据结构**：Hash（HSET/HGETALL）
- **Key 命名**：`wm:{agent_id}:{session_id}`
- **TTL 策略**：session 级别 24h，可配置
- **序列化**：JSON 字符串存储复杂对象

### 2.2 完整 Schema 定义

```redis
# Key: wm:{agent_id}:{session_id}
# Type: Hash
# TTL: 86400 seconds (24h)

HSET wm:agent_001:session_abc \
  session_id "session_abc" \
  agent_id "agent_001" \
  current_plan '{"goal": "分析文档", "steps": [...]}' \
  tool_results '[{"tool": "search", "result": "..."}]' \
  context_summary "用户正在询问关于..." \
  memory_ids '["mem_001", "mem_002"]' \
  working_items '{"key": "value"}' \
  turn_number "5" \
  created_at "2026-03-23T10:00:00Z" \
  updated_at "2026-03-23T10:15:00Z" \
  metadata '{"source": "api", "version": "v1"}'
```

### 2.3 Field 详细说明

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `session_id` | string | 会话唯一标识 | "sess_abc123" |
| `agent_id` | string | Agent 唯一标识 | "agent_001" |
| `current_plan` | JSON | 当前执行计划 | `{"goal": "", "steps": []}` |
| `tool_results` | JSON[] | 最近工具执行结果 | `[{"tool": "search", ...}]` |
| `context_summary` | string | 上下文摘要（压缩后） | "用户询问..." |
| `memory_ids` | JSON[] | 已加载的记忆 ID | `["mem_001", "mem_002"]` |
| `working_items` | JSON | 工作区临时数据 | `{"draft": "..."}` |
| `turn_number` | int | 当前轮次 | 5 |
| `created_at` | ISO8601 | 创建时间 | "2026-03-23T10:00:00Z" |
| `updated_at` | ISO8601 | 更新时间 | "2026-03-23T10:15:00Z" |
| `metadata` | JSON | 扩展元数据 | `{"source": "api"}` |

### 2.4 Redis 初始化脚本

```bash
#!/bin/bash
# init_redis.sh
# Redis 初始化脚本

set -e

REDIS_HOST=${REDIS_HOST:-"localhost"}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PASSWORD=${REDIS_PASSWORD:-""}

echo "初始化 Redis Schema for Agentic Memory..."

# 连接参数
AUTH_CMD=""
if [ -n "$REDIS_PASSWORD" ]; then
    AUTH_CMD="-a $REDIS_PASSWORD"
fi

redis-cli -h $REDIS_HOST -p $REDIS_PORT $AUTH_CMD << 'EOF'
# 配置持久化
CONFIG SET appendonly yes
CONFIG SET save "900 1 300 10 60 10000"

# 配置内存策略（优先淘汰 TTL 短的）
CONFIG SET maxmemory-policy volatile-lru

# 配置 Key 过期事件通知（用于 Episode Flush 触发）
CONFIG SET notify-keyspace-events Ex

# 创建索引（RedisSearch 可选）
# FT.CREATE idx:working_memory ON HASH PREFIX 1 wm: SCHEMA session_id TAG agent_id TAG

ECHO "Redis Schema 初始化完成"
EOF

echo "✓ Redis 初始化完成"
```

---

## 3. PostgreSQL Schema

### 3.1 数据库设计原则

- **扩展**：使用 `pgvector` 扩展存储向量
- **分区**：大表按时间分区（episode_executions）
- **索引**：GIN 索引用于 JSON/数组，HNSW 用于向量检索
- **约束**：外键约束保证数据一致性

### 3.2 完整 DDL

```sql
-- init_postgres.sql
-- PostgreSQL Schema 初始化脚本
-- 适用于：Procedural Memory + Community + 元数据

-- 启用必要扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- 1. Skills 表（Procedural Memory 核心）
-- ============================================
CREATE TABLE skills (
    skill_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- 技能代码模板（参数化）
    code_template TEXT NOT NULL,
    code_language VARCHAR(50) DEFAULT 'python',

    -- 向量表示（用于语义检索）
    embedding vector(1536),

    -- 版本控制
    version INTEGER DEFAULT 1,
    skill_type VARCHAR(50) CHECK (skill_type IN ('atomic', 'composite', 'workflow')),

    -- 质量指标
    success_rate FLOAT DEFAULT 0.0 CHECK (success_rate >= 0 AND success_rate <= 1),
    usage_count INTEGER DEFAULT 0,
    avg_latency_ms FLOAT DEFAULT 0.0,

    -- 归属与可见性
    agent_id VARCHAR(100) NOT NULL,
    visibility VARCHAR(20) DEFAULT 'private'
        CHECK (visibility IN ('private', 'team', 'org', 'public')),

    -- 标签（用于过滤）
    tags TEXT[],

    -- 依赖关系（存储 skill_id 数组）
    dependencies UUID[],

    -- 参数定义（JSON Schema）
    parameters JSONB,

    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- 约束
    CONSTRAINT chk_name_not_empty CHECK (name <> ''),
    CONSTRAINT chk_version_positive CHECK (version > 0)
);

-- Skills 索引
CREATE INDEX idx_skills_agent_id ON skills(agent_id);
CREATE INDEX idx_skills_visibility ON skills(visibility);
CREATE INDEX idx_skills_tags ON skills USING GIN(tags);
CREATE INDEX idx_skills_created_at ON skills(created_at);
CREATE INDEX idx_skills_success_rate ON skills(success_rate DESC);

-- HNSW 向量索引（用于语义搜索）
CREATE INDEX idx_skills_embedding ON skills
    USING hnsw(embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- ============================================
-- 2. Skill Executions 表（执行记录）
-- ============================================
CREATE TABLE skill_executions (
    execution_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    skill_id UUID NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
    agent_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(100),

    -- 执行上下文
    input_hash VARCHAR(64),  -- SHA256 of input
    input_summary TEXT,      -- 输入摘要
    output_summary TEXT,     -- 输出摘要

    -- 执行结果
    success BOOLEAN NOT NULL,
    error_message TEXT,

    -- 性能指标
    latency_ms FLOAT,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd DECIMAL(10, 6),

    -- 时间戳
    executed_at TIMESTAMPTZ DEFAULT NOW(),

    -- 扩展元数据
    metadata JSONB
);

-- Skill Executions 索引与分区
CREATE INDEX idx_skill_exec_skill_id ON skill_executions(skill_id);
CREATE INDEX idx_skill_exec_agent_id ON skill_executions(agent_id);
CREATE INDEX idx_skill_exec_success ON skill_executions(success);
CREATE INDEX idx_skill_exec_executed_at ON skill_executions(executed_at DESC);

-- 按月分区（执行记录量大）
CREATE TABLE skill_executions_y2026m03 PARTITION OF skill_executions
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- ============================================
-- 3. Skill Versions 表（版本历史）
-- ============================================
CREATE TABLE skill_versions (
    version_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    skill_id UUID NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
    version INTEGER NOT NULL,

    -- 版本内容
    code_template TEXT NOT NULL,
    description TEXT,
    parameters JSONB,

    -- 变更说明
    change_summary TEXT,
    changed_by VARCHAR(100),

    -- 版本质量快照
    success_rate_at_version FLOAT,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(skill_id, version)
);

CREATE INDEX idx_skill_versions_skill_id ON skill_versions(skill_id);

-- ============================================
-- 4. Skill Relations 表（Skill Mesh）
-- ============================================
CREATE TABLE skill_relations (
    relation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_skill_id UUID NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
    to_skill_id UUID NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,

    relation_type VARCHAR(50) NOT NULL
        CHECK (relation_type IN ('DEPENDS_ON', 'OFTEN_COMBINED', 'SUPERSEDES', 'SPECIALIZES', 'CONFLICTS_WITH')),

    weight FLOAT DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),

    evidence_count INTEGER DEFAULT 0,  -- 支持该关系的证据数量

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(from_skill_id, to_skill_id, relation_type)
);

CREATE INDEX idx_skill_rel_from ON skill_relations(from_skill_id);
CREATE INDEX idx_skill_rel_to ON skill_relations(to_skill_id);
CREATE INDEX idx_skill_rel_type ON skill_relations(relation_type);

-- ============================================
-- 5. Community Summaries 表（语义记忆）
-- ============================================
CREATE TABLE community_summaries (
    community_id VARCHAR(100) PRIMARY KEY,

    -- 社区统计
    entity_count INTEGER NOT NULL,
    relation_count INTEGER NOT NULL,

    -- 摘要内容
    summary_text TEXT NOT NULL,
    summary_embedding vector(1536),

    -- 关键实体（JSON 数组）
    key_entities JSONB,

    -- 层级（用于多级社区）
    hierarchy_level INTEGER DEFAULT 1,
    parent_community_id VARCHAR(100),

    -- 检测元数据
    detection_algorithm VARCHAR(50) DEFAULT 'leiden',
    detection_params JSONB,

    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- 有效性标记
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_comm_summaries_active ON community_summaries(is_active);
CREATE INDEX idx_comm_summaries_level ON community_summaries(hierarchy_level);
CREATE INDEX idx_comm_summaries_embedding ON community_summaries
    USING hnsw(summary_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 全文搜索索引
ALTER TABLE community_summaries
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', summary_text)) STORED;
CREATE INDEX idx_comm_summaries_search ON community_summaries USING GIN(search_vector);

-- ============================================
-- 6. Episodes Metadata 表（Episode 元数据索引）
-- ============================================
CREATE TABLE episodes (
    episode_id UUID PRIMARY KEY,
    agent_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(100) NOT NULL,

    -- 内容摘要（用于列表展示）
    content_summary TEXT,
    content_preview TEXT,

    -- 向量化状态（实际向量存储在 LanceDB）
    has_embedding BOOLEAN DEFAULT TRUE,
    embedding_model VARCHAR(50) DEFAULT 'bge-m3',

    -- 质量评分
    importance_score FLOAT CHECK (importance_score >= 0 AND importance_score <= 10),

    -- 分类标签
    tags TEXT[],
    episode_type VARCHAR(50) DEFAULT 'conversation',

    -- 时间戳（双时间模型）
    event_time TIMESTAMPTZ NOT NULL,      -- 事件发生时间
    ingestion_time TIMESTAMPTZ DEFAULT NOW(),  -- 摄入时间

    -- 归档状态
    is_archived BOOLEAN DEFAULT FALSE,
    archive_reason VARCHAR(50),

    -- LanceDB 引用
    lancedb_uri VARCHAR(500),

    -- 扩展元数据
    metadata JSONB
);

CREATE INDEX idx_episodes_agent_id ON episodes(agent_id);
CREATE INDEX idx_episodes_session_id ON episodes(session_id);
CREATE INDEX idx_episodes_importance ON episodes(importance_score DESC);
CREATE INDEX idx_episodes_tags ON episodes USING GIN(tags);
CREATE INDEX idx_episodes_event_time ON episodes(event_time DESC);
CREATE INDEX idx_episodes_archived ON episodes(is_archived) WHERE is_archived = FALSE;

-- ============================================
-- 7. Reflections 表（反思记录）
-- ============================================
CREATE TABLE reflections (
    reflection_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- 源 Episode
    source_episode_ids UUID[] NOT NULL,

    -- 反思内容
    reflection_text TEXT NOT NULL,
    reflection_type VARCHAR(50) DEFAULT 'pattern'
        CHECK (reflection_type IN ('pattern', 'insight', 'anomaly', 'learning')),

    -- 关联实体（链接到知识图谱）
    related_entities TEXT[],  -- entity names in Neo4j

    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- 质量评估
    confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),

    metadata JSONB
);

CREATE INDEX idx_reflections_episodes ON reflections USING GIN(source_episode_ids);
CREATE INDEX idx_reflections_type ON reflections(reflection_type);

-- ============================================
-- 8. Agent Registry 表（Agent 注册中心）
-- ============================================
CREATE TABLE agents (
    agent_id VARCHAR(100) PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    agent_type VARCHAR(50) DEFAULT 'general',

    -- 配置
    config JSONB,

    -- 记忆配置
    memory_policy JSONB DEFAULT '{
        "working_memory_ttl_hours": 24,
        "episode_importance_threshold": 5.0,
        "auto_archive_days": 90
    }'::jsonb,

    -- 统计
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ,
    total_episodes INTEGER DEFAULT 0,
    total_skills INTEGER DEFAULT 0,

    -- 状态
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived'))
);

CREATE INDEX idx_agents_status ON agents(status);

-- ============================================
-- 9. 更新触发器函数
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 应用触发器
CREATE TRIGGER update_skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_community_summaries_updated_at
    BEFORE UPDATE ON community_summaries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 10. 自动更新 Skill 成功率的函数
-- ============================================
CREATE OR REPLACE FUNCTION update_skill_success_rate()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE skills
    SET
        success_rate = (
            SELECT COALESCE(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 0)
            FROM skill_executions
            WHERE skill_id = NEW.skill_id
            AND executed_at > NOW() - INTERVAL '30 days'
        ),
        usage_count = (
            SELECT COUNT(*) FROM skill_executions WHERE skill_id = NEW.skill_id
        ),
        avg_latency_ms = (
            SELECT COALESCE(AVG(latency_ms), 0)
            FROM skill_executions
            WHERE skill_id = NEW.skill_id
        ),
        updated_at = NOW()
    WHERE skill_id = NEW.skill_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_skill_stats
    AFTER INSERT ON skill_executions
    FOR EACH ROW EXECUTE FUNCTION update_skill_success_rate();

-- ============================================
-- 11. 初始数据
-- ============================================
-- 创建系统 Agent
INSERT INTO agents (agent_id, agent_name, agent_type, config) VALUES
('system', 'System Agent', 'system', '{"description": "System maintenance agent"}'),
('default', 'Default Agent', 'general', '{"description": "Default general-purpose agent"}');

-- ============================================
-- 完成
-- ============================================
SELECT 'PostgreSQL Schema 初始化完成' AS status;
```

### 3.3 数据库连接池配置

```python
# db_config.py
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg
from asyncpg import Pool

POSTGRES_URL = "postgresql://user:password@localhost:5432/agent_memory"

class PostgresManager:
    """PostgreSQL 连接池管理器"""

    def __init__(self, dsn: str = POSTGRES_URL):
        self.dsn = dsn
        self._pool: Pool | None = None

    async def initialize(self):
        """初始化连接池"""
        self._pool = await asyncpg.create_pool(
            dsn=self.dsn,
            min_size=5,
            max_size=20,
            command_timeout=60,
            server_settings={
                'jit': 'off',  # 禁用 JIT 以避免向量化查询问题
            }
        )

    async def close(self):
        """关闭连接池"""
        if self._pool:
            await self._pool.close()

    @asynccontextmanager
    async def acquire(self) -> AsyncGenerator[asyncpg.Connection, None]:
        """获取连接上下文"""
        async with self._pool.acquire() as conn:
            yield conn

    async def fetch(self, query: str, *args):
        """执行查询"""
        async with self.acquire() as conn:
            return await conn.fetch(query, *args)

    async def fetchrow(self, query: str, *args):
        """查询单行"""
        async with self.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def execute(self, query: str, *args):
        """执行命令"""
        async with self.acquire() as conn:
            return await conn.execute(query, *args)

# 全局实例
pg_manager = PostgresManager()
```

---

## 4. LanceDB Schema（Episode + Content Block）

### 4.1 设计理念

- **存储位置**：S3 兼容对象存储（MinIO/AWS S3）
- **数据模型**：Arrow 表结构，支持向量+标量混合
- **索引**：IVF_PQ 向量索引
- **优势**：Serverless、列式压缩、高效过滤

### 4.2 Python Schema 定义

```python
# lancedb_schema.py
"""
LanceDB Schema 定义
用于 Episode Memory 和 Content Block 存储
"""

import pyarrow as pa
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Dict, Any
from uuid import UUID

import lancedb
import numpy as np
from lancedb.embeddings import EmbeddingFunctionRegistry
from lancedb.pydantic import LanceModel, Vector

# ============================================
# 1. Episode 表 Schema
# ============================================

class EpisodeRecord(LanceModel):
    """Episode 记录 Schema（Pydantic + LanceDB）"""

    # 主键
    episode_id: str

    # 归属
    agent_id: str
    session_id: str

    # 内容（原始文本，用于展示）
    content_text: str

    # 向量化内容（用于语义检索）
    # 维度：1536（BGE-m3）
    embedding: Vector(1536)

    # 质量评分
    importance_score: float  # 0-10

    # 分类
    tags: List[str]
    episode_type: str  # 'conversation', 'task', 'error', 'learning'

    # 双时间戳
    event_time: datetime  # 事件发生时间
    ingestion_time: datetime  # 数据摄入时间

    # 归档状态
    is_archived: bool

    # 扩展字段（JSON 序列化）
    metadata: str  # JSON string

    # 关联记忆
    related_episode_ids: List[str]
    related_skill_ids: List[str]


# Arrow Schema（用于直接创建表）
EPISODE_ARROW_SCHEMA = pa.schema([
    pa.field("episode_id", pa.string(), nullable=False),
    pa.field("agent_id", pa.string(), nullable=False),
    pa.field("session_id", pa.string(), nullable=False),
    pa.field("content_text", pa.large_string(), nullable=False),
    pa.field("embedding", pa.list_(pa.float32(), 1536), nullable=False),
    pa.field("importance_score", pa.float32(), nullable=False),
    pa.field("tags", pa.list_(pa.string())),
    pa.field("episode_type", pa.string(), nullable=False),
    pa.field("event_time", pa.timestamp('us')),
    pa.field("ingestion_time", pa.timestamp('us')),
    pa.field("is_archived", pa.bool_()),
    pa.field("metadata", pa.large_string()),  # JSON
    pa.field("related_episode_ids", pa.list_(pa.string())),
    pa.field("related_skill_ids", pa.list_(pa.string())),
])


# ============================================
# 2. Content Block 表 Schema（存储大块内容）
# ============================================

class ContentBlockRecord(LanceModel):
    """Content Block - 存储原始内容的大块数据"""

    block_id: str
    episode_id: str  # 关联的 episode

    # 块类型
    block_type: str  # 'text', 'code', 'json', 'tool_result', 'image_ref'

    # 内容（可能很大）
    content: str

    # 向量（如果内容需要检索）
    embedding: Optional[Vector(1536)]

    # 位置信息
    sequence_order: int  # 在 episode 中的顺序

    # 时间戳
    created_at: datetime


CONTENT_BLOCK_ARROW_SCHEMA = pa.schema([
    pa.field("block_id", pa.string(), nullable=False),
    pa.field("episode_id", pa.string(), nullable=False),
    pa.field("block_type", pa.string(), nullable=False),
    pa.field("content", pa.large_string(), nullable=False),
    pa.field("embedding", pa.list_(pa.float32(), 1536)),
    pa.field("sequence_order", pa.int32()),
    pa.field("created_at", pa.timestamp('us')),
])


# ============================================
# 3. Episode Store 管理类
# ============================================

class LanceDBEpisodeStore:
    """LanceDB Episode 存储管理"""

    def __init__(self, uri: str = "s3://agent-memory/episodes"):
        """
        Args:
            uri: S3 URI 或本地路径
                - S3: "s3://bucket/episodes"
                - 本地: "./data/episodes"
        """
        self.uri = uri
        self.db = None
        self.episode_table = None
        self.block_table = None

    async def initialize(self):
        """初始化数据库连接"""
        self.db = await lancedb.connect_async(self.uri)

        # 获取或创建表
        try:
            self.episode_table = await self.db.open_table("episodes")
        except Exception:
            self.episode_table = await self.db.create_table(
                "episodes",
                schema=EPISODE_ARROW_SCHEMA,
                exist_ok=True
            )

        try:
            self.block_table = await self.db.open_table("content_blocks")
        except Exception:
            self.block_table = await self.db.create_table(
                "content_blocks",
                schema=CONTENT_BLOCK_ARROW_SCHEMA,
                exist_ok=True
            )

        # 创建索引
        await self._ensure_indices()

    async def _ensure_indices(self):
        """确保索引存在"""
        # Episode 表向量索引
        try:
            await self.episode_table.create_index(
                column="embedding",
                index_type="IVF_PQ",
                metric="cosine",
                num_partitions=64,
                num_sub_vectors=16
            )
        except Exception as e:
            print(f"Index may already exist: {e}")

        # 标量索引
        await self.episode_table.create_scalar_index("agent_id", "BTREE")
        await self.episode_table.create_scalar_index("session_id", "BTREE")
        await self.episode_table.create_scalar_index("event_time", "BTREE")
        await self.episode_table.create_scalar_index("importance_score", "BTREE")

    async def insert_episode(self, episode: EpisodeRecord) -> str:
        """插入 Episode"""
        await self.episode_table.add([episode.model_dump()])
        return episode.episode_id

    async def search_similar(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        agent_id: Optional[str] = None,
        min_importance: float = 0.0,
        time_range_days: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """语义相似度搜索"""

        # 构建查询
        query = self.episode_table.search(query_embedding).metric("cosine")

        # 应用过滤器
        filters = [f"importance_score >= {min_importance}"]
        if agent_id:
            filters.append(f"agent_id = '{agent_id}'")
        if time_range_days:
            filters.append(f"event_time >= timestamp '{datetime.now().isoformat()}' - INTERVAL '{time_range_days} days'")

        if filters:
            query = query.where(" AND ".join(filters))

        # 执行搜索
        results = await query.limit(top_k).to_list()
        return results

    async def get_by_id(self, episode_id: str) -> Optional[Dict[str, Any]]:
        """通过 ID 获取 Episode"""
        results = await self.episode_table \
            .search() \
            .where(f"episode_id = '{episode_id}'") \
            .limit(1) \
            .to_list()
        return results[0] if results else None

    async def archive_old_episodes(self, days_old: int, min_importance: float = 5.0) -> int:
        """归档旧 Episode（软删除）"""
        from lancedb import LanceDBConnection

        cutoff_date = datetime.now() - timedelta(days=days_old)

        # 查找需要归档的记录
        results = await self.episode_table \
            .search() \
            .where(f"event_time < timestamp '{cutoff_date.isoformat}' AND importance_score < {min_importance} AND is_archived = false") \
            .limit(10000) \
            .to_list()

        # 标记为已归档
        archived_count = 0
        for record in results:
            record["is_archived"] = True
            archived_count += 1

        if archived_count > 0:
            await self.episode_table.merge_insert("episode_id") \
                .when_matched_update_all() \
                .execute(results)

        return archived_count


# ============================================
# 4. 初始化脚本
# ============================================

async def init_lancedb(uri: str = "s3://agent-memory/episodes"):
    """初始化 LanceDB"""
    store = LanceDBEpisodeStore(uri)
    await store.initialize()
    print(f"✓ LanceDB 初始化完成: {uri}")
    return store


if __name__ == "__main__":
    import asyncio
    asyncio.run(init_lancedb("./data/lancedb"))
```

### 4.3 S3 存储配置

```python
# s3_config.py
import os

# S3/MinIO 配置
S3_CONFIG = {
    "aws_access_key_id": os.getenv("AWS_ACCESS_KEY_ID", "minioadmin"),
    "aws_secret_access_key": os.getenv("AWS_SECRET_ACCESS_KEY", "minioadmin"),
    "region": os.getenv("AWS_REGION", "us-east-1"),
    "endpoint_url": os.getenv("S3_ENDPOINT_URL", "http://localhost:9000"),
}

# LanceDB 特定配置
LANCEDB_CONFIG = {
    "uri": os.getenv("LANCEDB_URI", "s3://agent-memory/lancedb"),
    "storage_options": {
        "access_key_id": S3_CONFIG["aws_access_key_id"],
        "secret_access_key": S3_CONFIG["aws_secret_access_key"],
        "region": S3_CONFIG["region"],
        "endpoint": S3_CONFIG["endpoint_url"],
    }
}
```

---

## 5. Neo4j Schema（知识图谱）

### 5.1 图模型设计

```mermaid
graph LR
    A[Entity<br/>name, type, description] -->|RELATES_TO| B[Entity]
    A -->|MEMBER_OF| C[Community]
    C -->|SUMMARIZES| D[CommunitySummary<br/>存储在 PostgreSQL]
    A -->|OBSERVED_IN| E[Episode]
```

### 5.2 完整 Cypher Schema

```cypher
// init_neo4j.cypher
// Neo4j 知识图谱 Schema 初始化

// ============================================
// 1. 约束与索引
// ============================================

// 实体唯一性约束
CREATE CONSTRAINT entity_name_type IF NOT EXISTS
FOR (e:Entity) REQUIRE (e.name, e.type) IS UNIQUE;

// 概念唯一性约束
CREATE CONSTRAINT concept_name IF NOT EXISTS
FOR (c:Concept) REQUIRE c.name IS UNIQUE;

// 社区唯一性约束
CREATE CONSTRAINT community_id IF NOT EXISTS
FOR (c:Community) REQUIRE c.community_id IS UNIQUE;

// 索引
CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type);
CREATE INDEX entity_embedding_index IF NOT EXISTS FOR (e:Entity) ON (e.embedding);
CREATE INDEX relation_type_index IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON (r.relation_type);
CREATE INDEX episode_id_index IF NOT EXISTS FOR (ep:Episode) ON (ep.episode_id);

// ============================================
// 2. 实体创建函数
// ============================================

// 合并实体（存在则更新，不存在则创建）
CREATE OR REPLACE FUNCTION merge_entity(
    entity_name STRING,
    entity_type STRING,
    description STRING,
    embedding LIST<FLOAT>,
    source_episode_id STRING
) {
    MERGE (e:Entity {name: entity_name, type: entity_type})
    ON CREATE SET
        e.description = description,
        e.embedding = embedding,
        e.created_at = datetime(),
        e.updated_at = datetime(),
        e.mention_count = 1,
        e.source_episodes = [source_episode_id]
    ON MATCH SET
        e.description = coalesce(description, e.description),
        e.updated_at = datetime(),
        e.mention_count = e.mention_count + 1,
        e.source_episodes = CASE
            WHEN source_episode_id IN e.source_episodes THEN e.source_episodes
            ELSE e.source_episodes + source_episode_id
        END
    RETURN e
};

// ============================================
// 3. 关系创建函数
// ============================================

// 创建实体间关系
CREATE OR REPLACE FUNCTION create_relation(
    from_entity STRING,
    from_type STRING,
    to_entity STRING,
    to_type STRING,
    relation_type STRING,
    weight FLOAT,
    source_episode_id STRING
) {
    MATCH (from:Entity {name: from_entity, type: from_type})
    MATCH (to:Entity {name: to_entity, type: to_type})
    MERGE (from)-[r:RELATES_TO {relation_type: relation_type}]->(to)
    ON CREATE SET
        r.weight = weight,
        r.created_at = datetime(),
        r.updated_at = datetime(),
        r.evidence_count = 1,
        r.source_episodes = [source_episode_id]
    ON MATCH SET
        r.weight = (r.weight * r.evidence_count + weight) / (r.evidence_count + 1),
        r.updated_at = datetime(),
        r.evidence_count = r.evidence_count + 1,
        r.source_episodes = CASE
            WHEN source_episode_id IN r.source_episodes THEN r.source_episodes
            ELSE r.source_episodes + source_episode_id
        END
    RETURN r
};

// ============================================
// 4. 社区管理
// ============================================

// 创建社区
CREATE OR REPLACE FUNCTION create_community(
    community_id STRING,
    level INTEGER,
    parent_id STRING
) {
    CREATE (c:Community {
        community_id: community_id,
        level: level,
        created_at: datetime(),
        entity_count: 0,
        relation_count: 0
    })
    WITH c
    CALL {
        WITH c, parent_id
        WITH c, parent_id
        WHERE parent_id IS NOT NULL
        MATCH (parent:Community {community_id: parent_id})
        CREATE (c)-[:CHILD_OF]->(parent)
        RETURN count(*) AS _
    }
    RETURN c
};

// 将实体分配到社区
CREATE OR REPLACE FUNCTION assign_entity_to_community(
    entity_name STRING,
    entity_type STRING,
    community_id STRING
) {
    MATCH (e:Entity {name: entity_name, type: entity_type})
    MATCH (c:Community {community_id: community_id})
    MERGE (e)-[m:MEMBER_OF]->(c)
    ON CREATE SET m.assigned_at = datetime()
    WITH c
    SET c.entity_count = c.entity_count + 1
};

// ============================================
// 5. 向量化搜索
// ============================================

// 通过向量相似度搜索实体
CREATE OR REPLACE FUNCTION search_entities_by_vector(
    query_embedding LIST<FLOAT>,
    top_k INTEGER
) {
    CALL db.index.vector.queryNodes(
        'entity_embedding_index',
        top_k,
        query_embedding
    ) YIELD node, score
    RETURN node.name AS name,
           node.type AS type,
           node.description AS description,
           score
    ORDER BY score DESC
};

// ============================================
// 6. 图遍历查询
// ============================================

// 多跳邻居查询
CREATE OR REPLACE FUNCTION get_entity_neighbors(
    start_name STRING,
    start_type STRING,
    hops INTEGER,
    relation_types LIST<STRING>
) {
    MATCH path = (start:Entity {name: start_name, type: start_type})-[r:RELATES_TO*1..hops]-(neighbor)
    WHERE ALL(rel IN relationships(path) WHERE rel.relation_type IN relation_types)
    RETURN DISTINCT neighbor.name AS name,
           neighbor.type AS type,
           length(path) AS distance,
           [rel IN relationships(path) | rel.relation_type] AS relation_path
    ORDER BY distance, name
};

// 子图提取（用于 LLM 上下文）
CREATE OR REPLACE FUNCTION extract_subgraph(
    center_name STRING,
    center_type STRING,
    depth INTEGER
) {
    MATCH path = (center:Entity {name: center_name, type: center_type})-[r:RELATES_TO*1..depth]-(node)
    RETURN center, relationships(path), nodes(path)
};

// ============================================
// 7. 统计与维护
// ============================================

// 获取知识图谱统计
CREATE OR REPLACE FUNCTION get_kg_stats() {
    RETURN {
        entity_count: count{(e:Entity)},
        relation_count: count{()-[r:RELATES_TO]->()},
        community_count: count{(c:Community)},
        entity_types: collect(DISTINCT e.type),
        relation_types: collect(DISTINCT r.relation_type)
    }
};

// 清理孤立实体
CREATE OR REPLACE FUNCTION cleanup_orphaned_entities() {
    MATCH (e:Entity)
    WHERE NOT (e)-[:RELATES_TO]-() AND NOT (e)-[:MEMBER_OF]-()
    WITH e LIMIT 1000
    DELETE e
    RETURN count(e) AS deleted_count
};

// ============================================
// 8. 示例数据（可选）
// ============================================

// 创建示例实体和关系
CREATE (llm:Entity {name: "Large Language Model", type: "Technology", description: "AI model trained on vast text data"});
CREATE (gpt:Entity {name: "GPT-4", type: "Model", description: "OpenAI's large language model"});
CREATE (openai:Entity {name: "OpenAI", type: "Organization", description: "AI research company"});

CREATE (llm)-[:RELATES_TO {relation_type: "includes", weight: 1.0}]->(gpt);
CREATE (openai)-[:RELATES_TO {relation_type: "developed", weight: 1.0}]->(gpt);

// 完成
RETURN "Neo4j Schema 初始化完成" AS status;
```

### 5.3 Neo4j Python 客户端

```python
# neo4j_client.py
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from neo4j import AsyncGraphDatabase, AsyncDriver

NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "password"

@dataclass
class Entity:
    name: str
    type: str
    description: Optional[str] = None
    embedding: Optional[List[float]] = None

@dataclass
class Relation:
    from_entity: str
    from_type: str
    to_entity: str
    to_type: str
    relation_type: str
    weight: float = 1.0


class Neo4jKnowledgeGraph:
    """Neo4j 知识图谱客户端"""

    def __init__(self, uri: str = NEO4J_URI, user: str = NEO4J_USER, password: str = NEO4J_PASSWORD):
        self.uri = uri
        self.auth = (user, password)
        self.driver: Optional[AsyncDriver] = None

    async def connect(self):
        """建立连接"""
        self.driver = AsyncGraphDatabase.driver(self.uri, auth=self.auth)

    async def close(self):
        """关闭连接"""
        if self.driver:
            await self.driver.close()

    async def add_entities(self, entities: List[Entity], source_episode_id: str) -> int:
        """批量添加实体"""
        query = """
        UNWIND $entities AS entity
        MERGE (e:Entity {name: entity.name, type: entity.type})
        ON CREATE SET
            e.description = entity.description,
            e.embedding = entity.embedding,
            e.created_at = datetime(),
            e.updated_at = datetime(),
            e.mention_count = 1,
            e.source_episodes = [$source_episode_id]
        ON MATCH SET
            e.description = coalesce(entity.description, e.description),
            e.updated_at = datetime(),
            e.mention_count = e.mention_count + 1,
            e.source_episodes = CASE
                WHEN $source_episode_id IN e.source_episodes THEN e.source_episodes
                ELSE e.source_episodes + $source_episode_id
            END
        RETURN count(e) AS count
        """

        async with self.driver.session() as session:
            result = await session.run(
                query,
                entities=[e.__dict__ for e in entities],
                source_episode_id=source_episode_id
            )
            record = await result.single()
            return record["count"]

    async def add_relations(self, relations: List[Relation], source_episode_id: str) -> int:
        """批量添加关系"""
        query = """
        UNWIND $relations AS rel
        MATCH (from:Entity {name: rel.from_entity, type: rel.from_type})
        MATCH (to:Entity {name: rel.to_entity, type: rel.to_type})
        MERGE (from)-[r:RELATES_TO {relation_type: rel.relation_type}]->(to)
        ON CREATE SET
            r.weight = rel.weight,
            r.created_at = datetime(),
            r.updated_at = datetime(),
            r.evidence_count = 1,
            r.source_episodes = [$source_episode_id]
        ON MATCH SET
            r.weight = (r.weight * r.evidence_count + rel.weight) / (r.evidence_count + 1),
            r.updated_at = datetime(),
            r.evidence_count = r.evidence_count + 1
        RETURN count(r) AS count
        """

        async with self.driver.session() as session:
            result = await session.run(
                query,
                relations=[r.__dict__ for r in relations],
                source_episode_id=source_episode_id
            )
            record = await result.single()
            return record["count"]

    async def search_similar_entities(
        self,
        query_embedding: List[float],
        top_k: int = 10
    ) -> List[Dict[str, Any]]:
        """向量相似度搜索实体"""
        query = """
        CALL db.index.vector.queryNodes('entity_embedding_index', $top_k, $embedding)
        YIELD node, score
        RETURN node.name AS name,
               node.type AS type,
               node.description AS description,
               score
        ORDER BY score DESC
        """

        async with self.driver.session() as session:
            result = await session.run(query, embedding=query_embedding, top_k=top_k)
            records = await result.data()
            return records

    async def traverse_graph(
        self,
        start_entity: str,
        start_type: str,
        hops: int = 2,
        relation_types: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """图遍历查询"""
        rel_filter = ""
        if relation_types:
            rel_filter = f"AND ALL(rel IN relationships(path) WHERE rel.relation_type IN {relation_types})"

        query = f"""
        MATCH path = (start:Entity {{name: $start_name, type: $start_type}})
                     -[r:RELATES_TO*1..{hops}]-(neighbor)
        WHERE neighbor <> start {rel_filter}
        RETURN DISTINCT neighbor.name AS name,
               neighbor.type AS type,
               neighbor.description AS description,
               length(path) AS distance,
               [rel IN relationships(path) | rel.relation_type] AS relation_path
        ORDER BY distance, name
        LIMIT 50
        """

        async with self.driver.session() as session:
            result = await session.run(
                query,
                start_name=start_entity,
                start_type=start_type
            )
            return await result.data()


# 使用示例
async def demo():
    kg = Neo4jKnowledgeGraph()
    await kg.connect()

    # 添加实体
    entities = [
        Entity(name="Python", type="Programming Language", description="..."),
        Entity(name="FastAPI", type="Framework", description="..."),
    ]
    await kg.add_entities(entities, "episode_001")

    await kg.close()
```

---

## 6. ClickHouse Schema（Telemetry）

### 6.1 时序数据设计

```sql
-- init_clickhouse.sql
-- ClickHouse Schema 初始化脚本

-- ============================================
-- 1. Agent Evidence 原始表
-- ============================================
CREATE TABLE IF NOT EXISTS agent_evidence (
    -- 标识
    evidence_id UUID,
    trace_id UUID,
    span_id UUID,
    parent_span_id UUID,

    -- 归属
    agent_id LowCardinality(String),
    session_id LowCardinality(String),
    episode_id UUID,

    -- 证据类型
    evidence_type LowCardinality(String),  -- LLM_CALL, TOOL_CALL, MEMORY_OP, REFLECTION, ERROR

    -- Payload（JSON 格式，根据类型变化）
    payload String CODEC(ZSTD(1)),

    -- 时间戳
    event_time DateTime64(3),        -- 事件发生时间
    ingestion_time DateTime64(3),    -- 摄入时间
    duration_ms UInt32,              -- 持续时间

    -- 资源使用
    prompt_tokens UInt32,
    completion_tokens UInt32,
    total_tokens UInt32,
    cost_usd Float64,

    -- 状态
    success UInt8,                   -- 0/1
    error_type LowCardinality(String),
    error_message String CODEC(ZSTD(1)),

    -- 上下文
    context_hash UInt64,

    -- 元数据
    metadata String CODEC(ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (agent_id, evidence_type, event_time)
TTL event_time + INTERVAL 90 DAY  -- 90 天后自动删除
SETTINGS index_granularity = 8192;

-- ============================================
-- 2. LLM Calls 物化视图
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_llm_calls
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (agent_id, model, event_time)
AS SELECT
    evidence_id,
    trace_id,
    agent_id,
    session_id,
    event_time,
    duration_ms,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    cost_usd,
    success,
    -- 从 payload 提取模型名称
    JSONExtractString(payload, 'model') AS model,
    JSONExtractString(payload, 'prompt_preview') AS prompt_preview
FROM agent_evidence
WHERE evidence_type = 'LLM_CALL';

-- ============================================
-- 3. Tool Calls 物化视图
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_tool_calls
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (agent_id, tool_name, event_time)
AS SELECT
    evidence_id,
    trace_id,
    agent_id,
    session_id,
    event_time,
    duration_ms,
    success,
    JSONExtractString(payload, 'tool_name') AS tool_name,
    JSONExtractString(payload, 'input_preview') AS input_preview
FROM agent_evidence
WHERE evidence_type = 'TOOL_CALL';

-- ============================================
-- 4. Memory Operations 物化视图
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_memory_ops
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (agent_id, memory_type, operation, event_time)
AS SELECT
    evidence_id,
    trace_id,
    agent_id,
    session_id,
    event_time,
    duration_ms,
    success,
    JSONExtractString(payload, 'memory_type') AS memory_type,
    JSONExtractString(payload, 'operation') AS operation,  -- read/write/delete
    JSONExtractString(payload, 'memory_id') AS memory_id
FROM agent_evidence
WHERE evidence_type = 'MEMORY_OP';

-- ============================================
-- 5. Agent 每日统计聚合表
-- ============================================
CREATE TABLE IF NOT EXISTS agent_daily_stats (
    agent_id LowCardinality(String),
    date Date,

    -- LLM 统计
    llm_calls UInt32,
    llm_tokens_total UInt64,
    llm_cost_total Float64,
    llm_avg_latency_ms Float64,
    llm_p99_latency_ms Float64,

    -- Tool 统计
    tool_calls UInt32,
    tool_success_rate Float64,
    tool_avg_latency_ms Float64,

    -- Memory 统计
    memory_reads UInt32,
    memory_writes UInt32,
    memory_avg_read_latency_ms Float64,

    -- Session 统计
    sessions_started UInt32,
    sessions_ended UInt32,
    avg_session_duration_sec Float64,

    -- Error 统计
    errors_total UInt32,
    error_rate Float64
) ENGINE = SummingMergeTree()
ORDER BY (agent_id, date);

-- 聚合物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agent_daily_stats
TO agent_daily_stats
AS SELECT
    agent_id,
    toDate(event_time) AS date,

    -- LLM
    countIf(evidence_type = 'LLM_CALL') AS llm_calls,
    sumIf(total_tokens, evidence_type = 'LLM_CALL') AS llm_tokens_total,
    sumIf(cost_usd, evidence_type = 'LLM_CALL') AS llm_cost_total,
    avgIf(duration_ms, evidence_type = 'LLM_CALL') AS llm_avg_latency_ms,
    quantileIf(0.99)(duration_ms, evidence_type = 'LLM_CALL') AS llm_p99_latency_ms,

    -- Tool
    countIf(evidence_type = 'TOOL_CALL') AS tool_calls,
    avgIf(success, evidence_type = 'TOOL_CALL') AS tool_success_rate,
    avgIf(duration_ms, evidence_type = 'TOOL_CALL') AS tool_avg_latency_ms,

    -- Memory
    countIf(evidence_type = 'MEMORY_OP' AND JSONExtractString(payload, 'operation') = 'read') AS memory_reads,
    countIf(evidence_type = 'MEMORY_OP' AND JSONExtractString(payload, 'operation') = 'write') AS memory_writes,

    -- Error
    countIf(evidence_type = 'ERROR') AS errors_total
FROM agent_evidence
GROUP BY agent_id, date;

-- ============================================
-- 6. 常用查询示例
-- ============================================

-- 查询 Agent 最近 1 小时的 LLM 调用
-- SELECT * FROM agent_evidence
-- WHERE agent_id = 'agent_001'
--   AND evidence_type = 'LLM_CALL'
--   AND event_time > now() - INTERVAL 1 HOUR
-- ORDER BY event_time DESC;

-- 查询错误率最高的 Agents（最近 24 小时）
-- SELECT
--     agent_id,
--     count() AS total,
--     sum(success = 0) AS errors,
--     errors / total AS error_rate
-- FROM agent_evidence
-- WHERE event_time > now() - INTERVAL 24 HOUR
-- GROUP BY agent_id
-- ORDER BY error_rate DESC;

-- 查询 P99 延迟趋势（按小时）
-- SELECT
--     toStartOfHour(event_time) AS hour,
--     quantile(0.99)(duration_ms) AS p99_latency
-- FROM agent_evidence
-- WHERE evidence_type = 'LLM_CALL'
-- GROUP BY hour
-- ORDER BY hour;

SELECT 'ClickHouse Schema 初始化完成' AS status;
```

### 6.2 ClickHouse Python 客户端

```python
# clickhouse_client.py
from typing import List, Dict, Any
from datetime import datetime
import clickhouse_connect
from clickhouse_connect.driver.asyncclient import AsyncClient

CLICKHOUSE_URL = "http://localhost:8123"
CLICKHOUSE_DB = "agent_memory"

class ClickHouseTelemetry:
    """ClickHouse 遥测数据客户端"""

    def __init__(self, url: str = CLICKHOUSE_URL, database: str = CLICKHOUSE_DB):
        self.url = url
        self.database = database
        self.client: AsyncClient | None = None

    async def connect(self):
        """建立连接"""
        self.client = await clickhouse_connect.get_async_client(
            host=self.url.replace("http://", "").replace(":8123", ""),
            port=8123,
            database=self.database
        )

    async def insert_evidence(self, evidence: Dict[str, Any]):
        """插入单条证据"""
        await self.client.insert(
            "agent_evidence",
            [evidence],
            database=self.database
        )

    async def insert_evidence_batch(self, evidences: List[Dict[str, Any]]):
        """批量插入证据"""
        if not evidences:
            return
        await self.client.insert(
            "agent_evidence",
            evidences,
            database=self.database
        )

    async def query_agent_stats(
        self,
        agent_id: str,
        start_time: datetime,
        end_time: datetime
    ) -> Dict[str, Any]:
        """查询 Agent 统计"""
        query = """
        SELECT
            count() AS total_calls,
            sum(success) AS success_calls,
            avg(duration_ms) AS avg_latency,
            quantile(0.99)(duration_ms) AS p99_latency,
            sum(total_tokens) AS total_tokens,
            sum(cost_usd) AS total_cost
        FROM agent_evidence
        WHERE agent_id = %(agent_id)s
          AND event_time >= %(start)s
          AND event_time <= %(end)s
        """

        result = await self.client.query(
            query,
            parameters={
                "agent_id": agent_id,
                "start": start_time,
                "end": end_time
            }
        )

        return result.first_row_as_dict() if result.result_rows else {}
```

---

## 7. 数据库初始化脚本汇总

### 7.1 一体化初始化脚本

```bash
#!/bin/bash
# init_all_databases.sh
# 一键初始化所有数据库

set -e

echo "========================================"
echo "Agentic Memory - 数据库初始化"
echo "========================================"

# 配置
REDIS_HOST=${REDIS_HOST:-"localhost"}
POSTGRES_URL=${POSTGRES_URL:-"postgresql://user:password@localhost:5432/agent_memory"}
NEO4J_URI=${NEO4J_URI:-"bolt://localhost:7687"}
CLICKHOUSE_URL=${CLICKHOUSE_URL:-"http://localhost:8123"}
LANCEDB_URI=${LANCEDB_URI:-"./data/lancedb"}

echo ""
echo "1. 初始化 Redis..."
chmod +x scripts/init_redis.sh
./scripts/init_redis.sh

echo ""
echo "2. 初始化 PostgreSQL..."
psql $POSTGRES_URL -f scripts/init_postgres.sql

echo ""
echo "3. 初始化 Neo4j..."
cypher-shell -a $NEO4J_URI -u neo4j -p password -f scripts/init_neo4j.cypher

echo ""
echo "4. 初始化 ClickHouse..."
curl -s $CLICKHOUSE_URL -d "$(cat scripts/init_clickhouse.sql)"

echo ""
echo "5. 初始化 LanceDB..."
python scripts/init_lancedb.py --uri "$LANCEDB_URI"

echo ""
echo "========================================"
echo "✓ 所有数据库初始化完成"
echo "========================================"
```

### 7.2 Makefile 命令

```makefile
# Makefile
# 数据库管理命令

.PHONY: init init-redis init-postgres init-neo4j init-clickhouse init-lancedb clean

# 一键初始化所有
init:
	@echo "初始化所有数据库..."
	@bash scripts/init_all_databases.sh

# 单独初始化
init-redis:
	@bash scripts/init_redis.sh

init-postgres:
	@psql $(POSTGRES_URL) -f scripts/init_postgres.sql

init-neo4j:
	@cypher-shell -a $(NEO4J_URI) -u neo4j -p $(NEO4J_PASSWORD) -f scripts/init_neo4j.cypher

init-clickhouse:
	@curl -s $(CLICKHOUSE_URL) -d "$$(cat scripts/init_clickhouse.sql)"

init-lancedb:
	@python scripts/init_lancedb.py

# 清理数据（危险！）
clean:
	@echo "⚠️  警告：这将删除所有数据！"
	@read -p "输入 'YES' 确认: " confirm && [ "$$confirm" = "YES" ] || exit 1
	@echo "清理中..."
	# Redis
	@redis-cli FLUSHDB
	# PostgreSQL
	@psql $(POSTGRES_URL) -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
	# Neo4j
	@cypher-shell -a $(NEO4J_URI) "MATCH (n) DETACH DELETE n"
	# ClickHouse
	@curl -s $(CLICKHOUSE_URL) -d "DROP TABLE IF EXISTS agent_evidence"
	@echo "✓ 清理完成"

# 验证连接
verify:
	@echo "验证数据库连接..."
	@redis-cli PING | grep -q "PONG" && echo "✓ Redis" || echo "✗ Redis"
	@psql $(POSTGRES_URL) -c "SELECT 1" > /dev/null 2>&1 && echo "✓ PostgreSQL" || echo "✗ PostgreSQL"
	@cypher-shell -a $(NEO4J_URI) "RETURN 1" > /dev/null 2>&1 && echo "✓ Neo4j" || echo "✗ Neo4j"
	@curl -s $(CLICKHOUSE_URL) | grep -q "Ok" && echo "✓ ClickHouse" || echo "✗ ClickHouse"
```

---

## 8. 数据生命周期管理

### 8.1 分层存储策略

| 数据类型 | 热存储 | 温存储 | 冷存储 | 生命周期 |
|---------|-------|-------|-------|---------|
| Working Memory | Redis (24h) | - | - | TTL 自动过期 |
| Episode (< 30d) | LanceDB | S3 Standard | - | 自动分层 |
| Episode (> 90d) | - | S3 IA | S3 Glacier | 定期归档 |
| Telemetry | ClickHouse (90d) | S3 Parquet | - | TTL + 导出 |
| Skills | PostgreSQL | - | - | 永久保留 |

### 8.2 数据清理策略

```python
# data_lifecycle.py
"""数据生命周期管理"""

from datetime import datetime, timedelta

class DataLifecycleManager:
    """数据生命周期管理器"""

    async def archive_old_episodes(self, days: int = 90, min_importance: float = 5.0):
        """归档旧 Episode"""
        # 软删除：标记 is_archived = True
        # 物理归档：导出到 S3 Glacier
        pass

    async def cleanup_telemetry(self, days: int = 90):
        """清理过期遥测数据"""
        # ClickHouse TTL 自动处理
        # 可选：导出到 S3 后再删除
        pass

    async def compact_lancedb(self):
        """压缩 LanceDB（合并小文件）"""
        # 调用 LanceDB optimize 命令
        pass
```

---

## 9. 数据模型关系图

```mermaid
erDiagram
    EPISODE ||--o{ CONTENT_BLOCK : contains
    EPISODE ||--o{ REFLECTION : generates
    EPISODE }|--|| AGENT : belongs_to

    SKILL ||--o{ SKILL_EXECUTION : has
    SKILL ||--o{ SKILL_VERSION : has_versions
    SKILL }o--o{ SKILL : relates_to
    SKILL }|--|| AGENT : owned_by

    ENTITY ||--o{ RELATION : connects
    ENTITY }o--o{ COMMUNITY : member_of
    COMMUNITY ||--|| COMMUNITY_SUMMARY : has_summary

    AGENT ||--o{ AGENT_EVIDENCE : generates
    AGENT ||--o{ SESSION : has
    SESSION ||--|| WORKING_MEMORY : has
```

---

## 10. 总结

本文档定义了 Agentic Memory 系统的完整存储层 Schema，包括：

1. **Redis**：Working Memory 超高速读写
2. **PostgreSQL + pgvector**：Skill、Community、元数据的强一致性存储
3. **LanceDB**：Episode Memory 的大规模向量检索
4. **Neo4j**：Knowledge Graph 的图遍历
5. **ClickHouse**：Telemetry 的时序分析

所有 Schema 均提供：
- 完整的 DDL/DML 语句
- Python 客户端代码
- 初始化脚本
- 运维管理命令
