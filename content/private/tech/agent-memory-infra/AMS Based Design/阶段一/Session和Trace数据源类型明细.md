
![[Pasted image 20260409090026.png]]


根据图片和三个版本的详细设计文档，以下是从 Agent Framework 的 **Session** 和 **Trace** 中能获取的具体内容细节的完整总结：

## 图片中标注的六大类数据

图片（手绘架构图）中 Agent-TES 的 **End-to-end Activity Recorder & Evidence Ingestion** 部分明确列出了六大类可采集数据：

### 1. User Requests, Events and Contexts（用户请求、事件与上下文）

| 数据项    | 来源                     | 具体字段（版本C）                                                                       |
| ------ | ---------------------- | ------------------------------------------------------------------------------- |
| 用户原始请求 | Session 消息流            | `messages[]` 中 role=user 的条目                                                    |
| 会话上下文  | Working Memory (Redis) | `session:{sid}:ctx` — token counts, truncation cursor, active memory references |
| 会话状态   | Working Memory         | `session:{sid}:state` — agent_id, user_id, created_at, last_active_at, status   |
| 对话历史   | Working Memory         | `session:{sid}:conv` — 最近50轮对话消息                                                |
| 事件时间   | OTel Span              | `start_time`, `end_time`, `event_time`                                          |

### 2. Multi-agent Orchestration and Inter-agent Coordination（多智能体编排与协调）

| 数据项 | 来源 | 具体字段 |
|---|---|---|
| Agent 标识 | Span 通用属性 | `agent.id`, `agent.tenant_id` |
| 任务标识 | Span 通用属性 | `agent.task_id` (一个 task = 完整的 Think→Act→…→Flush 循环) |
| 节点类型 | Span 通用属性 | `agent.node_type`: `think` / `act` / `observe` / `flush` |
| Trace 上下文传播 | OTel | `trace_id`, `span_id`, `parent_span_id`（支持跨 Agent 的调用链追踪） |
| 观测来源类型 | Observe 节点 | `agent.observation_type`: `tool_result` / `env_event` / `user_message` |

### 3. LLM CoT, Reasoning Traces, Decision Checkpoints（推理链、决策检查点）

| 数据项      | 来源       | 具体字段                                                           |
| -------- | -------- | -------------------------------------------------------------- |
| 当前轮次     | Think 节点 | `agent.turn_number`                                            |
| 上下文窗口消耗  | Think 节点 | `agent.context_tokens`                                         |
| 决策置信度    | Think 节点 | `agent.confidence` [0.0, 1.0]（可选）                              |
| 计划的工具调用数 | Think 节点 | `agent.tool_calls_planned`                                     |
| 记忆检索模式   | Think 节点 | `agent.ltm_retrieval_mode`: `lightweight` / `agentic` / `none` |
| 检索记忆数量   | Think 节点 | `agent.ltm_retrieved_count`                                    |
| 任务总结     | Flush 节点 | `agent.task_summary` (< 200 chars)                             |
| 最终回答     | Flush 节点 | `agent.final_answer` (< 500 chars)                             |

### 4. Model Version, Token Consumption, Decision Confidence（模型元数据）

| 数据项           | 来源       | 具体字段                            |
| ------------- | -------- | ------------------------------- |
| 模型名称          | Think 节点 | `agent.model` (e.g. `"gpt-4o"`) |
| 当前上下文 token 数 | Think 节点 | `agent.context_tokens`          |
| 任务总 token 消耗  | Flush 节点 | `agent.total_tokens`            |
| 决策置信度         | Think 节点 | `agent.confidence`              |
| 总轮次           | Flush 节点 | `agent.total_turns`             |

### 5. Tool Invocations, Prompts, Logs and Evidence（工具调用与证据）

| 数据项     | 来源             | 具体字段                                                            |
| ------- | -------------- | --------------------------------------------------------------- |
| 工具名称    | Act 节点         | `agent.tool_name` (e.g. `"sql_query"`, `"read_file"`)           |
| 工具调用 ID | Act 节点         | `agent.tool_call_id`                                            |
| 调用是否成功  | Act 节点         | `agent.tool_success` (bool)                                     |
| 输入大小    | Act 节点         | `agent.tool_input_size` (bytes)                                 |
| 输出大小    | Act 节点         | `agent.tool_output_size` (bytes)                                |
| 错误类型    | Act 节点         | `agent.tool_error_type` (e.g. `"TimeoutError"`)                 |
| 工具调用序列  | Flush 聚合       | `tool_chain`: Array(String) — 有序的工具调用序列                         |
| 工具调用明细  | Trace 消息       | `tool_history[]`: tool_name, input, output, success, latency_ms |
| 工具调用流   | Working Memory | `session:{sid}:tools` — Redis Stream, XADD + MAXLEN ~100        |

### 6. Outcome & Feedback（结果与反馈）

| 数据项                  | 来源              | 具体字段                                                                                                                       |
| -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 任务结果                 | Flush 节点        | `agent.outcome`: `success` / `failure` / `partial` / `cancelled`                                                           |
| 失败原因                 | Flush 节点        | `agent.failure_reason`                                                                                                     |
| 使用的技能                | Flush 节点        | `agent.skill_used`                                                                                                         |
| 技能是否生效               | Flush 节点        | `agent.skill_matched` (bool)                                                                                               |
| 促进分数（Session → 长期记忆） | Session Archive | `promotion_score`, `promotion_reasons` (task_completion, interaction_quality, knowledge_novelty, agent_improvement_signal) |
| 新颖度评估                | Session Archive | `novelty_score`, `top_similar_memory_ids`                                                                                  |

---

## 版本演进对比

三个版本的采集能力逐步增强，从最初的三层架构到最终精简为 OTel 原生方案：

| 维度         | 版本A                     | 版本B                  | 版本C（最终）                                                    |
| ---------- | ----------------------- | -------------------- | ---------------------------------------------------------- |
| **采集方式**   | eBPF + Sidecar + SDK 三层 | OTel Span + Evidence | 纯 OTel Span（去掉 Evidence 中间层）                               |
| **多租户**    | ❌                       | ❌                    | ✅ `tenant_id`                                              |
| **工具调用细节** | 仅 tool_name + success   | 同左                   | +`tool_call_id`, `input_size`, `output_size`, `error_type` |
| **模型元数据**  | 仅 Sidecar 指标            | ❌                    | ✅ `model`, `confidence`                                    |
| **记忆检索追踪** | ❌                       | retrieved_count      | +`retrieval_mode`(lightweight/agentic/none)                |
| **任务摘要**   | ❌                       | ❌                    | ✅ `task_summary`, `final_answer`                           |
| **采样策略**   | 无                       | 无                    | ✅ 尾采样（failure/长任务100%，技能50%，默认10%）                         |

版本C是最成熟的设计，去掉了版本A中的 eBPF 层和版本B中的 Evidence 中间层，直接用 OTel Span 属性承载所有信息，然后由 TES Aggregator 聚合输出 `ams.trace.ingested` 消息给下游 Memory Pipeline。