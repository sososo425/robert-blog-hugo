---
title: "详细设计 - API Interface"
date: 2026-03-23
draft: true
tags: ["agent-memory", "api", "fastapi", "design"]
---

# 07 详细设计 - API Interface

## 目录

1. [API 设计原则](#1-api-设计原则)
2. [Memory 核心 API](#2-memory-核心-api)
3. [Episode API](#3-episode-api)
4. [Skill API](#4-skill-api)
5. [Knowledge Graph API](#5-knowledge-graph-api)
6. [Agent Session API](#6-agent-session-api)
7. [Admin API](#7-admin-api)
8. [FastAPI 实现代码](#8-fastapi-实现代码)
9. [API 测试用例](#9-api-测试用例)

---

## 1. API 设计原则

### 1.1 设计风格

本系统采用 RESTful 风格，所有请求和响应均使用 JSON 格式。核心设计约定如下：

- **协议**：HTTPS（生产环境强制）
- **数据格式**：`Content-Type: application/json`
- **字符编码**：UTF-8
- **时间格式**：ISO 8601（`2026-03-23T10:00:00Z`）
- **ID 格式**：UUID v4 字符串
- **分页**：基于 offset/limit，默认 `limit=20`，最大 `limit=100`

### 1.2 统一响应格式

所有接口（包括错误响应）均使用以下统一结构：

```json
{
  "code": 0,
  "data": {},
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

字段说明：

| 字段        | 类型    | 说明                                    |
|-------------|---------|----------------------------------------|
| `code`      | int     | 业务错误码，0 表示成功                   |
| `data`      | any     | 响应数据，成功时为对象或数组              |
| `message`   | string  | 人可读的状态描述                         |
| `request_id`| string  | UUID，用于链路追踪，每次请求唯一生成       |

### 1.3 错误码设计

| 错误码    | HTTP 状态码 | 说明       | 示例场景                   |
| ------ | -------- | -------- | ---------------------- |
| `0`    | 200      | 成功       | 正常返回                   |
| `1001` | 400      | 请求参数校验失败 | `query` 字段为空           |
| `1002` | 401      | 认证失败     | JWT Token 过期或无效        |
| `1003` | 403      | 权限不足     | 跨 agent_id 访问他人数据      |
| `1004` | 404      | 资源不存在    | `memory_id` 不存在        |
| `1005` | 409      | 资源冲突     | 创建重复 skill_name        |
| `1006` | 422      | 语义校验失败   | `memory_type` 值非法      |
| `2001` | 500      | 内部服务错误   | 数据库连接失败                |
| `2002` | 503      | 下游服务不可用  | LanceDB 超时             |
| `2003` | 504      | 请求超时     | 检索超过 5s 全局超时           |
| `3001` | 429      | 请求频率超限   | 超过 100 req/s per agent |

错误响应示例：

```json
{
  "code": 1004,
  "data": null,
  "message": "memory not found: mem_abc123",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 1.4 认证机制

所有 API（除健康检查外）均需在 HTTP Header 中携带 Bearer JWT Token：

```
Authorization: Bearer <jwt_token>
```

JWT Payload 结构：

```json
{
  "sub": "agent_id_or_user_id",
  "agent_id": "agent-001",
  "role": "agent",
  "exp": 1772000000,
  "iat": 1771913600
}
```

- Token 有效期：24 小时（可配置）
- 刷新机制：过期前 1 小时可调用 `/api/v1/auth/refresh` 刷新
- 跨 agent_id 的数据访问需要 `role: admin`

### 1.5 API 版本

所有业务接口统一挂载在 `/api/v1/` 路径下。版本升级策略：
- 兼容性变更：在现有版本内追加字段（向后兼容）
- 破坏性变更：发布 `/api/v2/`，旧版本保持 6 个月过渡期

### 1.6 限流策略

| 维度             | 限制            |
|-----------------|-----------------|
| per agent_id    | 100 req/s       |
| per IP          | 200 req/s       |
| 批量写入接口    | 10 req/s        |

---

## 2. Memory 核心 API

### 2.1 `POST /api/v1/memories/search` - 统一记忆搜索

这是系统最核心的接口，触发多路检索融合流程。

**路径**：`POST /api/v1/memories/search`

**请求参数**：

```json
{
  "query": "用户上次提到的项目需求是什么",
  "memory_types": ["episode", "semantic", "procedural"],
  "top_k": 10,
  "agent_id": "agent-001",
  "filters": {
    "time_range": {
      "start": "2026-01-01T00:00:00Z",
      "end": "2026-03-23T23:59:59Z"
    },
    "importance_min": 0.5
  }
}
```

请求字段说明：

| 字段                    | 类型          | 必填 | 说明                                              |
|-------------------------|---------------|------|--------------------------------------------------|
| `query`                 | string        | 是   | 自然语言查询，最大 2000 字符                       |
| `memory_types`          | string[]      | 否   | 过滤记忆类型，不填则检索全部类型                   |
| `top_k`                 | int           | 否   | 返回结果数，默认 10，最大 50                       |
| `agent_id`              | string        | 是   | Agent 标识，与 JWT 中 agent_id 一致               |
| `filters.time_range`    | object        | 否   | 时间范围过滤                                       |
| `filters.importance_min`| float         | 否   | 最低重要性评分，范围 [0, 1]                        |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "results": [
      {
        "memory_id": "mem_550e8400",
        "content": "用户希望在 3 月底前完成 API 文档的编写",
        "score": 0.924,
        "memory_type": "episode",
        "metadata": {
          "created_at": "2026-03-20T14:30:00Z",
          "importance_score": 0.87,
          "episode_id": "ep_abc123",
          "session_id": "sess_xyz789"
        }
      }
    ],
    "total": 1,
    "latency_ms": 42
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

响应字段说明：

| 字段                      | 类型   | 说明                                       |
|---------------------------|--------|--------------------------------------------|
| `results[].memory_id`     | string | 记忆唯一标识                               |
| `results[].content`       | string | 记忆文本内容                               |
| `results[].score`         | float  | 综合相关性评分 [0, 1]                      |
| `results[].memory_type`   | string | 记忆类型：episode/semantic/procedural      |
| `results[].metadata`      | object | 元数据，随 memory_type 不同而有所差异       |
| `total`                   | int    | 命中总数（未分页）                          |
| `latency_ms`              | int    | 服务端检索耗时（毫秒）                      |

**示例 curl**：

```bash
curl -X POST https://api.agent-memory.example.com/api/v1/memories/search \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "用户上次提到的项目需求是什么",
    "memory_types": ["episode", "semantic"],
    "top_k": 10,
    "agent_id": "agent-001",
    "filters": {
      "importance_min": 0.5
    }
  }'
```

**Pydantic 模型**：

```python
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class TimeRangeFilter(BaseModel):
    start: Optional[datetime] = None
    end: Optional[datetime] = None


class MemorySearchFilter(BaseModel):
    time_range: Optional[TimeRangeFilter] = None
    importance_min: Optional[float] = Field(None, ge=0.0, le=1.0)


class MemorySearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000, description="自然语言查询")
    memory_types: Optional[list[str]] = Field(
        None,
        description="记忆类型过滤，可选值：working/episode/procedural/semantic"
    )
    top_k: int = Field(10, ge=1, le=50, description="返回结果数量")
    agent_id: str = Field(..., description="Agent 标识")
    filters: Optional[MemorySearchFilter] = None


class MemoryItem(BaseModel):
    memory_id: str
    content: str
    score: float
    memory_type: str
    metadata: dict


class MemorySearchResponse(BaseModel):
    results: list[MemoryItem]
    total: int
    latency_ms: int
```

---

### 2.2 `POST /api/v1/memories/write` - 写入记忆

**路径**：`POST /api/v1/memories/write`

**请求参数**：

```json
{
  "content": "用户明确表示希望 API 支持批量写入，单次最多 100 条",
  "memory_type": "episode",
  "agent_id": "agent-001",
  "metadata": {
    "session_id": "sess_xyz789",
    "importance_score": 0.75,
    "source": "conversation",
    "tags": ["requirement", "api-design"]
  }
}
```

请求字段说明：

| 字段           | 类型   | 必填 | 说明                                                  |
|----------------|--------|------|------------------------------------------------------|
| `content`      | string | 是   | 记忆内容文本，最大 10000 字符                          |
| `memory_type`  | string | 是   | 记忆类型：`episode`/`procedural`/`semantic`           |
| `agent_id`     | string | 是   | Agent 标识                                            |
| `metadata`     | object | 否   | 附加元数据，支持任意 key-value                         |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "memory_id": "mem_a1b2c3d4",
    "created_at": "2026-03-23T10:15:30Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440001"
}
```

**示例 curl**：

```bash
curl -X POST https://api.agent-memory.example.com/api/v1/memories/write \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "用户明确表示希望 API 支持批量写入",
    "memory_type": "episode",
    "agent_id": "agent-001",
    "metadata": {
      "session_id": "sess_xyz789",
      "importance_score": 0.75
    }
  }'
```

**Pydantic 模型**：

```python
from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime


class MemoryWriteRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=10000)
    memory_type: str = Field(..., pattern="^(episode|procedural|semantic)$")
    agent_id: str = Field(...)
    metadata: Optional[dict[str, Any]] = Field(default_factory=dict)


class MemoryWriteResponse(BaseModel):
    memory_id: str
    created_at: datetime
```

---

### 2.3 `DELETE /api/v1/memories/{memory_id}` - 删除记忆

**路径**：`DELETE /api/v1/memories/{memory_id}`

**路径参数**：

| 参数        | 类型   | 说明         |
|-------------|--------|-------------|
| `memory_id` | string | 记忆唯一标识 |

**Query 参数**：

| 参数       | 类型   | 必填 | 说明               |
|------------|--------|------|--------------------|
| `agent_id` | string | 是   | 用于鉴权校验所有权  |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "deleted": true,
    "memory_id": "mem_a1b2c3d4"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440002"
}
```

**示例 curl**：

```bash
curl -X DELETE "https://api.agent-memory.example.com/api/v1/memories/mem_a1b2c3d4?agent_id=agent-001" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

---

### 2.4 `GET /api/v1/memories/{memory_id}` - 获取记忆详情

**路径**：`GET /api/v1/memories/{memory_id}`

**路径参数**：

| 参数        | 类型   | 说明         |
|-------------|--------|-------------|
| `memory_id` | string | 记忆唯一标识 |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "memory_id": "mem_a1b2c3d4",
    "content": "用户明确表示希望 API 支持批量写入，单次最多 100 条",
    "memory_type": "episode",
    "agent_id": "agent-001",
    "embedding_model": "bge-m3",
    "created_at": "2026-03-23T10:15:30Z",
    "updated_at": "2026-03-23T10:15:30Z",
    "metadata": {
      "session_id": "sess_xyz789",
      "importance_score": 0.75,
      "source": "conversation",
      "tags": ["requirement", "api-design"]
    }
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440003"
}
```

**Pydantic 模型**：

```python
class MemoryDetail(BaseModel):
    memory_id: str
    content: str
    memory_type: str
    agent_id: str
    embedding_model: str
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, Any]
```

---

## 3. Episode API

### 3.1 `POST /api/v1/episodes` - 创建 Episode

**路径**：`POST /api/v1/episodes`

**请求参数**：

```json
{
  "agent_id": "agent-001",
  "session_id": "sess_xyz789",
  "title": "需求讨论：API 批量写入功能",
  "summary": "用户与 Agent 就 API 批量写入接口的技术细节展开讨论，确定了参数规范和限流策略",
  "raw_turns": [
    {
      "role": "user",
      "content": "我希望 API 能支持批量写入记忆",
      "timestamp": "2026-03-23T10:00:00Z"
    },
    {
      "role": "assistant",
      "content": "好的，单次批量最多支持 100 条，超出会返回 400 错误",
      "timestamp": "2026-03-23T10:00:05Z"
    }
  ],
  "importance_score": 0.8,
  "metadata": {
    "task_type": "requirement_gathering",
    "domain": "api-design"
  }
}
```

请求字段说明：

| 字段               | 类型     | 必填 | 说明                              |
|--------------------|----------|------|----------------------------------|
| `agent_id`         | string   | 是   | Agent 标识                        |
| `session_id`       | string   | 是   | 来源 Session ID                   |
| `title`            | string   | 是   | Episode 标题，最大 200 字符        |
| `summary`          | string   | 是   | 摘要文本，最大 5000 字符           |
| `raw_turns`        | array    | 否   | 原始对话轮次                       |
| `importance_score` | float    | 否   | 初始重要性评分 [0, 1]，默认 0.5   |
| `metadata`         | object   | 否   | 附加元数据                         |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "episode_id": "ep_f8a9b0c1",
    "agent_id": "agent-001",
    "created_at": "2026-03-23T10:15:30Z",
    "importance_score": 0.8
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440004"
}
```

**Pydantic 模型**：

```python
class TurnItem(BaseModel):
    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str
    timestamp: datetime


class EpisodeCreateRequest(BaseModel):
    agent_id: str
    session_id: str
    title: str = Field(..., max_length=200)
    summary: str = Field(..., max_length=5000)
    raw_turns: Optional[list[TurnItem]] = None
    importance_score: float = Field(0.5, ge=0.0, le=1.0)
    metadata: Optional[dict[str, Any]] = Field(default_factory=dict)


class EpisodeCreateResponse(BaseModel):
    episode_id: str
    agent_id: str
    created_at: datetime
    importance_score: float
```

---

### 3.2 `GET /api/v1/episodes/{episode_id}` - 获取 Episode 详情

**路径**：`GET /api/v1/episodes/{episode_id}`

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "episode_id": "ep_f8a9b0c1",
    "agent_id": "agent-001",
    "session_id": "sess_xyz789",
    "title": "需求讨论：API 批量写入功能",
    "summary": "用户与 Agent 就 API 批量写入接口的技术细节展开讨论",
    "importance_score": 0.8,
    "access_count": 3,
    "last_accessed_at": "2026-03-23T11:00:00Z",
    "created_at": "2026-03-23T10:15:30Z",
    "metadata": {
      "task_type": "requirement_gathering"
    }
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440005"
}
```

---

### 3.3 `GET /api/v1/episodes` - Episode 列表查询

**路径**：`GET /api/v1/episodes`

**Query 参数**：

| 参数           | 类型   | 必填 | 默认值 | 说明                              |
|----------------|--------|------|--------|----------------------------------|
| `agent_id`     | string | 是   | -      | Agent 标识                        |
| `page`         | int    | 否   | 1      | 页码，从 1 开始                   |
| `limit`        | int    | 否   | 20     | 每页数量，最大 100                |
| `sort_by`      | string | 否   | `created_at` | 排序字段                  |
| `sort_order`   | string | 否   | `desc` | 排序方向：asc/desc               |
| `importance_min` | float | 否 | -      | 最低重要性过滤                    |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "episode_id": "ep_f8a9b0c1",
        "title": "需求讨论：API 批量写入功能",
        "importance_score": 0.8,
        "created_at": "2026-03-23T10:15:30Z"
      }
    ],
    "total": 42,
    "page": 1,
    "limit": 20,
    "has_next": true
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440006"
}
```

**示例 curl**：

```bash
curl "https://api.agent-memory.example.com/api/v1/episodes?agent_id=agent-001&page=1&limit=20&sort_by=importance_score&sort_order=desc" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

---

### 3.4 `PUT /api/v1/episodes/{episode_id}/importance` - 更新重要性评分

**路径**：`PUT /api/v1/episodes/{episode_id}/importance`

**请求参数**：

```json
{
  "importance_score": 0.95,
  "reason": "用户多次引用此 Episode，判断为高重要性"
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "episode_id": "ep_f8a9b0c1",
    "importance_score": 0.95,
    "updated_at": "2026-03-23T12:00:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440007"
}
```

**Pydantic 模型**：

```python
class ImportanceUpdateRequest(BaseModel):
    importance_score: float = Field(..., ge=0.0, le=1.0)
    reason: Optional[str] = Field(None, max_length=500)
```

---

## 4. Skill API

### 4.1 `POST /api/v1/skills/search` - 技能语义搜索

**路径**：`POST /api/v1/skills/search`

**请求参数**：

```json
{
  "query": "如何解析 JSON 格式的用户输入",
  "agent_id": "agent-001",
  "top_k": 5,
  "filters": {
    "domain": "data-processing",
    "success_rate_min": 0.8
  }
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "results": [
      {
        "skill_id": "skill_a1b2c3",
        "name": "parse_json_input",
        "description": "解析并校验用户输入的 JSON 数据，支持 schema 验证",
        "score": 0.912,
        "success_rate": 0.95,
        "execution_count": 128,
        "version": "2.1.0",
        "metadata": {
          "domain": "data-processing",
          "tags": ["json", "parsing", "validation"]
        }
      }
    ],
    "total": 1,
    "latency_ms": 28
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440008"
}
```

**Pydantic 模型**：

```python
class SkillSearchFilter(BaseModel):
    domain: Optional[str] = None
    success_rate_min: Optional[float] = Field(None, ge=0.0, le=1.0)
    tags: Optional[list[str]] = None


class SkillSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    agent_id: str
    top_k: int = Field(5, ge=1, le=20)
    filters: Optional[SkillSearchFilter] = None


class SkillSearchItem(BaseModel):
    skill_id: str
    name: str
    description: str
    score: float
    success_rate: float
    execution_count: int
    version: str
    metadata: dict
```

---

### 4.2 `GET /api/v1/skills/{skill_id}` - 获取技能详情

**路径**：`GET /api/v1/skills/{skill_id}`

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "skill_id": "skill_a1b2c3",
    "name": "parse_json_input",
    "description": "解析并校验用户输入的 JSON 数据",
    "code_snippet": "def parse_json_input(raw: str, schema: dict) -> dict:\n    import json\n    data = json.loads(raw)\n    # validate...\n    return data",
    "parameters": {
      "raw": {"type": "string", "description": "原始 JSON 字符串"},
      "schema": {"type": "object", "description": "JSON Schema 验证规则"}
    },
    "returns": {"type": "object", "description": "解析后的字典对象"},
    "version": "2.1.0",
    "success_rate": 0.95,
    "execution_count": 128,
    "avg_latency_ms": 12,
    "created_at": "2026-01-15T08:00:00Z",
    "updated_at": "2026-03-10T14:00:00Z",
    "metadata": {
      "domain": "data-processing",
      "tags": ["json", "parsing"]
    }
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440009"
}
```

---

### 4.3 `POST /api/v1/skills` - 创建技能

**路径**：`POST /api/v1/skills`

**请求参数**：

```json
{
  "name": "parse_json_input",
  "description": "解析并校验用户输入的 JSON 数据，支持 schema 验证",
  "code_snippet": "def parse_json_input(raw: str, schema: dict) -> dict:\n    ...",
  "parameters": {
    "raw": {"type": "string", "description": "原始 JSON 字符串"},
    "schema": {"type": "object", "description": "验证规则"}
  },
  "returns": {"type": "object"},
  "agent_id": "agent-001",
  "metadata": {
    "domain": "data-processing",
    "tags": ["json", "parsing", "validation"]
  }
}
```

**Pydantic 模型**：

```python
class SkillCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, pattern="^[a-zA-Z0-9_-]+$")
    description: str = Field(..., max_length=2000)
    code_snippet: Optional[str] = Field(None, max_length=50000)
    parameters: Optional[dict[str, Any]] = Field(default_factory=dict)
    returns: Optional[dict[str, Any]] = Field(default_factory=dict)
    agent_id: str
    metadata: Optional[dict[str, Any]] = Field(default_factory=dict)


class SkillCreateResponse(BaseModel):
    skill_id: str
    name: str
    version: str
    created_at: datetime
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "skill_id": "skill_a1b2c3",
    "name": "parse_json_input",
    "version": "1.0.0",
    "created_at": "2026-03-23T10:30:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440010"
}
```

---

### 4.4 `PUT /api/v1/skills/{skill_id}` - 更新技能

**路径**：`PUT /api/v1/skills/{skill_id}`

更新技能会自动递增版本号（Semantic Versioning）。

**请求参数**：

```json
{
  "description": "解析并校验用户输入的 JSON 数据，支持 JSON Schema Draft-7",
  "code_snippet": "def parse_json_input(raw: str, schema: dict) -> dict:\n    # v2 implementation\n    ...",
  "metadata": {
    "domain": "data-processing",
    "tags": ["json", "parsing", "validation", "schema-draft7"]
  }
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "skill_id": "skill_a1b2c3",
    "version": "2.0.0",
    "previous_version": "1.0.0",
    "updated_at": "2026-03-23T11:00:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440011"
}
```

---

### 4.5 `POST /api/v1/skills/{skill_id}/execute` - 记录技能执行

**路径**：`POST /api/v1/skills/{skill_id}/execute`

记录技能的一次执行结果，用于更新统计数据（成功率、平均耗时）。

**请求参数**：

```json
{
  "agent_id": "agent-001",
  "session_id": "sess_xyz789",
  "success": true,
  "latency_ms": 15,
  "error_message": null,
  "input_summary": "解析 512 字节 JSON",
  "output_summary": "成功解析，返回 8 个字段"
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "execution_id": "exec_d4e5f6",
    "skill_id": "skill_a1b2c3",
    "recorded_at": "2026-03-23T10:35:00Z",
    "updated_stats": {
      "success_rate": 0.956,
      "execution_count": 129,
      "avg_latency_ms": 12.1
    }
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440012"
}
```

---

### 4.6 `GET /api/v1/skills/{skill_id}/versions` - 版本历史

**路径**：`GET /api/v1/skills/{skill_id}/versions`

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "skill_id": "skill_a1b2c3",
    "versions": [
      {
        "version": "2.1.0",
        "description": "支持 JSON Schema Draft-7",
        "created_at": "2026-03-10T14:00:00Z",
        "is_current": true
      },
      {
        "version": "1.0.0",
        "description": "初始版本",
        "created_at": "2026-01-15T08:00:00Z",
        "is_current": false
      }
    ]
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440013"
}
```

---

### 4.7 `GET /api/v1/skills/recommendations` - 技能推荐

**路径**：`GET /api/v1/skills/recommendations`

**Query 参数**：

| 参数       | 类型   | 必填 | 说明                         |
|------------|--------|------|------------------------------|
| `task`     | string | 是   | 任务描述文本                  |
| `agent_id` | string | 是   | Agent 标识                    |
| `top_k`    | int    | 否   | 推荐数量，默认 3              |

**示例 curl**：

```bash
curl "https://api.agent-memory.example.com/api/v1/skills/recommendations?task=解析用户上传的JSON文件&agent_id=agent-001&top_k=3" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "recommendations": [
      {
        "skill_id": "skill_a1b2c3",
        "name": "parse_json_input",
        "relevance_score": 0.94,
        "reason": "技能名称和描述与任务高度匹配，历史成功率 95.6%"
      }
    ],
    "task": "解析用户上传的 JSON 文件"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440014"
}
```

---

## 5. Knowledge Graph API

### 5.1 `POST /api/v1/kg/entities` - 批量创建实体

**路径**：`POST /api/v1/kg/entities`

**请求参数**：

```json
{
  "agent_id": "agent-001",
  "entities": [
    {
      "name": "FastAPI",
      "entity_type": "Technology",
      "description": "Python 高性能 Web 框架，基于 Starlette 和 Pydantic",
      "properties": {
        "language": "Python",
        "category": "web-framework",
        "github_stars": 75000
      }
    },
    {
      "name": "LanceDB",
      "entity_type": "Technology",
      "description": "基于 Lance 格式的向量数据库",
      "properties": {
        "language": "Rust/Python",
        "category": "vector-database"
      }
    }
  ]
}
```

请求字段说明：

| 字段                   | 类型   | 必填 | 说明                              |
|------------------------|--------|------|----------------------------------|
| `agent_id`             | string | 是   | Agent 标识                        |
| `entities`             | array  | 是   | 实体列表，最多 50 个              |
| `entities[].name`      | string | 是   | 实体名称，在同一 agent 内唯一     |
| `entities[].entity_type` | string | 是 | 实体类型（如 Person/Technology/Concept）|
| `entities[].description` | string | 否 | 描述文本，用于向量化              |
| `entities[].properties` | object | 否 | 附加属性                          |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "created": [
      {"entity_id": "ent_001", "name": "FastAPI"},
      {"entity_id": "ent_002", "name": "LanceDB"}
    ],
    "skipped": [],
    "errors": []
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440015"
}
```

**Pydantic 模型**：

```python
class EntityItem(BaseModel):
    name: str = Field(..., max_length=200)
    entity_type: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    properties: Optional[dict[str, Any]] = Field(default_factory=dict)


class KGEntitiesCreateRequest(BaseModel):
    agent_id: str
    entities: list[EntityItem] = Field(..., min_length=1, max_length=50)
```

---

### 5.2 `POST /api/v1/kg/relations` - 批量创建关系

**路径**：`POST /api/v1/kg/relations`

**请求参数**：

```json
{
  "agent_id": "agent-001",
  "relations": [
    {
      "source_entity_id": "ent_001",
      "target_entity_id": "ent_002",
      "relation_type": "USES",
      "properties": {
        "description": "Agentic Memory 系统使用 LanceDB 存储向量",
        "strength": 0.9
      }
    }
  ]
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "created": [
      {"relation_id": "rel_001", "relation_type": "USES"}
    ],
    "skipped": [],
    "errors": []
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440016"
}
```

**Pydantic 模型**：

```python
class RelationItem(BaseModel):
    source_entity_id: str
    target_entity_id: str
    relation_type: str = Field(..., max_length=100)
    properties: Optional[dict[str, Any]] = Field(default_factory=dict)


class KGRelationsCreateRequest(BaseModel):
    agent_id: str
    relations: list[RelationItem] = Field(..., min_length=1, max_length=100)
```

---

### 5.3 `GET /api/v1/kg/entities/search` - 实体搜索

**路径**：`GET /api/v1/kg/entities/search`

**Query 参数**：

| 参数       | 类型   | 必填 | 默认值 | 说明                     |
|------------|--------|------|--------|--------------------------|
| `q`        | string | 是   | -      | 搜索关键词或语义查询      |
| `agent_id` | string | 是   | -      | Agent 标识               |
| `top_k`    | int    | 否   | 10     | 返回结果数               |
| `type`     | string | 否   | -      | 按实体类型过滤           |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "results": [
      {
        "entity_id": "ent_001",
        "name": "FastAPI",
        "entity_type": "Technology",
        "description": "Python 高性能 Web 框架",
        "score": 0.88,
        "relation_count": 5
      }
    ],
    "total": 1
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440017"
}
```

---

### 5.4 `GET /api/v1/kg/communities/{community_id}/summary` - 获取社区摘要

**路径**：`GET /api/v1/kg/communities/{community_id}/summary`

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "community_id": "comm_001",
    "agent_id": "agent-001",
    "level": 1,
    "title": "Python Web 框架技术群组",
    "summary": "该社区包含与 Python Web 框架相关的技术实体，核心节点为 FastAPI、Django、Flask，彼此通过 SIMILAR_TO 和 COMPETES_WITH 关系连接。FastAPI 在性能和现代化特性方面具有优势。",
    "entity_count": 8,
    "relation_count": 14,
    "key_entities": ["FastAPI", "Django", "Flask"],
    "created_at": "2026-03-20T00:00:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440018"
}
```

---

### 5.5 `GET /api/v1/kg/traverse` - 图遍历

**路径**：`GET /api/v1/kg/traverse`

**Query 参数**：

| 参数             | 类型   | 必填 | 默认值 | 说明                           |
|------------------|--------|------|--------|-------------------------------|
| `start`          | string | 是   | -      | 起始实体 ID 或名称             |
| `agent_id`       | string | 是   | -      | Agent 标识                    |
| `hops`           | int    | 否   | 1      | 遍历跳数，最大 3              |
| `relation_types` | string | 否   | -      | 关系类型过滤（逗号分隔）       |
| `max_nodes`      | int    | 否   | 50     | 返回最大节点数                |

**示例 curl**：

```bash
curl "https://api.agent-memory.example.com/api/v1/kg/traverse?start=ent_001&agent_id=agent-001&hops=2&relation_types=USES,DEPENDS_ON" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "start_entity": {
      "entity_id": "ent_001",
      "name": "FastAPI"
    },
    "nodes": [
      {"entity_id": "ent_001", "name": "FastAPI", "entity_type": "Technology", "hop": 0},
      {"entity_id": "ent_002", "name": "LanceDB", "entity_type": "Technology", "hop": 1},
      {"entity_id": "ent_003", "name": "Pydantic", "entity_type": "Technology", "hop": 1}
    ],
    "edges": [
      {"source": "ent_001", "target": "ent_002", "relation_type": "USES"},
      {"source": "ent_001", "target": "ent_003", "relation_type": "DEPENDS_ON"}
    ],
    "text_summary": "FastAPI 使用 LanceDB 作为向量存储，依赖 Pydantic 进行数据校验。"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440019"
}
```

---

## 6. Agent Session API

### 6.1 `POST /api/v1/sessions` - 创建 Agent Session

**路径**：`POST /api/v1/sessions`

**请求参数**：

```json
{
  "agent_id": "agent-001",
  "task_description": "帮助用户完成 API 设计文档的编写",
  "initial_context": {
    "user_id": "user_123",
    "project": "agentic-memory",
    "priority": "high"
  },
  "ttl_seconds": 3600
}
```

请求字段说明：

| 字段                | 类型   | 必填 | 说明                              |
|---------------------|--------|------|----------------------------------|
| `agent_id`          | string | 是   | Agent 标识                        |
| `task_description`  | string | 否   | 当前任务描述                       |
| `initial_context`   | object | 否   | 初始上下文键值对                   |
| `ttl_seconds`       | int    | 否   | Session 生存时间，默认 3600 秒    |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "session_id": "sess_g7h8i9j0",
    "agent_id": "agent-001",
    "created_at": "2026-03-23T10:00:00Z",
    "expires_at": "2026-03-23T11:00:00Z",
    "working_memory_key": "wm:agent-001:sess_g7h8i9j0"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440020"
}
```

**Pydantic 模型**：

```python
class SessionCreateRequest(BaseModel):
    agent_id: str
    task_description: Optional[str] = Field(None, max_length=1000)
    initial_context: Optional[dict[str, Any]] = Field(default_factory=dict)
    ttl_seconds: int = Field(3600, ge=60, le=86400)


class SessionCreateResponse(BaseModel):
    session_id: str
    agent_id: str
    created_at: datetime
    expires_at: datetime
    working_memory_key: str
```

---

### 6.2 `GET /api/v1/sessions/{session_id}/working-memory` - 获取 Working Memory

**路径**：`GET /api/v1/sessions/{session_id}/working-memory`

Working Memory 存储在 Redis 中，以 Hash 结构保存当前 Session 的完整上下文。

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "session_id": "sess_g7h8i9j0",
    "agent_id": "agent-001",
    "context": {
      "task_description": "帮助用户完成 API 设计文档的编写",
      "current_step": "drafting_episode_api",
      "user_id": "user_123",
      "project": "agentic-memory",
      "recent_messages": [
        {"role": "user", "content": "请帮我写 Episode API 的设计", "ts": 1711188000},
        {"role": "assistant", "content": "好的，我来设计 Episode API", "ts": 1711188005}
      ],
      "active_entities": ["FastAPI", "Episode", "LanceDB"]
    },
    "token_count": 342,
    "updated_at": "2026-03-23T10:05:00Z",
    "ttl_remaining_seconds": 3295
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440021"
}
```

---

### 6.3 `PATCH /api/v1/sessions/{session_id}/working-memory` - 更新 Working Memory

**路径**：`PATCH /api/v1/sessions/{session_id}/working-memory`

支持部分更新（merge），不覆盖未指定字段。

**请求参数**：

```json
{
  "updates": {
    "current_step": "reviewing_skill_api",
    "active_entities": ["FastAPI", "Skill", "PostgreSQL"],
    "notes": "用户对 Skill 版本管理非常关注"
  },
  "append_message": {
    "role": "user",
    "content": "技能的版本如何管理？",
    "ts": 1711188300
  }
}
```

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "session_id": "sess_g7h8i9j0",
    "updated_keys": ["current_step", "active_entities", "notes", "recent_messages"],
    "token_count": 398,
    "updated_at": "2026-03-23T10:10:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440022"
}
```

---

### 6.4 `POST /api/v1/sessions/{session_id}/flush` - 刷写 Episode 到存储层

**路径**：`POST /api/v1/sessions/{session_id}/flush`

将当前 Working Memory 中的对话内容异步提交，生成 Episode 并写入 LanceDB 和 PostgreSQL。

**请求参数**：

```json
{
  "force": false,
  "importance_hint": 0.8,
  "summary_override": null
}
```

请求字段说明：

| 字段               | 类型   | 必填 | 说明                                   |
|--------------------|--------|------|----------------------------------------|
| `force`            | bool   | 否   | 强制刷写（即使消息数不足阈值），默认 false |
| `importance_hint`  | float  | 否   | 重要性评分提示（供 LLM 参考）           |
| `summary_override` | string | 否   | 手动指定摘要（不使用 LLM 生成）         |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "flushed": true,
    "episode_id": "ep_k1l2m3n4",
    "message_count": 8,
    "estimated_importance": 0.82,
    "pipeline_task_id": "task_p5q6r7s8"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440023"
}
```

**Pydantic 模型**：

```python
class SessionFlushRequest(BaseModel):
    force: bool = False
    importance_hint: Optional[float] = Field(None, ge=0.0, le=1.0)
    summary_override: Optional[str] = Field(None, max_length=5000)
```

---

## 7. Admin API

### 7.1 `GET /api/v1/admin/stats` - 系统统计

**路径**：`GET /api/v1/admin/stats`

**权限要求**：`role: admin`

**Query 参数**：

| 参数       | 类型   | 必填 | 说明                       |
|------------|--------|------|---------------------------|
| `agent_id` | string | 否   | 指定 Agent（不填则全局统计）|

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "memory_counts": {
      "working": 24,
      "episode": 1842,
      "procedural": 356,
      "semantic": 9870
    },
    "storage_sizes": {
      "lancedb_gb": 2.4,
      "postgresql_gb": 1.1,
      "neo4j_gb": 0.3,
      "redis_mb": 128
    },
    "recent_activity": {
      "writes_last_1h": 42,
      "reads_last_1h": 318,
      "pipeline_runs_last_24h": 8
    },
    "agent_count": 5,
    "active_sessions": 3,
    "computed_at": "2026-03-23T10:00:00Z"
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440024"
}
```

---

### 7.2 `POST /api/v1/admin/pipeline/trigger` - 手动触发 Pipeline

**路径**：`POST /api/v1/admin/pipeline/trigger`

**权限要求**：`role: admin`

**请求参数**：

```json
{
  "pipeline_name": "importance_scoring",
  "agent_id": "agent-001",
  "params": {
    "batch_size": 100,
    "dry_run": false
  }
}
```

Pipeline 名称可选值：

| Pipeline 名称            | 说明                              |
|--------------------------|----------------------------------|
| `importance_scoring`     | 重新计算 Episode 重要性评分       |
| `kg_community_detection` | 触发知识图谱社区发现              |
| `embedding_refresh`      | 刷新向量嵌入（模型升级后使用）    |
| `memory_consolidation`   | 记忆整合（合并相似 Episode）      |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "task_id": "task_t9u0v1w2",
    "pipeline_name": "importance_scoring",
    "status": "queued",
    "queued_at": "2026-03-23T10:00:00Z",
    "estimated_duration_seconds": 120
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440025"
}
```

---

### 7.3 `GET /api/v1/admin/pipeline/status` - Pipeline 状态

**路径**：`GET /api/v1/admin/pipeline/status`

**Query 参数**：

| 参数      | 类型   | 必填 | 说明                   |
|-----------|--------|------|------------------------|
| `task_id` | string | 否   | 指定查询某个任务       |
| `limit`   | int    | 否   | 返回最近 N 条，默认 10 |

**响应结构**：

```json
{
  "code": 0,
  "data": {
    "tasks": [
      {
        "task_id": "task_t9u0v1w2",
        "pipeline_name": "importance_scoring",
        "status": "running",
        "progress": 0.65,
        "started_at": "2026-03-23T10:00:05Z",
        "estimated_finish_at": "2026-03-23T10:02:05Z",
        "error_message": null
      }
    ]
  },
  "message": "ok",
  "request_id": "550e8400-e29b-41d4-a716-446655440026"
}
```

---

## 8. FastAPI 实现代码

### 8.1 项目结构

```
app/
├── main.py                        # FastAPI 应用入口
├── core/
│   ├── config.py                  # 环境变量配置
│   ├── security.py                # JWT 认证
│   ├── dependencies.py            # 公共依赖注入
│   └── exceptions.py              # 自定义异常
├── api/
│   └── v1/
│       ├── __init__.py
│       └── routers/
│           ├── memories.py        # Memory 核心接口
│           ├── episodes.py        # Episode 接口
│           ├── skills.py          # Skill 接口
│           ├── kg.py              # Knowledge Graph 接口
│           ├── sessions.py        # Agent Session 接口
│           └── admin.py           # Admin 接口
├── schemas/
│   ├── __init__.py
│   ├── base.py                    # 统一响应格式
│   ├── memories.py
│   ├── episodes.py
│   ├── skills.py
│   ├── kg.py
│   └── sessions.py
├── services/
│   ├── memory_service.py
│   ├── episode_service.py
│   ├── skill_service.py
│   ├── kg_service.py
│   └── session_service.py
└── db/
    ├── lancedb_client.py
    ├── postgres_client.py
    ├── neo4j_client.py
    └── redis_client.py
```

---

### 8.2 `app/main.py`

```python
"""
Agentic Memory System - FastAPI Application Entry Point
"""
import uuid
import time
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.exceptions import AgentMemoryException
from app.api.v1.routers import memories, episodes, skills, kg, sessions, admin
from app.schemas.base import BaseResponse

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动初始化 & 关闭清理"""
    logger.info("Starting Agentic Memory API server...")
    # 初始化数据库连接池
    from app.db.lancedb_client import get_lancedb_client
    from app.db.postgres_client import get_postgres_pool
    from app.db.neo4j_client import get_neo4j_driver
    from app.db.redis_client import get_redis_pool

    app.state.lancedb = await get_lancedb_client()
    app.state.postgres = await get_postgres_pool()
    app.state.neo4j = await get_neo4j_driver()
    app.state.redis = await get_redis_pool()

    logger.info("All database connections initialized.")
    yield

    # 关闭连接
    await app.state.postgres.close()
    await app.state.neo4j.close()
    await app.state.redis.close()
    logger.info("Agentic Memory API server shut down.")


app = FastAPI(
    title="Agentic Memory API",
    description="4层记忆系统 RESTful API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# ── Middleware ───────────────────────────────────────────────────────────────

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """为每个请求注入 request_id，并记录请求耗时"""
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    start_time = time.monotonic()

    response: Response = await call_next(request)

    duration_ms = int((time.monotonic() - start_time) * 1000)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Response-Time-Ms"] = str(duration_ms)

    logger.info(
        f"{request.method} {request.url.path} "
        f"status={response.status_code} "
        f"duration_ms={duration_ms} "
        f"request_id={request_id}"
    )
    return response


# ── Exception Handlers ───────────────────────────────────────────────────────

@app.exception_handler(AgentMemoryException)
async def agent_memory_exception_handler(request: Request, exc: AgentMemoryException):
    return JSONResponse(
        status_code=exc.http_status,
        content={
            "code": exc.code,
            "data": None,
            "message": exc.message,
            "request_id": getattr(request.state, "request_id", ""),
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={
            "code": 2001,
            "data": None,
            "message": "internal server error",
            "request_id": getattr(request.state, "request_id", ""),
        },
    )


# ── Routers ──────────────────────────────────────────────────────────────────

app.include_router(memories.router, prefix="/api/v1/memories", tags=["Memory"])
app.include_router(episodes.router, prefix="/api/v1/episodes", tags=["Episode"])
app.include_router(skills.router, prefix="/api/v1/skills", tags=["Skill"])
app.include_router(kg.router, prefix="/api/v1/kg", tags=["Knowledge Graph"])
app.include_router(sessions.router, prefix="/api/v1/sessions", tags=["Session"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["Admin"])


# ── Health Check ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health_check():
    return {"status": "ok", "version": "1.0.0"}
```

---

### 8.3 `app/core/exceptions.py`

```python
"""自定义异常体系"""


class AgentMemoryException(Exception):
    """所有业务异常的基类"""

    def __init__(self, code: int, message: str, http_status: int = 400):
        self.code = code
        self.message = message
        self.http_status = http_status
        super().__init__(message)


class NotFoundError(AgentMemoryException):
    def __init__(self, resource: str, resource_id: str):
        super().__init__(
            code=1004,
            message=f"{resource} not found: {resource_id}",
            http_status=404,
        )


class ValidationError(AgentMemoryException):
    def __init__(self, message: str):
        super().__init__(code=1001, message=message, http_status=400)


class AuthenticationError(AgentMemoryException):
    def __init__(self, message: str = "authentication failed"):
        super().__init__(code=1002, message=message, http_status=401)


class PermissionError(AgentMemoryException):
    def __init__(self, message: str = "permission denied"):
        super().__init__(code=1003, message=message, http_status=403)


class ConflictError(AgentMemoryException):
    def __init__(self, message: str):
        super().__init__(code=1005, message=message, http_status=409)


class DownstreamError(AgentMemoryException):
    def __init__(self, service: str, message: str):
        super().__init__(
            code=2002,
            message=f"downstream service error [{service}]: {message}",
            http_status=503,
        )


class TimeoutError(AgentMemoryException):
    def __init__(self, message: str = "request timeout"):
        super().__init__(code=2003, message=message, http_status=504)
```

---

### 8.4 `app/core/security.py`

```python
"""JWT 认证与鉴权"""
import logging
from datetime import datetime, timezone
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings
from app.core.exceptions import AuthenticationError, PermissionError

logger = logging.getLogger(__name__)

bearer_scheme = HTTPBearer(auto_error=False)


class TokenPayload:
    def __init__(self, sub: str, agent_id: str, role: str):
        self.sub = sub
        self.agent_id = agent_id
        self.role = role


def decode_token(token: str) -> TokenPayload:
    """解码并验证 JWT Token"""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        return TokenPayload(
            sub=payload["sub"],
            agent_id=payload["agent_id"],
            role=payload.get("role", "agent"),
        )
    except jwt.ExpiredSignatureError:
        raise AuthenticationError("token expired")
    except jwt.InvalidTokenError as e:
        raise AuthenticationError(f"invalid token: {e}")


async def get_current_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> TokenPayload:
    """FastAPI 依赖：提取并验证当前请求的 JWT Token"""
    if credentials is None:
        raise AuthenticationError("missing authorization header")
    return decode_token(credentials.credentials)


async def require_admin(
    token: TokenPayload = Depends(get_current_token),
) -> TokenPayload:
    """FastAPI 依赖：要求 admin 角色"""
    if token.role != "admin":
        raise PermissionError("admin role required")
    return token


def verify_agent_ownership(token: TokenPayload, agent_id: str) -> None:
    """校验 Token 中的 agent_id 与请求目标 agent_id 一致（admin 跳过）"""
    if token.role == "admin":
        return
    if token.agent_id != agent_id:
        raise PermissionError(
            f"access to agent_id={agent_id} not allowed for token agent_id={token.agent_id}"
        )
```

---

### 8.5 `app/schemas/base.py`

```python
"""统一响应格式"""
import uuid
from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel, Field
from pydantic.generics import GenericModel

T = TypeVar("T")


class BaseResponse(GenericModel, Generic[T]):
    """所有接口的统一响应包装"""
    code: int = 0
    data: Optional[T] = None
    message: str = "ok"
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    @classmethod
    def success(cls, data: T, message: str = "ok") -> "BaseResponse[T]":
        return cls(code=0, data=data, message=message)

    @classmethod
    def error(cls, code: int, message: str) -> "BaseResponse[None]":
        return cls(code=code, data=None, message=message)
```

---

### 8.6 `app/api/v1/routers/memories.py`

```python
"""Memory 核心接口路由"""
import time
import logging
from fastapi import APIRouter, Depends, Request

from app.core.security import get_current_token, verify_agent_ownership, TokenPayload
from app.core.exceptions import NotFoundError
from app.schemas.base import BaseResponse
from app.schemas.memories import (
    MemorySearchRequest,
    MemorySearchData,
    MemoryWriteRequest,
    MemoryWriteData,
    MemoryDeleteData,
    MemoryDetail,
)
from app.services.memory_service import MemoryService

router = APIRouter()
logger = logging.getLogger(__name__)


def get_memory_service(request: Request) -> MemoryService:
    return MemoryService(
        lancedb=request.app.state.lancedb,
        postgres=request.app.state.postgres,
        redis=request.app.state.redis,
    )


@router.post("/search", response_model=BaseResponse[MemorySearchData])
async def search_memories(
    body: MemorySearchRequest,
    token: TokenPayload = Depends(get_current_token),
    service: MemoryService = Depends(get_memory_service),
):
    """统一记忆搜索：触发多路检索融合流程"""
    verify_agent_ownership(token, body.agent_id)

    start = time.monotonic()
    results = await service.search(
        query=body.query,
        memory_types=body.memory_types,
        top_k=body.top_k,
        agent_id=body.agent_id,
        filters=body.filters,
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    return BaseResponse.success(
        MemorySearchData(
            results=results,
            total=len(results),
            latency_ms=latency_ms,
        )
    )


@router.post("/write", response_model=BaseResponse[MemoryWriteData])
async def write_memory(
    body: MemoryWriteRequest,
    token: TokenPayload = Depends(get_current_token),
    service: MemoryService = Depends(get_memory_service),
):
    """写入记忆到对应存储层"""
    verify_agent_ownership(token, body.agent_id)

    memory_id, created_at = await service.write(
        content=body.content,
        memory_type=body.memory_type,
        agent_id=body.agent_id,
        metadata=body.metadata or {},
    )

    return BaseResponse.success(
        MemoryWriteData(memory_id=memory_id, created_at=created_at)
    )


@router.delete("/{memory_id}", response_model=BaseResponse[MemoryDeleteData])
async def delete_memory(
    memory_id: str,
    agent_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: MemoryService = Depends(get_memory_service),
):
    """删除记忆"""
    verify_agent_ownership(token, agent_id)

    deleted = await service.delete(memory_id=memory_id, agent_id=agent_id)
    if not deleted:
        raise NotFoundError("memory", memory_id)

    return BaseResponse.success(
        MemoryDeleteData(deleted=True, memory_id=memory_id)
    )


@router.get("/{memory_id}", response_model=BaseResponse[MemoryDetail])
async def get_memory(
    memory_id: str,
    agent_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: MemoryService = Depends(get_memory_service),
):
    """获取记忆详情"""
    verify_agent_ownership(token, agent_id)

    detail = await service.get_by_id(memory_id=memory_id, agent_id=agent_id)
    if detail is None:
        raise NotFoundError("memory", memory_id)

    return BaseResponse.success(detail)
```

---

### 8.7 `app/api/v1/routers/skills.py`

```python
"""Skill 接口路由"""
import logging
from fastapi import APIRouter, Depends, Query, Request

from app.core.security import get_current_token, verify_agent_ownership, TokenPayload
from app.core.exceptions import NotFoundError, ConflictError
from app.schemas.base import BaseResponse
from app.schemas.skills import (
    SkillSearchRequest,
    SkillSearchData,
    SkillCreateRequest,
    SkillCreateResponse,
    SkillUpdateRequest,
    SkillUpdateResponse,
    SkillDetail,
    SkillExecuteRequest,
    SkillExecuteResponse,
    SkillVersionsResponse,
    SkillRecommendationsResponse,
)
from app.services.skill_service import SkillService

router = APIRouter()
logger = logging.getLogger(__name__)


def get_skill_service(request: Request) -> SkillService:
    return SkillService(postgres=request.app.state.postgres)


@router.post("/search", response_model=BaseResponse[SkillSearchData])
async def search_skills(
    body: SkillSearchRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """技能语义搜索（向量 + BM25 混合）"""
    verify_agent_ownership(token, body.agent_id)
    results = await service.search(body)
    return BaseResponse.success(results)


@router.get("/recommendations", response_model=BaseResponse[SkillRecommendationsResponse])
async def get_skill_recommendations(
    task: str = Query(..., min_length=1, max_length=1000),
    agent_id: str = Query(...),
    top_k: int = Query(3, ge=1, le=10),
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """根据任务描述推荐相关技能"""
    verify_agent_ownership(token, agent_id)
    recommendations = await service.recommend(task=task, agent_id=agent_id, top_k=top_k)
    return BaseResponse.success(recommendations)


@router.get("/{skill_id}", response_model=BaseResponse[SkillDetail])
async def get_skill(
    skill_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """获取技能详情"""
    detail = await service.get_by_id(skill_id)
    if detail is None:
        raise NotFoundError("skill", skill_id)
    return BaseResponse.success(detail)


@router.post("", response_model=BaseResponse[SkillCreateResponse], status_code=201)
async def create_skill(
    body: SkillCreateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """创建新技能"""
    verify_agent_ownership(token, body.agent_id)
    existing = await service.find_by_name(body.name, body.agent_id)
    if existing:
        raise ConflictError(f"skill with name '{body.name}' already exists")
    result = await service.create(body)
    return BaseResponse.success(result)


@router.put("/{skill_id}", response_model=BaseResponse[SkillUpdateResponse])
async def update_skill(
    skill_id: str,
    body: SkillUpdateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """更新技能（自动递增版本号）"""
    result = await service.update(skill_id, body)
    if result is None:
        raise NotFoundError("skill", skill_id)
    return BaseResponse.success(result)


@router.post("/{skill_id}/execute", response_model=BaseResponse[SkillExecuteResponse])
async def record_skill_execution(
    skill_id: str,
    body: SkillExecuteRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """记录技能执行结果，更新统计数据"""
    verify_agent_ownership(token, body.agent_id)
    result = await service.record_execution(skill_id, body)
    if result is None:
        raise NotFoundError("skill", skill_id)
    return BaseResponse.success(result)


@router.get("/{skill_id}/versions", response_model=BaseResponse[SkillVersionsResponse])
async def get_skill_versions(
    skill_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: SkillService = Depends(get_skill_service),
):
    """获取技能版本历史"""
    versions = await service.get_versions(skill_id)
    if versions is None:
        raise NotFoundError("skill", skill_id)
    return BaseResponse.success(versions)
```

---

### 8.8 `app/api/v1/routers/kg.py`

```python
"""Knowledge Graph 接口路由"""
import logging
from fastapi import APIRouter, Depends, Query, Request

from app.core.security import get_current_token, verify_agent_ownership, TokenPayload
from app.core.exceptions import NotFoundError
from app.schemas.base import BaseResponse
from app.schemas.kg import (
    KGEntitiesCreateRequest,
    KGEntitiesCreateResponse,
    KGRelationsCreateRequest,
    KGRelationsCreateResponse,
    KGEntitySearchResponse,
    KGCommunitySummaryResponse,
    KGTraverseResponse,
)
from app.services.kg_service import KGService

router = APIRouter()
logger = logging.getLogger(__name__)


def get_kg_service(request: Request) -> KGService:
    return KGService(
        neo4j=request.app.state.neo4j,
        postgres=request.app.state.postgres,
    )


@router.post("/entities", response_model=BaseResponse[KGEntitiesCreateResponse], status_code=201)
async def create_entities(
    body: KGEntitiesCreateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: KGService = Depends(get_kg_service),
):
    """批量创建知识图谱实体"""
    verify_agent_ownership(token, body.agent_id)
    result = await service.create_entities(body)
    return BaseResponse.success(result)


@router.post("/relations", response_model=BaseResponse[KGRelationsCreateResponse], status_code=201)
async def create_relations(
    body: KGRelationsCreateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: KGService = Depends(get_kg_service),
):
    """批量创建知识图谱关系"""
    verify_agent_ownership(token, body.agent_id)
    result = await service.create_relations(body)
    return BaseResponse.success(result)


@router.get("/entities/search", response_model=BaseResponse[KGEntitySearchResponse])
async def search_entities(
    q: str = Query(..., min_length=1, max_length=500),
    agent_id: str = Query(...),
    top_k: int = Query(10, ge=1, le=50),
    type: str = Query(None),
    token: TokenPayload = Depends(get_current_token),
    service: KGService = Depends(get_kg_service),
):
    """实体语义搜索"""
    verify_agent_ownership(token, agent_id)
    result = await service.search_entities(
        query=q, agent_id=agent_id, top_k=top_k, entity_type=type
    )
    return BaseResponse.success(result)


@router.get("/communities/{community_id}/summary", response_model=BaseResponse[KGCommunitySummaryResponse])
async def get_community_summary(
    community_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: KGService = Depends(get_kg_service),
):
    """获取社区摘要"""
    result = await service.get_community_summary(community_id)
    if result is None:
        raise NotFoundError("community", community_id)
    return BaseResponse.success(result)


@router.get("/traverse", response_model=BaseResponse[KGTraverseResponse])
async def traverse_graph(
    start: str = Query(..., description="起始实体 ID 或名称"),
    agent_id: str = Query(...),
    hops: int = Query(1, ge=1, le=3),
    relation_types: str = Query(None, description="逗号分隔的关系类型"),
    max_nodes: int = Query(50, ge=1, le=200),
    token: TokenPayload = Depends(get_current_token),
    service: KGService = Depends(get_kg_service),
):
    """图遍历：从起始实体出发，按跳数和关系类型扩展子图"""
    verify_agent_ownership(token, agent_id)
    relation_types_list = relation_types.split(",") if relation_types else None
    result = await service.traverse(
        start=start,
        agent_id=agent_id,
        hops=hops,
        relation_types=relation_types_list,
        max_nodes=max_nodes,
    )
    return BaseResponse.success(result)
```

---

### 8.9 `app/api/v1/routers/sessions.py`

```python
"""Agent Session 接口路由"""
import logging
from fastapi import APIRouter, Depends, Request

from app.core.security import get_current_token, verify_agent_ownership, TokenPayload
from app.core.exceptions import NotFoundError
from app.schemas.base import BaseResponse
from app.schemas.sessions import (
    SessionCreateRequest,
    SessionCreateResponse,
    WorkingMemoryResponse,
    WorkingMemoryUpdateRequest,
    WorkingMemoryUpdateResponse,
    SessionFlushRequest,
    SessionFlushResponse,
)
from app.services.session_service import SessionService

router = APIRouter()
logger = logging.getLogger(__name__)


def get_session_service(request: Request) -> SessionService:
    return SessionService(
        redis=request.app.state.redis,
        postgres=request.app.state.postgres,
        lancedb=request.app.state.lancedb,
    )


@router.post("", response_model=BaseResponse[SessionCreateResponse], status_code=201)
async def create_session(
    body: SessionCreateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SessionService = Depends(get_session_service),
):
    """创建 Agent Session，初始化 Working Memory"""
    verify_agent_ownership(token, body.agent_id)
    result = await service.create_session(body)
    return BaseResponse.success(result)


@router.get("/{session_id}/working-memory", response_model=BaseResponse[WorkingMemoryResponse])
async def get_working_memory(
    session_id: str,
    token: TokenPayload = Depends(get_current_token),
    service: SessionService = Depends(get_session_service),
):
    """获取 Session 的 Working Memory（从 Redis 读取）"""
    result = await service.get_working_memory(session_id)
    if result is None:
        raise NotFoundError("session", session_id)
    return BaseResponse.success(result)


@router.patch("/{session_id}/working-memory", response_model=BaseResponse[WorkingMemoryUpdateResponse])
async def update_working_memory(
    session_id: str,
    body: WorkingMemoryUpdateRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SessionService = Depends(get_session_service),
):
    """部分更新 Working Memory（merge 语义）"""
    result = await service.update_working_memory(session_id, body)
    if result is None:
        raise NotFoundError("session", session_id)
    return BaseResponse.success(result)


@router.post("/{session_id}/flush", response_model=BaseResponse[SessionFlushResponse])
async def flush_session(
    session_id: str,
    body: SessionFlushRequest,
    token: TokenPayload = Depends(get_current_token),
    service: SessionService = Depends(get_session_service),
):
    """将 Working Memory 刷写为 Episode 并提交到持久化存储层"""
    result = await service.flush_to_episode(session_id, body)
    if result is None:
        raise NotFoundError("session", session_id)
    return BaseResponse.success(result)
```

---

### 8.10 `app/core/config.py`

```python
"""环境变量配置（使用 pydantic-settings）"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 应用
    APP_ENV: str = "development"
    DEBUG: bool = False
    CORS_ORIGINS: list[str] = ["*"]

    # JWT
    JWT_SECRET_KEY: str = "changeme-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_HOURS: int = 24

    # PostgreSQL
    POSTGRES_DSN: str = "postgresql+asyncpg://user:pass@localhost:5432/agent_memory"
    POSTGRES_POOL_SIZE: int = 20
    POSTGRES_MAX_OVERFLOW: int = 10

    # LanceDB
    LANCEDB_URI: str = "/data/lancedb"

    # Neo4j
    NEO4J_URI: str = "bolt://localhost:7687"
    NEO4J_USER: str = "neo4j"
    NEO4J_PASSWORD: str = "changeme"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_MAX_CONNECTIONS: int = 50

    # Embedding
    EMBEDDING_MODEL: str = "BAAI/bge-m3"
    EMBEDDING_DEVICE: str = "cpu"
    EMBEDDING_BATCH_SIZE: int = 32

    # Reranker
    RERANKER_MODEL: str = "BAAI/bge-reranker-v2-m3"

    # Retrieval
    RETRIEVAL_GLOBAL_TIMEOUT_S: float = 5.0
    RETRIEVAL_PER_PATH_TIMEOUT_S: float = 3.0
    RETRIEVAL_MAX_CONCURRENT: int = 10

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
```

---

## 9. API 测试用例

### 9.1 测试配置（`tests/conftest.py`）

```python
"""pytest 配置与共用 Fixtures"""
import asyncio
import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock, MagicMock

from app.main import app
from app.core.security import decode_token


# ── 生成测试 JWT ─────────────────────────────────────────────────────────────

import jwt
from datetime import datetime, timedelta, timezone

TEST_SECRET = "test-secret-key"
TEST_AGENT_ID = "agent-test-001"


def make_token(agent_id: str = TEST_AGENT_ID, role: str = "agent") -> str:
    payload = {
        "sub": agent_id,
        "agent_id": agent_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, TEST_SECRET, algorithm="HS256")


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
async def client():
    """使用 ASGI Transport 创建测试客户端，不需要真实服务器"""
    # Mock 数据库状态
    app.state.lancedb = AsyncMock()
    app.state.postgres = AsyncMock()
    app.state.neo4j = AsyncMock()
    app.state.redis = AsyncMock()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def agent_headers():
    return {"Authorization": f"Bearer {make_token()}"}


@pytest.fixture
def admin_headers():
    return {"Authorization": f"Bearer {make_token(role='admin')}"}
```

---

### 9.2 Memory 接口测试（`tests/test_api_memories.py`）

```python
"""Memory API 功能测试"""
import pytest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone


# ── Test 1: 搜索记忆 - Happy Path ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_search_memories_happy_path(client, agent_headers):
    """正常搜索记忆，验证响应结构"""
    mock_results = [
        {
            "memory_id": "mem_001",
            "content": "用户希望 API 支持批量写入",
            "score": 0.92,
            "memory_type": "episode",
            "metadata": {"importance_score": 0.8},
        }
    ]

    with patch("app.services.memory_service.MemoryService.search", new_callable=AsyncMock) as mock_search:
        mock_search.return_value = mock_results

        response = await client.post(
            "/api/v1/memories/search",
            json={
                "query": "API 批量写入",
                "agent_id": "agent-test-001",
                "top_k": 5,
            },
            headers=agent_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert len(body["data"]["results"]) == 1
    assert body["data"]["results"][0]["memory_id"] == "mem_001"
    assert body["data"]["latency_ms"] >= 0
    assert "request_id" in body


# ── Test 2: 搜索记忆 - 无 Token ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_search_memories_no_token(client):
    """未携带 Token 时返回 401"""
    response = await client.post(
        "/api/v1/memories/search",
        json={"query": "test", "agent_id": "agent-test-001"},
    )
    assert response.status_code == 401
    assert response.json()["code"] == 1002


# ── Test 3: 搜索记忆 - 跨 agent 访问被拒绝 ────────────────────────────────────

@pytest.mark.asyncio
async def test_search_memories_cross_agent_forbidden(client, agent_headers):
    """访问其他 agent 的记忆返回 403"""
    response = await client.post(
        "/api/v1/memories/search",
        json={
            "query": "test",
            "agent_id": "agent-other-999",  # 与 Token 中 agent_id 不同
        },
        headers=agent_headers,
    )
    assert response.status_code == 403
    assert response.json()["code"] == 1003


# ── Test 4: 写入记忆 - Happy Path ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_write_memory_happy_path(client, agent_headers):
    """正常写入记忆"""
    now = datetime.now(timezone.utc)

    with patch("app.services.memory_service.MemoryService.write", new_callable=AsyncMock) as mock_write:
        mock_write.return_value = ("mem_new_001", now)

        response = await client.post(
            "/api/v1/memories/write",
            json={
                "content": "用户要求 API 响应时间 P99 < 100ms",
                "memory_type": "episode",
                "agent_id": "agent-test-001",
            },
            headers=agent_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["memory_id"] == "mem_new_001"
    assert "created_at" in body["data"]


# ── Test 5: 写入记忆 - 参数校验失败 ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_write_memory_invalid_type(client, agent_headers):
    """memory_type 非法时返回 422"""
    response = await client.post(
        "/api/v1/memories/write",
        json={
            "content": "test content",
            "memory_type": "invalid_type",  # 非法值
            "agent_id": "agent-test-001",
        },
        headers=agent_headers,
    )
    assert response.status_code == 422


# ── Test 6: 获取记忆详情 - Not Found ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_memory_not_found(client, agent_headers):
    """记忆不存在时返回 404"""
    with patch("app.services.memory_service.MemoryService.get_by_id", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = None

        response = await client.get(
            "/api/v1/memories/mem_nonexistent?agent_id=agent-test-001",
            headers=agent_headers,
        )

    assert response.status_code == 404
    assert response.json()["code"] == 1004


# ── Test 7: 删除记忆 - Happy Path ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_memory_happy_path(client, agent_headers):
    """正常删除记忆"""
    with patch("app.services.memory_service.MemoryService.delete", new_callable=AsyncMock) as mock_delete:
        mock_delete.return_value = True

        response = await client.delete(
            "/api/v1/memories/mem_001?agent_id=agent-test-001",
            headers=agent_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["deleted"] is True
```

---

### 9.3 Episode 接口测试（`tests/test_api_episodes.py`）

```python
"""Episode API 功能测试"""
import pytest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone


# ── Test 8: 创建 Episode - Happy Path ────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_episode_happy_path(client, agent_headers):
    """正常创建 Episode"""
    now = datetime.now(timezone.utc)

    with patch("app.services.episode_service.EpisodeService.create", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = {
            "episode_id": "ep_new_001",
            "agent_id": "agent-test-001",
            "created_at": now,
            "importance_score": 0.8,
        }

        response = await client.post(
            "/api/v1/episodes",
            json={
                "agent_id": "agent-test-001",
                "session_id": "sess_001",
                "title": "测试 Episode",
                "summary": "这是一个测试 Episode",
                "importance_score": 0.8,
            },
            headers=agent_headers,
        )

    assert response.status_code == 201
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["episode_id"] == "ep_new_001"


# ── Test 9: 更新重要性评分 ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_episode_importance(client, agent_headers):
    """更新 Episode 重要性评分"""
    now = datetime.now(timezone.utc)

    with patch("app.services.episode_service.EpisodeService.update_importance", new_callable=AsyncMock) as mock_update:
        mock_update.return_value = {
            "episode_id": "ep_001",
            "importance_score": 0.95,
            "updated_at": now,
        }

        response = await client.put(
            "/api/v1/episodes/ep_001/importance",
            json={"importance_score": 0.95, "reason": "用户多次引用"},
            headers=agent_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["data"]["importance_score"] == 0.95
```

---

### 9.4 Skill 接口测试（`tests/test_api_skills.py`）

```python
"""Skill API 功能测试"""
import pytest
from unittest.mock import AsyncMock, patch


# ── Test 10: 搜索技能 - 正常 ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_search_skills_happy_path(client, agent_headers):
    """技能语义搜索正常返回"""
    with patch("app.services.skill_service.SkillService.search", new_callable=AsyncMock) as mock_search:
        mock_search.return_value = {
            "results": [
                {
                    "skill_id": "skill_001",
                    "name": "parse_json",
                    "description": "解析 JSON",
                    "score": 0.91,
                    "success_rate": 0.95,
                    "execution_count": 100,
                    "version": "1.0.0",
                    "metadata": {},
                }
            ],
            "total": 1,
            "latency_ms": 20,
        }

        response = await client.post(
            "/api/v1/skills/search",
            json={
                "query": "解析 JSON 数据",
                "agent_id": "agent-test-001",
                "top_k": 5,
            },
            headers=agent_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["results"][0]["skill_id"] == "skill_001"


# ── Test 11: 创建技能 - 冲突 ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_skill_conflict(client, agent_headers):
    """创建重名技能时返回 409"""
    with patch("app.services.skill_service.SkillService.find_by_name", new_callable=AsyncMock) as mock_find:
        mock_find.return_value = {"skill_id": "skill_existing"}

        response = await client.post(
            "/api/v1/skills",
            json={
                "name": "parse_json",
                "description": "重复技能",
                "agent_id": "agent-test-001",
            },
            headers=agent_headers,
        )

    assert response.status_code == 409
    assert response.json()["code"] == 1005
```

---

### 9.5 Session 接口测试（`tests/test_api_sessions.py`）

```python
"""Session API 功能测试"""
import pytest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timedelta, timezone


# ── Test 12: 创建 Session ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_session_happy_path(client, agent_headers):
    """正常创建 Agent Session"""
    now = datetime.now(timezone.utc)

    with patch("app.services.session_service.SessionService.create_session", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = {
            "session_id": "sess_new_001",
            "agent_id": "agent-test-001",
            "created_at": now,
            "expires_at": now + timedelta(hours=1),
            "working_memory_key": "wm:agent-test-001:sess_new_001",
        }

        response = await client.post(
            "/api/v1/sessions",
            json={
                "agent_id": "agent-test-001",
                "task_description": "测试任务",
                "ttl_seconds": 3600,
            },
            headers=agent_headers,
        )

    assert response.status_code == 201
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["session_id"] == "sess_new_001"


# ── Test 13: Flush Session - Session 不存在 ────────────────────────────────────

@pytest.mark.asyncio
async def test_flush_session_not_found(client, agent_headers):
    """Session 不存在时 flush 返回 404"""
    with patch("app.services.session_service.SessionService.flush_to_episode", new_callable=AsyncMock) as mock_flush:
        mock_flush.return_value = None

        response = await client.post(
            "/api/v1/sessions/sess_nonexistent/flush",
            json={"force": False},
            headers=agent_headers,
        )

    assert response.status_code == 404
    assert response.json()["code"] == 1004
```

---

### 9.6 Admin 接口测试（`tests/test_api_admin.py`）

```python
"""Admin API 功能测试（需要 admin role）"""
import pytest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone


@pytest.mark.asyncio
async def test_get_admin_stats_requires_admin(client, agent_headers):
    """普通 agent 无法访问 admin stats"""
    response = await client.get(
        "/api/v1/admin/stats",
        headers=agent_headers,
    )
    assert response.status_code == 403
    assert response.json()["code"] == 1003


@pytest.mark.asyncio
async def test_get_admin_stats_happy_path(client, admin_headers):
    """admin 用户可以获取系统统计"""
    with patch("app.services.admin_service.AdminService.get_stats", new_callable=AsyncMock) as mock_stats:
        mock_stats.return_value = {
            "memory_counts": {"working": 10, "episode": 500, "procedural": 50, "semantic": 2000},
            "storage_sizes": {"lancedb_gb": 1.0, "postgresql_gb": 0.5, "neo4j_gb": 0.1, "redis_mb": 64},
            "recent_activity": {"writes_last_1h": 20, "reads_last_1h": 100, "pipeline_runs_last_24h": 3},
            "agent_count": 2,
            "active_sessions": 1,
            "computed_at": datetime.now(timezone.utc),
        }

        response = await client.get(
            "/api/v1/admin/stats",
            headers=admin_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["memory_counts"]["episode"] == 500
```

---

*文档结束*
