---
title: "05-Skill-MDS 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "skill-mining", "hdbscan", "skill-mesh", "详细设计", "版本C"]
---

# Skill-MDS 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: 认知飞轮的"经验提炼层"——将 AMS 中反复成功的执行模式，蒸馏为可复用的结构化技能，并通过技能网格（Skill Mesh）将其注入 Agent Framework。

---

## 1. 模块定位与职责

### 1.1 在认知飞轮中的位置

Skill-MDS（Skill Mining & Discovery Service）是认知飞轮的第三段——**Memory → Skill**，解决的核心问题是：

**如何从大量历史执行记录中，自动发现可复用的"技能配方"，并持续验证和管理它们的质量？**

```
                    ┌─────────────────────────────┐
                    │        认知飞轮              │
                    │                             │
    Agent-TES ─→ Agentic Memory ─→  Skill-MDS ─→ Agent Framework
    （采集）      （结构化记忆）     （技能蒸馏）   （技能应用）
                         ↑                            │
                         └────────── New Trace ───────┘
                    └─────────────────────────────┘
```

**与版本B的关键差异**：版本C 的 Skill-MDS 挖掘的输入源从"成功的 Procedural Memory Graph 路径"升级为同时利用两个数据层：
1. **AMS Procedural Memory**（Neo4j 图路径）——已结构化的执行语义
2. **ClickHouse `agent_task_summary`**（TES 原始任务汇总）——高频工具链的统计信号

双源融合使技能发现既有语义质量（来自图），又有统计可靠性（来自大量任务日志）。

### 1.2 三大职责

| 职责 | 说明 | 主要组件 |
|---|---|---|
| **a. 技能挖掘（Mining）** | 从历史 Trace / Graph 中聚类发现可复用执行模式，提炼为 Skill Candidate | Mining Pipeline |
| **b. 技能目录与检索（Catalog）** | 维护 Skill 的生命周期状态（active/deprecated/experimental），提供检索与推荐接口 | Skill Registry |
| **c. 技能网格（Mesh）** | 构建 Skill 间的关系拓扑（依赖/组合/互斥），实现多技能编排 | Skill Mesh Builder |

### 1.3 与其他模块的边界

| 模块 | 交互内容 | 方向 |
|---|---|---|
| **AMS (01)** | 提供 Skill 检索接口，供 AMS 在 Working Memory 初始化时注入相关 Skill | Skill-MDS → AMS |
| **MPP (02)** | 消费 `ams.skill.generate` Topic，完成技能文档写入 Procedural Memory Tree | MPP → Skill-MDS |
| **Agent-TES (04)** | 消费 ClickHouse `agent_task_summary`，获取工具链统计信号 | Skill-MDS → TES（只读）|
| **Agent Framework** | 通过 REST API 查询适用的 Skill，获取 skill.md 内容 | Agent → Skill-MDS |

---

## 2. Skill 的核心概念

### 2.1 什么是 Skill？

在 AMS 体系中，**Skill（技能）**是对一类成功执行模式的结构化抽象——它不是代码，而是**带约束的工作流配方（Workflow Recipe）**：

```
Skill = {
    "什么情境下触发"（Trigger Condition）
    + "需要哪些前置条件"（Preconditions）
    + "执行哪些步骤"（Step Sequence）
    + "每步用什么工具"（Tool Bindings）
    + "期望的输出形式"（Expected Output）
    + "已知局限性"（Limitations）
}
```

**Skill 的本质是 Procedural Memory 的人机可读形式**：它既能被 LLM 理解（用于 Prompt 注入），也能被代码解析（用于工具预加载、参数校验）。

### 2.2 Skill 的层级结构

Skill 按复杂度分为三个层级，形成**技能组合树（Skill Composition Tree）**：

```
Level 3: Composite Skill（复合技能）
    └── 由多个 Level 2 Skill 组合而成
         示例："完整代码审查流程"

Level 2: Compound Skill（复合技能）
    └── 由多个 Level 1 Skill 串联/并联
         示例："SQL 性能诊断"（= 执行计划分析 + 索引扫描 + 建议生成）

Level 1: Atomic Skill（原子技能）
    └── 最小不可分割的执行单元，通常对应 1-3 步工具调用
         示例："执行 SQL 查询并解析结果"
```

### 2.3 Skill 存储格式：skill.md

每个 Skill 以 Markdown 文档形式持久化，称为 `skill.md`。这一设计的核心优点：
- **LLM 友好**：直接注入 Prompt，无需解析
- **人类可读**：工程师可审阅、手动修订
- **层级结构映射 Procedural Memory Tree**：H1-H4 标题层级直接对应 Tree 的 Block → Section L1 → Section L2

#### skill.md 完整格式规范

```markdown
---
skill_id: "sk-{uuid8}"                    # 唯一标识，生成后不变
skill_name: "SQL性能诊断与优化"
skill_version: "1.3.2"                     # semver
skill_level: 2                             # 1=Atomic, 2=Compound, 3=Composite
status: "active"                           # active | experimental | deprecated
created_at: "2026-01-15T10:30:00Z"
updated_at: "2026-03-20T08:00:00Z"
source_agent_id: "agent_analytics_001"    # 最初从哪个 Agent 挖掘到
confidence_score: 0.87                     # 置信度 [0,1]，Sandbox 测试后更新
usage_count: 342                           # 历史使用次数
success_rate: 0.91                         # 历史成功率
avg_latency_ms: 4200                       # 平均执行耗时
tags: ["sql", "performance", "database", "analytics"]
required_tools: ["sql_query", "explain_plan", "index_advisor"]
trigger_keywords: ["慢查询", "查询优化", "SQL性能", "执行计划"]
dependencies: ["sk-a1b2c3d4"]             # 依赖的其他 Skill IDs
---

# SQL 性能诊断与优化

> **一句话描述**：系统地分析 SQL 查询的执行计划、索引使用和资源消耗，提供具体的优化建议。

## 适用场景

- 用户报告某个查询响应慢（> 2s）
- 需要定期检查关键业务查询的性能
- 数据库负载异常，需要定位根源

**不适用场景**：
- 查询本身 < 100ms（可能无需优化）
- 分布式查询涉及跨库联接（超出工具能力范围）

## 前置条件（Preconditions）

- [ ] 能够访问 `sql_query` 工具（有执行权限）
- [ ] 能够访问 `explain_plan` 工具
- [ ] 用户提供了待优化的 SQL 语句或查询标识

## 执行步骤

### Step 1：获取执行计划

```tool: explain_plan
input: {sql: "<用户提供的SQL>", format: "json"}
expected_output: 包含 cost、rows、type 字段的执行计划
error_handling: 若 SQL 语法错误，直接返回错误信息给用户
```

### Step 2：分析索引使用情况

```tool: sql_query
input: {sql: "SHOW INDEX FROM {table_name}", database: "{db_name}"}
expected_output: 索引列表，包含 cardinality、seq_in_index
```

### Step 3：执行性能分析查询

```tool: sql_query
input: {sql: "EXPLAIN ANALYZE {original_sql}", timeout_ms: 10000}
expected_output: 实际执行时间和行数
note: 若查询时间 > 5s，考虑使用 LIMIT 1000 限制范围
```

### Step 4：生成优化建议

基于前三步的输出，分析：
1. 全表扫描（type=ALL）→ 建议添加索引
2. filesort / temporary → 建议添加复合索引或重写查询
3. rows 估算偏差 > 10x → 建议 ANALYZE TABLE 更新统计信息

```tool: index_advisor
input: {explain_output: "<Step1的输出>", table_stats: "<Step2的输出>"}
expected_output: 具体的 CREATE INDEX 建议
```

## 预期输出

- 执行计划分析报告（结构化）
- 索引缺失或低效使用列表
- 可直接执行的 CREATE INDEX 语句（如适用）
- 优化后预期性能提升估算

## 已知局限性

- 不支持存储过程内部的性能分析
- `index_advisor` 工具对 JSON 列索引支持有限
- 若无 DBA 权限，`EXPLAIN ANALYZE` 可能被拒绝

## 变更历史

| 版本 | 日期 | 变更内容 |
|---|---|---|
| 1.3.2 | 2026-03-20 | 添加 index_advisor 工具调用（Step 4 拆分）|
| 1.3.0 | 2026-02-10 | 新增"不适用场景"说明 |
| 1.0.0 | 2026-01-15 | 初始版本（自动挖掘生成）|
```

---

## 3. 技能挖掘管道（Mining Pipeline）

### 3.1 管道总览

技能挖掘是一个**离线批处理 + 在线触发**的混合管道：

```
┌──────────────────────────────────────────────────────────────────┐
│                     Skill Mining Pipeline                        │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │   数据采集    │───→│  模式聚类    │───→│   候选生成        │   │
│  │  (Data       │    │  (Pattern    │    │   (Candidate      │   │
│  │  Collection) │    │  Clustering) │    │   Extraction)     │   │
│  └──────────────┘    └──────────────┘    └────────┬──────────┘   │
│                                                   │              │
│  ┌──────────────┐    ┌──────────────┐    ┌────────▼──────────┐   │
│  │   技能注册    │←───│  Sandbox     │←───│   LLM 精炼        │   │
│  │  (Registry)  │    │  测试验证    │    │   (LLM Refine)    │   │
│  └──────────────┘    └──────────────┘    └───────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**触发机制**：
- **定时触发（主路径）**：每日凌晨 2:00 UTC 执行全量挖掘，分析过去 7 天新增的 Trace 数据
- **积累触发（补充）**：当特定 `agent_id` 的成功 `task_count` 自上次挖掘后新增 200+，触发增量挖掘

### 3.2 阶段一：数据采集（Data Collection）

从两个数据源拉取挖掘原料：

```python
class SkillMiningDataCollector:
    """
    从两个数据源并行拉取挖掘原料：
    1. ClickHouse agent_task_summary - 工具链统计信号
    2. Neo4j Procedural Memory - 执行语义图
    """

    async def collect_tool_chain_patterns(
        self,
        agent_id: str,
        days: int = 7,
        min_occurrences: int = 5      # 出现次数阈值，过滤噪声
    ) -> list[ToolChainPattern]:
        """
        从 ClickHouse 提取高频工具链模式。

        工具链 = task 中按时序排列的工具调用序列。
        例如：["explain_plan", "sql_query", "index_advisor"]
        """
        query = """
        SELECT
            tool_chain,
            count() AS frequency,
            countIf(outcome = 'success') AS success_count,
            avg(latency_ms) AS avg_latency,
            avg(total_tokens) AS avg_tokens
        FROM agent_task_summary
        WHERE agent_id = %(agent_id)s
          AND outcome = 'success'
          AND event_time >= now() - INTERVAL %(days)s DAY
          AND length(tool_chain) >= 2        -- 至少 2 步工具调用才有价值
        GROUP BY tool_chain
        HAVING frequency >= %(min_occurrences)s
        ORDER BY frequency DESC
        LIMIT 500
        """
        rows = await self.clickhouse.execute(query, {
            "agent_id": agent_id,
            "days": days,
            "min_occurrences": min_occurrences
        })
        return [ToolChainPattern(**row) for row in rows]

    async def collect_procedural_graph_paths(
        self,
        agent_id: str,
        days: int = 7
    ) -> list[GraphPath]:
        """
        从 Neo4j Procedural Memory 提取成功执行的图路径。

        图路径包含：动作节点（Action Phrases）+ 执行关系（THEN/IF_THEN）+ 时间信息
        这比工具链更丰富——包含了 LLM 的推理语义（"当发现全表扫描时，检查索引"）
        """
        cypher = """
        MATCH path = (start:PhraseNode)-[:THEN*2..10]->(end:PhraseNode)
        WHERE start.agent_id = $agent_id
          AND start.memory_type = 'procedural'
          AND all(r IN relationships(path) WHERE
                  r.outcome = 'success' AND
                  r.created_at >= datetime() - duration({days: $days}))
        WITH path,
             [n IN nodes(path) | n.name] AS node_names,
             length(path) AS path_len,
             avg([r IN relationships(path) | r.confidence]) AS avg_confidence
        WHERE avg_confidence >= 0.6          -- 置信度过滤
        RETURN node_names, path_len, avg_confidence,
               count(*) AS frequency
        ORDER BY frequency DESC
        LIMIT 200
        """
        result = await self.neo4j.execute(cypher, {
            "agent_id": agent_id,
            "days": days
        })
        return [GraphPath(**record) for record in result]
```

### 3.3 阶段二：模式聚类（Pattern Clustering）

使用 **HDBSCAN（Hierarchical Density-Based Spatial Clustering of Applications with Noise）** 对工具链进行聚类，将语义相似的执行模式归并为一组。

#### 为什么选择 HDBSCAN？

| 比较维度 | K-Means | DBSCAN | **HDBSCAN** |
|---|---|---|---|
| 需要预设 K | ✅ 需要 | ❌ 不需要 | ❌ **不需要** |
| 处理噪声点 | ❌ 不处理 | ✅ 处理 | ✅ **处理** |
| 识别不规则形状的簇 | ❌ 只能圆形 | ✅ 支持 | ✅ **支持** |
| 层级聚类（多粒度）| ❌ | ❌ | ✅ **核心特性** |
| 稳定性（noise 处理）| ❌ | 中等 | ✅ **更稳定** |

技能集群天然是"大小不均匀、形状不规则"的——有些技能（如"搜索并总结"）非常通用，覆盖大量 Trace；有些技能（如"分析特定日志格式"）极其专用。HDBSCAN 能自适应地处理这种密度差异。

#### 向量化：工具链 → 嵌入向量

```python
class ToolChainVectorizer:
    """
    将工具链序列转换为固定维度的语义向量。

    使用两级向量化：
    1. 工具名 Token 化 + 位置编码（捕获顺序信息）
    2. 将工具链转为自然语言描述，走 LLM Embedding（捕获语义信息）

    最终向量 = concat(structural_embedding, semantic_embedding)
    """

    KNOWN_TOOLS = [
        # 标准工具集（每个系统会有自己的工具库）
        "sql_query", "explain_plan", "index_advisor", "read_file",
        "write_file", "web_search", "http_request", "code_execute",
        "vector_search", "graph_query", "send_email", "create_ticket",
        # ... 更多工具
    ]

    def structural_embed(self, tool_chain: list[str]) -> np.ndarray:
        """
        结构化向量：捕获工具使用顺序（位置感知的 BoW）

        工具出现在不同位置赋予不同权重：
        - 位置 i 的权重 = 1 / (1 + i)（靠前的工具权重更高）
        """
        vec = np.zeros(len(self.KNOWN_TOOLS))
        for pos, tool in enumerate(tool_chain):
            if tool in self.KNOWN_TOOLS:
                idx = self.KNOWN_TOOLS.index(tool)
                vec[idx] += 1.0 / (1 + pos)   # 位置衰减权重
        return vec / (np.linalg.norm(vec) + 1e-8)  # L2 归一化

    async def semantic_embed(self, tool_chain: list[str]) -> np.ndarray:
        """
        语义向量：将工具链转为自然语言，走 Embedding 模型

        示例：["explain_plan", "sql_query", "index_advisor"]
          → "Analyze SQL execution plan, then execute SQL query,
             then get index optimization advice"
          → LLM Embedding → 1536-dim vector
        """
        description = "Execute workflow: " + " → ".join(
            self._tool_to_description(t) for t in tool_chain
        )
        embedding = await self.embedding_client.embed(description)
        return np.array(embedding)

    def vectorize(self, tool_chain: list[str],
                  semantic_vec: np.ndarray) -> np.ndarray:
        """合并结构化 + 语义向量"""
        structural_vec = self.structural_embed(tool_chain)
        return np.concatenate([
            structural_vec * 0.3,   # 结构化权重 30%
            semantic_vec * 0.7       # 语义权重 70%
        ])


class ToolChainClusterer:
    """
    使用 HDBSCAN 对工具链向量进行层级密度聚类。
    输出：簇 ID → 簇中的工具链列表（含频率、成功率）
    """

    def __init__(
        self,
        min_cluster_size: int = 3,      # 最小簇大小（少于此数量的不成簇）
        min_samples: int = 2,            # 核心点的最少邻居数
        cluster_selection_epsilon: float = 0.1  # 合并相近簇的距离阈值
    ):
        import hdbscan
        self.clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_selection_epsilon,
            cluster_selection_method="eom",   # Excess of Mass（推荐）
            metric="euclidean",
            prediction_data=True              # 支持后续的 soft clustering
        )

    def cluster(
        self,
        patterns: list[ToolChainPattern],
        vectors: np.ndarray
    ) -> dict[int, list[ToolChainPattern]]:
        """
        返回：{cluster_id: [patterns]}
        cluster_id = -1 表示噪声点（不被任何簇接纳的模式）
        """
        labels = self.clusterer.fit_predict(vectors)
        probabilities = self.clusterer.probabilities_    # 每个点属于其簇的置信度

        clusters: dict[int, list] = {}
        for pattern, label, prob in zip(patterns, labels, probabilities):
            if label == -1:
                continue   # 过滤噪声点，不生成技能
            if label not in clusters:
                clusters[label] = []
            clusters[label].append({
                "pattern": pattern,
                "cluster_probability": float(prob)
            })

        return clusters

    def select_representative_chain(
        self,
        cluster_patterns: list[dict]
    ) -> ToolChainPattern:
        """
        从簇中选择最具代表性的工具链（作为技能模板的骨架）。
        选择标准：frequency * success_rate * cluster_probability 的加权得分最高者
        """
        best = max(
            cluster_patterns,
            key=lambda x: (
                x["pattern"].frequency *
                x["pattern"].success_rate *
                x["cluster_probability"]
            )
        )
        return best["pattern"]
```

### 3.4 阶段三：LLM 精炼（LLM Refinement）

聚类只能给出工具链骨架，要生成高质量的 skill.md，还需要 LLM 理解语义并补全文档：

```python
class SkillRefiner:
    """
    使用 LLM 将工具链模式 + 图路径语义 精炼为完整的 skill.md。

    输入：
        - representative_chain: 代表性工具链
        - cluster_patterns: 簇内所有模式（用于提取触发场景多样性）
        - graph_paths: Neo4j 中相关的执行语义路径

    输出：
        - SkillCandidate（含完整 skill.md 草稿）
    """

    REFINE_PROMPT = """你是一个 AI Agent 技能文档编写专家。

基于以下信息，生成一个标准化的技能文档（skill.md）：

## 工具链模式（核心骨架）
代表性工具调用序列：{tool_chain}
在过去 {days} 天中出现 {frequency} 次，成功率 {success_rate:.0%}，平均耗时 {avg_latency_ms}ms

## 簇内工具链变体（{variants_count} 个变体）
{variants_summary}

## 执行语义路径（来自知识图谱）
{graph_paths_summary}

## 生成要求
请生成一个完整的 skill.md，包含：
1. YAML frontmatter（skill_id 留空，我会填充）
2. 适用场景（从工具链模式和图路径中推断）
3. 不适用场景（基于工具能力局限性）
4. 前置条件（checkboxes）
5. 执行步骤（每步含 tool 代码块）
6. 预期输出描述
7. 已知局限性

语言要求：中文描述 + 英文技术术语
简洁原则：单个技能文档不超过 150 行
"""

    async def refine(
        self,
        representative_chain: ToolChainPattern,
        cluster_patterns: list[ToolChainPattern],
        graph_paths: list[GraphPath]
    ) -> "SkillCandidate":
        # 构造 variants summary（最多取 5 个变体）
        variants = cluster_patterns[:5]
        variants_summary = "\n".join(
            f"- {p.tool_chain} (freq={p.frequency}, sr={p.success_rate:.0%})"
            for p in variants
        )

        # 构造图路径 summary
        graph_summary = "\n".join(
            f"- {' → '.join(p.node_names[:6])} (confidence={p.avg_confidence:.2f})"
            for p in graph_paths[:5]
        )

        prompt = self.REFINE_PROMPT.format(
            tool_chain=representative_chain.tool_chain,
            days=7,
            frequency=representative_chain.frequency,
            success_rate=representative_chain.success_rate,
            avg_latency_ms=representative_chain.avg_latency,
            variants_count=len(cluster_patterns),
            variants_summary=variants_summary,
            graph_paths_summary=graph_summary
        )

        skill_md_content = await self.llm_client.complete(
            prompt=prompt,
            model="gpt-4o",
            max_tokens=3000,
            temperature=0.3    # 低温度，保证文档格式一致性
        )

        # 解析 LLM 输出，填充 skill_id 和统计字段
        candidate = self._parse_skill_md(skill_md_content)
        candidate.skill_id = f"sk-{uuid4().hex[:8]}"
        candidate.confidence_score = self._compute_confidence(
            frequency=representative_chain.frequency,
            success_rate=representative_chain.success_rate,
            cluster_size=len(cluster_patterns),
            graph_path_count=len(graph_paths)
        )
        candidate.source_agent_id = representative_chain.agent_id
        candidate.status = "experimental"   # 新生成的技能默认为实验状态

        return candidate

    def _compute_confidence(
        self,
        frequency: int,
        success_rate: float,
        cluster_size: int,
        graph_path_count: int
    ) -> float:
        """
        置信度 = 频率因子 × 成功率 × 多样性因子 × 图验证因子

        - 频率因子：log(frequency + 1) / log(100)，映射到 [0,1]
        - 多样性因子：min(cluster_size, 10) / 10
        - 图验证因子：min(graph_path_count, 5) / 5（有图路径佐证质量更高）
        """
        import math
        frequency_factor = min(math.log(frequency + 1) / math.log(100), 1.0)
        diversity_factor = min(cluster_size, 10) / 10.0
        graph_factor = min(graph_path_count, 5) / 5.0

        return round(frequency_factor * success_rate * diversity_factor * graph_factor, 3)
```

### 3.5 阶段四：Sandbox 测试（Sandbox Validation）

Skill Candidate 在进入 active 状态前，必须通过 Sandbox 测试：

```python
class SkillSandbox:
    """
    在隔离的沙箱环境中，使用历史测试用例验证 Skill Candidate 的质量。

    测试维度：
    1. 可解析性（Parsability）：YAML frontmatter + Markdown 格式合法
    2. 工具可用性（Tool Availability）：required_tools 在当前系统中存在
    3. 步骤完整性（Step Completeness）：每个步骤都有对应的工具调用
    4. 历史回测（Historical Backtesting）：用历史 Trace 回放，验证技能触发条件和步骤
    """

    class ValidationResult:
        passed: bool
        score: float                 # 综合得分 [0,1]
        parsability: bool
        tool_availability: float     # 所需工具的可用率
        step_completeness: float     # 步骤完整度
        backtest_success_rate: float # 历史回测成功率
        failure_reasons: list[str]

    async def validate(
        self,
        candidate: "SkillCandidate",
        backtest_traces: list[dict] | None = None
    ) -> ValidationResult:
        result = ValidationResult()

        # Step 1: 可解析性验证
        result.parsability = self._validate_format(candidate.skill_md)
        if not result.parsability:
            result.passed = False
            result.failure_reasons.append("YAML frontmatter 解析失败或 Markdown 格式不合规")
            return result

        # Step 2: 工具可用性验证
        available_tools = await self.tool_registry.list_available_tools()
        required = candidate.required_tools
        available = [t for t in required if t in available_tools]
        result.tool_availability = len(available) / max(len(required), 1)
        if result.tool_availability < 0.8:
            result.failure_reasons.append(
                f"工具不可用：{set(required) - set(available)}"
            )

        # Step 3: 步骤完整性验证（每步必须有至少一个 ```tool: 代码块）
        step_count, tool_block_count = self._count_steps_and_tools(candidate.skill_md)
        result.step_completeness = min(tool_block_count / max(step_count, 1), 1.0)
        if result.step_completeness < 0.6:
            result.failure_reasons.append(
                f"步骤工具绑定不足：{step_count} 步骤只有 {tool_block_count} 个工具调用"
            )

        # Step 4: 历史回测（可选，无测试集时跳过）
        if backtest_traces:
            result.backtest_success_rate = await self._run_backtest(
                candidate, backtest_traces
            )
        else:
            result.backtest_success_rate = 0.5   # 无测试集时给中性分

        # 综合得分
        result.score = (
            (1.0 if result.parsability else 0.0) * 0.3 +
            result.tool_availability * 0.2 +
            result.step_completeness * 0.2 +
            result.backtest_success_rate * 0.3
        )
        result.passed = result.score >= 0.6 and result.parsability and \
                        result.tool_availability >= 0.8

        return result

    async def _run_backtest(
        self,
        candidate: "SkillCandidate",
        traces: list[dict]
    ) -> float:
        """
        用历史 Trace 回放验证技能的触发条件和步骤覆盖度。

        验证逻辑：
        1. 从 traces 中找到与技能触发关键词匹配的 task_summary
        2. 检验这些 task 的实际工具链是否与技能步骤高度重叠（Jaccard ≥ 0.6）
        """
        trigger_words = candidate.trigger_keywords
        matched_traces = [
            t for t in traces
            if any(kw in t.get("task_summary", "") for kw in trigger_words)
        ]
        if not matched_traces:
            return 0.5   # 无匹配记录，中性

        skill_tools = set(candidate.required_tools)
        overlap_scores = []
        for trace in matched_traces[:20]:    # 最多回测 20 条
            trace_tools = set(trace.get("tool_chain", []))
            if not trace_tools:
                continue
            jaccard = len(skill_tools & trace_tools) / len(skill_tools | trace_tools)
            overlap_scores.append(jaccard)

        return sum(overlap_scores) / max(len(overlap_scores), 1)
```

---

## 4. Skill Registry（技能注册与管理）

### 4.1 Registry 数据模型（PostgreSQL）

```sql
-- 技能注册表
CREATE TABLE skill_registry (
    skill_id            VARCHAR(32) PRIMARY KEY,   -- "sk-{uuid8}"
    skill_name          TEXT NOT NULL,
    skill_version       VARCHAR(20) NOT NULL,       -- semver
    skill_level         SMALLINT NOT NULL,          -- 1/2/3
    status              VARCHAR(20) NOT NULL        -- active/experimental/deprecated
                          DEFAULT 'experimental',
    confidence_score    REAL NOT NULL,
    usage_count         INTEGER NOT NULL DEFAULT 0,
    success_count       INTEGER NOT NULL DEFAULT 0,
    total_count         INTEGER NOT NULL DEFAULT 0,  -- 使用次数（含失败）
    avg_latency_ms      REAL,
    source_agent_id     VARCHAR(64),
    required_tools      TEXT[] NOT NULL,
    trigger_keywords    TEXT[] NOT NULL,
    tags                TEXT[] NOT NULL DEFAULT '{}',
    dependencies        TEXT[] NOT NULL DEFAULT '{}', -- 依赖的 skill_ids
    skill_md_path       TEXT NOT NULL,               -- OSS 路径
    sandbox_score       REAL,                        -- Sandbox 测试得分
    sandbox_passed_at   TIMESTAMPTZ,

    -- 版本管理
    previous_version_id VARCHAR(32),                -- 升级前的版本 skill_id
    deprecation_reason  TEXT,
    deprecated_at       TIMESTAMPTZ,

    -- 审计
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          VARCHAR(64) NOT NULL DEFAULT 'skill-mds-auto',  -- 'auto' or user_id

    -- 多租户
    tenant_id           VARCHAR(64) NOT NULL
);

-- 成功率计算视图
CREATE VIEW skill_metrics AS
SELECT
    skill_id,
    skill_name,
    status,
    confidence_score,
    usage_count,
    CASE WHEN total_count > 0
         THEN success_count::REAL / total_count
         ELSE 0 END AS success_rate,
    avg_latency_ms,
    updated_at
FROM skill_registry;

-- 技能使用日志（用于降级检测和趋势分析）
CREATE TABLE skill_usage_log (
    log_id          BIGSERIAL PRIMARY KEY,
    skill_id        VARCHAR(32) NOT NULL REFERENCES skill_registry(skill_id),
    task_id         VARCHAR(64) NOT NULL,
    agent_id        VARCHAR(64) NOT NULL,
    tenant_id       VARCHAR(64) NOT NULL,
    outcome         VARCHAR(20) NOT NULL,    -- success/failure/partial
    latency_ms      INTEGER,
    matched         BOOLEAN NOT NULL,        -- 技能是否真正发挥了作用（来自 TES flush span）
    used_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_skill_usage_log_skill_id_used_at
    ON skill_usage_log(skill_id, used_at DESC);
CREATE INDEX idx_skill_usage_log_agent_id
    ON skill_usage_log(agent_id, used_at DESC);
```

### 4.2 状态机

技能在生命周期中经历以下状态转换：

```
        ┌─────────────────────────────────────────────────────┐
        │                  Skill 状态机                        │
        │                                                     │
        │  [挖掘生成]                                          │
        │       │                                             │
        │       ▼                                             │
        │  experimental ──→ [Sandbox 测试]                    │
        │       │                │                            │
        │       │          score ≥ 0.6 ──────────────────→ active
        │       │                                             │ │
        │       │          score < 0.6 ──→ rejected           │ │ [持续监控]
        │       │                                             │ │
        │       └──────── [手动提升] ────────────────────→ active
        │                                                     │ │
        │                                    [降级检测触发]    │ │
        │  deprecated ←─────────────────────────────────────── ┘
        │       │
        │       └── [手动归档] ──→ archived
        └─────────────────────────────────────────────────────┘
```

### 4.3 Registry API

```python
class SkillRegistry:
    """技能注册表，提供 CRUD + 检索 + 状态管理接口"""

    # ─── 注册 ────────────────────────────────────────────────
    async def register(self, candidate: SkillCandidate,
                        sandbox_result: SandboxResult) -> str:
        """注册新技能，返回 skill_id"""
        async with self.pg.transaction():
            # 检查是否存在语义重复的技能
            duplicate = await self._find_duplicate(candidate)
            if duplicate:
                # 若重复，触发版本升级流程而非新建
                return await self.upgrade(duplicate.skill_id, candidate)

            # 写入 skill.md 到 OSS
            oss_path = f"skills/{candidate.tenant_id}/{candidate.skill_id}.md"
            await self.oss.put(oss_path, candidate.skill_md.encode())

            # 写入 PostgreSQL
            await self.pg.execute("""
                INSERT INTO skill_registry
                (skill_id, skill_name, skill_version, skill_level, status,
                 confidence_score, source_agent_id, required_tools,
                 trigger_keywords, tags, dependencies, skill_md_path,
                 sandbox_score, sandbox_passed_at, tenant_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            """, candidate.skill_id, candidate.skill_name,
                candidate.skill_version, candidate.skill_level,
                "active" if sandbox_result.passed else "experimental",
                candidate.confidence_score, candidate.source_agent_id,
                candidate.required_tools, candidate.trigger_keywords,
                candidate.tags, candidate.dependencies, oss_path,
                sandbox_result.score,
                datetime.utcnow() if sandbox_result.passed else None,
                candidate.tenant_id)

            # 写入 Milvus（用于语义检索）
            await self._index_skill_embedding(candidate)

            return candidate.skill_id

    # ─── 检索 ────────────────────────────────────────────────
    async def search(
        self,
        query: str,
        agent_id: str,
        tenant_id: str,
        top_k: int = 5,
        status_filter: list[str] | None = None
    ) -> list[SkillRecord]:
        """
        多路检索技能：
        1. 关键词匹配（trigger_keywords 数组 overlap）
        2. 语义向量相似度（Milvus）
        3. 历史使用加权（该 agent 使用过的技能排名上浮）
        """
        if status_filter is None:
            status_filter = ["active"]

        # 关键词候选
        keyword_results = await self._keyword_search(
            query, tenant_id, status_filter
        )

        # 向量语义候选
        query_vec = await self.embedding_client.embed(query)
        vector_results = await self._vector_search(
            query_vec, tenant_id, status_filter, top_k * 3
        )

        # 融合 + 重排（RRF + 历史使用加权）
        merged = self._rrf_merge(keyword_results, vector_results)
        personalized = await self._personalize(merged, agent_id, top_k)

        return personalized

    # ─── 状态管理 ─────────────────────────────────────────────
    async def deprecate(
        self,
        skill_id: str,
        reason: str,
        replacement_skill_id: str | None = None
    ) -> None:
        """将技能标记为 deprecated，可选指定替代技能"""
        await self.pg.execute("""
            UPDATE skill_registry
            SET status = 'deprecated',
                deprecation_reason = $2,
                deprecated_at = now(),
                updated_at = now()
            WHERE skill_id = $1
        """, skill_id, reason)

        # 通知 Kafka（让 AMS 的 Skill Cache 失效）
        await self.kafka.send("ams.skill.deprecated", {
            "skill_id": skill_id,
            "reason": reason,
            "replacement_skill_id": replacement_skill_id
        })

    async def upgrade(
        self,
        old_skill_id: str,
        new_candidate: "SkillCandidate"
    ) -> str:
        """升级现有技能（保留历史版本，状态为 deprecated）"""
        new_candidate.skill_id = f"sk-{uuid4().hex[:8]}"
        new_candidate.previous_version_id = old_skill_id

        # 先废弃旧版本
        await self.deprecate(
            old_skill_id,
            reason=f"升级到新版本 {new_candidate.skill_id}",
            replacement_skill_id=new_candidate.skill_id
        )

        # 注册新版本
        sandbox_result = await self.sandbox.validate(new_candidate)
        return await self.register(new_candidate, sandbox_result)
```

---

## 5. 降级检测（Degradation Detection）

### 5.1 检测逻辑

技能投入使用后，需要持续监控其成功率，防止因环境变化（工具 API 更新、业务逻辑变化）导致技能失效：

```python
class SkillDegradationDetector:
    """
    持续监控技能的运行时成功率，检测统计显著的下降。

    检测算法：
    1. 每小时聚合过去 24h 的技能使用日志
    2. 计算"基线成功率"（过去 7 天）vs "当前成功率"（过去 24h）
    3. 用 Wilson Score 置信区间判断是否存在统计显著差异
    4. 若差异显著且超过阈值，触发降级告警
    """

    DEGRADATION_THRESHOLD = 0.15    # 成功率下降超过 15% 触发告警
    MIN_SAMPLE_SIZE = 20             # 少于 20 次使用不判断（样本不足）

    async def run_detection(self, tenant_id: str) -> list[DegradationAlert]:
        alerts = []
        active_skills = await self.registry.list_active(tenant_id)

        for skill in active_skills:
            baseline = await self._get_baseline_rate(skill.skill_id)
            current = await self._get_current_rate(skill.skill_id)

            if current["sample_count"] < self.MIN_SAMPLE_SIZE:
                continue   # 样本不足，跳过

            drop = baseline["success_rate"] - current["success_rate"]
            if drop >= self.DEGRADATION_THRESHOLD:
                # 计算 Wilson Score 置信区间（确保统计显著性）
                ci_lower, ci_upper = self._wilson_interval(
                    current["success_count"],
                    current["sample_count"]
                )
                if ci_upper < baseline["success_rate"] - 0.05:
                    # 当前成功率的置信上界低于基线 - 5%，判为显著下降
                    alerts.append(DegradationAlert(
                        skill_id=skill.skill_id,
                        skill_name=skill.skill_name,
                        baseline_success_rate=baseline["success_rate"],
                        current_success_rate=current["success_rate"],
                        drop=drop,
                        sample_count=current["sample_count"],
                        suggested_action=(
                            "auto_deprecate"
                            if drop >= 0.30 else "manual_review"
                        )
                    ))

        return alerts

    async def handle_alerts(self, alerts: list[DegradationAlert]) -> None:
        for alert in alerts:
            if alert.suggested_action == "auto_deprecate":
                # 严重降级（>30%）：自动废弃
                await self.registry.deprecate(
                    alert.skill_id,
                    reason=f"自动降级检测：成功率从 {alert.baseline_success_rate:.0%} "
                           f"下降到 {alert.current_success_rate:.0%}"
                )
                await self.notify("critical", alert)
            else:
                # 一般降级（15-30%）：触发人工审查告警
                await self.notify("warning", alert)

    def _wilson_interval(
        self, success: int, total: int, z: float = 1.96
    ) -> tuple[float, float]:
        """
        Wilson Score 置信区间（比正态近似更准确，尤其对极端比例）
        z=1.96 对应 95% 置信水平
        """
        if total == 0:
            return 0.0, 1.0
        p_hat = success / total
        denominator = 1 + z**2 / total
        center = (p_hat + z**2 / (2 * total)) / denominator
        margin = z * (p_hat * (1 - p_hat) / total + z**2 / (4 * total**2)) ** 0.5 / denominator
        return max(center - margin, 0.0), min(center + margin, 1.0)
```

### 5.2 降级告警规则（Prometheus）

```yaml
groups:
  - name: skill_mds_alerts
    rules:
      # 技能成功率低告警
      - alert: SkillSuccessRateLow
        expr: |
          (
            sum by (skill_id, skill_name) (
              rate(skill_usage_success_total[1h])
            ) /
            sum by (skill_id, skill_name) (
              rate(skill_usage_total[1h])
            )
          ) < 0.6
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Skill {{ $labels.skill_name }} success rate < 60%"
          description: "Current rate: {{ $value | humanizePercentage }}"

      # 技能成功率严重低告警（自动废弃触发条件）
      - alert: SkillSuccessRateCritical
        expr: |
          (
            sum by (skill_id, skill_name) (
              rate(skill_usage_success_total[2h])
            ) /
            sum by (skill_id, skill_name) (
              rate(skill_usage_total[2h])
            )
          ) < 0.4
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Skill {{ $labels.skill_name }} CRITICAL: success rate < 40%"

      # 技能挖掘管道积压告警
      - alert: SkillMiningPipelineLag
        expr: kafka_consumer_lag{consumer_group="skill-mining", topic="ams.trace.ingested"} > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Skill Mining Pipeline consumer lag > 10K"
```

---

## 6. Skill Mesh（技能网格）

### 6.1 设计定位

Skill Mesh 是技能间**关系拓扑的维护与查询引擎**——技能不是孤立的，它们之间存在依赖、组合、互斥等复杂关系：

```
                         Skill Mesh 拓扑示意
                ┌─────────────────────────────────┐
                │                                 │
    sk-A (SQL查询) ──COMPOSES──→ sk-C (SQL性能诊断) │
                │                    │            │
    sk-B (索引分析) ──COMPOSES──→ sk-C             │
                │                    │            │
                │               EXTENDS↓          │
                │                sk-D (DB综合诊断)  │
                │                    │            │
                │               CONFLICTS         │
                │                    ↓            │
                │              sk-E (轻量DB检查)    │
                └─────────────────────────────────┘
```

### 6.2 Skill Mesh 边类型

| 边类型 | 含义 | 自动推断逻辑 |
|---|---|---|
| `COMPOSES` | A 是 B 的组成步骤 | B 的步骤序列中包含 A 的 `required_tools` 子集 |
| `EXTENDS` | A 在 B 基础上增加了能力 | A 的触发场景是 B 的超集，且包含 B 的全部步骤 |
| `REQUIRES` | 使用 A 必须先有 B 的输出 | A 的 frontmatter `dependencies` 列表中包含 B |
| `CONFLICTS` | A 和 B 不能同时使用 | 两者都声明了相同的工具但步骤不兼容（由人工标注）|
| `SUPERSEDES` | A 是 B 的升级版 | Registry 中 A.previous_version_id = B.skill_id |

### 6.3 Skill Mesh 存储（Neo4j）

```cypher
// Skill 节点
CREATE CONSTRAINT skill_id_unique
    FOR (s:Skill) REQUIRE s.skill_id IS UNIQUE;

CREATE (s:Skill {
    skill_id:        "sk-a1b2c3d4",
    skill_name:      "SQL性能诊断与优化",
    skill_version:   "1.3.2",
    skill_level:     2,
    status:          "active",
    confidence:      0.87,
    tags:            ["sql", "performance"],
    tenant_id:       "tenant_abc"
})

// Skill 关系边
MATCH (a:Skill {skill_id: "sk-a1b2c3d4"})
MATCH (b:Skill {skill_id: "sk-e5f6g7h8"})
CREATE (a)-[:COMPOSES {
    created_at:         datetime(),
    inferred_by:        "auto",          // "auto" 或 "manual"
    confidence:         0.92
}]->(b)

// 查询：给定任务意图，推荐可用技能（含依赖图）
MATCH (s:Skill)-[:COMPOSES*0..2]->(related:Skill)
WHERE s.skill_id IN $candidate_ids
  AND s.status = 'active'
  AND s.tenant_id = $tenant_id
RETURN s, collect(DISTINCT related) AS related_skills
ORDER BY s.confidence DESC
```

### 6.4 Skill Mesh 自动构建

```python
class SkillMeshBuilder:
    """
    在技能注册/升级时，自动推断 Skill Mesh 中的关系边。
    """

    async def rebuild_edges_for_skill(self, new_skill: SkillRecord) -> None:
        """
        当新技能注册时，遍历现有技能库，推断新技能与其他技能的关系。
        """
        all_skills = await self.registry.list_active(new_skill.tenant_id)

        for existing in all_skills:
            if existing.skill_id == new_skill.skill_id:
                continue

            # 检查 COMPOSES 关系（新技能是否是现有技能的子技能）
            if self._is_composed_by(new_skill, existing):
                await self.neo4j.execute("""
                    MATCH (a:Skill {skill_id: $a_id})
                    MATCH (b:Skill {skill_id: $b_id})
                    MERGE (a)-[r:COMPOSES {tenant_id: $tenant_id}]->(b)
                    SET r.confidence = $confidence, r.updated_at = datetime()
                """, a_id=new_skill.skill_id, b_id=existing.skill_id,
                    tenant_id=new_skill.tenant_id,
                    confidence=self._compute_compose_confidence(new_skill, existing))

            # 检查 EXTENDS 关系（新技能是否扩展了现有技能）
            if self._is_extension_of(new_skill, existing):
                await self.neo4j.execute("""
                    MATCH (a:Skill {skill_id: $a_id})
                    MATCH (b:Skill {skill_id: $b_id})
                    MERGE (a)-[r:EXTENDS {tenant_id: $tenant_id}]->(b)
                    SET r.confidence = $confidence, r.updated_at = datetime()
                """, a_id=new_skill.skill_id, b_id=existing.skill_id,
                    tenant_id=new_skill.tenant_id,
                    confidence=0.8)

            # 检查 REQUIRES 关系（来自 skill.md frontmatter dependencies）
            for dep_id in new_skill.dependencies:
                await self.neo4j.execute("""
                    MATCH (a:Skill {skill_id: $a_id})
                    MATCH (b:Skill {skill_id: $dep_id})
                    MERGE (a)-[:REQUIRES {tenant_id: $tenant_id}]->(b)
                """, a_id=new_skill.skill_id, dep_id=dep_id,
                    tenant_id=new_skill.tenant_id)

    def _is_composed_by(
        self, candidate: SkillRecord, existing: SkillRecord
    ) -> bool:
        """
        判断 candidate 是否是 existing 的组成部分：
        candidate 的 required_tools 是 existing 的 required_tools 的真子集
        """
        candidate_tools = set(candidate.required_tools)
        existing_tools = set(existing.required_tools)
        return (
            candidate_tools.issubset(existing_tools) and
            len(candidate_tools) < len(existing_tools) and
            len(candidate_tools) >= 1
        )

    def _is_extension_of(
        self, candidate: SkillRecord, existing: SkillRecord
    ) -> bool:
        """
        判断 candidate 是否扩展了 existing：
        existing 的 required_tools 是 candidate 的子集（candidate 包含更多工具）
        且两者的触发关键词有显著重叠（Jaccard ≥ 0.5）
        """
        existing_tools = set(existing.required_tools)
        candidate_tools = set(candidate.required_tools)
        if not existing_tools.issubset(candidate_tools):
            return False

        # 触发关键词重叠度
        kw_a = set(candidate.trigger_keywords)
        kw_b = set(existing.trigger_keywords)
        if not kw_a or not kw_b:
            return False
        jaccard = len(kw_a & kw_b) / len(kw_a | kw_b)
        return jaccard >= 0.5
```

---

## 7. 技能注入到 Agent Framework

### 7.1 注入时机与方式

Skill 在两个时机注入到 Agent：

| 时机 | 触发条件 | 注入内容 |
|---|---|---|
| **会话初始化** | Agent 创建新会话（`POST /sessions`） | 基于 agent 历史任务类型，预加载 Top-3 高概率触发的 Skill |
| **检索增强** | AMS 检索到高相关 Skill（score ≥ 0.7） | 在 Retrieval 结果中附带相关 skill.md 内容 |

### 7.2 技能检索 API

```
GET /skills/search?query=<任务描述>&agent_id=<agent_id>&top_k=5
Authorization: Bearer <token>

Response:
{
  "skills": [
    {
      "skill_id": "sk-a1b2c3d4",
      "skill_name": "SQL性能诊断与优化",
      "skill_version": "1.3.2",
      "confidence_score": 0.87,
      "success_rate": 0.91,
      "relevance_score": 0.94,        // 与当前查询的相关度
      "skill_md_url": "https://oss.internal/skills/tenant_abc/sk-a1b2c3d4.md",
      "skill_md_content": "...",       // skill.md 完整内容（< 5KB 直接内联）
      "required_tools": ["sql_query", "explain_plan", "index_advisor"]
    }
  ],
  "total": 1
}
```

### 7.3 Skill 在 Prompt 中的注入模板

```python
SKILL_INJECTION_TEMPLATE = """
## 可用技能（Skill）

以下是与当前任务高度相关的技能，请优先参考：

---
{skill_md_content}
---

**使用说明**：
- 按照技能的"执行步骤"顺序调用工具
- 如遇到"已知局限性"中描述的情况，及时告知用户
- 任务完成后，在 flush Span 中设置 `skill_used={skill_id}` 和 `skill_matched=True/False`
"""
```

---

## 8. Kafka 消息格式

### 8.1 `ams.skill.generate`（MPP → Skill-MDS）

当 MPP 写入 skill.md 到 Procedural Memory Tree 后，触发 Skill-MDS 注册流程：

```json
{
  "message_id": "msg-uuid",
  "schema_version": "1.0",
  "event_type": "skill.generate",
  "tenant_id": "tenant_abc",
  "skill_id": "sk-a1b2c3d4",             // 新技能的 ID（由 Skill-MDS 预分配）
  "skill_md_path": "oss://skills/...",   // skill.md 在 OSS 的路径
  "source_agent_id": "agent_001",
  "confidence_score": 0.83,
  "trigger_metadata": {
    "cluster_size": 12,
    "representative_frequency": 48,
    "backtest_success_rate": 0.88
  },
  "created_at": "2026-03-26T02:30:00Z"
}
```

### 8.2 `ams.skill.deprecated`（Skill-MDS → AMS Cache 失效）

```json
{
  "message_id": "msg-uuid",
  "schema_version": "1.0",
  "event_type": "skill.deprecated",
  "tenant_id": "tenant_abc",
  "skill_id": "sk-a1b2c3d4",
  "reason": "成功率下降 > 30%（自动降级）",
  "replacement_skill_id": "sk-x9y8z7w6",   // null 表示无替代
  "deprecated_at": "2026-03-26T10:15:00Z"
}
```

---

## 9. 部署配置

### 9.1 Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: skill-mds
  namespace: agent-memory
spec:
  replicas: 2
  selector:
    matchLabels:
      app: skill-mds
  template:
    metadata:
      labels:
        app: skill-mds
    spec:
      containers:
        - name: skill-mds
          image: registry.internal/skill-mds:latest
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          env:
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: kafka.brokers
            - name: NEO4J_URI
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: neo4j.uri
            - name: PG_DSN
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: postgres.dsn
            - name: CLICKHOUSE_URL
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: clickhouse.url
            - name: MILVUS_HOST
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: milvus.host
            - name: LLM_ENDPOINT
              valueFrom:
                configMapKeyRef:
                  name: ams-config
                  key: llm.endpoint
            - name: SKILL_MINING_SCHEDULE
              value: "0 2 * * *"         # 每日凌晨 2:00 UTC 挖掘
            - name: MIN_CLUSTER_SIZE
              value: "3"
            - name: DEGRADATION_THRESHOLD
              value: "0.15"
            - name: MIN_SAMPLE_FOR_DEPRECATION
              value: "20"

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: skill-mining-job
  namespace: agent-memory
spec:
  schedule: "0 2 * * *"    # 每日凌晨 2:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: skill-mining
              image: registry.internal/skill-mds:latest
              command: ["python", "-m", "skill_mds.mining.run_daily"]
              resources:
                requests:
                  cpu: "2"
                  memory: "4Gi"     # 挖掘任务内存需求较高（HDBSCAN）
                limits:
                  cpu: "4"
                  memory: "8Gi"
          restartPolicy: OnFailure
```

### 9.2 关键参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `MIN_CLUSTER_SIZE` | 3 | HDBSCAN 最小簇大小，低于此值视为噪声，不生成技能 |
| `DEGRADATION_THRESHOLD` | 0.15 | 成功率下降超过 15% 触发告警 |
| `MIN_SAMPLE_FOR_DEPRECATION` | 20 | 少于此使用次数不触发自动废弃 |
| `SANDBOX_PASS_SCORE` | 0.6 | Sandbox 测试通过的最低综合分 |
| `SKILL_BACKTEST_DAYS` | 7 | 历史回测数据范围（天）|
| `DUPLICATE_SIMILARITY_THRESHOLD` | 0.92 | 向量相似度超过此值判为重复技能，触发版本升级 |

---

## 10. Prometheus 指标

| 指标名 | 类型 | 标签 | 说明 |
|---|---|---|---|
| `skill_registry_total` | Gauge | tenant_id, status | 技能注册表中各状态的技能数 |
| `skill_usage_total` | Counter | skill_id, outcome, matched | 技能使用次数（按结果和匹配度）|
| `skill_mining_run_duration_seconds` | Histogram | agent_id | 单次挖掘任务耗时 |
| `skill_mining_candidates_total` | Counter | agent_id, status | 挖掘产出的候选技能数（通过/拒绝）|
| `skill_sandbox_score` | Histogram | — | Sandbox 测试得分分布 |
| `skill_cluster_count` | Gauge | agent_id | 本次挖掘识别的簇数 |
| `skill_degradation_alerts_total` | Counter | skill_id, suggested_action | 降级告警计数 |
| `skill_mesh_edges_total` | Gauge | tenant_id, edge_type | Skill Mesh 各类型边数量 |

---

## 11. 上下游数据契约

### 11.1 输入

| 来源 | 协议/方式 | 数据内容 |
|---|---|---|
| **Agent-TES (ClickHouse)** | SQL 查询 | `agent_task_summary`：工具链统计信号（只读）|
| **Agentic Memory (Neo4j)** | Cypher 查询 | Procedural Memory 图路径（只读）|
| **MPP (Kafka)** | `ams.skill.generate` | 新技能生成通知（skill.md 路径）|
| **Agent Framework (REST)** | `GET /skills/search` | 技能检索请求 |

### 11.2 输出

| 目标 | 协议/方式 | 数据内容 |
|---|---|---|
| **PostgreSQL** | SQL 写入 | `skill_registry`、`skill_usage_log` |
| **Milvus** | SDK 写入 | 技能嵌入向量（`skill_embeddings` Collection）|
| **Neo4j** | Cypher 写入 | Skill Mesh 节点和关系边 |
| **OSS** | HTTP PUT | `skill.md` 文件 |
| **Kafka** | `ams.skill.deprecated` | 技能废弃通知（触发 AMS Cache 失效）|
| **Agent Framework** | REST 响应 | 技能检索结果（含 skill.md 内联内容）|

---

*下一步：[06-Multi-Agent-Collaboration 详细设计](./06-Multi-Agent-Collaboration.md) — 多 Agent 记忆共享模型（Private / Shared / Hierarchical）、ACL 访问控制、分布式一致性保证*
