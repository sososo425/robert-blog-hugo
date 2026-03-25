---
title: "02-Agent-Framework 详细设计"
date: 2026-03-23T18:00:00+08:00
draft: true
tags: ["agent-memory", "agent-framework", "langgraph", "详细设计", "版本B"]
---

# Agent Framework 详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **与AMS的关系**: Agent Framework 是 AMS 的**主要调用方**，通过 Memory Client SDK 与 AMS 交互

---

## 1. 模块定位与职责

### 1.1 在系统中的位置

Agent Framework 是系统的**执行中枢**，负责：
- 接收业务请求，驱动 LLM 完成复杂任务（ReAct 循环）
- 管理任务执行期间的上下文（通过 Working Memory）
- 在关键时机调用 AMS 检索记忆、写入状态
- 将执行轨迹上报给 Agent-TES

```
业务系统 / 用户
      │ HTTP/gRPC
      ▼
Agent Framework（执行中枢）
      │
      ├──→ AMS（记忆读写，Memory Client SDK）
      ├──→ Agent-TES（轨迹上报，OpenTelemetry SDK）
      ├──→ 外部工具（Python函数、API调用等）
      └──→ LLM（OpenAI / 本地模型）
```

**清晰边界**：
- Agent Framework **不直接访问** Redis、Milvus 等存储
- Agent Framework **只通过 AMS API** 读写记忆
- Agent Framework 的核心是"任务执行"，记忆管理委托给 AMS

### 1.2 核心职责

| 职责 | 说明 |
|------|------|
| **任务接收** | 解析用户意图，初始化 Agent 执行状态 |
| **ReAct 执行** | Think → Act → Observe 循环，直到任务完成 |
| **上下文管理** | 维护 context window 使用量，防止超限 |
| **记忆注入** | 启动时从 AMS 拉取相关记忆，注入到 system prompt |
| **记忆写入** | 任务完成后通知 Memory Pipeline 处理（间接写 AMS）|
| **轨迹上报** | 每个 Think/Act/Observe 步骤的轨迹发给 Agent-TES |

---

## 2. LangGraph StateGraph 设计

### 2.1 Agent 状态定义

```python
from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages

class AgentState(TypedDict):
    # 消息历史（LangGraph 自动 merge）
    messages: Annotated[list, add_messages]

    # 工作记忆快照（从 AMS 加载，任务过程中实时更新）
    working_memory: dict              # task_summary, plan, known_facts 等

    # 任务元信息
    agent_id:    str
    session_id:  str
    task_id:     str

    # 执行状态
    turn_number:        int           # 当前是第几轮 Think-Act-Observe
    tool_calls_history: list[dict]    # 历史工具调用记录

    # Context Window 监控
    context_tokens_used: int          # 当前已用 tokens
    context_tokens_max:  int          # 模型上下文上限

    # 检索到的记忆（每轮 Think 前注入）
    retrieved_memories: list[dict]    # 来自 AMS 的相关记忆

    # 任务完成标志
    is_done:      bool
    final_answer: str | None
```

### 2.2 StateGraph 节点定义

```python
from langgraph.graph import StateGraph, END

builder = StateGraph(AgentState)

builder.add_node("load_context",     load_context_node)     # 启动时加载记忆
builder.add_node("think",            think_node)            # LLM 推理
builder.add_node("act",              act_node)              # 工具调用
builder.add_node("observe",          observe_node)          # 处理工具结果
builder.add_node("update_memory",    update_memory_node)    # 更新工作记忆
builder.add_node("compress_context", compress_context_node) # 上下文压缩（换页）
builder.add_node("flush_episode",    flush_episode_node)    # 任务完成，触发记忆持久化

builder.set_entry_point("load_context")
builder.add_edge("load_context", "think")
builder.add_conditional_edges("think", route_after_think)   # done→flush / tools→act
builder.add_edge("act",     "observe")
builder.add_edge("observe", "update_memory")
builder.add_conditional_edges("update_memory", route_after_update)  # 需压缩→compress / 继续→think
builder.add_edge("compress_context", "think")
builder.add_edge("flush_episode", END)
```

### 2.3 各节点实现

#### load_context_node — 启动时从 AMS 加载记忆

```python
async def load_context_node(state: AgentState) -> AgentState:
    """
    任务开始时执行一次。
    - 从 AMS 加载工作记忆（若已有上下文，如断点续做）
    - 检索与任务相关的历史 Episode 和 Skill
    - 将检索结果存入 state.retrieved_memories，后续 Think 节点注入 prompt
    """
    client = get_memory_client(state["agent_id"])

    # 1. 尝试加载已有工作记忆（断点恢复场景）
    working_mem = await client.get_working_memory()
    if working_mem:
        state["working_memory"] = working_mem

    # 2. 基于任务描述检索相关历史记忆
    task_description = state["messages"][-1].content  # 用户最新消息
    memories = await client.search(
        query=task_description,
        layers=["episode", "procedural", "semantic"],
        top_k=8
    )

    state["retrieved_memories"] = [m.to_dict() for m in memories]

    # 3. 初始化工作记忆（若是新任务）
    if not state.get("working_memory"):
        await client.update_working_memory({
            "task_summary": task_description[:200],
            "current_plan": [],
            "completed_steps": [],
            "known_facts": {}
        })

    return state
```

#### think_node — LLM 推理（注入记忆到 Prompt）

```python
async def think_node(state: AgentState) -> AgentState:
    """
    构建包含记忆上下文的 system prompt，调用 LLM 推理。
    记忆以结构化方式注入，不直接混入消息历史。
    """
    # 构建 system prompt（含记忆注入）
    system_prompt = build_system_prompt(
        working_memory=state["working_memory"],
        retrieved_memories=state["retrieved_memories"],
        turn_number=state["turn_number"]
    )

    # 调用 LLM
    response = await llm.ainvoke(
        [SystemMessage(content=system_prompt)] + state["messages"]
    )

    # 更新状态
    state["messages"] = [response]
    state["turn_number"] += 1
    state["context_tokens_used"] = count_tokens(state)

    return state

def build_system_prompt(working_memory, retrieved_memories, turn_number) -> str:
    """
    记忆注入格式示例（结构化，便于 LLM 识别）：

    === 工作记忆（当前任务状态）===
    任务摘要：修复 sales.csv 乱码问题
    已完成步骤：[加载文件]
    已知信息：{"file": "sales.csv", "rows": 12000}

    === 相关历史经验 ===
    [Episode] CSV 乱码修复（置信度 0.91）
    内容：上次遇到类似问题，用 chardet 检测到 gbk 编码，encoding='gbk' 解决...

    [技能] csv-encoding-diagnosis（成功率 94%）
    步骤：1. chardet.detect(); 2. pd.read_csv(encoding=...); 3. 验证行数
    """
    parts = ["你是一个专业的数据分析助手，以下是你的记忆上下文：\n"]

    if working_memory:
        parts.append("=== 工作记忆（当前任务状态）===")
        parts.append(f"任务摘要：{working_memory.get('task_summary', '无')}")
        completed = working_memory.get("completed_steps", [])
        if completed:
            parts.append(f"已完成步骤：{completed}")
        facts = working_memory.get("known_facts", {})
        if facts:
            parts.append(f"已知信息：{json.dumps(facts, ensure_ascii=False)}")

    if retrieved_memories:
        parts.append("\n=== 相关历史经验 ===")
        for mem in retrieved_memories[:5]:  # 最多注入5条，避免 prompt 过长
            parts.append(f"[{mem['layer'].upper()}] {mem['title']}（置信度 {mem['score']:.2f}）")
            parts.append(f"内容：{mem['content'][:300]}...")

    return "\n".join(parts)
```

#### act_node — 执行工具调用

```python
async def act_node(state: AgentState) -> AgentState:
    """解析 LLM 响应中的 tool_calls，并行执行工具"""
    last_message = state["messages"][-1]
    tool_results = []

    for tool_call in last_message.tool_calls:
        result = await execute_tool(tool_call)
        tool_results.append({
            "tool_name": tool_call.name,
            "input":     tool_call.args,
            "output":    result,
            "success":   result.get("error") is None
        })

    state["tool_calls_history"].extend(tool_results)
    # 将工具结果作为 ToolMessage 添加到消息历史
    state["messages"] = [ToolMessage(content=str(r["output"]),
                                     tool_call_id=...) for r in tool_results]
    return state
```

#### update_memory_node — 更新工作记忆到 AMS

```python
async def update_memory_node(state: AgentState) -> AgentState:
    """
    每轮 Observe 完成后，将新获得的信息更新到 AMS Working Memory。
    只更新有变化的字段，避免全量写。
    """
    client = get_memory_client(state["agent_id"])

    # 提取本轮新增的 known_facts（从工具结果中解析）
    new_facts = extract_facts_from_tool_results(state["tool_calls_history"][-1:])

    if new_facts:
        await client.update_working_memory_fields({
            "known_facts": {**state["working_memory"].get("known_facts", {}), **new_facts}
        })
        state["working_memory"]["known_facts"].update(new_facts)

    return state
```

#### compress_context_node — 上下文压缩（MemGPT换页策略）

```python
async def compress_context_node(state: AgentState) -> AgentState:
    """
    当 context window 使用率超过阈值（默认 80%）时触发。
    将最旧的 N 条消息压缩归档，释放 context 空间。

    灵感来自 MemGPT 的 OS 换页隐喻：
    - 内存（context window）有限
    - 旧内容"换出"到 AMS Episode（永久存储）
    - 需要时再"换回"（通过检索）
    """
    # 识别最旧的 N 条非关键消息
    old_messages = identify_archivable_messages(state["messages"], keep_recent=10)

    if old_messages:
        # 压缩摘要（LLM生成）
        summary = await llm.ainvoke([
            SystemMessage(content="请对以下对话历史做一个简洁摘要（100字以内）："),
            HumanMessage(content=format_messages(old_messages))
        ])

        # 通知 Memory Pipeline 归档（异步，通过 HTTP 通知 Pipeline）
        await notify_pipeline_archive(
            agent_id=state["agent_id"],
            session_id=state["session_id"],
            content=summary.content,
            raw_messages=old_messages,
            importance=5.0  # 压缩归档的重要性默认中等
        )

        # 从 state 中移除旧消息，替换为摘要
        state["messages"] = [
            SystemMessage(content=f"[已归档摘要] {summary.content}")
        ] + state["messages"][-10:]  # 保留最近10条

    return state
```

#### flush_episode_node — 任务完成，触发 Episode 持久化

```python
async def flush_episode_node(state: AgentState) -> AgentState:
    """
    任务结束时执行：
    1. 清除 Working Memory（任务结束）
    2. 通知 Memory Pipeline 将本次任务的执行轨迹处理为 Episode
    """
    client = get_memory_client(state["agent_id"])

    # 1. 清除工作记忆
    await client.clear_working_memory()

    # 2. 构建任务摘要，通知 Memory Pipeline
    task_summary = {
        "agent_id":    state["agent_id"],
        "session_id":  state["session_id"],
        "task_summary": state["working_memory"].get("task_summary"),
        "messages":    [m.to_dict() for m in state["messages"]],
        "tool_history": state["tool_calls_history"],
        "outcome":     "success" if state["is_done"] else "failure",
        "final_answer": state["final_answer"]
    }

    # 发布到 Kafka（由 Agent-TES 接管后续处理）
    await kafka_producer.send("agent.episodes.raw", task_summary)

    return state
```

### 2.4 路由条件函数

```python
def route_after_think(state: AgentState) -> str:
    """Think 之后的路由"""
    last_msg = state["messages"][-1]

    if state["is_done"] or not last_msg.tool_calls:
        return "flush_episode"      # 无工具调用 = 任务完成

    if state["context_tokens_used"] > state["context_tokens_max"] * 0.8:
        return "compress_context"   # 超过80%使用率，先压缩

    return "act"                    # 正常继续执行工具

def route_after_update(state: AgentState) -> str:
    """update_memory 之后的路由"""
    if state["context_tokens_used"] > state["context_tokens_max"] * 0.8:
        return "compress_context"
    return "think"
```

---

## 3. Memory Client SDK 设计

### 3.1 SDK 接口

Memory Client SDK 是 Agent Framework 与 AMS 交互的统一入口，封装了所有 HTTP 调用细节。

```python
class MemoryAPIClient:
    """Agent Framework 使用的 Memory 客户端"""

    def __init__(self, base_url: str, agent_id: str):
        self.base_url = base_url
        self.agent_id = agent_id
        self._http = httpx.AsyncClient(timeout=5.0)

    # ========== Working Memory 操作 ==========

    async def get_working_memory(self) -> dict | None:
        """获取当前工作记忆"""
        resp = await self._http.get(f"{self.base_url}/api/v1/memory/working/{self.agent_id}")
        if resp.status_code == 404:
            return None
        return resp.json()["data"]

    async def update_working_memory(self, updates: dict) -> None:
        """全量更新工作记忆"""
        await self._http.put(
            f"{self.base_url}/api/v1/memory/working/{self.agent_id}",
            json=updates
        )

    async def update_working_memory_fields(self, fields: dict) -> None:
        """部分更新工作记忆字段"""
        await self._http.patch(
            f"{self.base_url}/api/v1/memory/working/{self.agent_id}",
            json=fields
        )

    async def clear_working_memory(self) -> None:
        """任务结束，清除工作记忆"""
        await self._http.delete(f"{self.base_url}/api/v1/memory/working/{self.agent_id}")

    # ========== 记忆检索 ==========

    async def search(
        self,
        query: str,
        layers: list[str] = None,
        top_k: int = 10,
        filters: dict = None
    ) -> list[MemorySearchResult]:
        """多层记忆统一检索"""
        payload = {
            "query":    query,
            "agent_id": self.agent_id,
            "layers":   layers or ["episode", "procedural", "semantic"],
            "top_k":    top_k,
            "filters":  filters or {}
        }
        resp = await self._http.post(f"{self.base_url}/api/v1/memory/search", json=payload)
        data = resp.json()["data"]
        return [MemorySearchResult(**r) for r in data["results"]]
```

### 3.2 SDK 在 Agent Framework 中的生命周期

```python
# 每个 Agent 实例初始化时创建一个 SDK 实例
memory_client = MemoryAPIClient(
    base_url=os.getenv("MEMORY_SERVICE_URL", "http://agent-memory-system:8080"),
    agent_id=agent_id
)

# 通过 dependency injection 传入各 Node
graph = build_graph(memory_client=memory_client)
```

---

## 4. 与 Agent-TES 的集成

Agent Framework 通过 OpenTelemetry SDK 向 Agent-TES 上报轨迹，无需直接调用 Agent-TES API。

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

tracer = trace.get_tracer("agent_framework")

async def think_node(state: AgentState) -> AgentState:
    with tracer.start_as_current_span("agent.think") as span:
        span.set_attribute("agent.id",           state["agent_id"])
        span.set_attribute("agent.turn_number",  state["turn_number"])
        span.set_attribute("agent.context_usage",state["context_tokens_used"])
        # ... 执行推理 ...
        span.set_attribute("agent.tool_calls_count", len(tool_calls))
    return state
```

Agent-TES 的 Sidecar 会自动采集这些 Span，无需 Agent Framework 做额外配置。

---

## 5. 上下游关系汇总

### 5.1 Agent Framework 调用哪些服务？

| 服务 | 接口 | 时机 | 同步/异步 |
|------|------|------|---------|
| **AMS** | GET/PUT/DELETE `/memory/working/*` | 每轮工具调用前后 | 同步 |
| **AMS** | POST `/memory/search` | 任务启动时、Think前 | 同步 |
| **LLM** | Chat Completion API | Think 节点 | 同步 |
| **外部工具** | 各种 Python 函数/HTTP API | Act 节点 | 同步 |
| **Kafka** | `agent.episodes.raw` topic | 任务完成时 | 异步 |
| **Agent-TES** | OpenTelemetry OTLP Exporter | 每个 Span | 异步（后台） |

### 5.2 哪些服务调用 Agent Framework？

| 调用方 | 协议 | 说明 |
|--------|------|------|
| 业务系统 | HTTP POST `/tasks` | 发起新任务 |
| Skill-MDS | HTTP PUT `/agents/{id}/skills` | 推送新技能（可选，也可由 Agent 主动拉取）|

---

## 6. 配置与部署

### 6.1 关键配置项

```yaml
# agent-framework ConfigMap
MEMORY_SERVICE_URL: "http://agent-memory-system.agent-apps.svc:8080"
LLM_API_BASE:       "https://api.openai.com/v1"
LLM_MODEL:          "gpt-4o"
KAFKA_BROKERS:      "kafka.middleware.svc:9092"
OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector.monitoring.svc:4318"
CONTEXT_WINDOW_MAX_TOKENS: "128000"
CONTEXT_COMPRESS_THRESHOLD: "0.8"   # 80% 时触发压缩
```

### 6.2 性能指标

| 指标 | 目标 |
|------|------|
| 任务接收到首次 Think 的延迟 | < 500ms（含 AMS 检索） |
| 每轮 Think-Act-Observe 耗时 | < 5s（LLM latency 主导） |
| Working Memory 读写延迟 | < 20ms |

---

*下一步：[03-Memory-Processing-Pipeline 详细设计](./03-Memory-Processing-Pipeline.md) — 了解 Evidence 如何被处理成可用的记忆*
