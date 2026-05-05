
- **版本**：v1.0
- **日期**：2026-04
- **定位**：可执行技术设计文档（面向工程落地）

## 第一部分：方案概述

### 1.1 背景
大语言模型驱动的 Agent 在生产环境中面临核心挑战：跨会话的长期记忆缺失。现有解决方案各有侧重：

- EverMemOS 提供了迄今最完整的情景-语义两层记忆架构，但缺乏显式实体关系建模
- Zep/Graphiti 在时序关系推理上领先，但场景化组织和用户个性化建模偏弱
- Mem0 生产成熟度最高，但架构偏扁平，缺乏主动激活机制

本方案以 EverMemOS 为核心骨架，在其基础上融合轻量知识图谱层，形成「情景记忆 + 语义记忆 + 程序记忆」三位一体的记忆系统。

### 1.2 目标

| 目标类型 | 具体目标 |
| --- | --- |
| 功能目标 | 实现跨会话的长期结构化记忆，支持场景回忆、个性化推理、实体关系推理、主动记忆激活 |
| 性能目标 | 单次检索 P95 延迟 < 200ms；记忆写入 P95 延迟 < 500ms（异步可接受 < 3s） |
| 质量目标 | LOCOMO 基准 > 90%；记忆一致性冲突处理覆盖率 > 95% |
| 工程目标 | 可水平扩展；支持百万级 MemCell；容器化一键部署 |

### 1.3 适用场景

**强适用：**

- 个人 AI 助手：长期陪伴型 Agent，需要记住用户偏好、生活状态、历史约定
- 企业知识助手：记住用户工作背景、项目进展、跨会话任务链
- 医疗/健康 Agent：记录用户健康状态、药物禁忌、随访提醒（需 PII 保护）
- 教育 Agent：追踪学生学习进展、知识薄弱点、学习风格

**中等适用：**

- 客服系统（需结合外部 CRM 数据）
- 多 Agent 协作框架（需扩展共享记忆层）

**不适用：**

- 纯检索增强（RAG）场景，无需长期个性化记忆
- 高频、超低延迟场景（< 50ms 要求）
- 无状态 API 服务（无需跨会话持久化）

### 1.4 方案优劣势分析

**优势：**

| 优势点 | 说明 |
| --- | --- |
| 生物启发架构 | 三层递进模拟人脑记忆机制，记忆组织符合认知规律 |
| 场景化组织 | MemScene 主题聚合，80% 查询走场景检索，效率高 |
| 主动激活 | Foresight 机制支持未来事件预测，主动提醒 |
| 关系推理补全 | 知识图谱弥补跨场景实体推理短板 |
| 强可解释性 | MemCell/MemScene/图节点全部可读，便于审计调试 |
| 渐进式演化 | 从纯 EverMemOS 起步，图谱层可按需扩展 |

**劣势与风险：**

| 劣势/风险 | 缓解措施 |
| --- | --- |
| 双层系统集成复杂度高 | 采用异步图构建，不影响主路径 |
| 混合存储（4 种引擎）运维成本高 | MVP 阶段可简化为 PostgreSQL + pgvector + Neo4j |
| 图构建依赖 LLM 实体抽取质量 | 实体抽取使用专用小模型 + 规则兜底 |
| 生产案例少（项目较新） | 核心逻辑自研，EverMemOS 作参考实现而非强依赖 |
## 第二部分：整体架构设计

### 2.1 系统架构总图

```
┌─────────────────────────────────────────────────────────────────┐
│                         客户端 / 应用层                          │
│          REST API / WebSocket / SDK（Python / TypeScript）       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                       Memory Gateway                            │
│   ┌─────────────────┐   ┌──────────────────┐  ┌─────────────┐  │
│   │  写入路由        │   │   查询路由器       │  │  安全/限流  │  │
│   │  (Write Router) │   │  (Query Router)  │  │  (Guard)   │  │
│   └────────┬────────┘   └────────┬─────────┘  └─────────────┘  │
└────────────┼────────────────────┼────────────────────────────── ┘
             │                    │
    ┌────────▼───────┐   ┌────────▼──────────────────────────────┐
    │  记忆写入 Pipeline│   │            记忆检索 Pipeline             │
    │  (Memory Write) │   │           (Memory Retrieval)          │
    └────────┬────────┘   └──────────────────────────────────────┘
             │
    ┌────────▼──────────────────────────────────────────────────┐
    │                   核心记忆引擎                             │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │            EverMemOS 层（情景 + 语义记忆）             │  │
    │  │  [情景轨迹形成] → MemCell → [语义巩固] → MemScene     │  │
    │  │                   ↓ 用户画像演化                       │  │
    │  │           Foresight 主动激活引擎                       │  │
    │  └──────────────────────────────────────────────────────┘  │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │            知识图谱层（关系记忆）[异步构建]            │  │
    │  │  实体节点 → 关系边（带时间戳）→ 社区聚合               │  │
    │  │  图谱查询：多跳推理 / 关系追溯 / 交叉验证              │  │
    │  └──────────────────────────────────────────────────────┘  │
    └───────────────────────────────────────────────────────────┘
             │
    ┌────────▼──────────────────────────────────────────────────┐
    │                    存储层（可插拔）                        │
    │  MongoDB     │ Milvus/pgvector │ Neo4j    │ Redis          │
    │  (文档存储)   │ (向量检索)       │ (图存储) │ (热缓存)        │
    └───────────────────────────────────────────────────────────┘
```

### 2.2 核心模块说明

| 模块 | 职责 | 关键技术 |
| --- | --- | --- |
| Memory Gateway | 请求鉴权、路由、限流、PII 过滤 | FastAPI、JWT、规则引擎 |
| 情景轨迹形成器 | 对话分段 → MemCell 生成 | LLM（claude-sonnet / gpt-4o） |
| 语义巩固器 | MemCell → MemScene 在线聚类 | 向量相似度 + LLM 摘要 |
| 用户画像引擎 | 从 MemScene 持续提炼用户特征 | 增量更新策略 |
| Foresight 激活器 | 定时扫描有效期内的 Foresight 条目 | Cron + 规则匹配 |
| 实体提取器 | 从 MemCell 中抽取实体和关系 | NER 模型 + LLM（异步） |
| 图谱构建器 | 实体/关系写入图数据库，维护时间戳 | Neo4j / Cypher |
| 查询路由器 | 判断走场景检索还是图查询 | 意图分类（轻量模型） |
| 检索融合器 | 合并场景检索 + 图查询结果，排序去重 | RRF（倒数排名融合） |
## 第三部分：数据模型设计

### 3.1 逻辑数据模型

#### 3.1.1 MemCell（记忆细胞）

MemCell 是最小的记忆单元，对应一段主题完整的对话片段。

```
MemCell
│
├── 身份标识
│     ├── cell_id: UUID          # 全局唯一 ID
│     ├── user_id: string        # 归属用户
│     └── group_id: string       # 对话组 ID（一次会话）
│
├── Episode（事件叙述）
│     ├── summary: string        # 第三人称客观摘要（50-100字）
│     ├── raw_quote: string      # 关键原话引用（可选）
│     └── scene_tag: enum        # 主题标签：work/health/life/relationship/finance/...
│
├── Atomic Facts（原子事实列表）
│     └── [{
│           predicate: string,   # 断言：subject.attribute 格式
│           object: string,      # 值
│           confidence: float,   # 置信度 0-1
│           source: string       # 来源消息 ID
│         }]
│
├── Foresight（前瞻信号列表）
│     └── [{
│           prediction: string,  # 自然语言描述的预测
│           valid_from: datetime,# 生效起始时间
│           valid_to: datetime,  # 生效结束时间（null=永久）
│           priority: enum,      # high/medium/low
│           action_hint: string  # 建议行动（注入系统 Prompt）
│         }]
│
├── Entity Mentions（实体提及列表）[新增·图谱层]
│     └── [{
│           entity_id: string,   # 图谱中的节点 ID
│           entity_name: string, # 实体名称
│           entity_type: enum,   # PERSON/ORG/PROJECT/CONCEPT/EVENT/LOCATION
│           role: string         # 实体在本事件中的角色（主体/客体/工具等）
│         }]
│
└── Metadata
      ├── create_time: datetime
      ├── last_access: datetime
      ├── expires_at: datetime    # null = 永不过期
      ├── access_count: int
      ├── importance_score: float # 重要性评分，影响淘汰策略
      ├── source_message_ids: []  # 原始消息 ID 列表（溯源）
      └── links
            ├── prev_cell_id
            ├── next_cell_id
            └── memscene_id       # 归属的 MemScene
```

#### 3.1.2 MemScene（记忆场景）

MemScene 是主题化的记忆聚合，对应一个稳定的语义主题。

```
MemScene
│
├── 身份标识
│     ├── scene_id: UUID
│     ├── user_id: string
│     ├── scene_name: string      # 人类可读名称
│     └── scene_type: enum       # work_project/health/social/finance/learning/...
│
├── 内容聚合
│     ├── memcell_ids: []         # 归属的 MemCell ID 列表
│     ├── summary: object         # 提炼后的结构化摘要（KV 格式）
│     ├── key_entities: []        # 场景内高频实体列表
│     └── embedding: vector       # 场景语义向量（用于相似场景检索）
│
├── 用户画像增量
│     └── user_profile_delta: {  # 从本场景提炼的用户特征
│           traits: KV,           # 稳定特质
│           preferences: KV,      # 偏好
│           constraints: KV,      # 限制（如：不能喝酒）
│           roles: KV             # 角色信息（如：产品经理）
│         }
│
├── 关联图谱节点 [新增·图谱层]
│     └── graph_cluster_id: string # 对应图谱中的社区/子图 ID
│
└── Metadata
      ├── create_time: datetime
      ├── last_update: datetime
      ├── memcell_count: int
      └── time_boundary: {earliest, latest}
```

#### 3.1.3 UserProfile（用户画像）

```
UserProfile
│
├── user_id: string               # 用户唯一标识
│
├── 稳定特质（长期，低更新频率）
│     ├── demographics: KV        # 年龄段/职业/地域等（用户明确提及）
│     ├── personality_traits: []  # 个性特征（内向/细心/追求效率等）
│     └── long_term_goals: []     # 长期目标
│
├── 偏好模型（中期，周/月级更新）
│     ├── topic_preferences: KV   # 话题偏好及权重
│     ├── communication_style: {}  # 沟通风格偏好
│     └── content_preferences: {} # 内容类型偏好
│
├── 当前状态（短期，实时更新）
│     ├── active_constraints: []  # 当前有效约束（如：服药中、出差中）
│     ├── current_projects: []    # 正在进行的项目
│     └── recent_context: string  # 最近对话主题摘要
│
└── Metadata
      ├── create_time
      ├── last_update
      └── scene_count             # 关联的 MemScene 数量
```

#### 3.1.4 知识图谱模型（新增层）

```
图谱节点（Entity Node）
│
├── entity_id: UUID
├── entity_name: string           # 实体名称（去重归一化）
├── entity_type: enum             # PERSON/ORG/PROJECT/CONCEPT/EVENT/LOCATION/OBJECT
├── user_id: string               # 归属用户（隔离不同用户图谱）
├── aliases: []                   # 别名列表（「老王」= 「王明」）
├── properties: KV                # 实体属性（随时间更新）
├── first_mentioned: datetime
├── last_mentioned: datetime
└── mention_count: int

图谱边（Relation Edge）
│
├── edge_id: UUID
├── source_entity_id: UUID
├── target_entity_id: UUID
├── relation_type: enum           # 关系类型（见下表）
├── label: string                 # 关系自然语言描述
├── valid_from: datetime          # 关系生效时间
├── valid_to: datetime            # 关系失效时间（null=仍有效）
├── confidence: float
├── source_cell_id: UUID          # 来源 MemCell（可溯源）
└── properties: KV                # 关系属性

关系类型枚举：
  WORKS_ON（参与项目）/ KNOWS（认识）/ OWNS（拥有）
  CAUSES（导致）/ FOLLOWS（时序后继）/ PART_OF（归属）
  CONTRADICTS（矛盾）/ SUPPORTS（支持）/ OCCURRED_AT（发生于）
  HAS_CONSTRAINT（有约束）/ HAS_PREFERENCE（有偏好）
```

#### 3.1.5 逻辑模型关系图

```
User (1) ──────────────── (N) MemCell
                                  │
                                  ├── belongs to ──── (1) MemScene
                                  │
                                  └── mentions ──── (N) Entity
                                                         │
                                                    connected by
                                                         │
                                                    (N) Relation Edge

MemScene (N) ──── derived from ──── (1) UserProfile delta

Entity (N) ── in ── (N) MemScene (via key_entities)
```

### 3.2 物理数据模型与存储引擎

#### 3.2.1 存储引擎分配

| 存储引擎 | 职责 | 存储内容 | 关键索引/配置 |
| --- | --- | --- | --- |
| MongoDB | 主文档存储 | MemCell 完整 JSON、MemScene、UserProfile | cell_id, user_id, expires_at（TTL），memscene_id |
| Milvus / pgvector | 向量检索 | MemCell embedding（1536-dim）、MemScene embedding | HNSW 索引，IP 相似度 |
| Neo4j | 图数据库 | Entity 节点、Relation 边、社区结构 | 图遍历索引，时间范围过滤 |
| Elasticsearch | 全文检索 | Episode 文本、Atomic Facts 原文、实体名称 | 倒排索引，中文分词（IK Analyzer） |
| Redis | 热数据缓存 | 高频 MemCell、当前 Session 上下文、UserProfile、Foresight 激活列表 | KeyValue + TTL，Hash 结构 |

> MVP 简化版：MongoDB（文档）+ pgvector（向量，集成在 PostgreSQL）+ Neo4j（图）+ Redis（缓存），去掉 Elasticsearch（用 MongoDB Atlas Search 替代）

#### 3.2.2 MongoDB 物理模型

```javascript
// Collection: memcells
{
  "_id": "mcell_uuid",
  "user_id": "user_xxx",
  "group_id": "grp_xxx",
  "episode": {
    "summary": "...",
    "raw_quote": "...",
    "scene_tag": "health"
  },
  "atomic_facts": [
    {"predicate": "user.health_status", "object": "taking_antibiotics", "confidence": 0.99}
  ],
  "foresight": [
    {
      "prediction": "...",
      "valid_from": ISODate("2026-05-02"),
      "valid_to": ISODate("2026-05-12"),
      "priority": "high",
      "action_hint": "推荐内容需过滤酒精"
    }
  ],
  "entity_mentions": [
    {"entity_id": "ent_xxx", "entity_name": "抗生素", "entity_type": "CONCEPT", "role": "constraint"}
  ],
  "metadata": {
    "create_time": ISODate("..."),
    "last_access": ISODate("..."),
    "expires_at": ISODate("..."),   // TTL 自动删除
    "access_count": 0,
    "importance_score": 0.85,
    "source_message_ids": ["msg_001", "msg_002"]
  },
  "links": {
    "prev_cell_id": null,
    "next_cell_id": "mcell_yyy",
    "memscene_id": "ms_xxx"
  }
}

// 索引策略
db.memcells.createIndex({ "user_id": 1, "metadata.create_time": -1 })
db.memcells.createIndex({ "links.memscene_id": 1 })
db.memcells.createIndex({ "metadata.expires_at": 1 }, { expireAfterSeconds: 0 })  // TTL
db.memcells.createIndex({ "episode.scene_tag": 1, "user_id": 1 })
db.memcells.createIndex({ 
  "foresight.valid_from": 1, 
  "foresight.valid_to": 1 
})  // Foresight 扫描索引
```

```javascript
// Collection: memscenes
{
  "_id": "ms_uuid",
  "user_id": "user_xxx",
  "scene_name": "Q4产品发布项目",
  "scene_type": "work_project",
  "memcell_ids": ["mcell_001", "mcell_002"],
  "summary": {
    "key_dates": {"beta": "2026-10-15", "ga": "2026-11-20"},
    "status": "on_track"
  },
  "key_entities": ["ent_project_q4", "ent_person_boss"],
  "embedding_ref": "ms_uuid",   // 指向 Milvus 中的向量 ID
  "graph_cluster_id": "cluster_xxx",
  "user_profile_delta": {
    "traits": {"role": "product_manager"},
    "preferences": {},
    "constraints": {}
  },
  "metadata": {
    "create_time": ISODate("..."),
    "last_update": ISODate("..."),
    "memcell_count": 2,
    "time_boundary": {
      "earliest": ISODate("..."),
      "latest": ISODate("...")
    }
  }
}

db.memscenes.createIndex({ "user_id": 1, "scene_type": 1 })
db.memscenes.createIndex({ "key_entities": 1 })
```

#### 3.2.3 Milvus 向量存储模型

```python
# MemCell 向量集合
memcell_schema = CollectionSchema(fields=[
    FieldSchema("cell_id",    DataType.VARCHAR,       max_length=128, is_primary=True),
    FieldSchema("user_id",    DataType.VARCHAR,       max_length=128),
    FieldSchema("scene_id",   DataType.VARCHAR,       max_length=128),
    FieldSchema("scene_tag",  DataType.VARCHAR,       max_length=32),
    FieldSchema("create_ts",  DataType.INT64),         # Unix timestamp
    FieldSchema("expires_ts", DataType.INT64),         # Unix timestamp, -1=永不过期
    FieldSchema("embedding",  DataType.FLOAT_VECTOR,  dim=1536),
])

index_params = {
    "metric_type": "IP",
    "index_type": "HNSW",
    "params": {"M": 16, "efConstruction": 200}
}

# 检索示例：用户 + 场景约束 + 未过期
results = collection.search(
    data=[query_embedding],
    anns_field="embedding",
    param={"metric_type": "IP", "params": {"ef": 64}},
    limit=20,
    expr=f'user_id == "{user_id}" && expires_ts > {current_ts}',
    output_fields=["cell_id", "scene_id", "scene_tag"]
)

# MemScene 向量集合（结构类似，dim 相同，无 expires_ts）
```

#### 3.2.4 Neo4j 图数据模型

```cypher
-- 节点定义
CREATE CONSTRAINT entity_id_unique FOR (e:Entity) REQUIRE e.entity_id IS UNIQUE;

-- 实体节点
CREATE (e:Entity {
  entity_id: "ent_uuid",
  entity_name: "王明",
  entity_type: "PERSON",
  user_id: "user_xxx",
  aliases: ["老王", "明哥"],
  first_mentioned: datetime("2026-04-01"),
  last_mentioned: datetime("2026-04-15"),
  mention_count: 5
})

-- 关系边（带时间戳）
MATCH (a:Entity {entity_id: "ent_001"})
MATCH (b:Entity {entity_id: "ent_002"})
CREATE (a)-[r:WORKS_ON {
  edge_id: "edge_uuid",
  label: "王明负责Q4产品发布项目",
  valid_from: datetime("2026-04-01"),
  valid_to: null,
  confidence: 0.95,
  source_cell_id: "mcell_xxx"
}]->(b)

-- 关系失效（不删除，保留历史）
MATCH ()-[r:WORKS_ON {edge_id: "edge_uuid"}]-()
SET r.valid_to = datetime("2026-11-20")

-- 多跳查询示例：与用户讨论项目相关的所有人员
MATCH (project:Entity {entity_type: "PROJECT"})-[r1:WORKS_ON]-(person:Entity {entity_type: "PERSON"})
WHERE project.entity_id IN $scene_entity_ids
  AND r1.valid_to IS NULL  // 仍有效的关系
RETURN person.entity_name, person.entity_id, r1.label

-- 时间范围查询：某时间点的关系状态
MATCH (a:Entity)-[r]-(b:Entity)
WHERE r.valid_from <= datetime($point_in_time)
  AND (r.valid_to IS NULL OR r.valid_to > datetime($point_in_time))
RETURN a, r, b
```

#### 3.2.5 Redis 缓存结构

```
# 用户 UserProfile 热缓存（每次检索前加载）
Key:  profile:{user_id}
Type: Hash
TTL:  30分钟（每次检索命中时刷新）
Value: JSON 序列化的 UserProfile

# 当前 Session 上下文（正在进行的对话）
Key:  session:{session_id}
Type: Hash
TTL:  2小时（Session 超时清理）
Value: {recent_cells: [], active_foresights: [], working_entities: []}

# Foresight 激活队列（定时任务扫描后写入）
Key:  foresight:active:{user_id}
Type: List
TTL:  24小时
Value: [{foresight_content, action_hint, priority}, ...]

# 高频 MemScene 热缓存
Key:  scene:{scene_id}
Type: String
TTL:  1小时
Value: JSON 序列化的 MemScene（含 summary）
```

## 第四部分：核心 Pipeline 设计

### 4.1 Pipeline 总览

**写入 Pipeline（同步 + 异步）：**

```

用户对话 ──[同步]──▶ 数据预处理 ──▶ 记忆抽取（MemCell 生成）──▶ 记忆巩固（MemScene 更新）
                                                                      │
                                                            ──[异步]──▶ 图谱构建（Entity + Relation）
```

**检索 Pipeline（同步）：**

```

用户 Query ──▶ Query 路由 ──▶ [场景检索] 或 [图谱查询] 或 [双路融合]
                                    │                │
                               MemScene 引导      多跳图遍历
                               MemCell 精检索    关系推理结果
                                    └────────────────┘
                                           │
                                    Foresight 注入
                                           │
                                    上下文组装 ──▶ LLM 生成回答
```

### 4.2 Pipeline 1：数据预处理（Data Preprocessing）

#### 4.2.1 职责

将原始对话消息流转换为可供后续处理的清洁、结构化输入。

#### 4.2.2 处理步骤

```
输入：原始消息列表 [{role, content, timestamp, message_id}]
│
├── Step 1: PII 检测与脱敏
│     规则引擎（手机号/身份证/银行卡/邮箱）+ 可选 NER 模型
│     策略：检测到 PII → 替换为占位符 [PHONE_XXX] 并记录映射表
│
├── Step 2: 内容过滤
│     过滤：空消息、系统消息、纯格式消息、超短消息（< 5字）
│
├── Step 3: 消息归一化
│     标准化时间格式、统一编码、截断超长消息（> 4000字 → 保留首尾 + 摘要中间）
│
├── Step 4: 对话主题边界检测
│     使用 LLM 判断：当前消息是否形成完整主题单元？
│     返回：{should_wait: bool, topic_tag: string, completeness_score: float}
│     策略：completeness_score > 0.75 → 触发 MemCell 生成
│           should_wait = true → 继续累积消息
│           强制触发：累积超过 20 条消息 OR 对话间隔 > 2小时
│
└── 输出：ConversationSegment {
          messages: 清洁消息列表,
          topic_tag: string,
          session_id: string,
          user_id: string,
          segment_start: datetime,
          segment_end: datetime
        }
```

#### 4.2.3 边界检测 Prompt

```python
BOUNDARY_DETECTION_PROMPT = """
你是一个对话主题边界检测器。分析以下对话片段，判断是否已形成一个完整的主题单元。

对话历史：
{conversation_history}

最新消息：{latest_message}

请判断：
1. 当前对话是否围绕一个完整且可总结的主题展开？（是/否）
2. 如果还需要等待更多消息，请说明原因。
3. 如果是完整主题，请给出主题标签（work/health/life/relationship/finance/learning/other）

返回 JSON 格式：
{
  "should_wait": false,  // true=继续等待, false=可以生成 MemCell
  "topic_tag": "health",
  "completeness_score": 0.9,  // 0-1，越高越完整
  "reason": "用户提到了完整的健康事件（拔牙+服药+禁忌）"
}
"""
```

### 4.3 Pipeline 2：记忆抽取（Memory Extraction / Episodic Trace Formation）

#### 4.3.1 职责

将 ConversationSegment 转化为结构化的 MemCell，包含事件摘要、原子事实、前瞻信号、实体提及。

#### 4.3.2 处理步骤

```
输入：ConversationSegment
│
├── Step 1: Episode 生成（事件摘要）
│     LLM 生成第三人称客观摘要
│     要求：简洁（50-100字）、包含时间上下文、不含主观评价
│
├── Step 2: Atomic Facts 抽取
│     LLM 从对话中抽取可验证的原子事实
│     格式：{predicate: "subject.attribute", object: "value", confidence: 0-1}
│     示例：{"predicate": "user.medication", "object": "antibiotics", "confidence": 0.99}
│     约束：每个 MemCell 最多 10 条原子事实；过滤置信度 < 0.6 的条目
│
├── Step 3: Foresight 生成（前瞻信号）
│     LLM 预测：此事件在未来什么时间、什么场景下需要被「激活」
│     要求：必须有明确的 valid_from 和 valid_to（可推算）
│     示例：服药10天禁酒 → valid_from=今天, valid_to=今天+10天
│     约束：每个 MemCell 最多 3 条 Foresight；无法确定时效的不生成
│
├── Step 4: 实体提及抽取（异步，供图谱层使用）
│     轻量 NER 模型（如 spaCy + 自定义规则）提取人名/项目名/组织名/概念
│     LLM 辅助判断实体类型和在事件中的角色
│     输出：entity_mentions 列表
│
├── Step 5: Importance Score 计算
│     特征：Foresight 数量、Atomic Facts 数量、情感强度、稀有度
│     公式：importance = 0.3 * foresight_count/3 + 0.3 * facts_count/10 
│                      + 0.2 * sentiment_intensity + 0.2 * rarity_score
│     得分范围 0-1，决定记忆淘汰优先级
│
├── Step 6: Embedding 生成
│     对 Episode.summary + Atomic Facts 拼接文本生成 1536-dim embedding
│     使用 text-embedding-3-large 或 BGE-M3（多语言）
│
└── 输出：MemCell（写入 MongoDB + Milvus）
```

#### 4.3.3 记忆抽取 Prompt

```python
MEMORY_EXTRACTION_PROMPT = """
你是一个专业的记忆抽取器。从以下对话片段中抽取结构化记忆信息。

对话片段：
{conversation_segment}

当前时间：{current_datetime}
用户 ID：{user_id}

请抽取以下信息，严格返回 JSON 格式：

{
  "episode": {
    "summary": "（第三人称，50-100字，客观描述发生了什么）",
    "raw_quote": "（对话中的关键原话，可选）",
    "scene_tag": "（work/health/life/relationship/finance/learning/other）"
  },
  "atomic_facts": [
    {
      "predicate": "（subject.attribute 格式）",
      "object": "（值）",
      "confidence": 0.0-1.0
    }
  ],
  "foresight": [
    {
      "prediction": "（自然语言描述未来需要注意什么）",
      "valid_from": "（ISO8601 格式，估算）",
      "valid_to": "（ISO8601 格式，估算；无法确定则 null）",
      "priority": "（high/medium/low）",
      "action_hint": "（建议如何在未来对话中使用此记忆）"
    }
  ],
  "importance_estimate": 0.0-1.0
}

注意事项：
- atomic_facts 最多10条，只包含可客观验证的事实，不含推断
- foresight 只在有明确时间边界时生成，避免模糊预测
- 摘要用第三人称（「用户」而非「我」）
"""
```

### 4.4 Pipeline 3：记忆巩固（Memory Consolidation / Semantic Consolidation）

#### 4.4.1 职责

将新产生的 MemCell 归入合适的 MemScene（或创建新 MemScene），并更新用户画像。

#### 4.4.2 处理步骤

```
输入：新生成的 MemCell
│
├── Step 1: 获取候选 MemScene
│     向 Milvus 查询与新 MemCell 相似的 Top-5 MemScene embedding
│     过滤：仅检索同一用户的 MemScene
│
├── Step 2: 多维评分（为每个候选 MemScene 计算归属分数）
│     
│     对每个候选 MemScene：
│       sem_sim     = cosine_similarity(new_cell.embedding, scene.embedding)
│       entity_overlap = |new_cell.entities ∩ scene.key_entities| / max(|new_cell.entities|, 1)
│       time_diff_days = (new_cell.create_time - scene.latest_cell_time).days
│       time_proximity = exp(-0.5 * time_diff_days)
│       tag_match = 1.0 if new_cell.scene_tag == scene.scene_type else 0.0
│       
│       score = 0.4 * sem_sim 
│             + 0.25 * entity_overlap 
│             + 0.2 * time_proximity 
│             + 0.15 * tag_match
│
├── Step 3: 归属决策
│     if max_score > THRESHOLD_ASSIGN (0.65):
│         → 归入得分最高的现有 MemScene
│     elif max_score > THRESHOLD_NEW (0.40):
│         → 归入现有 MemScene，但标记为「弱归属」（供后续重聚类）
│     else:
│         → 创建新 MemScene
│
├── Step 4: MemScene 摘要增量更新
│     策略：非每次都重新生成，而是增量更新
│     触发重新生成：新增 MemCell 数量超过阈值（5个）OR 重要 MemCell 加入
│     增量更新：使用 LLM 合并旧摘要 + 新 MemCell 的 episode + atomic_facts
│
├── Step 5: 用户画像增量更新
│     从 MemCell.atomic_facts 中提取用户相关事实
│     分类写入 UserProfile 的对应层（稳定特质/偏好/当前状态）
│     冲突处理：新值 vs 旧值 → 时间戳更新（保留历史版本）
│
└── 输出：更新后的 MemScene + UserProfile（写入 MongoDB + 更新 Milvus 向量）
```

#### 4.4.3 新 MemScene 创建流程

```python
def create_new_memscene(new_cell: MemCell) -> MemScene:
    """
    当 MemCell 无法归属现有 MemScene 时，创建新场景
    """
    # LLM 生成场景名称和初始摘要
    scene_name = llm_generate_scene_name(new_cell.episode.summary)

    scene = MemScene(
        scene_id=generate_uuid(),
        user_id=new_cell.user_id,
        scene_name=scene_name,
        scene_type=new_cell.episode.scene_tag,
        memcell_ids=[new_cell.cell_id],
        summary=extract_initial_summary(new_cell),
        key_entities=[m.entity_id for m in new_cell.entity_mentions],
        embedding=new_cell.embedding,   # 初始以 MemCell embedding 作为场景 embedding
        user_profile_delta=extract_profile_delta(new_cell)
    )

    return scene
```

#### 4.4.4 冲突记忆处理策略

```python
class ConflictResolver:
    """处理新旧记忆冲突"""

    def resolve(self, new_fact: AtomicFact, existing_facts: List[AtomicFact]) -> Resolution:
        # 找到相同 predicate 的旧事实
        conflicts = [f for f in existing_facts if f.predicate == new_fact.predicate]

        if not conflicts:
            return Resolution.ADD  # 无冲突，直接添加

        old_fact = max(conflicts, key=lambda f: f.create_time)

        # 时间更近的新事实优先（覆盖策略）
        if new_fact.confidence >= old_fact.confidence:
            # 标记旧事实为「已覆盖」，保留历史版本
            old_fact.status = "superseded"
            old_fact.superseded_by = new_fact.fact_id
            return Resolution.UPDATE

        # 新事实置信度低于旧事实，标记为「待验证」
        new_fact.status = "pending_verification"
        return Resolution.ADD_PENDING
```

### 4.5 Pipeline 4：知识图谱构建（Graph Construction）[异步]

#### 4.5.1 设计原则

- **异步执行**：图谱构建不在主路径上，不影响 MemCell 写入延迟
- **幂等操作**：同一 MemCell 的图谱构建可重试，不产生重复节点
- **渐进式**：从高置信度实体开始，逐步扩展图谱密度

#### 4.5.2 处理步骤

```
输入：新生成的 MemCell（从消息队列消费）
│
├── Step 1: 实体归一化（Entity Resolution）
│     问题：「老王」和「王明」是同一实体
│     策略：
│       a) 规则匹配：编辑距离 + 别名词典
│       b) 向量相似度：实体名称 embedding 相似度 > 0.85 → 候选同一实体
│       c) LLM 裁判：候选对由 LLM 判断是否同一实体（仅对 top 候选）
│     输出：{raw_name → canonical_entity_id} 映射
│
├── Step 2: 实体节点 Upsert
│     对每个 entity_mention：
│       若已存在（canonical_entity_id）→ 更新 last_mentioned, mention_count
│       若不存在 → 创建新节点
│
├── Step 3: 关系抽取（Relation Extraction）
│     LLM 分析 MemCell 中实体对之间的关系
│     Prompt：给定实体列表 + 事件摘要，输出关系三元组
│     过滤：confidence < 0.7 的关系不写入图谱
│
├── Step 4: 关系边 Upsert（带时效管理）
│     新关系 → CREATE 新边（valid_from=事件时间, valid_to=null）
│     关系变化 → SET 旧边 valid_to=当前时间，CREATE 新边
│     关系消失（明确提到结束）→ SET valid_to=当前时间
│
├── Step 5: MemScene ↔ 图谱关联
│     更新 MemScene.key_entities（添加本次提取的实体）
│     若实体形成新的图谱社区 → 更新 MemScene.graph_cluster_id
│
└── 输出：更新后的图谱（Neo4j 写入）
```

#### 4.5.3 关系抽取 Prompt

```python
RELATION_EXTRACTION_PROMPT = """
分析以下事件描述，提取其中实体之间的关系。

事件摘要：{episode_summary}
涉及实体：{entity_list}
事件时间：{event_time}

请识别实体之间的关系，只提取有明确依据的关系，返回 JSON 数组：
[
  {
    "source": "实体名称",
    "target": "实体名称",
    "relation_type": "（WORKS_ON/KNOWS/CAUSES/FOLLOWS/PART_OF/HAS_CONSTRAINT/HAS_PREFERENCE/其他）",
    "label": "关系的自然语言描述（一句话）",
    "confidence": 0.0-1.0,
    "is_temporal": false,   // 是否为临时关系（有时间边界）
    "estimated_end": null   // 预估关系结束时间（若有）
  }
]

注意：
- 只提取有强依据的关系，宁缺毋滥
- confidence < 0.7 的关系不需要返回
- 若无明确关系，返回空数组 []
"""
```

### 4.6 Pipeline 5：记忆检索（Reconstructive Recollection）

#### 4.6.1 查询路由策略

```python
class QueryRouter:
    """
    判断查询走哪条检索路径
    """
    SCENE_PATTERNS = [
        "上次.*聊", "之前.*说", "我们.*讨论", "关于.*话题",
        "根据.*偏好", "记得.*吗", "什么时候.*说"
    ]
    GRAPH_PATTERNS = [
        ".*和.*关系", ".*认识.*", ".*负责.*项目",
        ".*提到的.*人", ".*参与.*", "多跳", "谁.*和.*相关"
    ]

    def route(self, query: str, user_id: str) -> RouteDecision:
        # Step 1: 规则快速匹配
        for pattern in self.GRAPH_PATTERNS:
            if re.search(pattern, query):
                return RouteDecision.GRAPH_FIRST

        for pattern in self.SCENE_PATTERNS:
            if re.search(pattern, query):
                return RouteDecision.SCENE_FIRST

        # Step 2: 意图分类模型（轻量，< 10ms）
        intent = self.intent_classifier.predict(query)

        if intent in ["relation_query", "multi_hop", "entity_lookup"]:
            return RouteDecision.GRAPH_FIRST
        elif intent in ["scene_recall", "personalization", "temporal_foresight"]:
            return RouteDecision.SCENE_FIRST
        else:
            return RouteDecision.HYBRID  # 双路并行，融合结果
```

#### 4.6.2 场景检索路径

```python
def scene_retrieval_pipeline(query: str, user_id: str) -> RetrievalContext:

    # Step 1: 加载用户画像和活跃 Foresight
    user_profile = redis.get(f"profile:{user_id}") or mongo.find_profile(user_id)
    active_foresights = redis.get(f"foresight:active:{user_id}") or []

    # Step 2: Query 增强（加入用户画像上下文）
    enhanced_query = f"{query}\n[用户上下文：{user_profile.current_state}]"
    query_embedding = embed(enhanced_query)

    # Step 3: MemScene 引导检索（两阶段）
    # 阶段 3a：向量检索 Top-K MemScene
    candidate_scenes = milvus.search_scenes(
        embedding=query_embedding,
        user_id=user_id,
        top_k=5
    )

    # 阶段 3b：在 Top-2 MemScene 内精检索 MemCell
    memcells = []
    for scene in candidate_scenes[:2]:
        cells = milvus.search_cells_in_scene(
            scene_id=scene.scene_id,
            embedding=query_embedding,
            top_k=5,
            filter_expired=True
        )
        memcells.extend(cells)

    # Step 4: 整合 Foresight 注入
    relevant_foresights = [
        f for f in active_foresights
        if is_relevant(f, query)
    ]

    # Step 5: 组装上下文
    context = RetrievalContext(
        scenes=candidate_scenes[:2],
        memcells=memcells,
        user_profile=user_profile,
        active_foresights=relevant_foresights,
        constraints=extract_active_constraints(memcells)
    )

    return context
```

#### 4.6.3 图谱查询路径

```python
def graph_retrieval_pipeline(query: str, user_id: str) -> GraphContext:

    # Step 1: 提取查询中的实体
    query_entities = extract_entities_from_query(query)  # NER

    if not query_entities:
        # 降级到场景检索
        return scene_retrieval_pipeline(query, user_id)

    # Step 2: 实体映射到图谱节点
    entity_nodes = []
    for entity_name in query_entities:
        node = neo4j.find_entity(user_id=user_id, name=entity_name)
        if node:
            entity_nodes.append(node)

    # Step 3: 图遍历（最大 3 跳）
    subgraph = neo4j.query("""
        MATCH path = (start:Entity)-[*1..3]-(end:Entity)
        WHERE start.entity_id IN $entity_ids
          AND start.user_id = $user_id
          AND ALL(r IN relationships(path) WHERE r.valid_to IS NULL)
        RETURN path
        LIMIT 50
    """, entity_ids=[n.entity_id for n in entity_nodes], user_id=user_id)

    # Step 4: 从图谱结果找关联 MemCell
    related_cell_ids = [edge.source_cell_id for edge in subgraph.edges]
    related_cells = mongo.find_cells(related_cell_ids)

    return GraphContext(
        entities=entity_nodes,
        subgraph=subgraph,
        related_cells=related_cells
    )
```

#### 4.6.4 混合融合与上下文组装

```python
def assemble_final_context(
    query: str,
    scene_ctx: RetrievalContext,
    graph_ctx: GraphContext
) -> FinalContext:

    # Step 1: RRF（倒数排名融合）合并两路结果
    scene_cells = [(cell, score) for cell, score in scene_ctx.ranked_cells]
    graph_cells = [(cell, score) for cell, score in graph_ctx.ranked_cells]

    merged_cells = rrf_merge(scene_cells, graph_cells, k=60)

    # Step 2: Token 预算管理（防止超出上下文窗口）
    MAX_CONTEXT_TOKENS = 2000
    selected_cells = budget_select(merged_cells, max_tokens=MAX_CONTEXT_TOKENS)

    # Step 3: 组装最终 Prompt 注入内容
    context_block = f"""
[记忆上下文]
用户当前状态：{scene_ctx.user_profile.current_state}
活跃约束：{scene_ctx.constraints}
活跃提醒：{[f.action_hint for f in scene_ctx.active_foresights]}

相关记忆场景：
{format_scenes(scene_ctx.scenes[:2])}

关键事实：
{format_cells(selected_cells)}

实体关系：
{format_graph(graph_ctx.subgraph) if graph_ctx else '无'}
"""

    return FinalContext(
        context_block=context_block,
        token_count=count_tokens(context_block),
        source_cells=[cell.cell_id for cell in selected_cells]
    )
```

## 第五部分：API 接口设计

### 5.1 核心 API

```yaml
# Memory Gateway REST API

# 1. 写入对话（触发记忆 Pipeline）
POST /v1/memory/ingest
Request:
  user_id: string
  session_id: string
  messages:
    - role: user | assistant
      content: string
      timestamp: ISO8601
      message_id: string
Response:
  cell_id: string (若已生成 MemCell)
  status: pending | created | accumulated
  estimated_cells: int

# 2. 检索记忆（供 Agent 推理前调用）
POST /v1/memory/retrieve
Request:
  user_id: string
  query: string
  session_id: string (可选，加载当前会话上下文)
  retrieval_mode: auto | scene | graph | hybrid
  max_tokens: int (default: 2000)
Response:
  context_block: string  (直接注入 System Prompt 的格式化文本)
  source_cells: [cell_id]
  active_foresights: [{prediction, action_hint, priority}]
  retrieval_mode_used: scene | graph | hybrid
  latency_ms: int

# 3. 查询用户画像
GET /v1/memory/profile/{user_id}
Response: UserProfile

# 4. 列出记忆场景
GET /v1/memory/scenes/{user_id}
Query: scene_type?, limit?, offset?
Response: [MemScene]

# 5. 记忆管理
DELETE /v1/memory/cell/{cell_id}    # 删除单条记忆
DELETE /v1/memory/user/{user_id}    # 清空用户全部记忆
PATCH  /v1/memory/cell/{cell_id}    # 手动修正记忆内容

# 6. 图谱查询
POST /v1/memory/graph/query
Request:
  user_id: string
  entity_names: [string]
  max_hops: int (default: 2, max: 3)
  valid_at: ISO8601 (可选，查询某时间点的图谱状态)
Response:
  entities: [Entity]
  relations: [Relation]
  related_cells: [MemCell]
```

## 第六部分：非功能性设计

### 6.1 性能设计

| 场景 | 目标延迟 | 策略 |
| --- | --- | --- |
| 检索（P95） | < 200ms | Redis 缓存 UserProfile + 活跃 Foresight；Milvus HNSW 索引 |
| 写入（同步部分，P95） | < 100ms | 仅做预处理和边界判断，MemCell 生成异步化 |
| MemCell 生成（异步，P95） | < 5s | 独立工作线程池，LLM 并发调用 |
| 图谱构建（P95） | < 30s | 消息队列异步消费，不阻塞主路径 |

### 6.2 可靠性设计

**记忆写入可靠性：**
- MemCell 生成失败 → 原始消息保留在「待处理队列」，可重试
- 图谱构建失败 → 不影响 EverMemOS 层，图谱异步修复
- 存储写入失败 → 事务保证 MongoDB + Milvus 写入原子性

**记忆一致性：**
- MemScene 更新采用乐观锁（version 字段）
- UserProfile 更新采用 Last-Write-Wins + 历史版本保留
- 图谱边不物理删除，仅标记 valid_to（保留历史状态）

### 6.3 安全与隐私设计

**PII 保护：**
- 写入前自动检测 PII（手机号/身份证/银行卡）
- PII 替换为占位符 [PHONE_XXX]，映射表加密存储
- 支持用户发起「右被遗忘」请求（硬删除所有记忆）

**访问控制：**
- 每个用户只能访问自己的 MemCell/MemScene/UserProfile
- 图谱节点以 user_id 隔离
- API 层 JWT 鉴权 + 请求签名

**敏感记忆处理：**
- health/finance 类 MemCell 加密存储（字段级加密）
- 高优先级 Foresight 在传输时端到端加密

## 第七部分：项目规划

### 7.1 MVP 定义
MVP 目标：证明「EverMemOS + 知识图谱」融合架构的核心价值，可在真实用户场景中稳定运行。

MVP 范围：

- ✅ MemCell 生成（情景轨迹形成）
- ✅ MemScene 创建与更新（语义巩固）
- ✅ 场景检索路径（Reconstructive Recollection）
- ✅ UserProfile 基础版（当前状态 + 简单偏好）
- ✅ Foresight 主动激活（基础版）
- ✅ 知识图谱（实体节点 + 基础关系，仅 PERSON/PROJECT/CONCEPT 类型）
- ✅ REST API（ingest + retrieve + profile）
- ❌ 图谱多跳查询（MVP 后）
- ❌ 多模态记忆（MVP 后）
- ❌ 共享记忆（MVP 后）

**MVP 非功能要求：**

- 单用户场景，支持 1000+ MemCell
- 检索 P95 < 300ms
- 单机部署（Docker Compose）

### 7.2 技术栈选型（MVP）

```yaml
Backend:
  Language: Python 3.11
  Framework: FastAPI
  LLM: Claude claude-sonnet-4-20250514 (记忆抽取) + text-embedding-3-large (向量化)
  Queue: Celery + Redis (异步任务)

Storage:
  Document: MongoDB 7.0
  Vector: pgvector (PostgreSQL extension, MVP 阶段替代 Milvus，降低复杂度)
  Graph: Neo4j 5.x Community Edition
  Cache: Redis 7.x

Infrastructure:
  Container: Docker + Docker Compose
  CI/CD: GitHub Actions
  Monitoring: Prometheus + Grafana (基础版)
```

### 7.3 里程碑规划

#### Milestone 0：基础设施搭建（第 1-2 周）

**目标**：跑通基础环境，验证技术选型可行性

任务：
- [ ] Docker Compose 搭建 MongoDB + pgvector + Neo4j + Redis
- [ ] FastAPI 项目脚手架
- [ ] LLM 调用封装（Claude API + 重试 + 限速）
- [ ] Embedding 服务封装
- [ ] 基础日志和监控
- [ ] 单元测试框架搭建

验收标准：
- 所有存储引擎正常启动
- LLM 调用成功率 > 99%（含重试）
- 基础 API 健康检查通过

#### Milestone 1：MemCell 生成（第 3-4 周）

**目标**：实现对话 → MemCell 的核心转换

任务：
- [ ] 数据预处理 Pipeline（PII 检测 + 边界检测）
- [ ] 记忆抽取 Pipeline（Episode + Atomic Facts + Foresight）
- [ ] MemCell 写入 MongoDB + pgvector
- [ ] Importance Score 计算
- [ ] 异步任务队列（Celery）
- [ ] POST /v1/memory/ingest API

验收标准：
- 对 10 段测试对话，MemCell 生成准确率 > 85%（人工评估）
- Atomic Facts 精确率 > 90%，召回率 > 80%
- 写入 P95 延迟（同步部分）< 100ms
- 异步 MemCell 生成 P95 < 5s

#### Milestone 2：MemScene + 场景检索（第 5-6 周）

**目标**：实现完整的 EverMemOS 核心流程

任务：
- [ ] MemScene 在线增量聚类（多维评分 + 归属决策）
- [ ] MemScene 摘要增量更新
- [ ] UserProfile 基础版（当前状态 + 简单偏好）
- [ ] Foresight 激活扫描（Cron 任务）
- [ ] 场景检索 Pipeline
- [ ] 上下文组装（Token 预算管理）
- [ ] POST /v1/memory/retrieve API
- [ ] GET /v1/memory/profile API

验收标准：
- LOCOMO 基准子集得分 > 85%（纯场景检索）
- 检索 P95 延迟 < 250ms
- MemScene 聚类准确率 > 80%（人工评估）
- Foresight 激活准时率 > 95%

#### Milestone 3：知识图谱层（第 7-9 周）

**目标**：集成知识图谱，补全关系推理能力

任务：
- [ ] 实体提取 Pipeline（NER + LLM 辅助）
- [ ] 实体归一化（别名解析 + 向量相似度去重）
- [ ] 图谱构建 Pipeline（节点 Upsert + 关系边管理）
- [ ] 图谱查询路径（多跳 Cypher 查询）
- [ ] 查询路由器（规则 + 意图分类）
- [ ] 检索结果融合（RRF）
- [ ] POST /v1/memory/graph/query API

验收标准：
- 关系抽取精确率 > 80%，召回率 > 70%
- 多跳图查询（2跳）P95 延迟 < 200ms
- 查询路由准确率 > 85%（100 条测试 Query）
- 融合检索在关系推理类 Query 上相比纯场景检索，准确率提升 > 20%

#### Milestone 4：优化与生产化（第 10-12 周）

**目标**：达到生产环境就绪标准

任务：
- [ ] 性能优化（缓存策略调优 + 向量索引调优）
- [ ] 记忆一致性检查（冲突处理 + 幻觉记忆抑制）
- [ ] 记忆管理 API（查看/删除/修正）
- [ ] PII 保护完善
- [ ] 压力测试（1000 用户 × 1000 MemCell）
- [ ] 完整文档（API 文档 + 部署文档 + 调优指南）
- [ ] Prometheus + Grafana 监控大盘

验收标准：
- LOCOMO 综合基准 > 90%
- 系统在 1000 并发用户下 P99 延迟 < 500ms
- 24小时稳定运行无崩溃
- 文档覆盖率 100%（API + 架构）

#### Milestone 5：扩展能力（第 13-16 周，可选）
- [ ] 多模态记忆（图片/文档的记忆提取）
- [ ] 共享记忆（多 Agent / 多用户协作场景）
- [ ] 记忆遗忘曲线（Ebbinghaus 衰减策略）
- [ ] Memory Guardrail（幻觉记忆检测 + 过滤）
- [ ] 向量库迁移到 Milvus（为大规模场景准备）
- [ ] 水平扩展方案（分片 + 负载均衡）

### 7.4 资源与风险

**所需资源**

| 资源类型 | MVP 阶段 | 生产阶段 |
| --- | --- | --- |
| LLM 调用 | ~$0.05/用户/天（Claude Sonnet） | ~$0.02/用户/天（缓存优化后） |
| 服务器（单机） | 8 核 16G + 200G SSD | 按用户规模水平扩展 |
| 人力 | 1-2 名后端工程师 | 同上 |

**主要风险与缓解**

| 风险 | 概率 | 影响 | 缓解措施 |
| --- | --- | --- | --- |
| LLM 记忆抽取质量不稳定 | 中 | 高 | 引入 Prompt 版本管理 + A/B 测试；关键路径加人工审核 |
| 图谱实体归一化误差积累 | 中 | 中 | 低置信度匹配不自动合并，标记为「待确认」 |
| 混合存储运维复杂度高 | 高 | 中 | MVP 用 pgvector 替代 Milvus，降低引擎数量 |
| EverMemOS 开源实现与论文有差距 | 中 | 中 | 核心逻辑自研，EverMemOS 仅作参考，不强依赖开源代码 |
| 超长对话场景性能退化 | 低 | 高 | 提前做压测；设计 MemScene 分页加载策略 |
## 附录

### 附录 A：边界检测 Prompt 调优笔记

边界检测是 Pipeline 的入口，影响 MemCell 粒度。经验参数：

- completeness_score 阈值 0.75 适合日常对话；对于技术类对话可适当降低到 0.65
- 强制触发阈值（20 条消息 / 2 小时间隔）需根据实际用户对话模式调整
- 建议按场景类型（work/health/casual）分别训练不同的边界检测 Prompt

### 附录 B：MemScene 聚类阈值调优

| 参数 | 默认值 | 调高效果 | 调低效果 |
| --- | --- | --- | --- |
| THRESHOLD_ASSIGN | 0.65 | 创建更多独立 MemScene | MemScene 过于宽泛 |
| THRESHOLD_NEW | 0.40 | 弱归属增多 | 孤立 MemCell 增多 |
| sem_sim 权重 | 0.40 | 更重视语义相似 | 更重视其他维度 |
| entity_overlap 权重 | 0.25 | 更重视实体共享 | 语义优先 |

> 建议：根据 MemScene 平均包含 MemCell 数量来监控：理想范围是 3-15 个；若平均 < 3，调低 THRESHOLD_ASSIGN；若平均 > 20，调高。

### 附录 C：Neo4j 关键 Cypher 查询集

```cypher
-- 1. 查询用户的所有有效实体
MATCH (e:Entity {user_id: $user_id})
WHERE e.last_mentioned > datetime() - duration('P90D')  // 90天内提及
RETURN e ORDER BY e.mention_count DESC LIMIT 20

-- 2. 查询两个实体之间的关系路径（2跳）
MATCH path = (a:Entity {entity_name: $name1})-[*1..2]-(b:Entity {entity_name: $name2})
WHERE a.user_id = $user_id
  AND ALL(r IN relationships(path) WHERE r.valid_to IS NULL)
RETURN path

-- 3. 查询某实体参与的所有项目
MATCH (p:Entity {entity_type: "PERSON", entity_name: $person_name})
      -[r:WORKS_ON]-(proj:Entity {entity_type: "PROJECT"})
WHERE p.user_id = $user_id AND r.valid_to IS NULL
RETURN proj.entity_name, r.label, r.valid_from

-- 4. 时间点查询：某日期的关系状态
MATCH (a:Entity {user_id: $user_id})-[r]-(b:Entity)
WHERE r.valid_from <= datetime($point_in_time)
  AND (r.valid_to IS NULL OR r.valid_to > datetime($point_in_time))
RETURN a.entity_name, type(r), b.entity_name, r.label
```