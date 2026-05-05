---
title: "06-Agent-TES 详细设计"
date: 2026-03-23T22:00:00+08:00
draft: true
tags: ["agent-memory", "telemetry", "tes", "opentelemetry", "详细设计", "版本B"]
---

# Agent-TES 遥测系统详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: 采集 Agent 执行轨迹，生成结构化 Evidence，驱动记忆写入和质量监控

---

## 1. 模块定位与职责

### 1.1 在系统中的位置

Agent-TES（Trace & Evidence System）是系统的**观测层**，无侵入地采集 Agent 运行时数据，并将原始遥测信号转化为结构化 Evidence 向下游传递。

```
Agent Framework ──(OpenTelemetry Span)──→ TES Collector
                                               │
                                               ├──→ ClickHouse（原始轨迹持久化）
                                               ├──→ Kafka agent.evidence.raw（结构化 Evidence）
                                               └──→ Prometheus（实时指标）
```

**TES 的核心价值**：
- **解耦观测与业务**：Agent Framework 只需埋标准 OTel Span，无需知道数据如何处理
- **统一入口**：所有 Agent 遥测数据的单一汇聚点，便于运维和审计
- **证据生产**：将"执行日志"转化为"可学习的 Evidence"，驱动 Skill-MDS 和记忆演化

### 1.2 三层遥测架构

```
┌──────────────────────────────────────────────────────────┐
│ Layer 1: 原始 Trace（OpenTelemetry Span）                 │
│   - Think / Act / Observe 每步一个 Span                   │
│   - 包含 agent_id, session_id, tool_name, latency 等属性  │
└─────────────────────────┬────────────────────────────────┘
                          │ OTLP (gRPC)
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 2: 结构化 Evidence（TES 加工后）                    │
│   - 将 Span 聚合为任务级别的执行摘要                       │
│   - 标注 skill_name（若使用了技能）                        │
│   - 输出到 Kafka agent.evidence.raw                       │
└─────────────────────────┬────────────────────────────────┘
                          │ Kafka
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 3: 聚合指标（Prometheus + Grafana）                 │
│   - P50/P95/P99 延迟、成功率、工具使用频率                 │
│   - 技能成功率趋势、告警触发                               │
└──────────────────────────────────────────────────────────┘
```

---

## 2. OpenTelemetry 集成

### 2.1 Span 规范

Agent Framework 每个关键节点创建一个 Span，属性命名遵循语义约定：

```python
# Agent Framework 统一埋点规范
SPAN_ATTRIBUTES = {
    # 必填
    "agent.id":              str,   # agent_001
    "agent.session_id":      str,   # sess_abc123
    "agent.task_id":         str,   # task_xyz456
    "agent.node_type":       str,   # think / act / observe / compress / flush

    # Think 节点
    "agent.turn_number":     int,
    "agent.context_tokens":  int,   # 当前 context window 占用
    "agent.retrieved_memory_count": int,

    # Act 节点
    "agent.tool_name":       str,   # chardet.detect / pd.read_csv / ...
    "agent.tool_success":    bool,

    # Session 级别（flush 节点设置）
    "agent.outcome":         str,   # success / failure / partial
    "agent.total_turns":     int,
    "agent.skill_used":      str,   # 若本次使用了技能，记录技能名
}
```

### 2.2 Span 生命周期示例

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

# Agent Framework 初始化（启动时一次）
provider = TracerProvider()
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://tes-collector.monitoring.svc:4317"))
)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("agent_framework", version="1.0.0")

# 在 think_node 中埋点
async def think_node(state: AgentState) -> AgentState:
    with tracer.start_as_current_span("agent.think") as span:
        span.set_attribute("agent.id",              state["agent_id"])
        span.set_attribute("agent.session_id",      state["session_id"])
        span.set_attribute("agent.turn_number",     state["turn_number"])
        span.set_attribute("agent.context_tokens",  state["context_tokens_used"])
        span.set_attribute("agent.retrieved_memory_count",
                           len(state.get("retrieved_memories", [])))

        # ... 实际推理逻辑 ...

        span.set_attribute("agent.tool_calls_planned",
                           len(state["messages"][-1].tool_calls or []))
    return state

# 在 act_node 中埋点（每个工具调用一个子 Span）
async def act_node(state: AgentState) -> AgentState:
    for tool_call in state["messages"][-1].tool_calls:
        with tracer.start_as_current_span("agent.tool_call") as span:
            span.set_attribute("agent.id",       state["agent_id"])
            span.set_attribute("agent.tool_name", tool_call.name)
            try:
                result = await execute_tool(tool_call)
                span.set_attribute("agent.tool_success", True)
            except Exception as e:
                span.set_attribute("agent.tool_success", False)
                span.record_exception(e)
    return state
```

---

## 3. Evidence Schema

### 3.1 什么是 Evidence

Evidence 是 TES 将原始 Span 流聚合后产出的结构化信息单元，**粒度为一次完整任务会话**。

```json
// topic: agent.evidence.raw
{
  "evidence_id":   "ev_abc123456",
  "agent_id":      "agent_001",
  "session_id":    "sess_abc123",
  "task_id":       "task_xyz456",

  // 任务结果
  "outcome":       "success",      // success / failure / partial
  "total_turns":   5,
  "total_latency_ms": 12400,

  // 技能使用情况（可为 null）
  "skill_used":    "csv-encoding-diagnosis",
  "skill_matched": true,           // 技能是否成功匹配并发挥作用

  // 工具使用统计
  "tool_summary": {
    "chardet.detect":  {"calls": 1, "success": 1, "fail": 0},
    "pd.read_csv":     {"calls": 2, "success": 1, "fail": 1}
  },

  // 记忆使用情况
  "memory_retrieved": 3,           // 本次检索到几条记忆
  "memory_layers_hit": ["episode", "procedural"],

  // 时间信息
  "start_time":    "2026-03-23T10:00:00Z",
  "end_time":      "2026-03-23T10:02:04Z",

  // 异常信息（若有）
  "errors": [
    {"turn": 3, "tool": "pd.read_csv", "error_type": "UnicodeDecodeError"}
  ]
}
```

### 3.2 Evidence 生成逻辑

TES Processor 监听 `flush_episode` Span（任务结束标志），触发 Evidence 聚合：

```python
class EvidenceProcessor:
    """
    消费 OpenTelemetry Span，聚合为 Evidence。
    核心逻辑：当收到 node_type=flush 的 Span 时，汇总同一 session 的所有历史 Span。
    """

    async def on_span_end(self, span: ReadableSpan) -> None:
        node_type = span.attributes.get("agent.node_type")

        if node_type != "flush":
            # 非结束节点，缓存 Span
            await self._cache_span(span)
            return

        # 收到 flush，聚合该 session 所有 Span
        session_id = span.attributes.get("agent.session_id")
        session_spans = await self._load_session_spans(session_id)

        evidence = self._aggregate(session_spans, flush_span=span)

        # 发布到 Kafka
        await kafka_producer.send("agent.evidence.raw", evidence.to_dict())

        # 清理缓存
        await self._clear_session_cache(session_id)

    def _aggregate(
        self,
        spans: list[ReadableSpan],
        flush_span: ReadableSpan
    ) -> Evidence:
        tool_spans  = [s for s in spans if s.attributes.get("agent.node_type") == "act"
                                        and "agent.tool_name" in s.attributes]
        think_spans = [s for s in spans if s.attributes.get("agent.node_type") == "think"]

        # 工具调用统计
        tool_summary = {}
        for s in tool_spans:
            tool_name = s.attributes["agent.tool_name"]
            success   = s.attributes.get("agent.tool_success", False)
            if tool_name not in tool_summary:
                tool_summary[tool_name] = {"calls": 0, "success": 0, "fail": 0}
            tool_summary[tool_name]["calls"] += 1
            if success:
                tool_summary[tool_name]["success"] += 1
            else:
                tool_summary[tool_name]["fail"] += 1

        return Evidence(
            evidence_id   = f"ev_{uuid4().hex[:12]}",
            agent_id      = flush_span.attributes["agent.id"],
            session_id    = flush_span.attributes["agent.session_id"],
            outcome       = flush_span.attributes.get("agent.outcome", "unknown"),
            total_turns   = len(think_spans),
            total_latency_ms = sum(
                (s.end_time - s.start_time).microseconds // 1000
                for s in spans
            ),
            skill_used    = flush_span.attributes.get("agent.skill_used"),
            tool_summary  = tool_summary,
            memory_retrieved = max(
                (s.attributes.get("agent.retrieved_memory_count", 0) for s in think_spans),
                default=0
            ),
            start_time    = min(s.start_time for s in spans),
            end_time      = flush_span.end_time,
        )
```

---

## 4. ClickHouse — 执行轨迹持久化

### 4.1 表结构

```sql
-- 原始 Span 表（TES → ClickHouse，按天分区）
CREATE TABLE agent_spans (
    span_id          String,
    trace_id         String,
    parent_span_id   String,
    agent_id         String,
    session_id       String,
    task_id          String,
    node_type        String,    -- think / act / observe / flush
    tool_name        String,    -- act 节点使用
    tool_success     UInt8,
    context_tokens   UInt32,
    turn_number      UInt16,
    start_time       DateTime64(3, 'UTC'),
    end_time         DateTime64(3, 'UTC'),
    latency_ms       Float32,
    attributes       String     -- JSON 存储其余属性
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (agent_id, session_id, start_time)
TTL start_time + INTERVAL 90 DAY;   -- 90天自动过期


-- 技能会话汇总表（用于 Skill-MDS 共现分析）
CREATE TABLE agent_skill_sessions (
    session_id       String,
    agent_id         String,
    skill_sequence   Array(String),   -- 本次会话使用的技能序列
    outcome          String,
    event_time       DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_time)
ORDER BY (agent_id, event_time)
TTL event_time + INTERVAL 180 DAY;
```

### 4.2 典型分析查询

```sql
-- 查询某 Agent 最常使用的工具 TOP 10（近30天）
SELECT tool_name, count() AS call_count,
       sum(tool_success) / count() AS success_rate,
       avg(latency_ms) AS avg_latency_ms
FROM agent_spans
WHERE agent_id = 'agent_001'
  AND node_type = 'act'
  AND start_time >= now() - INTERVAL 30 DAY
GROUP BY tool_name
ORDER BY call_count DESC
LIMIT 10;

-- 查询每日任务成功率趋势
SELECT toDate(start_time) AS day,
       countIf(outcome = 'success') / count() AS success_rate,
       count() AS total_tasks
FROM agent_skill_sessions
WHERE agent_id = 'agent_001'
GROUP BY day
ORDER BY day DESC;

-- 查询平均 context window 使用率（识别频繁触发压缩的 Agent）
SELECT agent_id,
       avg(context_tokens) AS avg_context,
       max(context_tokens) AS max_context
FROM agent_spans
WHERE node_type = 'think'
  AND start_time >= now() - INTERVAL 7 DAY
GROUP BY agent_id
ORDER BY avg_context DESC;
```

---

## 5. Prometheus 实时指标

### 5.1 暴露的 Metrics

TES Collector 同时将 Span 数据转化为 Prometheus 指标（通过 OpenTelemetry Collector Pipeline）：

```yaml
# otel-collector-config.yaml（部分）
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  # 从 Span 属性中提取指标
  spanmetrics:
    metrics_exporter: prometheus
    dimensions:
      - agent.id
      - agent.node_type
      - agent.tool_name
      - agent.outcome

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  clickhouse:
    endpoint: tcp://clickhouse.data.svc:9000
  kafka:
    protocol_version: "3.0.0"
    brokers: ["kafka.middleware.svc:9092"]
    topic: agent.spans.raw
```

### 5.2 核心指标定义

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `agent_task_duration_seconds` | Histogram | agent_id, outcome | 任务完成时间分布 |
| `agent_tool_call_total` | Counter | agent_id, tool_name, success | 工具调用次数 |
| `agent_context_tokens` | Gauge | agent_id | 当前 context 使用量 |
| `agent_memory_retrieval_total` | Counter | agent_id, layer | 各记忆层检索次数 |
| `agent_skill_used_total` | Counter | agent_id, skill_name, success | 技能使用统计 |
| `agent_compress_context_total` | Counter | agent_id | 上下文压缩触发次数 |

### 5.3 告警规则

```yaml
# Prometheus AlertManager 规则
groups:
  - name: agent_quality
    rules:
      # Agent 任务成功率低
      - alert: AgentTaskSuccessRateLow
        expr: |
          rate(agent_task_success_total[1h]) /
          rate(agent_task_total[1h]) < 0.6
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Agent {{ $labels.agent_id }} 任务成功率低于 60%"

      # 某工具失败率突增
      - alert: ToolFailureRateHigh
        expr: |
          rate(agent_tool_call_total{success="false"}[15m]) /
          rate(agent_tool_call_total[15m]) > 0.5
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "工具 {{ $labels.tool_name }} 失败率超 50%"

      # Context Window 频繁压缩
      - alert: ContextCompressionFrequent
        expr: rate(agent_compress_context_total[1h]) > 5
        for: 20m
        labels:
          severity: warning
        annotations:
          summary: "Agent {{ $labels.agent_id }} 频繁触发 Context 压缩，建议检查任务复杂度"
```

---

## 6. TES Sidecar 部署模式

### 6.1 Sidecar 架构

每个 Agent Framework Pod 旁挂一个 OTel Collector Sidecar，负责本地 Span 的收集和转发：

```yaml
# Agent Framework Pod Spec
spec:
  containers:
    # 主容器：Agent Framework
    - name: agent-framework
      image: agent-framework:latest
      env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://localhost:4317"   # 发到同 Pod 的 Sidecar
        - name: OTEL_SERVICE_NAME
          value: "agent-framework"

    # Sidecar 容器：OTel Collector
    - name: otel-collector
      image: otel/opentelemetry-collector-contrib:latest
      ports:
        - containerPort: 4317   # OTLP gRPC（接收来自主容器）
        - containerPort: 8889   # Prometheus metrics（供 Prometheus 抓取）
      volumeMounts:
        - name: otel-config
          mountPath: /etc/otelcol
  volumes:
    - name: otel-config
      configMap:
        name: otel-collector-config
```

### 6.2 数据链路延迟目标

| 阶段 | 延迟目标 | 说明 |
|------|---------|------|
| Span 生成 → Sidecar 接收 | < 1ms | 本地 gRPC，几乎无延迟 |
| Sidecar → ClickHouse | < 500ms | 批量写入，Batch 大小 1000 |
| Sidecar → Kafka | < 100ms | 异步发送 |
| Kafka → MPP 消费 | < 5s | MPP 消费延迟（最终一致）|
| 全链路（Span → Episode 写入）| < 30s | 异步处理，非关键路径 |

---

## 7. 上下游关系汇总

### 7.1 TES 接收哪些数据？

| 来源 | 协议 | 数据类型 |
|------|------|---------|
| Agent Framework | OTLP gRPC (OTel Span) | Think/Act/Observe/Flush Span |

### 7.2 TES 输出到哪里？

| 目标 | 协议 | 数据 | 用途 |
|------|------|------|------|
| **ClickHouse** | TCP | 原始 Span | 执行轨迹持久化、离线分析 |
| **Kafka** `agent.evidence.raw` | Kafka Producer | Evidence JSON | MPP 消费，更新技能指标 |
| **Prometheus** | HTTP Pull | Metrics | 实时监控、告警 |

### 7.3 哪些服务依赖 TES？

| 服务 | 依赖形式 | 说明 |
|------|---------|------|
| **MPP FeedbackAggregator** | Kafka 消费 | 消费 Evidence 更新技能成功率 |
| **Skill-MDS** | ClickHouse 查询 | 技能共现分析（直接查 ClickHouse）|
| **Grafana** | Prometheus 数据源 | 可视化监控面板 |

---

*下一步：[07-API-Design 详细设计](./07-API-Design.md)*
