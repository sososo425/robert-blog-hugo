# 第4章 输入适配与 Raw Block 生成（重构版）

> 本章定义从上游 Agent 框架接收原始会话/Trace 数据，经过清洗、预处理，生成统一 Raw Block 的完整流程。
>
> **核心原则**：Ch4 只做"确定性处理"（零模型依赖），所有语义判断留给 Ch5。

---

## 4.1 Raw Block Schema

Raw Block 是系统的**统一原料格式**，所有后续处理（Ch5 抽取、图谱写入、溯源查询）都以 Raw Block 为输入。每个 Block 只含原始内容和结构化元数据，不做任何语义提炼。

```json
{
  "block_id":          "blk_acmecorp_01J5KXYZ...",
  "tenant_id":         "acmecorp",
  "session_id":        "sess_acmecorp_01A",
  "source_type":       "session",

  "role":              "user",
  "content":           "我用 pandas 处理了一个 CSV，有个列的类型识别有问题。",
  "content_resolved":  null,
  "content_oss_key":   null,

  "turn_index":        1,
  "timestamp":         1743162725,
  "source_uri":        "session://sess_acmecorp_01A/turn/1",

  "trace_step_type":   null,
  "tool_name":         null,
  "status":            null,
  "latency_ms":        null,

  "is_compressed":     false,
  "original_uri":      null
}
```

### 字段说明

| 字段                 | 类型     | 必填  | 说明                                                              |
| ------------------ | ------ | :-: | --------------------------------------------------------------- |
| `block_id`         | string |  ✅  | `blk_{tenant}_{ulid}`，全局唯一                                      |
| `tenant_id`        | string |  ✅  | 租户隔离                                                            |
| `session_id`       | string |  ✅  | 来自上游框架的会话 ID                                                    |
| `source_type`      | enum   |  ✅  | `session` / `agent_trace`                                       |
| `role`             | string |  ✅  | Session: `user` / `assistant`；Trace: `tool_use` / `tool_result` |
| `content`          | string |  ✅  | 经清洗/格式化后的内容（< 4KB）                                              |
| `content_resolved` | string |  -  | 共指消解后的内容（4.4 节填充），null 表示未处理                                    |
| `content_oss_key`  | string |  -  | 内容超 4KB 时存 OSS，此处存 key                                          |
| `turn_index`       | int    |  -  | Session 专有，会话内单调递增                                              |
| `timestamp`        | int    |  ✅  | Unix 时间戳（秒）                                                     |
| `source_uri`       | string |  ✅  | 溯源定位符，格式 `{source_type}://{session_id}/{定位}`                    |
| `trace_step_type`  | string |  -  | Trace 专有：`tool_use` / `tool_result`                             |
| `tool_name`        | string |  -  | Trace 专有：工具名称                                                   |
| `status`           | string |  -  | Trace 专有：`success` / `failure` / `retry` / `timeout`            |
| `latency_ms`       | int    |  -  | Trace 专有：执行耗时                                                   |
| `is_compressed`    | bool   |  ✅  | 是否经过低密度压缩（4.3.2 节）                                              |
| `original_uri`     | string |  -  | 压缩时原始内容的存储位置                                                    |

> **与旧 Schema 的变化**：
> - `speaker` → `role`（统一命名，Session 和 Trace 通用）
> - 移除 `embedding` / `triples`（属于 Ch5 抽取结果，不挂在 Block 上）
> - Trace 专用字段（`trace_step_type`/`tool_name`/`status`/`latency_ms`）提升到顶层
> - 新增 `content_resolved`（共指消解输出）
> - 新增 `is_compressed` / `original_uri`（压缩溯源）

### 必填字段校验

```python
REQUIRED_FIELDS = {"block_id", "tenant_id", "session_id", "source_type", "role", "content", "timestamp", "source_uri"}

def validate_block(block: dict) -> bool:
    """缺失必填字段的 Block 视为无效，拒绝入库"""
    missing = REQUIRED_FIELDS - set(k for k, v in block.items() if v is not None)
    if missing:
        logger.warning(f"Invalid block {block.get('block_id')}: missing {missing}")
        return False
    return True
```

---

## 4.2 输入适配（Stage 0）

### 4.2.1 Session 链路：会话归一化

上游 Session 消息流 → `NormalizedSession`，处理要点：

- 直接采信上游框架的 `session_id`，不做二次切分
- 识别 `role`（user / assistant / system）
- 确认 turn 边界（通常以 role 切换为界）
- 补全 `timestamp`（部分框架不带精确时间戳，需从上下游推算）

```python
@dataclass
class NormalizedTurn:
    turn_index: int
    role: str          # "user" / "assistant" / "system"
    content: str
    timestamp: int | None
    time_inferred: bool = False  # timestamp 是否为推算值

@dataclass
class NormalizedSession:
    session_id: str
    tenant_id: str
    turns: list[NormalizedTurn]

def adapt_langflow_session(langflow_payload: dict) -> NormalizedSession:
    """对接 Langflow 的输入适配"""
    return NormalizedSession(
        session_id=langflow_payload["session_id"],
        tenant_id=extract_tenant_id(langflow_payload),
        turns=[
            NormalizedTurn(
                turn_index=i,
                role=msg["sender"],
                content=msg["text"],
                timestamp=msg.get("timestamp"),
                time_inferred=msg.get("timestamp") is None,
            )
            for i, msg in enumerate(langflow_payload["messages"])
        ],
    )
```

**Timestamp 补全策略**：

| 情况 | 处理 |
|------|------|
| 上游提供精确时间戳 | 直接使用 |
| 上游缺失，前后 turn 有时间戳 | 线性插值，标记 `time_inferred=True` |
| 全部缺失 | 使用入库时间，标记 `time_inferred=True` |

### 4.2.2 Trace 链路：执行日志归一化

原始 Trace 日志（不同 Agent 框架格式各异）→ `NormalizedTrace`：

```python
@dataclass
class NormalizedTraceStep:
    step_index: int
    trace_step_type: str   # "tool_use" / "tool_result"
    tool_name: str
    action: str | None
    input_args: dict | None
    output_summary: str | None
    status: str            # "success" / "failure" / "retry" / "timeout"
    error_message: str | None
    latency_ms: int | None
    timestamp: int

@dataclass
class NormalizedTrace:
    session_id: str
    tenant_id: str
    steps: list[NormalizedTraceStep]
```

**多框架兼容策略**：通过**适配器插件（Adapter Plugin）**处理，每个框架对应一个适配器，新框架接入只需新增适配器，不修改主链路。

> **⚠️ 核心技术难点：多框架 Trace 格式异构**
>
> - 某些框架的 Trace 是扁平列表，需从 `parent_span_id` 重建树状执行链
> - 错误重试会产生多个同 action 的 step，需识别哪些是重试、哪些是新调用
> - 参考：Langfuse（OTEL 标准 Trace 格式）；OpenTelemetry Trace 规范

### 4.2.3 增量消息装配与去重

生产环境中，Session 消息通常以增量方式到达（Kafka / WebSocket），而非一次性完整 session。

```python
class SessionAssembler:
    """按 session_id 聚合增量消息，输出完整 turn 列表"""

    def __init__(self, state_store):
        self.state_store = state_store  # Redis / 本地缓存

    async def assemble(self, tenant_id: str, session_id: str, new_turns: list[NormalizedTurn]) -> list[NormalizedTurn]:
        """增量装配 + 去重"""
        # 1. 获取已有状态
        existing = await self.state_store.get(f"{tenant_id}:{session_id}") or []
        seen_keys = {(t.turn_index, t.timestamp) for t in existing}

        # 2. 去重：基于 turn_index + timestamp
        deduped = [t for t in new_turns if (t.turn_index, t.timestamp) not in seen_keys]

        # 3. 合并并按 turn_index 排序
        merged = sorted(existing + deduped, key=lambda t: t.turn_index)

        # 4. 更新状态
        await self.state_store.set(f"{tenant_id}:{session_id}", merged)

        return deduped  # 返回本次新增的 turn，供后续生成 Block
```

| 消息形态 | 处理方式 |
|---------|---------|
| 完整 Session | 跳过装配，直接进入清洗 |
| 增量片段 | 按 session_id 聚合，去重后追加 |
| 单轮消息 | 立即生成 Block（无需等待后续 turn） |
| 多 Session 批量 | 按 session_id 分组，各自独立处理 |


---

## 4.3 清洗与压缩

本节在 Block 生成前对 turn 进行确定性过滤和压缩。**纯规则实现，零模型依赖**。被过滤的 turn 不生成 RawBlock。

### 4.3.1 噪声过滤

| 类别 | 典型特征 | 默认策略 | 规则 |
|------|---------|---------|------|
| **System prompt** | `role=system` 或固定前缀 | 丢弃，不生成 Block | 按 role 判断 |
| **纯寒暄/确认** | 短句 + 高频词表匹配 | 丢弃 | 长度 < 阈值 + 词表命中 |
| **空内容** | content 为空白 | 丢弃 | strip 后为空 |
| **重复内容** | 与上一 turn content 完全相同 | 丢弃 | 精确匹配 |

```python
# 寒暄/确认词表（可配置扩展）
GREETING_PATTERNS = {
    "zh": {"嗯", "好的", "好", "明白", "明白了", "收到", "知道了", "谢谢", "感谢",
           "没问题", "可以", "行", "对", "是的", "ok", "嗯嗯", "了解"},
    "en": {"ok", "okay", "sure", "thanks", "thank you", "got it", "understood",
           "yes", "yeah", "yep", "right", "alright", "fine", "cool"},
}

def should_filter_turn(turn: NormalizedTurn, prev_turn: NormalizedTurn | None = None) -> tuple[bool, str]:
    """判断 turn 是否应被过滤（不生成 Block）

    Returns: (should_filter, reason)
    """
    content = turn.content.strip()

    # 1. 空内容
    if not content:
        return True, "empty_content"

    # 2. System prompt
    if turn.role == "system":
        return True, "system_prompt"

    # 3. 纯寒暄/确认（仅短句触发，避免误杀信息密度高的短指令）
    if len(content) <= 10:
        content_lower = content.lower().rstrip("。.!！~～")
        all_greetings = GREETING_PATTERNS["zh"] | GREETING_PATTERNS["en"]
        if content_lower in all_greetings:
            return True, "greeting_or_confirmation"

    # 4. 与上一 turn 完全重复
    if prev_turn and content == prev_turn.content.strip():
        return True, "duplicate_content"

    return False, ""
```

> **谨慎原则**：宁可多保留，不要误杀。短但信息密度高的用户指令（如"继续"在某些上下文中是有效指令）通过严格的长度 + 词表双重条件保护。如果误杀率 > 2%，应放宽阈值。

### 4.3.2 低密度压缩（可选）

**适用场景**：Assistant 长篇回复（> 2000 字）但信息密度低（冗余客套、重复句式、列举冗余）。

```python
import re

def should_compress(turn: NormalizedTurn, threshold: int = 2000) -> bool:
    """判断是否需要低密度压缩"""
    if turn.role != "assistant":
        return False
    if len(turn.content) <= threshold:
        return False
    # 检测冗余信号
    redundancy_signals = [
        len(re.findall(r"[。.!！]", turn.content)) > 30,       # 超多句子
        turn.content.count("\n") > 20,                          # 超多行
        len(set(turn.content.split())) / max(len(turn.content.split()), 1) < 0.4,  # 词汇多样性低
    ]
    return sum(redundancy_signals) >= 2

def compress_content(content: str) -> str:
    """提取式压缩：保留前 3 句 + 关键列表项 + 最后 2 句

    注意：这是纯规则压缩，不依赖模型。
    生产环境可选用 BART 摘要替代，但 Phase 1 不引入模型。
    """
    sentences = re.split(r'(?<=[。.!！\n])', content)
    sentences = [s.strip() for s in sentences if s.strip()]

    if len(sentences) <= 8:
        return content  # 不够长，不压缩

    # 保留：开头 3 句 + 含关键标记的句子 + 结尾 2 句
    key_markers = ["关键", "重要", "注意", "总结", "结论", "核心",
                   "key", "important", "note", "summary", "conclusion"]
    middle = [s for s in sentences[3:-2]
              if any(m in s.lower() for m in key_markers)
              or re.match(r'^\d+[.、)]', s)]  # 编号列表项

    compressed = sentences[:3] + middle + sentences[-2:]
    return "\n".join(compressed)
```

**压缩流程**：

```
原始 content → should_compress() → 是 → compress_content() → 写入 content
                                                             → 原始存 OSS → original_uri 记录路径
                                                             → is_compressed = true
                                  → 否 → 原样保留
```

---

## 4.4 共指消解预处理（可选）

**目标**：降低 Ch5 抽取阶段的"悬空代词"比例，减轻 LLM 负担。**仅做高性价比的规则层处理**，不追求完整指代消解。

### 设计原则

- 只处理**高置信度**的简单指代（上一句唯一主语明确）
- 无法确定时**不替换**，保留原词
- 输出写入 `content_resolved` 字段，`content` 保持原始值不变（溯源保障）

```python
import re

# 常见代词
ZH_PRONOUNS = {"它", "这个", "那个", "该", "其", "这", "那"}
EN_PRONOUNS = {"it", "this", "that", "its"}

def resolve_coreference(
    current_turn: NormalizedTurn,
    prev_turns: list[NormalizedTurn],
    max_lookback: int = 2
) -> str | None:
    """规则层共指消解

    策略：
    1. 检测当前 turn 是否含代词
    2. 从前 N 轮中提取候选实体（大写开头词、引号内容、已知工具名）
    3. 如果候选唯一且高置信，替换代词
    4. 否则返回 None（不处理）

    Returns: 消解后的文本，或 None 表示无需处理
    """
    content = current_turn.content
    all_pronouns = ZH_PRONOUNS | EN_PRONOUNS

    # 1. 检测是否含代词
    found_pronouns = [p for p in all_pronouns if p in content.lower()]
    if not found_pronouns:
        return None

    # 2. 从前几轮提取候选实体
    candidates = set()
    lookback = prev_turns[-max_lookback:] if len(prev_turns) >= max_lookback else prev_turns

    for t in lookback:
        # 引号内容
        candidates.update(re.findall(r'["\'「](.*?)["\'」]', t.content))
        # 反引号内容（代码/工具名）
        candidates.update(re.findall(r'`([^`]+)`', t.content))

    # 过滤太长或太短的候选
    candidates = {c for c in candidates if 1 < len(c) <= 30}

    # 3. 唯一候选 → 替换
    if len(candidates) == 1:
        entity = candidates.pop()
        resolved = content
        for p in found_pronouns:
            resolved = resolved.replace(p, f"{entity}（{p}）", 1)  # 保留原代词供溯源
        return resolved

    # 多候选或零候选 → 不替换
    return None
```

> **为什么保留原代词？**
> `"pandas（它）的 dtype 参数"` 而非直接替换为 `"pandas 的 dtype 参数"`——这样 Ch5 LLM 能看到消解结果，同时保留了原始表达，避免替换错误时无法回溯。


---

## 4.5 Raw Block 生成规则

经过 4.2（适配）→ 4.3（清洗）→ 4.4（消解）后，存活的 turn/step 按以下规则生成 Block。

### 4.5.1 生成粒度

| 来源 | 粒度 | 说明 |
|------|------|------|
| Session | 每个存活 Turn → 一个 Block | 保持 turn 原子性，不跨 turn 合并 |
| Trace | 每个 Step → 一个 Block | 保持 step 原子性，重试步骤各自生成独立 Block |

> **为什么不按语义分块？** 详见前文讨论——Block 是存储和溯源的粒度（无损、幂等、零模型），语义边界由 Ch5 Window Scheduler 处理。

### 4.5.2 Content 格式化规则

**Session Block**：

```python
def format_session_block_content(turn: NormalizedTurn) -> str:
    """Session Block content = role: content"""
    return f"{turn.role}: {turn.content}"
```

**Trace Block**：使用结构化 JSON 而非拼接字符串，保留完整信息供 Ch5 Trace 路径使用。

```python
import json

def format_trace_block_content(step: NormalizedTraceStep) -> str:
    """Trace Block content = 结构化 JSON 文本"""
    trace_info = {
        "tool": step.tool_name,
        "action": step.action,
        "status": step.status,
        "latency_ms": step.latency_ms,
    }
    if step.trace_step_type == "tool_use":
        trace_info["input"] = step.input_args
    elif step.trace_step_type == "tool_result":
        trace_info["output"] = step.output_summary
        if step.error_message:
            trace_info["error"] = step.error_message
    return json.dumps(trace_info, ensure_ascii=False)
```

> **与旧方案的区别**：旧方案用 `"tool=X; action=Y; ..."` 拼接字符串，丢失结构。新方案用 JSON 保留完整字段，Ch5 Trace 路径可直接 parse。

### 4.5.3 超长内容处理

| 内容长度 | 处理方式 |
|---------|---------|
| < 4KB | 直接存入 `content` 字段 |
| ≥ 4KB 且已压缩（4.3.2） | 压缩后内容存 `content`，原始存 OSS，`original_uri` 记录 |
| ≥ 4KB 且未压缩 | 截断前 4KB 存 `content`，完整内容存 OSS，`content_oss_key` 记录 |

### 4.5.4 Block 生成主流程

```python
from ulid import ULID

def generate_blocks(
    session: NormalizedSession,
    assembler_output: list[NormalizedTurn] | None = None
) -> list[dict]:
    """从 NormalizedSession 生成 Raw Block 列表

    流程：清洗过滤 → 可选压缩 → 可选消解 → 生成 Block
    """
    turns = assembler_output or session.turns
    blocks = []
    prev_turn = None

    for turn in turns:
        # Step 1: 噪声过滤
        should_filter, reason = should_filter_turn(turn, prev_turn)
        if should_filter:
            logger.debug(f"Filtered turn {turn.turn_index}: {reason}")
            prev_turn = turn
            continue

        # Step 2: 低密度压缩（可选）
        is_compressed = False
        original_uri = None
        content = turn.content
        if should_compress(turn):
            original_uri = store_to_oss(session.tenant_id, session.session_id, turn)
            content = compress_content(turn.content)
            is_compressed = True

        # Step 3: 共指消解（可选）
        content_resolved = resolve_coreference(turn, turns[:turn.turn_index])

        # Step 4: 生成 Block
        block_id = f"blk_{session.tenant_id}_{ULID()}"
        block = {
            "block_id": block_id,
            "tenant_id": session.tenant_id,
            "session_id": session.session_id,
            "source_type": "session",
            "role": turn.role,
            "content": format_session_block_content(
                NormalizedTurn(turn.turn_index, turn.role, content, turn.timestamp)
            ),
            "content_resolved": content_resolved,
            "content_oss_key": None,
            "turn_index": turn.turn_index,
            "timestamp": turn.timestamp,
            "source_uri": f"session://{session.session_id}/turn/{turn.turn_index}",
            "trace_step_type": None,
            "tool_name": None,
            "status": None,
            "latency_ms": None,
            "is_compressed": is_compressed,
            "original_uri": original_uri,
        }

        # 超长内容处理
        if len(block["content"].encode("utf-8")) >= 4096:
            block["content_oss_key"] = store_content_to_oss(block)
            block["content"] = block["content"][:4096]

        if validate_block(block):
            blocks.append(block)

        prev_turn = turn

    return blocks


def generate_trace_blocks(trace: NormalizedTrace) -> list[dict]:
    """从 NormalizedTrace 生成 Raw Block 列表"""
    blocks = []
    for step in trace.steps:
        block_id = f"blk_{trace.tenant_id}_{ULID()}"
        block = {
            "block_id": block_id,
            "tenant_id": trace.tenant_id,
            "session_id": trace.session_id,
            "source_type": "agent_trace",
            "role": step.trace_step_type,  # "tool_use" / "tool_result"
            "content": format_trace_block_content(step),
            "content_resolved": None,
            "content_oss_key": None,
            "turn_index": None,
            "timestamp": step.timestamp,
            "source_uri": f"agent_trace://{trace.session_id}/step/{step.step_index}",
            "trace_step_type": step.trace_step_type,
            "tool_name": step.tool_name,
            "status": step.status,
            "latency_ms": step.latency_ms,
            "is_compressed": False,
            "original_uri": None,
        }
        if validate_block(block):
            blocks.append(block)
    return blocks
```

---

## 4.6 Session 边界与 Episode 策略

### Session 边界策略：信任上游框架

本系统**不自行切分 session**。`session_id` 由上游 Agent 框架（如 Langflow）在创建对话时生成，AMS 直接采信。

**Langflow 的会话模型**：

```
Langflow
├── Flow（工作流定义，类似模板）
│   └── Chat Session（用户打开一个聊天窗口 = 一个 session）
│       ├── Message 1 (user)     ← turn 1
│       ├── Message 2 (assistant)← turn 2
│       └── ...
│   └── Chat Session（另一次对话 = 另一个 session）
```

> **为什么不自行切分？**
> 对接 Langflow 等框架时，session 边界已由框架层确定，AMS 再做切分是重复劳动且容易引入分歧（AMS 切出的边界与框架不一致会导致溯源混乱）。

### 关于 Episode 子段：不做，由 SemanticCluster 替代

**经全链路分析，决定不实现 episode 切分。**

| 维度 | episode 切分 | SemanticCluster |
|------|:---:|:---:|
| session 内多话题分组 | ✅ | ✅ |
| 跨 session 同主题聚合 | ❌ | ✅ |
| 话题交织处理 | ❌ 硬切导致错误归属 | ✅ 软聚天然容忍 |
| 实时性 | 实时 | 异步（可接受） |
| 实现复杂度 | 高（需 LLM 实时判断） | 中（HDBSCAN 批处理） |

### session_id 的保留用途

| 用途 | 说明 |
|------|------|
| **时间线重建** | `GET /api/memory/timeline?session_id=xxx` — 按 PRECEDES 链还原某次对话完整经过 |
| **PRECEDES 边构建** | 同一 session 内的 EventNode 按时间排序建立时序链 |
| **溯源定位** | EventNode → source_block_id → RawBlock → source_uri → 具体对话轮次 |

语义层面的检索（"和数据读取相关的历史"）由 `semantic_cluster_id` 承载，不依赖 session_id。


---

## 4.7 与第5章的分工边界

### 职责划分原则

> **Ch4 做"不会出错的事"，Ch5 做"可能出错但有多层兜底的事"。**

| 职责 | Ch4（确定性清洗） | Ch5（语义判断） |
|------|:---:|:---:|
| 空内容/system prompt 过滤 | ✅ | |
| 寒暄/确认词过滤 | ✅ | |
| 低密度压缩 | ✅ | |
| 简单共指消解（规则层） | ✅ | |
| ENTITY_ONLY / FULL 分级 | | ✅ Pre-Filter |
| 跨 block 上下文调度 | | ✅ Window Scheduler |
| 实体/关系/事件抽取 | | ✅ Layer 0-3 |
| L0/L1/L2 语义分层 | | ✅ Semantic Layering |
| 事件去重/合并/拆分 | | ✅ Post-Processor |

### 两层过滤的流转

```
原始 turns                    Ch4                        Ch5
──────────── ─────────────────────────── ────────────────────────────────
  30 turns → 噪声过滤（-8 turns）
             → 22 RawBlocks 生成
                                    → Pre-Filter: SKIP(5) + ENTITY_ONLY(4) + FULL(13)
                                    → Window Scheduler: 只拿 13 个 FULL block 组窗口
                                    → 抽取 Pipeline → 图谱
```

**关键保障**：
- Ch4 过滤是**保守的**（宁可多留），误杀率应 < 2%
- Ch5 Pre-Filter 是**分级的**（SKIP/ENTITY_ONLY/FULL），不直接丢弃，可回溯调整
- 即使 Ch4 多留了一些低价值 turn，Ch5 Pre-Filter 会将其标记为 SKIP，不会增加 LLM 调用

---

> **本章总结**：重构后的第4章从原方案的"直接映射"升级为"清洗-消解-生成"三步流程。核心变化是引入噪声过滤（减少 ~25% 无效 Block）和可选的共指消解预处理（降低 Ch5 LLM 负担）。同时更新了 RawBlock Schema 以对齐 Ch5 的字段需求，并新增了增量消息装配能力。所有处理均为纯规则、零模型依赖，保持 Ch4 作为系统"确定性基座"的定位。
