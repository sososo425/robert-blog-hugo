
---

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v3.0（融合版）
> **日期**: 2026-03-25
> **状态**: Draft
> **核心地位**: 本服务是整个 Agent Memory Infrastructure 的**中枢神经**，所有记忆的读写、检索、整合、生命周期管理均通过 AMS 统一调度。

---

## 1. 模块定位与职责边界

### 1.1 定位

AMS 是整个 Agent Memory Infrastructure 的**唯一入口服务（Gateway Service）**，对上承接 Agent Framework 的 memory I/O 请求，对下协调 Working Memory（Redis）、Long-term Memory（Neo4j / Milvus / Elasticsearch）、Pipeline Workers（Kafka consumers）等底层组件。

这一"单一入口"的设计参考了 Mem0 的 Memory Layer 架构理念——将记忆能力抽象为一个独立的、可插拔的中间层，使 Agent 框架无需关心底层存储细节 [5]。同时借鉴了 Letta 的有状态 Agent 服务端架构，将记忆管理从客户端上移到服务端，实现跨会话、跨 Agent 的统一记忆治理 [2]。

### 1.2 职责边界（RACI 矩阵）

| **职责** | **AMS** | **Pipeline Workers** | **Storage Engines** | **Agent-TES** | **Skill-MDS** |
|---|:---:|:---:|:---:|:---:|:---:|
| 接收 Agent 的 memory I/O 请求 | **R** | — | — | — | — |
| Working Memory 读写 | **R** | — | A | — | — |
| Long-term Memory 检索 | **R** | — | A | — | — |
| 记忆构建（Tree/Graph Construction） | C | **R** | A | — | — |
| 遥测数据采集 | — | — | — | **R** | — |
| 遥测数据注入记忆 | C | **R** | A | C | — |
| 技能挖掘与管理 | C | — | — | — | **R** |
| 记忆生命周期管理（TTL/遗忘/提升） | **R** | A | A | — | — |
| 记忆质量评估与反馈 | **R** | C | — | — | C |

> R = Responsible（执行）, A = Accountable（支撑）, C = Consulted（咨询）

### 1.3 不做什么（Explicit Non-Goals）

| **排除项** | **归属模块** |
|---|---|
| 遥测数据的采集和预处理 | Agent-TES（06） |
| Tree/Graph 的实际构建计算 | Memory Processing Pipeline（03） |
| 向量/图/全文索引的底层引擎管理 | Storage and Retrieval（04） |
| 技能的挖掘、测试、编码 | Skill-MDS（05） |
| Agent 的执行编排和任务调度 | Agent Framework（02） |

---

## 2. 系统架构

### 2.1 AMS 内部架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AMS (Agent Memory System)                        │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      API Gateway Layer                           │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │   │
│  │  │ REST API │  │ gRPC API │  │ WebSocket│  │ SDK Adapters  │   │   │
│  │  │ (HTTP/2) │  │ (Proto3) │  │ (Stream) │  │ (LC/CW/AG)   │   │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬────────┘   │   │
│  └───────┼──────────────┼──────────────┼───────────────┼────────────┘   │
│          └──────────────┼──────────────┼───────────────┘                │
│                         ▼              ▼                                 │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Core Service Layer                             │   │
│  │                                                                  │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐   │   │
│  │  │ Session Manager │  │ Memory Router   │  │ Lifecycle Mgr  │   │   │
│  │  │ (WM 会话管理)    │  │ (读写路由分发)   │  │ (生命周期管理)  │   │   │
│  │  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘   │   │
│  │           │                    │                    │            │   │
│  │  ┌────────▼────────┐  ┌───────▼─────────┐  ┌──────▼─────────┐  │   │
│  │  │ Context Builder │  │ Retrieval Engine│  │ Promotion      │  │   │
│  │  │ (上下文组装器)    │  │ (检索引擎)      │  │ Evaluator      │  │   │
│  │  │                 │  │                 │  │ (提升评估器)    │  │   │
│  │  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘  │   │
│  │           │                    │                    │            │   │
│  │  ┌────────▼────────┐  ┌───────▼─────────┐  ┌──────▼─────────┐  │   │
│  │  │ Memory Scorer   │  │ Fusion Engine   │  │ Decay Engine   │  │   │
│  │  │ (记忆评分器)     │  │ (融合引擎)      │  │ (衰减引擎)     │  │   │
│  │  └─────────────────┘  └─────────────────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Integration Layer                              │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │   │
│  │  │ Redis    │  │ Neo4j    │  │ Milvus   │  │ Elasticsearch  │  │   │
│  │  │ Client   │  │ Client   │  │ Client   │  │ Client         │  │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────────────┐  │   │
│  │  │ Kafka    │  │ PG Client│  │ LLM Client (Embedding/Chat) │  │   │
│  │  │ Producer │  │          │  │                              │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心子模块说明

| **子模块** | **职责** | **关键依赖** |
|---|---|---|
| **Session Manager** | 管理 Working Memory 的会话生命周期：创建、读写、过期、归档 | Redis Client |
| **Memory Router** | 根据请求类型和数据源映射规则，将读写请求路由到正确的存储引擎和管道 | 映射规则引擎 |
| **Lifecycle Manager** | 管理记忆的完整生命周期：创建→活跃→衰减→归档→删除 | Decay Engine, Kafka Producer |
| **Context Builder** | 为 Agent 组装结构化上下文：从多个记忆源拉取数据并拼装为 LLM 可消费的格式 | 所有 Storage Clients |
| **Retrieval Engine** | 多路召回协调器：并行调度 BM25/Vector/Tree/Graph 四路检索 | Milvus, ES, Neo4j Clients |
| **Promotion Evaluator** | 评估 Working Memory 中的会话数据是否值得提升到 Long-term Memory | LLM Client, Kafka Producer |
| **Memory Scorer** | 为检索结果和记忆条目计算综合评分（相关性 × 新鲜度 × 重要性） | — |
| **Fusion Engine** | 多路召回结果的融合：RRF（轻量模式）或 LLM-based（Agentic 模式） | LLM Client |
| **Decay Engine** | 执行时间衰减计算，定期更新记忆权重，标记过期记忆 | PG Client, Redis Client |

### 2.3 上下游交互全景

```
                    ┌─────────────────┐
                    │  Agent Framework │
                    │  (LangChain /   │
                    │   CrewAI / 自研)  │
                    └────────┬────────┘
                             │ REST / gRPC / WebSocket
                             ▼
┌────────────┐      ┌───────────────┐      ┌─────────────────┐
│ Agent-TES  │─────→│      AMS      │─────→│  Skill-MDS      │
│ (遥测数据)  │ Kafka│  (核心服务)    │ gRPC │  (技能查询)      │
└────────────┘      └───────┬───────┘      └─────────────────┘
                            │
              ┌─────────────┼─────────────────┐
              │             │                 │
              ▼             ▼                 ▼
     ┌──────────────┐ ┌──────────┐  ┌──────────────────┐
     │ Redis Cluster│ │ Kafka    │  │ Storage Engines   │
     │ (Working Mem)│ │ (Pipeline│  │ Neo4j / Milvus /  │
     │              │ │  Buffer) │  │ ES / PG / LanceDB │
     └──────────────┘ └────┬─────┘  └──────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Pipeline    │
                    │  Workers     │
                    │  (构建管道)   │
                    └──────────────┘
```

**交互协议矩阵**：

| **上游/下游** | **协议** | **方向** | **数据格式** | **说明** |
|---|---|---|---|---|
| Agent Framework → AMS | REST (HTTP/2) / gRPC | 同步 | JSON / Protobuf | 主要交互通道 |
| Agent Framework ↔ AMS | WebSocket | 双向流 | JSON | 实时上下文推送（可选） |
| Agent-TES → AMS | Kafka | 异步 | Avro / JSON | Topic: `ams.trace.ingested` |
| AMS → Pipeline Workers | Kafka | 异步 | Avro / JSON | Topic: `ams.pipeline.{stage}` |
| AMS → Skill-MDS | gRPC | 同步 | Protobuf | 技能检索查询 |
| AMS → Redis | Redis Protocol | 同步 | RESP3 | Working Memory 读写 |
| AMS → Neo4j | Bolt Protocol | 同步 | Cypher | Graph 查询 |
| AMS → Milvus | gRPC | 同步 | Protobuf | 向量检索 |
| AMS → Elasticsearch | REST (HTTP) | 同步 | JSON | 全文检索 |
| AMS → PostgreSQL | TCP (pgwire) | 同步 | SQL | 元数据、配置、审计 |
| AMS → LLM Service | REST / gRPC | 同步 | JSON / Protobuf | Embedding 生成、Query Expansion、Reranking |

---

## 3. 数据模型与 Schema 设计

### 3.1 核心领域模型

```
┌─────────────────────────────────────────────────────────────────┐
│                       AMS Domain Model                          │
│                                                                 │
│  ┌──────────┐ 1    * ┌──────────┐ 1    * ┌──────────────────┐  │
│  │  Tenant  │───────→│  Agent   │───────→│    Session        │  │
│  │          │        │          │        │  (Working Memory) │  │
│  └──────────┘        └────┬─────┘        └────────┬─────────┘  │
│                           │ 1                     │ *           │
│                           │                       ▼             │
│                           │              ┌────────────────┐     │
│                           │              │   Message      │     │
│                           │              │   (对话轮次)    │     │
│                           │              └────────────────┘     │
│                           │ *                                   │
│                           ▼                                     │
│                    ┌──────────────┐                              │
│                    │MemoryRecord  │←─── 长期记忆的统一抽象       │
│                    │(记忆记录)     │                              │
│                    └──────┬───────┘                              │
│                           │                                     │
│              ┌────────────┼────────────┐                        │
│              ▼            ▼            ▼                        │
│     ┌──────────────┐ ┌──────────┐ ┌────────────────┐           │
│     │ SemanticRecord│ │Procedural│ │MetacogRecord   │           │
│     │ (语义记忆)     │ │Record    │ │(元认知记忆)     │           │
│     │               │ │(程序记忆) │ │                │           │
│     └──────────────┘ └──────────┘ └────────────────┘           │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Block       │  │  Section     │  │  PhraseNode          │  │
│  │  (内容块)     │  │  (章节)      │  │  (短语节点)           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │  Edge        │  │  Community   │                             │
│  │  (图边)       │  │  (社区节点)  │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 PostgreSQL Schema（元数据层）

#### 3.2.1 租户与 Agent

```sql
-- 租户表：多租户隔离的顶层实体
CREATE TABLE tenants (
    tenant_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    plan            VARCHAR(50) NOT NULL DEFAULT 'free',  -- free / pro / enterprise
    config          JSONB NOT NULL DEFAULT '{}',           -- 租户级配置覆盖
    quota_memory_mb BIGINT NOT NULL DEFAULT 1024,          -- 记忆存储配额 (MB)
    quota_qps       INT NOT NULL DEFAULT 100,              -- 查询 QPS 配额
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active / suspended / deleted
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_status ON tenants(status);

-- Agent 表：每个 Agent 是记忆的主要拥有者
CREATE TABLE agents (
    agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    agent_type      VARCHAR(50) NOT NULL DEFAULT 'general',  -- general / specialist / orchestrator
    memory_config   JSONB NOT NULL DEFAULT '{
        "working_memory": {
            "max_turns": 50,
            "session_ttl_seconds": 7200,
            "idle_timeout_seconds": 1800
        },
        "long_term_memory": {
            "enabled": true,
            "tree_enabled": true,
            "graph_enabled": true,
            "decay_lambda": 0.001,
            "promotion_threshold": 0.6
        },
        "retrieval": {
            "default_mode": "lightweight",
            "max_results": 20,
            "reranking_enabled": true
        }
    }',
    metadata        JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_tenant ON agents(tenant_id);
CREATE INDEX idx_agents_status ON agents(status);
```

#### 3.2.2 记忆记录（Long-term Memory 的统一元数据）

```sql
-- 记忆记录表：所有长期记忆条目的统一元数据注册
CREATE TABLE memory_records (
    memory_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(agent_id),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),

    -- 记忆分类
    memory_type     VARCHAR(30) NOT NULL,  -- 'semantic' / 'procedural' / 'metacognitive'
    memory_subtype  VARCHAR(30),           -- semantic: 'fact' / 'episode'; procedural: 'workflow' / 'skill' / 'pattern'
    
    -- 数据源溯源
    source_type     VARCHAR(30) NOT NULL,  -- 'user_interaction' / 'agent_trace' / 'work_document' / 'source_code' / 'skill_markdown'
    source_id       VARCHAR(255),          -- 原始数据源 ID（如 session_id, trace_id, document_id）
    
    -- 结构标记
    structures      VARCHAR(30)[] NOT NULL, -- ARRAY['tree'] / ARRAY['graph'] / ARRAY['tree','graph']
    
    -- 内容摘要（用于快速预览，不替代实际存储）
    title           VARCHAR(500),
    summary         TEXT,
    
    -- 生命周期管理
    importance      FLOAT NOT NULL DEFAULT 0.5,   -- [0.0, 1.0] 重要性评分
    access_count    INT NOT NULL DEFAULT 0,        -- 被检索/访问的次数
    last_accessed   TIMESTAMPTZ,                   -- 最后一次被访问的时间
    decay_weight    FLOAT NOT NULL DEFAULT 1.0,    -- 当前衰减权重 w(t)
    expires_at      TIMESTAMPTZ,                   -- 硬过期时间（Temporal Invalidation）
    
    -- 状态
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active / decayed / archived / deleted
    
    -- 审计
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      VARCHAR(100),  -- 'system:pipeline' / 'user:xxx' / 'agent:xxx'
    
    -- 约束
    CONSTRAINT chk_memory_type CHECK (memory_type IN ('semantic', 'procedural', 'metacognitive')),
    CONSTRAINT chk_source_type CHECK (source_type IN ('user_interaction', 'agent_trace', 'work_document', 'source_code', 'skill_markdown')),
    CONSTRAINT chk_importance CHECK (importance >= 0.0 AND importance <= 1.0),
    CONSTRAINT chk_decay_weight CHECK (decay_weight >= 0.0 AND decay_weight <= 1.0)
);

-- 高频查询索引
CREATE INDEX idx_mr_agent_type ON memory_records(agent_id, memory_type);
CREATE INDEX idx_mr_agent_status ON memory_records(agent_id, status);
CREATE INDEX idx_mr_source ON memory_records(source_type, source_id);
CREATE INDEX idx_mr_decay ON memory_records(status, decay_weight) WHERE status = 'active';
CREATE INDEX idx_mr_expires ON memory_records(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_mr_tenant ON memory_records(tenant_id);

-- 分区策略（按 tenant_id hash 分区，支持多租户隔离）
-- 在大规模部署时启用：
-- CREATE TABLE memory_records (...) PARTITION BY HASH (tenant_id);
```

#### 3.2.3 数据源映射规则（运行时校验表）

```sql
-- 数据源映射规则表：管道验证时强制执行
CREATE TABLE source_mapping_rules (
    rule_id         SERIAL PRIMARY KEY,
    source_type     VARCHAR(30) NOT NULL UNIQUE,
    target_memories VARCHAR(30)[] NOT NULL,       -- 允许的目标记忆类型
    allowed_structures VARCHAR(30)[] NOT NULL,    -- 允许的结构类型
    rationale       TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 初始化规则数据
INSERT INTO source_mapping_rules (source_type, target_memories, allowed_structures, rationale) VALUES
('user_interaction',  ARRAY['procedural','semantic'], ARRAY['graph'],        'Preserves relational patterns and conversational flow as navigable graph paths'),
('agent_trace',       ARRAY['procedural','semantic'], ARRAY['graph'],        'Models execution trajectories and tool chains as temporal graph paths'),
('work_document',     ARRAY['procedural','semantic'], ARRAY['tree','graph'], 'Requires hierarchical abstraction AND entity-relationship graphs'),
('source_code',       ARRAY['procedural','semantic'], ARRAY['tree','graph'], 'Call Graph and Dependency Tree for code'),
('skill_markdown',    ARRAY['procedural'],            ARRAY['tree'],         'Leverages native Markdown heading hierarchy; max depth 4');
```

#### 3.2.4 会话元数据（Working Memory 的 PG 侧注册）

```sql
-- 会话注册表：Working Memory 会话的元数据（实际数据在 Redis）
CREATE TABLE sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(agent_id),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    user_id         VARCHAR(255),                    -- 关联的用户标识
    
    -- 会话状态
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active / idle / closed / promoted
    turn_count      INT NOT NULL DEFAULT 0,
    total_tokens    BIGINT NOT NULL DEFAULT 0,
    
    -- 提升状态
    promotion_score FLOAT,                           -- 提升评估分数
    promoted_at     TIMESTAMPTZ,                     -- 提升到长期记忆的时间
    promoted_memories UUID[],                        -- 提升产生的 memory_record IDs
    
    -- 时间戳
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    
    -- 元数据
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_sessions_agent ON sessions(agent_id, status);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_sessions_active ON sessions(status, last_active_at) WHERE status = 'active';
```

#### 3.2.5 审计日志

```sql
-- 审计日志表：记录所有关键操作
CREATE TABLE audit_logs (
    log_id          BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    agent_id        UUID,
    session_id      UUID,
    memory_id       UUID,
    
    action          VARCHAR(50) NOT NULL,  -- 'memory.create' / 'memory.retrieve' / 'memory.delete' / 'session.create' / 'session.promote' / ...
    actor           VARCHAR(100) NOT NULL, -- 'system:pipeline' / 'user:xxx' / 'agent:xxx' / 'api:xxx'
    details         JSONB,                 -- 操作详情
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 按时间分区（月度）
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
```

### 3.3 Redis Schema（Working Memory）

```
# ═══════════════════════════════════════════════════════════
# Working Memory — Redis Key 设计
# 所有 Key 以 tenant_id 前缀实现多租户隔离
# ═══════════════════════════════════════════════════════════

# ─── 会话状态 ───
# Type: Hash
# TTL: 7200s (从 last_active_at 计算)
Key: wm:{tenant_id}:{session_id}:state
Fields:
  agent_id        : string    # Agent UUID
  user_id         : string    # 用户标识（可选）
  status          : string    # "active" | "idle" | "closing"
  turn_count      : int       # 当前对话轮次数
  total_tokens    : int       # 累计 Token 消耗
  created_at      : int64     # Unix timestamp (ms)
  last_active_at  : int64     # Unix timestamp (ms)
  context_window  : int       # 当前上下文窗口 Token 数
  truncation_cursor: int      # 截断游标位置

# ─── 对话历史 ───
# Type: List (capped)
# 每个元素是 JSON 序列化的 Message 对象
# LTRIM 保留最近 max_turns 轮（默认 50）
Key: wm:{tenant_id}:{session_id}:messages
Element Schema (JSON):
{
  "message_id": "uuid",
  "role": "user" | "assistant" | "system" | "tool",
  "content": "string",
  "tool_calls": [                          // 仅 role=assistant 时
    {
      "tool_call_id": "string",
      "tool_name": "string",
      "arguments": {},
      "result": "string",                  // 工具返回结果
      "status": "success" | "error",
      "latency_ms": 123
    }
  ],
  "metadata": {
    "token_count": 150,
    "model": "gpt-4o",
    "timestamp": 1711360000000,
    "confidence": 0.92                     // Agent 决策置信度
  }
}

# ─── 任务状态 ───
# Type: Hash
# 用于多步骤任务的进度追踪
Key: wm:{tenant_id}:{session_id}:task
Fields:
  task_id         : string    # 当前任务 UUID
  task_type       : string    # "research" | "coding" | "analysis" | ...
  step_index      : int       # 当前步骤索引
  total_steps     : int       # 预估总步骤数
  tool_chain      : string    # JSON: 已执行的工具链 ["search","read","write"]
  partial_results : string    # JSON: 中间结果
  status          : string    # "running" | "paused" | "completed" | "failed"
  started_at      : int64
  updated_at      : int64

# ─── 工具调用流 ───
# Type: Stream
# XADD + MAXLEN ~200 限制增长
Key: wm:{tenant_id}:{session_id}:tools
Entry Schema:
  tool_name       : string
  tool_call_id    : string
  arguments       : string    # JSON
  result          : string    # JSON
  status          : string    # "success" | "error" | "timeout"
  latency_ms      : int
  timestamp       : int64

# ─── 活跃记忆引用 ───
# Type: Sorted Set
# Score = relevance_score, Member = memory_id
# 存储当前会话中从长期记忆检索并注入上下文的记忆引用
Key: wm:{tenant_id}:{session_id}:memory_refs
Member: memory_id (UUID string)
Score:  relevance_score (float, 0.0~1.0)

# ─── Agent 反思 ───
# Type: List (capped, LTRIM ~20)
# Agent 在执行过程中产生的自我反思/元认知记录
Key: wm:{tenant_id}:{session_id}:reflections
Element Schema (JSON):
{
  "reflection_id": "uuid",
  "type": "self_assessment" | "knowledge_gap" | "strategy_adjustment" | "confidence_calibration",
  "content": "string",
  "trigger": "string",           // 触发反思的事件描述
  "timestamp": 1711360000000
}
```

**TTL 管理 Lua 脚本**：

```lua
-- touch_session.lua
-- 原子性更新 last_active_at 并重置所有相关 Key 的 TTL
-- KEYS[1] = wm:{tenant_id}:{session_id}:state
-- ARGV[1] = current_timestamp_ms
-- ARGV[2] = ttl_seconds (default 7200)

local state_key = KEYS[1]
local prefix = string.sub(state_key, 1, -7)  -- 去掉 ":state"
local ts = ARGV[1]
local ttl = tonumber(ARGV[2])

-- 更新 last_active_at
redis.call('HSET', state_key, 'last_active_at', ts)

-- 重置所有相关 Key 的 TTL
local suffixes = {':state', ':messages', ':task', ':tools', ':memory_refs', ':reflections'}
for _, suffix in ipairs(suffixes) do
    local key = prefix .. suffix
    if redis.call('EXISTS', key) == 1 then
        redis.call('EXPIRE', key, ttl)
    end
end

return 1
```

### 3.4 Neo4j Schema（Graph 层）

```cypher
// ═══════════════════════════════════════════════════════════
// Graph Storage — Neo4j Node & Relationship Schema
// ═══════════════════════════════════════════════════════════

// ─── 约束与索引 ───

// Phrase Node 唯一约束
CREATE CONSTRAINT phrase_node_id IF NOT EXISTS
FOR (n:PhraseNode) REQUIRE n.node_id IS UNIQUE;

// Community Node 唯一约束
CREATE CONSTRAINT community_node_id IF NOT EXISTS
FOR (n:CommunityNode) REQUIRE n.community_id IS UNIQUE;

// Block Node 唯一约束（Tree↔Graph 桥接）
CREATE CONSTRAINT block_node_id IF NOT EXISTS
FOR (n:Block) REQUIRE n.block_id IS UNIQUE;

// 多租户隔离索引
CREATE INDEX phrase_tenant IF NOT EXISTS
FOR (n:PhraseNode) ON (n.tenant_id);

CREATE INDEX community_tenant IF NOT EXISTS
FOR (n:CommunityNode) ON (n.tenant_id);

// 记忆类型索引
CREATE INDEX phrase_memory_type IF NOT EXISTS
FOR (n:PhraseNode) ON (n.memory_type);

// 时间索引（用于 Temporal KG 查询）
CREATE INDEX phrase_created IF NOT EXISTS
FOR (n:PhraseNode) ON (n.created_at);

// ─── Node Schema ───

// PhraseNode（短语节点）—— Graph 的基本单元
// Labels: :PhraseNode[:Semantic|:Procedural]
(:PhraseNode {
    node_id:        String,     // UUID
    tenant_id:      String,     // 租户隔离
    agent_id:       String,     // Agent 归属
    memory_type:    String,     // 'semantic' | 'procedural'
    
    name:           String,     // 实体/概念名称（规范化后）
    original_text:  String,     // 原始文本片段
    description:    String,     // LLM 生成的描述
    entity_type:    String,     // 'person' | 'tool' | 'concept' | 'action' | 'event' | ...
    
    // 生命周期
    importance:     Float,      // [0.0, 1.0]
    access_count:   Integer,
    decay_weight:   Float,      // 当前衰减权重
    
    // 时序（Temporal KG）
    valid_from:     DateTime,   // 有效期起始
    valid_until:    DateTime,   // 有效期结束（null = 永久有效）
    
    // 溯源
    source_memory_id: String,   // 关联的 memory_record UUID
    source_block_id:  String,   // 来源 Block UUID
    
    created_at:     DateTime,
    updated_at:     DateTime
})

// CommunityNode（社区节点）—— 聚合层
(:CommunityNode {
    community_id:   String,     // UUID
    tenant_id:      String,
    agent_id:       String,
    
    level:          Integer,    // 社区层级（0 = 叶子社区, 1 = 上层社区, ...）
    name:           String,     // 社区名称（LLM 生成）
    summary:        String,     // 社区摘要（LLM 生成）
    member_count:   Integer,    // 成员节点数
    
    created_at:     DateTime,
    updated_at:     DateTime
})

// ─── Relationship Schema ───

// Context Edge: Block → PhraseNode（Tree↔Graph 桥接）
(:Block)-[:HAS_CONTEXT {
    weight:         Float,      // 上下文相关性权重
    chunk_position: Integer,    // 在 Block 内的位置
    created_at:     DateTime
}]->(:PhraseNode)

// Relation Edge: PhraseNode → PhraseNode（语义关系）
(:PhraseNode)-[:RELATES_TO {
    edge_id:        String,     // UUID
    relation_type:  String,     // 'calls' | 'depends_on' | 'contains' | 'causes' | 'follows' | ...
    description:    String,     // 关系描述
    weight:         Float,      // 关系强度
    importance:     Float,      // 重要性评分
    
    // 时序属性
    valid_from:     DateTime,
    valid_until:    DateTime,
    
    // 溯源
    source_memory_id: String,
    
    created_at:     DateTime,
    updated_at:     DateTime
}]->(:PhraseNode)

// Synonym Edge: PhraseNode → PhraseNode（同义关系）
(:PhraseNode)-[:SYNONYM_OF {
    confidence:     Float,      // 同义置信度 [0.0, 1.0]
    valid_from:     DateTime,
    created_at:     DateTime
}]->(:PhraseNode)

// Belongs_to Edge: PhraseNode → CommunityNode（社区归属）
(:PhraseNode)-[:BELONGS_TO {
    membership_score: Float,    // 归属强度
    created_at:     DateTime
}]->(:CommunityNode)

// Community Hierarchy: CommunityNode → CommunityNode（社区层级）
(:CommunityNode)-[:PARENT_COMMUNITY {
    created_at:     DateTime
}]->(:CommunityNode)
```

### 3.5 Milvus Schema（Vector 层）

```python
# ═══════════════════════════════════════════════════════════
# Vector Storage — Milvus Collection Schema
# ═══════════════════════════════════════════════════════════

# ─── Collection 1: block_embeddings ───
# 存储 Tree 层级 Block 的向量嵌入
block_embeddings_schema = CollectionSchema(
    fields=[
        FieldSchema(name="block_id",        dtype=DataType.VARCHAR, max_length=36, is_primary=True),
        FieldSchema(name="tenant_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="agent_id",        dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="memory_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="memory_type",     dtype=DataType.VARCHAR, max_length=20),   # 'semantic' | 'procedural'
        FieldSchema(name="block_type",      dtype=DataType.VARCHAR, max_length=20),   # 'text' | 'code' | 'table' | 'img'
        FieldSchema(name="section_id",      dtype=DataType.VARCHAR, max_length=36),   # 所属 Section L1 ID
        FieldSchema(name="summary",         dtype=DataType.VARCHAR, max_length=2000),
        FieldSchema(name="embedding",       dtype=DataType.FLOAT_VECTOR, dim=1536),   # text-embedding-3-small
        FieldSchema(name="importance",      dtype=DataType.FLOAT),
        FieldSchema(name="decay_weight",    dtype=DataType.FLOAT),
        FieldSchema(name="created_at",      dtype=DataType.INT64),                    # Unix timestamp ms
    ],
    description="Block-level embeddings for Tree retrieval"
)

# Index: IVF_PQ for large-scale, HNSW for low-latency
# 生产推荐: HNSW (M=16, efConstruction=256)
block_index_params = {
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 16, "efConstruction": 256}
}

# ─── Collection 2: section_embeddings ───
# 存储 Tree 层级 Section 的向量嵌入
section_embeddings_schema = CollectionSchema(
    fields=[
        FieldSchema(name="section_id",      dtype=DataType.VARCHAR, max_length=36, is_primary=True),
        FieldSchema(name="tenant_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="agent_id",        dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="memory_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="level",           dtype=DataType.INT32),                    # 1 = L1, 2 = L2, ...
        FieldSchema(name="section_name",    dtype=DataType.VARCHAR, max_length=500),
        FieldSchema(name="summary",         dtype=DataType.VARCHAR, max_length=4000),
        FieldSchema(name="embedding",       dtype=DataType.FLOAT_VECTOR, dim=1536),
        FieldSchema(name="block_count",     dtype=DataType.INT32),                    # 包含的 Block 数量
        FieldSchema(name="created_at",      dtype=DataType.INT64),
    ],
    description="Section-level embeddings for hierarchical Tree retrieval"
)

# ─── Collection 3: node_embeddings ───
# 存储 Graph 层级 PhraseNode 的向量嵌入
node_embeddings_schema = CollectionSchema(
    fields=[
        FieldSchema(name="node_id",         dtype=DataType.VARCHAR, max_length=36, is_primary=True),
        FieldSchema(name="tenant_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="agent_id",        dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="memory_type",     dtype=DataType.VARCHAR, max_length=20),
        FieldSchema(name="entity_type",     dtype=DataType.VARCHAR, max_length=30),
        FieldSchema(name="name",            dtype=DataType.VARCHAR, max_length=500),
        FieldSchema(name="description",     dtype=DataType.VARCHAR, max_length=2000),
        FieldSchema(name="embedding",       dtype=DataType.FLOAT_VECTOR, dim=1536),
        FieldSchema(name="importance",      dtype=DataType.FLOAT),
        FieldSchema(name="decay_weight",    dtype=DataType.FLOAT),
        FieldSchema(name="community_id",    dtype=DataType.VARCHAR, max_length=36),   # 所属社区
        FieldSchema(name="created_at",      dtype=DataType.INT64),
    ],
    description="PhraseNode embeddings for Graph retrieval"
)

# ─── Collection 4: community_embeddings ───
# 存储 Graph 层级 CommunityNode 的向量嵌入
community_embeddings_schema = CollectionSchema(
    fields=[
        FieldSchema(name="community_id",    dtype=DataType.VARCHAR, max_length=36, is_primary=True),
        FieldSchema(name="tenant_id",       dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="agent_id",        dtype=DataType.VARCHAR, max_length=36),
        FieldSchema(name="level",           dtype=DataType.INT32),
        FieldSchema(name="name",            dtype=DataType.VARCHAR, max_length=500),
        FieldSchema(name="summary",         dtype=DataType.VARCHAR, max_length=8000),
        FieldSchema(name="embedding",       dtype=DataType.FLOAT_VECTOR, dim=1536),
        FieldSchema(name="member_count",    dtype=DataType.INT32),
        FieldSchema(name="created_at",      dtype=DataType.INT64),
    ],
    description="Community-level embeddings for high-level Graph retrieval"
)
```

### 3.6 Elasticsearch Schema（全文检索层）

```json
// ═══════════════════════════════════════════════════════════
// Full-text Index — Elasticsearch Index Mapping
// ═══════════════════════════════════════════════════════════

// Index: ams_blocks
PUT /ams_blocks
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "analysis": {
      "analyzer": {
        "ams_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "stop", "snowball"]
        },
        "ams_cjk_analyzer": {
          "type": "custom",
          "tokenizer": "ik_max_word",
          "filter": ["lowercase"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "block_id":       { "type": "keyword" },
      "tenant_id":      { "type": "keyword" },
      "agent_id":       { "type": "keyword" },
      "memory_id":      { "type": "keyword" },
      "memory_type":    { "type": "keyword" },
      "block_type":     { "type": "keyword" },
      "section_id":     { "type": "keyword" },
      
      "raw_text":       { "type": "text", "analyzer": "ams_analyzer",
                          "fields": { "cjk": { "type": "text", "analyzer": "ams_cjk_analyzer" } } },
      "summary":        { "type": "text", "analyzer": "ams_analyzer",
                          "fields": { "cjk": { "type": "text", "analyzer": "ams_cjk_analyzer" } } },
      "tags":           { "type": "keyword" },
      
      "importance":     { "type": "float" },
      "decay_weight":   { "type": "float" },
      "created_at":     { "type": "date", "format": "epoch_millis" }
    }
  }
}

// Index: ams_nodes (PhraseNode 全文索引)
PUT /ams_nodes
{
  "mappings": {
    "properties": {
      "node_id":        { "type": "keyword" },
      "tenant_id":      { "type": "keyword" },
      "agent_id":       { "type": "keyword" },
      "memory_type":    { "type": "keyword" },
      "entity_type":    { "type": "keyword" },
      "name":           { "type": "text", "analyzer": "ams_analyzer",
                          "fields": { "keyword": { "type": "keyword" }, "cjk": { "type": "text", "analyzer": "ams_cjk_analyzer" } } },
      "description":    { "type": "text", "analyzer": "ams_analyzer",
                          "fields": { "cjk": { "type": "text", "analyzer": "ams_cjk_analyzer" } } },
      "community_id":   { "type": "keyword" },
      "importance":     { "type": "float" },
      "decay_weight":   { "type": "float" },
      "created_at":     { "type": "date", "format": "epoch_millis" }
    }
  }
}
```

---

## 4. API 详细设计

### 4.1 API 总览

AMS 对外暴露三套 API 接口，覆盖不同的集成场景：

| **接口类型** | **协议** | **适用场景** | **认证方式** |
|---|---|---|---|
| **REST API** | HTTP/2 + JSON | Web 客户端、低频管理操作、调试 | Bearer Token (JWT) |
| **gRPC API** | HTTP/2 + Protobuf | Agent Framework 高频调用、服务间通信 | mTLS + API Key |
| **WebSocket API** | WS + JSON | 实时上下文推送、流式检索结果 | Bearer Token |

**API 版本策略**：URL 路径版本化 `/api/v1/...`，gRPC 通过 package 版本化 `ams.v1.*`。

### 4.2 REST API 详细定义

#### 4.2.1 Session（Working Memory 会话管理）

---

**POST /api/v1/sessions**

创建新的 Working Memory 会话。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}
  Content-Type: application/json

Request Body:
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440001",       // required, UUID
  "user_id": "user_12345",                                   // optional, 关联用户
  "session_config": {                                         // optional, 覆盖 Agent 默认配置
    "max_turns": 100,                                         // 最大对话轮次
    "session_ttl_seconds": 3600,                              // 会话 TTL
    "idle_timeout_seconds": 900,                              // 空闲超时
    "auto_retrieve": true,                                    // 是否自动从 LTM 检索上下文
    "auto_retrieve_config": {
      "mode": "lightweight",                                  // "lightweight" | "agentic"
      "max_results": 10,
      "min_relevance": 0.5
    }
  },
  "initial_context": {                                        // optional, 初始上下文注入
    "system_prompt": "You are a helpful assistant...",
    "injected_memories": ["mem_id_1", "mem_id_2"],            // 预注入的长期记忆 ID
    "metadata": {
      "channel": "web",
      "locale": "zh-CN"
    }
  }
}

Response 201 Created:
{
  "session_id": "660e8400-e29b-41d4-a716-446655440099",
  "agent_id": "550e8400-e29b-41d4-a716-446655440001",
  "status": "active",
  "config": {
    "max_turns": 100,
    "session_ttl_seconds": 3600,
    "idle_timeout_seconds": 900,
    "auto_retrieve": true
  },
  "created_at": "2026-03-25T17:30:00.000Z",
  "expires_at": "2026-03-25T18:30:00.000Z"
}

Error Responses:
  400 Bad Request:  { "error": "INVALID_AGENT_ID", "message": "Agent not found or inactive" }
  403 Forbidden:    { "error": "QUOTA_EXCEEDED", "message": "Session quota exceeded for tenant" }
  429 Too Many:     { "error": "RATE_LIMITED", "message": "Too many session creations" }
```

---

**POST /api/v1/sessions/{session_id}/messages**

向会话追加消息并获取更新后的上下文。这是 Agent Framework 最高频的调用接口。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Path Parameters:
  session_id: UUID (required)

Request Body:
{
  "messages": [                                               // required, 一个或多个消息
    {
      "role": "user",                                         // "user" | "assistant" | "system" | "tool"
      "content": "帮我分析一下上季度的销售数据",
      "metadata": {
        "token_count": 15,                                    // optional, 客户端预计算
        "timestamp": 1711360000000                            // optional, 客户端时间戳
      }
    }
  ],
  "tool_results": [                                           // optional, 工具调用结果
    {
      "tool_call_id": "call_abc123",
      "tool_name": "sql_query",
      "result": "{\"rows\": [...]}",
      "status": "success",
      "latency_ms": 230
    }
  ],
  "retrieve_context": {                                       // optional, 是否触发 LTM 检索
    "enabled": true,                                          // 覆盖 auto_retrieve 设置
    "query": "上季度销售数据分析",                              // 自定义检索 query（默认用最新 user message）
    "mode": "lightweight",
    "filters": {
      "memory_types": ["semantic"],
      "time_range": {
        "start": "2025-10-01T00:00:00Z",
        "end": "2026-01-01T00:00:00Z"
      }
    },
    "max_results": 10,
    "min_relevance": 0.5
  }
}

Response 200 OK:
{
  "session_id": "660e8400-...",
  "turn_count": 5,
  "total_tokens": 1250,
  
  "messages_added": 1,
  
  "retrieved_context": {                                      // 仅当 retrieve_context.enabled=true
    "memories": [
      {
        "memory_id": "770e8400-...",
        "memory_type": "semantic",
        "title": "Q3 2025 销售报告",
        "summary": "第三季度总销售额同比增长 15%...",
        "relevance_score": 0.87,
        "source": {
          "type": "work_document",
          "id": "doc_q3_sales_2025"
        },
        "content_blocks": [                                   // 检索到的具体内容块
          {
            "block_id": "blk_001",
            "block_type": "text",
            "content": "2025年Q3销售总额达到...",
            "section_path": ["年度报告", "Q3 销售分析"]        // Tree 层级路径
          },
          {
            "block_id": "blk_002",
            "block_type": "table",
            "content": "| 产品线 | 销售额 | 同比 |\n|...",
            "section_path": ["年度报告", "Q3 销售分析", "分产品线明细"]
          }
        ],
        "related_entities": [                                 // Graph 层级的关联实体
          {
            "node_id": "node_001",
            "name": "Q3销售额",
            "entity_type": "metric",
            "relations": [
              { "target": "华东区", "relation": "breakdown_by", "weight": 0.9 }
            ]
          }
        ]
      }
    ],
    "retrieval_metadata": {
      "mode": "lightweight",
      "total_candidates": 45,
      "returned": 3,
      "latency_ms": 120,
      "channels_used": ["bm25", "vector", "graph"]
    }
  },
  
  "context_window": {
    "current_tokens": 1250,
    "max_tokens": 128000,
    "utilization": 0.0098,
    "truncated": false
  },
  
  "updated_at": "2026-03-25T17:31:05.000Z"
}

Error Responses:
  404 Not Found:    { "error": "SESSION_NOT_FOUND", "message": "Session expired or does not exist" }
  409 Conflict:     { "error": "SESSION_CLOSED", "message": "Session has been closed" }
  413 Too Large:    { "error": "MESSAGE_TOO_LARGE", "message": "Message exceeds 32KB limit" }
```

---

**GET /api/v1/sessions/{session_id}**

获取会话完整状态。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Path Parameters:
  session_id: UUID (required)

Query Parameters:
  include_messages: boolean (default: true)    // 是否包含对话历史
  include_task: boolean (default: false)       // 是否包含任务状态
  include_reflections: boolean (default: false) // 是否包含 Agent 反思
  message_limit: int (default: 50, max: 200)   // 返回的消息数量上限

Response 200 OK:
{
  "session_id": "660e8400-...",
  "agent_id": "550e8400-...",
  "user_id": "user_12345",
  "status": "active",
  "turn_count": 5,
  "total_tokens": 1250,
  "config": { ... },
  
  "messages": [                                // 按时间正序
    { "message_id": "...", "role": "user", "content": "...", "metadata": { ... } },
    { "message_id": "...", "role": "assistant", "content": "...", "metadata": { ... } },
    ...
  ],
  
  "task": {                                    // 仅当 include_task=true
    "task_id": "...",
    "status": "running",
    "step_index": 3,
    "total_steps": 5,
    "tool_chain": ["search", "read", "analyze"]
  },
  
  "reflections": [                             // 仅当 include_reflections=true
    { "reflection_id": "...", "type": "knowledge_gap", "content": "我缺少2025Q4的数据", ... }
  ],
  
  "memory_refs": [                             // 当前会话引用的长期记忆
    { "memory_id": "770e8400-...", "relevance_score": 0.87 }
  ],
  
  "context_window": {
    "current_tokens": 1250,
    "max_tokens": 128000,
    "utilization": 0.0098
  },
  
  "created_at": "2026-03-25T17:30:00.000Z",
  "last_active_at": "2026-03-25T17:31:05.000Z",
  "expires_at": "2026-03-25T18:31:05.000Z"
}
```

---

**DELETE /api/v1/sessions/{session_id}**

关闭会话，触发提升评估。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Query Parameters:
  force: boolean (default: false)              // 强制关闭，跳过提升评估
  promote: boolean (default: true)             // 是否触发提升评估

Response 200 OK:
{
  "session_id": "660e8400-...",
  "status": "closed",
  "promotion": {
    "evaluated": true,
    "score": 0.72,
    "promoted": true,
    "promoted_memories": [
      {
        "memory_id": "880e8400-...",
        "memory_type": "semantic",
        "memory_subtype": "episode",
        "title": "用户询问Q3销售数据分析"
      }
    ]
  },
  "closed_at": "2026-03-25T17:35:00.000Z"
}
```

---

是的，输出长度触达了上限被截断了。我现在从 **4.2.2 Memory（长期记忆管理）** 处继续，完成剩余全部内容 👇

---

#### 4.2.2 Memory（长期记忆管理）

---

**POST /api/v1/memories/retrieve**

统一检索接口——AMS 最核心的 API。支持 Lightweight 和 Agentic 两种模式。这一设计参考了 Mem0 的统一 search API 理念（一个接口覆盖所有记忆类型）[5]，同时融合了 LightRAG 的双层检索通道（低层级实体 + 高层级社区）[3]。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Request Body:
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440001",       // required
  "query": "上季度各产品线的销售趋势和同比变化",                // required, 自然语言查询
  
  "mode": "lightweight",                                      // "lightweight" | "agentic"
  
  // ─── 过滤条件 ───
  "filters": {
    "memory_types": ["semantic", "procedural"],               // 限定记忆类型
    "memory_subtypes": ["fact", "episode"],                   // 限定子类型
    "source_types": ["work_document", "user_interaction"],    // 限定数据源
    "structures": ["tree", "graph"],                          // 限定结构类型
    "time_range": {                                           // 时间范围过滤
      "field": "created_at",                                  // "created_at" | "valid_from" | "last_accessed"
      "start": "2025-07-01T00:00:00Z",
      "end": "2026-01-01T00:00:00Z"
    },
    "min_importance": 0.3,                                    // 最低重要性阈值
    "min_decay_weight": 0.1,                                  // 最低衰减权重阈值
    "tags": ["sales", "quarterly"],                           // 标签过滤
    "exclude_memory_ids": ["mem_id_old_1"]                    // 排除特定记忆
  },
  
  // ─── 检索参数 ───
  "retrieval_config": {
    "max_results": 20,                                        // 最终返回数量
    "min_relevance": 0.4,                                     // 最低相关性阈值
    
    // Lightweight 模式参数
    "channels": {                                             // 启用的检索通道
      "bm25": { "enabled": true, "weight": 0.2, "top_k": 50 },
      "vector": { "enabled": true, "weight": 0.4, "top_k": 50, "ef_search": 128 },
      "tree": { "enabled": true, "weight": 0.2, "top_k": 30, "max_depth": 3 },
      "graph": { "enabled": true, "weight": 0.2, "top_k": 30, "max_hops": 2, "use_ppr": true }
    },
    "fusion": "rrf",                                          // "rrf" | "weighted_sum"
    "rrf_k": 60,                                              // RRF 常数 k
    
    // Agentic 模式参数（仅 mode="agentic" 时生效）
    "agentic_config": {
      "query_expansion": true,                                // LLM 驱动的查询扩展
      "expansion_model": "gpt-4o-mini",                       // 扩展用模型
      "max_expansion_queries": 3,                             // 最大扩展查询数
      "multi_round": true,                                    // 多轮迭代检索
      "max_rounds": 3,                                        // 最大迭代轮数
      "round_stop_threshold": 0.85,                           // 满意度阈值，达到则提前停止
      "intelligent_fusion": true                              // LLM 驱动的智能融合
    },
    
    // Reranking 参数
    "reranking": {
      "enabled": true,
      "model": "bge-reranker-v2-m3",                          // Reranker 模型
      "top_k": 10                                             // Rerank 后保留数量
    }
  },
  
  // ─── 输出控制 ───
  "output_config": {
    "include_content": true,                                  // 是否返回完整内容
    "include_graph_context": true,                            // 是否返回 Graph 关联实体
    "include_tree_path": true,                                // 是否返回 Tree 层级路径
    "include_source_blocks": true,                            // 是否返回原始 Block
    "max_content_length": 2000,                               // 单条内容最大字符数
    "format": "structured"                                    // "structured" | "flat_text" | "markdown"
  }
}

Response 200 OK:
{
  "request_id": "req_abc123",
  "query": "上季度各产品线的销售趋势和同比变化",
  "mode": "lightweight",
  
  "results": [
    {
      "memory_id": "770e8400-e29b-41d4-a716-446655440010",
      "memory_type": "semantic",
      "memory_subtype": "fact",
      "title": "2025年Q3分产品线销售分析",
      "summary": "第三季度三大产品线销售表现分化明显：A产品线同比+22%...",
      
      "relevance_score": 0.91,                                // 综合相关性评分
      "importance": 0.85,
      "decay_weight": 0.95,
      "final_score": 0.88,                                    // relevance × importance × decay_weight 加权
      
      "source": {
        "type": "work_document",
        "id": "doc_q3_sales_2025",
        "name": "2025年Q3季度销售报告.pdf"
      },
      
      "tree_context": {                                       // Tree 层级上下文
        "section_path": [
          { "level": 2, "section_id": "sec_l2_001", "name": "年度销售报告" },
          { "level": 1, "section_id": "sec_l1_003", "name": "Q3 分产品线分析" }
        ],
        "blocks": [
          {
            "block_id": "blk_007",
            "block_type": "text",
            "content": "2025年第三季度，A产品线实现销售额5.2亿元，同比增长22%...",
            "tags": ["sales", "product_a", "q3"],
            "position": 3
          },
          {
            "block_id": "blk_008",
            "block_type": "table",
            "content": "| 产品线 | Q3销售额(亿) | 同比 | 环比 |\n|---|---|---|---|\n| A | 5.2 | +22% | +8% |\n| B | 3.1 | -5% | +2% |\n| C | 2.8 | +15% | +12% |",
            "tags": ["sales", "table", "comparison"],
            "position": 4
          }
        ]
      },
      
      "graph_context": {                                      // Graph 层级上下文
        "central_entities": [
          {
            "node_id": "node_101",
            "name": "Q3销售额",
            "entity_type": "metric",
            "description": "2025年第三季度总销售额"
          }
        ],
        "relations": [
          {
            "source": "Q3销售额",
            "target": "A产品线",
            "relation_type": "breakdown_by",
            "weight": 0.92,
            "description": "Q3销售额按A产品线分解"
          },
          {
            "source": "Q3销售额",
            "target": "华东区",
            "relation_type": "regional_distribution",
            "weight": 0.78,
            "description": "Q3销售额的华东区域分布"
          }
        ],
        "community": {
          "community_id": "comm_015",
          "name": "季度销售分析",
          "summary": "该社区包含所有与季度销售指标、产品线表现、区域分布相关的实体..."
        }
      },
      
      "created_at": "2025-10-15T10:00:00Z",
      "last_accessed": "2026-03-20T14:30:00Z"
    }
    // ... 更多结果
  ],
  
  "retrieval_metadata": {
    "mode": "lightweight",
    "channels": {
      "bm25":   { "candidates": 45, "latency_ms": 12 },
      "vector": { "candidates": 50, "latency_ms": 28 },
      "tree":   { "candidates": 22, "latency_ms": 35 },
      "graph":  { "candidates": 18, "latency_ms": 42 }
    },
    "fusion": { "method": "rrf", "input_candidates": 135, "deduplicated": 89 },
    "reranking": { "input": 89, "output": 10, "model": "bge-reranker-v2-m3", "latency_ms": 65 },
    "total_latency_ms": 148,
    "returned": 10
  }
}

Error Responses:
  400 Bad Request:  { "error": "INVALID_QUERY", "message": "Query must be between 1 and 2000 characters" }
  404 Not Found:    { "error": "AGENT_NOT_FOUND", "message": "Agent does not exist" }
  408 Timeout:      { "error": "RETRIEVAL_TIMEOUT", "message": "Retrieval exceeded 5s timeout" }
  422 Unprocessable:{ "error": "INVALID_FILTER", "message": "memory_type 'xxx' is not valid" }
```

---

**POST /api/v1/memories**

手动存储记忆——允许 Agent 或用户显式将重要信息写入长期记忆。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Request Body:
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440001",       // required
  
  "memory_type": "semantic",                                  // required: "semantic" | "procedural" | "metacognitive"
  "memory_subtype": "fact",                                   // optional: "fact" | "episode" | "workflow" | "skill" | "pattern"
  
  "source": {
    "type": "user_interaction",                               // required: 数据源类型
    "id": "session_660e8400",                                 // optional: 来源 ID
    "session_id": "660e8400-..."                              // optional: 关联会话
  },
  
  "content": {
    "title": "用户偏好：报告格式",                              // required
    "text": "用户 user_12345 偏好使用 Markdown 表格格式展示数据对比，不喜欢纯文本列举。",
    "tags": ["user_preference", "format", "markdown"],        // optional
    "metadata": {                                             // optional: 自定义元数据
      "confidence": 0.9,
      "observed_count": 3
    }
  },
  
  "importance": 0.7,                                          // optional, 默认 0.5
  
  "structures": ["graph"],                                    // optional, 不指定则按映射规则自动推断
  
  "ttl_seconds": null                                         // optional, null = 永不过期
}

Response 201 Created:
{
  "memory_id": "990e8400-e29b-41d4-a716-446655440077",
  "memory_type": "semantic",
  "memory_subtype": "fact",
  "status": "pending_processing",                             // 异步处理中
  "structures": ["graph"],
  "pipeline_job_id": "job_xyz789",                            // 可用于追踪处理进度
  "created_at": "2026-03-25T17:40:00.000Z"
}

Error Responses:
  400 Bad Request:  { "error": "MAPPING_VIOLATION", "code": "E1001",
                      "message": "source_type 'user_interaction' does not allow structure 'tree'. Allowed: ['graph']" }
  413 Too Large:    { "error": "CONTENT_TOO_LARGE", "message": "Content text exceeds 50KB limit" }
```

---

**GET /api/v1/memories/{memory_id}**

获取单条记忆的完整详情。

```
Headers:
  Authorization: Bearer {jwt_token}
  X-Tenant-ID: {tenant_id}

Path Parameters:
  memory_id: UUID (required)

Query Parameters:
  include_tree: boolean (default: true)        // 是否包含 Tree 结构详情
  include_graph: boolean (default: true)       // 是否包含 Graph 结构详情
  graph_depth: int (default: 1, max: 3)        // Graph 展开深度

Response 200 OK:
{
  "memory_id": "770e8400-...",
  "agent_id": "550e8400-...",
  "memory_type": "semantic",
  "memory_subtype": "fact",
  "status": "active",
  
  "title": "2025年Q3分产品线销售分析",
  "summary": "第三季度三大产品线销售表现分化明显...",
  
  "source": {
    "type": "work_document",
    "id": "doc_q3_sales_2025",
    "name": "2025年Q3季度销售报告.pdf"
  },
  
  "lifecycle": {
    "importance": 0.85,
    "access_count": 12,
    "last_accessed": "2026-03-20T14:30:00Z",
    "decay_weight": 0.95,
    "expires_at": null,
    "created_at": "2025-10-15T10:00:00Z",
    "updated_at": "2026-03-20T14:30:00Z"
  },
  
  "tree": {                                    // Tree 结构详情
    "sections": [
      {
        "section_id": "sec_l2_001",
        "level": 2,
        "name": "年度销售报告",
        "summary": "...",
        "children": [
          {
            "section_id": "sec_l1_003",
            "level": 1,
            "name": "Q3 分产品线分析",
            "summary": "...",
            "block_count": 5
          }
        ]
      }
    ],
    "blocks": [
      {
        "block_id": "blk_007",
        "block_type": "text",
        "raw_text": "2025年第三季度，A产品线实现销售额5.2亿元...",
        "summary": "A产品线Q3销售额5.2亿，同比+22%",
        "tags": ["sales", "product_a"],
        "position": 3,
        "prev_block_id": "blk_006",
        "next_block_id": "blk_008"
      }
      // ...
    ]
  },
  
  "graph": {                                   // Graph 结构详情
    "nodes": [
      {
        "node_id": "node_101",
        "name": "Q3销售额",
        "entity_type": "metric",
        "description": "2025年第三季度总销售额",
        "importance": 0.9,
        "community_id": "comm_015"
      }
    ],
    "edges": [
      {
        "edge_id": "edge_201",
        "source_node_id": "node_101",
        "target_node_id": "node_102",
        "relation_type": "breakdown_by",
        "description": "按产品线分解",
        "weight": 0.92
      }
    ],
    "communities": [
      {
        "community_id": "comm_015",
        "name": "季度销售分析",
        "summary": "...",
        "member_count": 15,
        "level": 0
      }
    ]
  }
}
```

---

**PATCH /api/v1/memories/{memory_id}**

更新记忆的元数据（不修改内容本身）。

```
Request Body:
{
  "importance": 0.95,                                         // 调整重要性
  "tags_add": ["highlighted", "key_insight"],                 // 追加标签
  "tags_remove": ["draft"],                                   // 移除标签
  "expires_at": "2027-01-01T00:00:00Z",                       // 设置/更新过期时间
  "metadata": {                                               // 合并更新自定义元数据
    "reviewed_by": "user_admin"
  }
}

Response 200 OK:
{
  "memory_id": "770e8400-...",
  "updated_fields": ["importance", "tags", "expires_at", "metadata"],
  "updated_at": "2026-03-25T17:45:00.000Z"
}
```

---

**DELETE /api/v1/memories/{memory_id}**

删除记忆（软删除，标记为 deleted 状态）。

```
Query Parameters:
  hard_delete: boolean (default: false)        // 硬删除：同时清除所有存储引擎中的数据
  cascade: boolean (default: true)             // 级联删除关联的 Tree/Graph 结构

Response 200 OK:
{
  "memory_id": "770e8400-...",
  "status": "deleted",
  "hard_deleted": false,
  "cascade_deleted": {
    "blocks": 5,
    "sections": 2,
    "phrase_nodes": 8,
    "edges": 12
  },
  "deleted_at": "2026-03-25T17:50:00.000Z"
}
```

---

**POST /api/v1/memories/feedback**

记忆检索质量反馈——用于持续优化检索效果。

```
Request Body:
{
  "agent_id": "550e8400-...",
  "session_id": "660e8400-...",                               // optional
  "request_id": "req_abc123",                                 // 关联的检索请求 ID
  
  "feedbacks": [
    {
      "memory_id": "770e8400-...",
      "relevance": "highly_relevant",                         // "highly_relevant" | "relevant" | "partially_relevant" | "irrelevant"
      "usefulness": "used_in_response",                       // "used_in_response" | "referenced" | "skipped" | "harmful"
      "comment": "这条记忆直接回答了用户的问题"                  // optional
    },
    {
      "memory_id": "880e8400-...",
      "relevance": "irrelevant",
      "usefulness": "skipped"
    }
  ]
}

Response 200 OK:
{
  "processed": 2,
  "importance_adjustments": [
    { "memory_id": "770e8400-...", "old_importance": 0.85, "new_importance": 0.88 },
    { "memory_id": "880e8400-...", "old_importance": 0.60, "new_importance": 0.55 }
  ]
}
```

---

#### 4.2.3 Agent（Agent 管理）

---

**POST /api/v1/agents**

```
Request Body:
{
  "name": "Sales Analyst Agent",
  "description": "专注于销售数据分析的 Agent",
  "agent_type": "specialist",
  "memory_config": {                                          // optional, 使用默认值
    "working_memory": {
      "max_turns": 100,
      "session_ttl_seconds": 3600,
      "idle_timeout_seconds": 900
    },
    "long_term_memory": {
      "enabled": true,
      "tree_enabled": true,
      "graph_enabled": true,
      "decay_lambda": 0.0005,
      "promotion_threshold": 0.65
    },
    "retrieval": {
      "default_mode": "lightweight",
      "max_results": 20,
      "reranking_enabled": true,
      "reranking_model": "bge-reranker-v2-m3"
    }
  },
  "metadata": {
    "department": "sales",
    "version": "1.0"
  }
}

Response 201 Created:
{
  "agent_id": "550e8400-...",
  "name": "Sales Analyst Agent",
  "status": "active",
  "memory_config": { ... },
  "created_at": "2026-03-25T17:00:00.000Z"
}
```

---

**GET /api/v1/agents/{agent_id}/stats**

获取 Agent 的记忆统计信息。

```
Response 200 OK:
{
  "agent_id": "550e8400-...",
  "stats": {
    "working_memory": {
      "active_sessions": 3,
      "total_sessions": 156,
      "avg_session_duration_seconds": 1240
    },
    "long_term_memory": {
      "total_memories": 1250,
      "by_type": {
        "semantic": { "total": 980, "active": 920, "decayed": 45, "archived": 15 },
        "procedural": { "total": 250, "active": 235, "decayed": 10, "archived": 5 },
        "metacognitive": { "total": 20, "active": 20, "decayed": 0, "archived": 0 }
      },
      "by_structure": {
        "tree_only": 180,
        "graph_only": 650,
        "tree_and_graph": 420
      },
      "storage_usage_mb": 256.5,
      "total_blocks": 4500,
      "total_sections": 890,
      "total_phrase_nodes": 12000,
      "total_edges": 35000,
      "total_communities": 450
    },
    "retrieval": {
      "total_queries_30d": 2340,
      "avg_latency_ms": 135,
      "p95_latency_ms": 210,
      "avg_relevance_score": 0.72,
      "feedback_positive_rate": 0.81
    }
  },
  "updated_at": "2026-03-25T17:55:00.000Z"
}
```

---

#### 4.2.4 Ingestion（数据摄入）

---

**POST /api/v1/ingest**

批量摄入外部数据源（文档、代码等）到长期记忆。这是一个异步接口，返回 Job ID 用于追踪进度。

```
Request Body:
{
  "agent_id": "550e8400-...",
  
  "source": {
    "type": "work_document",                                  // "work_document" | "source_code" | "skill_markdown"
    "format": "markdown",                                     // "markdown" | "pdf" | "html" | "txt" | "python" | "java" | "go"
    "name": "2025年Q3季度销售报告",
    "url": "s3://ams-data/docs/q3_sales_2025.md",             // S3/OSS URL 或直接内容
    "content": null,                                          // 与 url 二选一
    "metadata": {
      "author": "张三",
      "department": "销售部",
      "version": "1.2"
    }
  },
  
  "processing_config": {
    "structures": ["tree", "graph"],                          // 按映射规则自动推断，也可显式指定
    "tree_config": {
      "max_depth": 4,                                         // 最大 Section 层级深度
      "chunk_strategy": "semantic",                           // "semantic" | "fixed_size" | "heading_based"
      "chunk_size": 512,                                      // 仅 fixed_size 时生效
      "overlap": 50
    },
    "graph_config": {
      "layer_mode": "double",                                 // "double" | "full_three"
      "entity_extraction_model": "gpt-4o-mini",
      "relation_extraction_model": "gpt-4o-mini",
      "community_algorithm": "leiden",                        // "leiden" | "louvain"
      "community_resolution": 1.0
    },
    "embedding_model": "text-embedding-3-small",
    "language": "zh"
  },
  
  "priority": "normal"                                        // "low" | "normal" | "high"
}

Response 202 Accepted:
{
  "job_id": "job_ingest_001",
  "status": "queued",
  "estimated_duration_seconds": 120,
  "created_at": "2026-03-25T18:00:00.000Z",
  "tracking_url": "/api/v1/jobs/job_ingest_001"
}
```

---

**GET /api/v1/jobs/{job_id}**

查询异步任务进度。

```
Response 200 OK:
{
  "job_id": "job_ingest_001",
  "job_type": "ingestion",
  "status": "processing",                                     // "queued" | "processing" | "completed" | "failed" | "cancelled"
  "progress": {
    "stage": "structure",                                     // "ingestion" | "transform" | "structure" | "indexing"
    "stage_progress": 0.65,                                   // 当前阶段进度 [0.0, 1.0]
    "overall_progress": 0.72,                                 // 总体进度
    "details": {
      "blocks_created": 45,
      "sections_created": 8,
      "nodes_extracted": 120,
      "edges_created": 350,
      "communities_detected": 12
    }
  },
  "result": null,                                             // 完成后填充
  "error": null,                                              // 失败时填充
  "created_at": "2026-03-25T18:00:00.000Z",
  "started_at": "2026-03-25T18:00:05.000Z",
  "updated_at": "2026-03-25T18:01:30.000Z"
}

// 完成后的 result 示例:
"result": {
  "memory_ids": ["990e8400-..."],
  "stats": {
    "blocks": 52,
    "sections": 10,
    "phrase_nodes": 145,
    "edges": 420,
    "communities": 15,
    "processing_time_seconds": 95
  }
}
```

---

#### 4.2.5 Lifecycle（生命周期管理）

---

**POST /api/v1/lifecycle/decay**

手动触发衰减计算（通常由定时任务自动执行）。

```
Request Body:
{
  "agent_id": "550e8400-...",                                 // optional, 不指定则全局执行
  "dry_run": true,                                            // 仅模拟，不实际更新
  "decay_config": {
    "lambda": 0.001,                                          // 衰减系数
    "min_weight": 0.05,                                       // 低于此值标记为 decayed
    "archive_threshold": 0.01,                                // 低于此值标记为 archived
    "access_boost": true,                                     // 访问频率是否抵消衰减
    "access_boost_factor": 0.1                                // 每次访问增加的权重
  }
}

Response 200 OK:
{
  "dry_run": true,
  "affected_memories": {
    "total_evaluated": 1250,
    "weight_updated": 890,
    "newly_decayed": 15,                                      // active → decayed
    "newly_archived": 3,                                      // decayed → archived
    "boosted_by_access": 45                                   // 因访问频率而权重上升的
  },
  "execution_time_ms": 2300
}
```

---

**GET /api/v1/lifecycle/stats**

获取记忆生命周期统计。

```
Query Parameters:
  agent_id: UUID (optional)

Response 200 OK:
{
  "lifecycle_stats": {
    "total_memories": 1250,
    "status_distribution": {
      "active": 1175,
      "decayed": 55,
      "archived": 15,
      "deleted": 5
    },
    "decay_distribution": {                                   // 衰减权重分布
      "0.0-0.2": 18,
      "0.2-0.4": 37,
      "0.4-0.6": 125,
      "0.6-0.8": 380,
      "0.8-1.0": 690
    },
    "avg_age_days": 45.2,
    "avg_access_count": 8.5,
    "upcoming_expirations_7d": 3,                             // 7天内即将过期的记忆数
    "last_decay_run": "2026-03-25T06:00:00Z",
    "next_decay_run": "2026-03-26T06:00:00Z"
  }
}
```

---

### 4.3 gRPC API 定义

gRPC 接口面向 Agent Framework 的高频调用场景，提供比 REST 更低的延迟和更高的吞吐。

```protobuf
// ═══════════════════════════════════════════════════════════
// AMS gRPC Service Definition
// Package: ams.v1
// ═══════════════════════════════════════════════════════════

syntax = "proto3";
package ams.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/struct.proto";

// ─── 主服务定义 ───

service AgentMemoryService {
  // Session (Working Memory)
  rpc CreateSession(CreateSessionRequest) returns (Session);
  rpc AppendMessages(AppendMessagesRequest) returns (AppendMessagesResponse);
  rpc GetSession(GetSessionRequest) returns (Session);
  rpc CloseSession(CloseSessionRequest) returns (CloseSessionResponse);
  
  // Memory (Long-term)
  rpc RetrieveMemories(RetrieveRequest) returns (RetrieveResponse);
  rpc StoreMemory(StoreMemoryRequest) returns (StoreMemoryResponse);
  rpc GetMemory(GetMemoryRequest) returns (MemoryRecord);
  rpc DeleteMemory(DeleteMemoryRequest) returns (DeleteMemoryResponse);
  
  // Streaming retrieval (Agentic mode 的流式返回)
  rpc RetrieveMemoriesStream(RetrieveRequest) returns (stream RetrieveChunk);
  
  // Feedback
  rpc SubmitFeedback(FeedbackRequest) returns (FeedbackResponse);
  
  // Health
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

// ─── 核心消息类型 ───

message RetrieveRequest {
  string agent_id = 1;
  string query = 2;
  RetrieveMode mode = 3;
  RetrieveFilters filters = 4;
  RetrievalConfig config = 5;
  OutputConfig output_config = 6;
}

enum RetrieveMode {
  RETRIEVE_MODE_UNSPECIFIED = 0;
  LIGHTWEIGHT = 1;
  AGENTIC = 2;
}

message RetrieveFilters {
  repeated string memory_types = 1;
  repeated string memory_subtypes = 2;
  repeated string source_types = 3;
  repeated string structures = 4;
  TimeRange time_range = 5;
  float min_importance = 6;
  float min_decay_weight = 7;
  repeated string tags = 8;
  repeated string exclude_memory_ids = 9;
}

message TimeRange {
  string field = 1;
  google.protobuf.Timestamp start = 2;
  google.protobuf.Timestamp end = 3;
}

message RetrievalConfig {
  int32 max_results = 1;
  float min_relevance = 2;
  ChannelConfig channels = 3;
  string fusion_method = 4;
  int32 rrf_k = 5;
  AgenticConfig agentic_config = 6;
  RerankingConfig reranking = 7;
}

message ChannelConfig {
  ChannelParams bm25 = 1;
  ChannelParams vector = 2;
  ChannelParams tree = 3;
  GraphChannelParams graph = 4;
}

message ChannelParams {
  bool enabled = 1;
  float weight = 2;
  int32 top_k = 3;
}

message GraphChannelParams {
  bool enabled = 1;
  float weight = 2;
  int32 top_k = 3;
  int32 max_hops = 4;
  bool use_ppr = 5;
}

message AgenticConfig {
  bool query_expansion = 1;
  string expansion_model = 2;
  int32 max_expansion_queries = 3;
  bool multi_round = 4;
  int32 max_rounds = 5;
  float round_stop_threshold = 6;
  bool intelligent_fusion = 7;
}

message RerankingConfig {
  bool enabled = 1;
  string model = 2;
  int32 top_k = 3;
}

message OutputConfig {
  bool include_content = 1;
  bool include_graph_context = 2;
  bool include_tree_path = 3;
  bool include_source_blocks = 4;
  int32 max_content_length = 5;
  string format = 6;
}

message RetrieveResponse {
  string request_id = 1;
  repeated MemoryResult results = 2;
  RetrievalMetadata metadata = 3;
}

message RetrieveChunk {
  oneof chunk {
    MemoryResult result = 1;
    RetrievalMetadata metadata = 2;
    AgenticRoundInfo round_info = 3;
  }
}

message AgenticRoundInfo {
  int32 round = 1;
  string expanded_query = 2;
  int32 new_candidates = 3;
  float satisfaction_score = 4;
}

message MemoryResult {
  string memory_id = 1;
  string memory_type = 2;
  string memory_subtype = 3;
  string title = 4;
  string summary = 5;
  float relevance_score = 6;
  float importance = 7;
  float decay_weight = 8;
  float final_score = 9;
  SourceInfo source = 10;
  TreeContext tree_context = 11;
  GraphContext graph_context = 12;
  google.protobuf.Timestamp created_at = 13;
}

// ... (TreeContext, GraphContext, SourceInfo 等消息类型定义省略，结构与 REST 响应一致)
```

---

## 5. 核心流程详细设计

### 5.1 检索流程（Lightweight Mode）

这是 AMS 最高频的操作路径，设计目标是 **p95 < 200ms**。

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Lightweight Retrieval Flow                          │
│                                                                      │
│  ① Query 接收                                                        │
│  │  → 参数校验 + 租户隔离 + 速率限制                                  │
│  │  → 映射规则校验（filters 中的 memory_type/structure 合法性）        │
│  │                                                                    │
│  ② Query 预处理 (< 10ms)                                             │
│  │  → Query Embedding 生成（调用 LLM Service）                        │
│  │  → Query 分词（用于 BM25）                                         │
│  │  → 构建各通道的过滤条件（tenant_id + agent_id + filters）          │
│  │                                                                    │
│  ③ 四路并行召回 (< 80ms, 并行执行)                                    │
│  │  ┌─────────────────────────────────────────────────────────┐      │
│  │  │  BM25 Channel          → Elasticsearch                  │      │
│  │  │  Vector Channel        → Milvus (block + node + comm)   │      │
│  │  │  Tree Channel          → Neo4j (Section 层级导航)        │      │
│  │  │  Graph Channel + PPR   → Neo4j (关系遍历 + PageRank)    │      │
│  │  └─────────────────────────────────────────────────────────┘      │
│  │                                                                    │
│  ④ 结果融合 (< 15ms)                                                 │
│  │  → 去重（基于 memory_id + block_id）                               │
│  │  → RRF 融合: score = Σ 1/(k + rank_i) × weight_i                 │
│  │  → 应用 decay_weight 和 importance 加权                            │
│  │  → final_score = relevance × importance^α × decay_weight^β        │
│  │    (默认 α=0.3, β=0.2)                                            │
│  │                                                                    │
│  ⑤ Reranking (< 60ms, optional)                                      │
│  │  → Cross-encoder reranker (bge-reranker-v2-m3)                    │
│  │  → 输入: query + top-N candidates 的 summary/content              │
│  │  → 输出: reranked scores                                          │
│  │                                                                    │
│  ⑥ 上下文组装 (< 20ms)                                               │
│  │  → 根据 output_config 拉取 Tree path / Graph context              │
│  │  → 格式化为 structured / flat_text / markdown                     │
│  │                                                                    │
│  ⑦ 返回结果 + 异步记录                                                │
│     → 返回 RetrieveResponse                                          │
│     → 异步: 更新 access_count + last_accessed                        │
│     → 异步: 写入检索日志（用于质量分析）                               │
│                                                                      │
│  总延迟预算: 10 + 80 + 15 + 60 + 20 = 185ms (p95 target < 200ms)    │
└──────────────────────────────────────────────────────────────────────┘
```

#### RRF 融合算法实现

```python
def rrf_fusion(
    channel_results: dict[str, list[ScoredCandidate]],
    channel_weights: dict[str, float],
    k: int = 60
) -> list[ScoredCandidate]:
    """
    Reciprocal Rank Fusion (RRF) with channel weights.
    
    For each candidate across all channels:
      rrf_score = Σ (channel_weight_i / (k + rank_i))
    
    where rank_i is the 1-based rank in channel i.
    """
    fused_scores: dict[str, float] = {}
    candidate_map: dict[str, ScoredCandidate] = {}
    
    for channel_name, candidates in channel_results.items():
        weight = channel_weights.get(channel_name, 1.0)
        for rank, candidate in enumerate(candidates, start=1):
            cid = candidate.memory_id  # 或 block_id，取决于去重粒度
            fused_scores[cid] = fused_scores.get(cid, 0.0) + weight / (k + rank)
            if cid not in candidate_map:
                candidate_map[cid] = candidate
    
    # 应用 importance 和 decay_weight 加权
    for cid, base_score in fused_scores.items():
        candidate = candidate_map[cid]
        fused_scores[cid] = (
            base_score
            * (candidate.importance ** 0.3)
            * (candidate.decay_weight ** 0.2)
        )
    
    # 按融合分数降序排列
    sorted_ids = sorted(fused_scores, key=fused_scores.get, reverse=True)
    return [(candidate_map[cid], fused_scores[cid]) for cid in sorted_ids]
```

### 5.2 检索流程（Agentic Mode）

Agentic Mode 在 Lightweight 的基础上增加了 LLM 驱动的智能层，适用于复杂的多跳推理查询。这一设计参考了 AgenticRAG 的迭代检索思想 [1]。

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Agentic Retrieval Flow                            │
│                                                                      │
│  ① Query Expansion (LLM, ~200ms)                                    │
│  │  → 调用 LLM 将原始 query 扩展为多个子查询                         │
│  │  → 示例:                                                          │
│  │    原始: "上季度销售趋势和同比变化"                                 │
│  │    扩展: [                                                         │
│  │      "2025年Q3各产品线销售额数据",                                  │
│  │      "2025年Q3与Q2销售额环比对比",                                  │
│  │      "2024年Q3销售额用于同比计算"                                   │
│  │    ]                                                               │
│  │                                                                    │
│  ② Multi-round Iterative Retrieval                                   │
│  │  ┌─── Round 1 ────────────────────────────────────────────┐       │
│  │  │  对原始 query + 扩展 queries 并行执行 Lightweight 检索  │       │
│  │  │  → 合并结果集 → 计算 satisfaction_score                │       │
│  │  │  → if satisfaction_score >= threshold: STOP            │       │
│  │  └────────────────────────────────────────────────────────┘       │
│  │  ┌─── Round 2 (if needed) ────────────────────────────────┐       │
│  │  │  LLM 分析 Round 1 结果中的信息缺口                     │       │
│  │  │  → 生成补充 queries → 执行 Lightweight 检索            │       │
│  │  │  → 合并到累积结果集 → 重新计算 satisfaction_score      │       │
│  │  └────────────────────────────────────────────────────────┘       │
│  │  ... (最多 max_rounds 轮)                                         │
│  │                                                                    │
│  ③ Intelligent Fusion (LLM, ~300ms)                                  │
│  │  → LLM 对累积结果集进行语义去重、冲突消解、信息整合                │
│  │  → 输出: 排序后的、语义连贯的结果列表                              │
│  │                                                                    │
│  ④ Reranking + 上下文组装 (同 Lightweight)                            │
│  │                                                                    │
│  总延迟预算: 200 + N×200 + 300 + 80 = ~1000ms (N=1, p95 target)     │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.3 会话提升流程（Session Promotion）

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Session Promotion Flow                             │
│                                                                      │
│  触发条件:                                                            │
│  │  a. 会话显式关闭 (DELETE /sessions/{id})                          │
│  │  b. 空闲超时 (idle_timeout_seconds)                               │
│  │  c. TTL 过期 (session_ttl_seconds)                                │
│  │                                                                    │
│  ① 会话快照序列化                                                     │
│  │  → 从 Redis 读取完整会话数据                                       │
│  │  → 序列化为 SessionArchive 消息                                    │
│  │  → 发送到 Kafka topic: ams.session.archive                        │
│  │                                                                    │
│  ② 提升评估 (Pipeline Worker 消费)                                    │
│  │  → 评估维度:                                                       │
│  │    a. 信息密度: Agent 输出 token 数 / 总 token 数                  │
│  │    b. 任务完成度: 是否有成功的工具调用链                            │
│  │    c. 用户满意度: 是否有正向反馈信号                                │
│  │    d. 新颖性: 与已有记忆的语义距离                                  │
│  │  → promotion_score = weighted_sum(a, b, c, d)                     │
│  │  → if promotion_score < threshold: DISCARD                        │
│  │                                                                    │
│  ③ 记忆提取与分类                                                     │
│  │  → LLM 从会话内容中提取值得记忆的信息                              │
│  │  → 分类为 semantic (fact/episode) 或 procedural (workflow/pattern) │
│  │  → 生成 title + summary + tags                                    │
│  │                                                                    │
│  ④ 写入长期记忆                                                       │
│  │  → 创建 memory_record (PG)                                        │
│  │  → 发送到 Pipeline: ams.pipeline.ingestion                        │
│  │  → Pipeline Workers 执行 Tree/Graph Construction                  │
│  │                                                                    │
│  ⑤ 更新会话元数据                                                     │
│  │  → sessions.status = 'promoted'                                   │
│  │  → sessions.promotion_score = score                               │
│  │  → sessions.promoted_memories = [memory_ids]                      │
│  │                                                                    │
│  ⑥ 清理 Redis                                                        │
│  │  → 删除所有 wm:{tenant_id}:{session_id}:* 键                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.4 衰减引擎流程（Decay Engine）

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Decay Engine Flow                               │
│  (定时任务: 每日 UTC 06:00 执行)                                      │
│                                                                      │
│  ① 扫描所有 active 状态的 memory_records                              │
│  │  → 批量查询: WHERE status = 'active'                              │
│  │  → 分批处理 (batch_size = 1000)                                   │
│  │                                                                    │
│  ② 计算新的衰减权重                                                   │
│  │  → 基础衰减:                                                       │
│  │    w_base(t) = e^(-λ × days_since_creation)                       │
│  │                                                                    │
│  │  → 访问频率提升:                                                    │
│  │    w_access = min(1.0, access_count × boost_factor)               │
│  │                                                                    │
│  │  → 重要性保护:                                                      │
│  │    w_importance = importance^0.5  (高重要性记忆衰减更慢)            │
│  │                                                                    │
│  │  → 最终权重:                                                        │
│  │    decay_weight = min(1.0, w_base × (1 + w_access) × w_importance)│
│  │                                                                    │
│  ③ 状态转换                                                           │
│  │  → if decay_weight < min_weight (0.05):                           │
│  │       status: active → decayed                                    │
│  │  → if decay_weight < archive_threshold (0.01):                    │
│  │       status: decayed → archived                                  │
│  │       → 从 Milvus/ES 中移除索引（保留 Neo4j/PG 数据）             │
│  │                                                                    │
│  ④ Temporal Invalidation 检查                                         │
│  │  → 扫描 expires_at IS NOT NULL AND expires_at < now()             │
│  │  → 直接标记为 archived，无论 decay_weight                          │
│  │                                                                    │
│  ⑤ 批量更新                                                           │
│  │  → PG: UPDATE memory_records SET decay_weight, status, updated_at │
│  │  → Milvus: UPDATE decay_weight field                              │
│  │  → ES: UPDATE decay_weight field                                  │
│  │  → 写入审计日志                                                    │
│  │                                                                    │
│  ⑥ 指标上报                                                           │
│  │  → Prometheus: ams_decay_memories_processed_total                 │
│  │  → Prometheus: ams_decay_status_transitions{from,to}              │
│  │  → Prometheus: ams_decay_execution_duration_seconds               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Kafka Topic 设计

### 6.1 Topic 清单

| **Topic** | **Producer** | **Consumer** | **分区数** | **副本数** | **保留期** | **说明** |
|---|---|---|---|---|---|---|
| `ams.trace.ingested` | Agent-TES | AMS (Router) | 12 | 3 | 7d | TES 采集的原始遥测数据 |
| `ams.session.archive` | AMS (Session Mgr) | Pipeline Workers | 6 | 3 | 3d | 会话归档快照 |
| `ams.pipeline.ingestion` | AMS (Router) | Pipeline Workers | 12 | 3 | 3d | 待处理的摄入任务 |
| `ams.pipeline.transform` | Pipeline Workers | Pipeline Workers | 12 | 3 | 3d | 转换阶段输出 |
| `ams.pipeline.structure` | Pipeline Workers | Pipeline Workers | 12 | 3 | 3d | 结构化阶段输出 |
| `ams.pipeline.indexing` | Pipeline Workers | Pipeline Workers | 12 | 3 | 3d | 索引阶段输出 |
| `ams.pipeline.dlq` | Pipeline Workers | Ops Team | 3 | 3 | 30d | 死信队列 |
| `ams.memory.events` | AMS | Skill-MDS / Analytics | 6 | 3 | 7d | 记忆生命周期事件 |
| `ams.feedback` | AMS | Analytics Workers | 3 | 3 | 30d | 检索质量反馈 |

### 6.2 关键消息 Schema（Avro）

```json
// ams.session.archive 消息 Schema
{
  "type": "record",
  "name": "SessionArchive",
  "namespace": "ams.v1",
  "fields": [
    { "name": "session_id", "type": "string" },
    { "name": "agent_id", "type": "string" },
    { "name": "tenant_id", "type": "string" },
    { "name": "user_id", "type": ["null", "string"], "default": null },
    { "name": "turn_count", "type": "int" },
    { "name": "total_tokens", "type": "long" },
    { "name": "messages", "type": {
        "type": "array",
        "items": {
          "type": "record",
          "name": "ArchivedMessage",
          "fields": [
            { "name": "message_id", "type": "string" },
            { "name": "role", "type": "string" },
            { "name": "content", "type": "string" },
            { "name": "tool_calls", "type": ["null", "string"], "default": null },
            { "name": "token_count", "type": "int" },
            { "name": "timestamp", "type": "long" }
          ]
        }
      }
    },
    { "name": "reflections", "type": {
        "type": "array",
        "items": "string"
      },
      "default": []
    },
    { "name": "task_summary", "type": ["null", "string"], "default": null },
    { "name": "memory_refs", "type": {
        "type": "array",
        "items": "string"
      },
      "default": []
    },
    { "name": "created_at", "type": "long" },
    { "name": "closed_at", "type": "long" },
    { "name": "close_reason", "type": "string" }
  ]
}
```

```json
// ams.memory.events 消息 Schema
{
  "type": "record",
  "name": "MemoryEvent",
  "namespace": "ams.v1",
  "fields": [
    { "name": "event_id", "type": "string" },
    { "name": "event_type", "type": "string" },
    { "name": "memory_id", "type": "string" },
    { "name": "agent_id", "type": "string" },
    { "name": "tenant_id", "type": "string" },
    { "name": "memory_type", "type": "string" },
    { "name": "old_status", "type": ["null", "string"], "default": null },
    { "name": "new_status", "type": "string" },
    { "name": "details", "type": ["null", "string"], "default": null },
    { "name": "timestamp", "type": "long" }
  ]
}
```

---

## 7. 配置管理

### 7.1 分层配置体系

AMS 采用三层配置覆盖机制：**系统默认 → 租户级覆盖 → Agent 级覆盖**。

```yaml
# ═══════════════════════════════════════════════════════════
# AMS 系统默认配置 (config/ams-default.yaml)
# ═══════════════════════════════════════════════════════════

server:
  http_port: 8080
  grpc_port: 9090
  ws_port: 8081
  max_request_size_kb: 512
  request_timeout_ms: 5000
  graceful_shutdown_seconds: 30

working_memory:
  redis:
    cluster_nodes: "redis-0:6379,redis-1:6379,redis-2:6379"
    password_secret: "ams-redis-password"          # K8s Secret 引用
    max_connections_per_node: 50
    command_timeout_ms: 100
    connection_timeout_ms: 500
  session:
    default_ttl_seconds: 7200
    idle_timeout_seconds: 1800
    max_turns: 50
    max_message_size_kb: 32
    max_tool_stream_length: 200
    max_reflection_count: 20

long_term_memory:
  promotion:
    enabled: true
    threshold: 0.6
    evaluation_dimensions:
      information_density_weight: 0.3
      task_completion_weight: 0.3
      user_satisfaction_weight: 0.2
      novelty_weight: 0.2
  decay:
    enabled: true
    schedule_cron: "0 6 * * *"                     # 每日 UTC 06:00
    lambda: 0.001
    min_weight: 0.05
    archive_threshold: 0.01
    access_boost_enabled: true
    access_boost_factor: 0.1
    batch_size: 1000

retrieval:
  default_mode: "lightweight"
  max_results: 20
  min_relevance: 0.3
  timeout_ms: 3000
  lightweight:
    channels:
      bm25:   { enabled: true, weight: 0.2, top_k: 50 }
      vector: { enabled: true, weight: 0.4, top_k: 50, ef_search: 128 }
      tree:   { enabled: true, weight: 0.2, top_k: 30, max_depth: 3 }
      graph:  { enabled: true, weight: 0.2, top_k: 30, max_hops: 2, use_ppr: true }
    fusion: "rrf"
    rrf_k: 60
    score_weights:
      importance_alpha: 0.3
      decay_beta: 0.2
  agentic:
    query_expansion_model: "gpt-4o-mini"
    max_expansion_queries: 3
    max_rounds: 3
    round_stop_threshold: 0.85
    intelligent_fusion: true
  reranking:
    enabled: true
    model: "bge-reranker-v2-m3"
    top_k: 10

storage:
  neo4j:
    uri: "bolt://neo4j-0:7687"
    username: "neo4j"
    password_secret: "ams-neo4j-password"
    max_connection_pool_size: 100
    connection_timeout_ms: 5000
    max_transaction_retry: 3
  milvus:
    host: "milvus-proxy:19530"
    max_connections: 50
    timeout_ms: 3000
  elasticsearch:
    hosts: ["http://es-0:9200", "http://es-1:9200", "http://es-2:9200"]
    username: "elastic"
    password_secret: "ams-es-password"
    max_connections: 50
    request_timeout_ms: 3000
  postgresql:
    host: "pg-primary:5432"
    database: "ams"
    username: "ams_app"
    password_secret: "ams-pg-password"
    max_pool_size: 30
    min_pool_size: 5
    connection_timeout_ms: 3000

kafka:
  bootstrap_servers: "kafka-0:9092,kafka-1:9092,kafka-2:9092"
  producer:
    acks: "all"
    retries: 3
    batch_size_bytes: 16384
    linger_ms: 10
    compression: "lz4"
  consumer:
    group_id_prefix: "ams"
    auto_offset_reset: "earliest"
    max_poll_records: 100
    session_timeout_ms: 30000

llm:
  embedding:
    provider: "openai"                             # "openai" | "azure" | "local"
    model: "text-embedding-3-small"
    dimension: 1536
    batch_size: 64
    timeout_ms: 5000
    max_retries: 2
  chat:
    provider: "openai"
    model: "gpt-4o-mini"
    timeout_ms: 30000
    max_retries: 1
  reranker:
    provider: "local"                              # 本地部署的 reranker
    model: "bge-reranker-v2-m3"
    endpoint: "http://reranker-svc:8080/rerank"
    timeout_ms: 3000

observability:
  metrics:
    enabled: true
    port: 9090
    path: "/metrics"
  tracing:
    enabled: true
    exporter: "otlp"
    endpoint: "otel-collector:4317"
    sample_rate: 0.1
  logging:
    level: "info"                                  # "debug" | "info" | "warn" | "error"
    format: "json"
    output: "stdout"

rate_limiting:
  enabled: true
  default_qps: 100                                 # 每租户默认 QPS
  burst: 150
  strategy: "sliding_window"

auth:
  jwt:
    issuer: "ams-auth"
    audience: "ams-api"
    public_key_path: "/etc/ams/jwt-public.pem"
    token_expiry_seconds: 3600
  api_key:
    enabled: true
    header: "X-API-Key"

```

### 7.2 配置覆盖优先级

```
系统默认 (ams-default.yaml)
    ↓ 被覆盖
租户级配置 (tenants.config JSONB)
    ↓ 被覆盖
Agent 级配置 (agents.memory_config JSONB)
    ↓ 被覆盖
请求级参数 (API Request Body)
```

**合并策略**：深度合并（deep merge），下层配置的同名字段覆盖上层，未指定的字段继承上层默认值。

**示例**：租户设置了 `retrieval.default_mode = "agentic"`，则该租户下所有 Agent 的默认检索模式为 Agentic，除非 Agent 级配置或请求级参数显式覆盖。

### 7.3 动态配置热更新

| **配置类别** | **更新方式** | **生效延迟** | **是否需要重启** |
|---|---|---|---|
| 服务器端口、存储连接串 | ConfigMap 更新 + Pod 滚动重启 | ~60s | ✅ 是 |
| 检索参数、衰减参数 | PG 配置表 + 内存缓存（30s TTL） | < 30s | ❌ 否 |
| 租户/Agent 级配置 | API 更新 + 缓存失效 | < 5s | ❌ 否 |
| 速率限制、特性开关 | Redis 配置键 + 实时读取 | < 1s | ❌ 否 |

---

## 8. 错误处理与容错设计

### 8.1 错误码体系

AMS 采用**结构化错误码**，格式为 `E{模块}{序号}`：

| **错误码** | **HTTP Status** | **含义** | **处理建议** |
|---|---|---|---|
| **E1001** | 400 | 数据源映射规则违反 | 检查 source_type 与 structures 的合法组合 |
| **E1002** | 400 | 无效的记忆类型 | 检查 memory_type 枚举值 |
| **E1003** | 400 | 查询文本为空或超长 | 限制 1~2000 字符 |
| **E2001** | 404 | 会话不存在或已过期 | 创建新会话 |
| **E2002** | 409 | 会话已关闭 | 创建新会话 |
| **E2003** | 409 | 会话并发写入冲突 | 客户端重试（带 backoff） |
| **E3001** | 404 | 记忆记录不存在 | 检查 memory_id |
| **E3002** | 404 | Agent 不存在 | 检查 agent_id |
| **E4001** | 408 | 检索超时 | 缩小检索范围或切换到 lightweight 模式 |
| **E4002** | 503 | 存储引擎不可用 | 系统自动降级，稍后重试 |
| **E4003** | 503 | LLM 服务不可用 | Agentic 模式自动降级为 Lightweight |
| **E5001** | 429 | 速率限制 | 降低请求频率或升级配额 |
| **E5002** | 403 | 存储配额超限 | 清理过期记忆或升级配额 |
| **E9001** | 500 | 内部错误 | 联系运维团队 |

**统一错误响应格式**：

```json
{
  "error": {
    "code": "E4001",
    "message": "Retrieval timeout: operation exceeded 3000ms limit",
    "details": {
      "timeout_ms": 3000,
      "channels_completed": ["bm25", "vector"],
      "channels_timeout": ["graph"],
      "partial_results_available": true
    },
    "request_id": "req_abc123",
    "timestamp": "2026-03-25T18:00:00.000Z"
  }
}
```

### 8.2 降级策略

AMS 实现了多层级的优雅降级，确保核心功能在部分组件故障时仍可用：

| **故障场景** | **影响范围** | **降级策略** | **用户感知** |
|---|---|---|---|
| **Milvus 不可用** | 向量检索通道失效 | 自动禁用 vector channel，BM25 + Tree + Graph 三路召回 | 检索质量略降，延迟不变 |
| **Elasticsearch 不可用** | BM25 通道失效 | 自动禁用 bm25 channel，Vector + Tree + Graph 三路召回 | 关键词精确匹配能力下降 |
| **Neo4j 不可用** | Tree + Graph 通道失效 | 自动禁用 tree/graph channel，仅 BM25 + Vector 双路召回 | 多跳推理和层级导航不可用 |
| **LLM Service 不可用** | Embedding 生成 + Agentic 模式失效 | 新数据暂缓索引（Kafka 缓冲）；Agentic 自动降级为 Lightweight | 新记忆延迟入库；复杂查询质量下降 |
| **Redis 不可用** | Working Memory 完全失效 | 返回 E4002，Agent Framework 应切换到无状态模式 | 会话上下文丢失 |
| **Kafka 不可用** | 异步管道中断 | 同步写入 PG 作为 fallback，Pipeline 任务积压 | 新记忆入库延迟增大 |
| **PostgreSQL 不可用** | 元数据层失效 | 从 Redis 缓存读取 Agent/Tenant 配置（30s 缓存） | 新建 Agent/Session 不可用 |

### 8.3 重试与熔断

```yaml
# 重试策略
retry:
  redis:
    max_retries: 2
    backoff: "exponential"          # 50ms → 100ms
    max_backoff_ms: 200
  neo4j:
    max_retries: 3
    backoff: "exponential"          # 100ms → 200ms → 400ms
    max_backoff_ms: 500
  milvus:
    max_retries: 2
    backoff: "exponential"
    max_backoff_ms: 300
  elasticsearch:
    max_retries: 2
    backoff: "exponential"
    max_backoff_ms: 300
  llm:
    max_retries: 2
    backoff: "exponential"          # 500ms → 1000ms
    max_backoff_ms: 2000

# 熔断策略 (基于 Resilience4j / 类似库)
circuit_breaker:
  redis:
    failure_rate_threshold: 50      # 50% 失败率触发熔断
    slow_call_rate_threshold: 80    # 80% 慢调用触发熔断
    slow_call_duration_ms: 200
    wait_duration_open_ms: 10000    # 熔断开启后 10s 尝试半开
    permitted_calls_half_open: 5
    sliding_window_size: 20
  neo4j:
    failure_rate_threshold: 50
    slow_call_duration_ms: 1000
    wait_duration_open_ms: 15000
    sliding_window_size: 20
  milvus:
    failure_rate_threshold: 50
    slow_call_duration_ms: 500
    wait_duration_open_ms: 10000
    sliding_window_size: 20
  llm:
    failure_rate_threshold: 30      # LLM 更敏感，30% 即熔断
    slow_call_duration_ms: 10000
    wait_duration_open_ms: 30000    # LLM 恢复较慢，等待 30s
    sliding_window_size: 10
```

---

## 9. 可观测性设计

### 9.1 Prometheus 指标

```
# ═══════════════════════════════════════════════════════════
# AMS Prometheus Metrics
# ═══════════════════════════════════════════════════════════

# ─── API 层指标 ───
ams_http_requests_total{method, path, status_code, tenant_id}           counter
ams_http_request_duration_seconds{method, path, tenant_id}              histogram  (buckets: 10ms,50ms,100ms,200ms,500ms,1s,3s,5s)
ams_grpc_requests_total{method, status, tenant_id}                      counter
ams_grpc_request_duration_seconds{method, tenant_id}                    histogram
ams_active_websocket_connections{tenant_id}                             gauge

# ─── Working Memory 指标 ───
ams_wm_sessions_active{tenant_id, agent_id}                            gauge
ams_wm_sessions_created_total{tenant_id}                               counter
ams_wm_sessions_closed_total{tenant_id, close_reason}                  counter      # close_reason: explicit/idle/ttl
ams_wm_redis_command_duration_seconds{command, tenant_id}              histogram
ams_wm_messages_appended_total{tenant_id, role}                        counter
ams_wm_context_window_utilization{tenant_id, agent_id}                 histogram    # 上下文窗口利用率分布

# ─── Retrieval 指标 ───
ams_retrieval_requests_total{mode, tenant_id}                          counter      # mode: lightweight/agentic
ams_retrieval_duration_seconds{mode, tenant_id}                        histogram
ams_retrieval_channel_duration_seconds{channel, tenant_id}             histogram    # channel: bm25/vector/tree/graph
ams_retrieval_channel_candidates{channel, tenant_id}                   histogram    # 各通道召回数量
ams_retrieval_results_returned{mode, tenant_id}                        histogram
ams_retrieval_relevance_score{mode, tenant_id}                         histogram    # 结果相关性分布
ams_retrieval_reranking_duration_seconds{tenant_id}                    histogram
ams_retrieval_degraded_total{failed_channel, tenant_id}                counter      # 降级次数

# ─── Agentic Mode 特有指标 ───
ams_agentic_rounds_total{tenant_id}                                    histogram    # 迭代轮数分布
ams_agentic_expansion_queries{tenant_id}                               histogram    # 扩展查询数
ams_agentic_satisfaction_score{tenant_id}                              histogram

# ─── Pipeline 指标 ───
ams_pipeline_jobs_total{job_type, status}                              counter      # status: queued/processing/completed/failed
ams_pipeline_job_duration_seconds{job_type, stage}                     histogram
ams_pipeline_kafka_lag{topic, consumer_group}                          gauge        # Kafka 消费积压

# ─── Promotion 指标 ───
ams_promotion_evaluated_total{tenant_id}                               counter
ams_promotion_promoted_total{tenant_id, memory_type}                   counter
ams_promotion_discarded_total{tenant_id}                               counter
ams_promotion_score{tenant_id}                                         histogram

# ─── Lifecycle 指标 ───
ams_decay_memories_processed_total                                     counter
ams_decay_status_transitions_total{from_status, to_status}             counter
ams_decay_execution_duration_seconds                                   histogram
ams_memories_total{tenant_id, memory_type, status}                     gauge        # 各类型各状态的记忆总数

# ─── Storage 健康指标 ───
ams_storage_health{engine}                                             gauge        # 0=down, 1=degraded, 2=healthy
ams_circuit_breaker_state{engine}                                      gauge        # 0=closed, 1=half_open, 2=open

# ─── Feedback 指标 ───
ams_feedback_total{relevance, usefulness, tenant_id}                   counter
ams_feedback_positive_rate{tenant_id}                                  gauge        # 滚动 7 天正向反馈率
```

### 9.2 关键告警规则

```yaml
# Prometheus AlertManager Rules
groups:
  - name: ams-critical
    rules:
      - alert: AMSRetrievalLatencyHigh
        expr: histogram_quantile(0.95, rate(ams_retrieval_duration_seconds_bucket[5m])) > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "AMS 检索 p95 延迟超过 300ms"

      - alert: AMSRetrievalLatencyCritical
        expr: histogram_quantile(0.99, rate(ams_retrieval_duration_seconds_bucket[5m])) > 1.0
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "AMS 检索 p99 延迟超过 1s"

      - alert: AMSStorageDown
        expr: ams_storage_health == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "存储引擎 {{ $labels.engine }} 不可用"

      - alert: AMSCircuitBreakerOpen
        expr: ams_circuit_breaker_state == 2
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.engine }} 熔断器已开启"

      - alert: AMSKafkaLagHigh
        expr: ams_pipeline_kafka_lag > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Kafka topic {{ $labels.topic }} 积压超过 10K"

      - alert: AMSPipelineFailureRateHigh
        expr: rate(ams_pipeline_jobs_total{status="failed"}[10m]) / rate(ams_pipeline_jobs_total[10m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pipeline 失败率超过 10%"

      - alert: AMSRedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis 内存使用率超过 85%"

      - alert: AMSFeedbackQualityDrop
        expr: ams_feedback_positive_rate < 0.6
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "检索质量正向反馈率低于 60%"
```

### 9.3 分布式追踪

AMS 的每个请求都会生成完整的 OpenTelemetry Trace，包含以下关键 Span：

```
Trace: ams.retrieve (request_id=req_abc123)
│
├── Span: ams.auth.validate (2ms)
├── Span: ams.config.resolve (1ms)                    # 配置合并
├── Span: ams.query.preprocess (8ms)
│   ├── Span: llm.embedding.generate (6ms)            # Embedding 生成
│   └── Span: ams.query.tokenize (1ms)
│
├── Span: ams.retrieval.parallel_channels (75ms)       # 并行召回
│   ├── Span: ams.channel.bm25 (12ms)
│   │   └── Span: elasticsearch.search (10ms)
│   ├── Span: ams.channel.vector (28ms)
│   │   └── Span: milvus.search (25ms)
│   ├── Span: ams.channel.tree (35ms)
│   │   └── Span: neo4j.query (32ms)
│   └── Span: ams.channel.graph (42ms)
│       └── Span: neo4j.query.ppr (40ms)
│
├── Span: ams.fusion.rrf (5ms)
├── Span: ams.reranking (60ms)
│   └── Span: reranker.predict (55ms)
├── Span: ams.context.assemble (15ms)
│   ├── Span: neo4j.fetch_tree_path (8ms)
│   └── Span: neo4j.fetch_graph_context (6ms)
│
└── Span: ams.async.post_process                       # 异步，不阻塞响应
    ├── Span: pg.update_access_count
    └── Span: pg.write_audit_log
```

---

## 10. 安全设计

### 10.1 认证与授权

| **层级** | **机制** | **说明** |
|---|---|---|
| **API 认证** | JWT Bearer Token / API Key | 所有外部请求必须携带有效凭证 |
| **服务间认证** | mTLS | AMS 与 Pipeline Workers、Skill-MDS 之间的 gRPC 通信 |
| **存储认证** | 密码/证书（K8s Secret） | 所有存储引擎连接使用独立的服务账号 |

**JWT Token 结构**：

```json
{
  "sub": "user_12345",
  "iss": "ams-auth",
  "aud": "ams-api",
  "tenant_id": "tenant_001",
  "roles": ["agent_admin", "memory_read", "memory_write"],
  "exp": 1711363600,
  "iat": 1711360000
}
```

### 10.2 多租户数据隔离

| **存储引擎** | **隔离机制** | **说明** |
|---|---|---|
| **PostgreSQL** | `tenant_id` 字段 + RLS（Row Level Security） | 所有表强制 tenant_id 过滤 |
| **Redis** | Key 前缀 `wm:{tenant_id}:` | 命名空间隔离 |
| **Neo4j** | `tenant_id` 属性 + 查询时强制过滤 | 所有 Cypher 查询注入 tenant_id 条件 |
| **Milvus** | Partition Key = `tenant_id` | 分区级隔离，查询时指定 partition |
| **Elasticsearch** | Index alias + 过滤 | `ams_blocks_{tenant_id}` 或 filtered alias |
| **Kafka** | 消息体内 `tenant_id` 字段 | Consumer 端过滤 |

**PostgreSQL RLS 示例**：

```sql
-- 启用 RLS
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;

-- 创建策略：只能访问本租户数据
CREATE POLICY tenant_isolation ON memory_records
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- AMS 在每个数据库连接上设置租户上下文
SET app.current_tenant_id = '{tenant_id}';
```

### 10.3 数据加密

| **场景** | **加密方式** | **说明** |
|---|---|---|
| 传输中 | TLS 1.3 | 所有外部和内部通信 |
| 静态存储 | AES-256-GCM（磁盘级） | 通过 K8s StorageClass 的加密卷实现 |
| 敏感字段 | 应用层加密（可选） | 对 PII 字段（如 user_id 关联的内容）进行应用层加密 |

---

## 11. 性能基准与容量规划

### 11.1 性能 SLA

| **操作** | **p50** | **p95** | **p99** | **目标 QPS** |
|---|---|---|---|---|
| WM 消息追加 | 8ms | 25ms | 50ms | 5,000 |
| WM 会话读取 | 5ms | 15ms | 30ms | 10,000 |
| LTM 检索（Lightweight） | 80ms | 180ms | 300ms | 1,000 |
| LTM 检索（Agentic） | 500ms | 1,200ms | 3,000ms | 200 |
| 记忆存储（异步） | — | — | — | 500 |
| 数据摄入（异步） | — | — | — | 100 jobs/min |

### 11.2 容量估算模型

**假设基准**：1000 个活跃 Agent，每个 Agent 平均 5 个并发会话，每天产生 100 条新的长期记忆。

| **资源** | **计算公式** | **估算值** |
|---|---|---|
| **Redis 内存** | 1000 agents × 5 sessions × 50 turns × 2KB/turn | ~500 MB（远低于 48GB 容量） |
| **PG 行数** | 1000 agents × 100 memories/day × 365 days | ~36.5M rows/year |
| **Milvus 向量数** | 36.5M memories × avg 10 blocks/memory | ~365M vectors/year |
| **Neo4j 节点数** | 36.5M memories × avg 15 nodes/memory | ~547M nodes/year |
| **Neo4j 边数** | 547M nodes × avg 3 edges/node | ~1.6B edges/year |
| **ES 文档数** | 同 Milvus 向量数 | ~365M docs/year |
| **Kafka 吞吐** | 5000 sessions × 10 msgs/min × 2KB | ~100 MB/min |

### 11.3 水平扩展策略

| **组件** | **扩展维度** | **扩展触发条件** | **扩展方式** |
|---|---|---|---|
| **AMS API** | 无状态，水平扩展 | CPU > 70% 或 QPS > 阈值 | K8s HPA (2→10 pods) |
| **Pipeline Workers** | 无状态，水平扩展 | Kafka lag > 5000 | K8s HPA (2→20 pods) |
| **Redis** | 分片扩展 | 内存 > 70% | 在线 resharding（添加新主节点） |
| **Neo4j** | 读副本扩展 | 查询延迟 p95 > 500ms | 添加 Read Replica |
| **Milvus** | 分片 + 副本 | 向量数 > 100M/collection | 增加 Shard 数或 Query Node |
| **Elasticsearch** | 分片扩展 | 磁盘 > 75% | 添加数据节点 + reindex |

---

## 12. 技术栈总览

| **层级** | **技术选型** | **版本** | **用途** |
|---|---|---|---|
| **语言** | Go | 1.22+ | AMS 核心服务（高并发、低延迟） |
| **语言** | Python | 3.11+ | Pipeline Workers（LLM 调用、NLP 处理） |
| **API 框架** | Go: Gin + gRPC-Go | — | REST + gRPC 双协议 |
| **Working Memory** | Redis Stack | 7.2+ | 会话状态、对话历史 |
| **Graph Storage** | Neo4j | 5.x | 知识图谱、Tree 层级 |
| **Vector Storage** | Milvus | 2.4+ | 向量检索 |
| **Full-text** | Elasticsearch | 8.x | BM25 全文检索 |
| **Metadata** | PostgreSQL | 16+ | 元数据、配置、审计 |
| **Message Queue** | Apache Kafka | 3.7+ | 异步管道、事件流 |
| **LLM** | OpenAI / Azure OpenAI | — | Embedding、Query Expansion、Reranking |
| **容器编排** | Kubernetes | 1.28+ | 部署、扩缩容、服务发现 |
| **可观测性** | Prometheus + Grafana + Jaeger | — | 指标、告警、追踪 |
| **CI/CD** | GitHub Actions + ArgoCD | — | 持续集成、GitOps 部署 |

---

## 13. 模块依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                    AMS 模块依赖图                            │
│                                                             │
│  ┌──────────────┐                                           │
│  │ 02-Agent     │──────────────────┐                        │
│  │ Framework    │                  │                        │
│  └──────┬───────┘                  │                        │
│         │ depends on               │ depends on             │
│         ▼                          ▼                        │
│  ┌──────────────┐          ┌──────────────┐                 │
│  │ 07-API       │─────────→│ 01-AMS Core  │←──────────┐    │
│  │ Design       │          │ (本文档)      │           │    │
│  └──────────────┘          └──────┬───────┘           │    │
│                                   │                    │    │
│                    ┌──────────────┼──────────────┐     │    │
│                    │              │              │     │    │
│                    ▼              ▼              ▼     │    │
│             ┌───────────┐ ┌───────────┐ ┌──────────┐  │    │
│             │ 03-Memory │ │ 04-Storage│ │ 09-Schema│  │    │
│             │ Pipeline  │ │ Retrieval │ │          │  │    │
│             └───────────┘ └───────────┘ └──────────┘  │    │
│                                                        │    │
│  ┌──────────────┐  ┌──────────────┐                    │    │
│  │ 06-Agent-TES │──┘              │                    │    │
│  └──────────────┘  │ 05-Skill-MDS │────────────────────┘    │
│                    └──────────────┘                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ 08-Multi     │  │ 10-Deploy    │  │ 11-Testing   │      │
│  │ Agent        │  │              │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  (依赖 01)          (依赖 all)        (依赖 all)            │
└─────────────────────────────────────────────────────────────┘
```

---

## 14. 开放问题与后续迭代

| **编号** | **问题** | **影响模块** | **建议处理时间** |
|---|---|---|---|
| **OI-001** | Metacognitive Memory 的具体存储模型尚未细化——是独立 Collection 还是附着于其他记忆的元数据？ | 01, 09 | 03-Pipeline 详设时确定 |
| **OI-002** | Graph Construction 的 "full three-layer" 第三层（Temporal KG）的精确 Schema 待定义 | 03, 09 | 03-Pipeline 详设时确定 |
| **OI-003** | Agentic Mode 的 "satisfaction_score" 计算方法需要实验验证 | 01, 04 | 04-Retrieval 详设时确定 |
| **OI-004** | 多 Agent 场景下的记忆可见性控制（Private/Shared/Hierarchical）的 ACL 模型 | 01, 08 | 08-Multi-Agent 详设时确定 |
| **OI-005** | LanceDB 是否作为 Milvus 的补充/替代方案引入 Memory Lake 架构 | 04, 09 | 04-Storage 详设时评估 |
| **OI-006** | Reranker 模型的本地部署 vs API 调用的成本/延迟权衡 | 01, 10 | 10-Deployment 详设时确定 |

---

## 附录 A：参考资料

- [1] — [GraphRAG, LightRAG, and AgenticRAG: The Complete Developer's Guide](https://dev.to/superorange0707/the-complete-developers-guide-to-graphrag-lightrag-and-agenticrag-14go)
- [2] — [Letta V1: Lessons from ReAct, MemGPT, & Claude Code](https://www.letta.com/blog/letta-v1-agent)
- [3] — [LightRAG: Simple and Fast Retrieval-Augmented Generation (EMNLP 2025)](https://aclanthology.org/2025.findings-emnlp.568.pdf)
- [4] — [LightRAG GitHub Repository](https://github.com/hkuds/lightrag)
- [5] — [Mem0: AI Memory Layer Guide](https://mem0.ai/blog/ai-memory-layer-guide)

---

以上是 **01-Agent-Memory-System（AMS 核心服务）** 的完整详细设计文档。全文覆盖了：

| **章节** | **内容** | **可指导开发** |
|---|---|---|
| §1 模块定位 | 职责边界、RACI 矩阵 | ✅ 团队分工 |
| §2 系统架构 | 内部架构、上下游交互、协议矩阵 | ✅ 服务骨架搭建 |
| §3 数据模型 | PG/Redis/Neo4j/Milvus/ES 全部 Schema | ✅ DDL 直接执行 |
| §4 API 设计 | REST + gRPC 字段级定义 | ✅ 接口开发 |
| §5 核心流程 | 检索/提升/衰减的完整时序 | ✅ 业务逻辑实现 |
| §6 Kafka 设计 | Topic 清单 + Avro Schema | ✅ 消息中间件搭建 |
| §7 配置管理 | 分层配置 + 热更新 | ✅ 配置框架实现 |
| §8 容错设计 | 错误码 + 降级 + 熔断 | ✅ 可靠性工程 |
| §9 可观测性 | Metrics + Alerts + Tracing | ✅ 监控体系搭建 |
| §10 安全设计 | 认证 + 隔离 + 加密 | ✅ 安全合规 |
| §11 性能基准 | SLA + 容量估算 + 扩展策略 | ✅ 容量规划 |

下一个模块建议进入 **03-Memory-Processing-Pipeline**（记忆处理管线），因为它是 Tree/Graph Construction 的核心实现，直接决定了记忆的质量。