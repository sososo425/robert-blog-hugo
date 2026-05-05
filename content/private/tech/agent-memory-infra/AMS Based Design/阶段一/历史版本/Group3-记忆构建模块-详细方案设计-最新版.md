---
title: Group3 记忆构建模块 - 详细方案设计（最新版）
date: 2026-04-01
tags:
  - AMS
  - Group3
  - 记忆构建
  - TemporalKG
  - LLM-Prompt-First
status: 草稿
---

> [!info] 文档定位
> 本文档基于评审版重写，核心改动：
> 1. **抽取层从"规则优先"改为"LLM Prompt 优先"**，借鉴 Graphiti prompt 工程模式
> 2. 精简冗余论证，聚焦可落地的工程设计
> 3. 保留原方案中合理的架构决策（双链路、Temporal KG、最小 EventNode 等）

> [!warning] 对评审版的主要批评
> 评审版存在以下问题：
> 1. **"规则优先"抽取策略不适合原型阶段**：规则词典/正则/白名单需要大量人工维护，覆盖面窄，且对开放域对话表现差；原型阶段反而应该用 LLM prompt 快速验证效果，后期再用规则做优化
> 2. **论证篇幅过重，可执行内容过少**：第2章"为什么需要知识图谱"占了全文近 1/3，但这些论证在大纲文档中已经充分阐述，详细方案应聚焦 How 而非 Why
> 3. **Prompt 设计完全缺失**：作为抽取 pipeline 的核心，方案中没有给出任何 prompt 模板或设计思路
> 4. **抽取质量保障机制不足**：缺少结构化输出约束、去重策略、冲突检测等关键环节

---

## 目录

1. [设计目标与边界](#1-设计目标与边界)
2. [总体架构与处理流程](#2-总体架构与处理流程)
3. [Stage 0-1：输入适配与 Raw Block 生成](#3-stage-0-1输入适配与-raw-block-生成)
4. [Stage 2：LLM-Driven 抽取 Pipeline（核心）](#4-stage-2llm-driven-抽取-pipeline核心)
5. [Stage 3：实体去重与链接](#5-stage-3实体去重与链接)
6. [Stage 4：Temporal KG 写入](#6-stage-4temporal-kg-写入)
7. [数据存储设计（原型版）](#7-数据存储设计原型版)
8. [本地验证与评估](#8-本地验证与评估)
9. [开发排期与交付物](#9-开发排期与交付物)
10. [风险与后续演进](#10-风险与后续演进)

---

## 1. 设计目标与边界

### 1.1 核心目标

从用户会话和 Agent Trace 中提取结构化记忆，构建最小时序知识图谱（Temporal KG），验证"跨轮次、跨会话回忆"的技术可行性。

### 1.2 本期能力矩阵

| 级别 | 能力 | 说明 |
|------|------|------|
| P0 | Session 归并 + Raw Block 生成 | 对齐 TL 的 `Raw Block Schema v0.1` |
| P0 | LLM-Driven 实体抽取 | 基于 prompt 从 block 中抽取实体，输出结构化 JSON |
| P0 | LLM-Driven 事件抽取 | 抽取最小事件结构（触发词、参与者、时间） |
| P0 | LLM-Driven 关系/事实抽取 | 抽取带时间有效性的事实三元组 |
| P0 | Neo4j 写入 | 将实体、事件、关系写入图数据库 |
| P1 | LLM-Driven 实体去重 | 借鉴 Graphiti 的 candidate-ID 模式做跨会话实体消歧 |
| P1 | 本地验证接口 | 实体查询、时间线查询、1-2 跳路径 |
| P2 | Milvus 向量辅助召回 | 为实体去重提供候选集 |
| P2 | 遗忘机制 | 先保留字段，不做自动化 |

### 1.3 本期明确不做

- 完整检索层服务化
- Graph RAG / 多跳推理 / 社区发现
- 自动因果链修复与全局一致性修复
- 全局统一图谱（文档+会话+代码）
- 生产级多租户与权限治理

### 1.4 与评审版的关键差异

| 维度 | 评审版 | 本版 |
|------|--------|------|
| 抽取策略 | 规则优先 + 轻量模型补充 + LLM 精修 | **LLM Prompt 优先**，规则仅用于后处理归一化 |
| Prompt 设计 | 无 | **提供完整 prompt 模板与结构化输出 schema** |
| 去重机制 | 名称规范化 + 规则匹配 | **LLM candidate-ID 模式**（借鉴 Graphiti） |
| 边/事实建模 | 静态关系集合 | **带 valid_at/invalid_at 的时序事实** |
| 文档结构 | 大量论证章节 | **聚焦可执行的工程设计** |

---

## 2. 总体架构与处理流程

### 2.1 Pipeline 总览

```
Session / Trace
  ┌─────────────────────────────────┐
  │ Stage 0-1: 输入适配 + Raw Block │
  └──────────────┬──────────────────┘
                 ▼
  ┌─────────────────────────────────┐
  │ Stage 2: LLM-Driven 抽取       │
  │  ├─ 2a. Entity Extraction      │
  │  ├─ 2b. Event Extraction       │
  │  └─ 2c. Edge/Fact Extraction   │
  └──────────────┬──────────────────┘
                 ▼
  ┌─────────────────────────────────┐
  │ Stage 3: 实体去重与链接         │
  │  ├─ 3a. LLM Node Dedup        │
  │  └─ 3b. 名称归一化(后处理)     │
  └──────────────┬──────────────────┘
                 ▼
  ┌─────────────────────────────────┐
  │ Stage 4: Temporal KG 写入      │
  │  ├─ Neo4j 图谱写入             │
  │  └─ Milvus 向量写入(可选)      │
  └──────────────┬──────────────────┘
                 ▼
  ┌─────────────────────────────────┐
  │ 本地验证查询                    │
  └─────────────────────────────────┘
```

### 2.2 Session 与 Trace 双链路策略

沿用评审版的"前分后合"策略，这一点设计合理：
- **前半段分离处理**：Session（对话语义）和 Trace（执行日志）各自归一化、生成 Raw Block
- **后半段统一抽取**：两类 Block 进入同一套 LLM 抽取 pipeline，通过 `source_type` 字段区分
- **图谱层融合**：写入同一个 Temporal KG，通过桥接边连接

### 2.3 为什么原型阶段应该用 LLM Prompt 而不是规则

| 维度 | 规则优先 | LLM Prompt 优先 |
|------|----------|-----------------|
| 开发速度 | 需要逐条编写规则/词典，维护成本高 | 写好 prompt 即可快速覆盖多种场景 |
| 覆盖面 | 只能处理预设模式 | 对开放域对话天然适配 |
| 迭代效率 | 改规则→测试→补规则 循环慢 | 改 prompt→测试 循环快 |
| 质量上限 | 受限于规则完备性 | 受限于 LLM 能力，但上限更高 |
| 成本 | 推理成本低 | 推理成本较高，但原型阶段数据量小可接受 |
| 可解释性 | 强 | 通过结构化输出 + 溯源可保证 |
| 适合阶段 | **生产优化阶段**（用规则替代高频 LLM 调用） | **原型验证阶段** |

> [!tip] 核心观点
> 原型阶段的首要目标是**验证"能否抽出有意义的记忆"**，而不是"能否用最低成本抽取"。LLM prompt 是验证效果最快的方式；规则优化是后续降本增效的手段。

---

## 3. Stage 0-1：输入适配与 Raw Block 生成

### 3.1 输入适配（Stage 0）

将不同来源的数据适配为统一输入结构。

**输入来源**：
- 原始 session 消息流（JSONL）
- 原始 trace 日志（JSONL）
- Group 1 归档数据（可选联调）
- 公开数据集（CrossWOZ / ToolBench 等，开发阶段）

**输出**：`NormalizedSession` / `NormalizedTrace`

**处理要点**：
- 缺失字段允许 `null`，但必须保留 `tenant_id`、`timestamp`、`source_uri`
- Session 链路：识别 speaker、turn 边界、对话时间戳
- Trace 链路：归一化 tool/action/status/latency 字段

### 3.2 Session 归并与切分

**切分信号**（优先级从高到低）：
1. 显式切换："换个话题""重新开始"
2. 时间间隔：超过 5-10 分钟
3. 任务意图变化：如从"报错排查"转到"数据分析"
4. 对话结束信号："谢谢""先这样"

### 3.3 Raw Block 生成（Stage 1）

每个 turn 或 trace step 生成一个 Raw Block，对齐 TL 统一的 `Raw Block Schema v0.1`。

**Session Block 示例**：
```json
{
  "block_id": "blk_acmecorp_01JQ7M4YF3K9...",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "user: 昨天我用 pandas 处理了一个 CSV，今天想继续把 Excel 也读进来。",
  "metadata": {
    "timestamp": 1774922400,
    "source_uri": "session://sess_acmecorp_01.../turn/3",
    "session_id": "sess_acmecorp_01...",
    "turn_index": 3,
    "speaker": "user"
  }
}
```

**Trace Block 示例**：
```json
{
  "block_id": "blk_acmecorp_01JQ7M8D7E9...",
  "tenant_id": "acmecorp",
  "source_type": "agent_trace",
  "content": "tool=python_executor; action=read_excel; status=success; latency_ms=420",
  "metadata": {
    "timestamp": 1774922520,
    "source_uri": "trace://sess_acmecorp_01.../step/8",
    "session_id": "sess_acmecorp_01...",
    "step_index": 8,
    "tool_name": "python_executor"
  }
}
```

> [!note]
> 原型阶段 `embedding` 和 `triples` 字段不在 Block 生成阶段填充，而是由后续 Stage 2 的 LLM 抽取 pipeline 产出。

---

## 4. Stage 2：LLM-Driven 抽取 Pipeline（核心）

### 4.1 设计思路

借鉴 Graphiti 的 prompt 工程模式，把抽取拆分为三个独立的 LLM 调用：

```
Raw Block
  → Prompt 2a: 实体抽取 (Entity Extraction)
  → Prompt 2b: 事件抽取 (Event Extraction)
  → Prompt 2c: 关系/事实抽取 (Edge/Fact Extraction)
```

每个 prompt 都有：
1. **结构化输出 schema**（Pydantic 模型）—— 确保 LLM 输出可直接解析
2. **明确的排除规则**（什么不应该抽取）—— 减少噪声
3. **输入格式适配**（session 对话 vs trace 日志格式不同）
4. **source_block_id 溯源**（每个抽取结果都挂载来源 block）

### 4.2 Prompt 2a：实体抽取

#### 输出 Schema

```python
class ExtractedEntity(BaseModel):
    name: str                  # 实体名称，使用最完整的形式
    entity_type: str           # 见下方类型列表
    aliases: list[str]         # 别名/同义表达，如 ["pd", "Pandas"]
    source_block_id: str       # 来源 block ID
    confidence: float          # 0.0-1.0

class ExtractedEntities(BaseModel):
    entities: list[ExtractedEntity]
```

#### 实体类型（控制在 6 类以内）

| 类型 | 说明 | 示例 |
|------|------|------|
| `TOOL` | 工具、库、框架、API | pandas, read_excel, python_executor |
| `CONCEPT` | 技术概念、方法、算法 | CSV解析, 数据清洗 |
| `RESOURCE` | 文件、数据集、制品 | data.csv, output.xlsx |
| `PERSON` | 用户、角色 | 用户, Alice |
| `ORG` | 组织、系统、服务 | Acme Corp |
| `ACTION` | 关键动作/任务（动词短语，需关联参与者） | 读取Excel, 排查报错 |

#### System Prompt 模板

```
你是一个从 Agent 对话和执行日志中提取关键实体的专家。

【实体类型】
TOOL / CONCEPT / RESOURCE / PERSON / ORG / ACTION

【绝对不要提取】
- 代词：我、你、它、这个、那个
- 抽象情感或状态：成功、失败、好的、明白
- 纯时间表达：昨天、现在、之后（时间信息由事件抽取处理）
- 过于泛化的词：东西、内容、数据（除非有明确限定词）
- 句子片段或形容词
- 系统内部字段名：status、latency_ms、step_index

【提取规则】
1. 使用最完整、最具体的形式：提取 "pandas DataFrame" 而非 "DataFrame"
2. 识别别名：如 "pd"、"那个库"、"Pandas" 均指同一实体，列入 aliases
3. Session 类型输入：注意识别 speaker（用户名/agent 是实体）
4. Trace 类型输入：tool_name、action 通常是 TOOL 或 ACTION 实体
5. 不确定时，confidence 设为 0.3-0.5，宁可少抽不要滥抽

【自问测试】
提取前问自己：这个实体在不同会话中再次出现时，我能认出它吗？如果不能，不要提取。
```

#### User Prompt 模板

```
请从以下 {source_type} 类型的内容中提取实体。

<BLOCK_ID>{block_id}</BLOCK_ID>
<REFERENCE_TIME>{timestamp}</REFERENCE_TIME>

<CONTENT>
{content}
</CONTENT>

{custom_instructions}

请严格按照 JSON schema 输出，不要添加解释文字。
```

### 4.3 Prompt 2b：事件抽取

#### 输出 Schema

```python
class ExtractedEvent(BaseModel):
    event_id: str              # evt_<tenant>_<ulid>，由系统生成
    event_type: str            # 见下方事件类型
    trigger: str               # 触发词/核心动作描述
    participants: list[str]    # 参与实体名称列表
    event_time: str | None     # ISO 8601，无法确定时为 null
    time_resolution_confidence: float  # 时间置信度 0-1
    source_block_id: str
    confidence: float

class ExtractedEvents(BaseModel):
    events: list[ExtractedEvent]
```

#### 事件类型（控制在 7 类）

| 类型 | 适用链路 | 说明 |
|------|----------|------|
| `user_request` | Session | 用户提出需求或问题 |
| `decision` | Session | 用户或 Agent 做出决策 |
| `problem` | Session | 出现问题/报错 |
| `solution` | Session | 问题被解决 |
| `tool_use` | Trace | 工具被调用 |
| `tool_result` | Trace | 工具返回结果（成功/失败） |
| `artifact_create` | Trace | 产生了关键制品/文件 |

#### System Prompt 模板

```
你是一个从 Agent 对话和执行日志中提取关键事件的专家。
事件是"在特定时间发生的、有参与者的事情"，不是静态的实体属性。

【事件类型】
user_request / decision / problem / solution / tool_use / tool_result / artifact_create

【绝对不要提取为事件】
- 静态状态描述："pandas 是一个库"（这是实体属性，不是事件）
- 纯意图表达（没有实际发生）：除非有明确执行证据
- 重复的 trace 心跳/日志条目
- 过于细粒度的系统内部操作（除非与任务直接相关）

【时间处理规则】
- 有明确时间戳（trace 日志）→ 直接使用，confidence=0.95
- 有相对时间词（昨天/上周）→ 结合 REFERENCE_TIME 推算，confidence=0.6
- 只有顺序词（然后/之后）→ event_time=null，confidence=0.3
- 无任何时间信息 → event_time=null，confidence=0.2

【Session vs Trace 差异】
- Session 输入：重点抽取 user_request、problem、decision、solution
- Trace 输入：重点抽取 tool_use、tool_result、artifact_create
```

#### User Prompt 模板

```
请从以下 {source_type} 类型的内容中提取关键事件。

<BLOCK_ID>{block_id}</BLOCK_ID>
<REFERENCE_TIME>{timestamp}</REFERENCE_TIME>
<ENTITIES>{extracted_entities_json}</ENTITIES>

<CONTENT>
{content}
</CONTENT>

注意：participants 字段只使用 ENTITIES 列表中已出现的实体名称。
请严格按照 JSON schema 输出。
```

### 4.4 Prompt 2c：关系/事实抽取

这是借鉴 Graphiti edge 抽取思路最多的部分。关系不只是静态三元组，而是**带时间有效性的事实**。同时借鉴 EverMemOS 的 **Foresight** 思想，在提取时主动预测事实有效期。

> [!info] 参考来源
> - Graphiti edge prompt 工程：[https://github.com/getzep/graphiti/tree/main/graphiti_core/prompts](https://github.com/getzep/graphiti/tree/main/graphiti_core/prompts)
> - EverMemOS Foresight/validity intervals：arXiv 2501.02163 — [https://arxiv.org/abs/2501.02163](https://arxiv.org/abs/2501.02163)

#### 输出 Schema

```python
class ExtractedFact(BaseModel):
    source_entity: str         # 必须来自已抽取实体列表
    target_entity: str         # 必须来自已抽取实体列表
    relation_type: str         # SCREAMING_SNAKE_CASE，如 USES、INVOKES
    fact_text: str             # 自然语言描述，不要逐字引用原文
    valid_at: str | None       # ISO 8601，事实成立时间
    invalid_at: str | None     # ISO 8601，事实失效时间（已知时填写）
    validity_confidence: float # 对 invalid_at 预测的置信度（0-1）
    validity_reasoning: str    # 为什么这条事实会/不会失效，如 "API keys typically rotated every 90 days"
    source_block_id: str
    confidence: float

class ExtractedFacts(BaseModel):
    facts: list[ExtractedFact]
```

> [!note] validity_reasoning 字段说明（EverMemOS Foresight 思想）
> 这个字段要求 LLM 在提取时**主动推理**这条事实的有效期预期，而不是只记录"当前成立"。
> - 有明确时效的事实（API Key、临时授权、版本号）：填写推理理由 + 估算 `invalid_at`
> - 稳定事实（用户职位、工具能力）：`validity_reasoning = "Stable fact, unlikely to change soon"`，`invalid_at = null`
> - 当前进行时的状态（正在使用某工具）：`validity_reasoning = "Active in current session"`，`invalid_at = null`

#### 预定义关系类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `USES` | 实体使用工具/库 | 用户 USES pandas |
| `INVOKES` | 工具调用子工具/方法 | python_executor INVOKES read_excel |
| `PRODUCES` | 产生制品 | tool_use PRODUCES output.xlsx |
| `MENTIONS` | 会话中提及 | 用户 MENTIONS data.csv |
| `RELATES_TO` | 通用语义关联 | pandas RELATES_TO CSV解析 |
| `CAUSED_BY` | 因果关系（证据明确时） | solution CAUSED_BY tool_result |

> [!note] 关系命名规则
> 若以上预定义类型不够用，允许 LLM 自行生成 SCREAMING_SNAKE_CASE 格式的关系类型。
> 禁止使用动词短语或自然语言作为 relation_type。

#### System Prompt 模板

```
你是一个从 Agent 对话和执行日志中提取实体关系事实的专家。

【核心规则】
1. source_entity 和 target_entity 必须且只能使用 ENTITIES 列表中的名称
2. 每个事实必须涉及两个不同的实体（禁止单实体状态描述）
3. fact_text 是对原文的改写，不是逐字引用
4. 如果事实有明确的时间范围，填写 valid_at/invalid_at
5. 当前正在发生的事实：valid_at=REFERENCE_TIME，invalid_at=null

【时间有效性规则】
- "用户正在使用 pandas" → valid_at=当前时间，validity_reasoning="Active in current session"
- "用户昨天用过 pandas" → valid_at=推算的昨天，invalid_at=null（不确定是否仍有效）
- "用户从 pandas 切换到 polars" → pandas 的 USES 关系 invalid_at=切换时间

【validity_reasoning 填写规则（Foresight）】
对每条事实，必须推理其有效期预期：
- API Key / Token / 临时授权 → "Credentials typically expire or rotate, estimate 90 days"
- 软件版本号 / 配置项 → "Version info changes with upgrades"
- 用户当前使用的工具 → "Active in current session, may change"
- 稳定的能力/概念关系 → "Stable semantic fact, unlikely to change"
- 组织/团队归属 → "Org membership is relatively stable"

【禁止提取】
- 单实体状态："pandas 是流行的库"
- 过于泛化的关系：不要把所有事情都变成 RELATES_TO
- 无法从文本中直接支撑的推断
```

---

## 5. Stage 3：实体去重与链接

### 5.1 问题描述

同一实体在不同会话中可能以不同形式出现：
- `pandas` / `Pandas` / `pd` / "那个库"
- `python_executor` / "Python 执行器" / "代码执行工具"

去重的目标：**把这些指向同一真实对象的不同表述，归并到同一个 `entity_id` 下。**

### 5.2 三层去重策略

```
新抽取的实体
  → Step 1: 后处理归一化（规则，毫秒级）
  → Step 2: 候选召回（Milvus 向量相似度，可选）
  → Step 3: LLM 去重判断（Graphiti candidate-ID 模式）
  → 归并结果 → 更新 entity_id 映射
```

#### Step 1：后处理归一化（规则）

这是本方案中**唯一保留规则的环节**，用于低成本处理明确的规范化问题：
- 大小写统一：`Pandas` → `pandas`
- 去除首尾空格
- 常见缩写映射：`pd` → `pandas`（需维护小型白名单）
- 标点归一：全角/半角统一

#### Step 2：候选召回（Milvus，P2）

- 把每个实体名称的 embedding 存入 Milvus
- 新实体进来时，召回 top-5 候选（余弦相似度 > 0.85）
- 候选集送入 Step 3 进行 LLM 判断

> [!tip] 原型阶段降级方案
> 若 Milvus 尚未接入，直接用字符串相似度（编辑距离）召回候选，效果稍差但可快速验证流程。

> [!note] Phase 2 补充：HippoRAG 同义边
> LLM candidate-ID 去重处理的是**明确同名/别名**（实时，在抽取阶段）。但语义相似但表面不同的实体（"分布式追踪" vs "链路追踪" vs "Distributed Tracing"）需要另一套机制。
> Phase 2 计划加离线 Entity Normalization 任务：用 embedding 余弦相似度为语义相近实体生成 `SYNONYM_OF` 边，作为语义去重的补充层。参考：HippoRAG arXiv 2405.14831 — [https://arxiv.org/abs/2405.14831](https://arxiv.org/abs/2405.14831)

#### Step 3：LLM 去重判断（Graphiti candidate-ID 模式）

借鉴 Graphiti `dedupe_nodes` 的设计，用 candidate-ID 编号方案避免 LLM 做字符串匹配。

**输出 Schema**：
```python
class EntityResolution(BaseModel):
    new_entity_name: str          # 新实体名
    matched_candidate_id: int     # 匹配的候选 ID，-1 表示无匹配（新实体）
    merged_canonical_name: str    # 归并后的标准名称

class EntityResolutions(BaseModel):
    resolutions: list[EntityResolution]
```

**Prompt 模板**：
```
判断以下新实体是否与已有实体列表中的某个实体指向同一真实对象。

<EXISTING_ENTITIES>
[0] pandas (TOOL) - 数据处理库，已知别名: pd, Pandas
[1] python_executor (TOOL) - Python 代码执行工具
[2] data.csv (RESOURCE) - 数据文件
</EXISTING_ENTITIES>

<NEW_ENTITIES>
- "那个库" (TOOL, aliases: [])
- "Excel读取工具" (TOOL, aliases: [])
</NEW_ENTITIES>

【判断规则】
1. 返回 matched_candidate_id：若确认是同一真实对象，返回对应编号
2. 返回 -1：若不确定或明确不是同一对象
3. 宁可保守（返回 -1 创建新节点）也不要错误合并
4. 别名、缩写、同义词均视为同一实体
5. 同名但明显不同的概念不合并（如编程语言"Java"与地名"Java岛"）

输出每个新实体的 matched_candidate_id 和归并后的 canonical name。
```

### 5.3 去重结果处理

- `matched_candidate_id != -1`：复用已有 `entity_id`，将新别名加入 `aliases` 列表，更新 `last_seen_at`
- `matched_candidate_id == -1`：生成新 `entity_id`，创建新 `EntityNode`

---

## 6. Stage 4：Temporal KG 写入

### 6.1 写入原则

1. 每个 `EventNode` 必须有 `source_block_id` 溯源
2. 每个 `EntityNode` 必须有 `tenant_id`
3. 时间信息缺失时允许 `null`，但保留 `time_resolution_confidence`
4. 新数据进来时先与已有节点比对，不只是追加
5. 时序边 `PRECEDES` 为主持久化边，`FOLLOWS` 为派生关系

### 6.2 Neo4j 节点与关系模型

#### EntityNode

```cypher
(:EntityNode {
  entity_id: "ent_acmecorp_01...",
  tenant_id: "acmecorp",
  name: "pandas",
  entity_type: "TOOL",
  aliases: ["pd", "Pandas"],
  summary: "Python 数据处理库，用户频繁用于 CSV/Excel 读写",
  first_seen_at: datetime("2026-03-30T10:00:00Z"),
  last_seen_at: datetime("2026-03-31T10:02:00Z"),
  source_block_ids: ["blk_acmecorp_01...", "blk_acmecorp_02..."],
  created_at: datetime(),
  updated_at: datetime()
})
```

#### EventNode

```cypher
(:EventNode {
  event_id: "evt_acmecorp_01...",
  tenant_id: "acmecorp",
  event_type: "tool_use",
  trigger: "read_excel",
  event_time: datetime("2026-03-31T10:02:00Z"),
  time_resolution_confidence: 0.95,
  confidence: 0.88,
  session_id: "sess_acmecorp_01...",
  source_block_id: "blk_acmecorp_01...",
  created_at: datetime()
})
```

#### RawBlockRef

```cypher
(:RawBlockRef {
  block_id: "blk_acmecorp_01...",
  tenant_id: "acmecorp",
  source_type: "agent_trace",
  source_uri: "trace://sess_acmecorp_01.../step/8",
  timestamp: datetime("2026-03-31T10:02:00Z"),
  session_id: "sess_acmecorp_01..."
})
```

#### 关系类型

```cypher
// 实体参与事件
(:EntityNode)-[:PARTICIPATES_IN {role: "tool"}]->(:EventNode)

// 带时间有效性的事实关系
(:EntityNode)-[:USES {
  fact_text: "用户使用 pandas 处理数据",
  valid_at: datetime("2026-03-31"),
  invalid_at: null,
  confidence: 0.88,
  source_block_id: "blk_acmecorp_01..."
}]->(:EntityNode)

// 时序边（主要持久化边）
(:EventNode)-[:PRECEDES {confidence: 0.90}]->(:EventNode)

// 事件溯源
(:EventNode)-[:DERIVED_FROM]->(:RawBlockRef)

// Session-Trace 桥接
(:EventNode)-[:REQUEST_LEADS_TO {confidence: 0.75}]->(:EventNode)
```

### 6.3 冲突与更新处理

| 场景 | 处理方式 |
|------|----------|
| 新 block 提到同一实体 | 更新 `last_seen_at`，追加 `source_block_ids` |
| 新事实与旧事实冲突 | 旧事实关系加 `superseded_at`，新事实作为新边写入 |
| 同一事件重复出现 | 通过 `source_block_id` 去重，不重复写入 |
| 实体被归并 | 保留目标 `entity_id`，旧 ID 记录在 `merged_from` 字段 |

### 6.4 约束与索引

```cypher
CREATE CONSTRAINT entity_id_unique IF NOT EXISTS
  FOR (n:EntityNode) REQUIRE n.entity_id IS UNIQUE;

CREATE CONSTRAINT event_id_unique IF NOT EXISTS
  FOR (n:EventNode) REQUIRE n.event_id IS UNIQUE;

CREATE CONSTRAINT block_id_unique IF NOT EXISTS
  FOR (n:RawBlockRef) REQUIRE n.block_id IS UNIQUE;

CREATE INDEX entity_name_idx IF NOT EXISTS
  FOR (n:EntityNode) ON (n.tenant_id, n.name);

CREATE INDEX event_time_idx IF NOT EXISTS
  FOR (n:EventNode) ON (n.event_time);

CREATE INDEX event_session_idx IF NOT EXISTS
  FOR (n:EventNode) ON (n.session_id);
```


---

## 7. 数据存储设计（原型版）

### 7.1 存储分工

| 存储 | 职责 | 本期优先级 |
|------|------|-----------|
| Neo4j | 时序知识图谱主存储：EntityNode、EventNode、RawBlockRef、关系边 | P0 核心 |
| Milvus | 实体向量索引，用于去重候选召回 | P2 可选 |
| 本地 JSONL | 抽取中间结果归档、离线调试与回放 | P0 辅助 |

> [!warning]
> 本期不引入 LanceDB 作为 Group 3 的必需存储。Raw Block 原始内容通过本地 JSONL 或上游 block 文件追溯即可。

### 7.2 Milvus 集合设计（P2）

只保留一个集合：`entity_embeddings`

| 字段 | 类型 | 说明 |
|------|------|------|
| `entity_id` | VARCHAR | 主键，对应 Neo4j EntityNode |
| `tenant_id` | VARCHAR | 租户隔离 |
| `name` | VARCHAR | 实体标准名称 |
| `entity_type` | VARCHAR | 实体类型 |
| `embedding` | FLOAT_VECTOR | 名称 + 类型的语义向量 |
| `updated_at` | INT64 | 最近更新时间戳 |

### 7.3 本地 JSONL 归档结构

```
data/
├── raw_blocks/
│   ├── session_blocks.jsonl      # Session Raw Block
│   └── trace_blocks.jsonl        # Trace Raw Block
├── extracted/
│   ├── entities.jsonl            # 抽取的实体（含 source_block_id）
│   ├── events.jsonl              # 抽取的事件
│   └── facts.jsonl               # 抽取的关系/事实
├── dedup/
│   └── entity_resolutions.jsonl  # 去重归并结果
└── debug/
    └── llm_calls.jsonl           # LLM 调用记录，用于 prompt 调优
```

---

## 8. 本地验证与评估

### 8.1 验证原则

本期不实现完整检索层，只实现**本地验证能力**，用于判断图谱是否构建成功、结构是否可用。

### 8.2 三类本地验证查询

#### 查询 1：实体查询

输入：实体名称（如 `pandas`）

返回：
- 实体基本信息（类型、别名、首次/最近出现时间）
- 最近关联的事件列表
- 直接相关实体（1 跳）
- 来源 block 列表

```cypher
MATCH (e:EntityNode {name: $name, tenant_id: $tenant_id})
OPTIONAL MATCH (e)-[r]-(related)
RETURN e, r, related
ORDER BY e.last_seen_at DESC
LIMIT 20
```

#### 查询 2：时间线查询

输入：`session_id` 或时间范围

返回：
- 该 session 内的事件序列（按时间排序）
- 每个事件的参与实体
- 每个事件的 source block 引用

```cypher
MATCH (ev:EventNode {session_id: $session_id, tenant_id: $tenant_id})
OPTIONAL MATCH (ev)-[:DERIVED_FROM]->(ref:RawBlockRef)
OPTIONAL MATCH (entity:EntityNode)-[:PARTICIPATES_IN]->(ev)
RETURN ev, ref, collect(entity) AS participants
ORDER BY ev.event_time ASC
```

#### 查询 3：1-2 跳路径查看

输入：两个实体名称

返回：
- 是否存在直接关系（1 跳）
- 是否存在间接路径（2 跳）
- 路径上的关系类型与证据 block

```cypher
MATCH path = shortestPath(
  (a:EntityNode {name: $entity_a})-[*1..2]-(b:EntityNode {name: $entity_b})
)
RETURN path
LIMIT 5
```

### 8.3 评估指标

| 指标类别 | 指标 | 目标 | 说明 |
|---------|------|------|------|
| 实体抽取 | Precision | > 0.80 | 基于人工标注样本 |
| 实体抽取 | Recall | > 0.70 | 先关注高频实体 |
| 事件抽取 | Accuracy | > 0.70 | 事件类型控制在最小集合 |
| 时序质量 | 时序顺序准确率 | > 0.80 | 判断前后顺序是否正确 |
| 去重质量 | 实体归并准确率 | > 0.75 | 高频实体归并正确即可支撑 demo |
| 图谱写入 | 入库成功率 | > 0.95 | 入库失败率需可追溯 |
| Demo 可用 | Demo Case 通过率 | > 0.80 | 预设演示问题可正确展示 |

### 8.4 评估数据建议

构建一套轻量人工标注集：
- 50 条 session / trace 样本（CrossWOZ + ToolBench 各取一半）
- 100-150 个实体标注
- 50-80 个事件标注
- 30 组时序前后关系标注
- 10 个 demo query case

### 8.5 Prompt 调优流程

```
初始 prompt
  → 跑 20-30 条样本
  → 对比抽取结果与人工标注
  → 分析错误模式（漏抽/误抽/类型错误）
  → 调整 prompt 的排除规则或示例
  → 再跑一轮
```

LLM 调用记录统一写入 `debug/llm_calls.jsonl`，格式：

```json
{
  "block_id": "blk_acmecorp_01...",
  "prompt_version": "entity_v1.2",
  "input": "...",
  "output": "...",
  "parse_success": true,
  "timestamp": 1774922400
}
```


---

## 9. 开发排期与交付物

### 9.1 Week 1：规范对齐 + 环境搭建 + Prompt 初版

| 工作项 | 说明 | 交付物 |
|--------|------|--------|
| 对齐 TL 规范 | 确认 Raw Block Schema v0.1 与 ID 规范 | 对齐说明文档 |
| 输入适配器 | session / trace → NormalizedSession / NormalizedTrace | 适配脚本 |
| Demo 数据准备 | 从 CrossWOZ + ToolBench 抽取 50 条样本，人工标注 | 标注数据包 |
| Neo4j 环境搭建 | 单机开发环境，建 schema + 索引 | 初始化脚本 |
| Prompt 初版 | 实体/事件/关系抽取 prompt v0.1 | prompt 模板文件 |
| LLM 调用封装 | 统一的 LLM 调用 + 结构化输出解析模块 | `llm_extractor.py` |

### 9.2 Week 2：抽取 Pipeline + 去重 + 图谱写入

| 工作项 | 说明 | 交付物 |
|--------|------|--------|
| Session 归并器 | 任务边界切分，输出 Raw Block | `session_merger.py` |
| Trace 结构化 | trace step → Raw Block | `trace_parser.py` |
| 抽取 Pipeline | 实体 → 事件 → 关系，串联三个 prompt | `extraction_pipeline.py` |
| LLM 去重模块 | candidate-ID 模式实体归并 | `entity_dedup.py` |
| Neo4j 写入模块 | EntityNode / EventNode / 关系写入 | `kg_writer.py` |
| Prompt 调优 | 基于标注集迭代 prompt，目标 entity P > 0.75 | prompt v0.2 + 评估报告 |

### 9.3 Week 3：验证接口 + 评估 + Demo

| 工作项 | 说明 | 交付物 |
|--------|------|--------|
| 本地验证脚本 | 实体查询 / 时间线查询 / 1-2 跳路径 | `local_query.py` |
| Milvus 接入（可选） | 实体 embedding 写入，增强去重召回 | 向量召回 demo |
| 端到端评估 | 跑完整 pipeline，对比标注集 | 评估结果表 |
| Demo 准备 | 5 个预设 demo query case，可复现 | demo 脚本 + 截图 |

### 9.4 本期最终交付物

1. 一套可运行的 `Session/Trace → Raw Block → Temporal KG` 原型 pipeline
2. 三个 LLM prompt 模板（实体/事件/关系），含版本记录
3. 一套最小 Neo4j 图模型与写入脚本
4. 一份轻量评估结果表（基于 50 条标注样本）
5. 至少 5 个可复现的本地查询 demo case

---

## 10. 风险与后续演进

### 10.1 主要风险

| 风险 | 影响 | 缓解方式 |
|------|------|---------|
| LLM 输出不稳定（结构化解析失败） | 抽取 pipeline 中断 | 增加重试机制 + fallback 到空结果，保证 pipeline 不崩 |
| LLM 抽取成本超预期 | 影响开发节奏 | 开发阶段用小模型（如 qwen-turbo），评估阶段换强模型；batch 调用降低成本 |
| 实体去重误合并 | 图谱噪声，影响 demo 质量 | 设置保守阈值（不确定时返回 -1），宁可多节点也不误合并 |
| Prompt 迭代收敛慢 | Week 2 进度风险 | Week 1 先跑 20 条快速验证，不等完整标注集 |
| Schema 未及时统一 | 跨组联调困难 | Week 1 第一件事就是锁定 Raw Block 与 ID 规范 |

### 10.2 取舍优先级

若时间或资源不足，按以下顺序取舍：

1. ✅ Raw Block 对齐（不可妥协）
2. ✅ LLM 实体抽取 + Neo4j 最小图谱（核心验证目标）
3. ✅ LLM 事件抽取 + 时序边
4. ⚡ LLM 去重（可降级为规则归一化）
5. ⚡ LLM 关系/事实抽取（可降级为只保留时序边）
6. 🔄 Milvus 向量辅助（可选，Week 3 再决定）

### 10.3 后续演进方向（Phase 2）

| 方向 | 说明 | 参考来源 |
|------|------|---------|
| 规则替代高频 LLM 调用 | 对高频、模式固定的实体（工具名、常用库）改用规则白名单，降本 | — |
| Entity Summary 自动更新 | 借鉴 Graphiti `summarize_nodes`，为高频实体生成/更新摘要 | [Graphiti](https://github.com/getzep/graphiti) |
| **PPR 多跳检索** | 查询时：ANN 命中 EntityNode → PPR 在 KG 上传播 → 召回相关 EventNode + RawBlockRef，覆盖语义相关情节 | [HippoRAG arXiv 2405.14831](https://arxiv.org/abs/2405.14831) |
| **SemanticCluster 节点** | 对跨会话 EventNode 做主题聚类，生成 `SemanticCluster` 节点（对应 EverMemOS MemScene），完成情节→语义的固化 | [EverMemOS arXiv 2501.02163](https://arxiv.org/abs/2501.02163) |
| **离线 Entity Normalization** | 用 embedding 相似度生成 `SYNONYM_OF` 边，处理语义相近但表面不同的实体 | [HippoRAG arXiv 2405.14831](https://arxiv.org/abs/2405.14831) |
| 全局一致性修复 | 冲突检测、旧事实标记 superseded、实体跨 session 归并质量提升 | — |
| Graph RAG / 多跳推理 | 在 Temporal KG 基础上接入检索层，支持复杂记忆召回 | — |
| 社区发现 | Leiden 算法对实体聚类，生成主题摘要节点 | — |
| 遗忘机制 | 时效度衰减、低置信度节点过期标记 | — |
| 与 Group 2 知识图谱融合 | 打通文档/代码知识与会话记忆 | — |

---

## 附录 A：与评审版核心差异对照

| 章节 | 评审版 | 本版 |
|------|--------|------|
| 第2章（为什么需要KG） | 2000+ 字论证，6个子章节 | **删除**，此论证已在大纲文档中充分覆盖 |
| 抽取策略（6.5节） | 规则优先 + 轻量NER + LLM精修 | **LLM Prompt 优先**，提供完整 prompt 模板 |
| 实体去重 | 名称规范化 + 规则匹配 + 向量候选 | **LLM candidate-ID 模式**（Graphiti 借鉴） |
| 关系建模 | 静态关系集合 | **带 valid_at/invalid_at 的时序事实** |
| Prompt 设计 | 无 | **三套完整 prompt 模板 + Pydantic schema** |
| 调试支持 | 无 | **LLM 调用日志 + Prompt 版本记录 + 调优流程** |

## 附录 B：推荐的 5 个 Demo Query Case

1. **实体回忆**：`pandas` 这个工具最近一次在哪个 session 里被用到？当时做的是什么？
2. **时间线重建**：session `sess_xxx` 里，从"用户提出需求"到"工具执行成功"经历了哪些事件？
3. **路径查询**：`pandas` 和 `read_excel` 之间是否存在关联路径？
4. **演化追踪**：某个 session 中，用户的问题是如何从"报错"演化到"解决方案"的？
5. **跨会话回忆**：用户昨天提到的工具，今天又在哪个事件里出现了？

## 附录 C：共享规范对齐（Minimal ID）

| 对象 | ID 格式 | 示例 |
|------|---------|------|
| Raw Block | `blk_<tenant>_<ulid>` | `blk_acmecorp_01JQ7M4YF3K9...` |
| Session | `sess_<tenant>_<ulid>` | `sess_acmecorp_01JQ7M50A8N2...` |
| Event | `evt_<tenant>_<ulid>` | `evt_acmecorp_01JQ7M58CZQ1...` |
| Entity | `ent_<tenant>_<ulid>` | `ent_acmecorp_01JQ7M5E6T4P...` |
| Agent | `agt_<tenant>_<ulid>` | `agt_acmecorp_01JQ7M5HX8V2...` |

---

*本文档为 Group 3 原型阶段最新版详细方案，以"LLM Prompt 优先"替代"规则优先"作为抽取核心策略，借鉴 Graphiti 的 prompt 工程模式，聚焦 2-3 周内可落地的最小闭环验证。*
