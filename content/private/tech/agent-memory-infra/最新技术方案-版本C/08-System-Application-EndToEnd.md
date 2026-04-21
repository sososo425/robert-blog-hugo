---
title: "08-System-Application-EndToEnd 端到端应用场景"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "end-to-end", "场景", "编程助手", "版本C"]
---

# 端到端应用场景：个人编程助手 Agent

> **文档类型**: 应用场景设计（Application Scenario）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **目标读者**: 接入 AMS 的应用工程师、希望理解系统整体价值的架构师
>
> **核心问题**：一个编程助手 Agent 接入 AMS 后，数据怎么流、记忆怎么建、技能怎么长、下次怎么更快？本文用一个完整的真实场景，把整个认知飞轮跑一遍。

---

## 1. 为什么选编程助手场景？

编程助手是最能体现 AMS 全部价值的场景，原因如下：

| AMS 核心能力 | 在编程助手中的体现 |
|---|---|
| **Working Memory** | 当前任务的代码上下文、错误栈、工具调用结果 |
| **Declarative Memory** | 代码库知识（API 文档、架构说明、历史 PR）|
| **Procedural Memory** | 成功的调试套路（"遇到 OOM 先查堆转储"）|
| **Metacognitive Memory** | "这类问题我不擅长，需要先搜文档" |
| **Agent-TES** | 每次工具调用（read_file / run_test / search_code）都有完整 Trace |
| **Skill-MDS** | 反复成功的调试链路自动提炼为可复用 Skill |
| **Multi-Agent** | 架构分析 + 代码修复 + 日志分析三路 Agent 协作 |
| **认知飞轮** | 第 1 次诊断需要摸索，第 5 次同类问题直接按 Skill 执行 |

---

## 2. 系统接入指南（应用方视角）

### 2.1 三分钟最小接入

```python
# requirements.txt
# ams-sdk>=1.0.0
# opentelemetry-sdk>=1.24.0
# opentelemetry-exporter-otlp>=1.24.0

import os
from ams_sdk import AMSClient
from ams_sdk.telemetry import init_telemetry, get_tracer

# ─── Step 1: 初始化（应用启动时执行一次）─────────────────────
ams = AMSClient(
    endpoint=os.getenv("AMS_ENDPOINT", "http://ams-api.internal"),
    api_key=os.getenv("AMS_API_KEY"),
    agent_id=os.getenv("AGENT_ID"),          # 你的 Agent 唯一标识
    tenant_id=os.getenv("TENANT_ID"),
)

# 初始化遥测（自动埋点到本地 OTel Collector Sidecar）
init_telemetry(service_name="coding-assistant", agent_id=ams.agent_id)
tracer = get_tracer("coding-assistant")

# ─── Step 2: 创建会话（每个用户任务开始时）───────────────────
async def handle_user_task(user_message: str) -> str:
    session = await ams.create_session()

    # 检索相关技能和历史记忆（自动注入到 Prompt）
    context = await ams.retrieve(
        query=user_message,
        session_id=session.session_id,
        scope="all",     # private + shared + hierarchy
        top_k=5
    )

    # 执行 Agent 逻辑（你的业务代码）
    result = await run_agent(user_message, context, session, tracer)

    # ─── Step 3: 结束会话（任务完成时）───────────────────────
    await ams.close_session(
        session_id=session.session_id,
        outcome="success",
        summary=result.summary,    # < 200字的任务摘要
        final_answer=result.answer
    )
    return result.answer
```

### 2.2 标准接入（推荐）

在最小接入基础上，增加工具调用的精细 Span 埋点：

```python
async def run_tool(tool_name: str, tool_input: dict,
                   session: Session, tracer) -> dict:
    """所有工具调用统一走此函数，自动埋点"""
    with tracer.start_as_current_span("agent.act") as span:
        span.set_attribute("agent.id",          ams.agent_id)
        span.set_attribute("agent.session_id",  session.session_id)
        span.set_attribute("agent.task_id",     session.current_task_id)
        span.set_attribute("agent.node_type",   "act")
        span.set_attribute("agent.tool_name",   tool_name)
        span.set_attribute("agent.tool_call_id", str(uuid4()))

        try:
            result = await TOOL_REGISTRY[tool_name](tool_input)
            span.set_attribute("agent.tool_success",     True)
            span.set_attribute("agent.tool_output_size", len(str(result)))
            return result
        except Exception as e:
            span.set_attribute("agent.tool_success",    False)
            span.set_attribute("agent.tool_error_type", type(e).__name__)
            span.record_exception(e)
            raise
```

### 2.3 接入检查清单

```
□ AMS_ENDPOINT 环境变量已配置
□ AMS_API_KEY 已申请并配置
□ AGENT_ID 已在 AMS 控制台注册（指定 agent_type = "specialist"）
□ OTel Collector Sidecar 已通过 Kubernetes Admission Webhook 自动注入
□ 所有工具调用都有 act Span（tool_name / tool_success 属性）
□ 每个任务都有 flush Span（outcome / task_summary / final_answer 属性）
□ 测试：发送一个简单任务，验证 TES Aggregator 收到 ams.trace.ingested
```

---

## 3. 场景设定

### 3.1 用户与系统

**用户**：小王，某互联网公司后端工程师

**Agent 系统**（三 Agent 编排）：

```
用户
 ↓
Orchestrator Agent（编排，持有全局任务状态）
 ├── DB Agent（专注数据库诊断：EXPLAIN / 索引分析 / 慢查询）
 ├── Code Agent（专注代码分析：git blame / 代码搜索 / PR 查询）
 └── Log Agent（专注日志分析：错误日志 / 时序分析 / 指标查询）
```

**背景**：这套系统已运行 3 个月，AMS 中积累了：
- ~500 条 Declarative Memory（代码库文档、架构说明）
- ~200 条 Procedural Memory（历史调试轨迹）
- 12 个 active Skill（自动挖掘生成）
- 其中包含一个 Skill：`sk-f1e2d3c4`「SQL 性能劣化诊断」（3 周前第一次遇到类似问题时生成）

### 3.2 触发事件

**时间**：2026-03-26 周四上午 10:15

**用户输入**：
> "我们的订单查询 API（/api/orders）从今天早上 9 点开始响应变慢，P99 从 200ms 涨到了 5s 以上。昨晚有一次 deploy，帮我查一下根因。"

---

## 4. 全流程数据流（主线）

```
┌──────────────────────────────────────────────────────────────────────┐
│                    完整数据流时序图                                   │
│                                                                      │
│  10:15  用户输入 ──→ Orchestrator                                     │
│           │                                                          │
│           ├─→ [AMS] 创建 session，写入 Working Memory                │
│           ├─→ [AMS] 检索 LTM，命中 Skill "SQL性能劣化诊断"           │
│           │                                                          │
│  10:15  Orchestrator 注入 Skill，拆解子任务，创建 Shared Pool         │
│           │                                                          │
│  10:16  ┌─DB Agent────────────────────────────────────────────┐     │
│         │ explain_plan → sql_query × 3 → index_advisor         │     │
│         │ 发现：orders 表缺少 (user_id, created_at) 复合索引   │     │
│         │ → 写入 Shared Pool                                    │     │
│         └──────────────────────────────────────────────────────┘     │
│           │                                                          │
│  10:16  ┌─Code Agent──────────────────────────────────────────┐     │
│         │ git_log → git_diff → code_search                     │     │
│         │ 发现：昨晚 commit a3f9b2 删除了 migration 里的索引   │     │
│         │ → 写入 Shared Pool                                    │     │
│         └──────────────────────────────────────────────────────┘     │
│           │                                                          │
│  10:17  ┌─Log Agent───────────────────────────────────────────┐     │
│         │ query_metrics → search_error_logs                    │     │
│         │ 发现：P99 劣化起点 09:02，与 deploy 时间吻合         │     │
│         │ → 写入 Shared Pool                                    │     │
│         └──────────────────────────────────────────────────────┘     │
│           │                                                          │
│  10:18  Orchestrator 综合三路发现 → 输出根因报告 + 修复建议          │
│           │                                                          │
│  10:18  session 结束 → flush Span → TES Aggregator                  │
│           │                                                          │
│  10:18  [异步] ams.trace.ingested → MPP → Memory 写入               │
│                                                                      │
│  次日 02:00  Skill-MDS 挖掘 → 技能增强（confidence +0.06）          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. 分阶段详细解析

### Phase 1：任务启动与记忆检索（10:15:00 — 10:15:08）

**用户消息到达 Orchestrator。**

```python
# Orchestrator 处理入口
session = await ams.create_session()
# → Redis: SET session:{sid}:state {...} EX 7200
# → Redis: RPUSH session:{sid}:conv [{"role":"user","content":"订单查询API变慢..."}]

# 检索相关记忆（历史经验 + 技能）
context = await ams.retrieve(
    query="API响应变慢 P99劣化 deploy之后",
    session_id=session.session_id,
    scope="all",
    top_k=5
)
```

**AMS 内部检索路由（Lightweight Mode）**：

```
查询: "API响应变慢 P99劣化 deploy之后"
  │
  ├─→ [BM25 Channel] ES 倒排索引
  │     命中: "SQL慢查询诊断" Block (score: 0.72)
  │           "索引缺失导致全表扫描" Block (score: 0.68)
  │
  ├─→ [Vector Channel] Milvus block_embeddings
  │     命中: "订单表索引优化案例" (cosine: 0.89)
  │           "P99劣化根因分析模板" (cosine: 0.85)
  │
  ├─→ [Skill Channel] Skill Registry
  │     命中: sk-f1e2d3c4 "SQL性能劣化诊断" (relevance: 0.94, success_rate: 0.87)
  │
  └─→ RRF Fusion → Top-5 结果
        #1: Skill sk-f1e2d3c4（RRF score: 0.031）← 排第一！
        #2: "订单表索引优化案例" memory
        #3: "P99劣化根因分析模板" memory
        ...
```

**关键命中**：3 周前同类问题留下的 Skill `sk-f1e2d3c4` 排名第一。

**Skill 内容注入 Prompt**：

```
## 可用技能：SQL 性能劣化诊断（置信度 87%，历史成功率 87%）

适用场景：API 响应时间突然劣化，怀疑与数据库相关

执行步骤：
Step 1: 获取慢查询的执行计划（explain_plan）
Step 2: 检查近期 DDL 变更（git_log，重点关注 migration 文件）
Step 3: 分析索引覆盖率（index_advisor）
Step 4: 对比劣化时间点与 deploy 时间（query_metrics + git_log）
Step 5: 生成修复建议（CREATE INDEX 语句）
```

> **飞轮价值体现**：没有 AMS，Orchestrator 需要先"想清楚"诊断思路（至少 2-3 轮 LLM 推理）。有了 Skill，第一轮就拿到了完整的执行蓝图，**直接节省约 2 分钟和 ~3000 tokens**。

---

### Phase 2：多 Agent 并行执行（10:15:08 — 10:17:45）

**Orchestrator 建立协作结构**：

```python
# 创建共享记忆池（三路 Agent 共享发现）
pool_id = await ams.create_shared_pool(
    pool_name=f"incident_20260326_{session.session_id[:8]}",
    members=[
        {"agent_id": "db_agent_001",   "can_write": True},
        {"agent_id": "code_agent_001", "can_write": True},
        {"agent_id": "log_agent_001",  "can_write": True},
    ],
    created_by="orchestrator_001"
)

# 建立层级关系（子 Agent 可读 Orchestrator 的全局上下文）
await ams.create_agent_hierarchy(
    parent_agent_id="orchestrator_001",
    child_agents=["db_agent_001", "code_agent_001", "log_agent_001"],
    session_id=session.session_id
)

# Orchestrator 写入全局任务目标（子 Agent 可读）
await ams.store_memory(
    content="任务：诊断 /api/orders P99 从 200ms → 5s，onset 09:02，昨晚有 deploy。"
             "关注维度：DB 查询性能、代码变更、日志时序。",
    scope="global",
    agent_id="orchestrator_001"
)
```

**DB Agent 执行流（10:15:10 — 10:16:30）**：

```
think_span:
  → 从 Shared Pool 读取任务目标（Hierarchical Memory）
  → 决策：先执行 EXPLAIN ANALYZE 获取执行计划

act_span[1]: explain_plan
  input:  {sql: "SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20"}
  output: {type: "ALL", rows: 2847392, Extra: "Using filesort"}  ← 全表扫描！
  latency: 4821ms

act_span[2]: sql_query
  input:  {sql: "SHOW INDEX FROM orders"}
  output: [{Key_name: "PRIMARY"}, {Key_name: "idx_status"}]  ← 没有 user_id 索引！

act_span[3]: index_advisor
  input:  {explain: {...}, table_stats: {...}}
  output: {recommendation: "CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC)"}

think_span:
  → 综合分析：orders 表缺少 (user_id, created_at) 复合索引，导致全表扫描
  → 写入 Shared Pool

# DB Agent 将发现写入共享池（Append-Only，无冲突）
await ams.append_to_pool(
    pool_id=pool_id,
    content="""
    DB 诊断结论：
    - orders 表缺少复合索引 (user_id, created_at)
    - 当前查询走全表扫描（2.8M 行），耗时 ~4.8s
    - 修复方案：CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC)
    - 预期修复后：Index Range Scan，rows ~20，耗时 <10ms
    """,
    agent_id="db_agent_001"
)

flush_span:
  outcome: "success"
  tool_chain: ["explain_plan", "sql_query", "index_advisor"]
  task_summary: "发现orders表缺失复合索引导致全表扫描"
```

**Code Agent 执行流（10:15:10 — 10:16:50，与 DB Agent 并行）**：

```
act_span[1]: git_log
  input:  {path: "db/migrations/", since: "2026-03-25"}
  output: [{hash: "a3f9b2", msg: "fix: remove duplicate index", author: "dev_chen", time: "03-25 22:47"}]

act_span[2]: git_diff
  input:  {hash: "a3f9b2"}
  output: |
    - CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
    + -- Removed: duplicate with idx_user (incorrect assumption)

act_span[3]: code_search
  input:  {query: "idx_orders_user_created OR idx_user", type: "migration"}
  output: {找到 idx_user 只覆盖 user_id 单列，并非重复}

# 发现：commit a3f9b2 错误删除了复合索引（误以为与单列索引重复）
await ams.append_to_pool(
    pool_id=pool_id,
    content="""
    Code 诊断结论：
    - commit a3f9b2（03-25 22:47，dev_chen）删除了 idx_orders_user_created
    - 删除原因：误判为 idx_user 的重复索引（实际并非重复）
    - idx_user 仅覆盖 user_id 单列，不支持 ORDER BY created_at 的排序优化
    """,
    agent_id="code_agent_001"
)
```

**Log Agent 执行流（10:15:10 — 10:17:00，与上两路并行）**：

```
act_span[1]: query_metrics
  input:  {metric: "api_latency_p99", endpoint: "/api/orders", hours: 24}
  output: {劣化起点: "2026-03-26 09:02:15", 之前p99: 198ms, 之后p99: 4923ms}

act_span[2]: search_error_logs
  input:  {service: "order-service", since: "09:00", level: "WARN"}
  output: {大量 "Slow query" 日志，起点 09:02:18}

# 部署时间 vs 劣化时间对比
# deploy 完成时间: 09:01:52（从 CI/CD 系统查询）
# 劣化起点:        09:02:15  ← 23 秒后，完全吻合

await ams.append_to_pool(
    pool_id=pool_id,
    content="""
    Log 诊断结论：
    - P99 劣化起点：09:02:15，与 deploy 完成时间（09:01:52）相差 23s
    - 时序完全吻合，可确认 deploy 为根因触发点
    - Slow query 日志与劣化时间完全对齐
    """,
    agent_id="log_agent_001"
)
```

---

### Phase 3：综合结论与会话结束（10:17:45 — 10:18:20）

**Orchestrator 从 Shared Pool 综合三路发现**：

```python
# 检索共享池的所有发现
findings = await ams.retrieve(
    query="根因分析 诊断结论",
    agent_id="orchestrator_001",
    scope="pool",    # 检索 Shared Pool
    session_id=session.session_id
)

# LLM 综合 → 输出最终报告
final_report = await llm.synthesize(findings)
```

**最终输出**（用户看到的内容）：

```
根因分析报告 - /api/orders P99 劣化

【根因】
commit a3f9b2（昨晚 22:47，dev_chen）误删了 orders 表上的复合索引
idx_orders_user_created(user_id, created_at)，导致订单列表查询退化为全表扫描。

【证据链】
1. [DB] orders 表当前无 user_id+created_at 复合索引，查询全表扫 2.8M 行，耗时 ~4.8s
2. [Code] git diff a3f9b2 确认该索引在昨晚 22:47 被删除
3. [Log] P99 劣化起点 09:02:15，与 deploy 完成（09:01:52）相差 23s，时序吻合

【修复方案】
立即执行（预计 orders 表重建索引约 3-5 分钟）：
  CREATE INDEX CONCURRENTLY idx_orders_user_created
    ON orders(user_id, created_at DESC);

【预期效果】
索引重建完成后，P99 预计恢复到 <200ms。

【建议】
在 code review checklist 中增加"删除索引需确认所有依赖查询"的检查项。
```

**会话关闭（flush）**：

```python
await ams.close_session(
    session_id=session.session_id,
    outcome="success",
    total_turns=8,
    summary="诊断出orders表缺失复合索引，原因是昨晚commit误删，给出了CONCURRENTLY建索引的修复方案",
    final_answer=final_report,
    skill_used="sk-f1e2d3c4",
    skill_matched=True   # Skill 的步骤确实有效指导了诊断
)
# → TES flush_span 发送 → TES Aggregator → ams.trace.ingested
```

---

### Phase 4：异步记忆写入（10:18:20 — 10:25:00，后台）

**MPP Trace Pipeline 消费 `ams.trace.ingested`**：

```
消息到达 MPP → Trace Pipeline Worker

① 评分（Importance Scoring）
  - outcome = "success" → +0.3
  - total_turns = 8 → +0.1（非简单任务）
  - skill_matched = True → +0.2（技能得到验证）
  - 综合 importance = 0.82（高重要性）→ 进入长期记忆

② 写入 memory_records（PostgreSQL）
  memory_id: "mem-2026-03-26-abc123"
  agent_id: "orchestrator_001"
  memory_type: "procedural"
  memory_subtype: "workflow"
  source_type: "agent_trace"
  importance: 0.82
  title: "订单API P99劣化诊断（索引缺失）"
  summary: "因commit误删复合索引导致全表扫描，3路Agent协作5分钟内定位根因"
  structures: ["graph"]    ← agent_trace 只允许 Graph（见数据源映射规则）

③ Graph Construction Pipeline
  → NER 抽取 PhraseNode:
    "缺失索引" / "全表扫描" / "orders表" / "user_id+created_at"
    "P99劣化" / "commit a3f9b2" / "deploy" / "23秒延迟"

  → Relation Edge 构建（LLM 推断）:
    (commit a3f9b2) -[CAUSED]→ (缺失索引)
    (缺失索引)      -[CAUSED]→ (全表扫描)
    (全表扫描)      -[CAUSED]→ (P99劣化)
    (deploy)        -[TRIGGERED_AT]→ (09:01:52)
    (P99劣化)       -[STARTED_AT]→ (09:02:15)

  → Temporal KG（时序标注）:
    所有 CAUSED 边标注 temporal: "2026-03-26"
    有效期: 180天（procedural memory 默认保留半年）

  → Community 检测（Leiden）:
    社区 #1: {缺失索引, 全表扫描, P99劣化, orders表} → Community Summary:
             "订单表索引缺失导致查询性能劣化的典型模式"
    社区 #2: {commit, deploy, 时序} → Community Summary:
             "代码变更与性能劣化的时序关联证据链"

  → 写入 Neo4j + Milvus（node_embeddings + community_embeddings）
  → 写入 ES 全文索引（ams_memories）
  → 更新 memory_records.structures_status: {"graph": "completed"}

④ Skill 使用反馈回写
  skill_usage_log 写入一条记录：
  skill_id: "sk-f1e2d3c4", outcome: "success", matched: true, latency_ms: 185000
  → Skill success_count + 1, total_count + 1
  → 实时 success_rate 更新: 0.87 → 0.88
```

---

### Phase 5：Skill 增强（次日 02:00 UTC，异步）

**Skill-MDS 每日挖掘任务触发**：

```
扫描过去 7 天 ClickHouse agent_task_summary:

orchestrator_001 成功任务中：
  工具链 ["explain_plan", "sql_query", "index_advisor", "git_log", "git_diff", "query_metrics"]
  出现 4 次（本次 + 历史 3 次），成功率 100%

→ HDBSCAN 聚类：与现有 Skill sk-f1e2d3c4 的工具链向量相似度 0.96 > 0.92 阈值
→ 判断为"版本升级"而非"新技能"

Skill sk-f1e2d3c4 版本升级：
  旧版本（1.0.0）工具链：["explain_plan", "sql_query", "index_advisor"]
  新版本（1.1.0）工具链：增加 "git_log", "git_diff", "query_metrics"（三路协作模式）

LLM 精炼新 skill.md：
  - 新增"Step 4: 查询近期 DDL 变更（git_log + git_diff）"
  - 新增"Step 5: 对比时序（query_metrics）"
  - 更新"适用场景"：明确包含"deploy 后性能劣化"
  - confidence_score: 0.83 → 0.87（样本增加）

Sandbox 验证通过（score: 0.78 > 0.6）
→ 旧版本标记为 deprecated
→ 新版本 sk-f1e2d3c4-v2 status: "active"
→ Kafka: ams.skill.deprecated（触发 AMS Skill Cache 失效）
→ 新技能 skill.md 写入 Procedural Memory Tree
```

---

### Phase 6：飞轮闭合——下次同类问题（2 周后）

**新用户输入**：
> "昨天 deploy 之后 /api/products 的搜索接口变慢了，P99 从 300ms 到 8s"

**对比：有无 AMS 的差异**：

| 阶段 | 无 AMS（第一次遇到）| 有 AMS（飞轮已转）| 节省 |
|---|---|---|---|
| 诊断思路确定 | 3-4 轮 LLM 推理，~5 min | Skill 直接注入，0 轮额外推理 | ~5 min |
| 工具调用次数 | 8-10 次（摸索）| 5-6 次（按 Skill 步骤）| ~3 次 |
| Token 消耗 | ~8,000 tokens | ~3,500 tokens | ~56% |
| 总耗时 | ~20 min | ~7 min | ~65% |
| 结论准确率 | 中等（依赖当次 LLM 质量）| 高（经过 4 次成功验证的模式）| 显著提升 |

> **这就是认知飞轮的核心价值**：AMS 不只是"记忆存储"，而是让 Agent 随使用次数增加**越来越聪明**。每一次成功的诊断都在强化技能，每一次强化的技能都在降低下次的成本。

---

## 6. 内部数据加工全景图

```
                    ┌─────────────────────────────────────────────────┐
                    │              数据加工流水线总览                  │
                    │                                                 │
  原始输入            │  加工层                    存储层               │
  ──────────         │  ──────────────────         ──────────────────  │
                    │                                                 │
  OTel Span         │  TES Aggregator              ClickHouse         │
  (act/think/flush) │  会话聚合 + 边界检测  ──────→ agent_spans         │
       │            │       │                      agent_task_summary  │
       ▼            │       │                                         │
  ams.spans.raw     │       ▼                                         │
  (Kafka)           │  ams.trace.ingested                             │
       │            │  (Kafka)                                        │
       ▼            │       │                                         │
  TES Aggregator    │       ▼                                         │
       │            │  MPP Trace Pipeline                             │
       │            │  ┌──────────────────────────────────────┐       │
       │            │  │ ① 重要性评分（outcome/turns/skill）  │       │
       │            │  │ ② 写入 memory_records（PG）          │       │
       │            │  │ ③ NER 实体抽取                       │       │
       │            │  │ ④ Relation Edge 推断（LLM）          │       │
       │            │  │ ⑤ Temporal KG 构建                   │       │
       │            │  │ ⑥ Leiden 社区检测                    │       │
       │            │  │ ⑦ Community Summary 生成（LLM）      │       │
       │            │  │ ⑧ Embedding 生成（各层级）           │       │
       │            │  └──────────────────────────────────────┘       │
       │            │       │                                         │
       │            │       ├──→ Neo4j (PhraseNode + Edge + Community)│
       │            │       ├──→ Milvus (node_embeddings)             │
       │            │       ├──→ ES (全文索引)                        │
       │            │       └──→ PG memory_records (状态更新)         │
       │            │                                                 │
       │            │  [每日 02:00]                                   │
       │            │  Skill-MDS Mining Pipeline                      │
       │            │  ┌──────────────────────────────────────┐       │
       │            │  │ ① ClickHouse 工具链统计采集           │       │
       │            │  │ ② Neo4j 图路径采集                    │       │
       │            │  │ ③ 向量化（structural + semantic）     │       │
       │            │  │ ④ HDBSCAN 聚类                        │       │
       │            │  │ ⑤ 代表性工具链选取                    │       │
       │            │  │ ⑥ LLM 精炼生成 skill.md              │       │
       │            │  │ ⑦ Sandbox 验证（格式+工具+回测）      │       │
       │            │  │ ⑧ 注册到 Skill Registry              │       │
       │            │  │ ⑨ Skill Mesh 边自动推断               │       │
       │            │  └──────────────────────────────────────┘       │
       │            │       │                                         │
       │            │       ├──→ PG skill_registry                    │
       │            │       ├──→ Milvus skill_embeddings              │
       │            │       ├──→ Neo4j Skill Mesh                     │
       │            │       └──→ OSS skill.md 文件                    │
       │            │                                                 │
       │            │  [实时，每次查询]                               │
       │            │  AMS 检索路由                                   │
       │            │  BM25 + Vector + Graph + Skill → RRF Fusion     │
       │            │  → Agent Prompt 上下文注入                      │
       │            └─────────────────────────────────────────────────┘
```

---

## 7. 常见接入模式

### 模式 A：最小接入（仅 Working Memory + 检索）

**适用**：快速验证 AMS 价值，不改造现有 Agent 架构

```
接入内容：create_session / retrieve / close_session
获得价值：历史记忆检索、Skill 注入、跨会话知识积累
缺少：    精细的工具调用 Trace（Skill 挖掘效果有限）
```

### 模式 B：标准接入（+ TES 全链路 Trace）

**适用**：生产环境推荐

```
接入内容：模式A + 所有工具调用 act Span + think/flush Span
获得价值：完整技能挖掘、自动 Skill 生成、精准降级检测
要求：    所有工具调用通过 run_tool() 统一函数
```

### 模式 C：深度接入（+ 多 Agent 协作）

**适用**：编排型多 Agent 系统

```
接入内容：模式B + Shared Pool + Agent Hierarchy
获得价值：多路 Agent 协作记忆共享、子 Agent 继承父上下文、ACL 权限管控
要求：    Orchestrator 负责 Pool 生命周期管理
```

---

## 8. 调试与排错指南

### 8.1 记忆没有被检索到

```python
# 诊断步骤
# 1. 确认记忆是否写入成功
record = await ams.get_memory_status(memory_id="mem-xxx")
print(record.structures_status)
# 期望: {"graph": "completed"} 或 {"tree": "completed", "graph": "completed"}
# 若为 "pending" / "processing"：Pipeline 尚未处理完，等待 30s 重试

# 2. 确认 Embedding 是否生成
# → 查看 Milvus node_embeddings 集合中是否有对应 memory_id

# 3. 确认检索参数
context = await ams.retrieve(
    query="...",
    scope="all",      # 确保包含目标记忆的 scope
    debug=True        # 开启调试模式，返回各通道详细得分
)
print(context.debug_info)
# 输出: {bm25: [...], vector: [...], skill: [...], rrf_merged: [...]}
```

### 8.2 Skill 没有被挖掘出来

```
检查清单：
□ flush Span 有没有发送？（TES Aggregator 有没有收到 flush？）
□ outcome 是否为 "success"？（失败任务不触发 Skill 挖掘）
□ total_turns >= 5？（少于 5 轮的简单任务默认不挖掘）
□ 同类工具链出现次数 >= 5 次？（HDBSCAN min_cluster_size=3，但 min_occurrences=5）
□ 查看 ClickHouse: SELECT tool_chain, count() FROM agent_task_summary
    WHERE agent_id='xxx' AND outcome='success' GROUP BY tool_chain ORDER BY count() DESC
```

### 8.3 会话延迟过高

```
诊断分层：
> Working Memory p99 > 50ms？
  → 检查 Redis 内存使用率（目标 < 80%）
  → 检查 Redis Cluster 是否有节点故障（redis-cli cluster nodes）

> LTM 检索 p95 > 200ms？
  → 检查 Milvus queryNode CPU（HNSW ef 参数是否过大）
  → 检查 Neo4j 图查询（是否缺少索引，PROFILE 查询计划）
  → 若 Agentic Mode：检查 LLM 调用延迟（query expansion 步骤）

> Session 创建 p99 > 100ms？
  → 检查 Redis 网络 RTT（目标同 AZ < 2ms）
  → 检查是否触发了大量 LTM 检索（top_k 是否过大）
```

---

*本文档描述了 AMS 在编程助手场景下的完整应用全流程。将此文档与以下模块结合阅读，可获得最完整的理解：*
- *01-AMS（API 接口全貌）*
- *02-Pipeline（Phase 4 内部数据加工的详细实现）*
- *05-Skill-MDS（Phase 5 技能增强的详细实现）*
- *06-Multi-Agent（Phase 2 多 Agent 协作的详细实现）*
