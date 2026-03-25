---
title: "05-Skill-Mining-and-Discovery 详细设计"
date: 2026-03-23T21:00:00+08:00
draft: true
tags: ["agent-memory", "skill", "mining", "discovery", "详细设计", "版本B"]
---

# Skill Mining & Discovery 详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: 从 Episode 中自动挖掘、演化、推荐可复用的技能（Skill）

---

## 1. 模块定位与职责

### 1.1 Skill-MDS 在系统中的位置

Skill-MDS（Skill Mining & Discovery Service）是一个**独立的自动化服务**，负责将 Agent 积累的高质量执行经验提炼成可复用的操作技能。

```
AMS（数据源）──→ Skill-MDS（挖掘、演化、推荐）──→ AMS（写回技能）
                        ↑
               Agent-TES（提供执行反馈）
                        ↓
               Agent Framework（消费推荐技能）
```

**Skill-MDS 的价值**：
- **经验复用**：将一次性的成功经验转化为可被所有 Agent 调用的技能
- **持续演化**：随着更多执行反馈，技能质量不断提升
- **避免重复劳动**：相似任务直接匹配技能，无需从头推理

### 1.2 核心职责

| 职责 | 说明 |
|------|------|
| **技能挖掘** | 从 Episode 聚类中识别可复用模式，生成 Skill 候选 |
| **技能验证** | 通过质量门禁（成功率、样本量）决定候选是否晋升 |
| **技能版本管理** | 处理同名技能的更新、合并、废弃 |
| **技能降级检测** | 监控在用技能的成功率，发现退化及时告警 |
| **技能推荐** | 在 Agent 启动时，结合任务意图推荐最匹配的技能 |
| **技能关系图** | 维护技能间的依赖、组合、泛化关系（Skill Mesh）|

---

## 2. 技能挖掘算法

### 2.1 触发条件

ConsolidationEngine 在以下场景触发 Skill-MDS 挖掘任务：

```python
# 三类触发条件（来自 AMS ConsolidationEngine）
TRIGGER_CONDITIONS = {
    # 条件1：单个高分 Episode（重要性 >= 8 且 outcome == success）
    "high_importance_episode": {
        "importance_threshold": 8.0,
        "outcome":             "success"
    },

    # 条件2：积累到一定数量的同类 Episode
    "batch_episodes": {
        "min_count":  100,         # 近期成功 Episode 达到 100 条
        "run_every":  "6h"         # 每6小时检查一次
    },

    # 条件3：定时全量挖掘
    "scheduled_full_mining": {
        "cron": "0 2 * * *"        # 每日 02:00
    }
}
```

### 2.2 挖掘流程

```
Episode Pool（成功的、importance >= 5）
        │
        ▼
Step 1: Episode 向量聚类（K-Means / HDBSCAN）
        │  → 将语义相似的 Episode 分组
        ▼
Step 2: 候选模式提取（每个聚类 → 提取共同步骤序列）
        │  → 对比 tool_history，找出公共子序列
        ▼
Step 3: LLM 生成 Skill 模板
        │  → 将公共步骤序列 + 典型 Episode 发给 LLM
        │  → LLM 产出：skill_name / trigger_intent / workflow_steps
        ▼
Step 4: 质量门禁
        │  → success_rate >= 0.75 且 sample_count >= 3
        ▼
Step 5: 去重 & 版本管理
        │  → 检查是否已有同名技能（更新 vs 新建）
        ▼
Step 6: 写入 AMS（技能库）
```

### 2.3 Step 1：Episode 聚类

```python
import numpy as np
from sklearn.cluster import HDBSCAN

async def cluster_episodes(
    agent_id: str | None,
    min_cluster_size: int = 3
) -> list[list[str]]:
    """
    从 Milvus 获取 Episode 向量，使用 HDBSCAN 聚类。
    HDBSCAN 优点：不需要预设 K，自动处理噪声点。

    返回：每个聚类的 episode_id 列表
    """
    # 1. 从 Milvus 拉取近90天成功 Episode 的向量
    time_90d = int((datetime.now() - timedelta(days=90)).timestamp())
    expr = f'outcome == "success" and event_time > {time_90d}'
    if agent_id:
        expr += f' and agent_id == "{agent_id}"'

    results = milvus_client.query(
        collection_name="episodes",
        expr=expr,
        output_fields=["episode_id", "embedding"],
        limit=5000  # 最多处理5000条
    )

    if len(results) < min_cluster_size * 2:
        return []   # 数据量不足，不聚类

    episode_ids = [r["episode_id"] for r in results]
    embeddings  = np.array([r["embedding"] for r in results])

    # 2. HDBSCAN 聚类
    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=2,
        metric="euclidean"
    )
    labels = clusterer.fit_predict(embeddings)

    # 3. 按 label 分组（-1 是噪声点，跳过）
    clusters: dict[int, list[str]] = {}
    for episode_id, label in zip(episode_ids, labels):
        if label == -1:
            continue
        clusters.setdefault(label, []).append(episode_id)

    return list(clusters.values())
```

### 2.4 Step 2：提取公共步骤序列

```python
from collections import Counter

async def extract_common_steps(episode_ids: list[str]) -> list[str]:
    """
    从一批 Episode 的 tool_history 中提取公共工具调用序列。
    使用"最长公共子序列"思路，但以工具名为粒度。
    """
    # 从 PostgreSQL 获取这批 Episode 的 tool_history
    rows = await pg.fetch("""
        SELECT episode_id, content_preview, content_oss_key
        FROM episodes WHERE episode_id = ANY($1)
    """, episode_ids)

    all_tool_sequences = []
    for row in rows:
        # 解析 tool_history（存在 content 里）
        content = await load_full_content(row)
        tool_seq = parse_tool_sequence(content)  # 提取工具名序列
        if tool_seq:
            all_tool_sequences.append(tool_seq)

    if not all_tool_sequences:
        return []

    # 统计每个工具在各 Episode 中出现的频率
    # 频率 > 60% 的工具认为是公共步骤
    tool_counter = Counter()
    for seq in all_tool_sequences:
        for tool in set(seq):  # 去重，同一 Episode 只计一次
            tool_counter[tool] += 1

    threshold = len(all_tool_sequences) * 0.6
    common_tools = {t for t, cnt in tool_counter.items() if cnt >= threshold}

    # 从第一个 Episode 中按顺序取公共工具（保持步骤顺序）
    reference_seq = all_tool_sequences[0]
    return [t for t in reference_seq if t in common_tools]
```

### 2.5 Step 3：LLM 生成 Skill 模板

```python
async def generate_skill_template(
    cluster_episodes: list[str],
    common_steps: list[str]
) -> dict:
    """
    调用 LLM，基于典型 Episode 和公共步骤，生成结构化 Skill 定义。
    """
    # 取3个典型 Episode 作为 few-shot 示例
    sample_episodes = await load_episode_summaries(cluster_episodes[:3])

    prompt = f"""
你是一个 Agent 行为分析专家。以下是 {len(cluster_episodes)} 个语义相似的成功任务执行记录的摘要，
以及这些任务共同使用的工具序列。请将它们抽象成一个可复用的"技能（Skill）"定义。

## 共同工具序列
{' → '.join(common_steps)}

## 典型执行案例
{format_episodes(sample_episodes)}

## 请输出以下 JSON 格式（不要其他内容）：
{{
  "name":           "技能的英文名，使用 kebab-case，描述核心动作，例如 csv-encoding-diagnosis",
  "description":    "一句话描述这个技能解决什么问题（中文，30字以内）",
  "trigger_intent": "什么情况下应该用这个技能？（中文，描述触发场景，50字以内）",
  "preconditions":  ["前提条件1", "前提条件2"],
  "workflow_steps": [
    {{"step": 1, "action": "第一步做什么", "tool": "tool_name", "expected_output": "期望的输出"}},
    {{"step": 2, "action": "第二步做什么", "tool": "tool_name", "expected_output": "期望的输出"}}
  ]
}}
"""

    response = await llm.ainvoke(prompt, model="gpt-4o-mini")

    try:
        skill_def = json.loads(response.content.strip())
        skill_def["derived_from"] = cluster_episodes  # 记录来源 Episode
        return skill_def
    except json.JSONDecodeError:
        logger.warning("LLM 返回格式错误，跳过该聚类")
        return None
```

**输出示例**：

```json
{
  "name": "csv-encoding-diagnosis",
  "description": "诊断并修复 CSV 文件的字符编码问题",
  "trigger_intent": "用户遇到 CSV 读取乱码、UnicodeDecodeError、中文显示异常等问题时使用",
  "preconditions": ["有 CSV 文件路径", "文件可读"],
  "workflow_steps": [
    {"step": 1, "action": "检测文件编码", "tool": "chardet.detect", "expected_output": "编码名称如 gbk/utf-8"},
    {"step": 2, "action": "使用检测到的编码读取", "tool": "pd.read_csv", "expected_output": "DataFrame"},
    {"step": 3, "action": "验证行数与列名", "tool": "df.shape", "expected_output": "行数与预期一致"}
  ],
  "derived_from": ["ep_abc123", "ep_def456", "ep_ghi789"]
}
```

### 2.6 Step 4：质量门禁

```python
QUALITY_GATE = {
    "min_success_rate": 0.75,    # 最低成功率
    "min_sample_count": 3,       # 最少样本数（支撑该技能的 Episode 数量）
    "max_avg_turns":    15,      # 平均步骤数上限（太复杂的技能可能是几个技能的叠加）
}

def passes_quality_gate(
    cluster_size:  int,
    success_count: int,
    avg_turns:     float
) -> tuple[bool, str]:
    """
    返回 (通过, 原因)
    """
    success_rate = success_count / cluster_size if cluster_size > 0 else 0

    if success_rate < QUALITY_GATE["min_success_rate"]:
        return False, f"成功率 {success_rate:.1%} < {QUALITY_GATE['min_success_rate']:.1%}"

    if cluster_size < QUALITY_GATE["min_sample_count"]:
        return False, f"样本数 {cluster_size} < {QUALITY_GATE['min_sample_count']}"

    if avg_turns > QUALITY_GATE["max_avg_turns"]:
        return False, f"平均步骤数 {avg_turns:.1f} 超限，建议拆分"

    return True, "OK"
```

---

## 3. 技能版本管理

### 3.1 版本策略

技能以 `name` 字段为唯一标识（英文 kebab-case）。同名技能出现时，根据质量指标决定更新策略：

```
新候选 Skill（name = "csv-encoding-diagnosis"）
        │
        ▼
检查 PostgreSQL skills 表是否存在同名记录
        │
    ┌───┴───────────────────────────────────────────┐
    │                                               │
  不存在                                           存在
    │                                               │
    ▼                                               ▼
 直接写入                               比较新候选 vs 现有技能的质量
（status='candidate'）                             │
                                    ┌──────────────┼──────────────┐
                                    │              │              │
                                 新>旧           新≈旧          新<旧
                                    │              │              │
                                    ▼              ▼              ▼
                               版本+1，合并     补充样本数     保留旧版本
                               workflow_steps  更新指标        丢弃新候选
                               旧版本 deprecated
```

```python
async def upsert_skill(
    skill_def:     dict,
    success_rate:  float,
    sample_count:  int,
    avg_turns:     float
) -> str:
    """
    插入或更新技能，返回 skill_id。
    """
    name = skill_def["name"]

    existing = await pg.fetchrow("""
        SELECT skill_id, version, success_rate, usage_count
        FROM skills WHERE name = $1 AND status != 'deprecated'
        ORDER BY version DESC LIMIT 1
    """, name)

    if existing is None:
        # 新技能，直接写入（状态为 candidate，需积累反馈才晋升 active）
        skill_id = f"sk_{uuid4().hex[:12]}"
        await pg.execute("""
            INSERT INTO skills
                (skill_id, name, version, description, trigger_intent,
                 workflow_steps, preconditions, success_rate, usage_count,
                 avg_turns, derived_from, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'candidate')
        """,
            skill_id, name, 1,
            skill_def["description"], skill_def["trigger_intent"],
            json.dumps(skill_def["workflow_steps"]),
            skill_def.get("preconditions", []),
            success_rate, sample_count, avg_turns,
            skill_def.get("derived_from", [])
        )
        # 同步 embedding 到 Milvus
        embedding = await embedding_svc.embed(
            f"{skill_def['trigger_intent']}\n{skill_def['description']}"
        )
        await milvus_upsert_skill(skill_id, embedding, success_rate, "candidate")
        return skill_id

    # 已有同名技能，比较质量
    old_score = existing["success_rate"]
    new_score = success_rate

    if new_score > old_score + 0.05:
        # 新版本明显更好，升版本
        new_version = existing["version"] + 1
        new_skill_id = f"sk_{uuid4().hex[:12]}"

        await pg.execute("""
            INSERT INTO skills (skill_id, name, version, description,
                trigger_intent, workflow_steps, preconditions,
                success_rate, usage_count, avg_turns, derived_from,
                supersedes, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'candidate')
        """,
            new_skill_id, name, new_version,
            skill_def["description"], skill_def["trigger_intent"],
            json.dumps(skill_def["workflow_steps"]),
            skill_def.get("preconditions", []),
            success_rate, sample_count, avg_turns,
            skill_def.get("derived_from", []),
            existing["skill_id"]   # supersedes 旧版本
        )

        # 旧版本降为 deprecated
        await pg.execute("""
            UPDATE skills SET status = 'deprecated' WHERE skill_id = $1
        """, existing["skill_id"])

        return new_skill_id

    else:
        # 质量相近，仅更新指标（usage_count 累加）
        await pg.execute("""
            UPDATE skills SET
                success_rate = (success_rate * usage_count + $2 * $3) / (usage_count + $3),
                usage_count  = usage_count + $3,
                updated_at   = NOW()
            WHERE skill_id = $1
        """, existing["skill_id"], success_rate, sample_count)

        return existing["skill_id"]
```

### 3.2 技能状态机

```
candidate ──→ active ──→ deprecated
    │            │
    └── (质量门禁不通过) → 丢弃
         (积累 10 次真实调用 + success_rate >= 0.75) → active
         (recent_success_rate < 0.5，持续3天) → deprecated
```

| 状态 | 说明 | 推荐给 Agent？|
|------|------|:----------:|
| `candidate` | 刚挖掘出，样本量少，待验证 | 否 |
| `active` | 经过足够验证，可信赖 | 是 |
| `deprecated` | 被更好版本替代或持续失败 | 否 |

---

## 4. 技能降级检测

### 4.1 滑动窗口监控

每次 Agent 执行技能后，FeedbackAggregator 调用 AMS 更新 `recent_results`（最近20次结果）：

```python
# skills.recent_results 字段结构（JSONB，滑动窗口）
recent_results = [
    {"ts": "2026-03-23T10:00:00Z", "success": True,  "turns": 3},
    {"ts": "2026-03-23T11:30:00Z", "success": False, "turns": 8},
    # ... 最多保留最近20条
]
```

```python
async def update_skill_metrics(
    skill_name: str,
    success: bool,
    turns: int,
    latency_ms: float
) -> None:
    """
    更新技能统计指标（由 AMS skill metrics API 调用）
    """
    skill = await pg.fetchrow(
        "SELECT skill_id, recent_results FROM skills WHERE name=$1 AND status='active'",
        skill_name
    )
    if not skill:
        return

    # 更新滑动窗口
    window: list = json.loads(skill["recent_results"] or "[]")
    window.append({
        "ts": datetime.utcnow().isoformat(),
        "success": success,
        "turns": turns,
        "latency_ms": latency_ms
    })
    window = window[-20:]  # 保留最近20条

    # 计算近期成功率
    recent_success_rate = sum(1 for r in window if r["success"]) / len(window)

    # 更新数据库
    await pg.execute("""
        UPDATE skills SET
            success_rate    = (success_rate * usage_count + $2) / (usage_count + 1),
            usage_count     = usage_count + 1,
            avg_turns       = (avg_turns * usage_count + $3) / (usage_count + 1),
            recent_results  = $4,
            updated_at      = NOW()
        WHERE skill_id = $1
    """,
        skill["skill_id"],
        1.0 if success else 0.0,
        turns,
        json.dumps(window)
    )

    # 降级检测
    if recent_success_rate < 0.5 and len(window) >= 5:
        await trigger_skill_degradation_alert(skill["skill_id"], skill_name, recent_success_rate, window)
```

### 4.2 降级告警与处理

```python
async def trigger_skill_degradation_alert(
    skill_id: str,
    skill_name: str,
    recent_success_rate: float,
    recent_results: list
) -> None:
    """
    技能近期成功率低于阈值，触发降级流程：
    1. 发送告警（Kafka topic: agent.skill.degradation）
    2. 将技能标记为 'under_review'（可选：暂停推荐）
    3. 触发 Skill-MDS 重新挖掘该类型任务
    """
    alert = {
        "skill_id":           skill_id,
        "skill_name":         skill_name,
        "recent_success_rate": recent_success_rate,
        "sample_count":       len(recent_results),
        "failure_details":    [r for r in recent_results if not r["success"]],
        "alert_time":         datetime.utcnow().isoformat()
    }

    # 发送到 Kafka 告警 topic
    await kafka_producer.send("agent.skill.degradation", alert)

    # 若连续10次成功率 < 0.5，自动 deprecated
    if len(recent_results) >= 10:
        failure_count = sum(1 for r in recent_results[-10:] if not r["success"])
        if failure_count >= 6:  # 10次中超过6次失败
            await pg.execute("""
                UPDATE skills SET status = 'deprecated' WHERE skill_id = $1
            """, skill_id)
            logger.warning(f"技能 {skill_name} 已自动降级为 deprecated")
```

---

## 5. Skill Mesh — 技能关系图

### 5.1 概念

技能之间存在语义关系，构成一个**技能关系网络（Skill Mesh）**。这些关系存储在 Neo4j 中，用于：
- 推荐组合技能（若任务需要 A + B，且二者常一起使用）
- 避免同时推荐语义重复的技能
- 在技能搜索时扩展候选范围

```cypher
// ── Skill 节点 ──────────────────────────────────────
// (:SkillNode {skill_id, name, trigger_intent, status, success_rate})

// ── 关系类型 ──────────────────────────────────────────
// DEPENDS_ON: 技能A的执行依赖技能B的输出
//   (:SkillNode)-[:DEPENDS_ON]->(:SkillNode)

// OFTEN_COMBINED: 两个技能经常在同一会话中被连续使用
//   (:SkillNode)-[:OFTEN_COMBINED {co_occurrence_count: 42}]->(:SkillNode)

// SUPERSEDES: 新版本技能替代旧版本
//   (:SkillNode)-[:SUPERSEDES]->(:SkillNode)

// SPECIALIZES: 某技能是另一技能的特化版（更具体的场景）
//   (:SkillNode)-[:SPECIALIZES]->(:SkillNode)
//   例如：csv-gbk-fix -[:SPECIALIZES]-> csv-encoding-diagnosis
```

### 5.2 关系自动发现

```python
async def update_skill_mesh_from_sessions(agent_id: str) -> None:
    """
    分析执行日志，发现技能间的共现关系（OFTEN_COMBINED）。
    每日凌晨执行一次。
    """
    # 查 ClickHouse：同一会话中被连续调用的技能对
    rows = await clickhouse.execute("""
        SELECT skill_a, skill_b, count() AS co_count
        FROM (
            SELECT
                session_id,
                arrayJoin(skill_sequence) AS skill_a,
                arrayJoin(arraySlice(skill_sequence, 2)) AS skill_b
            FROM agent_skill_sessions
            WHERE agent_id = {agent_id}
              AND event_time > now() - INTERVAL 30 DAY
        )
        GROUP BY skill_a, skill_b
        HAVING co_count >= 5          -- 至少出现5次才建立关系
    """, {"agent_id": agent_id})

    for row in rows:
        await neo4j.run("""
            MERGE (a:SkillNode {name: $skill_a})
            MERGE (b:SkillNode {name: $skill_b})
            MERGE (a)-[r:OFTEN_COMBINED]->(b)
            ON CREATE SET r.co_occurrence_count = $count
            ON MATCH  SET r.co_occurrence_count = r.co_occurrence_count + $count
        """, skill_a=row["skill_a"], skill_b=row["skill_b"], count=row["co_count"])
```

### 5.3 技能查询示例

```cypher
-- 查找与某技能经常组合使用的技能（推荐补充技能）
MATCH (a:SkillNode {name: "csv-encoding-diagnosis"})-[:OFTEN_COMBINED]->(b:SkillNode)
WHERE b.status = 'active'
RETURN b.name, b.trigger_intent
ORDER BY b.success_rate DESC
LIMIT 5;

-- 查找技能的最新版本（跳过 superseded 版本）
MATCH path = (latest:SkillNode {name: "csv-encoding-diagnosis"})
WHERE NOT (latest)-[:SUPERSEDES]->()
  AND latest.status = 'active'
RETURN latest;

-- 查找某技能的特化版本（更精确场景匹配时优先）
MATCH (specific:SkillNode)-[:SPECIALIZES]->(base:SkillNode {name: "csv-encoding-diagnosis"})
RETURN specific.name, specific.trigger_intent, specific.success_rate;
```

---

## 6. 技能推荐

### 6.1 推荐时机

Agent Framework 在任务启动时（`load_context_node`）通过 AMS search API 检索匹配技能。AMS 内部 `MultiPathRetriever` 的路径4负责技能检索：

```python
# Agent Framework 调用（来自 02-Agent-Framework.md 的 load_context_node）
memories = await client.search(
    query=task_description,
    layers=["procedural"],   # procedural = Skill 层
    top_k=5
)
```

### 6.2 技能推荐逻辑

AMS 技能检索流程（路径4的详细展开）：

```python
async def retrieve_skills(
    query: str,
    agent_id: str,
    top_k: int = 5
) -> list[SkillResult]:
    """
    技能推荐：向量检索 + 图扩展 + 质量排序
    """
    # Step 1: 向量检索（Milvus skills collection）
    query_embedding = await embedding_svc.embed(query)
    milvus_results = milvus_client.search(
        collection_name="skills",
        data=[query_embedding],
        anns_field="embedding",
        search_params={"metric_type": "COSINE", "params": {"ef": 50}},
        limit=top_k * 3,
        expr='status == "active"',
        output_fields=["skill_id", "success_rate"]
    )
    base_skill_ids = [r.id for r in milvus_results]

    # Step 2: Skill Mesh 扩展（找关联技能）
    mesh_skill_names = await neo4j.run("""
        MATCH (a:SkillNode)-[:OFTEN_COMBINED|SPECIALIZES*1..2]->(b:SkillNode)
        WHERE a.skill_id IN $ids AND b.status = 'active'
        RETURN DISTINCT b.name
        LIMIT 10
    """, ids=base_skill_ids)
    # 将扩展技能加入候选池（权重略低）

    # Step 3: 从 PostgreSQL 获取完整 Skill 定义
    all_ids = base_skill_ids + [s["name"] for s in mesh_skill_names]
    skills = await pg.fetch("""
        SELECT skill_id, name, description, trigger_intent,
               workflow_steps, success_rate, usage_count, avg_turns
        FROM skills
        WHERE (skill_id = ANY($1) OR name = ANY($2))
          AND status = 'active'
        ORDER BY success_rate DESC, usage_count DESC
    """, base_skill_ids, [s["name"] for s in mesh_skill_names])

    # Step 4: 返回（调用方会做统一混合评分）
    return [SkillResult(
        memory_id=s["skill_id"],
        layer="procedural",
        title=s["name"],
        content=f"{s['trigger_intent']}\n步骤：{format_steps(s['workflow_steps'])}",
        score=milvus_similarity_map.get(s["skill_id"], 0.7),  # 来自向量相似度
        metadata={
            "success_rate":  s["success_rate"],
            "usage_count":   s["usage_count"],
            "avg_turns":     s["avg_turns"],
            "workflow_steps": s["workflow_steps"]
        }
    ) for s in skills[:top_k]]
```

### 6.3 技能注入 Prompt 格式

Agent Framework `think_node` 中，技能以结构化格式注入 system prompt：

```
=== 可用技能（根据当前任务匹配）===

[技能] csv-encoding-diagnosis（成功率 94%，已使用 127 次）
触发场景：用户遇到 CSV 读取乱码、UnicodeDecodeError 等问题
步骤：
  1. chardet.detect() → 检测文件编码
  2. pd.read_csv(encoding=<detected>) → 用正确编码读取
  3. df.shape 验证 → 确认行数与预期一致

[技能] dataframe-null-handling（成功率 88%，已使用 43 次）
触发场景：DataFrame 中存在空值需要处理
步骤：
  1. df.isnull().sum() → 统计空值分布
  2. 根据业务语义选择填充/删除/插值策略
  3. 再次验证空值率
```

---

## 7. AMS 对外暴露的 Skill 接口

Skill 相关的 REST API（完整版在 07-API-Design.md，此处列出关键接口）：

```
GET  /api/v1/memory/skills?status=active&limit=20
     → 列出活跃技能列表

GET  /api/v1/memory/skills/{skill_id}
     → 获取技能详情（含 workflow_steps）

POST /api/v1/memory/search
     body: {"query": "...", "layers": ["procedural"], "top_k": 5}
     → 语义搜索技能（推荐入口）

POST /api/v1/memory/skills
     → 直接写入技能（Skill-MDS 或人工录入）

PATCH /api/v1/memory/skills/{name}/metrics
     body: {"success": true, "turns": 3, "latency_ms": 450}
     → 更新技能执行指标（FeedbackAggregator 调用）

GET  /api/v1/memory/skills/{skill_id}/metrics
     → 获取技能指标（含 recent_success_rate）
```

---

## 8. 上下游关系汇总

### 8.1 Skill-MDS 调用哪些服务？

| 服务 | 接口 | 用途 |
|------|------|------|
| **AMS** | GET `/memory/episodes?outcome=success&importance_gte=5` | 获取待挖掘 Episode |
| **AMS** | POST `/memory/skills` | 写入挖掘出的候选技能 |
| **Milvus**（通过AMS）| 间接调用 | Episode 向量聚类 |
| **Neo4j**（通过AMS）| 间接调用 | Skill Mesh 更新 |
| **LLM API** | Chat Completion | 生成 Skill 模板 |
| **Embedding API** | Embedding | trigger_intent 向量化 |
| **ClickHouse**（直接）| SQL 查询 | 技能共现分析 |

> **注意**：Skill-MDS 直接访问 ClickHouse（执行轨迹时序数据），因为 AMS 不封装 ClickHouse 查询接口。其他存储仍通过 AMS API 访问。

### 8.2 哪些服务调用 Skill-MDS？

| 调用方 | 方式 | 说明 |
|--------|------|------|
| **AMS ConsolidationEngine** | HTTP POST 触发 | 发送挖掘任务请求（含待处理 Episode ID 列表）|
| **定时调度器** | Cron | 每日 02:00 触发全量挖掘 |

> **注意**：Agent Framework 不直接调用 Skill-MDS；技能推荐通过 AMS search API 完成，Agent Framework 感知不到 Skill-MDS 的存在。

---

*下一步：[06-Agent-TES 详细设计](./06-Agent-TES.md)*
