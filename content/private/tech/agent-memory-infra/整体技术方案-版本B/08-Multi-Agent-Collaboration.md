---
title: "08-Multi-Agent-Collaboration 详细设计"
date: 2026-03-23T23:00:00+08:00
draft: true
tags: ["agent-memory", "multi-agent", "collaboration", "详细设计", "版本B"]
---

# Multi-Agent 协作设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: 多 Agent 场景下的记忆共享、隔离与协作机制

---

## 1. 问题背景

单 Agent 场景下，记忆归属清晰（`agent_id` 即可区分）。但实际生产场景中，多个 Agent 需要协作完成任务：

- **Team Agent**：同一团队的 Agent 应该能共享学到的经验（如 CSV 编码技巧）
- **Specialist Agent**：负责特定领域的 Agent（数据处理、代码生成），其积累的技能应向全团队开放
- **任务分发**：一个 Orchestrator Agent 分发子任务给多个 Worker Agent，子任务结果需汇聚

**挑战**：
1. 隐私边界：Agent A 的私有数据不能被 Agent B 看到
2. 知识共享：高质量的公共知识应该可被所有 Agent 检索
3. 一致性：多 Agent 并发写入时避免冲突
4. 溯源：知识的来源 Agent 应可追溯

---

## 2. Visibility 模型

AMS 用 `visibility` 字段控制记忆的可见范围，分三级：

```
private  →  仅 agent_id 匹配时可见
  │
team     →  同 team_id 的所有 Agent 可见
  │
org      →  同 org_id 的所有 Agent 可见（接近公共知识）
```

```python
class Visibility(str, Enum):
    PRIVATE = "private"   # 仅自己（agent_id 级别）
    TEAM    = "team"      # 团队（team_id 级别）
    ORG     = "org"       # 组织（org_id 级别，接近全局公开）
```

**各记忆层的默认 visibility**：

| 记忆层 | 默认 visibility | 说明 |
|--------|:--------------:|------|
| Working Memory | private | 执行状态，只属于当前 Agent |
| Episode | private | 经历默认私有，可手动升级 |
| Skill | org | 技能挖掘后默认 org 级共享 |
| Semantic Block | 由写入方决定 | 业务文档通常 org 级，Agent 私有知识 private |
| Community Summary | org | 社区摘要天然跨 Agent |

### 2.1 检索时的 visibility 过滤

```python
# AMS MultiPathRetriever 中的过滤逻辑
def build_visibility_filter(agent_id: str, team_id: str | None, org_id: str | None) -> str:
    """
    构建 Milvus expr 过滤条件：
    - 包含本 Agent 的 private 记忆
    - 包含本团队的 team 记忆（若有 team_id）
    - 包含全组织的 org 记忆（若有 org_id）
    """
    conditions = [f'agent_id == "{agent_id}"']   # 自己的私有记忆

    if team_id:
        conditions.append(f'(visibility == "team" and team_id == "{team_id}")')

    if org_id:
        conditions.append(f'(visibility == "org" and org_id == "{org_id}")')

    # 公共知识（agent_id 为空）
    conditions.append('agent_id == ""')

    return " or ".join(f"({c})" for c in conditions)
```

---

## 3. 记忆共享与提升

### 3.1 Visibility 升级流程

Agent 在任务完成后，可以将私有记忆"提升"为团队/组织级共享：

```http
PATCH /api/v1/memory/episodes/ep_abc123
Content-Type: application/json

{
  "visibility": "team",
  "team_id":    "team_data_engineering"
}
```

**触发提升的典型场景**：
1. **自动触发**：Episode importance >= 9 且 outcome == success → ConsolidationEngine 建议提升
2. **技能晋升**：candidate Skill 变为 active 时，visibility 自动设为 org
3. **人工触发**：管理员或 Orchestrator Agent 手动提升

### 3.2 技能的组织级共享

技能挖掘后默认 `visibility = org`，所有 Agent 检索时都能找到：

```python
# Milvus skills collection 中的 org-level 技能检索
results = milvus_client.search(
    collection_name="skills",
    data=[query_embedding],
    expr='status == "active"',     # 无 agent_id 过滤，所有 active 技能都在候选
    limit=10
)
```

> **设计决策**：技能（操作方法）和知识（事实信息）不同，操作方法没有隐私性，应尽量共享。

---

## 4. Orchestrator-Worker 模式

### 4.1 任务分发与子记忆

一个 Orchestrator Agent 将任务分配给多个 Worker Agent，Worker 的执行结果需汇聚：

```
Orchestrator (agent_id: orch_001)
    │
    ├── 分发给 Worker A (agent_id: worker_csv_001)
    │     任务：处理 sales.csv 编码问题
    │
    └── 分发给 Worker B (agent_id: worker_db_002)
          任务：清洗数据库中的重复记录
```

**Orchestrator 汇聚子任务结果的方式**：

```python
# Orchestrator 向 AMS 查询子任务的执行结果
async def gather_worker_results(
    task_id: str,
    worker_ids: list[str]
) -> list[dict]:
    """
    等待所有 Worker 完成后，从 AMS 检索各 Worker 的 Episode（本次任务）。
    """
    results = []
    for worker_id in worker_ids:
        episodes = await ams_client.get(
            f"/api/v1/memory/episodes"
            f"?agent_id={worker_id}&session_id={task_id}&outcome=success"
        )
        results.extend(episodes["data"]["items"])

    return results
```

### 4.2 Working Memory 隔离

每个 Worker Agent 有独立的 Working Memory，不共享：

```
Redis key: working_memory:orch_001    → Orchestrator 的状态
Redis key: working_memory:worker_csv_001 → Worker A 的状态
Redis key: working_memory:worker_db_002  → Worker B 的状态
```

**合并汇报**：Worker 完成后，将关键结果写入 Episode（visibility=team），Orchestrator 通过检索获取：

```python
# Worker Agent flush_episode_node 中（额外步骤）
async def flush_episode_node(state: AgentState) -> AgentState:
    # ... 标准 flush 逻辑 ...

    # 若是子任务 Worker，将关键输出以 team 可见度写入 Episode
    if state.get("is_sub_task"):
        await ams_client.post("/api/v1/memory/episodes", json={
            **standard_episode,
            "visibility": "team",
            "team_id":    state["team_id"],
            "tags":       state.get("tags", []) + [f"task:{state['parent_task_id']}"]
        })
    return state
```

---

## 5. 并发写入冲突处理

### 5.1 Working Memory 并发

Working Memory 使用 Redis，多 Agent 写同一 key 时可能产生竞争：

```python
# 使用 Redis Lua 脚本做原子 HSET（避免 read-modify-write 竞争）
# HSET 本身是原子的，但 HGETALL + HSET 组合不是
# 解决方案：对 known_facts 用 Redis HSET 直接追加（不读取再合并）

await redis.hset(
    f"working_memory:{agent_id}",
    mapping={
        "known_facts": json.dumps(new_facts),  # 直接覆盖（last-write-wins）
        "updated_at":  datetime.utcnow().isoformat()
    }
)
# Last-write-wins 对 Working Memory 可接受，因为单 Agent 通常单线程更新
```

### 5.2 Episode/Block 并发写入

Episode 和 Block 的 `episode_id`/`block_id` 由写入方生成（UUID），不会冲突：

```python
# MPP 写入时自己生成 ID
episode_id = f"ep_{uuid4().hex[:12]}"
```

PostgreSQL `INSERT` 以 `episode_id` 为主键，若重复（极罕见）会返回唯一约束错误，MPP 做幂等重试：

```python
try:
    await pg.execute("INSERT INTO episodes (...) VALUES (...)", ...)
except UniqueViolationError:
    # 已写入，幂等成功
    logger.info(f"Episode {episode_id} already exists, skip")
```

### 5.3 Neo4j 实体合并

多个 Agent 可能同时提取并写入相同实体（如 "pandas"），使用 Cypher `MERGE` 避免重复：

```cypher
MERGE (n:PhraseNode {phrase: "pandas"})
ON CREATE SET
    n.node_id       = $node_id,
    n.phrase_type   = $phrase_type,
    n.mention_count = 1
ON MATCH SET
    n.mention_count = n.mention_count + 1,  // 原子递增
    n.updated_at    = datetime()
```

---

## 6. 权限控制

### 6.1 API 鉴权

AMS 的 Bearer Token 携带调用方身份信息：

```json
// JWT Payload 示例
{
  "sub":    "agent_001",
  "type":   "agent",        // agent / service / admin
  "org_id": "org_acme",
  "team_id":"team_data_eng",
  "scope":  ["memory:read", "memory:write:private", "memory:write:team"]
}
```

**scope 权限说明**：

| scope | 说明 |
|-------|------|
| `memory:read` | 可检索 private（自己）+ team + org 记忆 |
| `memory:write:private` | 可写入 private 记忆 |
| `memory:write:team` | 可写入 team 可见的记忆 |
| `memory:write:org` | 可写入 org 级记忆（仅 service 账号或 admin）|
| `memory:admin` | 可修改任何 Agent 的记忆（仅 admin）|

### 6.2 数据访问检查

AMS MemoryGateway 在每次请求时验证：

```python
class MemoryGateway:
    async def search(self, request: SearchRequest, token: JWTPayload) -> SearchResponse:
        # 权限检查：调用方只能查询自己的 agent_id
        if request.agent_id != token.sub and token.type != "admin":
            raise PermissionError(f"Agent {token.sub} 无权查询 {request.agent_id} 的记忆")

        # visibility 过滤：只返回调用方有权看到的记忆
        visibility_filter = build_visibility_filter(
            agent_id = token.sub,
            team_id  = token.team_id,
            org_id   = token.org_id
        )
        return await self.retriever.search(request, visibility_filter)
```

---

## 7. 实际协作场景示例

### 场景：数据处理流水线（Orchestrator + 3 个 Worker）

```
用户请求：处理并分析 Q1 销售数据（10个CSV文件）

Orchestrator (orch_001)
    │
    │  从 AMS 检索相关技能 → 发现 "csv-encoding-diagnosis"（org级，成功率94%）
    │
    ├── Worker A (worker_001)：处理 sales_jan.csv, sales_feb.csv
    │     - 使用技能 "csv-encoding-diagnosis"
    │     - Working Memory 记录：{"processed_files": ["sales_jan.csv"], "encoding": "gbk"}
    │     - 完成后写 Episode（visibility=team, tags=["task:task_q1_sales"]）
    │
    ├── Worker B (worker_002)：处理 sales_mar.csv ~ sales_jun.csv
    │     - 同样发现 gbk 编码问题，技能命中率 100%
    │     - 写 Episode（visibility=team）
    │
    └── Worker C (worker_003)：数据聚合
          - 从 AMS 检索 tag=task:task_q1_sales 的团队 Episode
          - 获取 Worker A 和 B 的处理结果
          - 执行聚合分析
          - 写入最终 Episode（importance=9, visibility=org）

结果：这次高分经验触发 ConsolidationEngine，
      "csv-encoding-diagnosis" 技能的 usage_count +10，success_rate 维持 94%，
      "batch-csv-processing-with-encoding" 新技能候选被挖掘出来。
```

---

*下一步：[09-Storage-Schema 详细设计](./09-Storage-Schema.md)*
