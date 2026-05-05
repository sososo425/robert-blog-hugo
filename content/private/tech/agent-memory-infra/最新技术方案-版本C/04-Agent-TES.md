---
title: "04-Agent-TES 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "telemetry", "tes", "opentelemetry", "详细设计", "版本C"]
---

# Agent-TES 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: 系统的"感官层"——以零代码侵入的方式采集 Agent 执行轨迹，将运行时信号转化为结构化记忆原料。

---

## 1. 模块定位与职责

### 1.1 在认知飞轮中的位置

Agent-TES（Telemetry & Evidence System）是认知飞轮的**数据入口**，解决的核心问题是：

**如何在不修改 Agent 业务逻辑代码的前提下，完整捕获 Agent 的思考-行动-观察循环？**

```
Agent Framework ──[OTel Span]──→ TES Collector ──→ Kafka ams.trace.ingested
                                       │
                                       ├──→ ClickHouse（原始轨迹，90天）
                                       └──→ Prometheus（实时指标）
```

**与版本B的关键差异**：版本C 的 TES 不再向 Kafka 发送 `agent.evidence.raw`（版本B的中间格式），而是直接产出 `ams.trace.ingested`——这与版本C的 Pipeline 设计对齐，Trace 直接进入 AMS Pipeline 体系，无需独立的 Evidence 格式中间层。

### 1.2 三大职责

| 职责 | 说明 |
|---|---|
| **遥测采集** | 通过 Sidecar + OTel Collector 无侵入采集 Agent 推理链（Think/Act/Observe/Flush）|
| **会话边界检测** | 通过 `flush` Span 感知任务结束，将分散的 Span 聚合为完整的执行记录 |
| **数据发布** | 将聚合后的执行记录发布到 Kafka `ams.trace.ingested`，驱动记忆生成 |

### 1.3 非侵入式设计原则

**Agent Framework 的最低接入成本**：只需在启动时添加 OTel SDK 初始化代码，并在关键节点（think/act/flush）创建 Span，业务逻辑代码零修改。

不需要：
- 调用任何 AMS API
- 关心记忆写入逻辑
- 知道 Kafka/Pipeline 的存在

---

## 2. 采集架构

### 2.1 Sidecar 部署模式（推荐）

每个 Agent Framework Pod 旁挂一个 OTel Collector Sidecar，本地接收 Span，完成聚合和转发：

```
┌────────────────────────────────────────────────────────┐
│                   Agent Framework Pod                  │
│                                                        │
│  ┌──────────────────────┐    ┌─────────────────────┐   │
│  │  Agent Framework     │    │   OTel Collector     │   │
│  │  (主容器)             │    │   Sidecar            │   │
│  │                      │    │                     │   │
│  │  - Think Node        │    │  receivers:          │   │
│  │  - Act Node          │──→ │    otlp (gRPC:4317) │   │
│  │  - Observe Node      │    │                     │   │
│  │  - Flush Node        │    │  processors:         │   │
│  │                      │    │    span_aggregator   │   │
│  │  OTEL_ENDPOINT=      │    │    session_detector  │   │
│  │  localhost:4317      │    │                     │   │
│  └──────────────────────┘    │  exporters:          │   │
│                              │    kafka (trace)     │   │
│                              │    clickhouse (raw)  │   │
│                              │    prometheus        │   │
│                              └─────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

```yaml
# Agent Framework Pod Spec（关键部分）
spec:
  containers:
    - name: agent-framework
      image: registry.internal/agent-framework:latest
      env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://localhost:4317"   # 本地 Sidecar，无网络跳转
        - name: OTEL_SERVICE_NAME
          value: "agent-framework"
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: "deployment.environment=production"
        - name: OTEL_TRACES_SAMPLER
          value: "parentbased_traceidratio"
        - name: OTEL_TRACES_SAMPLER_ARG
          value: "1.0"                    # 采样率，见 §5 动态采样

    - name: otel-collector
      image: otel/opentelemetry-collector-contrib:0.100.0
      args: ["--config=/etc/otelcol/config.yaml"]
      ports:
        - name: otlp-grpc
          containerPort: 4317
        - name: metrics
          containerPort: 8889
      resources:
        requests:
          cpu: "100m"
          memory: "256Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
      volumeMounts:
        - name: otel-config
          mountPath: /etc/otelcol
  volumes:
    - name: otel-config
      configMap:
        name: tes-collector-config
```

### 2.2 OTel Collector 配置（版本C）

```yaml
# tes-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 32

processors:
  # 内存限制保护（防止 OOM）
  memory_limiter:
    limit_mib: 400
    spike_limit_mib: 100
    check_interval: 5s

  # Batch：积累一定量 Span 后批量写出（提高吞吐）
  batch:
    send_batch_size: 512
    timeout: 1s

  # 自定义处理器：Session 聚合 + Flush 检测（见 §3）
  # 此处使用 transform processor 添加路由属性
  transform:
    trace_statements:
      - context: span
        statements:
          # 标记是否为 flush span
          - set(attributes["tes.is_flush"],
              attributes["agent.node_type"] == "flush")

exporters:
  # 发布到 Kafka ams.trace.ingested（聚合后的完整 Trace）
  # 注意：实际的聚合逻辑在 TES Aggregator 服务中（见 §3），
  #       Collector 只负责将原始 Span 转发到 Kafka 原始通道
  kafka/spans:
    protocol_version: "3.7.0"
    brokers:
      - kafka.middleware.svc:9092
    topic: ams.spans.raw       # 原始 Span 流（给 TES Aggregator 消费）
    encoding: otlp_proto       # OTel 原生格式

  # ClickHouse：持久化原始 Span（用于离线分析）
  clickhouse:
    endpoint: tcp://clickhouse.data.svc:9000
    database: agent_telemetry
    ttl: 2160h   # 90天
    timeout: 10s
    retry_on_failure:
      enabled: true
      max_elapsed_time: 300s

  # Prometheus：实时指标（spanmetrics processor）
  prometheus:
    endpoint: "0.0.0.0:8889"

  # 日志导出（调试用）
  logging:
    verbosity: normal

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777

service:
  extensions: [health_check, pprof]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, transform, batch]
      exporters: [kafka/spans, clickhouse, logging]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

---

## 3. Agent Framework 埋点规范

### 3.1 OTel Span 属性规范（版本C）

```python
# ═══════════════════════════════════════════════════════════
# Agent Framework OTel 埋点规范（版本C）
# 所有 Span 属性命名遵循 agent.* 命名空间
# ═══════════════════════════════════════════════════════════

# ─── 所有 Span 必填属性 ────────────────────────────────────
COMMON_ATTRIBUTES = {
    "agent.id":          str,    # Agent UUID，如 "agent_001"
    "agent.tenant_id":   str,    # 租户 ID，多租户隔离必填
    "agent.session_id":  str,    # 会话 UUID
    "agent.task_id":     str,    # 任务 UUID（一次任务 = 一次完整的 Think→Act→... →Flush 循环）
    "agent.node_type":   str,    # "think" | "act" | "observe" | "flush"
}

# ─── think 节点附加属性 ─────────────────────────────────────
THINK_ATTRIBUTES = {
    "agent.turn_number":              int,    # 当前轮次（从 1 开始）
    "agent.context_tokens":           int,    # 当前 context window 消耗的 token 数
    "agent.ltm_retrieved_count":      int,    # 本轮从 LTM 检索到的记忆数
    "agent.ltm_retrieval_mode":       str,    # "lightweight" | "agentic" | "none"
    "agent.tool_calls_planned":       int,    # 本轮计划调用的工具数（LLM 决策输出）
    "agent.model":                    str,    # 使用的 LLM 模型（如 "gpt-4o"）
    "agent.confidence":               float,  # [0.0, 1.0] Agent 决策置信度（可选）
}

# ─── act 节点附加属性 ─────────────────────────────────────
ACT_ATTRIBUTES = {
    "agent.tool_name":        str,    # 工具名，如 "sql_query" / "read_file" / "web_search"
    "agent.tool_call_id":     str,    # 本次工具调用的 ID（与 tool_result 关联）
    "agent.tool_success":     bool,   # 工具调用是否成功
    "agent.tool_input_size":  int,    # 输入大小（字节），用于识别大输入
    "agent.tool_output_size": int,    # 输出大小（字节）
    "agent.tool_error_type":  str,    # 失败时的错误类型（如 "TimeoutError"）
}

# ─── observe 节点附加属性 ───────────────────────────────────
OBSERVE_ATTRIBUTES = {
    "agent.observation_type": str,    # "tool_result" | "env_event" | "user_message"
    "agent.observation_size": int,    # 观察内容大小（字节）
}

# ─── flush 节点附加属性（任务结束必填）─────────────────────
FLUSH_ATTRIBUTES = {
    "agent.outcome":          str,    # "success" | "failure" | "partial" | "cancelled"
    "agent.total_turns":      int,    # 总轮次数
    "agent.total_tokens":     int,    # 总 token 消耗
    "agent.task_summary":     str,    # 任务摘要（< 200 字，供 TES Aggregator 使用）
    "agent.final_answer":     str,    # 最终答案摘要（< 500 字）
    "agent.skill_used":       str,    # 本次使用的技能名（可选）
    "agent.skill_matched":    bool,   # 技能是否实际发挥了作用
    "agent.failure_reason":   str,    # 失败原因（outcome=failure 时填写）
}
```

### 3.2 埋点代码示例（LangGraph 集成）

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
import os

# ─── SDK 初始化（Agent Framework 启动时执行一次）───────────────
def init_telemetry():
    provider = TracerProvider()
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
            ),
            max_export_batch_size=512,
            export_timeout_millis=5000
        )
    )
    trace.set_tracer_provider(provider)

tracer = trace.get_tracer("agent-framework", version="1.0.0")


# ─── think_node 埋点（LangGraph 节点）──────────────────────────
async def think_node(state: AgentState) -> AgentState:
    with tracer.start_as_current_span("agent.think") as span:
        # 必填属性
        span.set_attribute("agent.id",          state["agent_id"])
        span.set_attribute("agent.tenant_id",   state["tenant_id"])
        span.set_attribute("agent.session_id",  state["session_id"])
        span.set_attribute("agent.task_id",     state["task_id"])
        span.set_attribute("agent.node_type",   "think")
        # think 专属属性
        span.set_attribute("agent.turn_number",        state["turn_number"])
        span.set_attribute("agent.context_tokens",     state["context_tokens_used"])
        span.set_attribute("agent.ltm_retrieved_count",
                           len(state.get("retrieved_memories", [])))
        span.set_attribute("agent.ltm_retrieval_mode",
                           state.get("retrieval_mode", "none"))
        span.set_attribute("agent.model", state.get("model", "gpt-4o"))

        # 执行 LLM 推理
        response = await llm.ainvoke(state["messages"])

        planned_tools = len(response.tool_calls) if response.tool_calls else 0
        span.set_attribute("agent.tool_calls_planned", planned_tools)

        # 将 span_context 注入 state（用于 act_node 的子 Span 关联）
        state["current_span_context"] = span.get_span_context()
        state["messages"] = state["messages"] + [response]
        state["turn_number"] = state["turn_number"] + 1

    return state


# ─── act_node 埋点（每个工具调用一个子 Span）──────────────────
async def act_node(state: AgentState) -> AgentState:
    last_message = state["messages"][-1]
    if not last_message.tool_calls:
        return state

    results = []
    for tool_call in last_message.tool_calls:
        # 每个工具调用创建独立 Span（子 Span，parent 是 think_span）
        with tracer.start_as_current_span(
            "agent.act",
            context=trace.set_span_in_context(
                trace.NonRecordingSpan(state.get("current_span_context"))
            )
        ) as span:
            span.set_attribute("agent.id",          state["agent_id"])
            span.set_attribute("agent.tenant_id",   state["tenant_id"])
            span.set_attribute("agent.session_id",  state["session_id"])
            span.set_attribute("agent.task_id",     state["task_id"])
            span.set_attribute("agent.node_type",   "act")
            span.set_attribute("agent.tool_name",   tool_call["name"])
            span.set_attribute("agent.tool_call_id",tool_call["id"])

            import json
            input_size = len(json.dumps(tool_call.get("args", {})))
            span.set_attribute("agent.tool_input_size", input_size)

            try:
                result = await execute_tool(tool_call)
                output_size = len(str(result))
                span.set_attribute("agent.tool_success",     True)
                span.set_attribute("agent.tool_output_size", output_size)
                results.append({"id": tool_call["id"], "result": result})
            except Exception as e:
                span.set_attribute("agent.tool_success",    False)
                span.set_attribute("agent.tool_error_type", type(e).__name__)
                span.record_exception(e)
                results.append({"id": tool_call["id"], "error": str(e)})

    state["tool_results"] = state.get("tool_results", []) + results
    return state


# ─── flush_node 埋点（任务结束时执行）────────────────────────
async def flush_node(state: AgentState) -> AgentState:
    """
    flush_node 是 TES Aggregator 的触发信号。
    收到 flush Span 后，TES Aggregator 聚合该 task_id 的所有 Span，
    构建完整的 ams.trace.ingested 消息。
    """
    with tracer.start_as_current_span("agent.flush") as span:
        span.set_attribute("agent.id",          state["agent_id"])
        span.set_attribute("agent.tenant_id",   state["tenant_id"])
        span.set_attribute("agent.session_id",  state["session_id"])
        span.set_attribute("agent.task_id",     state["task_id"])
        span.set_attribute("agent.node_type",   "flush")
        # flush 专属属性（关键：TES Aggregator 用这些字段构建 trace 消息）
        span.set_attribute("agent.outcome",        state["outcome"])
        span.set_attribute("agent.total_turns",    state["turn_number"])
        span.set_attribute("agent.total_tokens",   state.get("total_tokens", 0))
        span.set_attribute("agent.task_summary",   state.get("task_summary", "")[:200])
        span.set_attribute("agent.final_answer",   state.get("final_answer", "")[:500])
        if state.get("skill_used"):
            span.set_attribute("agent.skill_used",    state["skill_used"])
            span.set_attribute("agent.skill_matched", state.get("skill_matched", False))
        if state["outcome"] == "failure" and state.get("failure_reason"):
            span.set_attribute("agent.failure_reason", state["failure_reason"])

    return state
```

---

## 4. TES Aggregator（会话聚合服务）

TES Aggregator 是一个独立的 Python 服务，消费 `ams.spans.raw` Topic（原始 Span 流），检测 flush Span，聚合完整的执行记录并发布到 `ams.trace.ingested`。

### 4.1 会话边界检测

```python
class TESAggregator:
    """
    消费 OTel Span 流，检测任务边界（flush Span），聚合并发布完整 Trace 消息。

    状态存储：Redis（span 缓存）
    触发条件：收到 node_type=flush 的 Span
    超时清理：task_id 对应的 Span 缓存超过 1h 无 flush → 强制归档
    """
    SPAN_CACHE_TTL = 3600   # 1小时，超时强制清理

    async def process_span(self, span: dict) -> None:
        task_id = span["attributes"].get("agent.task_id")
        node_type = span["attributes"].get("agent.node_type")

        if not task_id:
            return  # 无效 Span，跳过

        if node_type != "flush":
            # 非 flush：缓存 Span 到 Redis（以 task_id 为 key 的 List）
            await self.redis.rpush(
                f"tes:spans:{task_id}",
                json.dumps(self._serialize_span(span))
            )
            await self.redis.expire(f"tes:spans:{task_id}", self.SPAN_CACHE_TTL)
        else:
            # flush：聚合该 task 的所有 Span，构建并发布 Trace 消息
            await self._aggregate_and_publish(span)

    async def _aggregate_and_publish(self, flush_span: dict) -> None:
        task_id = flush_span["attributes"]["agent.task_id"]

        # 从 Redis 取出所有缓存的 Span
        raw_spans = await self.redis.lrange(f"tes:spans:{task_id}", 0, -1)
        all_spans = [json.loads(s) for s in raw_spans]
        all_spans.append(self._serialize_span(flush_span))  # 加入 flush span 本身

        # 清理缓存
        await self.redis.delete(f"tes:spans:{task_id}")

        # 构建 ams.trace.ingested 消息
        trace_message = self._build_trace_message(all_spans, flush_span)

        # 发布到 Kafka ams.trace.ingested
        await self.kafka_producer.send(
            topic="ams.trace.ingested",
            key=trace_message["session_id"],   # 分区键：同会话消息有序
            value=trace_message
        )

        # 同时写入 ClickHouse（原始 Span 持久化）
        await self._write_to_clickhouse(all_spans, trace_message)

    def _build_trace_message(self, all_spans: list[dict],
                              flush_span: dict) -> dict:
        """
        从 Span 列表构建 ams.trace.ingested 消息。
        格式与 AMS Pipeline §4.2 的输入消息格式对齐。
        """
        attrs = flush_span["attributes"]

        # 提取 think Span（每轮对话的推理步骤）
        think_spans = [s for s in all_spans
                        if s["attributes"].get("agent.node_type") == "think"]

        # 提取 act Span（工具调用步骤）
        act_spans = [s for s in all_spans
                      if s["attributes"].get("agent.node_type") == "act"]

        # 构建 tool_history
        tool_history = []
        for span in sorted(act_spans, key=lambda s: s["start_time"]):
            tool_history.append({
                "tool_name":   span["attributes"].get("agent.tool_name", ""),
                "tool_call_id": span["attributes"].get("agent.tool_call_id", ""),
                "success":     span["attributes"].get("agent.tool_success", False),
                "latency_ms":  span.get("latency_ms", 0),
                "input":       {},   # 不直接存完整 input（可能含敏感数据）
                "output":      {},   # 同上，完整 input/output 在 ClickHouse
                "error_type":  span["attributes"].get("agent.tool_error_type")
            })

        return {
            "message_id":   str(uuid4()),
            "schema_version": "1.0",
            "tenant_id":    attrs.get("agent.tenant_id", ""),
            "agent_id":     attrs.get("agent.id", ""),
            "session_id":   attrs.get("agent.session_id", ""),
            "trace_id":     flush_span.get("trace_id", ""),
            "event_time":   flush_span["end_time"],

            # 任务关键信息（来自 flush span 属性）
            "task_summary": attrs.get("agent.task_summary", ""),
            "outcome":      attrs.get("agent.outcome", "unknown"),
            "final_answer": attrs.get("agent.final_answer", ""),
            "turns":        attrs.get("agent.total_turns", len(think_spans)),
            "total_tokens": attrs.get("agent.total_tokens", 0),

            # 工具调用摘要
            "tool_history": tool_history,

            # 技能信息（若使用了技能）
            "skill_used":     attrs.get("agent.skill_used"),
            "skill_matched":  attrs.get("agent.skill_matched", False),

            # 链路追踪（用于 AMS Pipeline 继续传播 Trace Context）
            "_otel_trace_context": {
                "trace_id": flush_span.get("trace_id"),
                "span_id":  flush_span.get("span_id")
            }
        }
```

### 4.2 超时强制归档

```python
class SpanCacheCleanup:
    """
    定期扫描 Redis 中超时的 Span 缓存（task_id 没有收到 flush 超过 1h），
    强制构建 Trace 消息归档（outcome 标记为 "timeout"）。
    """

    async def run_cleanup(self) -> None:
        """每 5 分钟执行一次超时检查"""
        cursor = 0
        while True:
            cursor, keys = await self.redis.scan(
                cursor=cursor,
                match="tes:spans:*",
                count=100
            )

            for key in keys:
                ttl = await self.redis.ttl(key)
                if ttl < 0 or ttl > (self.SPAN_CACHE_TTL - 300):
                    continue  # 未过期，跳过

                # 即将过期的 Span 缓存：强制归档
                task_id = key.decode().split("tes:spans:")[-1]
                raw_spans = await self.redis.lrange(key, 0, -1)
                if raw_spans:
                    spans = [json.loads(s) for s in raw_spans]
                    # 构造一个虚假的 flush span
                    fake_flush = self._create_timeout_flush(spans)
                    await self._aggregate_and_publish(fake_flush)
                    await self.redis.delete(key)

            if cursor == 0:
                break
```

---

## 5. 动态采样策略

### 5.1 采样策略设计

对于高并发场景（如单 Agent 每秒多次工具调用），全量采样会产生大量数据。版本C 采用基于任务结果的**尾部采样（Tail-based Sampling）**：

```python
class TailSampler:
    """
    尾部采样：在 flush Span 到达后，根据任务结果决定是否保留完整 Trace。
    比头部采样（Head-based）更智能：能优先保留失败任务和高价值任务的完整链路。
    """

    SAMPLING_RULES = [
        # 规则优先级从高到低
        {"condition": lambda attrs: attrs.get("agent.outcome") == "failure",
         "sample_rate": 1.0,    # 失败任务：100% 保留（用于错误分析）
         "label": "failure"},

        {"condition": lambda attrs: float(attrs.get("agent.total_turns", 0)) >= 10,
         "sample_rate": 1.0,    # 长轮次任务（复杂任务）：100% 保留
         "label": "long_task"},

        {"condition": lambda attrs: attrs.get("agent.skill_used") is not None,
         "sample_rate": 0.5,    # 使用了技能的任务：50% 采样（用于技能评估）
         "label": "skill_used"},

        {"condition": lambda attrs: True,  # 默认规则
         "sample_rate": 0.1,    # 普通成功任务：10% 采样（减少存储压力）
         "label": "default"},
    ]

    def should_sample(self, flush_span: dict) -> bool:
        attrs = flush_span["attributes"]
        for rule in self.SAMPLING_RULES:
            if rule["condition"](attrs):
                import random
                return random.random() < rule["sample_rate"]
        return True

    def should_forward_to_ams(self, flush_span: dict) -> bool:
        """
        无论是否采样到 ClickHouse，以下情况都需要发送到 ams.trace.ingested：
        - 失败任务（学习失败经验）
        - 高重要性任务（turns >= 5 且 success）
        - 使用了新技能的任务
        """
        attrs = flush_span["attributes"]
        if attrs.get("agent.outcome") == "failure":
            return True
        if int(attrs.get("agent.total_turns", 0)) >= 5 and \
           attrs.get("agent.outcome") == "success":
            return True
        if attrs.get("agent.skill_used"):
            return True
        return False  # 简单成功任务不一定需要写入 AMS
```

---

## 6. ClickHouse 存储设计

### 6.1 原始 Span 表

```sql
-- 原始 Span 持久化（供离线分析和 Skill-MDS 使用）
CREATE TABLE agent_spans ON CLUSTER agent_cluster
(
    -- 链路追踪 ID
    span_id          FixedString(16),
    trace_id         FixedString(16),
    parent_span_id   FixedString(16),

    -- Agent 上下文
    tenant_id        LowCardinality(String),
    agent_id         LowCardinality(String),
    session_id       String,
    task_id          String,

    -- Span 类型与时间
    node_type        LowCardinality(String),  -- think/act/observe/flush
    start_time       DateTime64(3, 'UTC'),
    end_time         DateTime64(3, 'UTC'),
    latency_ms       Float32,

    -- Act 节点专属
    tool_name        LowCardinality(String),  -- 工具名（act 节点）
    tool_call_id     String,
    tool_success     UInt8,                   -- 0=fail, 1=success
    tool_input_size  UInt32,
    tool_output_size UInt32,
    tool_error_type  LowCardinality(String),

    -- Think 节点专属
    turn_number      UInt16,
    context_tokens   UInt32,
    ltm_retrieved    UInt16,
    model            LowCardinality(String),

    -- Flush 节点专属
    outcome          LowCardinality(String),  -- success/failure/partial
    total_turns      UInt16,
    total_tokens     UInt32,
    skill_used       LowCardinality(String),
    skill_matched    UInt8,

    -- 完整属性（JSON，用于不常用字段）
    extra_attributes String  -- JSON
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/agent_spans', '{replica}')
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (tenant_id, agent_id, session_id, start_time)
TTL start_time + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
```

### 6.2 任务汇总表（用于 Skill-MDS）

```sql
-- 任务级汇总（从 flush Span 直接写入，比从 agent_spans 聚合快 10x）
CREATE TABLE agent_task_summary ON CLUSTER agent_cluster
(
    task_id          String,
    trace_id         FixedString(16),
    tenant_id        LowCardinality(String),
    agent_id         LowCardinality(String),
    session_id       String,

    outcome          LowCardinality(String),
    total_turns      UInt16,
    total_tokens     UInt32,
    latency_ms       UInt32,
    task_summary     String,            -- 任务摘要（< 200 字）

    skill_used       LowCardinality(String),
    skill_matched    UInt8,
    tool_chain       Array(String),     -- 工具调用序列（有序）

    event_time       DateTime64(3, 'UTC')
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/agent_task_summary', '{replica}')
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, agent_id, event_time)
TTL event_time + INTERVAL 180 DAY;
```

### 6.3 典型分析查询

```sql
-- Skill-MDS 使用：查询某 Agent 最常使用的工具链（Top 10 序列）
SELECT
    arrayJoin(tool_chain) AS tool_sequence_step,
    count() AS frequency
FROM agent_task_summary
WHERE agent_id = 'agent_001'
  AND outcome = 'success'
  AND event_time >= now() - INTERVAL 30 DAY
GROUP BY tool_sequence_step
ORDER BY frequency DESC
LIMIT 10;

-- 技能成功率趋势（用于 Skill-MDS 降级检测）
SELECT
    toDate(event_time) AS day,
    skill_used,
    countIf(skill_matched = 1 AND outcome = 'success') AS success_count,
    count() AS total_count,
    success_count / total_count AS success_rate
FROM agent_task_summary
WHERE skill_used != ''
  AND event_time >= now() - INTERVAL 7 DAY
GROUP BY day, skill_used
ORDER BY day DESC, skill_used;

-- 工具失败率（告警触发来源）
SELECT
    tool_name,
    count() AS total_calls,
    countIf(tool_success = 0) AS fail_count,
    fail_count / total_calls AS fail_rate,
    avg(latency_ms) AS avg_latency
FROM agent_spans
WHERE node_type = 'act'
  AND start_time >= now() - INTERVAL 1 HOUR
GROUP BY tool_name
HAVING fail_rate > 0.3
ORDER BY fail_rate DESC;
```

---

## 7. Prometheus 实时指标

### 7.1 OTel Collector spanmetrics 配置

```yaml
# spanmetrics processor 配置（在 otel-collector config 中）
processors:
  spanmetrics:
    metrics_exporter: prometheus
    latency_histogram_buckets: [10ms, 50ms, 100ms, 500ms, 1s, 5s, 10s, 30s]
    dimensions:
      - name: agent.id
        default: unknown
      - name: agent.tenant_id
        default: unknown
      - name: agent.node_type
      - name: agent.tool_name
      - name: agent.outcome
      - name: agent.model
    exemplars:
      enabled: true
```

### 7.2 核心指标定义

| 指标名 | 类型 | 标签 | 说明 |
|---|---|---|---|
| `agent_span_duration_seconds` | Histogram | agent_id, node_type | Span（每个步骤）的延迟分布 |
| `agent_task_duration_seconds` | Histogram | agent_id, outcome | 任务端到端延迟（flush - 第一个think）|
| `agent_task_total` | Counter | agent_id, outcome | 任务总数（按结果拆分）|
| `agent_tool_calls_total` | Counter | agent_id, tool_name, success | 工具调用次数 |
| `agent_context_tokens` | Gauge | agent_id | 当前 context window 使用量 |
| `agent_ltm_retrieval_total` | Counter | agent_id, mode | LTM 检索次数（按模式）|
| `agent_turns_per_task` | Histogram | agent_id | 每个任务的轮次分布 |
| `agent_skill_usage_total` | Counter | agent_id, skill_name, matched | 技能使用统计 |
| `tes_trace_published_total` | Counter | tenant_id, outcome | 发布到 ams.trace.ingested 的消息数 |
| `tes_span_cache_size` | Gauge | — | Redis 中当前缓存的 Span 数量 |

### 7.3 告警规则

```yaml
groups:
  - name: tes_alerts
    rules:
      # Agent 任务成功率低
      - alert: AgentTaskSuccessRateLow
        expr: |
          rate(agent_task_total{outcome="success"}[30m]) /
          rate(agent_task_total[30m]) < 0.6
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Agent {{ $labels.agent_id }} task success rate < 60%"
          description: "Current success rate: {{ $value | humanizePercentage }}"

      # 工具失败率突增
      - alert: ToolFailureRateHigh
        expr: |
          rate(agent_tool_calls_total{success="false"}[15m]) /
          rate(agent_tool_calls_total[15m]) > 0.4
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Tool {{ $labels.tool_name }} failure rate > 40%"

      # TES Aggregator Span 缓存积压
      - alert: TESSpanCacheSizeHigh
        expr: tes_span_cache_size > 100000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "TES Span cache too large ({{ $value }} entries), possible flush span loss"

      # Kafka ams.trace.ingested 发布延迟
      - alert: TESKafkaPublishLag
        expr: tes_span_aggregation_duration_seconds{quantile="0.95"} > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "TES Aggregator p95 > 10s, Kafka publish may be slow"
```

---

## 8. 部署配置

### 8.1 TES Aggregator Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tes-aggregator
  namespace: agent-memory
spec:
  replicas: 2   # 2 副本，Kafka Consumer Group 自动负载均衡
  selector:
    matchLabels:
      app: tes-aggregator
  template:
    metadata:
      labels:
        app: tes-aggregator
    spec:
      containers:
        - name: tes-aggregator
          image: registry.internal/tes-aggregator:latest
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
          env:
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: kafka.brokers
            - name: KAFKA_CONSUMER_GROUP
              value: "tes-aggregator"
            - name: KAFKA_INPUT_TOPIC
              value: "ams.spans.raw"
            - name: KAFKA_OUTPUT_TOPIC
              value: "ams.trace.ingested"
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: redis.url
            - name: CLICKHOUSE_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: clickhouse.url
            - name: SPAN_CACHE_TTL_SECONDS
              value: "3600"
            - name: CLEANUP_INTERVAL_SECONDS
              value: "300"
```

### 8.2 关键配置参数

```yaml
# TES Aggregator 配置
kafka:
  consumer_group: "tes-aggregator"
  max_poll_interval_ms: 60000     # 1分钟，聚合等待时间
  session_timeout_ms: 30000

span_cache:
  ttl_seconds: 3600               # Span 缓存 TTL（对应最长任务时间）
  max_spans_per_task: 1000        # 单任务最大缓存 Span 数（防止内存溢出）

sampling:
  failure_rate: 1.0               # 失败任务采样率
  long_task_turns_threshold: 10   # 长任务轮次阈值
  long_task_rate: 1.0
  skill_task_rate: 0.5
  default_rate: 0.1

ams_forwarding:
  min_turns_for_forwarding: 5     # 少于此轮次的成功任务不发送到 AMS
  always_forward_failures: true
  always_forward_skill_tasks: true
```

### 8.3 依赖服务版本矩阵

| 依赖服务 | 最低版本 | 推荐版本 |
|---|---|---|
| OTel Collector Contrib | 0.90.0 | 0.100.0 |
| OpenTelemetry Python SDK | 1.20.0 | 1.24.0 |
| ClickHouse | 23.8 | 24.3 LTS |
| Apache Kafka | 3.5 | 3.7 |
| Redis | 7.0 | 7.2 |

---

## 9. 上下游数据契约

### 9.1 TES 接收

| 来源 | 协议 | 数据 |
|---|---|---|
| Agent Framework | OTLP gRPC → Sidecar Collector | OTel Span（Think/Act/Observe/Flush）|

### 9.2 TES 输出

| 目标 | 协议 | Topic/表 | 数据 |
|---|---|---|---|
| **AMS Pipeline** | Kafka | `ams.trace.ingested` | 聚合后的完整 Trace 消息（与 Pipeline §4 格式对齐）|
| **ClickHouse** | TCP | `agent_spans` / `agent_task_summary` | 原始 Span + 任务汇总（供 Skill-MDS 离线分析）|
| **Prometheus** | HTTP Pull | — | 实时指标（任务成功率、工具失败率等）|

### 9.3 Skill-MDS 的依赖

Skill-MDS 通过以下两种方式消费 TES 数据：
1. **实时**：通过 AMS Pipeline 的 FeedbackAggregator 更新技能成功率（见 Pipeline 设计 §5）
2. **离线**：直接查询 ClickHouse `agent_task_summary` 表，分析工具链共现模式，挖掘技能模板

---

*下一步：[05-Skill-MDS 详细设计](./05-Skill-MDS.md) — 技能挖掘（HDBSCAN聚类 + 工具链提取）、Skill Schema 定义、Sandbox 测试、技能网格（Skill Mesh）、技能版本管理与降级检测*
