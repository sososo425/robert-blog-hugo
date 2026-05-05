---
title: Session & Trace 记忆构建应用场景 - 端到端模拟
date: 2026-04-02
tags:
  - AMS
  - Group3
  - 记忆构建
  - TemporalKG
  - 端到端模拟
status: 草稿
---

> [!info] 文档定位
> 本文档是 Group 3 记忆构建模块的**端到端模拟示例**，用一个具体场景走通完整 Pipeline（Stage 0 → Stage 4 → 检索验证）。
> 所有术语、Schema、ID 格式严格对齐：
> - [[Group3 记忆构建模块 - 原理与背景]]（原理层）
> - [[Group3-记忆构建模块-详细方案设计-最新版]]（执行层）

> [!tip] 阅读建议
> 本文档适合在读完原理文档和方案文档后，作为"跑一遍看看"的理解辅助。
> 每个阶段都标注了对应的 Stage 编号，方便与方案文档交叉引用。

---

## 目录

1. [场景设定与原始数据](#1-场景设定与原始数据)
2. [Stage 0-1：输入适配与 Raw Block 生成](#2-stage-0-1输入适配与-raw-block-生成)
3. [Stage 2：LLM-Driven 抽取](#3-stage-2llm-driven-抽取)
4. [Stage 3：实体去重与链接](#4-stage-3实体去重与链接)
5. [Stage 4：Temporal KG 写入](#5-stage-4temporal-kg-写入)
6. [检索验证：六个问题的完整拆解](#6-检索验证六个问题的完整拆解)
7. [知识演化：Session B 进来后图谱怎么更新](#7-知识演化session-b-进来后图谱怎么更新)
8. [端到端流水线总结](#8-端到端流水线总结)

---

## 1. 场景设定与原始数据

### 1.1 场景描述

两轮对话 + 一次 Agent 内部执行，间隔 3 天，涉及 Session 和 Trace 两种数据源：

> **Session A（2026-03-28 14:32，sess_acmecorp_01A）**
> Turn 1 - 用户：我用 pandas 处理了一个 CSV，有个列的类型识别有问题。
> Turn 2 - Agent：你可以试试 `pd.read_csv('file.csv', dtype={'col_name': str})`，或者用 `converters` 参数……
> Turn 3 - 用户：试了一下，指定 dtype 之后那列不再被识别成 float 了，但日期列还是有问题。
> Turn 4 - Agent：日期列建议用 `parse_dates=['date_col']` 配合 `date_parser`……

> **Trace A（与 Session A 同时产生）**
> Agent 在 Turn 2 回复前，内部调用了 python_executor 执行 `pd.read_csv`，耗时 320ms，成功返回 DataFrame。

> **Session B（2026-03-31 09:15，sess_acmecorp_01B）**
> Turn 5 - 用户：上次那个问题，我换了一下读取方式，现在 Excel 也没问题了。

**核心挑战**：Session B 的 Turn 5 中，"上次那个问题"、"换了读取方式"、"Excel 也没问题了"——纯文本中没有任何锚点。系统必须通过结构化记忆才能理解这些指代。

### 1.2 原始输入数据

#### Session 原始消息流（JSONL 格式）

```json
{"session_id": "sess_acmecorp_01A", "tenant_id": "acmecorp", "turn_index": 1, "speaker": "user", "content": "我用 pandas 处理了一个 CSV，有个列的类型识别有问题。", "timestamp": 1743162725}
{"session_id": "sess_acmecorp_01A", "tenant_id": "acmecorp", "turn_index": 2, "speaker": "assistant", "content": "你可以试试 pd.read_csv('file.csv', dtype={'col_name': str})，或者用 converters 参数……", "timestamp": 1743162738}
{"session_id": "sess_acmecorp_01A", "tenant_id": "acmecorp", "turn_index": 3, "speaker": "user", "content": "试了一下，指定 dtype 之后那列不再被识别成 float 了，但日期列还是有问题。", "timestamp": 1743162942}
{"session_id": "sess_acmecorp_01A", "tenant_id": "acmecorp", "turn_index": 4, "speaker": "assistant", "content": "日期列建议用 parse_dates=['date_col'] 配合 date_parser……", "timestamp": 1743162955}
{"session_id": "sess_acmecorp_01B", "tenant_id": "acmecorp", "turn_index": 1, "speaker": "user", "content": "上次那个问题，我换了一下读取方式，现在 Excel 也没问题了。", "timestamp": 1743422103}
```

#### Trace 原始日志（JSONL 格式）

```json
{"session_id": "sess_acmecorp_01A", "tenant_id": "acmecorp", "step_index": 1, "tool_name": "python_executor", "action": "read_csv", "input_args": {"file": "data.csv", "dtype": {"amount": "str"}}, "status": "success", "latency_ms": 320, "output_summary": "DataFrame 128 rows x 5 cols", "timestamp": 1743162735}
```

---

## 2. Stage 0-1：输入适配与 Raw Block 生成

> 对应方案文档：§3 Stage 0-1

### 2.1 Stage 0：输入适配

Session 和 Trace 分别进入各自的适配链路，归一化为标准结构：

- **Session 链路**：识别 speaker、turn 边界、对话时间戳 → `NormalizedSession`
- **Trace 链路**：归一化 tool/action/status/latency 字段 → `NormalizedTrace`

### 2.2 Stage 1：Raw Block 生成

每个 turn 或 trace step 生成**一个** Raw Block。Block 是原料层，只含原始内容和元数据，**不做任何语义提炼**（语义抽取在 Stage 2 完成）。

#### Session Blocks（每个 turn → 一个 Block）

```json
// Block 1: Turn 1 — 用户提出问题
{
  "block_id": "blk_acmecorp_01A_T1",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "user: 我用 pandas 处理了一个 CSV，有个列的类型识别有问题。",
  "metadata": {
    "timestamp": 1743162725,
    "source_uri": "session://sess_acmecorp_01A/turn/1",
    "session_id": "sess_acmecorp_01A",
    "turn_index": 1,
    "speaker": "user"
  }
}

// Block 2: Turn 2 — Agent 建议 dtype 方案
{
  "block_id": "blk_acmecorp_01A_T2",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "assistant: 你可以试试 pd.read_csv('file.csv', dtype={'col_name': str})，或者用 converters 参数……",
  "metadata": {
    "timestamp": 1743162738,
    "source_uri": "session://sess_acmecorp_01A/turn/2",
    "session_id": "sess_acmecorp_01A",
    "turn_index": 2,
    "speaker": "assistant"
  }
}

// Block 3: Turn 3 — 用户反馈部分成功
{
  "block_id": "blk_acmecorp_01A_T3",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "user: 试了一下，指定 dtype 之后那列不再被识别成 float 了，但日期列还是有问题。",
  "metadata": {
    "timestamp": 1743162942,
    "source_uri": "session://sess_acmecorp_01A/turn/3",
    "session_id": "sess_acmecorp_01A",
    "turn_index": 3,
    "speaker": "user"
  }
}

// Block 4: Turn 4 — Agent 建议 parse_dates
{
  "block_id": "blk_acmecorp_01A_T4",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "assistant: 日期列建议用 parse_dates=['date_col'] 配合 date_parser……",
  "metadata": {
    "timestamp": 1743162955,
    "source_uri": "session://sess_acmecorp_01A/turn/4",
    "session_id": "sess_acmecorp_01A",
    "turn_index": 4,
    "speaker": "assistant"
  }
}

// Block 5: Turn 5 — 用户跨会话更新（Session B）
{
  "block_id": "blk_acmecorp_01B_T1",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "user: 上次那个问题，我换了一下读取方式，现在 Excel 也没问题了。",
  "metadata": {
    "timestamp": 1743422103,
    "source_uri": "session://sess_acmecorp_01B/turn/1",
    "session_id": "sess_acmecorp_01B",
    "turn_index": 1,
    "speaker": "user"
  }
}
```

#### Trace Block（每个 step → 一个 Block）

```json
// Block T1: Agent 内部执行 read_csv
{
  "block_id": "blk_acmecorp_01A_S1",
  "tenant_id": "acmecorp",
  "source_type": "agent_trace",
  "content": "tool=python_executor; action=read_csv; input={file: data.csv, dtype: {amount: str}}; status=success; latency_ms=320; output=DataFrame 128 rows x 5 cols",
  "metadata": {
    "timestamp": 1743162735,
    "source_uri": "trace://sess_acmecorp_01A/step/1",
    "session_id": "sess_acmecorp_01A",
    "step_index": 1,
    "tool_name": "python_executor"
  }
}
```

> [!note] 关键设计点
> - Block 是**原子粒度**：每个 turn / step 一个，不做跨 turn 聚合
> - Block 是**原料层**：只含原始内容 + 结构化元数据，不含抽取结果
> - `source_type` 区分 `"session"` 和 `"agent_trace"`，决定后续 Stage 2 使用哪种 prompt 模板
> - `source_uri` 保留完整溯源路径，确保任何抽取结果都能追回原始 turn/step

---

## 3. Stage 2：LLM-Driven 抽取

> 对应方案文档：§4 Stage 2

Stage 2 是核心环节。每个 Raw Block 依次经过三个独立的 LLM 调用，串联执行：

```
Raw Block
  → Prompt 2a: 实体抽取 (Entity Extraction)
  → Prompt 2b: 事件抽取 (Event Extraction)  ← 依赖 2a 的实体列表
  → Prompt 2c: 关系/事实抽取 (Edge/Fact Extraction) ← 依赖 2a 的实体列表
```

下面以 Block 1（blk_acmecorp_01A_T1）和 Block T1（blk_acmecorp_01A_S1）为例，分别展示 Session 链路和 Trace 链路的抽取结果。

### 3.1 Prompt 2a：实体抽取

#### Block 1（Session 链路）抽取结果

输入：`"user: 我用 pandas 处理了一个 CSV，有个列的类型识别有问题。"`

```json
{
  "entities": [
    {
      "name": "pandas",
      "entity_type": "TOOL",
      "aliases": ["pd", "Pandas"],
      "source_block_id": "blk_acmecorp_01A_T1",
      "confidence": 0.95
    },
    {
      "name": "CSV",
      "entity_type": "CONCEPT",
      "aliases": ["csv文件", "CSV文件"],
      "source_block_id": "blk_acmecorp_01A_T1",
      "confidence": 0.90
    },
    {
      "name": "data.csv",
      "entity_type": "RESOURCE",
      "aliases": [],
      "source_block_id": "blk_acmecorp_01A_T1",
      "confidence": 0.60
    }
  ]
}
```

> [!note] 为什么没有提取"列的类型识别"？
> 根据 Prompt 2a 的排除规则："过于泛化的词"和"句子片段"不应提取。"列的类型识别有问题"是一个问题描述，不是可跨会话归一的实体。它会在 Prompt 2b 中被提取为**事件**。

#### Block T1（Trace 链路）抽取结果

输入：`"tool=python_executor; action=read_csv; input={file: data.csv, dtype: {amount: str}}; status=success; latency_ms=320; output=DataFrame 128 rows x 5 cols"`

```json
{
  "entities": [
    {
      "name": "python_executor",
      "entity_type": "TOOL",
      "aliases": ["Python执行器"],
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.95
    },
    {
      "name": "pd.read_csv",
      "entity_type": "TOOL",
      "aliases": ["read_csv"],
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.92
    },
    {
      "name": "data.csv",
      "entity_type": "RESOURCE",
      "aliases": [],
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.95
    }
  ]
}
```

#### 所有 Block 的实体汇总

对 Session A 的 4 个 Block + 1 个 Trace Block 全部运行 Prompt 2a 后，得到实体全集（去重前）：

| 实体名称 | 类型 | 来源 Block | 置信度 |
|---------|------|-----------|--------|
| pandas | TOOL | blk_01A_T1, blk_01A_T2 | 0.95 |
| CSV | CONCEPT | blk_01A_T1 | 0.90 |
| data.csv | RESOURCE | blk_01A_T1, blk_01A_S1 | 0.60→0.95 |
| pd.read_csv | TOOL | blk_01A_T2, blk_01A_S1 | 0.92 |
| dtype | CONCEPT | blk_01A_T2, blk_01A_T3 | 0.85 |
| converters | CONCEPT | blk_01A_T2 | 0.70 |
| parse_dates | CONCEPT | blk_01A_T4 | 0.85 |
| date_parser | CONCEPT | blk_01A_T4 | 0.80 |
| python_executor | TOOL | blk_01A_S1 | 0.95 |

### 3.2 Prompt 2b：事件抽取

#### Block 1（Session 链路）

输入 Block content + 上一步提取的实体列表，输出：

```json
{
  "events": [
    {
      "event_id": "evt_acmecorp_01A_E1",
      "event_type": "problem",
      "trigger": "用户报告 CSV 列类型被错误识别",
      "participants": ["pandas", "CSV"],
      "event_time": "2026-03-28T14:32:05Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_T1",
      "confidence": 0.92
    }
  ]
}
```

#### Block 2（Session 链路）

```json
{
  "events": [
    {
      "event_id": "evt_acmecorp_01A_E2",
      "event_type": "solution",
      "trigger": "Agent 建议使用 dtype 参数指定列类型",
      "participants": ["pd.read_csv", "dtype"],
      "event_time": "2026-03-28T14:32:18Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_T2",
      "confidence": 0.88
    }
  ]
}
```

#### Block 3（Session 链路）

```json
{
  "events": [
    {
      "event_id": "evt_acmecorp_01A_E3",
      "event_type": "decision",
      "trigger": "用户确认 dtype 修复了 float 问题",
      "participants": ["dtype"],
      "event_time": "2026-03-28T14:35:42Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_T3",
      "confidence": 0.85
    },
    {
      "event_id": "evt_acmecorp_01A_E4",
      "event_type": "problem",
      "trigger": "用户报告日期列仍有解析问题",
      "participants": ["pandas", "parse_dates"],
      "event_time": "2026-03-28T14:35:42Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_T3",
      "confidence": 0.88
    }
  ]
}
```

#### Block 4（Session 链路）

```json
{
  "events": [
    {
      "event_id": "evt_acmecorp_01A_E5",
      "event_type": "solution",
      "trigger": "Agent 建议使用 parse_dates 和 date_parser 处理日期列",
      "participants": ["parse_dates", "date_parser", "pd.read_csv"],
      "event_time": "2026-03-28T14:35:55Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_T4",
      "confidence": 0.85
    }
  ]
}
```

#### Block T1（Trace 链路）

```json
{
  "events": [
    {
      "event_id": "evt_acmecorp_01A_TE1",
      "event_type": "tool_use",
      "trigger": "python_executor 调用 read_csv 读取 data.csv",
      "participants": ["python_executor", "pd.read_csv", "data.csv"],
      "event_time": "2026-03-28T14:32:15Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.95
    },
    {
      "event_id": "evt_acmecorp_01A_TE2",
      "event_type": "tool_result",
      "trigger": "read_csv 执行成功，返回 DataFrame 128行x5列",
      "participants": ["pd.read_csv", "data.csv"],
      "event_time": "2026-03-28T14:32:15Z",
      "time_resolution_confidence": 0.95,
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.93
    }
  ]
}
```

#### 事件时序链全景

```
Session A 时序线（2026-03-28）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━►

14:32:05          14:32:15           14:32:18          14:35:42              14:35:55
   │                 │                  │                 │                    │
   ▼                 ▼                  ▼                 ▼                    ▼
[evt_E1]         [evt_TE1]          [evt_E2]          [evt_E3]+[evt_E4]    [evt_E5]
problem          tool_use           solution          decision + problem    solution
"CSV列类型       "python_executor   "建议用dtype      "dtype修复float      "建议用
 识别错误"        调用read_csv"      指定列类型"       成功" + "日期列      parse_dates"
                 ↓                                    仍有问题"
              [evt_TE2]
              tool_result
              "read_csv
               执行成功"
```

### 3.3 Prompt 2c：关系/事实抽取

#### Block 1 的事实抽取

```json
{
  "facts": [
    {
      "source_entity": "pandas",
      "target_entity": "CSV",
      "relation_type": "RELATES_TO",
      "fact_text": "用户使用 pandas 处理 CSV 格式数据",
      "valid_at": "2026-03-28T14:32:05Z",
      "invalid_at": null,
      "validity_confidence": 0.3,
      "validity_reasoning": "Active in current session, may change to other formats",
      "source_block_id": "blk_acmecorp_01A_T1",
      "confidence": 0.88
    }
  ]
}
```

#### Block 2 的事实抽取

```json
{
  "facts": [
    {
      "source_entity": "pd.read_csv",
      "target_entity": "dtype",
      "relation_type": "USES",
      "fact_text": "Agent 建议通过 pd.read_csv 的 dtype 参数显式指定列类型来修复类型识别问题",
      "valid_at": "2026-03-28T14:32:18Z",
      "invalid_at": null,
      "validity_confidence": 0.5,
      "validity_reasoning": "This is a technique recommendation, stable knowledge",
      "source_block_id": "blk_acmecorp_01A_T2",
      "confidence": 0.90
    },
    {
      "source_entity": "pd.read_csv",
      "target_entity": "converters",
      "relation_type": "USES",
      "fact_text": "pd.read_csv 可通过 converters 参数自定义列转换逻辑",
      "valid_at": "2026-03-28T14:32:18Z",
      "invalid_at": null,
      "validity_confidence": 0.2,
      "validity_reasoning": "Stable API knowledge, unlikely to change",
      "source_block_id": "blk_acmecorp_01A_T2",
      "confidence": 0.85
    }
  ]
}
```

#### Block T1（Trace 链路）的事实抽取

```json
{
  "facts": [
    {
      "source_entity": "python_executor",
      "target_entity": "pd.read_csv",
      "relation_type": "INVOKES",
      "fact_text": "python_executor 调用了 pd.read_csv 方法读取 data.csv",
      "valid_at": "2026-03-28T14:32:15Z",
      "invalid_at": null,
      "validity_confidence": 0.8,
      "validity_reasoning": "Specific invocation event, valid at execution time",
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.95
    },
    {
      "source_entity": "pd.read_csv",
      "target_entity": "data.csv",
      "relation_type": "MENTIONS",
      "fact_text": "pd.read_csv 读取了文件 data.csv，指定了 dtype 参数",
      "valid_at": "2026-03-28T14:32:15Z",
      "invalid_at": null,
      "validity_confidence": 0.9,
      "validity_reasoning": "File reference specific to this execution",
      "source_block_id": "blk_acmecorp_01A_S1",
      "confidence": 0.93
    }
  ]
}
```

#### 所有事实汇总

| #   | source          | relation   | target      | fact_text                         | valid_at    | source_block |
| --- | --------------- | ---------- | ----------- | --------------------------------- | ----------- | ------------ |
| F1  | pandas          | RELATES_TO | CSV         | 用户使用 pandas 处理 CSV 格式数据           | 03-28 14:32 | blk_01A_T1   |
| F2  | pd.read_csv     | USES       | dtype       | 建议通过 dtype 参数修复类型识别问题             | 03-28 14:32 | blk_01A_T2   |
| F3  | pd.read_csv     | USES       | converters  | pd.read_csv 可通过 converters 自定义列转换 | 03-28 14:32 | blk_01A_T2   |
| F4  | python_executor | INVOKES    | pd.read_csv | python_executor 调用了 pd.read_csv   | 03-28 14:32 | blk_01A_S1   |
| F5  | pd.read_csv     | MENTIONS   | data.csv    | pd.read_csv 读取了文件 data.csv        | 03-28 14:32 | blk_01A_S1   |
| F6  | pd.read_csv     | USES       | parse_dates | 建议用 parse_dates 处理日期列             | 03-28 14:35 | blk_01A_T4   |
| F7  | pd.read_csv     | USES       | date_parser | 配合 date_parser 自定义日期解析            | 03-28 14:35 | blk_01A_T4   |
| F8  | pandas          | RELATES_TO | pd.read_csv | pd.read_csv 是 pandas 的文件读取方法      | 03-28 14:32 | blk_01A_T2   |

---

## 4. Stage 3：实体去重与链接

> 对应方案文档：§5 Stage 3

### 4.1 Step 1：后处理归一化（规则层）

对所有抽取出的实体做基础规范化：

| 原始名称 | 归一化后 | 规则 |
|---------|---------|------|
| Pandas | pandas | 大小写统一 |
| pd | pandas | 缩写映射白名单 |
| csv文件 | CSV | 别名归一化 |
| read_csv | pd.read_csv | 补全限定词 |
| Python执行器 | python_executor | 中文别名映射 |

### 4.2 Step 2：候选召回

原型阶段 Milvus 未接入，使用字符串编辑距离召回候选（降级方案）。

假设图谱中已有以下实体（如果这是第一次构建则跳过此步）：

```
已有实体库: (空 — 首次构建)
```

首次构建时，所有实体直接作为新节点创建，进入 Stage 4。

### 4.3 Step 3：LLM 去重判断（跨 Block 内部去重）

即使是首次构建，同一批 Block 内部也可能出现重复。例如 `data.csv` 同时出自 blk_01A_T1 和 blk_01A_S1。

```
<EXISTING_ENTITIES>
[0] pandas (TOOL) — 数据处理库，别名: pd, Pandas
[1] pd.read_csv (TOOL) — pandas 的 CSV 读取方法，别名: read_csv
[2] data.csv (RESOURCE) — 数据文件
</EXISTING_ENTITIES>

<NEW_ENTITIES>
- "data.csv" (RESOURCE, 来自 blk_01A_S1)
- "read_csv" (TOOL, 来自 blk_01A_S1)
</NEW_ENTITIES>
```

LLM 返回：

```json
{
  "resolutions": [
    {
      "new_entity_name": "data.csv",
      "matched_candidate_id": 2,
      "merged_canonical_name": "data.csv"
    },
    {
      "new_entity_name": "read_csv",
      "matched_candidate_id": 1,
      "merged_canonical_name": "pd.read_csv"
    }
  ]
}
```

### 4.4 去重后实体终表

| entity_id | 名称 | 类型 | 别名 | 来源 Blocks |
|-----------|------|------|------|------------|
| ent_acmecorp_E01 | pandas | TOOL | [pd, Pandas] | blk_01A_T1, blk_01A_T2 |
| ent_acmecorp_E02 | CSV | CONCEPT | [csv文件] | blk_01A_T1 |
| ent_acmecorp_E03 | data.csv | RESOURCE | [] | blk_01A_T1, blk_01A_S1 |
| ent_acmecorp_E04 | pd.read_csv | TOOL | [read_csv] | blk_01A_T2, blk_01A_S1 |
| ent_acmecorp_E05 | dtype | CONCEPT | [] | blk_01A_T2, blk_01A_T3 |
| ent_acmecorp_E06 | converters | CONCEPT | [] | blk_01A_T2 |
| ent_acmecorp_E07 | parse_dates | CONCEPT | [] | blk_01A_T4 |
| ent_acmecorp_E08 | date_parser | CONCEPT | [] | blk_01A_T4 |
| ent_acmecorp_E09 | python_executor | TOOL | [Python执行器] | blk_01A_S1 |

---

## 5. Stage 4：Temporal KG 写入

> 对应方案文档：§6 Stage 4

### 5.1 写入 Neo4j 的节点

#### EntityNode（9 个）

```cypher
CREATE (:EntityNode {
  entity_id: "ent_acmecorp_E01",
  tenant_id: "acmecorp",
  name: "pandas",
  entity_type: "TOOL",
  aliases: ["pd", "Pandas"],
  summary: "Python 数据处理库，用户用于 CSV 读写",
  first_seen_at: datetime("2026-03-28T14:32:05Z"),
  last_seen_at: datetime("2026-03-28T14:32:18Z"),
  source_block_ids: ["blk_acmecorp_01A_T1", "blk_acmecorp_01A_T2"],
  created_at: datetime(), updated_at: datetime()
})

// ... 其余 8 个 EntityNode 类似结构，省略
```

#### EventNode（7 个 Session + 2 个 Trace = 共 9 个）

```cypher
// Session 链路事件
CREATE (:EventNode {
  event_id: "evt_acmecorp_01A_E1",
  tenant_id: "acmecorp",
  event_type: "problem",
  trigger: "用户报告 CSV 列类型被错误识别",
  event_time: datetime("2026-03-28T14:32:05Z"),
  time_resolution_confidence: 0.95,
  confidence: 0.92,
  session_id: "sess_acmecorp_01A",
  source_block_id: "blk_acmecorp_01A_T1",
  created_at: datetime()
})

// Trace 链路事件
CREATE (:EventNode {
  event_id: "evt_acmecorp_01A_TE1",
  tenant_id: "acmecorp",
  event_type: "tool_use",
  trigger: "python_executor 调用 read_csv 读取 data.csv",
  event_time: datetime("2026-03-28T14:32:15Z"),
  time_resolution_confidence: 0.95,
  confidence: 0.95,
  session_id: "sess_acmecorp_01A",
  source_block_id: "blk_acmecorp_01A_S1",
  created_at: datetime()
})
```

#### RawBlockRef（6 个）

```cypher
CREATE (:RawBlockRef {
  block_id: "blk_acmecorp_01A_T1",
  tenant_id: "acmecorp",
  source_type: "session",
  source_uri: "session://sess_acmecorp_01A/turn/1",
  timestamp: datetime("2026-03-28T14:32:05Z"),
  session_id: "sess_acmecorp_01A"
})

CREATE (:RawBlockRef {
  block_id: "blk_acmecorp_01A_S1",
  tenant_id: "acmecorp",
  source_type: "agent_trace",
  source_uri: "trace://sess_acmecorp_01A/step/1",
  timestamp: datetime("2026-03-28T14:32:15Z"),
  session_id: "sess_acmecorp_01A"
})

// ... 其余 4 个 RawBlockRef 类似
```

### 5.2 写入 Neo4j 的关系

#### 实体参与事件（PARTICIPATES_IN）

```cypher
// pandas 参与了"问题报告"事件
MATCH (e:EntityNode {entity_id: "ent_acmecorp_E01"}),
      (ev:EventNode {event_id: "evt_acmecorp_01A_E1"})
CREATE (e)-[:PARTICIPATES_IN {role: "subject"}]->(ev)

// python_executor 参与了"工具调用"事件
MATCH (e:EntityNode {entity_id: "ent_acmecorp_E09"}),
      (ev:EventNode {event_id: "evt_acmecorp_01A_TE1"})
CREATE (e)-[:PARTICIPATES_IN {role: "tool"}]->(ev)

// pd.read_csv 参与了"工具调用"事件
MATCH (e:EntityNode {entity_id: "ent_acmecorp_E04"}),
      (ev:EventNode {event_id: "evt_acmecorp_01A_TE1"})
CREATE (e)-[:PARTICIPATES_IN {role: "action"}]->(ev)
```

#### 带时间有效性的事实关系（Temporal Facts）

```cypher
// F1: pandas RELATES_TO CSV
MATCH (a:EntityNode {entity_id: "ent_acmecorp_E01"}),
      (b:EntityNode {entity_id: "ent_acmecorp_E02"})
CREATE (a)-[:RELATES_TO {
  fact_text: "用户使用 pandas 处理 CSV 格式数据",
  valid_at: datetime("2026-03-28T14:32:05Z"),
  invalid_at: null,
  validity_reasoning: "Active in current session, may change to other formats",
  confidence: 0.88,
  source_block_id: "blk_acmecorp_01A_T1"
}]->(b)

// F4: python_executor INVOKES pd.read_csv
MATCH (a:EntityNode {entity_id: "ent_acmecorp_E09"}),
      (b:EntityNode {entity_id: "ent_acmecorp_E04"})
CREATE (a)-[:INVOKES {
  fact_text: "python_executor 调用了 pd.read_csv 方法读取 data.csv",
  valid_at: datetime("2026-03-28T14:32:15Z"),
  invalid_at: null,
  validity_reasoning: "Specific invocation event, valid at execution time",
  confidence: 0.95,
  source_block_id: "blk_acmecorp_01A_S1"
}]->(b)

// F8: pandas RELATES_TO pd.read_csv（稳定语义关系）
MATCH (a:EntityNode {entity_id: "ent_acmecorp_E01"}),
      (b:EntityNode {entity_id: "ent_acmecorp_E04"})
CREATE (a)-[:RELATES_TO {
  fact_text: "pd.read_csv 是 pandas 库的文件读取方法",
  valid_at: datetime("2026-03-28T14:32:18Z"),
  invalid_at: null,
  validity_reasoning: "Stable semantic fact, unlikely to change",
  confidence: 0.92,
  source_block_id: "blk_acmecorp_01A_T2"
}]->(b)
```

#### 时序边（PRECEDES）

```cypher
// Session 内事件时序链
MATCH (e1:EventNode {event_id: "evt_acmecorp_01A_E1"}),
      (e2:EventNode {event_id: "evt_acmecorp_01A_E2"})
CREATE (e1)-[:PRECEDES {confidence: 0.95}]->(e2)

MATCH (e2:EventNode {event_id: "evt_acmecorp_01A_E2"}),
      (e3:EventNode {event_id: "evt_acmecorp_01A_E3"})
CREATE (e2)-[:PRECEDES {confidence: 0.95}]->(e3)

MATCH (e3:EventNode {event_id: "evt_acmecorp_01A_E3"}),
      (e4:EventNode {event_id: "evt_acmecorp_01A_E4"})
CREATE (e3)-[:PRECEDES {confidence: 0.90}]->(e4)

MATCH (e4:EventNode {event_id: "evt_acmecorp_01A_E4"}),
      (e5:EventNode {event_id: "evt_acmecorp_01A_E5"})
CREATE (e4)-[:PRECEDES {confidence: 0.95}]->(e5)
```

#### 事件溯源边（DERIVED_FROM）

```cypher
// 每个 EventNode 必须溯源到 RawBlockRef
MATCH (ev:EventNode {event_id: "evt_acmecorp_01A_E1"}),
      (ref:RawBlockRef {block_id: "blk_acmecorp_01A_T1"})
CREATE (ev)-[:DERIVED_FROM]->(ref)

MATCH (ev:EventNode {event_id: "evt_acmecorp_01A_TE1"}),
      (ref:RawBlockRef {block_id: "blk_acmecorp_01A_S1"})
CREATE (ev)-[:DERIVED_FROM]->(ref)

// ... 其余事件类似
```

#### Session-Trace 桥接边

这是"前分后合"策略的关键——连接 Session 视角与 Trace 视角：

```cypher
// 用户请求（E1: 问题报告）引出了 Agent 内部执行（TE1: 工具调用）
MATCH (e1:EventNode {event_id: "evt_acmecorp_01A_E1"}),
      (te1:EventNode {event_id: "evt_acmecorp_01A_TE1"})
CREATE (e1)-[:REQUEST_LEADS_TO {confidence: 0.85}]->(te1)

// Agent 的 dtype 建议（E2）尝试解决用户的问题（E1）
MATCH (e2:EventNode {event_id: "evt_acmecorp_01A_E2"}),
      (e1:EventNode {event_id: "evt_acmecorp_01A_E1"})
CREATE (e2)-[:ATTEMPTS_TO_SOLVE {confidence: 0.90}]->(e1)

// 工具执行结果（TE2）为 Agent 建议（E2）提供了证据
MATCH (te2:EventNode {event_id: "evt_acmecorp_01A_TE2"}),
      (e2:EventNode {event_id: "evt_acmecorp_01A_E2"})
CREATE (te2)-[:EVIDENCES {confidence: 0.88}]->(e2)
```

### 5.3 完整图谱可视化

```
                    ┌─────────────────────────────────────────────┐
                    │     Temporal KG（Session A 构建完成后）      │
                    └─────────────────────────────────────────────┘

  ┌──────────────┐                ┌──────────────┐
  │ RawBlockRef  │                │ RawBlockRef  │
  │ blk_01A_T1   │                │ blk_01A_S1   │
  │ (session)    │                │ (agent_trace)│
  └──────┬───────┘                └──────┬───────┘
         │ DERIVED_FROM                  │ DERIVED_FROM
         ▼                               ▼
  ┌──────────────┐  REQUEST_LEADS_TO  ┌──────────────┐
  │  EventNode   │ ─────────────────► │  EventNode   │
  │  evt_E1      │                    │  evt_TE1     │
  │  problem     │                    │  tool_use    │
  │  "CSV列类型  │                    │  "read_csv   │
  │   识别错误"  │                    │   被调用"    │
  └──────┬───────┘                    └──────┬───────┘
         │                                   │
    PARTICIPATES_IN                     PARTICIPATES_IN
    ┌────┴────┐                        ┌─────┼─────┐
    ▼         ▼                        ▼     ▼     ▼
 [pandas]  [CSV]              [python_   [pd.read  [data.csv]
 ent_E01   ent_E02             executor]  _csv]     ent_E03
                               ent_E09    ent_E04
    │                                      │
    │  RELATES_TO                          │
    └──────────────►[pd.read_csv]◄─────────┘
                     ent_E04    INVOKES
                        │
                   ┌────┼────┐
                   ▼    ▼    ▼
               [dtype] [parse  [converters]
               ent_E05  _dates] ent_E06
                        ent_E07

  时序链：
  evt_E1 ─PRECEDES─► evt_E2 ─PRECEDES─► evt_E3 ─PRECEDES─► evt_E4 ─PRECEDES─► evt_E5
  problem            solution            decision            problem             solution
```

---

## 6. 检索验证：六个问题的完整拆解

以下六个问题中，前四个来自原理文档 §2.2 "向量召回很难稳定回答，但知识图谱可以"的例子，后两个来自本场景的跨会话挑战。

### 6.0 检索架构概述（Hybrid Retrieval 三通道）

```
用户查询
  ┌────────────────────────────────────────────────────────┐
  │                  意图理解 + 查询拆解                    │
  └──────────┬─────────────────┬──────────────────┬────────┘
             ▼                 ▼                  ▼
  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
  │ 向量通道      │  │ 图谱通道          │  │ 上下文过滤    │
  │ (Milvus)     │  │ (Neo4j Cypher)   │  │ (session_id, │
  │ 语义相似      │  │ 路径遍历/时序/    │  │  时间窗,     │
  │ 实体候选      │  │ 关系查询          │  │  tenant_id)  │
  └──────┬───────┘  └────────┬─────────┘  └──────┬───────┘
         └──────────┬────────┘                    │
                    ▼                             │
           ┌──────────────┐                       │
           │  综合打分排序  │◄──────────────────────┘
           └──────┬───────┘
                  ▼
           ┌──────────────┐
           │  溯源还原     │
           │  EventNode → │
           │  RawBlockRef  │
           │  → 原始 turn  │
           └──────────────┘
```

---

**6 个检索验证问题：**

| 模拟文档问题                                    | 对应 1.3 类型       | 匹配度     | 说明                                                                                                                                                             |
| ----------------------------------------- | --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6.1** "pandas 和 read_excel 之间存在什么路径关系？" | **Q2 路径查询**     | ✅ 精确匹配  | 与 1.3 的 Q2 示例几乎一字不差                                                                                                                                            |
| **6.2** "sess_01A 里问题怎么从报错演化到解决方案？"       | **Q3 时间线重建**    | ✅ 精确匹配  | 沿 PRECEDES 链重建完整事件演化链，且展示了 Session-Trace 交织视角                                                                                                                  |
| **6.3** "read_excel 这次调用之前发生了什么？"         | **Q4 因果追溯**（部分） | ⚠️ 部分覆盖 | 这是**时序回溯**（PRECEDES 反向），不完全等于 1.3 的 Q4 定义。Q4 强调的是"请求 → 执行步骤 → 成功/失败"的因果链（REQUEST_LEADS_TO → EVIDENCES），这里侧重的是"某事件之前发生了什么"。因果追溯的**桥接边维度**在 6.2 中体现了，但没有作为独立问题展示 |
| **6.4** "用户昨天提到的工具，今天又出现在哪了？"             | **Q1 实体查询**     | ✅ 覆盖    | 这是 Q1 的一个变种——跨时间窗的实体复现追踪。核心是按 entity_id + 时间约束查询，属于实体查询范畴                                                                                                      |
| **6.5** "'上次那个问题'指的是什么？"                  | **Q5 跨会话指代解析**  | ✅ 精确匹配  | 完整展示了三通道检索 + 综合打分 + 溯源还原的全流程                                                                                                                                   |
| **6.6** "用户在'数据文件读取'主题上，方案怎么演化的？"         | **Q6 语义联想**（变种） | ⚠️ 部分覆盖 | 这更接近"知识演化追踪"（Q2 + Q1 的组合查询），而非纯粹的语义联想。1.3 的 Q6 强调的是"语义相似的历史情节"（依赖 SemanticCluster 或 embedding 相似性），6.6 用的是**指定实体群 + 时间排序**，并没有走 SemanticCluster 路径             |

### 6.1 问题 1：`pandas` 和 `read_excel` 之间存在什么路径关系？

> 来自原理文档 §2.2 示例

#### 意图理解

```yaml
query: "pandas 和 read_excel 之间存在什么路径关系？"
intent: path_query           # 查两个实体间的连接路径
entities_mentioned: [pandas, read_excel]
query_type: graph_traversal  # 纯图谱查询，不需要向量通道
```

#### 查询执行

```cypher
-- 1-2 跳路径查询
MATCH path = shortestPath(
  (a:EntityNode {name: "pandas", tenant_id: "acmecorp"})
  -[*1..2]-
  (b:EntityNode {name: "pd.read_excel", tenant_id: "acmecorp"})
)
RETURN path LIMIT 5
```

#### 结果

**假设 Session B 处理后 `pd.read_excel` 已入图**（见第 7 章）：

```
路径 1（2跳）：
  pandas ─[RELATES_TO]─► pd.read_csv ─[RELATES_TO]─► pd.read_excel

路径 2（1跳，如果存在直接关系）：
  pandas ─[RELATES_TO]─► pd.read_excel
```

**关键证据溯源**：

```
pd.read_csv ─[RELATES_TO]─► pd.read_excel
  → fact_text: "用户将 read_csv 的方案推广到 read_excel"
  → source_block_id: "blk_acmecorp_01B_T1"
  → valid_at: "2026-03-31T09:15:03Z"
```

#### 向量召回做不到的点

向量搜索 "pandas" 和 "read_excel" 只能告诉你它们语义相似（都是数据处理工具），但无法回答：
- 它们之间有几跳路径？
- 路径上经过了哪些中间实体？
- 这个关联是什么时候建立的？来自哪个对话？

---

### 6.2 问题 2：某个 session 里，问题是怎么从"报错"演化到"解决方案"的？

> 来自原理文档 §2.2 示例

#### 意图理解

```yaml
query: "sess_acmecorp_01A 里问题是怎么演化的？"
intent: timeline_reconstruction  # 重建时间线
scope: single_session
target: event_chain from problem to solution
```

#### 查询执行

```cypher
-- 按时间排序获取该 session 的所有事件
MATCH (ev:EventNode {session_id: "sess_acmecorp_01A", tenant_id: "acmecorp"})
OPTIONAL MATCH (ev)-[:DERIVED_FROM]->(ref:RawBlockRef)
OPTIONAL MATCH (entity:EntityNode)-[:PARTICIPATES_IN]->(ev)
RETURN ev, ref, collect(entity.name) AS participants
ORDER BY ev.event_time ASC
```

#### 结果：事件演化链

```
时间线重建结果（sess_acmecorp_01A）：

① 14:32:05 [problem] "CSV 列类型被错误识别"
    参与者: pandas, CSV
    来源: blk_01A_T1 → Turn 1 用户原话
    ↓ PRECEDES
② 14:32:15 [tool_use] "python_executor 调用 read_csv"  ← Trace 视角
    参与者: python_executor, pd.read_csv, data.csv
    来源: blk_01A_S1 → Trace step 1
    桥接: ① ─REQUEST_LEADS_TO─► ②
    ↓ PRECEDES
③ 14:32:15 [tool_result] "read_csv 成功，返回 DataFrame"
    参与者: pd.read_csv, data.csv
    来源: blk_01A_S1
    桥接: ③ ─EVIDENCES─► ④
    ↓ PRECEDES
④ 14:32:18 [solution] "Agent 建议使用 dtype 参数"
    参与者: pd.read_csv, dtype
    来源: blk_01A_T2 → Turn 2 Agent 回复
    桥接: ④ ─ATTEMPTS_TO_SOLVE─► ①
    ↓ PRECEDES
⑤ 14:35:42 [decision] "用户确认 dtype 修复了 float 问题"
    参与者: dtype
    来源: blk_01A_T3 → Turn 3 用户反馈
    ↓ PRECEDES
⑥ 14:35:42 [problem] "日期列仍有解析问题"  ← 新问题分叉
    参与者: pandas, parse_dates
    来源: blk_01A_T3
    ↓ PRECEDES
⑦ 14:35:55 [solution] "建议用 parse_dates + date_parser"
    参与者: parse_dates, date_parser, pd.read_csv
    来源: blk_01A_T4 → Turn 4 Agent 建议
```

**演化模式归纳**：`problem → tool_use → tool_result → solution → decision → problem(新) → solution`

#### 向量召回做不到的点

向量搜索能找到包含"报错"或"解决方案"的文本片段，但无法：
- 按时间排序重建完整演化链
- 区分"第一个问题"和"第二个问题"（都是 problem 类型）
- 展示 Session 视角（用户说了什么）和 Trace 视角（系统做了什么）的交织关系

---

### 6.3 问题 3：`read_excel` 这次调用之前发生了什么？

> 来自原理文档 §2.2 示例（改编：假设 Session B 触发了 read_excel 的 Trace）

#### 意图理解

```yaml
query: "read_excel 这次调用之前发生了什么？"
intent: backward_trace        # 从一个事件往前追溯
anchor_entity: pd.read_excel
anchor_event_type: tool_use
direction: backward (PRECEDES 的反向)
```

#### 查询执行

```cypher
-- 找到 pd.read_excel 参与的最近一次 tool_use 事件
MATCH (e:EntityNode {name: "pd.read_excel"})-[:PARTICIPATES_IN]->(ev:EventNode {event_type: "tool_use"})
WITH ev ORDER BY ev.event_time DESC LIMIT 1

-- 从该事件往前追溯（PRECEDES 的反向）
MATCH (prev:EventNode)-[:PRECEDES*1..5]->(ev)
OPTIONAL MATCH (entity:EntityNode)-[:PARTICIPATES_IN]->(prev)
RETURN prev, collect(entity.name) AS participants
ORDER BY prev.event_time ASC
```

#### 结果

```
read_excel 调用（假设 evt_01B_TE1）之前的事件链：

... ─► evt_E4 [problem "日期列仍有问题"]
    ─► evt_E5 [solution "建议 parse_dates"]
    ─► (跨会话间隔 3 天)
    ─► evt_01B_E1 [solution "用户报告换了读取方式，问题解决"]
    ─► evt_01B_TE1 [tool_use "read_excel 被调用"]  ← 锚点
```

#### 向量召回做不到的点

"read_excel 之前发生了什么"是一个**时序回溯查询**——需要从一个锚点沿 PRECEDES 边反向遍历。向量搜索无法理解"之前"这个时序方向。

---

### 6.4 问题 4：用户昨天提到的工具，今天又在哪个事件里出现了？

> 来自原理文档 §2.2 示例

#### 意图理解

```yaml
query: "用户昨天提到的工具，今天又出现在哪了？"
intent: cross_session_entity_tracking   # 跨时间追踪实体复现
time_constraint:
  yesterday: 2026-03-30    # 假设"今天"是 2026-03-31
  today: 2026-03-31
entity_filter: entity_type = "TOOL"
```

#### 查询执行

```cypher
-- Step 1: 找出"昨天"出现的 TOOL 实体
MATCH (e:EntityNode {entity_type: "TOOL", tenant_id: "acmecorp"})
      -[:PARTICIPATES_IN]->(ev1:EventNode)
WHERE ev1.event_time >= datetime("2026-03-30T00:00:00Z")
  AND ev1.event_time < datetime("2026-03-31T00:00:00Z")
WITH e

-- Step 2: 这些实体"今天"又参与了哪些事件？
MATCH (e)-[:PARTICIPATES_IN]->(ev2:EventNode)
WHERE ev2.event_time >= datetime("2026-03-31T00:00:00Z")
  AND ev2.event_time < datetime("2026-04-01T00:00:00Z")
OPTIONAL MATCH (ev2)-[:DERIVED_FROM]->(ref:RawBlockRef)
RETURN e.name, ev2.event_type, ev2.trigger, ref.source_uri
```

#### 结果

```
┌─────────────┬────────────┬──────────────────────────┬──────────────────────┐
│ 实体         │ 事件类型   │ 触发描述                 │ 来源                  │
├─────────────┼────────────┼──────────────────────────┼──────────────────────┤
│ pandas      │ solution   │ 用户报告问题已解决        │ session://01B/turn/1 │
│ pd.read_csv │ solution   │ 用户换了读取方式          │ session://01B/turn/1 │
└─────────────┴────────────┴──────────────────────────┴──────────────────────┘
```

> [!note] 场景适配说明
> 本模拟中 Session A 是 3 天前而非"昨天"。上表假设了更贴近"昨天/今天"的数据分布来展示查询模式。实际效果相同——核心是按 `event_time` 做时间窗交叉。

#### 向量召回做不到的点

这个查询的核心是**同一实体跨时间窗的复现检测**：
- 需要"昨天"和"今天"两个时间窗约束
- 需要确认是**同一个**实体（不是语义相似，而是 entity_id 相同）
- 向量搜索无法表达"同一实体在不同时间出现"这种结构化约束

---

### 6.5 问题 5："上次那个问题"指的是什么？（跨会话指代消解）

> 来自本场景 Session B 的核心挑战

#### 意图理解

```yaml
input: "上次那个问题，我换了一下读取方式，现在 Excel 也没问题了。"

intent_analysis:
  primary_intent: status_update        # 用户在汇报进展
  speech_act: inform_resolution        # 告知问题已解决
  temporal_signal: "上次"              # 指向过去
  anaphora:
    - "那个问题" → 需要回溯查找
    - "读取方式" → 需要关联到具体技术方案
  new_information:
    - "换了读取方式" → 用户采取了新行动
    - "Excel 也没问题" → 方案泛化到新格式
```

#### 查询拆解

```yaml
sub_queries:
  Q1_recent_problems:
    question: "该用户最近的未解决问题是什么？"
    channel: graph         # 图谱通道
    cypher: |
      MATCH (ev:EventNode {tenant_id: "acmecorp"})
      WHERE ev.event_type IN ["problem", "solution"]
      RETURN ev ORDER BY ev.event_time DESC LIMIT 5

  Q2_topic_match:
    question: "哪些历史事件与'读取方式'相关？"
    channel: vector + graph   # 混合通道
    steps:
      - 向量通道: "读取方式" embedding → 召回相似实体 → [pd.read_csv, pd.read_excel]
      - 图谱通道: 从召回实体出发遍历关联事件

  Q3_resolution_status:
    question: "候选事件中，哪些尚未被标记为 resolved？"
    channel: graph
    filter: "event_type = 'problem' AND 无后续 solution 事件"
```

#### 三通道执行与融合

**向量通道**：
```
query embedding("读取方式") → ANN search in Milvus
  → top-3: [pd.read_csv (0.91), pd.read_excel (0.87), converters (0.62)]
```

**图谱通道**：
```cypher
-- Q1: 最近未解决的问题
MATCH (ev:EventNode {event_type: "problem", tenant_id: "acmecorp"})
WHERE NOT exists {
  MATCH (ev)-[:PRECEDES*1..3]->(sol:EventNode {event_type: "solution"})
  WHERE sol.event_time > ev.event_time
}
RETURN ev ORDER BY ev.event_time DESC LIMIT 3

-- 结果:
-- evt_E4 [problem "日期列仍有问题"] — 有后续 solution(E5) 但为"建议"未确认
-- evt_E1 [problem "CSV列类型识别"] — 有部分解决(E3 decision)但非完全
```

**上下文过滤**：
```
tenant_id = "acmecorp"
时间窗: 最近 7 天
```

#### 综合打分

```yaml
Candidate: evt_E1 + evt_E4（同一问题链）

scoring:
  temporal_recency:  0.85   # 3天前，近期
  topic_overlap:     0.95   # "读取方式" ↔ pd.read_csv（向量通道命中）
  status_fit:        0.90   # 问题未完全解决，符合"那个问题"语义
  entity_continuity: 0.88   # pandas, pd.read_csv 都在链中

  final_score: 0.90

  ✅ "上次那个问题" = evt_E1→evt_E4 问题链
     (pandas 读取 CSV 时列类型识别问题 → dtype 部分修复 → 日期列仍有问题)
```

#### 溯源还原

```
匹配结果 → evt_E1 → DERIVED_FROM → blk_acmecorp_01A_T1
                                     ↓
                     原始文本: "我用 pandas 处理了一个 CSV，有个列的类型识别有问题。"
                     来源: session://sess_acmecorp_01A/turn/1
                     时间: 2026-03-28T14:32:05Z
```

---

### 6.6 问题 6：用户的方案演化轨迹是什么？（知识演化追踪）

#### 意图理解

```yaml
query: "用户在'数据文件读取'这个主题上，方案是怎么演化的？"
intent: knowledge_evolution_tracking
topic: 数据文件读取
```

#### 查询执行

```cypher
-- 找到与"数据文件读取"相关的实体群
MATCH (e:EntityNode)
WHERE e.name IN ["pd.read_csv", "pd.read_excel", "pandas", "dtype", "parse_dates"]
  AND e.tenant_id = "acmecorp"

-- 找到这些实体参与的所有事件，按时间排序
MATCH (e)-[:PARTICIPATES_IN]->(ev:EventNode)
RETURN ev.event_type, ev.trigger, ev.event_time,
       collect(e.name) AS involved_entities
ORDER BY ev.event_time ASC
```

#### 结果：方案演化时间线

```
2026-03-28 14:32  [problem]   CSV列类型识别错误           {pandas, CSV}
2026-03-28 14:32  [tool_use]  python_executor→read_csv   {python_executor, pd.read_csv}
2026-03-28 14:32  [solution]  建议: dtype参数             {pd.read_csv, dtype}
2026-03-28 14:35  [decision]  dtype修复了float问题        {dtype}
2026-03-28 14:35  [problem]   日期列仍有问题              {pandas, parse_dates}
2026-03-28 14:35  [solution]  建议: parse_dates           {parse_dates, date_parser, pd.read_csv}
      ↓ 3天间隔
2026-03-31 09:15  [solution]  用户自行解决，Excel也没问题  {pandas, pd.read_excel}
```

**Temporal Fact 演化**：

```
关系: pandas ─RELATES_TO─► CSV
  valid_at: 2026-03-28   invalid_at: null

关系: pandas ─RELATES_TO─► Excel     ← 新增
  valid_at: 2026-03-31   invalid_at: null
  validity_reasoning: "用户报告方案已推广到Excel格式"

关系: pd.read_csv ─USES─► dtype
  valid_at: 2026-03-28   invalid_at: null
  fact_text 更新: "dtype方案部分有效，用户后续换了其他读取方式"
```

---

## 7. 知识演化：Session B 进来后图谱怎么更新

> 对应方案文档：§6.3 冲突与更新处理，原理文档：§5.1 Resolution + Update

当 Session B（blk_acmecorp_01B_T1）进入 Pipeline 时，Stage 2 抽取出新的实体、事件和事实。Stage 4 写入时，不是无脑追加，而是与已有图谱比对：

### 7.1 新增 Raw Block

```json
{
  "block_id": "blk_acmecorp_01B_T1",
  "tenant_id": "acmecorp",
  "source_type": "session",
  "content": "user: 上次那个问题，我换了一下读取方式，现在 Excel 也没问题了。",
  "metadata": {
    "timestamp": 1743422103,
    "source_uri": "session://sess_acmecorp_01B/turn/1",
    "session_id": "sess_acmecorp_01B",
    "turn_index": 1,
    "speaker": "user"
  }
}
```

### 7.2 Stage 2 抽取结果

**实体**：
```json
[
  {"name": "Excel", "entity_type": "CONCEPT", "aliases": ["xlsx", "xls文件"], "confidence": 0.90},
  {"name": "pd.read_excel", "entity_type": "TOOL", "aliases": ["read_excel"], "confidence": 0.75}
]
```

> [!note] `pd.read_excel` 的 confidence 只有 0.75
> 因为用户原文说的是"换了一下读取方式"，LLM 推断可能是 read_excel 但不确定。这里体现了 Prompt 2a 中"不确定时 confidence 设为 0.3-0.5"的规则。0.75 表示有较强推断依据但非直接证据。

**事件**：
```json
[
  {
    "event_id": "evt_acmecorp_01B_E1",
    "event_type": "solution",
    "trigger": "用户报告已更换读取方式解决问题，Excel 也可正常处理",
    "participants": ["pandas", "pd.read_excel", "Excel"],
    "event_time": "2026-03-31T09:15:03Z",
    "time_resolution_confidence": 0.95,
    "source_block_id": "blk_acmecorp_01B_T1",
    "confidence": 0.88
  }
]
```

**事实**：
```json
[
  {
    "source_entity": "pandas",
    "target_entity": "Excel",
    "relation_type": "RELATES_TO",
    "fact_text": "用户使用 pandas 成功处理了 Excel 文件",
    "valid_at": "2026-03-31T09:15:03Z",
    "invalid_at": null,
    "validity_confidence": 0.4,
    "validity_reasoning": "User confirmed working, likely to continue using",
    "source_block_id": "blk_acmecorp_01B_T1",
    "confidence": 0.85
  },
  {
    "source_entity": "pd.read_csv",
    "target_entity": "pd.read_excel",
    "relation_type": "RELATES_TO",
    "fact_text": "用户将 read_csv 上的修复方案推广到了 read_excel",
    "valid_at": "2026-03-31T09:15:03Z",
    "invalid_at": null,
    "validity_confidence": 0.3,
    "validity_reasoning": "Stable knowledge about method similarity",
    "source_block_id": "blk_acmecorp_01B_T1",
    "confidence": 0.78
  }
]
```

### 7.3 Stage 3 去重

新实体 `pandas` 需要与已有图谱比对：

```
<EXISTING_ENTITIES>
[0] pandas (TOOL) — 数据处理库，别名: pd, Pandas
[1] pd.read_csv (TOOL) — pandas 的 CSV 读取方法
...
</EXISTING_ENTITIES>

<NEW_ENTITIES>
- "Excel" (CONCEPT)       → matched_candidate_id: -1 (新实体)
- "pd.read_excel" (TOOL)  → matched_candidate_id: -1 (新实体)
- "pandas" (TOOL)         → matched_candidate_id: 0  (复用已有)
</NEW_ENTITIES>
```

### 7.4 Stage 4 图谱更新

| 操作 | 对象 | 详情 |
|------|------|------|
| **新增节点** | EntityNode `Excel` | ent_acmecorp_E10，类型 CONCEPT |
| **新增节点** | EntityNode `pd.read_excel` | ent_acmecorp_E11，类型 TOOL |
| **新增节点** | EventNode `evt_01B_E1` | solution，"用户报告问题已解决" |
| **新增节点** | RawBlockRef `blk_01B_T1` | session，来源 Session B |
| **更新已有** | EntityNode `pandas` | last_seen_at 更新为 2026-03-31，追加 source_block_ids |
| **新增边** | pandas ─RELATES_TO─► Excel | 带 valid_at, validity_reasoning |
| **新增边** | pd.read_csv ─RELATES_TO─► pd.read_excel | 方案推广关系 |
| **新增边** | evt_E5 ─PRECEDES─► evt_01B_E1 | 跨会话时序链接（间隔 3 天） |
| **新增边** | evt_01B_E1 ─DERIVED_FROM─► blk_01B_T1 | 溯源 |
| **语义标注** | evt_01B_E1 ─ATTEMPTS_TO_SOLVE─► evt_E1 | 该 solution 解决了最初的 problem |

### 7.5 更新后的图谱增量

```
  Session A 子图（已有）                    Session B 新增
  ─────────────────────                    ────────────────

                                          ┌──────────────┐
                                          │ RawBlockRef  │
                                          │ blk_01B_T1   │
                                          └──────┬───────┘
                                                 │ DERIVED_FROM
                                                 ▼
  evt_E5 ──────────PRECEDES──────────────► evt_01B_E1
  [solution:                               [solution:
   "建议parse_dates"]                       "用户报告已解决
                                             Excel也没问题"]
                                                 │
                                            PARTICIPATES_IN
                                           ┌─────┼─────┐
                                           ▼     ▼     ▼
                                        [pandas] [Excel] [pd.read_excel]
                                        (已有,    (新)    (新)
                                         更新)

  evt_01B_E1 ──ATTEMPTS_TO_SOLVE──► evt_E1 [problem: "CSV列类型识别"]
```

---

## 8. 端到端流水线总结

### 8.1 Pipeline 全景

```
Session 原始消息流 ──► Stage 0 ──► NormalizedSession ──┐
                      (输入适配)                       │
                                                      ├──► Stage 1 ──► Raw Block
                                                      │    (Block生成)   (原料层)
Trace 原始日志 ──────► Stage 0 ──► NormalizedTrace ───┘
                      (输入适配)                              │
                                                             ▼
                                                      Stage 2: LLM 抽取
                                                      ┌──────────────────┐
                                                      │ 2a 实体抽取       │
                                                      │ 2b 事件抽取       │
                                                      │ 2c 关系/事实抽取  │
                                                      └────────┬─────────┘
                                                               ▼
                                                      Stage 3: 实体去重
                                                      ┌──────────────────┐
                                                      │ 规则归一化        │
                                                      │ 向量候选(可选)    │
                                                      │ LLM candidate-ID │
                                                      └────────┬─────────┘
                                                               ▼
                                                      Stage 4: KG 写入
                                                      ┌──────────────────┐
                                                      │ Neo4j 图谱写入    │
                                                      │ Milvus 向量(可选) │
                                                      └────────┬─────────┘
                                                               ▼
                                                      Temporal KG
                                                      ┌──────────────────┐
                                                      │ EntityNode       │
                                                      │ EventNode        │
                                                      │ RawBlockRef      │
                                                      │ 时序边/事实边     │
                                                      │ 桥接边           │
                                                      └────────┬─────────┘
                                                               ▼
                                                      检索验证
                                                      ┌──────────────────┐
                                                      │ Hybrid Retrieval │
                                                      │ 向量+图谱+过滤   │
                                                      │ 溯源还原         │
                                                      └──────────────────┘
```

### 8.2 本场景的数据量统计

| 对象 | 数量 | 说明 |
|------|------|------|
| 原始 Session turns | 5 | Session A: 4 turns + Session B: 1 turn |
| 原始 Trace steps | 1 | Session A 的 1 个工具调用 |
| Raw Blocks | 6 | 5 session + 1 trace |
| LLM 调用次数 | 18 | 6 blocks × 3 prompts (2a+2b+2c) |
| 去重 LLM 调用 | 2 | 批内去重 + Session B 入图时去重 |
| EntityNode | 11 | 9(Session A) + 2(Session B 新增) |
| EventNode | 9 | 7(Session链路) + 2(Trace链路)，Session B 再+1 |
| RawBlockRef | 6 | 与 Raw Block 一一对应 |
| 事实关系边 | 10 | 8(Session A) + 2(Session B) |
| 时序边(PRECEDES) | 6 | Session A 内 5 条 + 跨会话 1 条 |
| 桥接边 | 3 | REQUEST_LEADS_TO, ATTEMPTS_TO_SOLVE, EVIDENCES |

### 8.3 六个检索问题的能力覆盖

| # | 问题 | 核心能力 | 向量能做？ | 图谱能做？ |
|---|------|---------|-----------|-----------|
| 1 | pandas 和 read_excel 的路径关系 | 路径遍历 | ❌ 只知道"像" | ✅ 1-2跳路径 + 中间实体 |
| 2 | session 内问题演化链 | 时序重建 | ❌ 无法排序/串联 | ✅ PRECEDES 链 + 桥接边 |
| 3 | read_excel 调用前发生了什么 | 反向时序追溯 | ❌ 无"之前"概念 | ✅ PRECEDES 反向遍历 |
| 4 | 昨天的工具今天又出现在哪 | 跨时间窗实体追踪 | ❌ 无时间窗交叉 | ✅ entity_id + event_time |
| 5 | "上次那个问题"指代消解 | 混合检索 | ⚠️ 能找相似片段 | ✅ 时序+实体+状态三维打分 |
| 6 | 方案演化轨迹 | 知识演化追踪 | ❌ 无 valid_at/invalid_at | ✅ Temporal Fact + 事件链 |

### 8.4 关键设计决策回顾

| 决策 | 为什么 | 对应文档章节 |
|------|-------|------------|
| Block 是原子 turn，不做语义聚合 | 语义抽取由 LLM 完成，Block 只是原料 | 方案 §3 |
| 三个独立 LLM prompt 串联 | 各司其职，结构化输出可验证 | 方案 §4 |
| candidate-ID 去重而非字符串匹配 | 编号消除 LLM 文本生成歧义 | 方案 §5，Graphiti |
| 关系边带 valid_at/invalid_at | 事实会过期或被替代，不只是有/无 | 原理 §5.1 Temporal Fact |
| validity_reasoning 字段 | 主动预测事实有效期，减少僵尸事实 | 原理 §6.2 EverMemOS Foresight |
| Session-Trace 桥接边 | 前分后合，连接用户视角与系统视角 | 原理 §3.4 |
| EventNode 是一等公民 | 时序链的挂载点，Session/Trace 的桥接点 | 原理 §4.1 |
| RawBlockRef 轻量溯源 | 记忆出错时能追回原始证据 | 原理 §4.3 |


---

*本文档用一个具体场景走通了 Group 3 记忆构建模块的完整 Pipeline，从原始对话到 Temporal KG 再到检索验证。所有术语和 Schema 对齐最新版方案文档。*
