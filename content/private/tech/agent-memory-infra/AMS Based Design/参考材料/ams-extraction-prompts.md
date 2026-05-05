# AMS 实体 / 关系 / 事件抽取 — Prompt 汇总

本文档整理**当前代码路径**中用于 **Session 联合抽取**（实体、事件、参与者、关系边）的 LLM 提示与相关约束。以源码为准；若与实现不一致，以 `src/agent_memory/ams/llm_extract.py` 为准。

| 组件 | 说明 |
|------|------|
| **Kimi** `run_kimi_session_extraction` | `system` = 下文章节「系统提示」，`user` = `build_extraction_user_prompt(...)` |
| **Ollama** `run_ollama_session_extraction` | 与 Kimi **同一套** system + user（`/api/generate` 的 `system` / `prompt` 字段） |
| **分块** `run_*_session_extraction_auto_chunked` | 不改变 prompt 文本，仅按块重复调用并合并结果 |
| **Layer1 GLiNER** | 无自然语言 prompt；使用闭集 **标签列表**（见文末） |

以下正文中的 **系统提示**、**JSON Schema** 与源码字符串一致（便于离线评审与复制）；用户消息中的 JSON 负载为运行时拼装，文中用占位说明结构。

---

## 1. 系统提示（`EXTRACTION_SYSTEM_PROMPT` / `_EXTRACTION_SYSTEM_PROMPT_ZH`）

**文件**: `src/agent_memory/ams/llm_extract.py`（约第 113–157 行，`EXTRACTION_SYSTEM_PROMPT` 为其公开别名）

```
你是 Agent 长期记忆流水线中的联合抽取模型, 同时产出实体、事件、参与者与关系边 JSON.
领域与类型按通用对话与工具轨迹约定如下.
实体类型优先 TOOL, CONCEPT, RESOURCE, PERSON, ORG, ACTION (大写英文类名).
实体-实体关系优先 USES, INVOKES, PRODUCES, MENTIONS, RELATES_TO, CAUSED_BY, SYNONYM_OF;
若确有必要且文本有依据, 允许其它 SCREAMING_SNAKE_CASE 关系名.

【事件】事件是"在语境中发生的、可叙述的一件事", 不是静态属性句.
Session 侧重: user_request, decision, problem, solution;
Trace 侧重: tool_use, tool_result, artifact_create;
artifact_create: 明确写出/保存了文件、补丁、报告、配置等产物时用;
tool_result: 工具返回内容但未强调落盘产物时;
枚举另有 topic_shift, assistant_reply, clarification 等, 仅在证据充分时使用.
不要当成事件: 纯百科定义、无执行痕迹的纯意图、重复无信息的心跳日志、
与当前任务无关的极细系统内部噪声.

【事件粒度】RawBlock 是溯源边界, EventNode 是语义/情景边界, 二者解耦.
遵循「一发生一事件」, 不是「一块必须一事件」: 同一 block 若只有一个可叙述的发生, 只输出一个 EventNode;
若整段仅为礼节性短回复(无新事实、无新决策、无新工具/trace 动作), 不要为该块输出 EventNode.
assistant_reply 仅在助手给出实质性新信息、方案、总结、追问或带证据的反馈时建立;
避免把「嗯/好的/Thanks!/纯夸赞且无新命题」建模为独立事件.
Trace: 连续多次纯探查类工具调用可合并为较少事件, 优先保留状态变化、错误、最终成功、artifact 落盘等有记忆价值的步.

【时间】time_resolution_confidence 表示对 event_time 的把握.
取值 0-1, 在下方建议区间内自洽即可.
块或 trace 有显式时间戳且直接用作 event_time: 建议约 0.85-0.95.
相对时间(昨天/上周)结合 REFERENCE_TIME 推算: 建议约 0.5-0.7.
仅有顺序词(然后/之后)无绝对时间: event_time 可为 null, 建议约 0.25-0.4.
无时间线索: event_time=null, 建议约 0.15-0.35.

【关系与事实】
实体-实体边必须两端都是已输出实体列表中的实体, 且能在当前材料中找到依据;
不要输出仅描述单个实体状态却无第二端对象的"伪关系";
fact_text 用简短自然语言概括事实, 避免整句照抄原文.
对可能过期的事实(凭据、版本、临时状态), 在 fact_text 点明理由;
并尽量填写 valid_at / invalid_at;
若填写了时效边界, 可附加 validity_reasoning(一两句, 可省略).

【语言】对话与日志可中英混杂.
输出 JSON 键名与枚举字面量必须与 Schema 一致(英文).

【溯源】source_block_id / entity_id / event_id 必须与输入块 ID 及你自洽命名一致.
禁止臆造未出现的 block_id.
```

---

## 2. 用户提示模板（`build_extraction_user_prompt`）

**文件**: `src/agent_memory/ams/llm_extract.py`（约第 199–254 行）

**固定开头与说明**（其后拼接动态 JSON/XML 风格片段）：

```
请根据以下锚点与材料, 生成符合末尾英文 Schema 的单个 JSON 对象.
仅输出 JSON, 无 markdown 围栏.

<REFERENCE_TIME>{首块或首轮时间戳}</REFERENCE_TIME>

以下为上游预抽取的实体/关系候选(可为空数组).
请校对、合并、补充遗漏, 勿盲目照抄.
<PRE_EXTRACTED_ENTITIES>
{JSON 数组: Layer1 实体候选}
</PRE_EXTRACTED_ENTITIES>

<PRE_EXTRACTED_RELATIONS>
{JSON 数组: Layer1 关系候选}
</PRE_EXTRACTED_RELATIONS>

以下为各块的显式时间锚(供时间推理, 仅为块级时间戳):
<PARSED_TIMES>
[{"block_id","timestamp"}, ...]
</PARSED_TIMES>

<SESSION_META>
tenant_id='...'
session_id='...'
task_id='...'
</SESSION_META>

<DIALOGUE_TURNS_JSON>
{session.turns 的 JSON}
</DIALOGUE_TURNS_JSON>

<TRACE_STEPS_JSON>
{session.trace_steps 的 JSON}
</TRACE_STEPS_JSON>

<RAW_BLOCKS_JSON>
块内 text 可能含 [user]/[assistant] 前缀表示说话人.
block_id 必须与输出中的 source_block_id 对齐.
{RawBlock 列表 JSON: block_id, source_type, timestamp, text, source_uri}
</RAW_BLOCKS_JSON>

{见第 3 节 _EXTRACTION_SCHEMA 全文}
只输出 JSON 对象, 不要解释或其他文字.
```

**说明**:

- `prior_encoder_extraction` 非空时，`PRE_EXTRACTED_*` 来自 Layer1（如 GLiNER）序列化结果；为空则为 `[]`。
- `REFERENCE_TIME` 来自 `_reference_time_iso`：优先首块时间戳，否则首轮时间。

---

## 3. 输出 JSON Schema 片段（`_EXTRACTION_SCHEMA`，拼在用户消息末尾）

**文件**: `src/agent_memory/ams/llm_extract.py`（约第 71–111 行）

```
Return a single JSON object (no markdown fences) with this shape:
{
  "entities": [
    {"entity_id": "string", "name": "string", "entity_type": "string",
     "aliases": ["optional"], "schema_version": "v1"}
  ],
  "events": [
    {"event_id": "string",
     "event_type": "user_request|problem|decision|topic_shift|assistant_reply|"
     "clarification|solution|observation|tool_use|tool_result|artifact_create|other",
     "summary": "string", "event_time": "ISO-8601 or null",
     "time_resolution_confidence": 0.0-1.0 or null,
     "confidence": 0.0-1.0,
     "source_block_id": "must match one of the input block_ids",
     "source_type": "session|agent_trace"}
  ],
  "participants": [
    {"entity_id": "string", "event_id": "string", "role": "subject|object|context|..."}
  ],
  "relationships": [
    {"rel_type": "DERIVED_FROM", "from_event_id": "string", "to_block_id": "string"},
    {"rel_type": "PRECEDES", "from_event_id": "string", "to_event_id": "string"},
    {
     "rel_type": "USES|INVOKES|PRODUCES|MENTIONS|RELATES_TO|CAUSED_BY|...",
     "from_entity_id": "string",
     "to_entity_id": "string",
     "fact_text": "string or null",
     "confidence": 0.0-1.0 or null,
     "valid_at": "ISO or null",
     "invalid_at": "ISO or null",
     "validity_reasoning": "string or null, optional"
    },
    {"rel_type": "REQUEST_LEADS_TO|ATTEMPTS_TO_SOLVE|EVIDENCES|"
     "CONTINUES", "from_event_id": "string",
     "to_event_id": "string"}
  ]
}
Every event must have a DERIVED_FROM edge to its source_block_id.
Order tool/user events with PRECEDES where temporal order is clear.
```

---

## 4. Layer1：GLiNER 闭集标签（非 LLM 文本 prompt）

**文件**: `src/agent_memory/core/config.py` — 字段 `AMS_GLINER_LABELS`（默认约第 125–128 行），经 `Settings.ams_gliner_label_list()` 拆成列表传入 `encoder_gliner.extract_with_gliner` → `model.predict_entities(text, labels, threshold)`。

**默认值（逗号分隔）**：

`Tool,Library,API,Error,file format,data type,Concept,Person,Organization,Product,Location,City,Weather,Money,Date,Time,Transport,Software`

GLiNER 路径**仅产出实体**（及与块的对齐），不直接产出事件/关系；事件与关系由 **Layer3 LLM** 按上文的 system + user 联合抽取（hybrid 时 LLM 会收到上述实体/关系候选）。

---

## 5. 与抽取相关、但非「实体/关系/事件抽取」的其它 LLM 提示

以下模块**不**使用上一节的 `build_extraction_user_prompt`，列入备查以免混淆：

| 模块 | 文件 | 用途 |
|------|------|------|
| 检索规划器 | `agentic_llm_plan.py` | 图检索与工具规划 JSON，非 SessionExtraction |
| Agentic 摘要 | `agentic_synthesize.py` | 基于检索结果的总结，非结构化抽取 |
| 数据集脚本等 | `scripts/build_zh_locomo_datasets.py` 等 | 离线翻译，与 AMS 抽取无关 |

---

## 6. 后处理与规则（非 prompt）

- **Layer2 规则**: `extractors.apply_layer2_rules` 等对图做确定性修补（非 LLM）。
- **Hybrid 低价值事件剪枝**: `hybrid_postprocess.prune_low_value_session_events`，与系统提示中的事件粒度口径一致；开关见 `docs/ams-hybrid-extraction.md` 与 `AMS_EVENT_PRUNE_LOW_VALUE` 等环境变量。
- **结构兜底**: `extractors._minimal_extraction_from_blocks` 在 LLM 失败时生成最小图，无额外 prompt。

---

## 7. 变更时如何维护

1. 修改抽取口径时，应同步更新 **`llm_extract.py`** 中的 `_EXTRACTION_SYSTEM_PROMPT_ZH`、必要时 `_EXTRACTION_SCHEMA` 与 `build_extraction_user_prompt`。
2. 更新本文档或至少在 PR 描述中说明「文档 `docs/ams-extraction-prompts.md` 已同步 / 待同步」。
3. 单元测试 `tests/unit/ams/test_llm_extract_parse.py` 等对 `EXTRACTION_SYSTEM_PROMPT` 有关键字断言，改文案时需一并调整测试。
