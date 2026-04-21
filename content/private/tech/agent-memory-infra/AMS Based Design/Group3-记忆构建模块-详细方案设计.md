# Group 3 记忆构建模块 - 详细技术方案设计

> **文档版本**: v1.0
> **日期**: 2026-03-30
> **负责组**: Group 3 (记忆构建 - Session/Trace)
> **核心目标**: 从用户会话和 Agent Trace 中构建时序知识图谱 (Temporal KG)

---

## 目录

1. [数据准备](#1-数据准备)
2. [数据处理 Pipeline](#2-数据处理-pipeline)
3. [数据存储设计](#3-数据存储设计)
4. [检索与评估](#4-检索与评估)
5. [开发排期与里程碑](#5-开发排期与里程碑)

---

## 1. 数据准备

### 1.1 数据来源与特性

Group 3 处理的数据类型：

| 数据类型                 | 来源                   | 特性               | 处理难度 |
| -------------------- | -------------------- | ---------------- | ---- |
| **User Interaction** | Agent Framework 会话数据 | 多轮对话、意图漂移、口语化    | 中    |
| **Agent Trace**      | Agent-TES 执行轨迹       | 工具调用链、时序依赖、结构化日志 | 中    |
| **Session Archive**  | Working Memory 归档    | 完整会话上下文、高价值筛选后数据 | 低    |

### 1.2 公开数据集推荐

#### 1.2.1 对话/会话数据集

| 数据集                                                 | 规模      | 语言  | 适用场景         | 下载链接                                                       |
| --------------------------------------------------- | ------- | --- | ------------ | ---------------------------------------------------------- |
| **MultiWOZ 2.4**                                    | 10K+ 对话 | 英文  | 多领域任务对话、槽位填充 | [GitHub](https://github.com/budzianowski/multiwoz)         |
| **CrossWOZ**                                        | 6K 对话   | 中文  | 中文多轮对话、跨领域   | [GitHub](https://github.com/thu-coai/CrossWOZ)             |
| **LCCC (Large-scale Cleaned Chinese Conversation)** | 12M 对话  | 中文  | 开放域闲聊、对话生成   | [GitHub](https://github.com/thu-coai/CDial-GPT)            |
| **ConvAI2**                                         | 10K+ 对话 | 英文  | 个性化对话、人物画像   | [ParlAI](http://parl.ai/projects/convai2/)                 |
| **CAiRE**                                           | 多轮对话    | 中英文 | 任务型对话、知识问答   | [PapersWithCode](https://paperswithcode.com/dataset/caire) |

#### 1.2.2 Agent/工具调用轨迹数据集

| 数据集              | 规模          | 特性             | 适用场景          |
| ---------------- | ----------- | -------------- | ------------- |
| **ToolBench**    | 16K+ API 调用 | 真实 API 调用序列    | 工具使用学习、API 推荐 |
| **APIBench**     | API 调用序列    | 代码-API 对应关系    | 代码辅助、API 检索   |
| **GorillaBench** | 1,600+ API  | 多模态 API 调用     | API 选择、参数填充   |
| **AgentBench**   | 多环境评测       | LLM Agent 能力评测 | Agent 能力评估    |
| **WebShop**      | 12K 轨迹      | 电商购物任务         | 任务规划、决策制定     |

#### 1.2.3 时序/事件知识图谱数据集

| 数据集                                                  | 规模         | 特性        | 适用场景      |
| ---------------------------------------------------- | ---------- | --------- | --------- |
| **ICEWS (Integrated Conflict Early Warning System)** | 2.6M 事件    | 国际政治事件、时序 | 事件预测、时序推理 |
| **GDELT**                                            | 全球事件数据库    | 实时新闻事件    | 事件检测、趋势分析 |
| **Wikidata-Temporal**                                | 结构化知识 + 时间 | 实体生命周期    | 时序知识补全    |
| **YAGO-Temporal**                                    | 时序事实       | 实体时间属性    | 时序问答      |

### 1.3 数据预处理建议

```python
# 示例：MultiWOZ 数据转换为 AMS Raw Block 格式
{
  "block_id": "blk_session_001_turn_003",
  "tenant_id": "demo",
  "source_type": "user_interaction",
  "content": "User: 我想预订一家中餐厅，预算在200元左右。 System: 请问您希望在哪个区域用餐？",
  "metadata": {
    "session_id": "sess_001",
    "turn_id": 3,
    "user_intent": "restaurant_booking",
    "slots": {"cuisine": "chinese", "price_range": "200"}
  },
  "timestamp": "2026-03-30T10:15:00Z"
}
```

---

## 2. 数据处理 Pipeline

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Group 3 Memory Processing Pipeline               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Input Sources                                                          │
│  ├── User Session (多轮对话)                                             │
│  └── Agent Trace (执行轨迹)                                              │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Stage 1: Session Normalization                                  │   │
│  │  ├── Session 分段 (按任务边界)                                    │   │
│  ├──├── 意图识别与槽位填充                                          │   │
│  │  └── 会话摘要生成                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Stage 2: Entity & Event Extraction                              │   │
│  │  ├── Two-Pass NER (spaCy + LLM)                                  │   │
│  │  ├── 事件抽取 (Event Extraction)                                  │   │
│  │  ├── 时间表达式识别 (Temporal Expression)                          │   │
│  │  └── 指代消解 (Coreference Resolution)                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Stage 3: Temporal KG Construction                               │   │
│  │  ├── 实体链接 (Entity Linking)                                    │   │
│  │  ├── 时序关系抽取 (Temporal Relation Extraction)                   │   │
│  │  ├── 因果推断 (Causal Inference)                                  │   │
│  │  └── 时序一致性校验 (Temporal Consistency Check)                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Stage 4: Storage & Indexing                                     │   │
│  │  ├── Neo4j (Temporal KG 存储)                                     │   │
│  │  ├── Milvus (实体向量索引)                                        │   │
│  │  └── LanceDB (元数据与内容)                                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Stage 1: Session Normalization

#### 2.2.1 会话分段 (Session Segmentation)

```python
class SessionSegmenter:
    """
    将长会话按任务边界切分为独立的 Episode
    """

    def segment(self, messages: List[Message]) -> List[Episode]:
        """
        基于以下信号进行分段：
        1. 用户显式任务切换 ("换个话题")
        2. 意图类别变化 (restaurant_booking -> hotel_booking)
        3. 长时间间隔 (> 5分钟)
        4. 任务完成信号 ("谢谢"/"再见")
        """
        episodes = []
        current_segment = []

        for i, msg in enumerate(messages):
            current_segment.append(msg)

            # 检测分段信号
            if self._is_boundary_signal(msg, messages[i-1] if i > 0 else None):
                episodes.append(self._create_episode(current_segment))
                current_segment = []

        if current_segment:
            episodes.append(self._create_episode(current_segment))

        return episodes

    def _is_boundary_signal(self, current: Message, previous: Optional[Message]) -> bool:
        """检测会话边界信号"""
        # 显式切换
        if any(kw in current.content for kw in ["换个话题", "重新", "另外"]):
            return True

        # 时间间隔
        if previous and (current.timestamp - previous.timestamp) > timedelta(minutes=5):
            return True

        # 意图变化
        if current.intent != previous.intent:
            return True

        return False
```

#### 2.2.2 意图识别与槽位填充

```python
class IntentSlotExtractor:
    """
    使用轻量模型进行意图识别和槽位填充
    """

    def __init__(self):
        # 使用 BERT-based 分类器
        self.intent_classifier = pipeline(
            "text-classification",
            model="distilbert-base-uncased-finetuned-sst-2-english"
        )
        self.slot_tagger = TokenClassificationPipeline(
            model="dslim/bert-base-NER"
        )

    def extract(self, user_message: str) -> IntentSlotResult:
        intent = self.intent_classifier(user_message)
        slots = self.slot_tagger(user_message)

        return IntentSlotResult(
            intent=intent["label"],
            confidence=intent["score"],
            slots=self._normalize_slots(slots)
        )
```

### 2.3 Stage 2: Entity & Event Extraction

#### 2.3.1 Two-Pass NER 实现

```python
class TwoPassNER:
    """
    两遍实体抽取：spaCy 快速 + LLM 精准
    """

    def __init__(self):
        # Fast Pass: spaCy
        self.nlp_fast = spacy.load("zh_core_web_trf")  # 中文
        self.nlp_fast_en = spacy.load("en_core_web_trf")  # 英文

        # LLM for precise extraction
        self.llm_client = OpenAIClient()

    async def extract(self, content: str, language: str = "zh") -> List[Entity]:
        # Pass 1: Fast extraction
        doc = self.nlp_fast(content) if language == "zh" else self.nlp_fast_en(content)
        fast_entities = [
            Entity(
                name=ent.text,
                type=ent.label_,
                confidence=0.7,  # spaCy 默认置信度
                source="spacy"
            )
            for ent in doc.ents
        ]

        # Pass 2: LLM precise extraction (only for high-value content)
        if self._is_high_value(content):
            llm_entities = await self._llm_extract(content, language)
            # Merge: LLM 结果优先级更高
            return self._merge_entities(fast_entities, llm_entities)

        return fast_entities

    async def _llm_extract(self, content: str, language: str) -> List[Entity]:
        prompt = f"""
请从以下文本中提取所有重要实体（人物、组织、工具、概念、操作、事件）。

要求：
1. 规范化实体名称（去除口语化表达）
2. 识别实体类型：person / org / tool / concept / action / event
3. 为每个实体提供一句话描述
4. 给出置信度（0.0-1.0）

文本内容：
{content[:800]}

请以 JSON 数组格式返回：
[
  {{
    "name": "实体名称",
    "entity_type": "tool",
    "description": "Python 数据分析库",
    "confidence": 0.95
  }}
]
"""

        response = await self.llm_client.chat_completion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )

        return [Entity(**e) for e in json.loads(response)]
```

#### 2.3.2 时间表达式识别

```python
class TemporalExpressionExtractor:
    """
    识别和规范化时间表达式
    """

    def __init__(self):
        # 使用 SUTime (Stanford) 或 HeidelTime
        self.time_parser = SUTime()

    def extract(self, text: str, reference_time: datetime) -> List[TemporalExpr]:
        """
        识别时间表达式并解析为绝对时间

        示例：
        - "昨天" -> 2026-03-29
        - "下周三" -> 2026-04-08
        - "下午3点" -> 15:00
        """
        parsed = self.time_parser.parse(text, reference_time)

        return [
            TemporalExpr(
                text=p["text"],
                type=p["type"],  # DATE / TIME / DURATION
                value=p["value"],  # ISO 8601 格式
                start=p["start"],
                end=p["end"]
            )
            for p in parsed
        ]
```

#### 2.3.3 事件抽取

```python
class EventExtractor:
    """
    从文本中抽取结构化事件
    """

    def __init__(self):
        self.llm_client = OpenAIClient()

    async def extract_events(self, content: str, context: SessionContext) -> List[Event]:
        """
        抽取事件及其参与者、时间、地点

        ACE 2005 事件类型：
        - LIFE: be-born, marry, divorce, injure, die
        - BUSINESS: start-org, merge-org, declare-bankruptcy, end-org
        - TRANSACTION: transfer-ownership, transfer-money
        - CONFLICT: attack, demonstrate
        - CONTACT: meet, phone-write
        """
        prompt = f"""
请从以下对话中抽取结构化事件。

事件定义：一个事件包含触发词、事件类型、参与者（角色）、时间、地点。

对话内容：
{content}

会话上下文：
- 会话时间: {context.session_time}
- 用户: {context.user_id}

请以 JSON 格式返回事件列表：
[
  {{
    "trigger": "预订",
    "event_type": "transaction/booking",
    "arguments": [
      {{"role": "agent", "entity": "用户"}},
      {{"role": "object", "entity": "餐厅"}},
      {{"role": "time", "value": "2026-03-30T18:00:00"}}
    ],
    "confidence": 0.85
  }}
]
"""

        response = await self.llm_client.chat_completion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )

        return [Event(**e) for e in json.loads(response).get("events", [])]
```

### 2.4 Stage 3: Temporal KG Construction

#### 2.4.1 实体链接 (Entity Linking)

```python
class EntityLinker:
    """
    将新抽取的实体链接到已有实体或创建新实体
    """

    def __init__(self, neo4j_client: Neo4jClient, milvus_client: MilvusClient):
        self.neo4j = neo4j_client
        self.milvus = milvus_client
        self.embedding_svc = EmbeddingService()

    async def link_or_create(self, entity: Entity, tenant_id: str) -> str:
        """
        返回链接到的 entity_id（已有或新创建）
        """
        # Step 1: 生成实体 embedding
        entity_emb = await self.embedding_svc.embed(
            f"{entity.name} {entity.description}"
        )

        # Step 2: 向量检索相似实体
        similar_entities = await self.milvus.search(
            collection="node_embeddings",
            data=[entity_emb],
            limit=5,
            expr=f'tenant_id == "{tenant_id}"'
        )

        # Step 3: 判断是否为同一实体
        for sim in similar_entities[0]:
            if sim.score > 0.92:  # 高相似度阈值
                # 进一步验证：名称规范化后比较
                existing = await self.neo4j.get_entity(sim.entity_id)
                if self._is_same_entity(entity, existing):
                    # 更新已有实体（增加别名、访问计数）
                    await self._update_existing_entity(existing["entity_id"], entity)
                    return existing["entity_id"]

        # Step 4: 创建新实体
        entity_id = await self._create_new_entity(entity, tenant_id, entity_emb)
        return entity_id

    def _is_same_entity(self, new: Entity, existing: dict) -> bool:
        """判断两个实体是否为同一实体的核心逻辑"""
        # 名称规范化比较
        norm_new = self._normalize_name(new.name)
        norm_existing = self._normalize_name(existing["name"])

        if norm_new == norm_existing:
            return True

        # 别名匹配
        aliases = set(existing.get("aliases", []))
        if norm_new in aliases:
            return True

        return False
```

#### 2.4.2 时序关系抽取

```python
class TemporalRelationExtractor:
    """
    抽取实体间的时序关系
    """

    TEMPORAL_RELATIONS = [
        "follows",        # A 在 B 之后发生
        "precedes",       # A 在 B 之前发生
        "simultaneous",   # A 和 B 同时发生
        "contains",       # A 包含 B（时间区间）
        "causes",         # A 导致 B
        "enables",        # A 使能 B
        "prevents",       # A 阻止 B
    ]

    async def extract(self, events: List[Event], text: str) -> List[TemporalRelation]:
        """
        基于事件时间和文本线索抽取时序关系
        """
        relations = []

        # 基于时间戳的显式时序关系
        for i, event_a in enumerate(events):
            for event_b in events[i+1:]:
                if event_a.time and event_b.time:
                    rel = self._infer_temporal_relation(event_a, event_b)
                    if rel:
                        relations.append(rel)

        # 基于文本线索的隐式时序关系
        text_relations = await self._extract_from_text(events, text)
        relations.extend(text_relations)

        return relations

    def _infer_temporal_relation(self, event_a: Event, event_b: Event) -> Optional[TemporalRelation]:
        """基于时间戳推断时序关系"""
        time_a = event_a.time
        time_b = event_b.time

        if time_a and time_b:
            if time_a < time_b:
                return TemporalRelation(
                    source=event_a.id,
                    target=event_b.id,
                    type="precedes",
                    confidence=0.9
                )
            elif time_a > time_b:
                return TemporalRelation(
                    source=event_a.id,
                    target=event_b.id,
                    type="follows",
                    confidence=0.9
                )

        return None
```

#### 2.4.3 时序一致性校验

```python
class TemporalConsistencyChecker:
    """
    检测和修复时序知识图谱中的不一致
    """

    def check(self, kg: TemporalKG) -> List[Inconsistency]:
        """
        检查时序一致性约束：
        1. 传递性：A before B, B before C → A before C
        2. 非自反性：A 不能在 A 之前
        3. 因果链合理性：原因时间 <= 结果时间
        """
        inconsistencies = []

        # 检查循环依赖
        cycles = self._detect_cycles(kg)
        for cycle in cycles:
            inconsistencies.append(Inconsistency(
                type="cycle",
                description=f"发现时序循环: {' -> '.join(cycle)}",
                severity="high"
            ))

        # 检查因果时序矛盾
        for edge in kg.edges:
            if edge.type == "causes":
                source_time = kg.get_node(edge.source).time
                target_time = kg.get_node(edge.target).time

                if source_time and target_time and source_time > target_time:
                    inconsistencies.append(Inconsistency(
                        type="causal_temporal_conflict",
                        description=f"因果时序矛盾: {edge.source} 在 {edge.target} 之后",
                        severity="high"
                    ))

        return inconsistencies
```

---

## 3. 数据存储设计

### 3.1 存储架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Group 3 Storage Architecture                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │    Neo4j        │  │    Milvus       │  │   LanceDB       │         │
│  │                 │  │                 │  │                 │         │
│  │ Temporal KG     │  │ Entity Vectors  │  │ Metadata +      │         │
│  │ - PhraseNode    │  │ - node_emb      │  │ Raw Content     │         │
│  │ - EventNode     │  │ - event_emb     │  │                 │         │
│  │ - Relations     │  │                 │  │                 │         │
│  │ - Temporal Edges│  │                 │  │                 │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│         │                     │                     │                   │
│         └─────────────────────┼─────────────────────┘                   │
│                               │                                         │
│                               ▼                                         │
│                    ┌─────────────────────┐                              │
│                    │   Storage SDK       │                              │
│                    │   (统一访问层)       │                              │
│                    └─────────────────────┘                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Neo4j 图模型设计 (Temporal KG)

#### 3.2.1 节点类型

```cypher
// PhraseNode - 实体/概念节点
(:PhraseNode {
  entity_id: "ent_acmecorp_01hq4j...",  // 统一 ID
  tenant_id: "acmecorp",
  agent_id: "agent_001",  // null 表示公共实体

  // 基本属性
  name: "pandas",
  original_text: "Pandas",
  description: "Python 数据分析与处理库",
  entity_type: "tool",  // person/org/tool/concept/action/event

  // 统计属性
  importance: 0.85,
  access_count: 42,
  decay_weight: 0.95,  // 时序衰减权重

  // 时序属性
  valid_from: datetime("2026-01-01T00:00:00"),
  valid_until: null,  // null 表示当前有效

  // 溯源
  source_memory_id: "mem_001",
  source_block_ids: ["blk_001", "blk_002"],

  // 元数据
  created_at: datetime(),
  updated_at: datetime()
})

// EventNode - 事件节点
(:EventNode {
  event_id: "evt_acmecorp_01hq4j...",
  tenant_id: "acmecorp",
  agent_id: "agent_001",

  trigger_word: "预订",
  event_type: "transaction/booking",

  // 时间信息
  start_time: datetime("2026-03-30T18:00:00"),
  end_time: null,
  duration_minutes: null,

  // 置信度
  confidence: 0.88,

  // 溯源
  source_memory_id: "mem_001",
  source_session_id: "sess_abc123",

  created_at: datetime()
})

// CommunityNode - 社区节点
(:CommunityNode {
  community_id: "com_acmecorp_01hq4j...",
  tenant_id: "acmecorp",
  agent_id: "agent_001",

  level: 0,  // 0=叶子社区, 1=上层社区
  summary: "数据处理工具链相关概念",
  member_count: 15,

  created_at: datetime(),
  updated_at: datetime()
})
```

#### 3.2.2 关系类型

```cypher
// 语义关系
(:PhraseNode)-[:RELATES_TO {
  relation_type: "depends_on",
  description: "read_csv 依赖 pandas",
  weight: 0.85,
  importance: 0.7,

  // 时序属性
  valid_from: datetime(),
  valid_until: null,

  source_memory_id: "mem_001",
  created_at: datetime()
}]->(:PhraseNode)

// 时序关系
(:EventNode)-[:FOLLOWS {
  time_gap_minutes: 5,
  confidence: 0.9
}]->(:EventNode)

(:EventNode)-[:CAUSES {
  causal_strength: 0.8,
  evidence: "用户明确要求预订导致预订事件"
}]->(:EventNode)

// 实体-事件参与关系
(:PhraseNode)-[:PARTICIPATES_IN {
  role: "agent",  // agent/object/instrument/time/location
  confidence: 0.92
}]->(:EventNode)

// 上下文关系 (Tree ↔ Graph 桥接)
(:Block {block_id: "blk_001"})-[:HAS_CONTEXT {
  weight: 0.9,  // 相关性权重
  chunk_position: 2,
  created_at: datetime()
}]->(:PhraseNode)

// 社区归属
(:PhraseNode)-[:BELONGS_TO {
  membership_score: 0.92,
  created_at: datetime()
}]->(:CommunityNode)
```

#### 3.2.3 约束与索引

```cypher
// 唯一约束
CREATE CONSTRAINT phrase_node_id IF NOT EXISTS
  FOR (n:PhraseNode) REQUIRE n.entity_id IS UNIQUE;

CREATE CONSTRAINT event_node_id IF NOT EXISTS
  FOR (n:EventNode) REQUIRE n.event_id IS UNIQUE;

CREATE CONSTRAINT community_node_id IF NOT EXISTS
  FOR (n:CommunityNode) REQUIRE n.community_id IS UNIQUE;

// 查询索引
CREATE INDEX phrase_name_idx IF NOT EXISTS
  FOR (n:PhraseNode) ON (n.tenant_id, n.name);

CREATE INDEX phrase_type_idx IF NOT EXISTS
  FOR (n:PhraseNode) ON (n.entity_type);

CREATE INDEX event_time_idx IF NOT EXISTS
  FOR (n:EventNode) ON (n.start_time);

CREATE INDEX temporal_valid_idx IF NOT EXISTS
  FOR (n:PhraseNode) ON (n.valid_from, n.valid_until);
```

### 3.3 Milvus 集合设计

#### 3.3.1 node_embeddings 集合

```python
from pymilvus import CollectionSchema, FieldSchema, DataType

node_fields = [
    FieldSchema("entity_id", DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id", DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id", DataType.VARCHAR, max_length=64),
    FieldSchema("name", DataType.VARCHAR, max_length=300),
    FieldSchema("entity_type", DataType.VARCHAR, max_length=30),
    FieldSchema("description", DataType.VARCHAR, max_length=1000),
    FieldSchema("community_id", DataType.VARCHAR, max_length=64),
    FieldSchema("importance", DataType.FLOAT),
    FieldSchema("decay_weight", DataType.FLOAT),
    FieldSchema("created_at", DataType.INT64),
    FieldSchema("embedding", DataType.FLOAT_VECTOR, dim=1536),
]

node_schema = CollectionSchema(
    fields=node_fields,
    description="Entity embeddings for semantic search"
)

node_collection = Collection(name="node_embeddings", schema=node_schema)

# HNSW 索引
node_collection.create_index(
    field_name="embedding",
    index_params={
        "index_type": "HNSW",
        "metric_type": "COSINE",
        "params": {"M": 16, "efConstruction": 200}
    }
)
```

#### 3.3.2 event_embeddings 集合

```python
event_fields = [
    FieldSchema("event_id", DataType.VARCHAR, max_length=64, is_primary=True),
    FieldSchema("tenant_id", DataType.VARCHAR, max_length=64),
    FieldSchema("agent_id", DataType.VARCHAR, max_length=64),
    FieldSchema("trigger_word", DataType.VARCHAR, max_length=100),
    FieldSchema("event_type", DataType.VARCHAR, max_length=50),
    FieldSchema("start_time", DataType.INT64),  // Unix timestamp
    FieldSchema("embedding", DataType.FLOAT_VECTOR, dim=1536),
]
```

### 3.4 LanceDB 表设计

```python
import lancedb

# 连接 LanceDB
db = lancedb.connect("/path/to/lancedb")

# 会话元数据表
session_schema = pa.schema([
    ("session_id", pa.string()),
    ("tenant_id", pa.string()),
    ("agent_id", pa.string()),
    ("user_id", pa.string()),
    ("start_time", pa.timestamp('us')),
    ("end_time", pa.timestamp('us')),
    ("message_count", pa.int32()),
    ("task_summary", pa.string()),
    ("outcome", pa.string()),
    ("raw_content", pa.string()),  # 完整会话内容 (< 4KB)
    ("content_oss_key", pa.string()),  # 大内容 OSS 路径
])

# 创建表
sessions_table = db.create_table("sessions", schema=session_schema)

# Block 内容表（与 Tree 共享）
block_schema = pa.schema([
    ("block_id", pa.string()),
    ("session_id", pa.string()),
    ("tenant_id", pa.string()),
    ("content", pa.string()),
    ("turn_index", pa.int32()),
    ("speaker", pa.string()),  # user / assistant
    ("timestamp", pa.timestamp('us')),
    ("intent", pa.string()),
])
```

---

## 4. 检索与评估

### 4.1 检索能力设计

#### 4.1.1 时序图谱检索

```python
class TemporalKGRetriever:
    """
    基于时序知识图谱的检索
    """

    def __init__(self, neo4j_client: Neo4jClient):
        self.neo4j = neo4j_client

    async def query_temporal_path(self,
                                   entity_a: str,
                                   entity_b: str,
                                   max_depth: int = 3) -> List[TemporalPath]:
        """
        查找两个实体间的时序路径

        示例查询："用户上周使用 pandas 时遇到的问题是什么？"
        """
        cypher = """
        MATCH path = (a:PhraseNode {name: $entity_a})-
                     [:FOLLOWS|CAUSES|RELATES_TO*1..$max_depth]-
                     (b:PhraseNode {name: $entity_b})
        WHERE ALL(r IN relationships(path) WHERE
            (r.valid_until IS NULL OR r.valid_until > datetime())
        )
        RETURN path,
               [n IN nodes(path) | n.name] as node_names,
               [r IN relationships(path) | r.type] as rel_types
        ORDER BY length(path)
        LIMIT 10
        """

        results = await self.neo4j.run(cypher, entity_a=entity_a, entity_b=entity_b, max_depth=max_depth)
        return [TemporalPath(**r) for r in results]

    async def query_event_sequence(self,
                                    start_time: datetime,
                                    end_time: datetime,
                                    entity_filter: Optional[str] = None) -> List[Event]:
        """
        查询指定时间范围内的事件序列
        """
        cypher = """
        MATCH (e:EventNode)
        WHERE e.start_time >= $start_time
          AND e.start_time <= $end_time
        """

        if entity_filter:
            cypher += """
            AND (e)-[:PARTICIPATES_IN]-(:PhraseNode {name: $entity_filter})
            """

        cypher += """
        RETURN e
        ORDER BY e.start_time
        """

        results = await self.neo4j.run(cypher, start_time=start_time, end_time=end_time, entity_filter=entity_filter)
        return [Event(**r["e"]) for r in results]
```

#### 4.1.2 多跳推理检索

```python
class MultiHopRetriever:
    """
    基于 PPR (Personalized PageRank) 的多跳推理检索
    """

    async def retrieve_with_ppr(self,
                                 query_entities: List[str],
                                 top_k: int = 20) -> List[ScoredEntity]:
        """
        使用 Personalized PageRank 从种子实体扩散
        """
        # Step 1: 找到种子实体节点
        seed_query = """
        MATCH (n:PhraseNode)
        WHERE n.name IN $query_entities
        RETURN n.entity_id as entity_id
        """
        seeds = await self.neo4j.run(seed_query, query_entities=query_entities)
        seed_ids = [s["entity_id"] for s in seeds]

        # Step 2: 运行 PPR 算法
        ppr_query = """
        MATCH (seed:PhraseNode) WHERE seed.entity_id IN $seed_ids
        WITH collect(seed) AS seedNodes
        CALL gds.pageRank.stream('temporal-graph', {
            sourceNodes: seedNodes,
            dampingFactor: 0.85,
            maxIterations: 50,
            relationshipWeightProperty: 'weight'
        })
        YIELD nodeId, score
        RETURN gds.util.asNode(nodeId) as node, score
        ORDER BY score DESC
        LIMIT $top_k
        """

        results = await self.neo4j.run(ppr_query, seed_ids=seed_ids, top_k=top_k)
        return [
            ScoredEntity(entity=r["node"], score=r["score"])
            for r in results
        ]
```

### 4.2 评估方案

#### 4.2.1 数据集构建

```
评估数据集结构：

ams_evaluation_dataset/
├── session_qa/                    # 会话问答对
│   ├── train.jsonl
│   ├── dev.jsonl
│   └── test.jsonl
├── temporal_reasoning/            # 时序推理题
│   ├── before_after.jsonl       # 先后关系
│   ├── causal_inference.jsonl   # 因果推断
│   └── duration_estimation.jsonl # 持续时长估计
├── entity_linking/                # 实体链接
│   └── entity_disambiguation.jsonl
└── multi_hop/                     # 多跳问答
    ├── 2hop_questions.jsonl
    └── 3hop_questions.jsonl
```

示例数据格式：

```json
{
  "query": "用户昨天提到的那个数据分析库是什么？",
  "context": {
    "current_time": "2026-03-30T10:00:00Z",
    "user_id": "user_001"
  },
  "expected_answer": "pandas",
  "evidence_session_ids": ["sess_20260329_1430"],
  "difficulty": "medium",
  "evaluation_metrics": ["recall@1", "mrr"]
}
```

#### 4.2.2 评估指标

| 指标类别     | 指标名称                       | 说明        | 目标值    |
| -------- | -------------------------- | --------- | ------ |
| **检索质量** | Recall@K                   | Top-K 召回率 | > 0.85 |
|          | MRR (Mean Reciprocal Rank) | 平均倒数排名    | > 0.70 |
|          | NDCG@K                     | 归一化折损累积增益 | > 0.75 |
| **实体抽取** | Entity Precision           | 实体抽取精确率   | > 0.80 |
|          | Entity Recall              | 实体抽取召回率   | > 0.75 |
|          | Entity F1                  | 实体抽取 F1   | > 0.77 |
| **时序推理** | Temporal Accuracy          | 时序关系判断准确率 | > 0.85 |
|          | Causal Accuracy            | 因果关系判断准确率 | > 0.70 |
| **多跳问答** | 2-hop Accuracy             | 两跳问答准确率   | > 0.65 |
|          | 3-hop Accuracy             | 三跳问答准确率   | > 0.50 |

#### 4.2.3 业界基准对比

| 基准测试         | 说明     | 我们的目标            |
| ------------ | ------ | ---------------- |
| **HippoRAG** | 多跳问答基准 | Recall@10 > 0.75 |
| **T-REx**    | 时序关系抽取 | F1 > 0.70        |
| **TimeQA**   | 时序问答   | EM > 0.60        |
| **CLUTRR**   | 因果推理   | Accuracy > 0.80  |

#### 4.2.4 评估脚本示例

```python
class TemporalKGEvaluator:
    """
    时序知识图谱评估器
    """

    def __init__(self, retriever: TemporalKGRetriever):
        self.retriever = retriever

    async def evaluate_temporal_qa(self, test_file: str) -> dict:
        """
        评估时序问答能力
        """
        results = []

        with open(test_file) as f:
            for line in f:
                sample = json.loads(line)

                # 执行检索
                retrieved = await self.retriever.retrieve(
                    query=sample["query"],
                    context=sample["context"]
                )

                # 判断正确性
                is_correct = self._check_correctness(
                    retrieved,
                    sample["expected_answer"]
                )

                # 计算排名
                rank = self._get_answer_rank(retrieved, sample["expected_answer"])

                results.append({
                    "query_id": sample["id"],
                    "correct": is_correct,
                    "rank": rank,
                    "reciprocal_rank": 1.0 / rank if rank else 0
                })

        # 计算指标
        metrics = {
            "recall@1": sum(1 for r in results if r["rank"] == 1) / len(results),
            "recall@5": sum(1 for r in results if r["rank"] and r["rank"] <= 5) / len(results),
            "mrr": sum(r["reciprocal_rank"] for r in results) / len(results),
        }

        return metrics
```

---

## 5. 开发排期与里程碑

### 5.1 2-3周原型阶段排期

| Week       | 任务              | 产出                        | 负责人  |
| ---------- | --------------- | ------------------------- | ---- |
| **Week 1** | 数据集调研与准备        | 选定 2-3 个公开数据集，完成数据预处理脚本   | 露阳   |
|            | Neo4j 环境搭建      | 本地 Neo4j + GDS 插件部署完成     | 吕鑫   |
|            | Session 分段原型    | SessionSegmenter 基础版本     | 彬彬   |
| **Week 2** | Two-Pass NER 实现 | spaCy + LLM NER Pipeline  | 露阳   |
|            | 实体链接原型          | EntityLinker 基础版本         | 吕鑫   |
|            | 时序关系抽取          | TemporalRelationExtractor | 彬彬   |
|            | Neo4j Schema 设计 | Cypher Schema + 索引        | 吕鑫   |
| **Week 3** | Temporal KG 构建  | 端到端 KG 构建 Pipeline        | 三人协作 |
|            | 检索接口实现          | PPR + 时序查询接口              | 彬彬   |
|            | 评估数据集构建         | 100+ 测试样例                 | 露阳   |
|            | 原型演示准备          | Demo + 文档                 | 三人协作 |

### 5.2 技术风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 实体消歧准确率低 | 图谱质量差 | 先用规则+简单向量相似，后期引入更复杂的消歧模型 |
| 时序表达式识别不准 | 时序关系错误 | 使用成熟的 SUTime/HeidelTime 库，而非自研 |
| Neo4j 性能瓶颈 | 写入慢 | 批量写入、异步处理、连接池优化 |
| LLM API 延迟/成本 | Pipeline 吞吐低 | 本地部署小模型作为 Fallback |

### 5.3 与 Group 1/2 的协作接口

```python
# Group 3 接收来自 Group 1 的数据格式
class Group1ToGroup3Interface:
    """
    Group 1 (Working Memory / Session) → Group 3 (记忆构建)
    """

    async def receive_session_archive(self, data: dict):
        """
        接收 Group 1 归档的会话数据
        """
        expected_format = {
            "session_id": "str",
            "tenant_id": "str",
            "agent_id": "str",
            "messages": [{"role": "str", "content": "str", "timestamp": "iso8601"}],
            "tool_history": [{"tool": "str", "input": "dict", "output": "dict"}],
            "session_summary": "str",
            "promotion_score": "float"
        }

        # 触发 Group 3 的处理 Pipeline
        await self.process_session(data)

# Group 3 接收来自 Group 2 的数据格式
class Group2ToGroup3Interface:
    """
    Group 2 (知识库构建) → Group 3 (记忆构建)

    Group 3 可以从 Group 2 产出的 Block 中抽取实体，
    补充到全局知识图谱中
    """

    async def receive_knowledge_blocks(self, blocks: List[dict]):
        """
        接收 Group 2 的知识 Block，提取实体
        """
        for block in blocks:
            entities = await self.extract_entities(block["content"])
            # 链接到全局图谱
            await self.link_to_global_kg(entities)
```

---

## 附录

### A. 依赖安装清单

```bash
# 核心依赖
pip install neo4j-python-driver pymilvus lancedb

# NLP/NER
pip install spacy transformers
python -m spacy download zh_core_web_trf
python -m spacy download en_core_web_trf

# 图算法
pip install networkx leidenalg igraph

# 时序处理
pip install sutime dateparser

# 向量化
pip install openai sentence-transformers

# 评估
pip install scikit-learn pandas
```

### B. 参考资源

1. **HippoRAG**: [GitHub](https://github.com/OSU-NLP-Group/HippoRAG) - 受海马体启发的知识图谱检索
2. **RAPTOR**: [GitHub](https://github.com/parthsarthi03/raptor) - 递归抽象树组织检索
3. **GraphRAG**: [GitHub](https://github.com/microsoft/graphrag) - 微软知识图谱 RAG
4. **LightRAG**: [GitHub](https://github.com/HKUSTDial/LightRAG) - 轻量级知识图谱检索
5. **Neo4j GDS**: [文档](https://neo4j.com/docs/graph-data-science/current/) - 图数据科学库

---

*本文档为 Group 3 原型阶段详细设计方案，后续根据原型验证结果迭代更新。*
