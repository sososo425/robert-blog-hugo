---
title: "07-API-Design 详细设计"
date: 2026-03-23T22:30:00+08:00
draft: true
tags: ["agent-memory", "api", "rest", "sdk", "详细设计", "版本B"]
---

# API 接口设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: AMS 对外暴露的完整 REST API 规范及 Python SDK 示例

---

## 1. API 设计原则

### 1.1 通用规范

| 项目 | 规范 |
|------|------|
| 基础路径 | `/api/v1/memory` |
| 数据格式 | JSON（Content-Type: application/json）|
| 鉴权 | Bearer Token（JWT，Header: `Authorization: Bearer <token>`）|
| 版本策略 | URL 路径版本化（v1, v2...），主版本不兼容时升级 |
| 错误码 | HTTP 状态码 + 业务 code 字段 |
| 幂等性 | PUT/PATCH 幂等；POST 非幂等（含唯一 ID 则幂等化）|

### 1.2 统一响应格式

```json
// 成功响应
{
  "code":    0,
  "message": "ok",
  "data":    { ... },
  "request_id": "req_abc123"   // 用于链路追踪
}

// 错误响应
{
  "code":    40001,
  "message": "agent_id is required",
  "data":    null,
  "request_id": "req_abc123"
}
```

**业务错误码**：

| code | HTTP 状态 | 含义 |
|------|-----------|------|
| 0 | 200 | 成功 |
| 40001 | 400 | 参数缺失或格式错误 |
| 40401 | 404 | 资源不存在 |
| 42901 | 429 | 请求频率超限 |
| 50001 | 500 | 内部服务错误 |
| 50301 | 503 | 依赖服务不可用（Milvus/Redis 等）|

---

## 2. Working Memory API

### 2.1 接口列表

```
GET    /api/v1/memory/working/{agent_id}
PUT    /api/v1/memory/working/{agent_id}
PATCH  /api/v1/memory/working/{agent_id}
DELETE /api/v1/memory/working/{agent_id}
```

### 2.2 接口详情

#### GET /working/{agent_id} — 获取工作记忆

```http
GET /api/v1/memory/working/agent_001
Authorization: Bearer <token>
```

**成功响应（200）**：
```json
{
  "code": 0,
  "data": {
    "agent_id":      "agent_001",
    "session_id":    "sess_abc123",
    "task_summary":  "帮用户修复 sales.csv 的乱码问题",
    "current_plan":  ["检测编码", "读取文件", "验证行数"],
    "completed_steps": ["检测编码"],
    "known_facts":   {"file": "sales.csv", "encoding": "gbk"},
    "tool_results":  [{"tool": "chardet.detect", "result": {"encoding": "gbk"}}],
    "context_tokens": 8420,
    "updated_at":    "2026-03-23T10:01:30Z"
  }
}
```

**资源不存在（404）**：
```json
{"code": 40401, "message": "working memory not found for agent_001"}
```

#### PUT /working/{agent_id} — 全量写入工作记忆

```http
PUT /api/v1/memory/working/agent_001
Content-Type: application/json

{
  "session_id":    "sess_abc123",
  "task_summary":  "帮用户修复 sales.csv 的乱码问题",
  "current_plan":  ["检测编码", "读取文件", "验证行数"],
  "completed_steps": [],
  "known_facts":   {},
  "context_tokens": 1200
}
```

- 若 key 不存在，创建（TTL 3600s）
- 若 key 已存在，全量覆盖并重置 TTL

#### PATCH /working/{agent_id} — 部分更新工作记忆

```http
PATCH /api/v1/memory/working/agent_001
Content-Type: application/json

{
  "known_facts": {"file": "sales.csv", "encoding": "gbk"},
  "completed_steps": ["检测编码"]
}
```

- 仅更新传入的字段，其余字段保持原值
- 同时续期 TTL（续 3600s）

#### DELETE /working/{agent_id} — 清除工作记忆

```http
DELETE /api/v1/memory/working/agent_001
```

- 任务结束时调用，DEL Redis key
- 响应：`{"code": 0, "message": "deleted"}`

---

## 3. Memory Search API

### 3.1 统一搜索入口

```http
POST /api/v1/memory/search
```

这是 Agent Framework 最常调用的接口，支持多层并行检索。

**请求体**：
```json
{
  "query":     "如何处理 CSV 文件的字符编码问题",
  "agent_id":  "agent_001",
  "layers":    ["episode", "procedural", "semantic"],
  "top_k":     8,
  "filters": {
    "outcome":     "success",          // 仅返回成功的 Episode（可选）
    "time_range":  {"days": 90},       // 仅返回最近90天（可选）
    "importance_gte": 5.0              // 最低重要性（可选）
  },
  "enable_rerank": false               // 是否开启 BGE 精排（可选，默认 false）
}
```

**参数说明**：

| 字段 | 必填 | 说明 |
|------|:----:|------|
| `query` | ✅ | 搜索文本，会生成 embedding |
| `agent_id` | ✅ | Agent 身份，用于权限过滤 |
| `layers` | 否 | 默认 `["episode","procedural","semantic"]` |
| `top_k` | 否 | 默认 10，最大 50 |
| `filters` | 否 | 可选过滤条件 |
| `enable_rerank` | 否 | `true` 时开启 BGE Cross-Encoder 精排 |

**`layers` 可选值**：

| 值 | 对应存储 | 说明 |
|----|---------|------|
| `"working"` | Redis | 当前工作记忆（一般不用于检索）|
| `"episode"` | Milvus + PostgreSQL | 历史执行经验 |
| `"procedural"` | Milvus + PostgreSQL | 技能库 |
| `"semantic"` | Milvus + PostgreSQL + Neo4j | Block + Summary + 图 |

**成功响应（200）**：
```json
{
  "code": 0,
  "data": {
    "results": [
      {
        "memory_id":   "ep_abc123",
        "layer":       "episode",
        "title":       "CSV乱码修复（sales.csv，gbk编码）",
        "content":     "任务：帮用户修复 sales.csv 乱码...\n结果：success（encoding='gbk'解决）",
        "score":       0.91,
        "importance":  8.5,
        "outcome":     "success",
        "event_time":  "2026-01-15T09:30:00Z",
        "tags":        ["csv", "encoding", "gbk", "pandas"]
      },
      {
        "memory_id":   "sk_def456",
        "layer":       "procedural",
        "title":       "csv-encoding-diagnosis",
        "content":     "触发场景：CSV乱码问题\n步骤：1.chardet.detect → 2.pd.read_csv(encoding=...) → 3.验证行数",
        "score":       0.88,
        "importance":  null,
        "metadata": {
          "success_rate": 0.94,
          "usage_count":  127,
          "avg_turns":    3.2,
          "workflow_steps": [
            {"step": 1, "action": "检测编码", "tool": "chardet.detect"},
            {"step": 2, "action": "读取CSV",  "tool": "pd.read_csv"},
            {"step": 3, "action": "验证行数", "tool": "df.shape"}
          ]
        }
      },
      {
        "memory_id":   "blk_ghi789",
        "layer":       "semantic",
        "title":       "Pandas read_csv encoding 参数说明",
        "content":     "read_csv 的 encoding 参数接受 Python 标准编码名称...",
        "score":       0.76,
        "importance":  null,
        "metadata": {
          "doc_id":     "doc_pandas_guide",
          "block_type": "text",
          "source_url": "https://pandas.pydata.org/docs/"
        }
      }
    ],
    "total":        3,
    "latency_ms":   68,
    "paths_used":   ["episode", "procedural", "semantic_block"],
    "reranked":     false
  }
}
```

---

## 4. Episode Memory API

### 4.1 接口列表

```
POST   /api/v1/memory/episodes            写入 Episode
GET    /api/v1/memory/episodes/{id}       获取 Episode 详情
GET    /api/v1/memory/episodes            列举（分页，含过滤）
PATCH  /api/v1/memory/episodes/{id}       更新字段（如 consolidated）
DELETE /api/v1/memory/episodes/{id}       删除
```

### 4.2 写入 Episode

```http
POST /api/v1/memory/episodes
Content-Type: application/json

{
  "agent_id":    "agent_001",
  "session_id":  "sess_abc123",
  "event_time":  "2026-03-23T10:05:00Z",
  "title":       "CSV乱码修复（sales.csv，gbk编码）",
  "content":     "任务：帮用户修复 sales.csv 乱码\n结果：...",
  "importance":  8.5,
  "outcome":     "success",
  "tags":        ["csv", "encoding", "gbk"],
  "visibility":  "private"
}
```

**AMS 内部处理**：
1. 若 `content` > 4KB，存入 OSS，记录 `content_oss_key`
2. 生成 embedding，写入 Milvus `episodes` collection
3. 元数据写入 PostgreSQL `episodes` 表
4. 检查是否满足 ConsolidationEngine 触发条件

**成功响应（201）**：
```json
{
  "code": 0,
  "data": {
    "episode_id":  "ep_abc123xyz",
    "ingestion_time": "2026-03-23T10:05:02Z"
  }
}
```

### 4.3 列举 Episode

```http
GET /api/v1/memory/episodes?agent_id=agent_001&outcome=success&limit=20&offset=0
```

| 参数 | 说明 |
|------|------|
| `agent_id` | 必填 |
| `outcome` | 可选：success/failure/partial |
| `importance_gte` | 可选：最低重要性过滤 |
| `consolidated` | 可选：true/false |
| `limit` | 默认 20，最大 100 |
| `offset` | 分页偏移 |

---

## 5. Knowledge（语义记忆）API

### 5.1 统一写入入口

```http
POST /api/v1/memory/knowledge
```

通过 `type` 字段区分写入的数据类型：

#### 写入 Block

```json
{
  "type":       "block",
  "agent_id":   null,              // null = 公共知识
  "content":    "pandas read_csv 的 encoding 参数...",
  "block_type": "text",            // text / table / img
  "metadata": {
    "doc_id":      "doc_pandas_guide",
    "chunk_index": 3,
    "source_url":  "https://pandas.pydata.org/docs/"
  }
}
```

**响应**：
```json
{"code": 0, "data": {"block_id": "blk_abc123"}}
```

#### 写入实体和关系

```json
{
  "type": "entities",
  "entities": [
    {"phrase": "pandas",    "phrase_type": "LIBRARY"},
    {"phrase": "read_csv",  "phrase_type": "FUNCTION"},
    {"phrase": "encoding",  "phrase_type": "CONCEPT"}
  ],
  "relations": [
    {"from": "pandas", "to": "read_csv",  "relation_type": "CONTAINS",  "weight": 10},
    {"from": "read_csv", "to": "encoding", "relation_type": "HAS_PARAM", "weight": 8}
  ],
  "source_block_ids": ["blk_abc123", "blk_def456"]
}
```

#### 写入 Section Summary

```json
{
  "type":         "section_summary",
  "summary_type": "section_l1",    // section_l1 / section_l2 / community
  "content":      "本节介绍了 pandas 读取 CSV 的编码处理方法...",
  "source_ids":   ["blk_abc123", "blk_def456", "blk_ghi789"],
  "metadata":     {"doc_id": "doc_pandas_guide"}
}
```

#### 写入 Community Summary

```json
{
  "type":           "section_summary",
  "summary_type":   "community",
  "community_id":   "cn_csv_encoding",
  "content":        "CSV编码相关概念（pandas, read_csv, chardet, gbk, utf-8）...",
  "member_phrases": ["pandas", "read_csv", "chardet", "gbk", "utf-8"],
  "agent_id":       null
}
```

---

## 6. Skills API

### 6.1 接口列表

```
GET    /api/v1/memory/skills                         列举活跃技能
POST   /api/v1/memory/skills                         写入新技能（Skill-MDS 调用）
GET    /api/v1/memory/skills/{skill_id}               获取技能详情
PATCH  /api/v1/memory/skills/{name}/metrics          更新执行指标（FeedbackAggregator 调用）
GET    /api/v1/memory/skills/{skill_id}/metrics      获取指标摘要
```

### 6.2 更新技能指标

```http
PATCH /api/v1/memory/skills/csv-encoding-diagnosis/metrics
Content-Type: application/json

{
  "success":    true,
  "turns":      3,
  "latency_ms": 4500
}
```

**AMS 内部处理**：
1. 更新 `success_rate`（加权移动平均）
2. 更新 `recent_results`（滑动窗口，最近20次）
3. 若 `recent_success_rate < 0.5` 且样本 >= 5，触发降级告警

**响应**：
```json
{
  "code": 0,
  "data": {
    "skill_name":         "csv-encoding-diagnosis",
    "success_rate":       0.94,
    "usage_count":        128,
    "recent_success_rate": 0.90
  }
}
```

---

## 7. Python SDK 示例

### 7.1 安装与初始化

```python
# pip install agent-memory-client  （假设包名）
from agent_memory import MemoryClient

client = MemoryClient(
    base_url  = "http://agent-memory-system:8080",
    agent_id  = "agent_001",
    api_token = os.getenv("MEMORY_API_TOKEN")
)
```

### 7.2 Working Memory 操作

```python
# 初始化工作记忆
await client.working_memory.put({
    "session_id":    "sess_001",
    "task_summary":  "修复CSV乱码",
    "current_plan":  ["检测编码", "读取", "验证"],
    "known_facts":   {},
    "context_tokens": 1000
})

# 更新部分字段
await client.working_memory.patch({
    "known_facts": {"encoding": "gbk"},
    "completed_steps": ["检测编码"]
})

# 读取
wm = await client.working_memory.get()
print(wm["known_facts"])   # {"encoding": "gbk"}

# 任务结束清除
await client.working_memory.delete()
```

### 7.3 记忆检索

```python
# 统一搜索（最常用接口）
results = await client.search(
    query  = "CSV文件乱码怎么处理",
    layers = ["episode", "procedural"],
    top_k  = 5
)

for r in results:
    print(f"[{r.layer}] {r.title}  score={r.score:.2f}")
    if r.layer == "procedural":
        # 技能结果包含 workflow_steps
        for step in r.metadata["workflow_steps"]:
            print(f"  Step {step['step']}: {step['action']} ({step['tool']})")
```

**输出示例**：
```
[episode]    CSV乱码修复（sales.csv，gbk编码）  score=0.91
[procedural] csv-encoding-diagnosis             score=0.88
  Step 1: 检测编码 (chardet.detect)
  Step 2: 读取CSV (pd.read_csv)
  Step 3: 验证行数 (df.shape)
```

### 7.4 写入 Episode

```python
ep_id = await client.episodes.write(
    session_id  = "sess_001",
    event_time  = datetime.utcnow(),
    title       = "CSV乱码修复",
    content     = "任务：修复sales.csv乱码...\n结果：success，encoding='gbk'",
    importance  = 8.5,
    outcome     = "success",
    tags        = ["csv", "encoding", "gbk"]
)
print(f"Episode written: {ep_id}")
```

### 7.5 写入知识 Block

```python
# 写入文本 Block
block_id = await client.knowledge.write_block(
    content    = "pandas read_csv 的 encoding 参数接受...",
    block_type = "text",
    doc_id     = "doc_pandas_guide",
    source_url = "https://pandas.pydata.org/docs/"
)

# 写入表格 Block
table_content = """| 编码 | 说明 |
|------|------|
| utf-8 | 通用 Unicode 编码 |
| gbk | 中文 Windows 常用编码 |"""

block_id = await client.knowledge.write_block(
    content    = table_content,
    block_type = "table",
    doc_id     = "doc_encoding_guide"
)
```

---

## 8. 接口限流与 SLA

| 接口 | QPS 限制（单 Agent）| P99 延迟目标 |
|------|:------------------:|:----------:|
| GET working memory | 1000 | < 5ms |
| PUT/PATCH working memory | 500 | < 10ms |
| POST search | 100 | < 200ms |
| POST episodes（写入）| 50 | < 100ms |
| POST knowledge（写入）| 50 | < 200ms |
| PATCH skill metrics | 200 | < 50ms |

> **注意**：`POST /search` 的延迟受 Milvus ANN 检索影响，开启 `enable_rerank` 后 P99 可能上升至 500ms。

---

*下一步：[08-Multi-Agent-Collaboration 详细设计](./08-Multi-Agent-Collaboration.md)*
