---
title: 第5章 混合抽取 Pipeline（重构版）
date: 2026-04-16
tags:
  - AMS
  - 抽取Pipeline
  - 粒度控制
status: 草稿
---

# 第5章 混合抽取 Pipeline（Encoder + LLM）—— 重构版

> **与原第5章的关系**：本文是对原方案设计第5章的完整重写。核心变化：引入**抽取粒度控制层**（Block 前置过滤、语义分层、Window 调度、事件后处理），解决原方案"per-block 机械抽取"导致的图谱膨胀和跨 turn 事件断裂问题。模型选型和 Layer 1/2/3 分层架构保留原有设计，在此基础上补全粒度控制的工程实现。

---

## 5.1 设计思路：为什么选择混合架构

本系统的核心抽取任务（实体、事件、关系）采用 **"LLM 主抽取 + Encoder 选择性辅助"** 的混合架构。 
参考： [[AMS-实体关系抽取选型及实验验证报告（重构版）]]   [[AMS-实体关系抽取-路线图-进一步思考]]

> ⚠️ **叙事演进说明**：经实验验证（详见《AMS 实体关系抽取选型及实验验证报告（重构版）》§4），GLiNER 系列 Encoder 在中文会话场景表现远逊预期，而 4B 级小 LLM（gemma4-e4b）全面碾压 Encoder。因此架构主次关系为：**小 LLM 为中文会话的主抽取器，Encoder 退居为英文 Trace 专用通道和降级 fallback**。

### Transformer 三大架构与任务适配

| 架构 | 代表模型 | 注意力机制 | 擅长任务 |
|------|---------|-----------|---------|
| **Encoder-only** | BERT, DeBERTa, ModernBERT | 双向注意力 | 分类、序列标注（NER）、关系分类 |
| **Decoder-only** | GPT 系列 | 单向注意力 | 文本生成、开放推理 |
| **Encoder-Decoder** | T5, BART | 编码器双向 + 解码器单向 | 翻译、摘要、生成式抽取 |

**关键洞察1**：==双向注意力的结构性优势只在训练分布内兑现==——在英文标准语料、封闭标签集、边界清晰的名词短语场景下，Encoder-only 模型（86-350M）更快且往往更准。但当 Encoder 的预训练数据中目标语言覆盖不足时（如 GLiNER 的中文覆盖），理论优势无法兑现。

**关键洞察2**：在中文会话场景中，当前开源 GLiNER checkpoints 表现远逊于预期——实测显示它们甚至无法正确抽取"上海"（被标为整句）、"理财"（0 hits）等基础实体。因此==在当前中文 AMS 场景下，GLiNER 应被定位为快速候选生成器或高置信过滤层，而非抽取主力==。

### 任务-模型匹配矩阵

| 任务                   | 最佳架构                    | 推荐模型                        | 原因                          |
| -------------------- | ----------------------- | --------------------------- | --------------------------- |
| NER - 英文 Trace       | Encoder-only            | GLiNER / ModernBERT-GLiNER  | 双向编码在英文标准语料下最有效             |
| NER - **中文会话**       | **Decoder-only（小 LLM）** | **Qwen2.5-7B / gemma4-e4b** | 中文预训练充分；GLiNER 中文 span 边界失效 |
| 预定义关系分类 - 英文         | Encoder-only            | GLiNER-RelEx                | 经典分类任务                      |
| 预定义关系分类 - **中文**     | **Decoder-only（小 LLM）** | **Qwen2.5-7B / gemma4-e4b** | 与 NER 一步完成，无管道错误传播          |
| **中文联合抽取（实体+关系+事件）** | **Decoder-only（小 LLM）** | **Qwen2.5-7B + JSON 结构化输出** | 一次调用同时输出，避免管道式错误传播          |
| 时效推理（Foresight）      | Decoder-only            | LLM（GPT-4o/Claude）          | 需要链式思考 + 世界知识               |
| 开放关系发现               | Decoder-only            | LLM                         | 需要创造性生成新关系类型                |
| 跨句因果推断               | Decoder-only            | LLM                         | 需要长程推理能力                    |

### 混合架构的核心论点

**"根据语言和数据源，用最合适的模型做主抽取"**：

- **中文会话 Session** → 小 LLM（Qwen2.5-7B / gemma4-e4b）
- **英文 Trace / 结构化文本** → Encoder（GLiNER-RelEx）
- **Foresight / 开放推理 / 复杂整合** → 大 LLM

| 维度 | 全规则方案 | 全 LLM 方案 | **本方案（小 LLM 主抽取 + Encoder 辅助）** |
|------|----------|------------|-------------------------------------|
| 开发速度 | 慢 | 快 | 中 |
| 运行成本 | ~$0 | ~$300/天（万级 block） | 中文 ~$200-250/天；本地 7B 后 ~$30-50/天 |
| 覆盖面 | 受限于规则完备性 | 全面 | 全面 |
| 中文准确率 | 中 | 高 | **高** |
| 英文准确率 | 中 | 高 | **更高** |


---

## 5.2 整体架构总览（重构版）

原第5章的 pipeline 是 **per-block 单次调用**：每个 RawBlock 独立走 Layer 0→1→2→3，不区分 block 价值，不处理跨 block 语义。重构版在原有 Layer 分层之上，增加了**粒度控制层**，形成五层架构：

```
                         Session / Trace 原始数据
                                  |
                    +-------------+---------------+
                    |                             |
              Session Blocks                Trace Blocks
                    |                             |
          +-------- v --------+                   |
          | (1) Pre-Filter    | <-- Block 级价值评估
          | (跳过/简抽/全抽)   |                   |
          +-------- | --------+                   |
                    |                             |
          +-------- v --------+                   |
          | (2) Window        |                   |
          |  Scheduler        | <-- 决定喂入哪些 block
          |  (单block/滑窗/   |                   |
          |   全session)      |                   |
          +-------- | --------+                   |
                    |                             |
          +-------- v --------------------- v ----+
          |        (3) 抽取 Pipeline               |
          |   Layer 0: 语言/数据源路由              |
          |   Layer 1: 模型抽取                    |
          |   Layer 2: 规则后处理                   |
          |   Layer 3: 大 LLM 精修                 |
          +-------- | ----------------------------+
                    |
          +-------- v --------+
          | (4) 语义分层       | <-- L0/L1/L2 标注
          |  (决定入图策略)    |
          +-------- | --------+
                    |
          +-------- v --------+
          | (5) Event         | <-- 去重/合并/拆分
          |  Post-Processor   |
          +-------- | --------+
                    |
                    v
          EntityNode / EventNode / 过滤掉
```

**核心设计原则**：

> **RawBlock 是存储和溯源的粒度，EventNode 是记忆和推理的粒度。两者解耦，各自优化。**

原方案的 Layer 0/1/2/3 解决的是"用什么模型抽"的问题。重构版新增的 (1)(2)(4)(5) 解决的是"抽什么、怎么组织、什么入图"的问题。

---

## 5.3 (1) Pre-Filter：Block 级价值评估

### 5.3.1 为什么需要前置过滤

原方案中，每个 RawBlock 无差别地走完整 pipeline（Layer 0→1→2→3）。但一个 30-turn 会话中，大量 turn 是低价值的：

| Turn 类型 | 占比 | 典型内容 | 抽取价值 |
|-----------|------|---------|---------|
| Assistant 礼节/确认 | ~25-30% | "好的"、"收到"、"我来看看" | **零** |
| 用户简单确认 | ~10-15% | "嗯"、"对"、"继续" | **零** |
| 信息传递型陈述 | ~10-15% | "我们的数据按天分区" | **中**（只需抽实体，不建事件） |
| 有意义的交互 | ~40-50% | 请求、问题、方案、决策 | **高** |

如果不做前置过滤，30 个 block 都走 LLM 抽取，至少浪费 30-50% 的 token 成本在零价值内容上。

### 5.3.2 三级评估策略

Pre-Filter 对每个 block 做快速评估，分为三个处理级别：

| 级别 | 判断条件 | 处理方式 | 成本 |
|------|---------|---------|------|
| **SKIP** | 纯礼节/确认/空内容 | 不进入抽取 pipeline，只保留 RawBlock | ~0 |
| **ENTITY_ONLY** | 信息传递型陈述（L1 层级） | 只抽实体和关系，不建 EventNode | Layer 1 成本 |
| **FULL** | 有意义的交互（L2 层级） | 走完整 pipeline | 全量成本 |

### 5.3.3 实现方式：规则优先 + 小模型兜底

```python
import re

# === 规则层：处理明确的 SKIP 情况 ===

SKIP_PATTERNS = [
    # Assistant 礼节
    r'^(好的|收到|明白|了解|没问题|OK|Got it|Sure|I see|Let me)[\s,.!。！]*$',
    # 用户确认
    r'^(嗯|对|是的|ok|yes|继续|go on|right)[\s,.!。！]*$',
    # 纯 emoji / 表情
    r'^[\s\U0001F600-\U0001F64F\U0001F300-\U0001F5FF]+$',
]

def rule_based_prefilter(block: RawBlock) -> str | None:
    """规则判断，能确定的直接返回级别，不确定返回 None"""
    text = block.content.strip()
    
    # 空内容或极短内容
    if len(text) < 5:
        return "SKIP"
    
    # 匹配 SKIP 模式
    for pattern in SKIP_PATTERNS:
        if re.match(pattern, text, re.IGNORECASE):
            return "SKIP"
    
    # Trace block 始终 FULL（结构化数据，无礼节内容）
    if block.source_type == "trace":
        return "FULL"
    
    return None  # 规则无法判断，交给小模型

# === 小模型层：处理规则无法判断的情况 ===

PREFILTER_PROMPT = """对以下对话内容做价值评估，只输出一个词：SKIP / ENTITY_ONLY / FULL

判断标准：
- SKIP：纯礼节、确认、无信息量的回复
- ENTITY_ONLY：陈述背景事实、声明环境/工具/配置，没有"发生"什么
- FULL：包含请求、问题、方案、决策、工具使用、错误报告等有行动意义的内容

内容：{content}

评估结果："""

async def prefilter_block(block: RawBlock) -> str:
    """Pre-Filter 入口：规则优先，小模型兜底"""
    # Step 1: 规则判断
    rule_result = rule_based_prefilter(block)
    if rule_result is not None:
        return rule_result
    
    # Step 2: 小模型判断（用最轻量的模型，如 gemma4-e4b 或 Qwen2.5-1.5B）
    resp = await small_llm_classify(
        PREFILTER_PROMPT.format(content=block.content[:500])
    )
    level = resp.strip().upper()
    return level if level in ("SKIP", "ENTITY_ONLY", "FULL") else "FULL"  # 默认保守
```

### 5.3.4 成本影响估算

以 30-turn 会话为例：

| 无 Pre-Filter | 有 Pre-Filter | 节省 |
|--------------|--------------|------|
| 30 blocks x 全量 pipeline | ~8 SKIP + ~5 ENTITY_ONLY + ~17 FULL | |
| 30 次 LLM 调用 | 17 次全量 + 5 次 Layer 1 only | **~40-50% token 成本** |


---

## 5.4 (2) Window Scheduler：跨 Block 上下文调度

### 5.4.1 核心问题

原方案 per-block 单次调用 LLM，无法处理：

1. **一个事件跨多个 turn**：用户分 3 轮补全一个订票请求，应合并为一个 EventNode
2. **一个 turn 包含多个事件**：用户一句话说"dtype 问题解决了，但日期列还有问题"，应拆为两个 EventNode
3. **指代消解依赖上文**：第 5 轮说"那个库"，需要第 3 轮的上下文才能消解为"pandas"

这些问题的根因是：**LLM 的一次调用看到的上下文不够**。

### 5.4.2 三种调度策略

Window Scheduler 根据 session 长度和 block 评估级别，选择不同的调度策略：

#### 策略 A：Session 级批处理（短会话）

**适用条件**：session 内 FULL 级 block <= 15 个（约 <= 30 turns）

```
整个 session 的所有 FULL block --> 一次 LLM 调用
```

- 把所有 FULL 级 block 的内容拼接，一次性喂给 LLM
- LLM 有全局视野，天然能合并/拆分事件，消解指代
- **优点**：最高质量；无去重问题
- **缺点**：长 session 超 context window；一次调用 token 量大
- **成本**：一次大调用约等于多次小调用的总 token 量，但省去了去重开销

```python
def schedule_session_batch(blocks: list[RawBlock]) -> list[ExtractionWindow]:
    """策略 A：全 session 一次调用"""
    full_blocks = [b for b in blocks if b.prefilter_level == "FULL"]
    return [ExtractionWindow(
        blocks=full_blocks,
        strategy="session_batch",
        context_blocks=[b for b in blocks if b.prefilter_level == "ENTITY_ONLY"],
    )]
```

#### 策略 B：滑动窗口（长会话）

**适用条件**：session 内 FULL 级 block > 15 个

```
Window 1: [Block 1, 2, 3, 4, 5]     --> LLM 调用 1
Window 2: [Block 3, 4, 5, 6, 7]     --> LLM 调用 2
Window 3: [Block 5, 6, 7, 8, 9]     --> LLM 调用 3
...
```

- 窗口大小 = 5 个 FULL block（约 10 turns），步长 = 2-3（重叠 2-3 个 block）
- 重叠部分保证跨窗口事件不被截断
- 每个窗口额外携带前 1-2 个 ENTITY_ONLY block 作为背景上下文（不要求抽取事件，仅供指代消解）
- **优点**：可处理任意长度 session
- **缺点**：重叠区域产出的事件需要去重

```python
def schedule_sliding_window(
    blocks: list[RawBlock],
    window_size: int = 5,
    stride: int = 3
) -> list[ExtractionWindow]:
    """策略 B：滑动窗口"""
    full_blocks = [b for b in blocks if b.prefilter_level == "FULL"]
    entity_blocks = [b for b in blocks if b.prefilter_level == "ENTITY_ONLY"]

    windows = []
    for i in range(0, len(full_blocks), stride):
        window_blocks = full_blocks[i:i + window_size]
        if not window_blocks:
            break

        # 查找窗口时间范围内的 ENTITY_ONLY block 作为上下文
        window_start = window_blocks[0].timestamp
        window_end = window_blocks[-1].timestamp
        context = [b for b in entity_blocks
                   if window_start <= b.timestamp <= window_end]

        windows.append(ExtractionWindow(
            blocks=window_blocks,
            strategy="sliding_window",
            context_blocks=context,
            overlap_block_ids=[b.block_id for b in window_blocks[:window_size - stride]],
        ))
    return windows
```

#### 策略 C：Trace 独立处理

**适用条件**：Trace 数据源

Trace block 天然是结构化的（tool_use + tool_result），不存在语义模糊。但需要聚合连续的探索性调用：

```python
def schedule_trace(blocks: list[RawBlock]) -> list[ExtractionWindow]:
    """策略 C：Trace 按工具调用链分组"""
    windows = []
    current_group = []

    for block in blocks:
        if block.trace_step_type == "tool_use":
            current_group.append(block)
        elif block.trace_step_type == "tool_result":
            current_group.append(block)
            # 遇到状态变化或不同工具 --> 切分窗口
            if is_state_changing(block) or len(current_group) >= 6:
                windows.append(ExtractionWindow(
                    blocks=current_group,
                    strategy="trace_group",
                ))
                current_group = []

    if current_group:
        windows.append(ExtractionWindow(blocks=current_group, strategy="trace_group"))
    return windows
```

### 5.4.3 调度器入口

```python
@dataclass
class ExtractionWindow:
    blocks: list[RawBlock]           # 需要抽取的 block
    strategy: str                     # session_batch / sliding_window / trace_group
    context_blocks: list[RawBlock] = field(default_factory=list)  # 仅供上下文，不抽取事件
    overlap_block_ids: list[str] = field(default_factory=list)    # 标记重叠区域

def schedule_extraction(session: Session) -> list[ExtractionWindow]:
    """Window Scheduler 入口"""
    trace_blocks = [b for b in session.blocks if b.source_type == "trace"]
    session_blocks = [b for b in session.blocks if b.source_type == "session"]

    windows = []

    if trace_blocks:
        windows.extend(schedule_trace(trace_blocks))

    full_count = sum(1 for b in session_blocks if b.prefilter_level == "FULL")
    if full_count <= 15:
        windows.extend(schedule_session_batch(session_blocks))
    else:
        windows.extend(schedule_sliding_window(session_blocks))

    return windows
```

### 5.4.4 Window 内的 LLM Prompt 结构

多 block 喂入时，prompt 需要清晰标记每个 block 的边界和角色：

```
你是一个从 Agent 对话中提取实体、关系和事件的专家。

以下是一段连续的多轮对话，包含 {n} 个对话片段。请基于整体语义进行抽取。

【背景上下文（仅供理解，不需要从中抽取事件）】
[CONTEXT block_id="{block_id}" role="{role}" time="{timestamp}"]
{content}
[END_CONTEXT]
...

【需要抽取的对话片段】
[BLOCK block_id="{block_id}" role="{role}" time="{timestamp}"]
{content}
[END_BLOCK]
...

【抽取要求】
1. 实体：抽取在交互中被激活的实体（工具、概念、资源、人物、组织、操作）
2. 关系：抽取实体之间的关系，每条关系必须指向已抽取的实体
3. 事件：**一发生一 event，不是一 block 一 event**
   - 如果多个 block 是在补全同一个请求或讨论同一个问题 --> 合并为一个 EventNode
   - 如果一个 block 包含多个独立语义单元 --> 拆分为多个 EventNode
   - 每个 EventNode 的 source_block_ids 记录所有来源 block
4. 过滤：纯礼节、确认、无信息量的内容不要建 EventNode

请严格按照 JSON schema 输出。
```


---

## 5.5 (3) 抽取 Pipeline（Layer 0/1/2/3）

本节沿用原方案的分层抽取架构，关键变化是：**输入从单个 RawBlock 变为 ExtractionWindow（可能包含多个 block）**。

### 5.5.1 Layer 0：语言/数据源路由

每个 ExtractionWindow 进入路由，按语言和数据源类型分流：

```python
def detect_route(window: ExtractionWindow) -> str:
    """根据窗口内容判断抽取路径"""
    # Trace 窗口直接走英文路径
    if window.strategy == "trace_group":
        return "en_trace"
    # 检测主要语言
    all_text = " ".join(b.content for b in window.blocks)
    chinese_ratio = sum(1 for c in all_text if '\u4e00' <= c <= '\u9fff') / max(len(all_text), 1)
    return "zh_session" if chinese_ratio > 0.1 else "en_trace"
```

### 5.5.2 Layer 1：模型抽取（分路径）

**英文 Trace 路径（Encoder）**：

| 模型 | 底座 | 参数量 | 适用场景 |
|------|------|--------|---------|
| `gliner-relex-multi-v1.0` | mDeBERTa-v3-base | ~86M | 英文 Trace / 结构化文本 |
| `modern-gliner-bi-large-v1.0` | ModernBERT-large | ~350M | 超长英文 block |

```python
from gliner import GLiNER

class Layer1Encoder:
    """GLiNER-RelEx 实体与关系抽取器（英文 Trace 路径）"""

    def __init__(self, model_name: str = "knowledgator/gliner-relex-multi-v1.0"):
        self.model = GLiNER.from_pretrained(model_name)
        self.entity_labels = ["TOOL", "CONCEPT", "RESOURCE", "PERSON", "ORG", "ACTION"]
        self.relation_labels = ["USES", "INVOKES", "PRODUCES", "MENTIONS", "RELATES_TO", "CAUSED_BY"]

    def extract(self, text: str, threshold: float = 0.5) -> dict:
        entities, relations = self.model.predict_entities_and_relations(
            text, self.entity_labels, self.relation_labels, threshold=threshold
        )
        return {"entities": entities, "relations": relations}
```

**中文 Session 路径（小 LLM）**：

| 模型 | 参数量 | 中文能力 | 部署方式 |
|------|--------|---------|---------|
| **Qwen2.5-7B / Qwen3-8B** | 7-8B | 中文预训练最强 | vLLM / Ollama + GPU |
| **gemma4-e4b** | ~4B | 中文可用（已实测验证） | Ollama（CPU/GPU） |

```python
import json
import httpx

async def small_llm_extract(window: ExtractionWindow, model: str = "qwen2.5:7b") -> dict:
    """小 LLM 联合抽取：实体 + 关系 + 事件（JSON 结构化输出）

    关键变化：输入是整个 window 的多个 block，而非单个 block。
    """

    # 拼接窗口内所有 block，标记边界
    block_texts = []
    for b in window.context_blocks:
        block_texts.append(f"[CONTEXT block_id=\"{b.block_id}\" role=\"{b.role}\"]\n{b.content}\n[END_CONTEXT]")
    for b in window.blocks:
        block_texts.append(f"[BLOCK block_id=\"{b.block_id}\" role=\"{b.role}\"]\n{b.content}\n[END_BLOCK]")

    combined_input = "\n\n".join(block_texts)

    system_prompt = """你是一个信息抽取专家。从多轮对话中抽取实体、关系和事件。
严格按照以下 JSON 格式输出，不要添加任何解释文字：
{
  "entities": [{"name": "...", "entity_type": "TOOL|CONCEPT|RESOURCE|PERSON|ORG|ACTION", "confidence": 0.0-1.0}],
  "relations": [{"source": "...", "target": "...", "relation_type": "USES|INVOKES|PRODUCES|MENTIONS|RELATES_TO|CAUSED_BY", "confidence": 0.0-1.0}],
  "events": [{"event_type": "user_request|decision|problem|solution|tool_use|tool_result|artifact_create", "summary": "...", "participants": ["..."], "source_block_ids": ["..."]}]
}

关键规则：
- 一发生一 event，不是一 block 一 event
- 多轮补全同一请求 --> 合并为一个 event，source_block_ids 包含所有来源
- 一个 block 含多个独立语义 --> 拆分为多个 event
- CONTEXT block 仅供理解上下文，不需要从中抽取事件"""

    resp = await httpx.AsyncClient().post(
        "http://localhost:11434/api/chat",
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": combined_input}
            ],
            "format": "json",
            "options": {"temperature": 0.2}
        }
    )
    return json.loads(resp.json()["message"]["content"])
```

> 生产环境建议：使用 vLLM + Outlines 的 constrained decoding 替代 Ollama JSON mode，可强制输出严格符合 Pydantic schema 的 JSON。

### 5.5.3 Layer 2：规则与轻量工具层

Layer 2 对 Layer 1 的原始输出进行清洗、增强和补充，全部在代码层完成，无模型推理开销。

**5.5.3.1 停用词与代词过滤**

```python
STOP_ENTITIES = {
    "pronouns": {"我", "你", "它", "这个", "那个", "he", "she", "it", "this", "that"},
    "abstract_states": {"成功", "失败", "好的", "明白", "ok", "done"},
    "generic_words": {"东西", "内容", "数据", "stuff", "things"},
    "system_fields": {"status", "latency_ms", "step_index", "timestamp"},
}

def filter_entities(entities: list[dict]) -> list[dict]:
    filtered = []
    for e in entities:
        text_lower = e["text"].strip().lower()
        if any(text_lower in stopset for stopset in STOP_ENTITIES.values()):
            continue
        if len(text_lower) <= 1:
            continue
        filtered.append(e)
    return filtered
```

**5.5.3.2 时间表达式解析**

| 时间表达式类型 | 处理方式 | 工具 |
|-------------|---------|------|
| ISO 8601 时间戳（Trace 日志） | 直接使用 | 正则提取 |
| 相对时间词（"昨天"/"上周"） | 结合 REFERENCE_TIME 推算 | duckling / dateparser |
| 顺序词（"然后"/"之后"） | 标记为 null，confidence=0.3 | 规则 |
| 无时间信息 | event_time=null，confidence=0.2 | 默认值 |

> 复杂时间推理（如"三周前开始用的"）仍由 Layer 3 LLM 处理。

**5.5.3.3 Aliases 聚合**

```python
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

embedding_model = SentenceTransformer("BAAI/bge-small-zh-v1.5")

def cluster_aliases(entities: list[dict], threshold: float = 0.85) -> list[dict]:
    """基于 embedding 相似度聚合同一实体的别名"""
    texts = [e["text"] for e in entities]
    embeddings = embedding_model.encode(texts)
    sim_matrix = cosine_similarity(embeddings)

    groups = []
    visited = set()
    for i, e in enumerate(entities):
        if i in visited:
            continue
        group = [e]
        for j in range(i + 1, len(entities)):
            if j in visited:
                continue
            if (entities[j]["label"] == e["label"]
                and sim_matrix[i][j] > threshold):
                group.append(entities[j])
                visited.add(j)
        canonical = max(group, key=lambda x: len(x["text"]))
        aliases = [g["text"] for g in group if g["text"] != canonical["text"]]
        groups.append({**canonical, "aliases": aliases})
        visited.add(i)
    return groups
```

**5.5.3.4 实体类型校验**

```python
KNOWN_TOOLS = {"pandas", "numpy", "python", "docker", "git", "redis"}
KNOWN_ORGS = {"google", "microsoft", "openai", "anthropic"}

def correct_entity_types(entities: list[dict]) -> list[dict]:
    for e in entities:
        name_lower = e["text"].lower()
        if name_lower in KNOWN_TOOLS and e["label"] != "TOOL":
            e["label"] = "TOOL"
        if name_lower in KNOWN_ORGS and e["label"] != "ORG":
            e["label"] = "ORG"
    return entities
```

### 5.5.4 Layer 3：大 LLM 精修

Layer 3 是 pipeline 中不可替代的高阶推理层。其职责因路径不同而有差异：

| 路径 | Layer 1 完成了什么 | Layer 3 需要做什么 |
|------|------------------|------------------|
| **英文 Trace** | GLiNER-RelEx 完成基础 NER + 预定义关系 | 补充遗漏关系 + Foresight + fact_text 改写 + 开放关系发现 |
| **中文 Session** | 小 LLM 已完成实体+关系+事件抽取 | **仅做不可替代子任务**：Foresight + 开放关系发现 + 跨句因果推断 + fact_text 质量提升 |

**输出 Schema**：

```python
class ExtractedEvent(BaseModel):
    event_id: str              # evt_<tenant>_<ulid>
    event_type: str            # user_request/decision/problem/solution/tool_use/tool_result/artifact_create
    summary: str               # 一句话事件描述（<=80字）
    participants: list[str]    # 参与实体名称列表
    source_block_ids: list[str]  # 来源 block ID 列表（支持多 block）
    event_time: str | None
    time_resolution_confidence: float
    confidence: float

class ExtractedFact(BaseModel):
    source_entity: str
    target_entity: str
    relation_type: str         # SCREAMING_SNAKE_CASE
    fact_text: str             # 自然语言描述
    valid_at: str | None
    invalid_at: str | None     # Foresight 预测
    validity_confidence: float
    validity_reasoning: str    # 为什么会/不会失效
    source_block_id: str
    confidence: float
```

**Foresight（validity_reasoning）填写规则**：

| 事实类型 | validity_reasoning 示例 | invalid_at |
|---------|----------------------|------------|
| API Key / Token | "Credentials typically expire or rotate, estimate 90 days" | 推算日期 |
| 软件版本号 | "Version info changes with upgrades" | null（不确定） |
| 用户当前使用的工具 | "Active in current session, may change" | null |
| 稳定的能力/概念关系 | "Stable semantic fact, unlikely to change" | null |
| 组织/团队归属 | "Org membership is relatively stable" | null |

> Foresight 是混合架构中 LLM 不可替代的核心原因之一——Encoder 模型无法进行链式推理和时效预测。


---

## 5.6 (4) 语义分层（L0/L1/L2 标注与入图决策）

本层决定抽取结果中的每个实体/关系/事件**是否进入图谱、以什么形式进入**。

### 5.6.1 三层语义模型回顾

| 层级 | 类型 | 例子 | 入图策略 |
|------|------|------|---------|
| **L0：通用常识** | LLM 天然知道的事实 | "Python 是编程语言"、"巴黎是法国首都" | ❌ 丢弃 |
| **L1：领域/用户背景知识** | 在交互中被提及但非情景化 | "我们公司用 Kafka 2.8"、"项目基于 Python 3.10" | ⚠️ **实体入图 + 关系入图，不建 EventNode** |
| **L2：情景化知识** | 在特定交互中被激活/使用 | "用户这次用 pandas 的 dtype 参数解决了 CSV 问题" | ✅ 实体 + 关系 + EventNode 全量入图 |

### 5.6.2 分层判定逻辑

```python
from dataclasses import dataclass

@dataclass
class SemanticLayerResult:
    layer: str  # "L0" / "L1" / "L2"
    reason: str
    action: str  # "drop" / "entity_only" / "full"

# L0 检测：基于高频常识三元组库
COMMON_KNOWLEDGE_TRIPLES = {
    ("python", "IS_A", "programming language"),
    ("docker", "IS_A", "container platform"),
    ("paris", "CAPITAL_OF", "france"),
    # ... 从 Wikidata 高频子集导入
}

def classify_semantic_layer(entity: dict, relations: list[dict], context: str) -> SemanticLayerResult:
    """判断一个实体属于哪个语义层"""
    name_lower = entity["text"].lower()

    # L0：检查是否为纯常识
    for rel in relations:
        triple = (rel["source"].lower(), rel["relation_type"], rel["target"].lower())
        if triple in COMMON_KNOWLEDGE_TRIPLES:
            # 但如果上下文中有个性化修饰，升级到 L1
            personal_markers = ["我", "我们", "我习惯", "我们团队", "上次", "目前用的"]
            if any(m in context for m in personal_markers):
                return SemanticLayerResult("L1", "common knowledge with personal context", "entity_only")
            return SemanticLayerResult("L0", "pure common knowledge", "drop")

    # L2：检查是否有情景化标志
    episodic_markers = [
        "解决了", "出错了", "发现", "试了", "改成", "用了",
        "fixed", "solved", "tried", "changed", "used", "found",
    ]
    if any(m in context for m in episodic_markers):
        return SemanticLayerResult("L2", "episodic interaction", "full")

    # 默认 L1：被提及但无明确情景化
    return SemanticLayerResult("L1", "mentioned but not episodic", "entity_only")
```

> **实际生产中**：L0/L1/L2 的判定应在 Layer 3 大 LLM 精修时一并完成（在 prompt 中要求标注 semantic_layer 字段），上述规则层作为 fallback 和校验。

### 5.6.3 入图动作映射

```python
def apply_layer_decision(extraction_result: dict, layer_results: dict[str, SemanticLayerResult]) -> dict:
    """根据语义层决策过滤抽取结果"""
    filtered = {"entities": [], "relations": [], "events": []}

    for entity in extraction_result["entities"]:
        layer = layer_results.get(entity["text"], SemanticLayerResult("L1", "default", "entity_only"))
        if layer.action != "drop":
            entity["semantic_layer"] = layer.layer
            filtered["entities"].append(entity)

    for relation in extraction_result["relations"]:
        # 关系跟随其两端实体中较高的层级
        src_layer = layer_results.get(relation["source"], SemanticLayerResult("L1", "", "entity_only"))
        tgt_layer = layer_results.get(relation["target"], SemanticLayerResult("L1", "", "entity_only"))
        if src_layer.action != "drop" and tgt_layer.action != "drop":
            filtered["relations"].append(relation)

    for event in extraction_result["events"]:
        # 事件只保留 L2 级别
        participants_layers = [layer_results.get(p, SemanticLayerResult("L1", "", "entity_only")) for p in event["participants"]]
        if any(l.layer == "L2" for l in participants_layers):
            filtered["events"].append(event)

    return filtered
```

---

## 5.7 (5) Event Post-Processor（去重 / 合并 / 拆分）

### 5.7.1 为什么需要后处理

| 来源 | 问题 | 处理方式 |
|------|------|---------|
| 滑动窗口重叠 | 同一事件被两个窗口各抽一次 | **去重**：基于 source_block_ids 重叠检测 |
| LLM 过度拆分 | 一个完整请求被拆成多个碎片事件 | **合并**：基于时间邻近 + 参与者重叠 + 语义相似 |
| LLM 漏拆 | 一个 block 含多个独立语义但只出一个事件 | **拆分**：检测 summary 中的并列结构 |

### 5.7.2 去重（Sliding Window 重叠区域）

```python
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np

dedup_model = SentenceTransformer("BAAI/bge-small-zh-v1.5")

def dedup_events(events: list[dict], overlap_threshold: float = 0.5, sim_threshold: float = 0.85) -> list[dict]:
    """对滑动窗口产出的事件进行去重

    核心逻辑：如果两个事件的 source_block_ids 有重叠，且 summary 语义相似度 > 阈值，则合并。
    """
    if len(events) <= 1:
        return events

    summaries = [e["summary"] for e in events]
    embeddings = dedup_model.encode(summaries)
    sim_matrix = cosine_similarity(embeddings)

    merged_indices = set()
    result = []

    for i, event in enumerate(events):
        if i in merged_indices:
            continue

        best = event
        for j in range(i + 1, len(events)):
            if j in merged_indices:
                continue

            # 检查 source_block_ids 重叠度
            ids_i = set(event["source_block_ids"])
            ids_j = set(events[j]["source_block_ids"])
            overlap = len(ids_i & ids_j) / max(len(ids_i | ids_j), 1)

            if overlap >= overlap_threshold and sim_matrix[i][j] >= sim_threshold:
                # 合并：取 confidence 更高的 summary，合并 source_block_ids
                merged_indices.add(j)
                best = {
                    **best,
                    "source_block_ids": list(ids_i | ids_j),
                    "participants": list(set(best["participants"]) | set(events[j]["participants"])),
                    "confidence": max(best["confidence"], events[j]["confidence"]),
                }

        result.append(best)

    return result
```

### 5.7.3 合并（碎片事件聚合）

```python
def merge_fragments(events: list[dict], time_window_sec: int = 120, sim_threshold: float = 0.75) -> list[dict]:
    """合并时间相邻、参与者重叠、语义相似的碎片事件"""
    if len(events) <= 1:
        return events

    # 按时间排序
    sorted_events = sorted(events, key=lambda e: e.get("event_time", "") or "")

    summaries = [e["summary"] for e in sorted_events]
    embeddings = dedup_model.encode(summaries)
    sim_matrix = cosine_similarity(embeddings)

    merged = set()
    result = []

    for i, event in enumerate(sorted_events):
        if i in merged:
            continue

        group = [event]
        for j in range(i + 1, len(sorted_events)):
            if j in merged:
                continue

            # 时间邻近
            t_i = event.get("event_time")
            t_j = sorted_events[j].get("event_time")
            if t_i and t_j:
                from datetime import datetime
                dt = abs((datetime.fromisoformat(t_j) - datetime.fromisoformat(t_i)).total_seconds())
                if dt > time_window_sec:
                    continue

            # 参与者重叠
            p_overlap = len(set(event["participants"]) & set(sorted_events[j]["participants"]))
            if p_overlap == 0:
                continue

            # 语义相似
            if sim_matrix[i][j] >= sim_threshold:
                group.append(sorted_events[j])
                merged.add(j)

        # 合并 group
        combined = {
            **group[0],
            "source_block_ids": list(set(bid for e in group for bid in e["source_block_ids"])),
            "participants": list(set(p for e in group for p in e["participants"])),
            "summary": max((e["summary"] for e in group), key=len),  # 取最长 summary
            "confidence": max(e["confidence"] for e in group),
        }
        result.append(combined)

    return result
```

---

## 5.8 落地策略与阶段规划

### Phase 1：MVP（2-3 周）

| 组件 | 实现 | 说明 |
|------|------|------|
| Pre-Filter | 纯规则（正则 + 长度 + 角色） | 不引入模型 |
| Window Scheduler | 仅策略 A（session 批处理） | 短会话先跑通 |
| Layer 0 路由 | 硬编码：session→中文路径，trace→英文路径 | |
| Layer 1 | Ollama + Qwen2.5:7b（JSON mode） | 单模型走通全流程 |
| Layer 2 | 停用词过滤 + 实体类型校验 | 最小规则集 |
| Layer 3 | 跳过 | MVP 不用大 LLM |
| 语义分层 | 硬编码 L2（全量入图） | 不做过滤 |
| Event Post-Processor | 跳过 | 短会话无重叠 |

**MVP 目标**：一个 30 轮中文 session → 产出 12-15 个 EventNode + 20-30 个 EntityNode → 写入图谱 → 可检索。

### Phase 2：质量提升（3-4 周）

| 组件 | 升级 | 说明 |
|------|------|------|
| Pre-Filter | 加入 bge-small 分类器 | 提升低价值 turn 过滤准确率 |
| Window Scheduler | 加入策略 B（滑动窗口） | 支持长会话 |
| Layer 1 英文路径 | 引入 GLiNER-RelEx | Trace 数据走 Encoder |
| Layer 2 | 加入 alias 聚合 + 时间解析 | 完整规则层 |
| Layer 3 | 引入大 LLM（GPT-4o / Claude） | Foresight + 开放关系 |
| 语义分层 | 实现 L0/L1/L2 判定 | 减少图谱噪声 |
| Event Post-Processor | 实现去重 + 合并 | 处理滑动窗口重叠 |

### Phase 3：规模化（4-6 周）

- vLLM + Outlines 替代 Ollama，支持 constrained decoding
- 策略 C（Trace 工具链分组）上线
- 异步 pipeline + 消息队列（Celery / Temporal）
- 抽取质量评估框架（人工标注 → golden set → 自动回归测试）
- 多租户隔离与资源调度


---

## 5.9 核心技术难点

| #   | 难点                     | 描述                                     | 应对策略                                                                  |
| --- | ---------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| 1   | **跨 Block 事件合并/拆分**    | "一发生一 event"要求 LLM 理解多轮语义边界            | Window Scheduler 提供足够上下文 + prompt 明确要求合并/拆分 + Event Post-Processor 兜底 |
| 2   | **滑动窗口去重**             | 重叠区域产出的重复事件需准确识别                       | source_block_ids 重叠检测 + embedding 相似度双重验证                             |
| 3   | **L0/L1/L2 边界模糊**      | "我们用 Kafka" 是 L1 还是 L2？取决于上下文          | 规则层做粗分 + Layer 3 LLM 做精判 + 宁可 L1→L2 不丢信息                              |
| 4   | **中文指代消解**             | "那个库"、"刚才的方法"需要跨轮消解                    | Window 携带 context_blocks + 小 LLM 在联合抽取时自然消解                           |
| 5   | **Foresight 准确性**      | invalid_at 预测容易过于激进或保守                 | validity_confidence 量化不确定性 + 定期衰减检查而非硬过期                              |
| 6   | **GLiNER 中文失效**        | 实验验证 GLiNER 对中文基本无效                    | 中英分路：中文走小 LLM，英文走 Encoder                                             |
| 7   | **JSON 输出稳定性**         | 小 LLM JSON mode 偶尔产出非法 JSON            | Pydantic 校验 + 重试（最多 2 次）+ vLLM Outlines constrained decoding          |
| 8   | **长 session token 爆炸** | 100+ turn session 单次喂入超 context window | 滑动窗口策略 B + Pre-Filter 过滤 50%+ 低价值 turn                                |

> **核心技术难点 4：指代消解**
> 
> 用户会话中的指代词（"那个库"、"上次那个问题"、"刚才的代码"）是抽取质量的关键瓶颈。没有指代消解，图谱会出现大量孤立节点，无法形成有效的跨会话关联。
> 
> **缓解策略**：
> 1. 当前 block 内的局部指代（"那个库" → "pandas"）：在 Layer 3 LLM 精修中通过上下文理解识别
> 2. 跨 block 的远程指代（"上次那个问题" → 3天前的 session）：无法在当前 block 解决，依赖 Stage 3 的去重和 Stage 6 的 SemanticCluster 聚类，在检索层通过主题相似性召回
> 3. Layer 1 GLiNER 不具备指代消解能力，此任务完全由 Layer 3 承担
> 
> **参考**：Graphiti 的 Resolution 机制；EverMemOS 的 Reconstructive Recollection

> **核心技术难点 5：时间推断与置信度**
> 
> 原始数据的时间信息质量参差不齐：
> - Trace 日志通常有精确时间戳
> - Session 对话可能只有相对时间词（"昨天"、"上周"）
> - 有些会话完全缺失时间信息
> 
> **混合架构下的分层处理**：
> - Layer 2 处理确定性时间表达式（ISO 时间戳、"昨天/上周" + REFERENCE_TIME 推算）
> - Layer 3 LLM 处理模糊时间推理（"三周前开始用的"、"最近一直在用"）
> 
> **时间置信度计算**（参考：时间置信度的计算与应用）：
> 
> ```
> confidence = 0.35 * source_reliability 
>            + 0.25 * expression_clarity 
>            + 0.20 * (1 - normalization_ambiguity) 
>            + 0.20 * cross_evidence_consistency
> ```
> 
> **权重设计依据**：初始权重基于领域经验分配，强调**数据来源可靠性**（Trace 日志 > 会话模糊表述）和**表达清晰度**（绝对时间 > 相对时间 > 模糊时间）。`normalization_ambiguity` 惩罚一词多义的时间词（如"上个月"可能指农历/公历），`cross_evidence_consistency` 奖励多源交叉验证。
> 
> **反向校准机制**：在系统运行后，收集时间解析的**人工标注反馈**（标注人员判断解析结果是否正确），每月运行一次逻辑回归拟合，动态调整四个权重。在积累足够标注数据（>500 条）之前，沿用上述经验权重。
> 
> 应用策略：高置信度（>0.8）→ 强时序约束；中置信度（0.5-0.8）→ 标记估计；低置信度（<0.5）→ 弱证据，检索排序时降级处理。

> **核心技术难点 6：事实有效期预测（Foresight）**
> 
> 要求 LLM 在精修时预测 `invalid_at` 是一个高难度任务。LLM 可能对事实的时效性判断过于乐观（认为永久有效）或过于保守（频繁标记失效）。
> 
> **这是混合架构中 LLM 不可替代的核心原因之一**——Encoder 模型（BERT/GLiNER）是判别式模型，无法进行链式推理和时效预测。
> 
> **缓解策略**：
> 1. 在 prompt 中给出明确的类别示例（API Key / 版本号 / 当前使用 / 稳定知识）
> 2. `validity_confidence` 字段标记 LLM 对自己预测的信心
> 3. 后期根据实际覆盖情况校准（新事实是否覆盖了旧事实）
> 
> **参考**：EverMemOS（arXiv 2501.02163）的 MemCell(P) 设计

> **核心技术难点 7：结构化输出稳定性**
> 
> LLM 输出不总是严格符合 Pydantic schema，可能出现：字段缺失、类型错误、JSON 格式错误、多余解释文字。
> 
> **混合架构的优势**：Layer 1 GLiNER 的输出是确定性的结构化数据，不存在解析问题。Layer 3 LLM 的输出仍需 schema 校验。
> 
> **缓解策略**：
> 4. Prompt 中强调"严格按照 JSON schema 输出，不要添加解释文字"
> 5. 使用 GPT-4 级别的模型进行精修（比轻量模型稳定性高）
> 6. 完善的 fallback 机制（解析失败时记录日志但不中断 pipeline）
> 7. Prompt 版本管理，快速迭代修复系统性解析错误

> **核心技术难点 8：Layer 1 → Layer 3 的信息传递（新增）**
> 
> 混合架构引入了层间数据流的新挑战：
> - **Schema 对齐**：GLiNER 输出格式需要转换为 LLM prompt 可理解的文本格式
> - **错误级联控制**：Layer 1 的误抽/漏抽会影响 Layer 3 的判断
> - **confidence 传递**：Layer 1 的低置信度结果是否应该传给 Layer 3？阈值如何设定？
> 
> **缓解策略**：
> 1. Layer 1 输出附带 confidence score，Layer 3 prompt 中标注置信度供 LLM 参考
> 2. confidence < 0.3 的实体/关系不传入 Layer 3（减少噪声）
> 3. Layer 3 prompt 明确允许"补充预处理遗漏"（兜底机制）
> 4. 监控 Layer 1 → Layer 3 的一致性指标，发现系统性偏差时调整阈值

> **核心技术难点 9：GLiNER 在非标准文本上的泛化能力（新增）**
> 
> Agent 对话不是标准的自然语言文本，常包含：
> - 代码片段（`import pandas as pd`）
> - 错误堆栈（`TypeError: ...`）
> - 混合语言（中英文夹杂）
> - 系统日志格式（`tool=python_executor; action=run; status=success`）
> 
> GLiNER 主要在标准 NLP 数据集上训练，对这些非标准格式的泛化能力需要验证。
> 
> **缓解策略**：
> 1. 阶段一对比实验中，重点评估非标准文本的 F1
> 2. 如果泛化效果不佳，考虑在 Agent 对话数据上微调 GLiNER
> 3. 对 Trace 日志类型的 block，可以先用规则做预格式化，再送入 GLiNER

> **核心技术难点 10：中文 Encoder 的训练分布错位（新增，基于实测）**
> 
> 这是 GLiNER 中文失效的**根本原因**，不只是"训练数据中中文比例低"（表面现象）。
> 
> **问题本质**：GLiNER 的预训练数据主要来自 PileNER（英文）和 Euro-GLiNER-x（12 种印欧语言，拉丁字母为主），其 subword embedding 对中文字符的覆盖非常有限。在 BPE/SentencePiece 分词下，中文字符被拆为字节级 token，span 预测头在以空格分隔语言为主的训练数据上优化，**对中文字符边界的检测能力从根本上就缺失**。
> 
> 这解释了为什么"双向注意力的结构性优势"在中文场景无法兑现——**Encoder 的理论优势只在训练分布内兑现，中文零样本场景根本不在分布内**。一个 4B 的 decoder-only 模型（gemma4-e4b）之所以能碾压 86M 的 encoder-only 模型（GLiNER-RelEx），是因为前者在预训练阶段看过大量中文文本，建立了真实的字符级语义表示。
> 
> **实测证据**（详见《实体关系抽取选型及实验验证报告（重构版）》§4）：
> - `zh_weather`："上海今天天气怎么样" → GLiNER 标注整句为 CITY (0.895)；gemma4-e4b 正确识别 "上海" 为 CONCEPT
> - `zh_lend`：GLiNER 完全漏掉人名"葛瑞刚"；gemma4-e4b 正确识别 PERSON + RESOURCE + MENTIONS 关系
> - `zh_money`：GLiNER 将 "我有10万闲钱" 标为 PERSON (0.846)；gemma4-e4b 正确识别 "10万闲钱" 为 RESOURCE
> 
> **缓解策略**：
> 1. **短期**：中文会话路径使用小 LLM（Qwen2.5-7B）作为主抽取器，彻底绕过 Encoder 中文缺陷
> 2. **中期**：关注 GLiNER2（2025 EMNLP）是否引入字符级中文支持；关注中文专精 Encoder（Chinese-BERT-wwm + GlobalPointer）的零样本化进展
> 3. **长期**：如果本地 7B LLM 推理成本持续下降（量化、推测解码），Encoder 在中文场景的价值将进一步萎缩
---

## 5.10 工程化封装

### 5.10.1 Pipeline 主入口

```python
from dataclasses import dataclass, field
from typing import Optional
import asyncio

@dataclass
class ExtractionConfig:
    small_llm_model: str = "qwen2.5:7b"
    encoder_model: str = "knowledgator/gliner-relex-multi-v1.0"
    embedding_model: str = "BAAI/bge-small-zh-v1.5"
    layer3_enabled: bool = False  # Phase 1 关闭
    semantic_layering_enabled: bool = False  # Phase 1 关闭
    post_processing_enabled: bool = False  # Phase 1 关闭
    prefilter_use_model: bool = False  # Phase 1 纯规则
    window_strategy: str = "auto"  # auto / session_batch / sliding_window
    max_retries: int = 2

@dataclass
class ExtractionResult:
    entities: list[dict] = field(default_factory=list)
    relations: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)  # 统计信息

async def run_extraction_pipeline(
    session: "Session",
    config: ExtractionConfig = ExtractionConfig()
) -> ExtractionResult:
    """第5章抽取 Pipeline 主入口

    流程：Pre-Filter → Window Scheduler → Extraction (L0/1/2/3) → Semantic Layering → Post-Process
    """

    # ① Pre-Filter
    for block in session.blocks:
        block.prefilter_level = prefilter_block(block)

    stats = {
        "total_blocks": len(session.blocks),
        "skip_blocks": sum(1 for b in session.blocks if b.prefilter_level == "SKIP"),
        "entity_only_blocks": sum(1 for b in session.blocks if b.prefilter_level == "ENTITY_ONLY"),
        "full_blocks": sum(1 for b in session.blocks if b.prefilter_level == "FULL"),
    }

    # ② Window Scheduler
    windows = schedule_extraction(session)
    stats["window_count"] = len(windows)
    stats["window_strategies"] = [w.strategy for w in windows]

    # ③ Extraction Pipeline（并行处理多个 window）
    all_results = await asyncio.gather(*[
        extract_window(w, config) for w in windows
    ])

    # 合并所有 window 的结果
    merged = ExtractionResult()
    for r in all_results:
        merged.entities.extend(r.entities)
        merged.relations.extend(r.relations)
        merged.events.extend(r.events)

    # ④ Semantic Layering
    if config.semantic_layering_enabled:
        merged = apply_semantic_layering(merged)

    # ⑤ Event Post-Processing
    if config.post_processing_enabled:
        merged.events = dedup_events(merged.events)
        merged.events = merge_fragments(merged.events)

    merged.metadata = stats
    return merged

async def extract_window(window: "ExtractionWindow", config: ExtractionConfig) -> ExtractionResult:
    """单个 Window 的抽取流程"""
    route = detect_route(window)

    if route == "en_trace":
        # Layer 1: GLiNER Encoder
        raw = layer1_encoder.extract(
            " ".join(b.content for b in window.blocks)
        )
    else:
        # Layer 1: 小 LLM
        for attempt in range(config.max_retries + 1):
            try:
                raw = await small_llm_extract(window, model=config.small_llm_model)
                break
            except (json.JSONDecodeError, KeyError):
                if attempt == config.max_retries:
                    raw = {"entities": [], "relations": [], "events": []}

    # Layer 2: 规则清洗
    raw["entities"] = filter_entities(raw.get("entities", []))
    raw["entities"] = correct_entity_types(raw.get("entities", []))
    raw["entities"] = cluster_aliases(raw.get("entities", []))

    # Layer 3: 大 LLM 精修（可选）
    if config.layer3_enabled:
        raw = await layer3_refine(raw, window)

    return ExtractionResult(
        entities=raw.get("entities", []),
        relations=raw.get("relations", []),
        events=raw.get("events", []),
    )
```

### 5.10.2 可观测性

```python
import logging
import time

logger = logging.getLogger("ams.extraction")

class PipelineMetrics:
    """Pipeline 运行指标收集"""

    def __init__(self):
        self.timings: dict[str, float] = {}
        self.counts: dict[str, int] = {}

    def record(self, stage: str, duration: float, count: int = 0):
        self.timings[stage] = duration
        self.counts[stage] = count
        logger.info(f"[{stage}] {duration:.2f}s, produced {count} items")

    def summary(self) -> dict:
        return {
            "total_time": sum(self.timings.values()),
            "stages": {k: {"time": self.timings[k], "count": self.counts.get(k, 0)} for k in self.timings},
        }
```

---

## 5.11 推荐模型选型表

| 用途                                   | 推荐模型                        | 参数量   | 部署方式          | 备注                       |
| ------------------------------------ | --------------------------- | ----- | ------------- | ------------------------ |
| **中文 NER+RE+Event（Layer 1）**         | Qwen2.5-7B / Qwen3-8B       | 7-8B  | vLLM / Ollama | 中文预训练最强，JSON mode 稳定     |
| **中文 NER+RE+Event（轻量备选）**            | gemma4-e4b                  | ~4B   | Ollama CPU    | 中文可用，资源受限时使用             |
| **英文 NER+RE（Layer 1 Encoder）**       | gliner-relex-multi-v1.0     | ~86M  | CPU / GPU     | mDeBERTa 底座，英文 Trace 专用  |
| **英文 NER+RE（长文本备选）**                 | modern-gliner-bi-large-v1.0 | ~350M | GPU           | ModernBERT 底座，8192 token |
| **Embedding（Layer 2 alias 聚合 + 去重）** | bge-small-zh-v1.5           | ~33M  | CPU           | 中英双语，轻量高效                |
| **Pre-Filter 分类器**                   | bge-small-zh-v1.5 + 线性层     | ~33M  | CPU           | Phase 2 引入               |
| **Layer 3 精修 / Foresight**           | GPT-4o / Claude 3.5 Sonnet  | -     | API           | 仅不可替代任务调用                |

### 业界参考

| 项目/论文 | 相关技术点 | 参考价值 |
|----------|----------|---------|
| **Microsoft GraphRAG** | 社区检测 + 全局摘要 | 图谱构建的层次化思路 |
| **LightRAG** | 轻量级图谱 + 双层检索 | 实体/关系抽取的 prompt 设计 |
| **GLiNER / GLiNER-RelEx** | 零样本 NER + 关系抽取 | Encoder 路径的核心模型 |
| **Outlines (dottxt)** | Constrained decoding for LLM | JSON 输出稳定性保障 |
| **Mem0** | 记忆管理 + 事实更新 | Foresight / 时效管理的参考 |
| **MemGPT / Letta** | 分层记忆 + 自主管理 | 情景/语义记忆分层架构 |

---

> **本章总结**：重构后的抽取 Pipeline 从原方案的"per-block 四层抽取"升级为"五阶段语义驱动架构"。核心变化是引入 Pre-Filter（减少无效调用）、Window Scheduler（解决跨 block 语义问题）和 Event Post-Processor（处理窗口重叠），同时保持了原方案的混合抽取思路（Encoder + 小 LLM + 大 LLM 分工）。落地时分三个 Phase 渐进，MVP 阶段仅需 Ollama + Qwen2.5 即可跑通全流程。
