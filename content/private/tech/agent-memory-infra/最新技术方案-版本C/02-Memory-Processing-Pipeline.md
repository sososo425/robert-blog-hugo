---
title: "02-Memory-Processing-Pipeline 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "pipeline", "kafka", "详细设计", "版本C"]
---

# Memory Processing Pipeline 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: 连接原始数据与结构化记忆存储的**异步处理管道集群**，是 AMS 认知飞轮的工厂层。

---
![[Pasted image 20260327135634.png]]
## 1. 模块定位与职责

### 1.1 在系统中的定位

Memory Processing Pipeline（简称 MPP）是一组**独立部署的异步 Python Worker 服务**，通过 Kafka 与 AMS 解耦，专职承担"将原始数据转化为可检索结构化记忆"的重计算工作。

```
Agent Framework ──→ AMS ──→ Kafka: ams.pipeline.* ──→ MPP Workers ──→ Storage Engines
Agent-TES       ──→ Kafka: ams.trace.ingested ──→ MPP Workers      (Neo4j / Milvus / ES / PG)
                                                        ↑
                                                   AMS 通过 Kafka
                                                   下发构建任务
```

**MPP 在系统中处于"工厂层"**：AMS 是记忆的门卫（Gateway），负责接收请求、鉴权、路由；MPP 是工厂（Factory），负责重计算任务——切块、提取实体、生成 Embedding、社区检测、写索引。两者职责清晰分离。

### 1.2 职责边界

**MPP 做什么：**

| 职责 | 说明 |
|---|---|
| **Trace 入库** | 消费 Agent-TES 推送的执行 Trace，评分、提取标签、写入 memory_records，触发 Graph 构建 |
| **Session 归档** | 消费 AMS 推送的会话归档请求，构建 memory 内容，触发 Graph 构建 |
| **Tree Construction** | 将文档内容切块（Chunking）→ Section 层级归属 → 生成摘要 → 写入 Milvus/Neo4j |
| **Graph Construction** | NER 实体抽取 → 关系抽取 → Temporal KG（动态数据）→ Leiden 社区检测 → Community Summary |
| **Indexing** | 将处理完成的记忆写入 Elasticsearch 全文索引，更新记忆最终状态 |

**MPP 不做什么：**

| 排除项 | 归属 |
|---|---|
| 接收 Agent 的 memory I/O 请求 | AMS（01） |
| Working Memory 读写 | AMS（01） |
| 记忆检索与上下文组装 | AMS（01） |
| 遥测数据的采集（Span 生成） | Agent-TES（04） |
| 技能挖掘与管理 | Skill-DOM（05） |
| 直接被 Agent Framework 调用 | 不对外暴露同步 API，纯异步 |

### 1.3 为什么选择异步架构？

选择 Kafka + 异步 Worker 而非 AMS 内部同步处理的三个核心原因：

**① 解耦（Decoupling）**：Agent 的 memory write 请求必须低延迟响应（< 100ms）。Tree/Graph 构建涉及 LLM 调用（~1s/次）、NER（~100ms/chunk）、Milvus 写入等重计算，不能阻塞 AMS 的同步路径。Kafka 作为缓冲层，让 AMS 立即返回 `status: "pending_processing"`，Pipeline 异步完成后更新状态。

**② 弹性扩缩容（Elastic Scaling）**：Pipeline 计算负载与 AMS 请求负载相互独立。文档批量导入时 Pipeline 负载暴增，可独立扩容 Pipeline Worker 副本数，不影响 AMS 的 API 响应能力。

**③ 可重放（Replayability）**：Kafka 的 offset 机制支持历史数据重跑。当 Embedding 模型升级（如从 text-embedding-3-small 升级到新版本）时，可从 `ams.pipeline.structure` topic 的起始 offset 重新消费，重新生成所有向量，不需要重新触发上游。

### 1.4 Pipeline 类型总览

MPP 包含 **5 种 Pipeline**，每种对应不同的 Kafka Topic 和处理逻辑：

| Pipeline | 触发 Topic | 处理对象 | 适用 source_type |
|---|---|---|---|
| **Trace Pipeline** | `ams.trace.ingested` | Agent 执行 Trace | `agent_trace` |
| **Session Archive Pipeline** | `ams.session.archive` | 会话归档请求 | `user_interaction` |
| **Tree Construction Pipeline** | `ams.pipeline.structure`（含 `tree` 标记）| 文档/代码/技能 | `work_document`, `source_code`, `skill_markdown` |
| **Graph Construction Pipeline** | `ams.pipeline.structure`（含 `graph` 标记）| 所有需要图结构的记忆 | 除 `skill_markdown` 外的所有 |
| **Indexing Pipeline** | `ams.pipeline.indexing` | 构建完成的记忆 | 全部 |

---

## 2. 整体架构

### 2.1 Pipeline 总体数据流图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Memory Processing Pipeline                          │
│                                                                          │
│  ┌─────────────┐    ams.trace.ingested                                   │
│  │  Agent-TES  │──────────────────────────┐                             │
│  └─────────────┘                          │                             │
│                                           ▼                             │
│  ┌─────────────┐    ams.session.archive  ┌──────────────────────────┐   │
│  │     AMS     │─────────────────────→  │   Kafka Message Bus       │   │
│  │  (Gateway)  │─→ ams.pipeline.structure│                          │   │
│  │             │─→ ams.pipeline.indexing │  Topics:                 │   │
│  └─────────────┘                        │  · ams.trace.ingested     │   │
│                                         │  · ams.session.archive    │   │
│                                         │  · ams.pipeline.structure │   │
│                                         │  · ams.pipeline.indexing  │   │
│                                         │  · ams.pipeline.dlq       │   │
│                                         └──────────┬───────────────┘   │
│                                                    │                    │
│                    ┌───────────────────────────────┼───────────────┐    │
│                    │                               │               │    │
│                    ▼                               ▼               ▼    │
│  ┌──────────────────────┐   ┌───────────────────────┐  ┌─────────────┐ │
│  │  Trace / Session     │   │  Tree Construction    │  │  Indexing   │ │
│  │  Archive Pipeline    │   │  Pipeline             │  │  Pipeline   │ │
│  │                      │   │                       │  │             │ │
│  │  · 重要性评分(LLM)    │   │  · Chunking           │  │  · ES 写入  │ │
│  │  · 标签提取           │   │  · Section 层级归属   │  │  · 状态更新 │ │
│  │  · Embedding         │   │  · Summary 生成(LLM) │  └──────┬──────┘ │
│  │  · PG memory_records │   │  · Milvus 写入        │         │        │
│  │  · 触发 Graph 构建   │   │  · Neo4j Block/Sec   │         │        │
│  └──────────┬───────────┘   └────────────┬──────────┘         │        │
│             │                            │                     │        │
│             ▼                            │                     │        │
│  ┌──────────────────────┐               │                     │        │
│  │  Graph Construction  │←──────────────┘                     │        │
│  │  Pipeline            │  (work_document/source_code 同时    │        │
│  │                      │   触发 Tree + Graph)                 │        │
│  │  · Two-pass NER      │                                      │        │
│  │  · 关系抽取(LLM)     │                                      │        │
│  │  · Temporal KG       │──────────────────────────────────→  │        │
│  │  · Leiden 社区检测   │   ams.pipeline.indexing              │        │
│  │  · Community Summary │                                      │        │
│  └──────────────────────┘                                      │        │
│                                                                │        │
│  ┌─────────────────────────────────────────────────────────┐   │        │
│  │                  Storage Engines                        │←──┘        │
│  │  PostgreSQL  │  Milvus  │  Neo4j  │  Elasticsearch      │            │
│  └─────────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 source_type 路由矩阵

这是版本C最核心的设计约束——**数据源决定了走哪些 Pipeline**：

| source_type | Trace/Session Pipeline | Tree Pipeline | Graph Pipeline | Graph layer_mode | Indexing Pipeline |
|---|:---:|:---:|:---:|---|:---:|
| `user_interaction` | ✅ Session Archive | ❌ | ✅ | `full_three_layer` | ✅ |
| `agent_trace` | ✅ Trace | ❌ | ✅ | `full_three_layer` | ✅ |
| `work_document` | ❌（直接走 AMS ingest API）| ✅ | ✅ | `double_layer` | ✅ |
| `source_code` | ❌（直接走 AMS ingest API）| ✅ | ✅ | `double_layer` | ✅ |
| `skill_markdown` | ❌（直接走 AMS ingest API）| ✅ | ❌ | N/A | ✅ |

> **full_three_layer vs double_layer 说明**：
> - `full_three_layer`：Phrase Node → Community Node → **Temporal KG（时序知识图谱）**。适用于动态数据（交互/轨迹），捕获时序关系，支持"上周 Agent 是怎么处理这个问题的"这类时序回溯查询。
> - `double_layer`：Phrase Node → Community Node。适用于静态文档，无时序语义，不构建 Temporal KG。

### 2.3 Pipeline 4 阶段划分

MPP 内部将处理过程分为 4 个逻辑阶段，每个阶段通过独立的 Kafka Topic 串联，支持断点续传和分阶段重放：

```
[Ingestion]          [Transform]            [Structure]           [Indexing]
AMS 写入 PG    →    内容预处理             Tree / Graph 构建    →  ES 全文索引
memory_records       (NLP 清洗、分块)       (LLM 重计算密集)       状态置 active
status=pending       标签/摘要提取

Kafka: ams.pipeline.ingestion → ams.pipeline.transform → ams.pipeline.structure → ams.pipeline.indexing
```

> **注意**：Trace Pipeline 和 Session Archive Pipeline 跳过前两个阶段，直接从自己的 Topic 消费并写入 PG，然后发布到 `ams.pipeline.structure` 触发后续阶段。

### 2.4 Pipeline Worker 并发模型

```
Kafka Topic: ams.pipeline.structure
  Partitions: 12

Consumer Group: ams-pipeline-workers
  Pod 1: Partitions 0-3  (4 个分区)
  Pod 2: Partitions 4-7  (4 个分区)
  Pod 3: Partitions 8-11 (4 个分区)

每个 Pod 内部：
  asyncio event loop
  ├── max 8 个并发 LLM 调用 (Semaphore)
  ├── max 16 个并发 Milvus 写入 (Semaphore)
  └── max 4 个并发 Neo4j 写入 (Neo4j 连接池上限)

分区键规则（保证顺序性）：
  ams.trace.ingested:      partition_key = session_id   (同会话 Trace 顺序处理)
  ams.session.archive:     partition_key = agent_id     (同 Agent 归档串行执行)
  ams.pipeline.structure:  partition_key = memory_id    (同记忆多阶段顺序执行)
  ams.pipeline.indexing:   partition_key = memory_id
```

---

## 3. Kafka Topic 设计

### 3.1 Topic 规范表

| Topic | 分区数 | 分区键 | 保留时间 | 生产方 | 消费方 | 格式 |
|---|:---:|---|:---:|---|---|---|
| `ams.trace.ingested` | 12 | `session_id` | 7天 | Agent-TES | Trace Pipeline | JSON |
| `ams.session.archive` | 12 | `agent_id` | 7天 | AMS | Session Archive Pipeline | JSON |
| `ams.pipeline.ingestion` | 12 | `memory_id` | 3天 | AMS（ingest API）| Ingestion Worker | JSON |
| `ams.pipeline.transform` | 12 | `memory_id` | 3天 | Ingestion Worker | Transform Worker | JSON |
| `ams.pipeline.structure` | 12 | `memory_id` | 3天 | Transform Worker / Trace Pipeline / Session Pipeline | Tree Worker & Graph Worker | JSON |
| `ams.pipeline.indexing` | 12 | `memory_id` | 3天 | Tree Worker / Graph Worker | Indexing Worker | JSON |
| `ams.pipeline.dlq` | 6 | `original_topic` | 30天 | 所有 Pipeline（失败时） | 运维告警 / 手动重放 | JSON |

### 3.2 消息 Schema

#### ams.trace.ingested（Agent-TES 生产）

```json
{
  "message_id": "msg_uuid_001",           // 幂等键，UUID
  "schema_version": "1.0",
  "tenant_id": "tenant_acme",
  "agent_id": "agent_001",
  "session_id": "sess_abc123",
  "trace_id": "trace_xyz789",             // OTel Trace ID（关联 Agent-TES）
  "event_time": "2026-03-26T01:00:00Z",

  "task_summary": "帮用户分析 Q1 销售数据并生成报告",
  "messages": [...],                      // 完整对话消息列表（role/content）
  "tool_history": [
    {
      "tool_name": "sql_query",
      "input": {"query": "SELECT ..."},
      "output": {"rows": [...]},
      "success": true,
      "latency_ms": 230
    }
  ],
  "outcome": "success",                   // "success" | "failure" | "partial"
  "final_answer": "Q1 总销售额 ¥1.2M，同比增长 18%...",
  "turns": 7,
  "total_tokens": 4200
}
```

#### ams.session.archive（AMS 生产，Session 关闭时触发）

```json
{
  "message_id": "msg_uuid_002",
  "schema_version": "1.0",
  "tenant_id": "tenant_acme",
  "agent_id": "agent_001",
  "session_id": "sess_abc123",
  "event_time": "2026-03-26T01:05:00Z",

  "promotion_score": 0.74,               // 提升评分（由 AMS Promotion Evaluator 计算）
  "promotion_reasons": {                 // 各维度分数，用于 Pipeline 记录
    "task_completion": 0.9,
    "interaction_quality": 0.8,
    "knowledge_novelty": 0.6,
    "agent_improvement_signal": 0.7
  },
  "novelty_score": 0.62,                 // 1 - max_cosine_similarity(top_3_existing)
  "top_similar_memory_ids": [            // 若 novelty_score < 0.08（即相似度 > 0.92），填充此字段
    "mem_existing_001"
  ],

  "session_snapshot": {
    "messages": [...],                   // 完整会话消息
    "tool_history": [...],
    "outcome": "success",
    "turns": 12,
    "total_tokens": 8500
  }
}
```

#### ams.pipeline.structure（触发 Tree / Graph 构建）

```json
{
  "message_id": "msg_uuid_003",
  "schema_version": "1.0",
  "tenant_id": "tenant_acme",
  "agent_id": "agent_001",
  "memory_id": "mem_uuid_001",           // 已在 PG memory_records 中创建的记录
  "source_type": "work_document",        // 决定走哪些构建路径
  "structures_to_build": ["tree", "graph"],  // 本次需要构建的结构

  "content": {
    "title": "2026年Q1销售分析报告",
    "text": "完整的文档正文...",
    "tags": ["sales", "Q1", "analysis"]
  },

  "processing_config": {
    "tree_config": {
      "chunk_strategy": "heading_based",
      "max_tokens": 1500,
      "overlap": 100
    },
    "graph_config": {
      "layer_mode": "double_layer",
      "entity_extraction_model": "gpt-4o-mini",
      "relation_extraction_model": "gpt-4o-mini",
      "community_algorithm": "leiden",
      "community_resolution": 1.0
    },
    "embedding_model": "text-embedding-3-small",
    "language": "zh"
  },

  "priority": "normal"                   // "low" | "normal" | "high"
}
```

#### ams.pipeline.indexing（触发 ES 索引写入）

```json
{
  "message_id": "msg_uuid_004",
  "schema_version": "1.0",
  "tenant_id": "tenant_acme",
  "agent_id": "agent_001",
  "memory_id": "mem_uuid_001",
  "completed_structures": ["tree", "graph"],  // 已完成的结构，触发最终索引

  "index_payload": {
    "title": "2026年Q1销售分析报告",
    "summary": "本报告分析了Q1各产品线销售数据...",
    "content_text": "完整正文（用于全文检索）",
    "tags": ["sales", "Q1", "analysis"],
    "source_type": "work_document",
    "memory_type": "declarative",
    "created_at": "2026-03-26T01:00:00Z"
  }
}
```

### 3.3 Dead Letter Queue（DLQ）设计

当消息处理失败超过重试次数后，路由到 `ams.pipeline.dlq`。

#### DLQ 消息格式

```json
{
  "dlq_id": "dlq_uuid_001",
  "original_topic": "ams.pipeline.structure",
  "original_message_id": "msg_uuid_003",
  "original_message": { ... },           // 完整的原始消息
  "failure_info": {
    "error_type": "LLMCallError",
    "error_message": "Rate limit exceeded: gpt-4o-mini",
    "stack_trace": "...",
    "attempt_count": 3,
    "last_attempt_at": "2026-03-26T01:10:00Z"
  },
  "created_at": "2026-03-26T01:10:05Z"
}
```

#### 重试策略（Exponential Backoff）

```python
RETRY_DELAYS = [
    0,       # 第 1 次：立即重试
    30,      # 第 2 次：30 秒后
    300,     # 第 3 次：5 分钟后
]
# 第 3 次仍失败 → 发送到 DLQ
```

#### DLQ 告警规则

- `ams_mpp_dlq_depth{topic} > 100` 持续 5 分钟 → Slack 告警
- `ams_mpp_dlq_depth{topic} > 500` → PagerDuty 告警（可能是系统性故障）

#### 手动重放 API

```
POST /api/v1/admin/pipeline/reprocess
Body:
{
  "dlq_message_ids": ["dlq_uuid_001", "dlq_uuid_002"],  // 指定重放
  // 或
  "filter": {
    "original_topic": "ams.pipeline.structure",
    "error_type": "LLMCallError",
    "created_before": "2026-03-26T02:00:00Z"
  }
}
```

---

## 4. Pipeline 1 — Trace 入库 Pipeline

### 4.1 触发条件与职责

- **消费 Topic**：`ams.trace.ingested`（由 Agent-TES 生产）
- **适用 source_type**：`agent_trace`
- **输出**：在 PG `memory_records` 中创建记录，触发 Graph Construction（`full_three_layer`）

### 4.2 处理步骤详解

```python
class TracePipeline:
    """
    处理 Agent 执行 Trace，将其转化为 agent_trace 类型的记忆。
    消费: ams.trace.ingested
    """

    async def process(self, msg: dict) -> None:
        # ─── 幂等性检查 ───
        if await self._is_processed(msg["message_id"]):
            return  # 重复消息，跳过
        await self._mark_processing(msg["message_id"])

        try:
            # Step 1: 构建 memory content（结构化文本）
            content_text = self._build_trace_content(msg)
            title = self._generate_title(msg)

            # Step 2: 重要性评分（LLM）
            importance = await self._score_importance(
                title=title,
                content=content_text,
                outcome=msg["outcome"],
                turns=msg.get("turns", 0)
            )

            # Step 3: 标签提取
            tags = await self._extract_tags(content_text)

            # Step 4: Embedding 生成（title + content 前 500 字符）
            embedding_text = f"{title}\n{content_text[:500]}"
            embedding = await self.embedding_svc.embed_single(embedding_text)

            # Step 5: 写入 PG memory_records
            memory_id = await self._create_memory_record(
                tenant_id=msg["tenant_id"],
                agent_id=msg["agent_id"],
                memory_type="declarative",
                memory_subtype="episodic",
                source_type="agent_trace",
                source_id=msg["trace_id"],
                title=title,
                summary=content_text[:500],
                importance=importance,
                tags=tags,
                structures=["graph"],
                structures_status={"graph": "pending"},
                raw_content_ref=await self._store_raw_content(msg),  # 存 OSS
            )

            # Step 6: 发布到 ams.pipeline.structure 触发 Graph Construction
            await self.kafka_producer.send(
                topic="ams.pipeline.structure",
                key=memory_id,  # 分区键
                value={
                    "message_id": str(uuid4()),
                    "schema_version": "1.0",
                    "tenant_id": msg["tenant_id"],
                    "agent_id": msg["agent_id"],
                    "memory_id": memory_id,
                    "source_type": "agent_trace",
                    "structures_to_build": ["graph"],
                    "content": {
                        "title": title,
                        "text": content_text,
                        "tags": tags
                    },
                    "processing_config": {
                        "graph_config": {
                            "layer_mode": "full_three_layer",  # 包含 Temporal KG
                            "entity_extraction_model": "gpt-4o-mini",
                            "relation_extraction_model": "gpt-4o-mini",
                            "community_algorithm": "leiden",
                            "temporal_reference_time": msg["event_time"]
                        },
                        "embedding_model": "text-embedding-3-small"
                    }
                }
            )

            await self._mark_processed(msg["message_id"])

        except Exception as e:
            await self._handle_failure(msg, e)

    def _build_trace_content(self, msg: dict) -> str:
        """将原始 Trace 消息构建为结构化 memory 正文"""
        parts = [
            f"任务：{msg['task_summary']}",
            f"结果：{msg['outcome']}",
            f"轮次：{msg.get('turns', 0)} 轮对话，消耗 {msg.get('total_tokens', 0)} tokens",
        ]
        if msg.get("final_answer"):
            parts.append(f"最终答案：{msg['final_answer'][:300]}")

        parts.append("工具调用序列：")
        for i, tool in enumerate(msg.get("tool_history", [])[:10], 1):
            status = "✓" if tool["success"] else "✗"
            input_repr = str(tool.get("input", {}))[:80]
            parts.append(f"  {i}. {status} {tool['tool_name']}({input_repr})")
            if not tool["success"] and tool.get("output", {}).get("error"):
                parts.append(f"     错误：{str(tool['output']['error'])[:100]}")

        return "\n".join(parts)

    async def _score_importance(self, title: str, content: str,
                                outcome: str, turns: int) -> float:
        """调用 LLM 评估 Trace 的重要性（1.0-10.0），归一化为 0.0-1.0"""
        prompt = f"""请为以下 Agent 执行记录评估重要性分数（1-10分）。

评分维度：
- 任务难度与创新性（首次遇到此类问题得分高）
- 结果质量（成功且答案准确得分高）
- 失败经验价值（失败但有明确原因、可学习得分高）
- 多步工具协作复杂度（工具链越复杂得分越高）

评分标准：
- 9-10分：极其重要，包含全新解决方案或重要失败教训
- 7-8分：重要，解决了有难度的问题，或有明确价值的失败案例
- 5-6分：中等，解决了常见问题，有一定参考价值
- 3-4分：较低，简单操作，无特别学习价值
- 1-2分：无价值，操作失败且无明确原因

任务标题：{title}
执行结果：{outcome}（共 {turns} 轮）
执行摘要：
{content[:600]}

请只返回一个数字（1.0-10.0），不要任何解释。"""

        try:
            resp = await self.llm_client.chat_completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=10,
                temperature=0.1
            )
            raw_score = float(resp.strip())
            return min(max(raw_score / 10.0, 0.0), 1.0)  # 归一化到 [0, 1]
        except (ValueError, Exception):
            # 解析失败：根据 outcome 设定默认值
            return 0.7 if outcome == "success" else 0.5

    def _generate_title(self, msg: dict) -> str:
        """从 Trace 消息生成简短标题"""
        summary = msg.get("task_summary", "")
        outcome_suffix = "（成功）" if msg["outcome"] == "success" else "（失败）"
        # 截断到 50 字以内
        title = summary[:47] + "..." if len(summary) > 50 else summary
        return f"{title}{outcome_suffix}"
```

### 4.3 重要性评分详细标准

| 分数区间（归一化后）| 含义 | 典型场景 |
|---|---|---|
| 0.9 - 1.0 | 极其重要 | 首次解决复杂多步骤问题；包含关键错误诊断与修复 |
| 0.7 - 0.9 | 重要 | 成功完成 5 步以上工具链任务；失败但有明确可复用的错误原因 |
| 0.5 - 0.7 | 中等 | 常规问答、数据查询；简单工具调用成功 |
| 0.3 - 0.5 | 较低 | 重复任务，无新内容 |
| 0.0 - 0.3 | 无价值 | 失败且无有效信息；幂等操作 |

---

## 5. Pipeline 2 — Session 归档 Pipeline

### 5.1 触发条件与职责

- **消费 Topic**：`ams.session.archive`（由 AMS Promotion Evaluator 生产）
- **触发时机**：
  1. AMS 计算 `promotion_score >= 0.6`（可配置阈值）
  2. AMS `CloseSession` 时，若有未归档内容
- **适用 source_type**：`user_interaction`
- **输出**：在 PG `memory_records` 创建记录，触发 Graph Construction（`full_three_layer`）

### 5.2 Novelty Check（新颖性检查）

Session Archive Pipeline 在创建新记忆前，必须执行新颖性检查，避免语义重复的记忆碎片化累积：

```python
async def _check_novelty_and_decide(self, tenant_id: str, agent_id: str,
                                     novelty_score: float,
                                     top_similar_ids: list[str]) -> dict:
    """
    根据 novelty_score 决定：新建记忆 or 更新已有记忆。

    AMS 已在生产 session.archive 消息时计算好 novelty_score 和 top_similar_ids，
    Pipeline 直接读取判断，无需重新计算。

    Returns:
        {"action": "create_new", "memory_id": None}
        {"action": "update_existing", "memory_id": "mem_xxx"}
    """
    # cosine_similarity > 0.92 ↔ novelty_score < 0.08
    if novelty_score < 0.08 and top_similar_ids:
        # 近似重复：只更新已有记忆的统计，不创建新记忆
        existing_id = top_similar_ids[0]
        await self.pg_client.execute("""
            UPDATE memory_records
            SET access_count = access_count + 1,
                importance = LEAST(1.0, importance + 0.02),
                last_accessed = now(),
                updated_at = now()
            WHERE memory_id = $1
        """, existing_id)
        return {"action": "update_existing", "memory_id": existing_id}
    else:
        # 新颖内容：正常创建新记忆
        return {"action": "create_new", "memory_id": None}
```

### 5.3 处理步骤

```python
class SessionArchivePipeline:
    async def process(self, msg: dict) -> None:
        if await self._is_processed(msg["message_id"]):
            return

        # Step 1: Novelty check
        decision = await self._check_novelty_and_decide(
            tenant_id=msg["tenant_id"],
            agent_id=msg["agent_id"],
            novelty_score=msg["novelty_score"],
            top_similar_ids=msg.get("top_similar_memory_ids", [])
        )

        if decision["action"] == "update_existing":
            # 近似重复，更新已有记忆即可，不继续 Pipeline
            await self._mark_processed(msg["message_id"])
            return

        # Step 2: 构建 memory content（从会话消息中提取高价值内容）
        session = msg["session_snapshot"]
        content_text = self._build_session_content(session)
        title = self._infer_session_title(session)

        # Step 3: 写入 PG memory_records
        memory_id = await self._create_memory_record(
            tenant_id=msg["tenant_id"],
            agent_id=msg["agent_id"],
            memory_type="declarative",
            memory_subtype="episodic",
            source_type="user_interaction",
            source_id=msg["session_id"],
            title=title,
            summary=content_text[:500],
            importance=self._map_promotion_score_to_importance(
                msg["promotion_score"]
            ),
            structures=["graph"],
            structures_status={"graph": "pending"},
        )

        # Step 4: 触发 Graph Construction（full_three_layer for user_interaction）
        await self.kafka_producer.send(
            topic="ams.pipeline.structure",
            key=memory_id,
            value={
                "message_id": str(uuid4()),
                "tenant_id": msg["tenant_id"],
                "agent_id": msg["agent_id"],
                "memory_id": memory_id,
                "source_type": "user_interaction",
                "structures_to_build": ["graph"],
                "content": {"title": title, "text": content_text},
                "processing_config": {
                    "graph_config": {
                        "layer_mode": "full_three_layer",
                        "temporal_reference_time": msg["event_time"]
                    }
                }
            }
        )

    def _build_session_content(self, session: dict) -> str:
        """
        从会话消息中提取高价值内容，构建 memory 正文。
        策略：保留 user 消息（意图）+ assistant 的关键输出（结果）
        """
        parts = []
        messages = session.get("messages", [])

        # 用户意图（所有 user 消息）
        user_msgs = [m["content"] for m in messages if m["role"] == "user"]
        if user_msgs:
            parts.append("用户需求：" + " | ".join(user_msgs[:3])[:300])

        # Agent 关键输出（最后一条 assistant 消息）
        assistant_msgs = [m["content"] for m in messages
                          if m["role"] == "assistant" and m.get("content")]
        if assistant_msgs:
            parts.append(f"Agent 结论：{assistant_msgs[-1][:500]}")

        # 工具调用摘要
        tool_history = session.get("tool_history", [])
        if tool_history:
            tools_used = list(dict.fromkeys([t["tool_name"] for t in tool_history]))
            parts.append(f"使用工具：{', '.join(tools_used[:8])}")

        return "\n".join(parts)
```

---

## 6. Pipeline 3 — Tree Construction Pipeline

### 6.1 触发条件与职责

- **消费 Topic**：`ams.pipeline.structure`（其中 `structures_to_build` 包含 `"tree"`）
- **适用 source_type**：`work_document`, `source_code`, `skill_markdown`
- **不适用**：`user_interaction`, `agent_trace`（这两类不走 Tree）
- **输出**：
  - Milvus `block_embeddings` 集合（段落级向量）
  - Milvus `section_embeddings` 集合（章节级向量）
  - Neo4j `(:Block)` 节点 + `(:Section)` 节点（`skill_markdown` 不写 Neo4j）
  - PG `structures_status` 更新 `{"tree": "completed"}`

### 6.2 分块策略（Chunking Strategy）

分块策略根据内容类型和文档结构自动选择：

```python
def select_chunk_strategy(source_type: str, content: str,
                            config: dict) -> str:
    """自动选择分块策略"""
    explicit = config.get("tree_config", {}).get("chunk_strategy")
    if explicit:
        return explicit  # 优先使用显式配置

    if source_type == "source_code":
        return "semantic"   # 代码：按语义边界（函数/类）

    # 检测 Markdown 标题密度
    heading_count = content.count("\n#")
    char_count = len(content)
    if heading_count > 0 and char_count / max(heading_count, 1) < 3000:
        return "heading_based"  # 文档有明确标题结构

    return "fixed_size"  # 兜底策略
```

#### 策略 A：heading_based（标题驱动分块）

适用场景：Markdown 文档、技术手册、skill_markdown

```python
class HeadingBasedChunker:
    """
    按 Markdown 标题（#、##、###）分割，将每个标题开始的段落视为一个 Section。
    若某 Section 超过 max_tokens，则进一步按段落边界拆分。
    """
    MAX_TOKENS = 1500
    OVERLAP_TOKENS = 100

    def chunk(self, text: str) -> list[dict]:
        """
        Returns: list of {
            "content": str,
            "heading": str,          # 当前标题文本
            "heading_level": int,    # 1/2/3
            "position": int,         # 在原文中的 chunk 序号
            "block_type": str        # "text" | "code" | "table" | "img"
        }
        """
        sections = self._split_by_headings(text)
        chunks = []
        for section in sections:
            if self._count_tokens(section["content"]) <= self.MAX_TOKENS:
                chunks.append(self._classify_block(section))
            else:
                # 超大 Section：按段落边界再次拆分
                sub_chunks = self._split_by_paragraph(
                    section["content"],
                    max_tokens=self.MAX_TOKENS,
                    overlap=self.OVERLAP_TOKENS
                )
                for sub in sub_chunks:
                    sub["heading"] = section["heading"]
                    sub["heading_level"] = section["heading_level"]
                    chunks.append(self._classify_block(sub))

        for i, chunk in enumerate(chunks):
            chunk["position"] = i
        return chunks

    def _classify_block(self, chunk: dict) -> dict:
        """检测 block_type：text / code / table / img"""
        content = chunk["content"].strip()
        if content.startswith("```") or content.startswith("    "):
            chunk["block_type"] = "code"
        elif content.startswith("|") and "|---|" in content:
            chunk["block_type"] = "table"
        elif content.startswith("!["):
            chunk["block_type"] = "img"
        else:
            chunk["block_type"] = "text"
        return chunk
```

#### 策略 B：semantic（语义边界分块）

适用场景：`source_code`，按函数/类/模块边界切割

```python
class SemanticChunker:
    """
    对代码文件按语义单元（函数定义、类定义、顶层语句块）分割。
    使用 tree-sitter 解析 AST，提取顶层声明。
    """
    def chunk(self, text: str, language: str = "python") -> list[dict]:
        import tree_sitter_languages
        parser = tree_sitter_languages.get_parser(language)
        tree = parser.parse(bytes(text, "utf-8"))

        chunks = []
        for node in tree.root_node.children:
            if node.type in ("function_definition", "class_definition",
                             "decorated_definition"):
                chunk_text = text[node.start_byte:node.end_byte]
                chunks.append({
                    "content": chunk_text,
                    "heading": self._extract_name(node, text),
                    "heading_level": 2,
                    "block_type": "code",
                    "position": len(chunks)
                })

        if not chunks:
            # 无法解析（如非标准语法）：降级到 fixed_size
            return FixedSizeChunker().chunk(text)
        return chunks
```

#### 策略 C：fixed_size（固定大小，兜底）

```python
class FixedSizeChunker:
    def chunk(self, text: str,
               max_tokens: int = 512,
               overlap: int = 64) -> list[dict]:
        """按 token 数量滑动窗口分块"""
        tokens = self.tokenizer.encode(text)
        chunks = []
        start = 0
        while start < len(tokens):
            end = min(start + max_tokens, len(tokens))
            chunk_text = self.tokenizer.decode(tokens[start:end])
            chunks.append({
                "content": chunk_text,
                "heading": "",
                "heading_level": 0,
                "block_type": "text",
                "position": len(chunks)
            })
            start += max_tokens - overlap
        return chunks
```

### 6.3 Section 层级归属（Tree 结构构建）

Block → Section L1 → Section L2 的层级关系通过标题级别建立：

```
原始文档结构:
  # 第一章（H1）               → Section L1
    ## 1.1 背景（H2）           → Section L2
       段落A（chunk 1）          → Block（属于 Section L2 "1.1 背景"）
       段落B（chunk 2）          → Block（属于 Section L2 "1.1 背景"）
    ## 1.2 目标（H2）           → Section L2
       段落C（chunk 3）          → Block（属于 Section L2 "1.2 目标"）
  # 第二章（H1）               → Section L1
    ...

Tree 节点关系（Neo4j）:
  (:Block {block_id: "b1"}) -[:BELONGS_TO_SECTION]-> (:Section {level: 2, heading: "1.1 背景"})
  (:Section {heading: "1.1 背景"}) -[:CHILD_OF]-> (:Section {level: 1, heading: "第一章"})
  (:Section {heading: "第一章"}) -[:CHILD_OF]-> (:Memory {memory_id: "mem_001"})
```

```python
class TreeBuilder:
    async def build_tree(self, chunks: list[dict],
                          memory_id: str,
                          tenant_id: str,
                          agent_id: str) -> dict:
        """
        从 chunks 列表构建 Section 层级树，生成 Section Summary。
        Returns: {"sections": [...], "doc_summary": str}
        """
        # Step 1: 从 chunks 推导 Section 树结构
        sections = self._build_section_hierarchy(chunks)

        # Step 2: 为每个 Section 生成摘要（3-5 个相邻 block 合并摘要）
        section_summaries = {}
        for section in sections:
            child_blocks = [c for c in chunks
                             if c.get("section_id") == section["section_id"]]
            if child_blocks:
                summary_text = "\n".join([b["content"][:300]
                                           for b in child_blocks[:5]])
                section_summaries[section["section_id"]] = \
                    await self._generate_section_summary(
                        section_heading=section["heading"],
                        content=summary_text
                    )

        # Step 3: 生成文档级摘要（从所有 L1 Section 摘要汇总）
        l1_summaries = [section_summaries.get(s["section_id"], "")
                         for s in sections if s["level"] == 1]
        doc_summary = await self._generate_doc_summary(
            title=memory_id,  # 实际从 memory 标题传入
            section_summaries=l1_summaries[:8]
        )

        return {"sections": sections, "section_summaries": section_summaries,
                "doc_summary": doc_summary}

    async def _generate_section_summary(self, section_heading: str,
                                         content: str) -> str:
        """LLM 生成章节摘要（150字以内）"""
        prompt = f"""请为以下章节内容生成一段简洁的摘要（150字以内）。

章节标题：{section_heading}
章节内容：
{content[:1200]}

要求：
- 突出核心信息和关键概念
- 不引入原文没有的内容
- 使用陈述句，不要列举格式

请直接输出摘要，不要任何前言。"""

        resp = await self.llm_client.chat_completion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0.3
        )
        return resp.strip()
```

### 6.4 Embedding 生成与存储

```python
class TreeIndexer:
    async def index_tree(self, chunks: list[dict], sections: list[dict],
                          section_summaries: dict, memory_id: str,
                          tenant_id: str, agent_id: str,
                          embedding_model: str) -> None:
        """
        批量生成 Embedding 并写入 Milvus。
        使用批处理减少 API 调用次数（32 条/批）。
        """
        BATCH_SIZE = 32

        # ─── Block Embeddings ───
        block_texts = [chunk["content"] for chunk in chunks]
        block_embeddings = await self._batch_embed(block_texts,
                                                    embedding_model, BATCH_SIZE)

        block_records = []
        for chunk, emb in zip(chunks, block_embeddings):
            block_records.append({
                "id": chunk["block_id"],
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "memory_id": memory_id,
                "section_id": chunk.get("section_id", ""),
                "block_type": chunk["block_type"],
                "position": chunk["position"],
                "content_preview": chunk["content"][:200],
                "embedding": emb,
                "decay_weight": 1.0,
                "created_at": int(time.time())
            })

        await self.milvus_client.upsert(
            collection="block_embeddings",
            data=block_records
        )

        # ─── Section Embeddings ───
        section_ids_with_summary = [
            sid for sid in section_summaries if section_summaries[sid]
        ]
        section_texts = [section_summaries[sid]
                          for sid in section_ids_with_summary]
        if section_texts:
            sec_embeddings = await self._batch_embed(section_texts,
                                                      embedding_model, BATCH_SIZE)
            sec_records = []
            for sid, emb in zip(section_ids_with_summary, sec_embeddings):
                section = next((s for s in sections
                                 if s["section_id"] == sid), None)
                if section:
                    sec_records.append({
                        "id": sid,
                        "tenant_id": tenant_id,
                        "agent_id": agent_id,
                        "memory_id": memory_id,
                        "level": section["level"],
                        "heading": section["heading"],
                        "summary": section_summaries[sid],
                        "embedding": emb,
                        "created_at": int(time.time())
                    })
            await self.milvus_client.upsert(
                collection="section_embeddings",
                data=sec_records
            )

    async def _batch_embed(self, texts: list[str], model: str,
                            batch_size: int) -> list[list[float]]:
        """批量调用 Embedding API，返回向量列表"""
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            embeddings = await self.embedding_svc.embed_batch(batch, model=model)
            all_embeddings.extend(embeddings)
        return all_embeddings
```

### 6.5 Neo4j 写入（Tree 结构）

```python
# 写入 Block 节点（每个 chunk 对应一个 Block 节点）
MERGE_BLOCK_QUERY = """
MERGE (b:Block {block_id: $block_id})
ON CREATE SET
  b.tenant_id = $tenant_id,
  b.agent_id = $agent_id,
  b.memory_id = $memory_id,
  b.section_id = $section_id,
  b.block_type = $block_type,
  b.position = $position,
  b.content_preview = $content_preview,
  b.summary = $summary,
  b.tags = $tags,
  b.decay_weight = 1.0,
  b.created_at = datetime()
ON MATCH SET
  b.summary = $summary,
  b.updated_at = datetime()
"""

# 写入 Section 节点及层级关系
MERGE_SECTION_QUERY = """
MERGE (s:Section {section_id: $section_id})
ON CREATE SET
  s.tenant_id = $tenant_id,
  s.agent_id = $agent_id,
  s.memory_id = $memory_id,
  s.heading = $heading,
  s.level = $level,
  s.summary = $summary,
  s.created_at = datetime()
ON MATCH SET
  s.summary = $summary,
  s.updated_at = datetime()
"""

# Block → Section 归属关系
LINK_BLOCK_TO_SECTION_QUERY = """
MATCH (b:Block {block_id: $block_id})
MATCH (s:Section {section_id: $section_id})
MERGE (b)-[:BELONGS_TO_SECTION]->(s)
"""

# Section 父子关系
LINK_SECTION_HIERARCHY_QUERY = """
MATCH (child:Section {section_id: $child_id})
MATCH (parent:Section {section_id: $parent_id})
MERGE (child)-[:CHILD_OF]->(parent)
"""
```

> **skill_markdown 例外**：`skill_markdown` 类型只走 Tree，**不写 Neo4j 图结构**。Block 和 Section Embedding 写入 Milvus 即可，Neo4j 节点创建步骤跳过。

### 6.6 structures_status 更新

Tree Construction 完成后，通过 JSONB 原子更新通知 AMS：

```python
await self.pg_client.execute("""
    UPDATE memory_records
    SET structures_status = structures_status || '{"tree": "completed"}'::jsonb,
        updated_at = now()
    WHERE memory_id = $1
""", memory_id)

# 检查是否所有结构都已完成，若是则触发 Indexing Pipeline
await self._check_and_trigger_indexing(memory_id)
```

---

## 7. Pipeline 4 — Graph Construction Pipeline

### 7.1 触发条件与职责

- **消费 Topic**：`ams.pipeline.structure`（其中 `structures_to_build` 包含 `"graph"`）
- **适用 source_type**：除 `skill_markdown` 外的所有类型
- **并发说明**：对于 `work_document` / `source_code`，Tree Pipeline 和 Graph Pipeline **同时**消费同一条 `ams.pipeline.structure` 消息（两个 Consumer Group 独立消费），互不阻塞，各自只更新自己的 JSONB key

### 7.2 Two-pass NER（两遍实体抽取）

```python
class TwoPassNER:
    """
    两遍策略：spaCy 快速提取（所有 chunk）+ LLM 精准提取（高价值 chunk）
    """
    CONFIDENCE_THRESHOLD = 0.7   # 低于此置信度的 chunk 触发 LLM 精提
    HIGH_VALUE_PATTERNS = [       # 触发 LLM 精提的内容特征
        r"(?:算法|架构|原理|机制|策略|方案)",
        r"(?:class|def|function|API|interface)",
        r"(?:导致|因此|因为|所以|然而|但是)",  # 因果关系词
    ]

    async def extract(self, chunks: list[dict],
                       language: str = "zh") -> list[dict]:
        """
        Returns: list of {
            "entity_id": str,
            "name": str,              # 规范化名称
            "original_text": str,     # 原始文本
            "entity_type": str,       # person/org/tool/concept/action/event
            "description": str,       # LLM 生成的描述
            "source_block_ids": list, # 来源 Block ID 列表
            "confidence": float
        }
        """
        # Pass 1: spaCy 快速提取（全部 chunk）
        all_entities = {}
        for chunk in chunks:
            fast_entities = self._spacy_extract(chunk["content"], language)
            for ent in fast_entities:
                key = self._canonicalize(ent["name"])
                if key not in all_entities:
                    all_entities[key] = ent
                    all_entities[key]["source_block_ids"] = []
                all_entities[key]["source_block_ids"].append(chunk["block_id"])

        # Pass 2: LLM 精准提取（仅高价值 chunk）
        high_value_chunks = [c for c in chunks
                              if self._is_high_value(c["content"])]
        if high_value_chunks:
            llm_entities = await self._llm_extract_batch(high_value_chunks)
            # 合并：LLM 结果优先级更高（覆盖 spaCy 同名实体）
            for ent in llm_entities:
                key = self._canonicalize(ent["name"])
                if key in all_entities:
                    # 已有实体：补充 description，更新 confidence
                    all_entities[key]["description"] = ent.get("description", "")
                    all_entities[key]["confidence"] = max(
                        all_entities[key].get("confidence", 0.7),
                        ent.get("confidence", 0.9)
                    )
                    all_entities[key]["source_block_ids"] = list(set(
                        all_entities[key]["source_block_ids"] +
                        ent.get("source_block_ids", [])
                    ))
                else:
                    # 新实体（spaCy 遗漏）
                    all_entities[key] = ent

        return list(all_entities.values())

    def _canonicalize(self, name: str) -> str:
        """规范化实体名：小写、去除多余空白、繁简统一"""
        return name.strip().lower().replace("  ", " ")

    def _is_high_value(self, content: str) -> bool:
        """判断是否是高价值 chunk，需要 LLM 精提"""
        import re
        for pattern in self.HIGH_VALUE_PATTERNS:
            if re.search(pattern, content):
                return True
        return False

    async def _llm_extract_batch(self, chunks: list[dict]) -> list[dict]:
        """批量调用 LLM 提取实体（最多 8 个 chunk 一批）"""
        results = []
        for i in range(0, len(chunks), 8):
            batch = chunks[i:i + 8]
            combined_text = "\n\n".join([
                f"[段落{j+1}] {c['content'][:500]}"
                for j, c in enumerate(batch)
            ])
            entities = await self._llm_ner_call(combined_text)
            results.extend(entities)
        return results

    async def _llm_ner_call(self, text: str) -> list[dict]:
        """调用 LLM 提取实体，返回结构化实体列表"""
        prompt = f"""请从以下文本中提取所有重要实体（人物、组织、工具、概念、操作、事件）。

对每个实体，请提供：
- name: 规范化名称（统一使用最完整的形式）
- entity_type: person / org / tool / concept / action / event
- description: 一句话描述（50字以内）
- confidence: 置信度（0.0-1.0）

文本内容：
{text}

请以 JSON 数组格式返回，示例：
[{{"name": "Pandas", "entity_type": "tool", "description": "Python 数据分析库", "confidence": 0.95}}]

只返回 JSON，不要任何前言。"""

        try:
            resp = await self.llm_client.chat_completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=1000,
                temperature=0.1,
                response_format={"type": "json_object"}
            )
            import json
            data = json.loads(resp)
            return data if isinstance(data, list) else data.get("entities", [])
        except Exception:
            return []
```

### 7.3 Relation Edge 构建

```python
class RelationExtractor:
    """
    从实体对和上下文中抽取语义关系。
    """
    # 关系类型分类法
    RELATION_TYPES = [
        "calls",          # A 调用 B（函数/API）
        "depends_on",     # A 依赖 B
        "contains",       # A 包含 B（组合关系）
        "causes",         # A 导致 B
        "follows",        # A 在 B 之后执行（顺序关系）
        "produces",       # A 产生 B（输出关系）
        "uses",           # A 使用 B（工具关系）
        "is_part_of",     # A 是 B 的一部分
        "interacts_with", # A 与 B 交互
        "similar_to",     # A 与 B 语义相似（弱关系）
    ]

    async def extract(self, entities: list[dict],
                       chunks: list[dict]) -> list[dict]:
        """
        对共现实体对抽取关系。
        优化：只抽取在同一 chunk 中共现的实体对（避免笛卡尔积爆炸）。

        Returns: list of {
            "source_entity": str,    # entity name
            "target_entity": str,
            "relation_type": str,
            "description": str,
            "weight": float,         # 关系强度 [0, 1]
            "importance": float,
            "source_block_ids": list
        }
        """
        relations = []
        entity_set = {e["name"].lower() for e in entities}

        for chunk in chunks:
            # 找出此 chunk 中出现的实体
            chunk_entities = [
                e for e in entities
                if e["name"].lower() in chunk["content"].lower()
                and chunk["block_id"] in e.get("source_block_ids", [])
            ]

            # 对共现实体对（最多 C(n,2) 对，n<=10）调用 LLM 关系抽取
            if len(chunk_entities) < 2:
                continue
            if len(chunk_entities) > 10:
                chunk_entities = chunk_entities[:10]  # 限制规模

            for i in range(len(chunk_entities)):
                for j in range(i + 1, len(chunk_entities)):
                    ent_a = chunk_entities[i]
                    ent_b = chunk_entities[j]
                    rel = await self._extract_pair_relation(
                        ent_a, ent_b, chunk["content"]
                    )
                    if rel:
                        rel["source_block_ids"] = [chunk["block_id"]]
                        relations.append(rel)

        # 关系去重（同一实体对可能在多个 chunk 中共现）
        return self._dedup_relations(relations)

    async def _extract_pair_relation(self, ent_a: dict, ent_b: dict,
                                      context: str) -> dict | None:
        """对一对实体在给定上下文中推断关系"""
        prompt = f"""给定以下两个实体和上下文，判断它们之间的关系。

实体A：{ent_a['name']}（{ent_a.get('entity_type', 'unknown')}）
实体B：{ent_b['name']}（{ent_b.get('entity_type', 'unknown')}）

上下文：
{context[:600]}

可选关系类型：{', '.join(self.RELATION_TYPES)}

如果两者有明确关系，返回 JSON：
{{"source": "{ent_a['name']}", "target": "{ent_b['name']}", "relation_type": "...", "description": "...", "weight": 0.8}}

如果没有明确关系，返回：null

只返回 JSON 或 null，不要任何解释。"""

        try:
            resp = await self.llm_client.chat_completion(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=150,
                temperature=0.1
            )
            if resp.strip().lower() == "null":
                return None
            import json
            return json.loads(resp)
        except Exception:
            return None
```

### 7.4 Temporal KG 生成（full_three_layer 专属）

对于 `user_interaction` 和 `agent_trace`，需要在 PhraseNode 和 Edge 上附加时序属性：

```python
class TemporalKGBuilder:
    """
    构建 Temporal Knowledge Graph（时序知识图谱）。
    核心：为每个实体和关系标记 valid_from / valid_until。
    适用：full_three_layer（user_interaction / agent_trace）
    """

    async def apply_temporal_attributes(self,
                                         entities: list[dict],
                                         relations: list[dict],
                                         reference_time: str) -> None:
        """
        为实体和关系应用时序属性，并处理时序失效（Temporal Invalidation）。
        reference_time: 本次 Trace/Session 发生的时间（ISO 8601）
        """
        # Step 1: 为所有新实体和关系设置 valid_from = reference_time
        for entity in entities:
            entity["valid_from"] = reference_time
            entity["valid_until"] = None  # 默认永久有效

        for relation in relations:
            relation["valid_from"] = reference_time
            relation["valid_until"] = None

        # Step 2: 时序失效检测（Temporal Invalidation）
        # 检查是否有新实体与已有实体描述冲突
        for entity in entities:
            existing = await self._find_existing_entity(entity["name"])
            if existing and self._has_contradiction(entity, existing):
                # 将旧实体标记为失效
                await self._invalidate_entity(
                    entity_id=existing["entity_id"],
                    valid_until=reference_time,
                    reason=f"Superseded by new information at {reference_time}"
                )

    def _has_contradiction(self, new_ent: dict, existing: dict) -> bool:
        """
        检测新旧实体描述是否有实质性矛盾。
        简单启发式：description 语义相似度 < 0.5 且 entity_type 相同
        """
        # 实际实现：对 description embedding 计算余弦相似度
        # 这里使用简化版本
        if new_ent.get("entity_type") != existing.get("entity_type"):
            return False
        # 若描述差异显著（实际使用 embedding similarity）
        return False  # 保守策略：只有明确信号才标记失效

    async def _invalidate_entity(self, entity_id: str,
                                   valid_until: str, reason: str) -> None:
        """在 Neo4j 中将实体标记为失效"""
        await self.neo4j_client.run("""
            MATCH (n:PhraseNode {entity_id: $entity_id})
            SET n.valid_until = datetime($valid_until),
                n.invalidation_reason = $reason,
                n.updated_at = datetime()
        """, entity_id=entity_id, valid_until=valid_until, reason=reason)
```

### 7.5 社区检测（Leiden Algorithm）

```python
class LeidenCommunityDetector:
    """
    基于 Leiden 算法对 PhraseNode 图执行社区检测，生成 CommunityNode。
    触发条件：
    1. 新增 PhraseNode 数量 >= DETECTION_THRESHOLD（500）
    2. 每日 03:00 定时全量检测
    """
    DETECTION_THRESHOLD = 500

    async def maybe_trigger(self, agent_id: str, tenant_id: str,
                              new_node_count: int) -> bool:
        """检查是否需要触发社区检测"""
        counter_key = f"leiden:new_nodes:{tenant_id}:{agent_id}"
        current = await self.redis.incrby(counter_key, new_node_count)
        if current >= self.DETECTION_THRESHOLD:
            await self.redis.delete(counter_key)
            return True
        return False

    async def run_detection(self, agent_id: str, tenant_id: str) -> dict:
        """
        执行完整的社区检测流程。
        Returns: {"communities_created": int, "communities_updated": int}
        """
        # Step 1: 从 Neo4j 读取实体图
        graph_data = await self._fetch_entity_graph(agent_id, tenant_id)
        if len(graph_data["nodes"]) < 10:
            return {"communities_created": 0, "communities_updated": 0}

        # Step 2: 构建 networkx 图
        import networkx as nx
        G = nx.Graph()
        for node in graph_data["nodes"]:
            G.add_node(node["entity_id"], phrase=node["name"],
                        entity_type=node.get("entity_type", ""))
        for edge in graph_data["edges"]:
            G.add_edge(edge["source"], edge["target"],
                        weight=edge.get("weight", 1.0))

        # Step 3: 运行 Leiden 算法
        import leidenalg
        import igraph as ig
        # networkx → igraph 转换
        ig_graph = ig.Graph.from_networkx(G)
        partition = leidenalg.find_partition(
            ig_graph,
            leidenalg.ModularityVertexPartition,
            n_iterations=10,
            seed=42
        )

        # Step 4: 处理每个社区
        created, updated = 0, 0
        for community_idx, member_nodes in enumerate(partition):
            member_entity_ids = [
                list(G.nodes())[n] for n in member_nodes
            ]
            member_phrases = [
                G.nodes[eid].get("phrase", eid)
                for eid in member_entity_ids
            ]

            # 生成社区 ID（基于成员集合的哈希）
            community_id = self._generate_community_id(
                tenant_id, agent_id, frozenset(member_entity_ids)
            )

            # 检查社区是否已存在（避免重复生成）
            existing = await self._get_community(community_id)

            # 生成 Community Summary
            summary = await self._generate_community_summary(
                member_phrases=member_phrases,
                related_blocks=await self._get_related_blocks(
                    member_entity_ids, tenant_id, agent_id
                )
            )

            # 写入 CommunityNode to Neo4j
            await self._upsert_community_node(
                community_id=community_id,
                tenant_id=tenant_id,
                agent_id=agent_id,
                member_entity_ids=member_entity_ids,
                summary=summary,
                member_count=len(member_entity_ids)
            )

            # 写入 Community Summary Embedding to Milvus
            embedding = await self.embedding_svc.embed_single(summary)
            await self.milvus_client.upsert(
                collection="community_embeddings",
                data=[{
                    "id": community_id,
                    "tenant_id": tenant_id,
                    "agent_id": agent_id,
                    "summary": summary,
                    "member_count": len(member_entity_ids),
                    "embedding": embedding,
                    "created_at": int(time.time())
                }]
            )

            if existing:
                updated += 1
            else:
                created += 1

        return {"communities_created": created, "communities_updated": updated}

    async def _generate_community_summary(self, member_phrases: list[str],
                                           related_blocks: list[dict]) -> str:
        """调用 LLM 生成社区摘要（200字以内）"""
        excerpts = "\n".join([
            f"- {b['content_preview'][:200]}"
            for b in related_blocks[:5]
        ])
        prompt = f"""以下是一组语义相关的概念/实体，以及它们出现过的文本片段。
请生成一段综合摘要（200字以内），描述这组概念的整体含义和相互关系。

概念列表：{', '.join(member_phrases[:20])}

相关文本片段：
{excerpts}

请直接输出摘要，不要前言或标题。"""

        resp = await self.llm_client.chat_completion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=300,
            temperature=0.3
        )
        return resp.strip()
```

### 7.6 Neo4j 图写入

```python
# PhraseNode 写入（MERGE 保证幂等）
MERGE_PHRASE_NODE_QUERY = """
MERGE (n:PhraseNode {entity_id: $entity_id})
ON CREATE SET
  n.tenant_id = $tenant_id,
  n.agent_id = $agent_id,
  n.name = $name,
  n.original_text = $original_text,
  n.description = $description,
  n.entity_type = $entity_type,
  n.importance = $importance,
  n.access_count = 0,
  n.decay_weight = 1.0,
  n.valid_from = datetime($valid_from),
  n.valid_until = null,
  n.source_memory_id = $source_memory_id,
  n.created_at = datetime()
ON MATCH SET
  n.description = CASE WHEN $description <> '' THEN $description ELSE n.description END,
  n.importance = CASE WHEN $importance > n.importance THEN $importance ELSE n.importance END,
  n.access_count = n.access_count + 1,
  n.updated_at = datetime()
"""

# RELATES_TO 边写入
MERGE_RELATION_QUERY = """
MATCH (a:PhraseNode {entity_id: $source_id})
MATCH (b:PhraseNode {entity_id: $target_id})
MERGE (a)-[r:RELATES_TO {edge_id: $edge_id}]->(b)
ON CREATE SET
  r.relation_type = $relation_type,
  r.description = $description,
  r.weight = $weight,
  r.importance = $importance,
  r.valid_from = datetime($valid_from),
  r.valid_until = null,
  r.source_memory_id = $source_memory_id,
  r.created_at = datetime()
ON MATCH SET
  r.weight = r.weight + $weight * 0.1,  -- 共现次数增加关系强度
  r.updated_at = datetime()
"""

# Block → PhraseNode 上下文关联（Tree↔Graph 桥接边）
MERGE_HAS_CONTEXT_QUERY = """
MATCH (b:Block {block_id: $block_id})
MATCH (n:PhraseNode {entity_id: $entity_id})
MERGE (b)-[r:HAS_CONTEXT]->(n)
ON CREATE SET
  r.weight = $weight,
  r.chunk_position = $position,
  r.created_at = datetime()
"""
```

### 7.7 structures_status 更新

```python
# Graph Construction 完成后更新
await self.pg_client.execute("""
    UPDATE memory_records
    SET structures_status = structures_status || '{"graph": "completed"}'::jsonb,
        updated_at = now()
    WHERE memory_id = $1
""", memory_id)

# 检查是否所有结构都完成
await self._check_and_trigger_indexing(memory_id)

async def _check_and_trigger_indexing(self, memory_id: str) -> None:
    """
    检查 structures_status 中所有 key 是否都为 'completed'。
    若是，发布到 ams.pipeline.indexing 触发最终索引。
    """
    record = await self.pg_client.fetchrow("""
        SELECT structures, structures_status, agent_id, tenant_id
        FROM memory_records WHERE memory_id = $1
    """, memory_id)

    required = set(record["structures"])  # e.g. {"tree", "graph"}
    completed = {
        k for k, v in record["structures_status"].items()
        if v == "completed"
    }

    if required == completed:
        # 所有结构构建完成，触发 Indexing Pipeline
        await self.kafka_producer.send(
            topic="ams.pipeline.indexing",
            key=memory_id,
            value={
                "message_id": str(uuid4()),
                "tenant_id": record["tenant_id"],
                "agent_id": record["agent_id"],
                "memory_id": memory_id,
                "completed_structures": list(completed),
                "index_payload": await self._build_index_payload(memory_id)
            }
        )
```

---

## 8. Pipeline 5 — Indexing Pipeline

### 8.1 触发条件与职责

- **消费 Topic**：`ams.pipeline.indexing`
- **触发时机**：所有 `structures_status` key 均为 `"completed"` 时，由最后完成的 Pipeline Worker 发布消息
- **职责**：将记忆写入 Elasticsearch 全文索引，并更新 PG 中的记忆状态为 `active`（对外可见）

### 8.2 Elasticsearch 索引写入

```python
class IndexingPipeline:
    ES_INDEX = "ams_memories"

    async def process(self, msg: dict) -> None:
        if await self._is_processed(msg["message_id"]):
            return

        memory_id = msg["memory_id"]
        payload = msg["index_payload"]

        # Step 1: 从 PG 获取完整记忆元数据（补充 index_payload 可能缺少的字段）
        record = await self.pg_client.fetchrow("""
            SELECT memory_id, tenant_id, agent_id, memory_type, memory_subtype,
                   source_type, title, summary, importance, decay_weight,
                   created_at, tags
            FROM memory_records WHERE memory_id = $1
        """, memory_id)

        # Step 2: 写入 Elasticsearch
        es_doc = {
            "memory_id": str(record["memory_id"]),
            "tenant_id": str(record["tenant_id"]),
            "agent_id": str(record["agent_id"]),
            "memory_type": record["memory_type"],
            "memory_subtype": record["memory_subtype"] or "",
            "source_type": record["source_type"],
            "title": record["title"] or "",
            "summary": record["summary"] or "",
            "content_text": payload.get("content_text", ""),  # 全文，用于 BM25
            "tags": record["tags"] or [],
            "importance": float(record["importance"]),
            "decay_weight": float(record["decay_weight"]),
            "created_at": record["created_at"].isoformat()
        }

        await self.es_client.index(
            index=self.ES_INDEX,
            id=str(memory_id),
            document=es_doc,
            op_type="index"  # upsert 语义：若已存在则覆盖
        )

        # Step 3: 更新 PG status = 'active'（记忆现在对外可见）
        await self.pg_client.execute("""
            UPDATE memory_records
            SET status = 'active',
                updated_at = now()
            WHERE memory_id = $1
        """, memory_id)

        await self._mark_processed(msg["message_id"])
```

### 8.3 Elasticsearch Index 设计

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "ik_smart_analyzer": {
          "type": "custom",
          "tokenizer": "ik_smart"
        }
      }
    },
    "similarity": {
      "custom_bm25": {
        "type": "BM25",
        "k1": 1.2,
        "b": 0.75
      }
    }
  },
  "mappings": {
    "properties": {
      "memory_id":    {"type": "keyword"},
      "tenant_id":    {"type": "keyword"},
      "agent_id":     {"type": "keyword"},
      "memory_type":  {"type": "keyword"},
      "source_type":  {"type": "keyword"},
      "title": {
        "type": "text",
        "analyzer": "ik_smart_analyzer",
        "similarity": "custom_bm25",
        "fields": {"keyword": {"type": "keyword", "ignore_above": 500}}
      },
      "summary": {
        "type": "text",
        "analyzer": "ik_smart_analyzer",
        "similarity": "custom_bm25"
      },
      "content_text": {
        "type": "text",
        "analyzer": "ik_smart_analyzer",
        "similarity": "custom_bm25"
      },
      "tags":         {"type": "keyword"},
      "importance":   {"type": "float"},
      "decay_weight": {"type": "float"},
      "created_at":   {"type": "date"}
    }
  }
}
```

---

## 9. 错误处理与幂等性设计

### 9.1 幂等性保证

幂等性是分布式消息处理的首要保证。MPP 在三个层面确保幂等：

```python
class IdempotencyGuard:
    """统一的幂等性检查器，每个 Pipeline Worker 依赖此类"""
    PROCESSED_TTL = 86400  # 24小时，覆盖 Kafka 最大重试窗口

    async def is_processed(self, message_id: str) -> bool:
        key = f"mpp:processed:{message_id}"
        return await self.redis.exists(key)

    async def mark_processing(self, message_id: str) -> bool:
        """
        原子性地标记"处理中"，防止多个 Pod 同时处理同一消息。
        使用 SET NX EX（Set if Not eXists，带过期时间）。
        Returns: True 表示成功获锁，False 表示已被其他 Pod 处理
        """
        key = f"mpp:processing:{message_id}"
        result = await self.redis.set(key, "1", nx=True, ex=300)  # 5分钟锁
        return result is not None

    async def mark_processed(self, message_id: str) -> None:
        """标记处理完成，释放锁"""
        await self.redis.set(
            f"mpp:processed:{message_id}", "1", ex=self.PROCESSED_TTL
        )
        await self.redis.delete(f"mpp:processing:{message_id}")
```

**存储层幂等操作规范**：

| 存储 | 幂等写法 |
|---|---|
| PostgreSQL | `INSERT ... ON CONFLICT (memory_id) DO UPDATE SET ...` |
| Milvus | `upsert()` 替代 `insert()` |
| Neo4j | 全部使用 `MERGE` 代替 `CREATE` |
| Elasticsearch | `index()` with explicit `id`（upsert 语义）|
| Redis | `SET key value NX EX ttl`（Set if Not Exists）|

### 9.2 重试策略

```python
class RetryPolicy:
    DELAYS = [0, 30, 300]   # 秒：立即、30s、5min

    async def execute_with_retry(self, fn, msg: dict,
                                   max_attempts: int = 3) -> None:
        attempt = msg.get("_attempt", 0)

        try:
            await fn(msg)
        except Exception as e:
            if attempt < max_attempts - 1:
                # 还有重试次数：延迟重新发布到原 Topic
                delay = self.DELAYS[attempt]
                await asyncio.sleep(delay)
                msg["_attempt"] = attempt + 1
                await self.kafka_producer.send(
                    topic=msg["_original_topic"],
                    key=msg.get("memory_id", ""),
                    value=msg
                )
                logger.warning(
                    f"Message {msg['message_id']} failed attempt {attempt+1}, "
                    f"retrying after {delay}s. Error: {e}"
                )
            else:
                # 重试耗尽：发送到 DLQ
                await self._send_to_dlq(msg, e)
                raise  # 让 Kafka consumer 确认消费，避免无限循环

    async def _send_to_dlq(self, msg: dict, error: Exception) -> None:
        import traceback
        await self.kafka_producer.send(
            topic="ams.pipeline.dlq",
            key=msg.get("_original_topic", "unknown"),
            value={
                "dlq_id": str(uuid4()),
                "original_topic": msg.get("_original_topic", ""),
                "original_message_id": msg.get("message_id", ""),
                "original_message": msg,
                "failure_info": {
                    "error_type": type(error).__name__,
                    "error_message": str(error),
                    "stack_trace": traceback.format_exc(),
                    "attempt_count": msg.get("_attempt", 0) + 1,
                    "last_attempt_at": datetime.utcnow().isoformat() + "Z"
                },
                "created_at": datetime.utcnow().isoformat() + "Z"
            }
        )
        # 同时更新 PG 中的 structures_status 为 "failed"
        if msg.get("memory_id"):
            stage = "tree" if "tree" in msg.get("structures_to_build", []) else "graph"
            await self.pg_client.execute(f"""
                UPDATE memory_records
                SET structures_status = structures_status ||
                    '{{"{ stage }": "failed"}}'::jsonb,
                    updated_at = now()
                WHERE memory_id = $1
            """, msg["memory_id"])
```

### 9.3 部分失败处理

Tree / Graph Construction 中，部分 Block 处理失败不应阻塞整体流程：

```python
# Tree Construction 部分失败示例
async def process_chunks_with_partial_tolerance(
    chunks: list[dict], memory_id: str
) -> dict:
    """
    对每个 chunk 独立处理。单个 chunk 失败不阻塞其他 chunk。
    返回处理统计：{"success": n, "failed": n, "failed_block_ids": [...]}
    """
    results = await asyncio.gather(
        *[process_single_chunk(chunk) for chunk in chunks],
        return_exceptions=True  # 不抛出异常，把异常作为返回值
    )

    success_count = 0
    failed_ids = []
    for chunk, result in zip(chunks, results):
        if isinstance(result, Exception):
            logger.error(f"Block {chunk['block_id']} failed: {result}")
            failed_ids.append(chunk["block_id"])
        else:
            success_count += 1

    if failed_ids:
        # 记录失败的 block，允许后续单独重试
        await record_partial_failures(memory_id, failed_ids)

    # 即使有部分失败，只要有成功的 block，仍继续后续流程
    if success_count > 0:
        return {"success": success_count, "failed": len(failed_ids),
                "failed_block_ids": failed_ids}
    else:
        raise Exception(f"All {len(chunks)} blocks failed for memory {memory_id}")
```

---

## 10. 性能设计

### 10.1 延迟 SLA 目标

| Pipeline | 阶段 | SLA | 说明 |
|---|---|---|---|
| Trace Pipeline | 端到端 | < 15s p95 | LLM 评分(~2s) + Embedding(~0.5s) + Graph触发(~0.5s) |
| Session Archive Pipeline | 端到端 | < 30s p95 | 内容构建 + Graph触发 |
| Tree Construction | 单文档 50 blocks | < 60s p95 | Embedding批量(~15s) + LLM摘要(~30s) + Neo4j写入(~10s) |
| Graph Construction | 单文档 50 实体 | < 90s p95 | NER(~20s) + 关系抽取(~50s) + Milvus写入(~10s) |
| Community Detection | 全图 10K 节点 | < 5min | Leiden算法(~30s) + Community Summary LLM(~4min) |
| Indexing Pipeline | 单条记忆 | < 5s p95 | ES写入 + PG状态更新 |

### 10.2 LLM 调用批处理优化

LLM API 是 Pipeline 的性能瓶颈。关键优化策略：

```python
class BatchEmbeddingService:
    """
    收集批量 Embedding 请求，达到阈值或超时后统一发送。
    显著减少 API 调用次数（32条/批 vs 1条/调用，节省约 80% 调用次数）。
    """
    BATCH_SIZE = 32
    FLUSH_TIMEOUT_MS = 100  # 最多等待 100ms 再发送

    async def embed_batch(self, texts: list[str],
                           model: str = "text-embedding-3-small") -> list[list[float]]:
        """批量 Embedding，内部自动分批"""
        all_embeddings = []
        for i in range(0, len(texts), self.BATCH_SIZE):
            batch = texts[i:i + self.BATCH_SIZE]
            resp = await self.openai_client.embeddings.create(
                input=batch,
                model=model
            )
            all_embeddings.extend([e.embedding for e in resp.data])
        return all_embeddings


class LLMCallCache:
    """
    对 NER 结果缓存（相同 chunk content → 相同 NER 结果）。
    适用场景：相同文档被多个 Agent 摄入（公共知识库）
    """
    TTL = 3600  # 1 小时

    async def get_or_compute(self, cache_key: str,
                              compute_fn) -> any:
        cached = await self.redis.get(f"llm_cache:{cache_key}")
        if cached:
            import json
            return json.loads(cached)

        result = await compute_fn()
        await self.redis.set(
            f"llm_cache:{cache_key}",
            json.dumps(result),
            ex=self.TTL
        )
        return result
```

### 10.3 背压控制（Backpressure）

```python
class BackpressureController:
    """
    监控下游依赖的响应延迟，动态调节消费速率。
    """
    async def check_and_throttle(self) -> None:
        """在每条消息处理前调用，必要时限流"""

        # 检查 LLM API 速率限制
        if self.llm_rate_limiter.is_limited():
            wait_seconds = self.llm_rate_limiter.retry_after()
            logger.warning(f"LLM rate limited, waiting {wait_seconds}s")
            await asyncio.sleep(wait_seconds)

        # 检查 Milvus 写入延迟
        if self.milvus_latency_p99 > 500:  # ms
            # 减小批量写入大小，减轻 Milvus 压力
            self.milvus_batch_size = max(8, self.milvus_batch_size // 2)
            logger.warning(
                f"Milvus p99 latency {self.milvus_latency_p99}ms, "
                f"reducing batch size to {self.milvus_batch_size}"
            )

        # 检查 PG 连接池
        if self.pg_pool.get_size() - self.pg_pool.get_idle_size() > 0.9 * self.pg_pool.get_size():
            # 连接池使用率 > 90%：暂停 100ms
            await asyncio.sleep(0.1)
```

---

## 11. 可观测性

### 11.1 Prometheus 指标

```yaml
# Pipeline 处理持续时间（按 pipeline_type 和 stage 拆分）
- name: mpp_pipeline_processing_duration_seconds
  type: histogram
  labels: [pipeline_type, stage]
  buckets: [0.1, 0.5, 1.0, 5.0, 15.0, 30.0, 60.0, 90.0]

# 消息处理计数（按 status 拆分）
- name: mpp_messages_processed_total
  type: counter
  labels: [pipeline_type, status]  # status: success / failure / dlq_sent

# LLM 调用统计
- name: mpp_llm_calls_total
  type: counter
  labels: [model, operation]  # operation: importance_score / ner_extract / relation_extract / summary / community_summary

- name: mpp_llm_call_duration_seconds
  type: histogram
  labels: [model, operation]
  buckets: [0.1, 0.5, 1.0, 2.0, 5.0, 10.0]

# Kafka Consumer Lag（最关键的队列积压指标）
- name: mpp_kafka_consumer_lag
  type: gauge
  labels: [topic, partition]

# 创建的实体/块数量（追踪数据增长速率）
- name: mpp_blocks_created_total
  type: counter
  labels: [source_type]

- name: mpp_phrase_nodes_created_total
  type: counter
  labels: [source_type, layer_mode]

# Leiden 社区检测
- name: mpp_community_detection_duration_seconds
  type: histogram
  buckets: [30.0, 60.0, 120.0, 300.0]

- name: mpp_communities_detected_total
  type: counter
  labels: [agent_id, action]  # action: created / updated

# DLQ 深度（告警依据）
- name: mpp_dlq_depth
  type: gauge
  labels: [original_topic]
```

### 11.2 分布式链路追踪

MPP 从 Kafka 消息 Header 中读取 OTel Trace Context，保持与 AMS 的链路连通：

```python
from opentelemetry import trace
from opentelemetry.propagate import extract
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

class TracePropagationMiddleware:
    async def process_with_trace(self, kafka_msg, pipeline_fn) -> None:
        # 从 Kafka Headers 中提取 Trace Context
        headers = {k: v.decode() for k, v in kafka_msg.headers}
        ctx = extract(headers)  # W3C TraceContext format

        tracer = trace.get_tracer("mpp")
        with tracer.start_as_current_span(
            name=f"mpp.{pipeline_fn.__name__}",
            context=ctx,
            kind=trace.SpanKind.CONSUMER
        ) as span:
            span.set_attribute("memory_id", kafka_msg.value.get("memory_id", ""))
            span.set_attribute("source_type", kafka_msg.value.get("source_type", ""))
            span.set_attribute("pipeline_type", pipeline_fn.__name__)

            try:
                await pipeline_fn(kafka_msg.value)
                span.set_status(trace.StatusCode.OK)
            except Exception as e:
                span.record_exception(e)
                span.set_status(trace.StatusCode.ERROR, str(e))
                raise
```

### 11.3 Prometheus 告警规则

```yaml
groups:
  - name: mpp_alerts
    rules:
      # Kafka 积压告警
      - alert: MPPKafkaConsumerLagHigh
        expr: mpp_kafka_consumer_lag{topic=~"ams.pipeline.*"} > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pipeline Kafka lag is high ({{ $value }} messages)"
          description: "Topic {{ $labels.topic }} partition {{ $labels.partition }} lag > 10000 for 5 minutes"

      # DLQ 积压告警
      - alert: MPPDLQDepthHigh
        expr: mpp_dlq_depth > 100
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Pipeline DLQ depth is high ({{ $value }} messages)"

      - alert: MPPDLQDepthCritical
        expr: mpp_dlq_depth > 500
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Pipeline DLQ critical - possible systemic failure"

      # Pipeline 处理延迟告警（超过 SLA 2倍）
      - alert: MPPProcessingLatencyHigh
        expr: |
          histogram_quantile(0.95,
            rate(mpp_pipeline_processing_duration_seconds_bucket[5m])
          ) > 180  # Tree Construction SLA 60s * 2 = 120s, 取 180s 余量
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pipeline p95 latency {{ $value }}s exceeds 2× SLA"

      # LLM 错误率告警
      - alert: MPPLLMErrorRateHigh
        expr: |
          rate(mpp_messages_processed_total{status="failure"}[5m]) /
          rate(mpp_messages_processed_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pipeline failure rate {{ $value | humanizePercentage }}"
```

---

## 12. 部署配置

### 12.1 Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ams-pipeline-workers
  namespace: agent-memory
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ams-pipeline-workers
  template:
    metadata:
      labels:
        app: ams-pipeline-workers
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      containers:
        - name: pipeline-worker
          image: registry.internal/ams-pipeline-workers:latest
          ports:
            - name: metrics
              containerPort: 9090
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "4"
              memory: "8Gi"   # NER + LLM 并发调用内存需求
          env:
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: kafka.brokers
            - name: KAFKA_CONSUMER_GROUP
              value: "ams-pipeline-workers"
            - name: KAFKA_TOPICS
              value: "ams.trace.ingested,ams.session.archive,ams.pipeline.structure,ams.pipeline.indexing"
            - name: AMS_GRPC_ENDPOINT
              value: "ams.agent-memory.svc:9090"
            - name: POSTGRES_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: postgres.url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: redis.url
            - name: NEO4J_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: neo4j.url
            - name: MILVUS_HOST
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: milvus.host
            - name: ELASTICSEARCH_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: elasticsearch.url
            - name: LLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: llm.api.key
            - name: LLM_BASE_URL
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: llm.base.url
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 30
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: ams-pipeline-workers
                topologyKey: kubernetes.io/hostname
```

### 12.2 关键配置（config.yaml）

```yaml
# ═══════════════════════════════════════════════
# MPP 关键配置（全部参数含默认值和说明）
# ═══════════════════════════════════════════════

kafka:
  consumer_group: "ams-pipeline-workers"
  max_poll_interval_ms: 300000    # 5分钟，覆盖最长的 LLM 处理时间
  session_timeout_ms: 60000       # 1分钟 heartbeat 超时
  auto_offset_reset: "earliest"   # 新消费者从最早偏移量开始消费（支持重放）
  enable_auto_commit: false        # 手动提交 offset，确保处理完成后再确认

chunking:
  default_strategy: "heading_based"
  max_tokens_per_chunk: 1500      # heading_based 策略的单块最大 token 数
  fixed_size_tokens: 512          # fixed_size 策略的块大小
  overlap_tokens: 64              # fixed_size 策略的重叠大小
  min_chunk_tokens: 50            # 小于此阈值的 chunk 合并到上一块

embedding:
  model: "text-embedding-3-small"
  batch_size: 32                  # 每次 API 调用的最大文本数
  cache_ttl_seconds: 3600         # Embedding 结果缓存时间（相同内容复用）

ner:
  fast_model: "zh_core_web_trf"   # spaCy 中文模型（Transformer 版）
  llm_model: "gpt-4o-mini"        # LLM 精准 NER 模型
  high_value_threshold: 0.7       # 低于此置信度的 chunk 触发 LLM 精提
  max_entities_per_doc: 200       # 单文档最大实体数，超出时丢弃置信度最低的

relation_extraction:
  model: "gpt-4o-mini"
  max_entity_pairs_per_chunk: 45  # C(10,2) = 45，chunk 内最多 10 个实体
  min_relation_weight: 0.3        # 低于此置信度的关系丢弃

community_detection:
  algorithm: "leiden"
  resolution: 1.0                 # Leiden 分辨率参数（越大社区越小）
  n_iterations: 10                # Leiden 迭代次数
  threshold_new_nodes: 500        # 触发检测的新增节点数阈值
  cron_schedule: "0 3 * * *"      # 每日 03:00 全量检测
  max_community_size: 200         # 超过此大小的社区跳过摘要生成（性能保护）

llm:
  importance_scorer_model: "gpt-4o-mini"
  summary_model: "gpt-4o-mini"
  community_summary_model: "gpt-4o-mini"  # 社区摘要可用更好的模型
  max_concurrent_calls: 8         # asyncio Semaphore 限制并发 LLM 调用数
  request_timeout_seconds: 30
  retry_on_rate_limit: true

novelty_check:
  similarity_threshold: 0.92      # 余弦相似度 > 此值视为近似重复
  update_existing_importance_boost: 0.02  # 命中近似记忆时的重要性增量

retry:
  max_attempts: 3
  delays_seconds: [0, 30, 300]    # 重试延迟：立即、30s、5min

milvus:
  max_concurrent_writes: 16       # asyncio Semaphore 限制并发 Milvus 写入数

neo4j:
  connection_pool_size: 10        # Neo4j 连接池大小

promotion_score_threshold: 0.6    # Session 归档的最低提升分数（与 AMS 配置保持一致）
```

### 12.3 依赖服务版本矩阵

| 依赖服务 | 最低版本 | 推荐版本 | 说明 |
|---|---|---|---|
| Apache Kafka | 3.5 | 3.7 | 需要 KRaft 模式（无 ZooKeeper 依赖）|
| PostgreSQL | 15.0 | 16.x | JSONB `||` 原子合并语义 |
| Redis | 7.0 | 7.2 | SET NX EX 命令（幂等锁）|
| Neo4j | 5.0 | 5.20 | GDS 插件 >= 2.5（Leiden 算法支持）|
| Milvus | 2.3 | 2.4 | Upsert API 支持 |
| Elasticsearch | 8.0 | 8.14 | IK 分析器支持中文分词 |
| Python | 3.11 | 3.12 | asyncio 性能优化 |
| leidenalg | 0.10 | latest | Leiden 算法 Python 绑定 |
| spaCy | 3.7 | latest | `zh_core_web_trf` 模型支持 |
| tree-sitter-languages | 1.8 | latest | 多语言代码解析 |

---

## 附录：Pipeline Worker 启动与健康检查

```python
class MPPWorkerApp:
    """MPP Worker 主应用，统一管理所有 Pipeline 的 Kafka 消费循环"""

    def __init__(self, config: MPPConfig):
        self.config = config
        self.pipelines = {
            "ams.trace.ingested":      TracePipeline(config),
            "ams.session.archive":     SessionArchivePipeline(config),
            "ams.pipeline.structure":  StructurePipelineRouter(config),  # 路由到 Tree/Graph
            "ams.pipeline.indexing":   IndexingPipeline(config),
        }
        self.health_server = HealthCheckServer()

    async def start(self) -> None:
        """启动所有 Consumer 和健康检查服务"""
        await asyncio.gather(
            self._consume_all_topics(),
            self.health_server.start(port=8080)
        )

    async def _consume_all_topics(self) -> None:
        """启动 Kafka Consumer，分发到对应 Pipeline"""
        consumer = AIOKafkaConsumer(
            *list(self.pipelines.keys()),
            bootstrap_servers=self.config.kafka.brokers,
            group_id=self.config.kafka.consumer_group,
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            max_poll_interval_ms=300000
        )
        await consumer.start()
        try:
            async for msg in consumer:
                topic = msg.topic
                pipeline = self.pipelines.get(topic)
                if pipeline:
                    await pipeline.process(msg.value)
                    await consumer.commit()
        finally:
            await consumer.stop()


class HealthCheckServer:
    """提供 Kubernetes Readiness / Liveness Probe 端点"""

    async def handle_ready(self, request):
        """Readiness: 检查所有依赖服务连通性"""
        checks = {
            "kafka": await self._check_kafka(),
            "postgres": await self._check_postgres(),
            "redis": await self._check_redis(),
            "neo4j": await self._check_neo4j(),
            "milvus": await self._check_milvus(),
        }
        if all(checks.values()):
            return web.Response(text="OK", status=200)
        failed = [k for k, v in checks.items() if not v]
        return web.Response(text=f"Not ready: {failed}", status=503)

    async def handle_live(self, request):
        """Liveness: 检查进程是否正常运行（无死锁等）"""
        # 简单检查：Kafka consumer 是否仍在活跃消费
        if self.consumer_is_alive:
            return web.Response(text="OK", status=200)
        return web.Response(text="Consumer dead", status=503)
```

---

*下一步：[03-Storage-and-Retrieval 详细设计](./03-Storage-and-Retrieval.md) — 存储引擎协调、双模式检索详细实现（Lightweight: 4路并行+RRF; Agentic: LLM扩展+多轮迭代）*
