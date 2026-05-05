好，直接输出。

---

# Temporal-KG 边类型定义的方法论思考

> 版本：v2.0（扩展版，覆盖全部 A-E 五类边）
> 作者：AMS 架构设计者
> 日期：2026-04-09
> 关联文档：《AMS 语义记忆与情景记忆构建系统 — 完整方案设计》、《EntityNode 类型定义方法论思考 v1.1》、《EventNode 类型定义的方法论思考》、《BERT 或 GLiNER 替代实体关系抽取》

---

## 1. 引言：从"实体关系边"到"全图边类型体系"

在前两篇方法论文档中，我们分别梳理了 EntityNode（实体类型）和 EventNode（事件类型）的定义依据。本文档最初只聚焦于"实体关系边"（Category A），但 AMS 的 Temporal Knowledge Graph 实际包含 **5 大类、共 16 种边类型**，它们共同构成图谱的完整连接结构。

仅讨论实体关系边是不够的。原因是：

1. **5 类边服务于不同的记忆功能**——实体关系边支撑**语义记忆**，时序边支撑**情景记忆**，桥接边实现"前分后合"，溯源边保证**可审计性**，固化边支撑**主题知识**。只分析一类，无法看到完整的设计逻辑。
2. **5 类边的生成机制完全不同**——有的由 GLiNER-RelEx 抽取，有的由规则引擎构建，有的由时间戳自动推导，有的由离线聚类产生。选型约束的讨论必须覆盖全部类别。
3. **边之间存在协作关系**——例如 `PARTICIPATES_IN` 是 EntityNode 和 EventNode 之间的桥梁，`DERIVED_FROM` 是事件到原始数据的溯源链，它们与实体关系边共同构成检索路径。

因此，本文档将 v1.0 的"实体关系边"分析扩展为**完整的 Temporal-KG 边类型体系分析**。

### 1.1 完整边类型全景

| 类别    | 名称                | 连接                                                         | 边类型数 | 核心功能           |
| ----- | ----------------- | ---------------------------------------------------------- | ---- | -------------- |
| **A** | 实体关系边             | EntityNode ↔ EntityNode                                    | 6+1  | 语义记忆：事实知识表示    |
| **B** | 事件时序边             | EventNode → EventNode                                      | 1    | 情景记忆：时间线重建     |
| **C** | 参与与溯源边            | EntityNode → EventNode / EventNode → RawBlockRef           | 2    | 跨节点类型连接 + 数据溯源 |
| **D** | Session-Trace 桥接边 | EventNode → EventNode（跨来源）                                 | 3    | "前分后合"策略的粘合剂   |
| **E** | 语义固化边             | SemanticCluster → EventNode / EntityNode / SemanticCluster | 2+1  | 主题知识聚合         |

共计 **16 种边类型**（含 SYNONYM_OF 离线边和 SUBSUMES 可选边）。

### 1.2 五类边的方法论来源各不相同

这是本文档的核心发现：5 类边来自**完全不同的方法论传统和选型约束**，不能用统一的框架套用。

| 类别            | 方法论来源                           | 选型约束                       | 生成方式                    |
| ------------- | ------------------------------- | -------------------------- | ----------------------- |
| **A. 实体关系边**  | KG 关系类型形式化传统 + Agent 交互语义       | GLiNER-RelEx 封闭集 + LLM 开放集 | **三层混合抽取**（Layer 1/2/3） |
| **B. 事件时序边**  | Allen 时间逻辑 + 事件流建模              | 时间戳可靠性                     | **规则自动推导**              |
| **C. 参与与溯源边** | 数据溯源 (Data Provenance) + 语义角色标注 | 抽取阶段副产物                    | **抽取时自动生成**             |
| **D. 桥接边**    | 因果推理 + "前分后合"架构需求               | 启发式规则 + 时间窗口               | **规则引擎 + 语义匹配**         |
| **E. 语义固化边**  | 主题模型 + 层次聚类                     | 离线批处理                      | **聚类算法 + LLM 摘要**       |

下面逐类展开分析。

---

## 2. Category A：实体关系边（EntityNode ↔ EntityNode）

### 2.1 方法论基础

#### 2.1.1 关系类型的理论溯源

预定义的 6 种关系类型，在多个学科领域都能找到语义原型。但需要明确：**AMS 的方法论是工程驱动（交互语义驱动），不是本体论驱动。** 下面列出的参考来自不同学科，AMS 只是借用了它们各自对关系语义的共识性定义，作为选型时的语义原型参考，而非照搬任何一个体系。

| 参考来源 | 所属领域 | 核心思想 | 与本方案的对应 |
| --- | --- | --- | --- |
| **Schema.org** | Web 标准（SEO 结构化标记词汇表） | 用 `Action`、`CreativeWork`、`uses` 等有限谓词描述 Web 实体关系 | USES、PRODUCES 的语义原型 |
| **SUMO (Suggested Upper Merged Ontology)** | 知识工程（上层本体的一个具体实现） | 定义 `causes`、`uses`、`refers_to` 等最抽象的关系类型 | CAUSED_BY、MENTIONS 的语义原型 |
| **FrameNet** | 语言学（语义框架标注库） | 框架元素之间的 `Uses`、`Inheritance`、`Subframe` 关系 | USES、INVOKES 的语义原型 |
| **软件工程领域建模** | 软件工程 | `calls`、`imports`、`produces`、`depends_on` | INVOKES、PRODUCES 的直接来源 |

本方案的 6 种预定义类型，不是对任何一个传统的"领域特化"，而是**从多个领域各取了有共识的语义原型**，再以 Agent 交互场景做选型裁剪。

知识图谱领域对关系类型的分类有成熟的实践光谱，但它们是**参考坐标系，不是我们的方法论**：

| 方法论 | 代表 | 关系类型量级 | 特点 |
|---|---|---|---|
| **顶层本体 (Upper Ontology)** | SUMO, DOLCE | 数十种 | 高度抽象，领域无关 |
| **领域本体 (Domain Ontology)** | SNOMED-CT, Gene Ontology | 数百~数千种 | 领域专用，高覆盖 |
| **轻量级关系集** | ConceptNet (34种), Wikidata (~10K properties) | 数十~数万种 | 通用但有边界 |
| **开放信息抽取 (Open IE)** | ReVerb, OLLIE | 无限 | 以自然语言短语作为关系，不预定义 |

我在 AMS 中没有走上述任何一条路。与 EntityNode 类型定义的立场一致——**我们的方法论是交互语义驱动，不是本体论驱动**。上述传统只是告诉我 `causes`、`uses` 这些谓词有行业共识的语义定义，可以拿来用，但我不需要照搬它们的分类体系：

- 顶层本体太抽象，无法区分 Agent 交互中"调用工具"和"提到概念"的语义差异；
- 领域本体太重，Agent 的对话横跨多领域，不可能为每个领域维护专用关系集；
- Open IE 不预定义类型，与 GLiNER-RelEx 的封闭集分类能力直接矛盾。

#### 2.1.2 "交互语义驱动"的轻量关系集

与实体类型定义的方法论一致，我从 **Agent 的实际交互模式** 出发，提取高频、可区分、有检索价值的关系类型。具体遵循三个原则：

1. **功能性区分**：每种关系类型对应 Agent 交互中一种明确的语义角色关系（谁使用谁、谁产出谁、谁调用谁）。
2. **检索可操作性**：每种关系类型在检索时能作为有效的过滤条件（"查找用户使用过的所有工具" → 沿 `USES` 边遍历）。
3. **模型可分类性**：类型总数必须在 GLiNER-RelEx 的有效分类能力范围内。

如果说 EntityNode 的类型来自语义角色（"谁参与了交互"），那么关系边的类型则来自**谓词语义**（"参与者之间发生了什么关系"）。我对 Agent 会话和 Trace 的高频交互模式做了如下归纳：

| 交互模式 | 典型 utterance / trace     | 关系类型           | 语义角色对应                         |
| ---- | ------------------------ | -------------- | ------------------------------ |
| 功能依赖 | "我用 pandas 处理了 CSV"      | **USES**       | Agent/Tool → Resource          |
| 调用层级 | "先调 read_csv 再调 merge"   | **INVOKES**    | Tool → Tool                    |
| 输出产生 | "脚本生成了一张报表"              | **PRODUCES**   | Tool/Action → Resource         |
| 引用提及 | "你提到的那个 bug"             | **MENTIONS**   | any → any（弱关联）                 |
| 语义关联 | "pandas 和 polars 功能类似"   | **RELATES_TO** | any → any（catch-all）           |
| 因果触发 | "因为 OOM 所以改了 batch size" | **CAUSED_BY**  | Event/Problem → Event/Solution |

这 6 种关系覆盖了 Agent 交互中**最高频的谓词语义空间**。设计遵循两个原则：

1. **互斥优先级**：USES > INVOKES > PRODUCES > CAUSED_BY > MENTIONS > RELATES_TO（优先匹配语义更精确的类型）
2. **RELATES_TO 兜底**：所有无法明确归入前 5 类的关系，统一落入 RELATES_TO，确保不丢失信息

#### 2.1.3 与语义角色理论的关联

实体类型借鉴了 FrameNet 的 Frame Element 概念。关系边的方法论是这一思路的自然延伸：

- FrameNet 中，一个 Frame 内的多个 Element 之间存在结构化关系（Agent-Patient, Instrument-Result 等）；
- AMS 的关系边正是这些结构化关系在 Agent 交互场景中的投影：
  - `USES` ≈ Agent-Instrument（Agent 使用工具/资源）
  - `PRODUCES` ≈ Instrument-Result（工具产出产物）
  - `INVOKES` ≈ Agent-Action（Agent 触发动作）
  - `CAUSED_BY` ≈ Cause-Effect（因果关系）

#### 2.1.4 Graphiti 参考：时态关系边

Graphiti（getzep/graphiti）的核心创新之一是**时态关系边（Temporal Relation Edges）**，直接影响了本方案的关系边设计：

- **Graphiti 的边属性**：`fact_text`（自然语言描述）、`created_at` / `expired_at`（系统时间）、`valid_at` / `invalid_at`（业务时间）
- **Superseded_at 机制**：当新事实与旧事实冲突时，旧边不删除，标记 `expired_at = now`，新边携带 `valid_at = now`
- **本方案的继承**：我在关系边上保留了 `valid_at`、`invalid_at`、`superseded_at` 三个时态字段，加上 `fact_text` 和 `validity_reasoning`（来自 EverMemOS Foresight），构成完整的**双时态 + 前瞻**模型

Graphiti 的关系类型本身是开放的（LLM 生成任意 `relation_type` 字符串），但本方案做了**结构化收敛**——将高频关系收敛为 6 种预定义类型，低频关系保留 LLM 开放生成通道。这是对 Graphiti 的"有纪律的继承"。

#### 2.1.5 EverMemOS Foresight：前瞻推理

EverMemOS 的 Foresight 机制体现为关系边上的两个字段：
- `validity_reasoning`：LLM 生成的自然语言推理，说明为什么认为这条关系未来可能失效
- `invalid_at`：LLM 预测的失效时间点

这两个字段**只能由 LLM（Layer 3）生成**，GLiNER-RelEx 无法处理此类开放推理任务。这也是关系边必须保留 LLM 开放通道的核心原因之一。

### 2.2 选型约束："半开放集"架构

实体关系边呈现独特的**半开放集（Semi-Open Set）**模式，这是 AMS 三类类型体系中唯一真正保留了开放扩展通道的设计。

#### 2.2.1 GLiNER-RelEx (Layer 1) 的封闭集约束

GLiNER-RelEx（`knowledgator/gliner-relex-multi-v1.0`）的关系分类是**封闭集判别式分类**：

```python
relation_labels = ["USES", "INVOKES", "PRODUCES", "MENTIONS", "RELATES_TO", "CAUSED_BY"]
entities, relations = model.predict_entities_and_relations(
    block_text, entity_labels, relation_labels, threshold=threshold
)
```

- 模型只能从 `relation_labels` 中选择，无法发明新类型
- 分类性能随 label 数量增加而下降
- 6 种类型是 GLiNER-RelEx 的"舒适区"上限

#### 2.2.2 LLM (Layer 3) 的互补角色

LLM 在关系抽取中承担三个 GLiNER-RelEx 无法完成的任务：

1. **开放关系类型生成**：当两个实体之间的关系不属于预定义 6 种时，LLM 生成自由文本 `relation_type`
2. **fact_text 生成**：将关系三元组转化为可读的自然语言事实陈述，这是关系边被向量化并写入 Milvus 的语义载体
3. **Foresight 推理**：生成 `validity_reasoning` 和预测 `invalid_at`

#### 2.2.3 "半开放集"是约束和需求的均衡解

```
Layer 1 (GLiNER-RelEx)     Layer 3 (LLM)
┌───────────────────┐     ┌───────────────────┐
│ 封闭集分类:        │     │ 开放生成:          │
│ USES / INVOKES /  │     │ fact_text          │
│ PRODUCES /        │ ──→ │ validity_reasoning │
│ MENTIONS /        │     │ invalid_at         │
│ RELATES_TO /      │     │ 开放关系类型         │
│ CAUSED_BY         │     │                    │
└───────────────────┘     └───────────────────┘
   ~10-30ms, $0              ~1-2s, $
   高召回、粗分类              精修、补充、扩展
```

### 2.3 6+1 种关系类型定义

| 关系类型 | 语义 | 典型三元组 | 本体来源 | Agent 高频度 |
|---|---|---|---|---|
| **USES** | 功能依赖 | (用户, USES, pandas) | Schema.org `Action.instrument`、FrameNet `Using` | ★★★★★ |
| **INVOKES** | 调用层级 | (脚本A, INVOKES, 函数B) | 软件工程 `calls` / `imports` | ★★★★ |
| **PRODUCES** | 产出关系 | (pandas, PRODUCES, DataFrame) | SUMO `result`、Schema.org `Action.result` | ★★★ |
| **MENTIONS** | 引用提及 | (用户, MENTIONS, Kubernetes) | Dublin Core `references`、Schema.org `mentions` | ★★★★ |
| **RELATES_TO** | 泛化语义关联 | (React, RELATES_TO, Vue) | KG 通用 `related` / `seeAlso` | ★★★★★ |
| **CAUSED_BY** | 因果关系 | (内存溢出, CAUSED_BY, 数据量过大) | SUMO `causes`、Pearl 因果推理 | ★★★ |
| **SYNONYM_OF** | 同义等价（离线） | (pandas, SYNONYM_OF, pd) | 实体归一化基础设施 | N/A |

**语义强度梯度**（分类判定优先级从强到弱）：

```
强结构化                                              弱结构化
 ←──────────────────────────────────────────────────────→
INVOKES > PRODUCES > USES > CAUSED_BY > MENTIONS > RELATES_TO
(确定的调用链)  (确定的产出)  (功能依赖)  (因果判断)  (松散引用)  (兜底)
```

### 2.4 时态属性：双时态 + 前瞻

所有实体关系边携带时间有效性字段：

| 字段                             | 来源                  | 含义              | 生成层         |
| ------------------------------ | ------------------- | --------------- | ----------- |
| `created_at`                   | Graphiti            | 系统时间：三元组何时写入图谱  | 系统自动        |
| `expired_at` / `superseded_at` | Graphiti            | 系统时间：何时被新事实覆盖   | 冲突检测自动      |
| `valid_at`                     | Graphiti            | 业务时间：该事实从何时开始有效 | Layer 3 LLM |
| `invalid_at`                   | EverMemOS Foresight | 业务时间：该事实预计何时失效  | Layer 3 LLM |
| `validity_reasoning`           | EverMemOS Foresight | 失效推理            | Layer 3 LLM |
| `fact_text`                    | Graphiti            | 自然语言事实描述        | Layer 3 LLM |

superseded_at 冲突解决示例：

```
旧边: (user, USES, pandas, valid_at=2024-01, superseded_at=NULL)
新事实: "用户已经完全切换到 polars"

→ 旧边更新: superseded_at = 2024-03-15
→ 新边写入: (user, USES, polars, valid_at=2024-03-15)
→ 旧边不删除，仍可查询历史
```

### 2.5 与 Graphiti 的差异总结

| 维度 | Graphiti | AMS |
|---|---|---|
| **关系类型来源** | 纯 LLM 生成 (Open Set) | GLiNER-RelEx 预分类 + LLM 补充 (Half-Open) |
| **预定义类型** | 无 | 6 种 |
| **成本模型** | 每条边都需要 LLM 调用 | 预定义类型由 GLiNER-RelEx 覆盖，LLM 只处理 fact_text 和开放类型 |
| **Foresight** | 无 | 有（来自 EverMemOS：validity_reasoning + invalid_at） |
| **时间建模** | Bitemporal | Bitemporal + Foresight |

---

## 3. Category B：事件时序边（EventNode → EventNode）

### 3.1 方法论基础：Allen 时间逻辑与事件流

事件时序边只有一种类型：**`PRECEDES`**（A 在时序上先于 B）。这看似简单，实则是整个情景记忆回溯能力的基础。

#### 3.1.1 Allen 时间区间关系 (Allen's Interval Algebra)

James Allen 在 1983 年提出了 13 种时间区间关系（before, after, meets, overlaps, during, starts, finishes 等），是时间推理的经典理论框架。AMS 的 `PRECEDES` 对应其中最基本的 **`before`** 关系。

为什么只选 `before`（即 PRECEDES），而不是 Allen 的全部 13 种？

| 考虑因素 | 分析 |
|---|---|
| **Agent 事件的粒度** | Agent 会话中的事件（一次请求、一次工具调用）是**点事件或极短区间事件**，不是长时间区间。`overlaps`、`during` 等区间关系几乎不适用 |
| **存储效率** | 13 种关系需要精确的区间起止时间，Agent 事件通常只有一个时间戳（point-in-time），信息不足以支撑区间推理 |
| **检索场景** | 情景记忆的核心查询是"按时间顺序回放事件链"，只需要 `before/after` 关系 |

因此，**选择 PRECEDES 是 Allen 时间逻辑在点事件场景下的合理简化**。

#### 3.1.2 事件流建模 (Event Stream / Event Sourcing)

`PRECEDES` 链的另一个方法论来源是**事件溯源 (Event Sourcing)** 模式：

- 在 Event Sourcing 中，系统状态由一系列有序事件重建（event replay）
- AMS 的 `PRECEDES` 链实现了同样的能力：给定一个 session，沿 PRECEDES 链遍历，可以完整重建"那次会话中发生了什么"
- 这正是情景记忆的核心功能——**时间线重建**

#### 3.1.3 只持久化 PRECEDES，不持久化 FOLLOWS

设计文档明确指出：

> 只持久化 `PRECEDES`，`FOLLOWS` 为查询视角的派生关系，不重复写入，避免双写一致性问题。

这是图数据库设计的经典实践——**单向边 + 查询时反转**。在 Neo4j 中，查询 `FOLLOWS` 只需反向遍历 `PRECEDES`，无需额外存储。这避免了：
- 双写一致性风险（如果更新 PRECEDES 忘了更新 FOLLOWS）
- 存储冗余（边数翻倍）
- 维护成本（删除/修改时需要同步两条边）

### 3.2 选型约束：规则自动推导

PRECEDES 边**不需要任何模型抽取**，完全由规则自动推导：

```
构建规则：
  对于同一 session_id 下的两个 EventNode A 和 B，
  若 A.event_time < B.event_time，
  且 B 是 A 之后时间最近的事件，
  则创建 (A)-[:PRECEDES]->(B)
```

**选型约束分析**：

| 维度 | 分析 |
|---|---|
| **不需要 GLiNER/LLM** | 时序关系完全由时间戳决定，不涉及语义判断 |
| **不需要封闭/开放集讨论** | 只有一种类型（PRECEDES），无分类问题 |
| **核心依赖** | 时间戳的**准确性和完整性** |
| **生成阶段** | Stage 4（写入图谱时），在同一 session 内自动构建 |

这使得 PRECEDES 成为 5 类边中**实现最简单、可靠性最高**的一类。

### 3.3 风险：时间戳可靠性

PRECEDES 链的质量完全取决于时间戳。设计文档中已识别此风险（核心技术难点 10），并给出了分级策略：

| 时间戳置信度 | 处理策略 |
|---|---|
| 高 (>0.8) | 正常构建 PRECEDES 边 |
| 中 (0.5-0.8) | 构建 PRECEDES 边但标记 `confidence: 0.6`，检索时降级 |
| 低 (<0.5) | 不构建 PRECEDES 边，仅保留 `event_time` 字段 |
| 冲突（时间相同） | 按 `block_id` 字典序排序，或引入 `step_index` 作为二级排序键 |

**风险评级**：中等。时间戳在 Session 数据中通常可靠（服务端生成），但 Trace 数据中可能存在时钟漂移、异步回调等情况导致时间戳不准确。

---

## 4. Category C：参与与溯源边

Category C 包含两种边，分别服务于两个完全不同的目的：

| 边类型 | 连接 | 说明 |
|---|---|---|
| `PARTICIPATES_IN` | EntityNode → EventNode | 实体参与了某个事件，携带 `role` 字段 |
| `DERIVED_FROM` | EventNode → RawBlockRef | 事件溯源到原始 block（必填） |

### 4.1 PARTICIPATES_IN：语义角色标注的图谱投影

#### 4.1.1 方法论基础：语义角色标注 (Semantic Role Labeling, SRL)

`PARTICIPATES_IN` 的方法论来源是 **语义角色标注 (SRL)**——NLP 中判断"谁在事件中扮演什么角色"的经典任务。

SRL 的标准问题形式是：给定一个谓词（事件），识别它的各个论元（参与者）及其角色（Agent, Patient, Instrument, Location 等）。

在 AMS 中，`PARTICIPATES_IN` 正是 SRL 在图谱层面的投影：

| SRL 概念 | AMS 对应 |
|---|---|
| 谓词 (Predicate) | EventNode（一次事件） |
| 论元 (Argument) | EntityNode（参与者） |
| 角色标签 (Role Label) | `PARTICIPATES_IN` 边上的 `role` 字段 |

`role` 字段目前定义了三种值：

| role | 含义 | 示例 |
|---|---|---|
| `tool` | 作为工具参与事件 | pandas **PARTICIPATES_IN** (role=tool) "读取CSV数据"事件 |
| `subject` | 作为主语/发起者参与 | 用户 **PARTICIPATES_IN** (role=subject) "请求数据分析"事件 |
| `object` | 作为宾语/受事参与 | data.csv **PARTICIPATES_IN** (role=object) "读取CSV数据"事件 |

这三个角色是对 FrameNet/PropBank 中数十种细粒度角色的**极度简化**，理由与实体类型的"6 种即够"逻辑一致：

1. **GLiNER 的标注粒度**：GLiNER 在抽取实体时，已经标注了实体类型（TOOL/CONCEPT/RESOURCE/PERSON/ORG/ACTION）。`role` 字段可以从实体类型**规则推导**：
   - entity_type = TOOL → role = tool
   - entity_type = PERSON → role = subject
   - entity_type = RESOURCE → role = object
   - 其余类型 → role = object（默认）
2. **检索需求有限**：检索时主要查询"哪些实体参与了这个事件"或"这个实体参与了哪些事件"，role 只是辅助过滤条件，不需要太细的粒度。

#### 4.1.2 选型约束

`PARTICIPATES_IN` 是**抽取阶段的副产物**，不需要独立的模型：

```
抽取流程中的自然产出：

Layer 1 (GLiNER-RelEx) 抽出：
  实体: [pandas(TOOL), data.csv(RESOURCE), 用户(PERSON)]
  事件: "用户用 pandas 读取 data.csv"

→ 自动生成 PARTICIPATES_IN 边：
  (pandas) -[PARTICIPATES_IN {role: tool}]→ (event_读取)
  (data.csv) -[PARTICIPATES_IN {role: object}]→ (event_读取)
  (用户) -[PARTICIPATES_IN {role: subject}]→ (event_读取)
```

**关键认识**：PARTICIPATES_IN 不是独立抽取的——它是实体和事件抽取完成后的**结构化关联产物**。只要实体和事件抽取正确，PARTICIPATES_IN 就正确。因此，它的质量完全**继承自 Layer 1/Layer 3 的实体和事件抽取质量**。

#### 4.1.3 核心价值：跨节点类型的桥梁

`PARTICIPATES_IN` 是整个图谱中**唯一连接 EntityNode 和 EventNode 的结构化边**。没有它，实体和事件就是两个孤立的子图。

它的桥梁作用体现在：

1. **从实体出发找事件**：`(pandas)-[PARTICIPATES_IN]->(event)` → "pandas 参与过哪些事件？"
2. **从事件出发找实体**：`(event)<-[PARTICIPATES_IN]-(entity)` → "这个事件涉及哪些实体？"
3. **PPR 多跳检索的传播通道**：HippoRAG 的 Personalized PageRank 在图上传播时，PARTICIPATES_IN 是从实体入口节点到达事件节点的关键路径

设计文档中 PPR 检索的 `relationshipTypes` 配置：

```cypher
CALL gds.pageRank.stream('my_graph', {
  sourceNodes: [entry_node],
  relationshipTypes: ['PARTICIPATES_IN', 'PRECEDES', 'RELATES_TO'],
  ...
})
```

注意 `PARTICIPATES_IN` 是 PPR 传播的**三种边之一**，与 PRECEDES 和 RELATES_TO 并列。这说明它在检索中的地位与实体关系边同等重要。

### 4.2 DERIVED_FROM：数据溯源 (Data Provenance)

#### 4.2.1 方法论基础：W3C PROV 数据溯源模型

`DERIVED_FROM` 的方法论来源是 **W3C PROV (Provenance)** 标准——描述数据"从哪里来"的语义模型。

| W3C PROV 概念 | AMS 对应 |
|---|---|
| Entity（数据实体） | EventNode（从原始数据中抽取出的事件） |
| Activity（产生数据的活动） | 抽取流程（Stage 2 LLM 抽取） |
| Derivation（派生关系） | `DERIVED_FROM`（事件派生自原始 block） |

W3C PROV 定义了 `wasDerivedFrom` 关系，表示"一个实体是从另一个实体派生而来"。AMS 的 `DERIVED_FROM` 是这个概念的直接映射。

#### 4.2.2 选型约束

`DERIVED_FROM` 是**写入阶段的强制操作**，不需要任何模型：

```
Stage 4 写入规则：
  每个 EventNode 在写入 Neo4j 时，必须同时创建：
  (EventNode)-[:DERIVED_FROM]->(RawBlockRef)
  
  其中 RawBlockRef 的 block_id 来自抽取上下文（Stage 2 传递下来）
```

设计文档将 DERIVED_FROM 标记为**必填**（`DERIVED_FROM | EventNode → RawBlockRef | 事件溯源到原始 block（必填）`），这是数据治理的硬性要求——任何事件都必须可追溯到原始数据。

#### 4.2.3 核心价值：可审计性 + 情景细节回填

DERIVED_FROM 服务于两个关键场景：

1. **可审计性**：当检索结果被质疑时，可以沿 DERIVED_FROM 找到原始 block 文本，验证抽取是否正确
2. **情景细节回填**：检索时，先通过图谱找到相关 EventNode，再通过 DERIVED_FROM 拉取 RawBlockRef 的完整原文，为 Agent 提供详细上下文

设计文档中的检索路径明确展示了这一点：

```
查询: "用户上次提到的 pandas 问题是什么？"
→ 命中 EntityNode (pandas)
→ PPR 传播到相关 EventNode
→ 通过 DERIVED_FROM 边拉取 RawBlockRef（情景细节）
```

#### 4.2.4 与 PARTICIPATES_IN 的关系

PARTICIPATES_IN 和 DERIVED_FROM 共同构成了图谱中的**"结构性脚手架"**：

```
EntityNode ──PARTICIPATES_IN──→ EventNode ──DERIVED_FROM──→ RawBlockRef
  (语义)         (谁参与了什么)      (事件)       (事件来自哪里)      (原始数据)
```

这条链路是完整的**"从概念到事件到原文"的溯源路径**，是 AMS 区别于纯向量检索方案的核心结构优势。

### 4.3 Category C 的风险

| 风险 | 等级 | 说明 |
|---|---|---|
| PARTICIPATES_IN 的 role 分配不准 | 低 | 可从 entity_type 规则推导，不依赖模型 |
| DERIVED_FROM 缺失 | 低 | 写入时强制要求，代码层面可硬编码 |
| PARTICIPATES_IN 过多 | 中 | 如果一个事件抽出 10+ 个实体参与者，边数会膨胀。可考虑只保留 top-5 参与者 |

---

## 5. Category D：Session-Trace 桥接边（EventNode → EventNode，跨来源）

### 5.1 方法论基础：因果推理 + "前分后合"架构需求

#### 5.1.1 "前分后合"策略的产物

桥接边是 AMS "前分后合"（Session 和 Trace 分别处理、合并写入统一图谱）架构的**必然产物**。

设计文档中的关键描述：

> EntityNode 归一后天然跨族群——同一个实体 `pandas` 不管从哪条链路抽出，都指向同一个节点，是天然的粘合剂。但 EventNode 是一次性的，对话事件和执行事件之间的因果关系需要显式的边来表达。

这揭示了桥接边存在的根本原因：**EntityNode 天然融合，EventNode 天然隔离**。桥接边解决的是 EventNode 的跨来源连接问题。

#### 5.1.2 三种桥接边的因果语义

| 边类型 | 方向 | 因果语义 | 现实世界类比 |
|---|---|---|---|
| `REQUEST_LEADS_TO` | 对话事件 → 执行事件 | "用户的请求触发了工具调用" | 下单 → 发货 |
| `ATTEMPTS_TO_SOLVE` | 执行事件 → 对话事件 | "工具执行尝试解决用户的问题" | 治疗 → 治愈尝试 |
| `EVIDENCES` | 执行事件 → 对话事件 | "执行结果为对话结论提供证据" | 实验结果 → 论文结论 |

这三种边构成了一个**"请求-执行-反馈"的因果闭环**：

```
用户请求 (session)
    │
    ├── REQUEST_LEADS_TO ──→ 工具调用 (trace)
    │                            │
    │                            ├── ATTEMPTS_TO_SOLVE ──→ 用户问题 (session)
    │                            │
    │                            └── EVIDENCES ──→ 对话结论 (session)
    │
    └── 下一个请求...
```

#### 5.1.3 方法论参考：语用学中的"言语行为-后果"链

三种桥接边可以映射到语用学（Pragmatics）中的 **言语行为理论 (Speech Act Theory)**：

| Austin/Searle 概念 | AMS 桥接边 |
|---|---|
| Illocutionary act（言语行为：用户的请求意图） | 对话事件（user_request） |
| Perlocutionary act（言后行为：请求导致的实际行动） | REQUEST_LEADS_TO → 执行事件（tool_use） |
| Perlocutionary effect（言后效果：行动的结果反馈） | EVIDENCES / ATTEMPTS_TO_SOLVE → 对话事件（solution/problem） |

这不是刻意套用理论，而是说明：**桥接边的三种类型恰好覆盖了"意图 → 行动 → 反馈"这个基本的交互闭环**，无需更多、也不能更少。

### 5.2 选型约束：启发式规则引擎

桥接边**不由模型抽取**，而由**启发式规则引擎**在 Stage 4（写入图谱后）构建：

```
规则 1：时间邻近 + 语义相关（生成 REQUEST_LEADS_TO）
  若 Session Event（user_request）的时间戳与 Trace Event（tool_use）相差 < 30秒
  且 tool_use 的参与者与 request 中提到的实体有交集
  则创建 REQUEST_LEADS_TO 边

规则 2：执行结果反馈（生成 EVIDENCES / ATTEMPTS_TO_SOLVE）
  若 tool_result 的状态与后续的 Session Event（solution/problem）语义匹配
  则创建 EVIDENCES 或 ATTEMPTS_TO_SOLVE 边
```

**为什么用规则而非模型？**

| 考虑 | 分析 |
|---|---|
| **语义明确** | 桥接边的判定依据（时间邻近 + 实体交集）是结构化条件，不需要语义理解 |
| **跨 block 推理** | 桥接边连接的是来自不同 block 的事件，GLiNER-RelEx 只能在单 block 内工作 |
| **低频操作** | 桥接边只在同一 session 中 Session + Trace 数据都到齐后才构建，频率远低于实体关系边 |
| **可调试性** | 规则引擎的逻辑透明，容易调试和调参（如调整时间窗口阈值） |

**关键区分**：桥接边的 3 种类型不是分类问题（不是从候选中选一种），而是**条件触发问题**（满足哪个规则就生成哪种边）。因此不需要 GLiNER-RelEx 这样的分类器。

### 5.3 风险分析

#### 5.3.1 启发式规则的精度（最高风险）

**问题**：规则 1 的"30 秒时间窗口 + 实体交集"可能产生误判：
- **假阳性**：两个无关的事件恰好时间接近且共享一个常见实体（如 `python`），被错误连接
- **假阴性**：用户请求和工具调用之间有 >30 秒的延迟（如 LLM 思考时间），导致真实的因果关系被遗漏

**缓解策略**：
1. 桥接边携带 `confidence` 字段，低于阈值的桥接边在检索时降级处理
2. 时间窗口参数应可配置，根据实际数据分布调优
3. 设计文档已明确："桥接边的 confidence 低于直接抽取的边（如 PRECEDES），在检索时作为弱证据使用"

#### 5.3.2 ATTEMPTS_TO_SOLVE vs EVIDENCES 的边界

**问题**：规则 2 中，如何区分"尝试解决"和"提供证据"？

- `ATTEMPTS_TO_SOLVE`：强调**过程**——执行事件试图解决问题（不一定成功）
- `EVIDENCES`：强调**结果**——执行结果支撑了某个结论（已确认）

**判定建议**：
- 如果后续的 Session Event 是 `solution` 类型 → EVIDENCES
- 如果后续的 Session Event 是 `problem` 类型（即尝试失败，问题仍在） → ATTEMPTS_TO_SOLVE
- 如果后续无明确分类 → 默认 ATTEMPTS_TO_SOLVE（较保守）

#### 5.3.3 Session 和 Trace 数据不齐的情况

**问题**：如果一个 session 只有 Session 数据没有 Trace 数据（或反之），桥接边无法生成。

**影响**：不影响图谱基础结构。对话事件和执行事件各自通过 PRECEDES 链保持内部连续性，只是跨来源的因果连接缺失。检索时退化为单来源的情景记忆，质量下降但不至于出错。

---

## 6. Category E：语义固化边（SemanticCluster 相关）

### 6.1 方法论基础：主题模型 + 层次聚类

#### 6.1.1 SemanticCluster 的定位

SemanticCluster 对应 EverMemOS 中的 **MemScene** 概念——对多个事件做主题聚类后生成的语义摘要节点。它是从情景记忆（EventNode）到语义记忆的**升华层**。

语义固化边将 SemanticCluster 与图谱中的其他节点连接起来：

| 边类型 | 连接 | 说明 |
|---|---|---|
| `AGGREGATES` | SemanticCluster → EventNode | Cluster 聚合了哪些事件 |
| `REPRESENTS` | SemanticCluster → EntityNode | Cluster 代表的核心实体/主题 |
| `SUBSUMES` (可选) | SemanticCluster → SemanticCluster | Cluster 之间的层级关系 |

#### 6.1.2 AGGREGATES：集合成员关系

`AGGREGATES` 表示"这个主题聚类包含了哪些事件"。方法论来源是**集合论中的成员关系 (membership)**——SemanticCluster 是一个集合，EventNode 是它的元素。

在主题模型 (Topic Modeling) 的语境中，AGGREGATES 类似于"文档属于主题"的分配关系，只不过这里的"文档"是事件，"主题"是语义聚类。

#### 6.1.3 REPRESENTS：主题-实体关联

`REPRESENTS` 表示"这个主题聚类与哪些核心实体相关"。这类似于主题模型中的**"主题关键词"**——每个主题有一组代表性词汇，每个 SemanticCluster 有一组代表性实体。

例如：

```
SemanticCluster {theme: "pandas 数据文件读写问题排查"}
  -[REPRESENTS]→ EntityNode {name: "pandas", type: TOOL}
  -[REPRESENTS]→ EntityNode {name: "read_csv", type: ACTION}
  -[REPRESENTS]→ EntityNode {name: "CSV", type: CONCEPT}
```

#### 6.1.4 SUBSUMES：层级聚类

`SUBSUMES` 表示一个 Cluster 是另一个 Cluster 的上位概念，对应**层次聚类 (Hierarchical Clustering)** 中的树形结构：

```
SemanticCluster {theme: "数据读取问题"}
  -[SUBSUMES]→ SemanticCluster {theme: "pandas CSV 类型识别"}
  -[SUBSUMES]→ SemanticCluster {theme: "pandas Excel 日期解析"}
```

设计文档将 SUBSUMES 标记为**可选**，说明第一阶段可以只做 flat clustering（HDBSCAN），不做层级关系。待数据积累后，再考虑构建层级。

### 6.2 选型约束：离线批处理

语义固化边的生成完全是**离线**的，与实时抽取管线无关：

| 维度 | 分析 |
|---|---|
| **触发条件** | 新增 EventNode 超过阈值 / 定时触发 / 手动触发 |
| **构建算法** | HDBSCAN 聚类 + LLM 生成主题摘要 |
| **GLiNER/BERT** | 不参与——聚类基于 EventNode 的 embedding 向量，不基于文本分类 |
| **LLM 角色** | 为每个聚类生成 `theme` 和 `summary`，不参与边类型判定 |

```python
# 构建流程示意
def build_semantic_clusters(tenant_id: str):
    events = fetch_unclustered_events(tenant_id, limit=1000)
    event_embeddings = [embed(e.summary + e.participants) for e in events]
    clusters = hdbscan_cluster(event_embeddings, min_cluster_size=3)
    
    for cluster_events in clusters:
        cluster_node = create_cluster_node(
            theme=llm_generate_theme(cluster_events),
            summary=llm_generate_summary(cluster_events)
        )
        # 生成 AGGREGATES 边
        for event in cluster_events:
            create_aggregates_edge(cluster_node, event)
        # 生成 REPRESENTS 边（通过统计 cluster 内事件的高频参与者实体）
        top_entities = get_top_entities(cluster_events, top_k=5)
        for entity in top_entities:
            create_represents_edge(cluster_node, entity)
```

**关键认识**：AGGREGATES 和 REPRESENTS 的类型判定不是分类问题，而是**聚类结果的结构化表达**。AGGREGATES 由聚类算法直接产出（事件被分到哪个 cluster），REPRESENTS 由统计方法产出（cluster 内高频实体）。

### 6.3 风险分析

| 风险 | 等级 | 说明 |
|---|---|---|
| 聚类质量差 | 中 | HDBSCAN 的 `min_cluster_size` 等超参需要调优；embedding 质量直接影响聚类效果 |
| REPRESENTS 选取不准 | 低 | 基于频率统计的 top-k 实体选取，逻辑简单，误差有限 |
| SUBSUMES 构建时机过早 | 低 | 已标记为可选，第一阶段不实现 |
| Cluster 过于碎片化 | 中 | 如果 `min_cluster_size` 设太小，会产生大量只有 3-5 个事件的小 cluster，检索时噪声大 |

---

## 7. 全局视角：五类边的协作关系

### 7.1 检索路径中的边类型协作

一次典型的检索查询会**跨越多类边**：

```
Query: "用户上次遇到 pandas 问题是怎么解决的？"

Step 1: 向量检索 → 命中 EntityNode (pandas)                    [入口]
Step 2: (pandas)-[PARTICIPATES_IN]→(EventNode: problem)         [C类：参与边]
Step 3: (problem)-[PRECEDES*]→(EventNode: solution)             [B类：时序边]
Step 4: (problem)←[ATTEMPTS_TO_SOLVE]-(EventNode: tool_use)     [D类：桥接边]
Step 5: (tool_use)-[DERIVED_FROM]→(RawBlockRef)                 [C类：溯源边]
Step 6: (pandas)-[USES]→(read_csv)                              [A类：实体关系边]
Step 7: (problem)-[AGGREGATES]←(SemanticCluster: "数据读取问题")  [E类：固化边]
```

**结论**：五类边不是孤立的，而是在检索过程中形成**协作链路**。每类边缺失都会导致特定检索能力的退化。

### 7.2 五类边的生成时序

```
时间轴 →

Stage 2 (抽取)          Stage 4 (写入)          Stage 7 (桥接)      离线批处理
├─ 实体/事件抽取       ├─ A: 实体关系边写入    ├─ D: 桥接边构建     ├─ E: 语义固化边
│  └─ C: PARTICIPATES  ├─ B: PRECEDES 构建    │                    │
│      _IN 同步生成     ├─ C: DERIVED_FROM     │                    │
│                       │     强制写入          │                    │
```

注意生成时序的差异：
- **C 类最早**：PARTICIPATES_IN 在抽取阶段就产生
- **A/B/C(DERIVED_FROM) 同步**：在 Stage 4 写入时一起完成
- **D 类延迟**：需要等 Session + Trace 数据都到齐后才构建
- **E 类最晚**：离线批处理，可能延迟数小时到数天

### 7.3 五类边的属性丰富度对比

| 类别 | 边类型数 | 携带属性 | 时态字段 | 生成成本 |
|---|---|---|---|---|
| **A. 实体关系边** | 6+1 | fact_text, confidence, validity_reasoning, valid_at, invalid_at, superseded_at | ✅ 完整双时态+前瞻 | 高（GLiNER-RelEx + LLM） |
| **B. 事件时序边** | 1 | confidence | ❌ 无（本身就是时间关系） | 低（规则推导） |
| **C. 参与与溯源边** | 2 | role（仅 PARTICIPATES_IN） | ❌ 无 | 低（抽取副产物 + 强制写入） |
| **D. 桥接边** | 3 | confidence | ❌ 无 | 中（规则引擎 + 语义匹配） |
| **E. 语义固化边** | 2+1 | 无额外属性 | ❌ 无 | 中（聚类 + LLM 摘要） |

**观察**：只有 Category A（实体关系边）携带完整的时态属性。这是因为**只有事实知识才有"过期"的概念**——时序关系（B）、参与关系（C）、因果关系（D）、聚合关系（E）一旦成立就不会"过期"（它们描述的是发生过的事实，不是当前状态）。

---

## 8. 整体选型约束总结

### 8.1 五类边的封闭/开放模式

| 类别 | 封闭/开放 | 原因 |
|---|---|---|
| **A. 实体关系边** | **半开放集** | 预定义 6 种（GLiNER-RelEx 封闭分类）+ LLM 可输出开放类型 |
| **B. 事件时序边** | **固定单一** | 只有 PRECEDES，无分类问题 |
| **C. 参与与溯源边** | **固定双种** | PARTICIPATES_IN + DERIVED_FROM，无分类问题 |
| **D. 桥接边** | **固定三种** | 规则触发，每种规则对应一种边类型 |
| **E. 语义固化边** | **固定三种** | 聚类结果的结构化表达，无分类问题 |

**核心发现**：只有 Category A 涉及"类型分类"问题，因此只有 Category A 受到 GLiNER-RelEx 的封闭集约束。B-E 四类边的类型都是**固定的、由生成规则决定的**，不需要模型分类。

### 8.2 五类边与三层抽取架构的关系

```
三层混合抽取架构：

Layer 1 (GLiNER-RelEx)  → 生成 A 类边（封闭集关系分类）
                         → 辅助生成 C 类边（PARTICIPATES_IN，从抽取结果推导）

Layer 2 (规则引擎)      → 生成 B 类边（PRECEDES，时间戳排序）
                         → 生成 D 类边（桥接边，启发式规则）
                         → 辅助 C 类边（role 推导规则）

Layer 3 (LLM)           → 补充 A 类边（开放关系类型 + fact_text + Foresight）
                         → E 类边的 LLM 部分（主题摘要生成，但不参与边类型判定）

写入时自动              → C 类边的 DERIVED_FROM（必填，硬编码逻辑）

离线批处理              → E 类边（聚类算法 + LLM 摘要）
```

---

## 9. 风险总览与改进建议

### 9.1 按优先级排序的风险

| 优先级 | 风险 | 类别 | 影响 |
|---|---|---|---|
| **P0** | RELATES_TO 膨胀，实体关系边退化为无类型图 | A | 语义记忆检索精度全面下降 |
| **P1** | 桥接边启发式规则精度不足 | D | "前分后合"的核心价值受损 |
| **P1** | GLiNER-RelEx 在 Agent 领域数据上表现未验证 | A | 整个 Layer 1 的 ROI 不确定 |
| **P2** | PRECEDES 链因时间戳不准而断裂 | B | 情景记忆时间线重建失败 |
| **P2** | PARTICIPATES_IN 过多导致边膨胀 | C | 图谱存储和检索性能下降 |
| **P2** | CAUSED_BY 因果推断准确性低 | A | 问题诊断和经验复用能力受限 |
| **P3** | 聚类质量差导致 SemanticCluster 碎片化 | E | 主题检索噪声大 |
| **P3** | MENTIONS vs RELATES_TO 边界模糊 | A | 检索过滤精度下降，但不影响连通性 |
| **P3** | Layer 1 → Layer 3 关系类型一致性 | A | 图谱中出现冗余边 |

### 9.2 改进建议

#### 短期（原型阶段）

1. **GLiNER-RelEx 基线实验**：收集 50-100 段标注数据，对比 GLiNER-RelEx vs 纯 LLM 的关系分类 F1。优先验证 A 类边的可行性。

2. **RELATES_TO 比例监控**：在写入图谱时实时统计各关系类型比例。设置告警：`RELATES_TO > 40%` 触发人工审查。

3. **桥接边时间窗口参数化**：将 30 秒的时间窗口设为可配置参数，根据实际数据分布调优。

4. **PARTICIPATES_IN 的 top-k 限制**：每个事件的参与者实体上限设为 5-8 个，防止边膨胀。

#### 中期（上线运营后）

5. **开放类型"提升"机制**：收集 LLM Layer 3 输出的开放关系类型，频率 > 5% 时评估是否提升为预定义类型。

6. **CAUSED_BY 专项评估**：如果 GLiNER-RelEx 对 CAUSED_BY 的召回率 < 50%，考虑将其从 Layer 1 移除，完全由 LLM Layer 3 负责。

7. **桥接边构建规则扩展**：当前只有 2 条规则，随着数据积累，可以增加更精细的规则（如基于事件类型组合的模式匹配）。

#### 长期（体系演化）

8. **关系类型层级化**：当预定义类型增长到 10+ 种时，引入层级结构：
   ```
   FUNCTIONAL (功能关系)
     ├── USES
     ├── INVOKES
     └── PRODUCES
   REFERENTIAL (引用关系)
     ├── MENTIONS
     └── RELATES_TO
   CAUSAL (因果关系)
     └── CAUSED_BY
   ```

9. **SUBSUMES 边启用**：当 SemanticCluster 数量积累到足够多时，启用层次聚类，构建 cluster 间的层级关系。

---

## 10. 总结

### 10.1 五类边的设计哲学

AMS Temporal-KG 的 16 种边类型看似复杂，但背后遵循一个清晰的设计哲学：

> **工程驱动，理论可溯源，但不被理论绑架。**

我们的设计是工程实践——怎么有效怎么来，首要目标是实现可用的系统。背后的理论（哲学的、知识工程的、语言学的、NLP 的、知识图谱的）提供语义原型和设计参考，但不作为方法论的约束。需要时能回去查，日常不背着它走。

```
每类边回答一个核心问题：

A. 实体关系边：  "两个实体之间是什么关系？"     → 语义记忆
B. 事件时序边：  "事件之间的时间顺序是什么？"   → 情景记忆（时间线）
C. 参与与溯源边："谁参与了什么？数据从哪来？"   → 跨类型桥梁 + 可审计
D. 桥接边：      "对话和执行之间有什么因果？"   → "前分后合"融合
E. 语义固化边：  "哪些事件构成一个主题？"       → 主题知识聚合
```

### 10.2 三个维度的设计差异

| 维度 | A (实体关系) | B (时序) | C (参与/溯源) | D (桥接) | E (固化) |
|---|---|---|---|---|---|
| **方法论** | KG 关系类型形式化传统 + 交互语义 | Allen 时间逻辑 | SRL + W3C PROV | 因果推理 + 语用学 | 主题模型 + 层次聚类 |
| **生成方式** | GLiNER-RelEx + LLM | 规则推导 | 抽取副产物 + 强制写入 | 启发式规则 | 离线聚类 + LLM |
| **封闭度** | 半开放 | 固定 | 固定 | 固定 | 固定 |

### 10.3 与实体/事件类型体系的封闭度光谱

将边类型体系纳入后，AMS 的完整"封闭度光谱"变为：

```
硬封闭 ───── 软封闭 ───── 半开放 ───── 固定（无分类问题）
EntityNode    EventNode    A类边        B/C/D/E类边
(GLiNER)      (BERT+LLM)  (RelEx+LLM)  (规则/聚类/强制)
```

**核心洞察**：只有涉及"从文本中判断语义类型"的场景才面临封闭/开放的抉择（EntityNode、EventNode、A 类边）。其余边的类型由**生成规则天然决定**，不存在分类问题，因此不受 GLiNER/BERT 的能力约束。这也解释了为什么设计文档中 B-E 类边的定义如此简洁——它们不需要类型设计的方法论讨论，因为类型就是规则的直接映射。

---

*本文档基于 AMS 完整方案设计文档 v1.0（第 3.2 节完整边类型目录、第 7.4 节桥接边构建、第 9 章语义固化、第 10 章检索策略、第 12 章容量估算）、GLiNER/BERT 替代抽取参考文档、Graphiti 源码分析、EverMemOS Foresight 机制分析、W3C PROV 数据溯源标准、Allen 时间逻辑综合整理。*

---

以上就是完整的 v2.0 扩展版。核心变化：

1. **标题和范围**：从"实体关系边"扩展为"Temporal-KG 全部边类型"
2. **新增 4 个 Category**：B（事件时序边）、C（参与与溯源边）、D（桥接边）、E（语义固化边），每个都有方法论依据和选型约束分析
3. **新增全局视角**（第 7 章）：五类边的协作关系、生成时序、属性对比
4. **新增整体选型约束总结**（第 8 章）：五类边与三层抽取架构的完整映射
5. **风险总览**按优先级排序，改进建议覆盖全部五类