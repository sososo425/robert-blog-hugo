## Zep的记忆如何实现的

Zep 的记忆实现非常有深度，其核心是一套叫做 **Graphiti** 的**时序知识图谱引擎**。让我用图来拆解它的完整架构。

![[Pasted image 20260417154656.png]]
**核心：Graphiti 时序知识图谱**

Zep 的记忆不是简单地把对话存起来，而是通过 Graphiti 引擎将输入的对话、业务数据、外部事件**实时解析成知识图谱结构**。每一条对话进来后，系统会抽取实体、推断关系，然后以带时间戳的三元组写入图中。

**三层子图分工**

Graphiti 维护多个子图的层次结构，专门针对真实世界的时序索引记忆优化：Episode 子图记录情节记忆，每个节点代表原始事件或消息并标注原始时间戳；Semantic 子图存储实体节点和它们之间带有效期的关系边；Community 子图则存储更高层次的主题聚合，类似 GraphRAG 中的社区摘要。 [Emergent Mind](https://www.emergentmind.com/topics/zep-a-temporal-knowledge-graph-architecture)这三层从"发生了什么"到"涉及谁"再到"整体在讲什么"，构成完整的记忆层次。

**双时态建模（Bitemporal）**

这是 Zep 最有特色的设计。系统追踪四个时间戳：`t_created` 和 `t_expired` 监控事实在系统中的写入与失效时间；`t_valid` 和 `t_invalid` 追踪事实在现实世界中的有效时间范围。 [Medium](https://medium.com/@parklize/how-memory-is-implemented-in-llm-based-agents-f08e7b6662ff)这意味着 Zep 能回答"用户昨天说他住北京，但今天改口说已经搬到上海——以哪个为准？"这类随时间变化的问题，而不是简单地覆盖旧事实。

**三步检索管道**

检索过程分三步：Search 阶段识别候选节点和边；Rerank 阶段用 MMR（最大边际相关性）、提及频率重排序器、以及基于 Cross-encoder 的 LLM 重排序器对结果重新排列；最后 Format 阶段将语义边（事实）、实体节点、社区节点格式化为 LLM 可直接消费的上下文字符串。 [arXiv](https://arxiv.org/pdf/2501.13956)

**三种记忆模式**

Zep 提供三种记忆模式：User Threads（单会话消息历史）、User Graphs（用户个人知识图谱，存储偏好、事实）、Shared Graphs（跨用户的组织级知识图谱）。 [DeepWiki](https://deepwiki.com/getzep/zep/2.2-memory-systems)三种模式在检索时并行搜索，合并结果后一起送给 Agent。

**User Threads vs User Graphs 核心区别**

这两者的关系类似于"日记本"vs"通讯录+事实卡片"——前者记录你说了什么，后者提炼你知道什么。

```
用户对话消息 ──写入──→ User Thread (原始存储)
                           │
                    (后台自动处理: Graphiti 抽取实体/关系)
                           │
                           ▼
                      User Graph (结构化知识)
```


| 对比维度      | User Threads                                                   | User Graphs                                                    |
| --------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| **是什么**   | 按时间顺序存储的原始对话消息流                                                | 从对话中提取出的结构化知识图谱                                                |
| **类比**    | 聊天记录 / 日记本                                                     | 通讯录 + 事实卡片 + 偏好档案                                              |
| **存储的内容** | 完整的 `role: content` 消息序列                                       | 实体节点（Person/Org...）+ 关系边（事实三元组）                                |
| **数据格式**  | 线性、按时间排列的文本                                                    | 图结构，带时态的实体和关系                                                  |
| **API**   | Thread API：`thread.add_messages()`、`thread.get_user_context()` | Graph API：`graph.add(user_id=...)`、`graph.search(user_id=...)` |
| **写入方式**  | 直接写入原始消息                                                       | ① 从 Thread 消息自动后台抽取；② 也可直接通过 Graph API 写入 text/json            |
| **检索方式**  | 两种模式：`summary`（摘要）或 `basic`（原始消息历史）                            | 按 scope 搜索：`edges`（事实）、`nodes`（实体）、`episodes`（事件序列）            |
| **有没有图谱** | **没有**，纯线性消息存储                                                 | **有**，完整的时序知识图谱（Graphiti 三层子图）                                 |
| **时态能力**  | 只有消息的时间戳                                                       | 完整的双时态模型（valid_at / invalid_at / created_at / expired_at）      |
| **典型回答**  | "用户在第 3 轮对话里说了什么？"                                             | "用户喜欢什么编程语言？"（跨所有对话聚合的事实）                                      |


**关键关系**：Thread 是 Graph 的**输入源**之一。当消息写入 Thread 后，Zep 后台自动调用 Graphiti 引擎从消息中抽取实体和关系，写入该用户的 Graph。但 Graph 也可以独立于 Thread 使用——比如直接通过 `graph.add(user_id="u001", data="用户偏好深色主题", type="text")` 写入结构化知识，不经过对话。

**为什么需要两者并存？**

- **Thread 解决"短期上下文"**：当前会话需要最近几轮对话的原文，给 Agent 保持对话连贯性
- **Graph 解决"长期记忆"**：跨越数百次对话，从结构化事实中检索"这个用户是谁、喜欢什么、历史上发生过什么变化"
- 一个管"回忆原话"，一个管"知道事实"——各有不可替代的场景

---

**Thread 深入：存储维护 & Thread→Graph 数据流转**

#### 1. Thread 如何存储和维护短期上下文

**存储**：Thread 中的消息以线性序列存储在 PostgreSQL 中（Zep Cloud 后端），每条消息包含 `role`（user/assistant）、`content`（原文）、`timestamp` 等字段。消息**永久保留，不会被删除或压缩**。

**提供短期上下文的机制**：Zep 的设计是——**Thread 本身不做摘要/窗口截断，而是用 Graph 搜索来"代替"传统的上下文窗口管理**。具体来说：

```
Agent 调用 thread.get_user_context(thread_id)
     │
     │  Zep 内部执行：
     │
     ├─① 取最近 2 条消息作为 query
     │
     ├─② 用这个 query 并行搜索该用户的整个 User Graph：
     │    ├─ 语义搜索（向量相似度）
     │    ├─ 全文搜索
     │    └─ BFS 广度优先搜索（最近 4 个 episode 的关联节点/边，2 层深度）
     │
     ├─③ MMR 重排序（去冗余 + 与最近 4 条消息的相关性）
     │
     └─④ 返回 Context Block：
          ├─ <USER_SUMMARY>  用户画像摘要
          └─ <FACTS>         按相关性排序的事实列表（带时间有效期）
```

**返回给 Agent 的实际上下文格式**（来自 Zep 官方文档）：

```
<USER_SUMMARY>
Emily Painter 是账户 ID 为 Emily0e62 的用户，使用数字艺术工具进行创作。
最近遇到了 Magic Pen Tool 的技术问题，期望获得及时的支持...
</USER_SUMMARY>

<FACTS>
- Emily 遇到了登录问题 (2024-11-14 - present)
- 账户 Emily0e62 因付款失败被暂停 (2024-11-14 - present)
- 失败交易使用了末四位为 1234 的卡片 (2024-09-15 - present)
- 交易失败原因是"卡过期" (2024-09-15 - present)
</FACTS>
```

**Zep 推荐的 Agent Prompt 组装方式**：

```
┌─────────────────────────────────────────────┐
│ System Prompt                               │
│  + Context Block (来自 Graph 搜索的长期记忆)   │
├─────────────────────────────────────────────┤
│ 最近 4~6 条原始消息 (来自 Thread 的短期记忆)   │
├─────────────────────────────────────────────┤
│ 最新一条 User 消息                           │
└─────────────────────────────────────────────┘
```

> **核心思路**：Zep 没有走 MemGPT 那种"滚动窗口+溢出存储"的路线，也没有做传统的"对话摘要压缩"。它的策略是：**最近几条原始消息保持原貌（短期记忆），所有历史信息通过 Graph 搜索按相关性召回（长期记忆）**。Context Block（P95 < 200ms）替代了摘要的角色。

> **为什么 `get_user_context()` 只需要 thread_id 就能搜索整个 User Graph？** 因为 Thread 关联了 user_id，而 User Graph 也是按 user_id（即 group_id）分区的。Thread 只是用来确定"当前在聊什么"（取最近 2 条消息当 query），实际搜索范围是该用户的**所有历史数据**，不限于当前 Thread。

#### 2. Thread 数据如何流转到 Graph 层

这是一个**异步后台处理**的过程。当 `thread.add_messages()` 被调用后：

```
thread.add_messages(thread_id, messages=[...])
     │
     │  ① 消息立即写入 Thread 存储（同步，毫秒级）
     │
     │  ② 后台异步触发 Graphiti add_episode()
     │     （处理延迟：几秒到几分钟，取决于 LLM 调用）
     │
     ▼
Graphiti 的 Episode 处理管道
```

**关键问题：消息如何映射为 Episode？**

Graphiti 的 `add_episode()` 接受一个 `episode_body` 字符串。对于对话场景，**一次调用可以包含多轮对话**：

```python
await graphiti.add_episode(
    name="客服会话_2024-03-15",
    episode_body=(
        "user: 我的订单延迟了\n"
        "assistant: 我帮您查一下订单号\n"
        "user: 订单号是 A12345\n"
        "assistant: 查到了，快递预计明天到达"
    ),
    source=EpisodeType.message,   # 指明是对话格式
    reference_time=datetime(2024, 3, 15, 14, 0),
    group_id="user_u001",
)
```

所以 Thread → Episode 的映射关系是**灵活的**：

- 可以是每条消息 → 一个 Episode（最细粒度）
- 也可以是一组连续消息 → 一个 Episode（Zep 的默认做法，通常按"一轮对话交互"或"一段时间窗口"打包）

**到了 Graph 层的完整处理流程**（是的，有拆分和再提取）：

```
Episode (一段多轮对话原文)
    │
    ├─ Step 1: 创建 EpisodicNode
    │          保存原文到 content 字段，附带 valid_at 时间戳
    │
    ├─ Step 2: 检索上下文
    │          拉取同一 group_id 下最近 N 个历史 Episode
    │          (为后续去重和代词消歧提供上下文)
    │
    ├─ Step 3: 实体抽取（LLM）         ← 这是"再提取"
    │          输入: 原文 + 历史上下文 + entity_types
    │          输出: [{name: "张伟", type: Person},
    │                 {name: "订单A12345", type: Order}, ...]
    │          规则: 代词消歧、说话人必提取、不提取时间
    │
    ├─ Step 4: 实体消解（三级去重）      ← 这是"合并"
    │          新抽取的"张伟" vs 已有的"张伟" → 合并为同一个 EntityNode
    │          精确匹配 → MinHash 模糊 → LLM 判断
    │
    ├─ Step 5: 关系抽取（LLM）         ← 这也是"再提取"
    │          输入: 实体列表 + 原文 + reference_time
    │          输出: [{source: "张伟", target: "订单A12345",
    │                  relation: "HAS_ORDER",
    │                  fact: "张伟有一个延迟的订单A12345",
    │                  valid_at: "2024-03-15T14:00:00Z"}, ...]
    │
    ├─ Step 6: 边消解 + 矛盾检测        ← 这也是"合并"
    │          检查: 已有同样的关系？→ 去重
    │          检查: 新事实与旧事实矛盾？→ 旧边标记 invalid_at/expired_at
    │
    ├─ Step 7: 属性抽取 + Summary 生成
    │          为实体节点更新 summary、attributes
    │
    └─ Step 8: 批量持久化
              创建 MENTIONS 边（Episode→Entity）
              创建 RELATES_TO 边（Entity→Entity）
              生成向量嵌入
              单事务写入 Neo4j
```

**所以回答你的问题**：

> Thread 到 Graph 层**有没有拆分和再提取关系？**

**有**，而且是 Graph 层做的最核心的事情。Thread 只负责存原文，Graph 层做了三件关键的事：


| 操作                 | 说明                          | 为什么需要                                      |
| ------------------ | --------------------------- | ------------------------------------------ |
| **拆分（Extraction）** | LLM 从一段多轮对话中抽取出多个实体和多条关系    | 一段话可能包含 N 个事实，需要分别建模                       |
| **合并（Resolution）** | 新抽取的实体/关系与已有图谱做三级去重和矛盾检测    | "张伟"出现在 100 个 Episode 中，图谱里只有一个 EntityNode |
| **时间推断（Temporal）** | LLM 将"上周""三年前"等相对时间解析为绝对时间戳 | 边的 valid_at/invalid_at 需要精确时间              |


**一图总结 Thread 的两个用途**：

```
                    User Thread
                   ┌─────────────┐
                   │ msg1: ...   │
                   │ msg2: ...   │
                   │ msg3: ...   │
                   │ ...         │
                   │ msg_n: ...  │
                   └──────┬──────┘
                          │
          ┌───────────────┼───────────────┐
          │                               │
    用途 1: 短期上下文                用途 2: Graph 输入源
          │                               │
          ▼                               ▼
  取最近 4~6 条原始消息            后台异步 → Graphiti
  直接拼入 Agent Prompt           add_episode()
  (保持对话连贯性)                    │
          │                     ┌─────┼─────┐
          │                     │     │     │
          │                  抽取   消解   时态推断
          │                  实体   去重   矛盾检测
          │                     │     │     │
          │                     └─────┼─────┘
          │                           │
          │                           ▼
          │                    User Graph (知识图谱)
          │                           │
          │                           ▼
          └──→ Context Block ←── Graph 搜索结果
               (长期记忆)        (语义+全文+BFS)
```

---

**与 MemGPT 的本质区别**

MemGPT 模拟操作系统的分页机制，把对话放入滚动队列，溢出的部分存到外部存储——本质还是线性的文本检索。Zep 则利用时序知识图谱来结构化和检索长期记忆，融入时间推理以在信息随时间变化时维护准确的知识

---

## Graphiti 三层子图数据模型详解

Graphiti 的知识图谱由**节点（Node）** 和**边（Edge）** 组成，按职责分为三层子图。所有节点和边都继承自统一基类，共享 `uuid`、`group_id`、`created_at` 等公共字段。

### 完整图 Schema 总览

```
SagaNode --[HAS_EPISODE]--> EpisodicNode --[NEXT_EPISODE]--> EpisodicNode
EpisodicNode --[MENTIONS]--> EntityNode
EntityNode --[RELATES_TO]--> EntityNode
CommunityNode --[HAS_MEMBER]--> EntityNode
```

#### 节点类型汇总


| 节点类型              | DB 标签        | 所属子图        | 说明                                                                                                   | 关键独有字段                                                                                           | 示例                                                                                                                                               |
| ----------------- | ------------ | ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EpisodicNode**  | `:Episodic`  | Episodic 层  | 保存一次输入的**原始内容**，是知识图谱的事实来源                                                                           | `content`（原文）、`source`（message/json/text）、`valid_at`（事件发生时间）、`entity_edges`（抽取出的关系 UUID 列表）      | 一段客服对话 `"user: 订单延迟了\nassistant: 我查一下"`，valid_at = 2024-03-15                                                                                    |
| **EntityNode**    | `:Entity`    | Semantic 层  | 从 Episode 中抽取、去重后的**现实世界实体**                                                                         | `name`（规范名称）、`name_embedding`（向量嵌入）、`labels`（多标签类型）、`summary`（LLM 聚合摘要）、`attributes`（自定义属性 dict） | name="张伟"，labels=["Person","Engineer"]，summary="张伟是美团的后端开发工程师"                                                                                   |
| **CommunityNode** | `:Community` | Community 层 | 由算法自动聚类的**实体社区**，提供主题级摘要                                                                             | `name`（LLM 生成的社区名称）、`name_embedding`（向量嵌入）、`summary`（社区摘要）                                       | name="中国互联网人才流动"，summary="包含在阿里/字节/腾讯间流动的多位技术人才..."                                                                                              |
| **SagaNode**      | `:Saga`      | Episodic 层  | 多个 Episode 的**命名容器 + 有序链**。解决"哪些 Episode 属于同一段叙事？顺序是什么？"的问题。按 `(name, group_id)` 唯一。不含任何内容字段，仅是组织结构。 | `name`（Saga 标识名，如会话 ID / 文档名）                                                                    | ① 一次完整的客服会话：name="support_session_2024-03-15_ticket5678"，下挂 3 个 Episode（用户开场→排查→解决）；② 一期播客逐段转录：name="podcast_ep42"，下挂 10 个 Episode（每段 5 分钟的转录文本） |


> **关于 EpisodicNode 存原文是否会膨胀——见下方 Q&A 第 1 点**
> **关于 SagaNode 到底是什么——见下方 Q&A 第 2 点**

##### Q&A：EpisodicNode 和 SagaNode 疑问解答

**Q1：EpisodicNode 为什么存储原文？不会膨胀吗？**

这是一个**有意识的设计权衡**，Graphiti 同时提供了控制手段：


| 维度                 | 说明                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **为什么要存**          | ① **溯源需求**：任何一条 EntityEdge 的 `fact` 都可能被质疑"依据是什么？"，必须能追溯到原始对话（`EntityEdge.episodes → EpisodicNode.content`）；② **上下文窗口**：提取新 Episode 时，系统需要拉取最近 N 个历史 Episode 的 `content` 作为上下文，用于代词消歧和实体消解；③ **搜索能力**：Zep 的 BFS 检索会返回 Episode 原文片段，让 Agent 知道"这条事实原话是怎么说的" |
| **确实会膨胀**          | 大量长文本（如文档、多轮对话）写入后，`content` 字段会占用显著的图数据库存储空间                                                                                                                                                                                                              |
| **Graphiti 的解决方案** | 提供 `**store_raw_episode_content`** 开关，在初始化时设置：                                                                                                                                                                                                             |


```python
# 默认：保留原文
graphiti = Graphiti(uri, user, password, store_raw_episode_content=True)

# 不保留原文：处理完成后 content="" 空字符串
graphiti = Graphiti(uri, user, password, store_raw_episode_content=False)
```

设为 `False` 后，EpisodicNode 的 `content` 在抽取完实体和关系后会被清空为 `""`。**抽取出的 EntityNode、EntityEdge 及其嵌入不受影响**，只是丢失了回溯原文的能力。

**实际建议**：

- 对话场景（每条消息几百字）：保留原文，膨胀可控
- 文档/知识库场景（每篇几千到几万字）：考虑 `store_raw_episode_content=False`，或者对长文档做分段后再 `add_episode`（每段作为一个独立 Episode，控制单个 Episode 的 content 大小）
- 另外，Episode 粒度本身也是可控的：可以每条消息一个 Episode（细粒度），也可以一组对话一个 Episode（粗粒度），粒度越粗单个 content 越大

#### EpisodicNode 可选存储架构：三种方案对比分析

除了 Graphiti 默认的"全量存图"和`store_raw_episode_content=False`的"丢弃原文"两个极端，实际落地时还有更灵活的方案。以下对三种方案做完整对比：

**方案 A：原文内联存图（Graphiti 默认）**

```
EpisodicNode
  ├─ content: "user: 我买的鞋子有质量问题...(完整原文)"
  ├─ valid_at, source, ...
  └─ entity_edges: [...]
```

**方案 B：轻量节点 + 原文外部存储（外部证据库）**

```
EpisodicNode (图数据库内)
  ├─ content: ""                          ← 图内不存原文
  ├─ content_ref: "s3://bucket/ep-001"    ← 指向外部存储的引用
  ├─ summary: "用户反馈鞋子质量问题要求退货"  ← LLM 生成的情节摘要
  ├─ valid_at, source, ...
  └─ entity_edges: [...]

外部存储 (S3/OSS/PostgreSQL/ES)
  └─ ep-001: "user: 我买的鞋子有质量问题...(完整原文)"
```

**方案 C：纯摘要节点（丢弃原文）**

```
EpisodicNode (图数据库内)
  ├─ content: ""            ← 不存原文
  ├─ summary: "用户反馈鞋子质量问题要求退货"  ← 只保留摘要
  ├─ valid_at, source, ...
  └─ entity_edges: [...]

原文：处理完即丢弃，不保留
```

**三方案对比**：


| 维度                                 | 方案 A：原文内联       | 方案 B：轻量节点+外部存储        | 方案 C：纯摘要                                           |
| ---------------------------------- | --------------- | --------------------- | -------------------------------------------------- |
| **图 DB 存储压力**                      | 高（原文直接占图 DB 空间） | 低（图内只存 summary + ref） | 最低                                                 |
| **溯源能力**                           | 完整（直接从图中读原文）    | 完整（一次外部跳转取原文）         | **丢失**（只有摘要，无法看到原话）                                |
| **上下文窗口**（提取时需要历史 Episode 原文做代词消歧） | 直接可用            | 需从外部存储拉取（多一次 IO）      | **不可用**——summary 丢失了代词、口语化表达等细节，影响后续 Episode 的抽取质量 |
| **BFS 检索返回原文**                     | 直接返回            | 需要额外查外部存储，增加延迟        | 只能返回摘要                                             |
| **重新抽取**（发现 LLM 抽取有误时重跑）           | 可以，原文在          | 可以，从外部存储取回原文重跑        | **不可以**——原文已丢失                                     |
| **摘要质量风险**                         | 不依赖摘要           | summary 是辅助，原文兜底      | **全部依赖 LLM 摘要质量**——如果摘要遗漏关键细节，信息永久丢失               |
| **架构复杂度**                          | 最简单（单存储）        | 中等（需要外部存储 + 引用管理）     | 最简单                                                |
| **适用场景**                           | 对话为主、数据量可控      | 大规模生产、数据量大、合规要求保留原文   | 个人助手、隐私敏感、不关心溯源                                    |


**分析结论**：

方案 B（轻量节点 + 外部存储）**是可行的，而且在生产环境中是最推荐的折中方案**。原因：

1. **图 DB 本质上不适合存大文本**。Neo4j/FalkorDB 的优势在于图遍历和关系查询，大量文本内容会拖慢图操作的性能。把原文放到对象存储或关系型数据库更合理。
2. **溯源不可丢**。方案 C 看似最轻量，但在实际业务中极易出问题：
  - LLM 抽取不是 100% 准确，发现错误时需要原文重跑
  - 合规审计需要证据链
  - 用户可能问"你说我喜欢 Python，我什么时候说过？"——只有摘要无法回答
3. **对上下文窗口的影响可以工程化解决**：
  - 方案 B 中，`retrieve_episodes()` 拉历史上下文时增加一步外部读取
  - 可以用缓存（Redis）缓解：最近 N 个 Episode 的原文热缓存，命中率高

方案 C（纯摘要）**可以作为方案 B 的降级策略**——对于特别老的 Episode（比如半年前的），可以清理掉外部存储中的原文，只保留摘要节点。这样形成一个分层淘汰策略：

```
最近 7 天：方案 A（原文内联图 DB，热数据快速访问）
7 天~6 个月：方案 B（轻量节点 + 外部冷存储）
6 个月以上：方案 C（纯摘要，外部原文归档/清理）
```

**如果要落地方案 B，Graphiti 需要改造的点**：

Graphiti 原生不支持方案 B，需要在应用层做适配：


| 改造点                 | 说明                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ |
| 新增 `content_ref` 字段 | EpisodicNode 扩展一个引用字段（或复用 `source_description` 存储外部地址）                               |
| 新增 `summary` 字段     | EpisodicNode 目前没有 summary（只有 EntityNode 和 CommunityNode 有），需要新增，在 Episode 入图时 LLM 生成 |
| 写入流程改造              | `add_episode()` 后，将 content 写入外部存储，然后清空图内 content                                    |
| 读取流程改造              | `retrieve_episodes()` 拉上下文时，从外部存储按 `content_ref` 取回原文                                |
| Summary 嵌入          | 为 summary 生成向量嵌入，支持按情节摘要做语义搜索                                                        |


---

**Q2：SagaNode 到底是什么？解决什么问题？**

SagaNode 用一句话说：**它是 Episode 的"文件夹"——给一组相关 Episode 起个名字并串成有序链表**。

**为什么需要它？** 没有 Saga 的话，所有 Episode 就是一个扁平的集合，只能按 `group_id` + `valid_at` 排序。但现实中，同一个用户可能同时有多条对话线：

```
用户 u001 (group_id = "user_u001")
  ├─ 客服会话 A（3月15日关于退货）   ← 这是一条叙事线
  │    ├─ Episode 1: 用户描述问题
  │    ├─ Episode 2: 客服排查
  │    └─ Episode 3: 问题解决
  │
  ├─ 客服会话 B（3月16日关于发票）   ← 这是另一条叙事线
  │    ├─ Episode 4: 用户要发票
  │    └─ Episode 5: 客服提供发票
  │
  └─ 导入的 HR 文档（3月17日）      ← 这又是一条
       ├─ Episode 6: 文档第1段
       ├─ Episode 7: 文档第2段
       └─ Episode 8: 文档第3段
```

不用 Saga → Episode 1~8 混在一起，无法区分"哪些属于同一次对话"
用 Saga → 三个 SagaNode 各自挂着自己的 Episode 链

**具体的图结构示例**：

```
SagaNode (name="客服会话A_退货")
    │
    ├──[HAS_EPISODE]──→ Episode 1 (用户: 我要退货...)
    ├──[HAS_EPISODE]──→ Episode 2 (客服: 请提供订单号...)
    └──[HAS_EPISODE]──→ Episode 3 (客服: 已提交退货申请...)

Episode 1 ──[NEXT_EPISODE]──→ Episode 2 ──[NEXT_EPISODE]──→ Episode 3
```

- `HAS_EPISODE` 回答"这个 Saga 包含哪些 Episode？"（成员关系，无序）
- `NEXT_EPISODE` 回答"这些 Episode 的先后顺序是什么？"（时间链，有序）

**创建方式**：SagaNode 是**隐式创建**的——只要在 `add_episode()` 时传入 `saga` 参数，系统自动 get-or-create：

```python
# 第一次传入 saga="客服会话A_退货" → 自动创建 SagaNode
result1 = await graphiti.add_episode(
    name="用户描述问题",
    episode_body="user: 我买的鞋子有质量问题想退货...",
    source=EpisodeType.message,
    reference_time=datetime(2024, 3, 15, 10, 0),
    saga="客服会话A_退货",      # ← 指定 Saga 名称
    group_id="user_u001",
)

# 第二次传入同一 saga → 复用已有 SagaNode，自动追加 NEXT_EPISODE 链
result2 = await graphiti.add_episode(
    name="客服排查",
    episode_body="assistant: 请提供您的订单号...",
    source=EpisodeType.message,
    reference_time=datetime(2024, 3, 15, 10, 5),
    saga="客服会话A_退货",
    saga_previous_episode_uuid=result1.episode.uuid,  # 优化：跳过 DB 查询
    group_id="user_u001",
)
```

**典型使用场景**：


| 场景     | Saga name 命名              | 每个 Episode 是什么        |
| ------ | ------------------------- | --------------------- |
| 多轮客服会话 | 会话 ID（如 `session_abc123`） | 每轮 user+assistant 的对话 |
| 播客处理   | 播客期号（如 `podcast_ep42`）    | 每 5 分钟的转录文本段          |
| 文档版本追踪 | 文档名（如 `设计文档_v3`）          | 每次修订的内容               |
| 邮件线程   | 邮件 thread ID              | 每封邮件                  |


**不用 Saga 也行**：Saga 是可选的。如果业务场景不需要区分叙事线（比如每个用户只有一个连续的对话流），不传 `saga` 参数即可，Episode 照常工作。

#### 边类型汇总


| 边类型                 | 关系标签            | 源节点 → 目标节点                  | 说明                     | 关键独有字段                                                                                                                                                                   | 示例                                                                                     |
| ------------------- | --------------- | --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **EpisodicEdge**    | `:MENTIONS`     | EpisodicNode → EntityNode   | 情节**提及**了哪些实体，提供溯源链路   | （无特殊字段，仅基类字段）                                                                                                                                                            | ep-001 --MENTIONS--> "张伟"：表示这段对话中提到了张伟                                                 |
| **EntityEdge**      | `:RELATES_TO`   | EntityNode → EntityNode     | 两个实体之间的**事实关系**，核心数据结构 | `name`（关系类型如 WORKS_AT）、`fact`（自然语言事实）、`fact_embedding`（向量嵌入）、`episodes`（来源 Episode 列表）、`valid_at`/`invalid_at`（事件时间）、`created_at`/`expired_at`（系统时间）、`attributes`（自定义属性） | "张伟" --RELATES_TO--> "美团"，name="WORKS_AT"，fact="张伟于2024年加入美团做后端开发"，valid_at=2024-08-08 |
| **CommunityEdge**   | `:HAS_MEMBER`   | CommunityNode → EntityNode  | 社区**包含**哪些成员实体         | （无特殊字段）                                                                                                                                                                  | "中国互联网人才流动" --HAS_MEMBER--> "张伟"                                                       |
| **HasEpisodeEdge**  | `:HAS_EPISODE`  | SagaNode → EpisodicNode     | Saga**包含**哪些情节         | （无特殊字段）                                                                                                                                                                  | saga-001 --HAS_EPISODE--> ep-001、ep-002、ep-003                                         |
| **NextEpisodeEdge** | `:NEXT_EPISODE` | EpisodicNode → EpisodicNode | 同一 Saga 内情节的**时间顺序链**  | （无特殊字段）                                                                                                                                                                  | ep-001 --NEXT_EPISODE--> ep-002 --NEXT_EPISODE--> ep-003                               |


#### 所有节点/边共有的基类字段


| 字段           | 类型       | 说明                |
| ------------ | -------- | ----------------- |
| `uuid`       | str      | uuid4 自动生成的全局唯一主键 |
| `group_id`   | str      | 多租户分区键            |
| `created_at` | datetime | 系统写入时间            |


节点额外共有 `name`（标识名）和 `labels`（标签列表）；边额外共有 `source_node_uuid` 和 `target_node_uuid`（拓扑方向）。

---

### 第一层：Episodic 子图（情节记忆层）

**职责**：存储原始输入事件，保留未经加工的上下文，是知识图谱的"事实来源"。

#### 节点：EpisodicNode（标签 `:Episodic`）


| 字段                   | 类型          | 说明                                 |
| -------------------- | ----------- | ---------------------------------- |
| `uuid`               | str         | 唯一标识                               |
| `name`               | str         | 情节名称                               |
| `content`            | str         | **原始输入内容**（对话/JSON/文本）             |
| `source`             | EpisodeType | 输入格式枚举：`message` / `json` / `text` |
| `source_description` | str         | 来源元数据描述                            |
| `valid_at`           | datetime    | **事件实际发生时间**                       |
| `created_at`         | datetime    | 系统写入时间                             |
| `entity_edges`       | list[str]   | 从该情节中抽取出的 EntityEdge UUID 列表       |
| `group_id`           | str         | 租户/分区 ID                           |


> source `不是"数据来源"，而是输入格式声明——它告诉 Graphiti 用哪套 Prompt 来抽取实体和关系 "数据从哪来的"由另一个字段` source_description` 记录。


| source 值  | 含义                     | 抽取差异         |
| --------- | ---------------------- | ------------ |
| `message` | 对话格式（`actor: content`） | 代词消歧、说话人强制提取 |
| `json`    | JSON 结构                | 遍历 key-value |
| `text`    | 普通文本                   | 通用散文抽取       |


#### 边：EpisodicEdge（关系类型 `:MENTIONS`）


| 字段                 | 类型       | 说明              |
| ------------------ | -------- | --------------- |
| `uuid`             | str      | 唯一标识            |
| `source_node_uuid` | str      | 指向 EpisodicNode |
| `target_node_uuid` | str      | 指向 EntityNode   |
| `group_id`         | str      | 租户/分区 ID        |
| `created_at`       | datetime | 创建时间            |


还有两种辅助边：

- **NextEpisodeEdge** (`:NEXT_EPISODE`)：按时间顺序串联同一 Saga 下的情节
- **HasEpisodeEdge** (`:HAS_EPISODE`)：将 SagaNode 与其包含的情节关联

#### 举例

假设用户在客服会话中说了一句话：

```
EpisodicNode:
  uuid: "ep-001"
  name: "客服会话 2024-03-15"
  content: "user: 我的订单延迟了\nassistant: 我帮您查一下"
  source: message
  source_description: "support_ticket_5678"
  valid_at: 2024-03-15T10:30:00Z    # 对话实际发生时间
  created_at: 2024-03-15T10:35:00Z  # 系统入库时间
  entity_edges: ["edge-001", "edge-002"]
  group_id: "customer_123"
```

系统从中抽取出实体"用户"和"订单"后，创建两条 EpisodicEdge：

```
EpisodicEdge:
  source_node_uuid: "ep-001"   → 指向上面的 EpisodicNode
  target_node_uuid: "ent-user" → 指向 EntityNode「用户」
  关系类型: MENTIONS
```

---

### 第二层：Entity/Semantic 子图（语义知识层）

**职责**：存储从情节中抽取、去重后的**实体**和**实体间关系（事实）**。这是知识图谱的核心语义层，支持双时态建模。

#### 节点：EntityNode（标签 `:Entity`）


| 字段               | 类型             | 说明                                                 |
| ---------------- | -------------- | -------------------------------------------------- |
| `uuid`           | str            | 唯一标识                                               |
| `name`           | str            | **规范化实体名称**（去重后的唯一名）                               |
| `name_embedding` | list[float]    | None                                               |
| `summary`        | str            | 由所有关联边的 fact 自动聚合生成的实体摘要                           |
| `labels`         | list[str]      | **实体类型标签**，如 `["Person"]`、`["Person", "Employee"]` |
| `attributes`     | dict[str, Any] | 自定义属性（由 Pydantic Schema 定义、LLM 抽取）                 |
| `group_id`       | str            | 租户/分区 ID                                           |
| `created_at`     | datetime       | 首次入图时间                                             |


#### 边：EntityEdge（关系类型 `:RELATES_TO`）

这是 Graphiti 最核心的数据结构，承载了**带时态的事实三元组**。


| 字段                 | 类型             | 说明                              |
| ------------------ | -------------- | ------------------------------- |
| `uuid`             | str            | 唯一标识                            |
| `source_node_uuid` | str            | 源 EntityNode UUID               |
| `target_node_uuid` | str            | 目标 EntityNode UUID              |
| `name`             | str            | 关系名称（如 `works_at`、`married_to`） |
| `fact`             | str            | **自然语言事实描述**                    |
| `fact_embedding`   | list[float]    | None                            |
| `episodes`         | list[str]      | 提到该事实的所有 Episode UUID（溯源）       |
| `attributes`       | dict[str, Any] | 自定义属性                           |
| `group_id`         | str            | 租户/分区 ID                        |
| `**created_at`**   | datetime       | **系统时间**：事实入库时间                 |
| `**expired_at`**   | datetime       | None                            |
| `**valid_at`**     | datetime       | None                            |
| `**invalid_at`**   | datetime       | None                            |


> 四个时间戳构成**双时态模型（Bitemporal）**：`created_at` / `expired_at` 跟踪"系统何时知道/遗忘"；`valid_at` / `invalid_at` 跟踪"现实中何时成立/不再成立"。

#### `fact` 作为边属性的设计考量

EntityEdge 上同时存在 `name`（结构化关系类型，如 `WORKS_AT`）和 `fact`（自然语言描述，如 "张伟于2024年加入美团做后端开发"）。**为什么不只用 name？为什么 fact 放在边上而不是独立建节点？** 这是 Graphiti 最关键的建模决策之一。

**先看 `name` 和 `fact` 各自解决什么问题**：

```
EntityEdge:
  张伟 ──[RELATES_TO]──→ 美团
  name: "WORKS_AT"                          ← 结构化标签：用于过滤、聚合、约束
  fact: "张伟于2024年加入美团做后端开发工程师"    ← 自然语言：用于语义搜索、LLM 消费、展示给用户
```


| 字段     | 本质          | 用途                                                 | 能力            |
| ------ | ----------- | -------------------------------------------------- | ------------- |
| `name` | 关系**类别**    | 按类型过滤（"查所有 WORKS_AT 关系"）、约束合法的实体对（Person→Org）、聚合统计 | 结构化查询         |
| `fact` | 关系的**完整语义** | 语义搜索（`fact_embedding`）、直接送给 LLM 读、展示给用户、矛盾检测的语义比对  | 语义搜索 + LLM 理解 |


> `name` 回答"什么类型的关系"，`fact` 回答"这个关系具体说了什么"。

**为什么 `name` 不够？**

```
仅有 name="WORKS_AT"，你丢失了：
  - 什么时候加入的？     → fact 里有 "2024年"
  - 什么职位？          → fact 里有 "后端开发工程师"
  - 是跳槽还是应届？     → fact 里有 "从腾讯跳槽"
  - 工作内容是什么？     → fact 里有 "负责微信支付"
```

关系类型是**离散分类**（WORKS_AT / LIVES_IN / MARRIED_TO），表达能力有限。`fact` 是**连续语义**，保留了原文的全部信息密度。

**为什么 `fact` 放在边上，而不是独立建 FactNode？**

这是另一种可行的建模方式（RDF 中叫"关系具象化 / Reification"）：

```
方案 X（独立 FactNode）：
  张伟 ──[HAS_FACT]──→ FactNode("张伟于2024年加入美团") ──[ABOUT]──→ 美团
                           ├─ fact_embedding: [...]
                           ├─ valid_at: 2024-01-01
                           └─ episodes: [ep-100]
```

对比 Graphiti 的做法：

```
Graphiti 的做法（fact 作为边属性）：
  张伟 ──[RELATES_TO {fact:"张伟于2024年加入美团", valid_at:...}]──→ 美团
```


| 维度        | 独立 FactNode                                      | fact 作为边属性（Graphiti 选择）                              |
| --------- | ------------------------------------------------ | ---------------------------------------------------- |
| **查询性能**  | 差——从 Entity A 到 Entity B 需要跳两层（A→Fact→B），遍历成本翻倍  | 好——单跳直达，`MATCH (a)-[e:RELATES_TO]->(b)` 一步完成         |
| **时态绑定**  | 需要在 FactNode 上挂 valid_at/invalid_at，查询时既过滤节点又过滤边 | 时态字段和 fact 在**同一条边**上，WHERE 条件天然一体                   |
| **语义搜索**  | 向量索引建在 FactNode 上，搜到后还需再跳转获取两端实体                 | 向量索引建在边的 `fact_embedding` 上，搜到边直接拿到 source/target 实体 |
| **数据一致性** | FactNode 删除时需要同步清理两端的 HAS_FACT / ABOUT 边         | 删一条边即完成，无级联清理                                        |
| **存储开销**  | 每条事实 = 1 个节点 + 2 条边                              | 每条事实 = 1 条边                                          |
| **表达力**   | 更强——可以对 Fact 建立二级关系（如 Fact 的来源 Agent、Fact 的置信度等） | 较弱——边属性是扁平的 dict，无法对边再建关系                            |


> **Graphiti 选择 fact 作为边属性的核心理由**：知识图谱的主要操作是**遍历实体间的关系**和**按事实语义搜索**。这两个操作在"边属性"模式下都是单跳完成，性能最优。独立 FactNode 的额外表达力（对 fact 再建关系）在 Agent 记忆场景下几乎用不到。

**fact 在实际数据流中的角色**：

```
写入时：
  对话原文 → LLM 抽取 → fact (对原文的改写/概括)
                         ↓
                    fact_embedding (向量化)

检索时：
  用户 query → 向量搜索 fact_embedding → 命中的 EntityEdge
    → 返回 fact 文本（直接可读）
    → 附带 valid_at/invalid_at（时态上下文）
    → 拼入 Context Block 的 <FACTS> 部分送给 Agent

矛盾检测时：
  新 fact vs 已有 fact → 语义相似度比较 → 判断是否矛盾
  如矛盾 → 旧边标记 invalid_at/expired_at
```

**fact 的生成规则**（来自 Graphiti 源码 Prompt）：

> *"The `fact` should closely paraphrase the original source sentence(s). Do not verbatim quote the original text."*

即 `fact` 不是原文的逐字复制，而是**改写后的事实陈述**。这有两个好处：

1. **去噪**：原文可能包含口语、代词、废话，fact 是提炼后的清晰表述
2. **标准化**：不同 Episode 中对同一事实的不同表述方式（"他去了美团" vs "张伟加入美团"）被标准化为一致的 fact

#### 举例

假设系统处理过两段对话：

1. "小明在2020年加入了阿里巴巴"
2. "小明在2024年跳槽去了字节跳动"

抽取出的图结构：

```
EntityNode (实体节点):
  ① uuid: "ent-xiaoming"
     name: "小明"
     labels: ["Person"]
     summary: "小明曾在阿里巴巴工作，2024年跳槽至字节跳动"
     attributes: {}

  ② uuid: "ent-alibaba"
     name: "阿里巴巴"
     labels: ["Organization"]
     summary: "中国互联网公司"

  ③ uuid: "ent-bytedance"
     name: "字节跳动"
     labels: ["Organization"]
     summary: "中国互联网公司"

EntityEdge (关系边):
  ① uuid: "rel-001"
     source_node_uuid: "ent-xiaoming"
     target_node_uuid: "ent-alibaba"
     name: "works_at"
     fact: "小明于2020年加入阿里巴巴工作"
     valid_at:   2020-01-01    # 现实中生效
     invalid_at: 2024-01-01    # 现实中失效（跳槽了）
     created_at: 2024-03-10    # 系统入库
     expired_at: 2024-03-12    # 被新事实取代

  ② uuid: "rel-002"
     source_node_uuid: "ent-xiaoming"
     target_node_uuid: "ent-bytedance"
     name: "works_at"
     fact: "小明于2024年跳槽至字节跳动"
     valid_at:   2024-01-01    # 现实中生效
     invalid_at: null          # 仍然有效
     created_at: 2024-03-12    # 系统入库
     expired_at: null          # 未被取代
```

通过双时态模型，系统可以回答"小明2022年在哪里工作？"（阿里巴巴）和"小明现在在哪里工作？"（字节跳动）。

---

### 第三层：Community 子图（社区聚合层）

**职责**：对语义层的实体进行**自动聚类**，生成高层次的主题摘要。类似 GraphRAG 的社区摘要思路，但在 Graphiti 中使用 `label_propagation` 算法实时维护。

#### 节点：CommunityNode（标签 `:Community`）


| 字段               | 类型          | 说明                            |
| ---------------- | ----------- | ----------------------------- |
| `uuid`           | str         | 唯一标识                          |
| `name`           | str         | **自动生成的社区名称**（由 LLM 根据成员实体生成） |
| `name_embedding` | list[float] | None                          |
| `summary`        | str         | **社区摘要**（聚合成员实体信息，LLM 生成）     |
| `group_id`       | str         | 租户/分区 ID                      |
| `created_at`     | datetime    | 创建时间                          |


#### 边：CommunityEdge（关系类型 `:HAS_MEMBER`）


| 字段                 | 类型       | 说明               |
| ------------------ | -------- | ---------------- |
| `uuid`             | str      | 唯一标识             |
| `source_node_uuid` | str      | 指向 CommunityNode |
| `target_node_uuid` | str      | 指向 EntityNode    |
| `group_id`         | str      | 租户/分区 ID         |
| `created_at`       | datetime | 创建时间             |


#### 聚类算法

Graphiti 使用 **Label Propagation** 算法进行社区发现，按 `group_id` 独立运行。流程：

1. 在 Entity 子图上运行标签传播，将紧密连接的实体划入同一社区
2. 为每个社区调用 LLM 生成 `name` 和 `summary`
3. 创建 CommunityNode 并通过 `HAS_MEMBER` 边连接成员实体

#### 举例

接上面小明的例子，加入更多实体后，系统可能自动聚类出：

```
CommunityNode:
  uuid: "comm-001"
  name: "中国互联网行业人才流动"
  summary: "该社区包含多位在阿里巴巴、字节跳动、腾讯等中国互联网公司之间
            流动的技术人才，涉及小明、小红等人的工作经历和职位变动。"
  group_id: "default"

CommunityEdge (HAS_MEMBER):
  ① source: "comm-001" → target: "ent-xiaoming"   (小明)
  ② source: "comm-001" → target: "ent-alibaba"    (阿里巴巴)
  ③ source: "comm-001" → target: "ent-bytedance"  (字节跳动)
```

社区节点在检索时可以提供**主题级别的上下文**——当用户询问"中国互联网人才流动趋势"这类宏观问题时，系统无需遍历所有边，直接返回社区摘要即可。

---

### 三层协作关系总结


| 层次                  | 节点类型          | 边类型                     | 回答的问题            | 数据来源                       |
| ------------------- | ------------- | ----------------------- | ---------------- | -------------------------- |
| **Episodic**        | EpisodicNode  | MENTIONS / NEXT_EPISODE | "原始对话说了什么？"      | 直接写入                       |
| **Entity/Semantic** | EntityNode    | RELATES_TO（双时态）         | "谁和谁有什么关系？什么时候？" | LLM 从 Episode 中抽取          |
| **Community**       | CommunityNode | HAS_MEMBER              | "整体在讲什么主题？"      | Label Propagation + LLM 聚合 |


数据流向：**Episode → (LLM 抽取) → Entity → (算法聚类) → Community**，三层从细粒度到粗粒度，共同支撑从"发生了什么"到"涉及谁"再到"整体在讲什么"的完整记忆层次。

---

## Episodic 与 Semantic 子图：节点/边如何定义、一段话如何被抽取、属性设计原则

### 一、节点与边的类定义结构

Graphiti 的所有节点和边都基于 Pydantic BaseModel，通过抽象基类统一接口：

```
                BaseModel (Pydantic)
                     │
        ┌────────────┴────────────┐
      Node (ABC)               Edge (ABC)
   ┌────┼────┬────┐        ┌────┼────┬─────┬──────┐
   │    │    │    │        │    │    │     │      │
Episodic Entity Community Saga  Episodic Entity Community HasEpisode NextEpisode
 Node    Node   Node    Node   Edge    Edge    Edge      Edge        Edge
```

**基类 Node** 提供的公共字段：

```python
class Node(BaseModel, ABC):
    uuid: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    group_id: str
    labels: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: utc_now())

    @abstractmethod
    async def save(self, driver: GraphDriver): ...
    async def delete(self, driver: GraphDriver): ...
```

**基类 Edge** 提供的公共字段：

```python
class Edge(BaseModel, ABC):
    uuid: str = Field(default_factory=lambda: str(uuid4()))
    group_id: str
    source_node_uuid: str
    target_node_uuid: str
    created_at: datetime

    @abstractmethod
    async def save(self, driver: GraphDriver): ...
    async def delete(self, driver: GraphDriver): ...
```

> 设计要点：基类只包含"身份标识 + 分区 + 时间 + 图拓扑"四类最基础的属性，子类按各自语义需要扩展。

---

### 二、一段对话具体如何被抽取为图结构（End-to-End 示例）

假设输入以下一段**多轮对话**（`EpisodeType.message`），`reference_time = 2024-08-15T14:00:00Z`：

```
user: 我叫张伟，上周刚从腾讯跳槽到了美团，做后端开发
assistant: 欢迎张伟！能告诉我你之前在腾讯做了多久吗？
user: 在腾讯待了三年，主要做微信支付
```

以下是 Graphiti 的 **四阶段处理流程**：

#### Phase 1：创建 EpisodicNode 并检索上下文

系统首先将原始对话写入 EpisodicNode（不做任何加工）：

```
EpisodicNode:
  uuid: "ep-100"
  name: "对话 2024-08-15"
  content: "user: 我叫张伟，上周刚从腾讯跳槽到了美团...(完整原文)"
  source: message               ← 指明是对话格式
  source_description: "chat_session_001"
  valid_at: 2024-08-15T14:00:00Z
  created_at: 2024-08-15T14:00:05Z
  group_id: "user_zhangwei"
```

然后调用 `retrieve_episodes()` 拉取该 group_id 下最近 N 条历史 Episode 作为上下文（默认 `RELEVANT_SCHEMA_LIMIT = 10`）。

#### Phase 2：Node 抽取与消解

系统构建 Prompt 调用 LLM。**关键——Prompt 是按 episode.source 分路由的**：


| EpisodeType | Prompt 函数           | 特殊处理                                         |
| ----------- | ------------------- | -------------------------------------------- |
| `message`   | `extract_message()` | **代词消歧**（he/she→全名）、**说话人必提取**（冒号前的名字是第一个实体） |
| `json`      | `extract_json()`    | 遍历 JSON 结构字段                                 |
| `text`      | `extract_text()`    | 通用散文抽取                                       |


对话格式下，Prompt 的核心指令（来自源码）：

> *"Always extract the speaker (the part before the colon `:`) as the first entity node."*
> *"Pronoun references such as he/she/they should be disambiguated to the names of the reference entities."*
> *"Do NOT extract entities representing relationships or actions."*
> *"Do NOT extract dates, times, or other temporal information—these will be handled separately."*

LLM 返回结构化结果 `ExtractedEntities`：

```python
class ExtractedEntity(BaseModel):
    name: str            # 实体名
    entity_type_id: int  # 对应预定义的实体类型 ID
```

本例 LLM 输出：

```json
{
  "extracted_entities": [
    {"name": "张伟",   "entity_type_id": 1},  // Person
    {"name": "腾讯",   "entity_type_id": 2},  // Organization
    {"name": "美团",   "entity_type_id": 2},  // Organization
    {"name": "微信支付", "entity_type_id": 3}  // Product
  ]
}
```

> **entity_type_id 是怎么来的？需要预定义吗？**
>
> **不是必须的，是可选预定义**。两种模式：
>
> - **不传** `entity_types`：所有实体都归为通用 `Entity` 类型，LLM 自由抽取，没有自定义属性。开箱即用但分类粗糙。
> - **传入** `entity_types`：调用方用 Pydantic Model 定义类型（如 `Person`、`Organization`），Graphiti 内部自动把 dict key 按顺序映射为 `entity_type_id = 1, 2, 3...`，连同 docstring 描述一起拼入 Prompt 给 LLM 做分类。分类后还会按 Schema 提取自定义 attributes。
>
> 关系（Edge）同理——`edge_types` 参数可以预定义关系类型和合法实体对签名，不传则 LLM 自由命名。

**注意**：`user`、`assistant` 这种通用代词不会被抽取；"上周"、"三年"等时间信息**不在此阶段抽取**，留给 Edge 阶段处理。

**Node 消解（三级去重策略）**：

```
新抽取的 "腾讯"
    │
    ├─ Tier 1: 精确匹配 → 归一化后的字符串 == 已有 EntityNode.name？
    │                      是 → 直接合并，跳过
    │
    ├─ Tier 2: 模糊匹配 → MinHash Jaccard 相似度
    │                      相似 → 候选列表
    │
    └─ Tier 3: LLM 判断 → 将候选送入 dedupe_nodes prompt
                           LLM 返回: "腾讯" == "腾讯控股"? → 是，合并
```

消解后生成最终的 EntityNode 列表：

```
EntityNode ①:
  uuid: "ent-zhangwei"
  name: "张伟"
  labels: ["Person"]
  summary: ""   ← 首次出现，后续聚合
  attributes: {}

EntityNode ②:
  uuid: "ent-tencent"
  name: "腾讯"
  labels: ["Organization"]

EntityNode ③:
  uuid: "ent-meituan"
  name: "美团"
  labels: ["Organization"]

EntityNode ④:
  uuid: "ent-wechatpay"
  name: "微信支付"
  labels: ["Product"]
```

此时系统创建 **EpisodicEdge (MENTIONS)** 将情节与实体关联：

```
ep-100 --[MENTIONS]--> ent-zhangwei
ep-100 --[MENTIONS]--> ent-tencent
ep-100 --[MENTIONS]--> ent-meituan
ep-100 --[MENTIONS]--> ent-wechatpay
```

#### Phase 3：Edge 抽取与消解

系统将抽取出的实体列表 + 原文 + reference_time 一起喂给 `extract_edges` Prompt。

Prompt 核心指令（来自源码）：

> *"Extract all factual relationships between the given ENTITIES based on the CURRENT MESSAGE."*
> *"The `fact` should closely paraphrase the original source sentence(s). Do not verbatim quote."*
> *"Use `REFERENCE_TIME` to resolve vague or relative temporal expressions (e.g., 'last week')."*
> *"If the fact is ongoing (present tense), set `valid_at` to REFERENCE_TIME."*
> *"If a change/termination is expressed, set `invalid_at` to the relevant timestamp."*

LLM 返回结构化 `ExtractedEdges`：

```python
class Edge(BaseModel):
    source_entity_name: str    # 源实体名（必须在 ENTITIES 列表中）
    target_entity_name: str    # 目标实体名
    relation_type: str         # SCREAMING_SNAKE_CASE 关系类型
    fact: str                  # 自然语言事实描述
    valid_at: str | None       # ISO 8601
    invalid_at: str | None     # ISO 8601
```

本例 LLM 输出：

```json
{
  "edges": [
    {
      "source_entity_name": "张伟",
      "target_entity_name": "腾讯",
      "relation_type": "WORKED_AT",
      "fact": "张伟在腾讯工作了三年，主要负责微信支付的后端开发",
      "valid_at": "2021-08-08T00:00:00Z",
      "invalid_at": "2024-08-08T00:00:00Z"
    },
    {
      "source_entity_name": "张伟",
      "target_entity_name": "美团",
      "relation_type": "WORKS_AT",
      "fact": "张伟于上周从腾讯跳槽至美团，担任后端开发工程师",
      "valid_at": "2024-08-08T00:00:00Z",
      "invalid_at": null
    },
    {
      "source_entity_name": "张伟",
      "target_entity_name": "微信支付",
      "relation_type": "WORKED_ON",
      "fact": "张伟在腾讯期间主要负责微信支付项目",
      "valid_at": "2021-08-08T00:00:00Z",
      "invalid_at": "2024-08-08T00:00:00Z"
    }
  ]
}
```

> 注意 LLM 如何将"上周"解析为 `2024-08-08`（reference_time 减 7 天），将"三年"倒推为 `2021-08-08`。

**Edge 消解（矛盾检测与时态失效）**：

如果图中已有一条旧边：`张伟 --[WORKS_AT]--> 腾讯, valid_at=2021, invalid_at=null`

新边 `张伟 --[WORKS_AT]--> 美团` 会触发**矛盾检测**：

1. 搜索同一对节点间的已有边
2. 语义相似度判断是否矛盾
3. 若矛盾：旧边设 `invalid_at = 2024-08-08`、`expired_at = now()`

##### Graphiti 矛盾检测的具体实现

整个 Edge 消解分为**三个 Stage**，逐层过滤：

```
新抽取的边 (new_edge)
    │
    ├─ Stage 1: 快速逐字匹配
    │   从图中查出同一对节点 (source, target) 之间的所有已有边
    │   对比 fact 归一化后的字符串：
    │     完全相同？ → 直接复用旧边，把新 episode UUID 追加到 episodes 列表
    │     不相同？  → 进入 Stage 2
    │
    ├─ Stage 2: LLM 去重 + 矛盾检测（核心）
    │   构建两个候选列表：
    │     EXISTING FACTS:                同一对节点间的已有边（精确匹配）
    │     FACT INVALIDATION CANDIDATES:  语义相似的边（向量搜索 fact_embedding）
    │   两个列表统一编号（idx 连续），连同 new_edge 一起送入 LLM Prompt
    │   LLM 返回：
    │     duplicate_facts: [idx...]     ← 与新事实语义相同的旧边
    │     contradicted_facts: [idx...]  ← 被新事实推翻的旧边
    │
    └─ Stage 3: 时态处理
        对 contradicted_facts 中的每条旧边执行：
          旧边.invalid_at = new_edge.valid_at   (现实中失效时间)
          旧边.expired_at = now()               (系统中被取代时间)
        对 duplicate_facts：
          复用旧边，追加 episode UUID
        特殊情况：如果旧边的 valid_at > 新边的 valid_at
          说明新写入的是一条"更早的历史事实"
          → 新边自己被标记为 expired（旧边反而是更新的）
```

**Stage 2 的 LLM Prompt 实际长什么样**（来自源码 `dedupe_edges.resolve_edge`）：

```
系统消息：
  "You are a helpful assistant that de-duplicates facts and determines
   which existing facts are contradicted by the new fact."

用户消息：
  <EXISTING FACTS>                        ← 同一节点对的已有边，带 idx 编号
  [
    {"idx": 0, "fact": "张伟在腾讯工作", "valid_at": "2021-01-01", ...},
    {"idx": 1, "fact": "张伟是腾讯的后端工程师", "valid_at": "2021-06-01", ...}
  ]

  <FACT INVALIDATION CANDIDATES>          ← 语义搜索召回的相似边，idx 继续编号
  [
    {"idx": 2, "fact": "张伟在百度实习", "valid_at": "2019-01-01", ...}
  ]

  <NEW FACT>                              ← 新抽取的边
  {"fact": "张伟于2024年跳槽至美团做后端开发"}
```

LLM 返回结构化结果：

```python
class EdgeDuplicate(BaseModel):
    duplicate_facts: list[int]      # 与新事实相同的旧边 idx（只能从 EXISTING FACTS 中选）
    contradicted_facts: list[int]   # 被新事实推翻的旧边 idx（两个列表都可以选）
```

本例 LLM 可能返回：

```json
{
  "duplicate_facts": [],
  "contradicted_facts": [0, 1]    // idx 0 和 1 都被新事实推翻
}
```

**为什么候选列表分两组？**

- `EXISTING FACTS`：同一节点对 (张伟→腾讯) 之间的已有边——精确匹配，最可能是重复或矛盾
- `FACT INVALIDATION CANDIDATES`：通过 `fact_embedding` 向量搜索召回的语义相似边——可能涉及不同节点对但语义冲突（如"张伟在百度实习"虽然不是同一节点对，但也可能被张伟去美团的事实间接影响）

##### 其他主流矛盾处理方案对比

Graphiti 的做法（LLM 判断 + 双时态标记）并非唯一选择。业界有几种不同思路：


| 方案                          | 核心思路                                              | 代表系统                     | 优点                             | 缺点                                 |
| --------------------------- | ------------------------------------------------- | ------------------------ | ------------------------------ | ---------------------------------- |
| **① LLM 判断 + 双时态保留**        | LLM 判断是否矛盾，矛盾则旧边标记 `invalid_at`/`expired_at`，保留历史 | **Graphiti/Zep**         | 保留完整变更历史，支持"某时刻事实是什么"的时态查询，可审计 | 依赖 LLM 判断准确度，每条新边都需要 LLM 调用（成本+延迟） |
| **② 直接覆盖（Last-Write-Wins）** | 新事实直接覆盖旧事实，不保留历史                                  | 传统知识图谱（如 Wikidata 手动编辑）  | 实现最简单，图始终保持最新状态                | **丢失历史**——无法回答"过去的事实是什么"，不可逆       |
| **③ 置信度评分**                 | 为每条事实计算 confidence score，冲突时保留高分的                 | **EvoKG**、部分学术系统         | 不依赖 LLM 做判断，可用学习函数自动评分         | 需要训练评分模型，冷启动困难，置信度的定义因场景而异         |
| **④ 版本链（Append-Only）**      | 所有事实都保留，不做矛盾判断，查询时按时间取最新                          | 部分事件溯源（Event Sourcing）架构 | 完全无损，写入最快                      | **查询复杂**——每次读取都需要遍历版本链找最新，图膨胀严重    |
| **⑤ 规则引擎**                  | 预定义冲突规则（如"一个人同一时间只能在一家公司工作"），自动判断矛盾               | 传统本体推理系统（OWL/SWRL）       | 不需要 LLM，确定性强，可解释               | 规则需要人工编写和维护，覆盖率有限，无法处理隐含矛盾         |
| **⑥ T-GRAG（2025）**          | 在 GraphRAG 中加入时间冲突检测层，检索时动态过滤过期/冲突事实              | T-GRAG（学术论文）             | 不修改写入流程，在检索侧解决                 | 存储不做清理，随时间膨胀；依赖检索时的冲突检测逻辑          |


**Graphiti 方案的核心取舍分析**：

```
成本轴：每条新边都需要 ≥1 次 LLM 调用（候选召回 + 矛盾判断）
  │
  │  Graphiti: ●──── 高（LLM 调用多，但判断准确）
  │  规则引擎: ──●── 低（无 LLM，但覆盖率有限）
  │  直接覆盖: ────● 最低（无任何判断逻辑）
  │
  ├──────────────────────────────────────→ 历史保留轴
     直接覆盖: ●    无历史
     Graphiti:  ──● 完整双时态历史
     Append-Only: ──────● 完整但未标记矛盾
```

> **Graphiti 的选择是"用 LLM 调用成本换取准确的矛盾判断 + 完整的时态历史"**。这在 Agent 记忆场景下是合理的——用户偏好、工作经历等事实会随时间变化，Agent 需要知道"现在的事实"和"过去的事实"。

> **如果我们自己要落地，可能的优化方向**：
>
> - 将 Stage 2 的 LLM 矛盾判断**降级为规则+嵌入双重判断**：先用规则引擎处理明显矛盾（同一关系类型 + 同一节点对 + 时间不重叠），只对规则无法判断的 case 调用 LLM
> - 批量处理：累积 N 条新边后一次性送 LLM 判断，而非逐条调用
> - 异步矛盾检测：写入时只做 Stage 1 快速去重，矛盾检测放到后台异步执行

最终写入图的 EntityEdge：

```
EntityEdge ①:
  source: "ent-zhangwei" → target: "ent-tencent"
  name: "WORKED_AT"
  fact: "张伟在腾讯工作了三年，主要负责微信支付的后端开发"
  valid_at:   2021-08-08T00:00:00Z
  invalid_at: 2024-08-08T00:00:00Z    ← 已结束
  created_at: 2024-08-15T14:00:05Z
  expired_at: null
  episodes: ["ep-100"]

EntityEdge ②:
  source: "ent-zhangwei" → target: "ent-meituan"
  name: "WORKS_AT"
  fact: "张伟于上周从腾讯跳槽至美团，担任后端开发工程师"
  valid_at:   2024-08-08T00:00:00Z
  invalid_at: null                     ← 仍然有效
  created_at: 2024-08-15T14:00:05Z
  expired_at: null
  episodes: ["ep-100"]

EntityEdge ③:
  source: "ent-zhangwei" → target: "ent-wechatpay"
  name: "WORKED_ON"
  fact: "张伟在腾讯期间主要负责微信支付项目"
  valid_at:   2021-08-08T00:00:00Z
  invalid_at: 2024-08-08T00:00:00Z
  created_at: 2024-08-15T14:00:05Z
  expired_at: null
  episodes: ["ep-100"]
```

#### Phase 4：Summary 生成 + 持久化

- 对所有新/更新的 EntityNode 批量调用 LLM 生成 `summary`（每批最多 30 个节点）
- 为 EntityNode.name 和 EntityEdge.fact 生成向量嵌入（`name_embedding` / `fact_embedding`）
- 调用 `add_nodes_and_edges_bulk()` 在**单个数据库事务**中持久化所有节点和边
- 可选：运行 Label Propagation 更新 Community 子图

---

### 三、属性设计原则与规则

每个属性的存在都有明确的设计理由，可归纳为**六大设计原则**：

#### 原则 1：身份唯一性（Identity）


| 属性     | 所在类           | 规则                                       |
| ------ | ------------- | ---------------------------------------- |
| `uuid` | 所有 Node/Edge  | `uuid4()` 自动生成，全局唯一主键，不可变                |
| `name` | EntityNode    | **规范化名称**，是去重的主要依据（精确匹配→模糊匹配→LLM 判断三级策略） |
| `name` | CommunityNode | LLM 自动生成的社区标题                            |
| `name` | EpisodicNode  | 情节标识符（人工指定）                              |


> **为什么 name 不是主键？** 因为实体名可能在消解过程中被合并修改，uuid 才是稳定标识。

#### 原则 2：多租户隔离（Multi-tenancy）


| 属性         | 所在类          | 规则                                                   |
| ---------- | ------------ | ---------------------------------------------------- |
| `group_id` | 所有 Node/Edge | **分区键**，所有查询、删除、社区检测都按 group_id 隔离。支持同一数据库内跑多个独立知识图谱 |


> **为什么每条边也要 group_id？** 因为图数据库的边查询需要独立过滤，不能只依赖节点的 group_id。

##### group_id 详解

**本质**：`group_id` 是一个字符串类型的逻辑分区键，打在**每一个节点和每一条边**上。同一 `group_id` 下的所有节点和边构成一个**逻辑上完全独立的知识图谱**。不同 `group_id` 之间的数据在写入、查询、去重、社区检测等所有操作中**互不可见**。

**底层实现因数据库而异**：


| 图数据库后端             | group_id 的隔离方式                                                                    |
| ------------------ | --------------------------------------------------------------------------------- |
| **Neo4j**          | 所有数据存在同一个数据库，`group_id` 作为节点/边的属性字段，所有查询语句中加 `WHERE n.group_id = $gid` 做过滤        |
| **FalkorDB**       | 每个 `group_id` 对应一个**独立的 Graph 数据库实例**，物理隔离（但目前有并发 bug，见 GitHub Issue #1325/#1331） |
| **Neptune / Kuzu** | 类似 Neo4j，属性级别过滤                                                                   |


**在 Zep 产品中的映射——三种记忆模式对应三种 group_id 策略**：

```
┌─────────────────────────────────────────────────────────────┐
│                      Zep 记忆系统                            │
├──────────────┬──────────────────┬───────────────────────────┤
│ User Threads │   User Graphs    │     Shared Graphs         │
│  (会话历史)   │  (用户个人图谱)   │   (组织级共享图谱)          │
├──────────────┼──────────────────┼───────────────────────────┤
│ group_id =   │ group_id =       │ group_id =                │
│ user_{uid}   │ user_{uid}       │ graph_{custom_graph_id}   │
│              │                  │                           │
│ 按 user_id   │ 按 user_id 隔离   │ 按 graph_id 隔离，多用户   │
│ 隔离，每人    │ 存储该用户的偏好、 │ 可共同读写同一个 graph_id  │
│ 独立的对话流  │ 事实、知识        │ 下的组织知识               │
└──────────────┴──────────────────┴───────────────────────────┘
```

具体来说：


| Zep 记忆模式          | API 调用示例                                                  | group_id 来源               | 隔离粒度                       |
| ----------------- | --------------------------------------------------------- | ------------------------- | -------------------------- |
| **User Threads**  | `thread.add_messages(user_id="u001", ...)`                | `user_id` → 自动转为 group_id | 每个用户一个独立的对话历史图             |
| **User Graphs**   | `graph.add(user_id="u001", data="喜欢Python", type="text")` | `user_id` → 自动转为 group_id | 每个用户一个独立的个人知识图谱            |
| **Shared Graphs** | `graph.add(graph_id="company_kb", data=..., type="text")` | `graph_id` → 作为 group_id  | 自定义命名的共享图谱，多个用户/Agent 共读共写 |


**检索时的 group_ids 组合**：

关键设计——搜索 API 支持传入**多个 group_id**，实现跨图谱的联合检索：

```python
# 同时搜索用户个人图谱 + 组织共享图谱
results = await graphiti.search(
    query="张伟的技术栈是什么？",
    group_ids=["user_u001", "company_kb"]  # 两个 group 联合搜索
)
```

这就是 Zep 文档中说的"三种模式在检索时并行搜索，合并结果后一起送给 Agent"的具体实现。Agent 的一次记忆检索可以同时查到：

- 该用户的私有对话历史（User Thread）
- 该用户的个人偏好和事实（User Graph）
- 组织级的共享知识（Shared Graph）

**group_id 影响的操作全景**：


| 操作                    | group_id 的作用                                  |
| --------------------- | --------------------------------------------- |
| `add_episode()`       | 写入时指定 group_id，所有抽取出的 Node/Edge 都打上该标签        |
| `search()`            | 传入 `group_ids` 列表，只在这些分区内搜索                   |
| `clear_data()`        | 按 group_id 批量删除，只清空指定分区                       |
| Node 去重               | 只在同一 group_id 内去重，不同分区允许同名实体独立存在              |
| Community 检测          | Label Propagation 按 group_id 独立运行，不同分区的社区互不影响 |
| `retrieve_episodes()` | 只拉取同一 group_id 内的历史情节作为上下文                    |


**一个关键设计选择**：group_id 是**逻辑分区**而非物理分区（Neo4j 后端下）。这意味着：

- **优点**：部署简单，一个数据库实例服务所有租户；跨 group 联合查询只需传多个 group_ids
- **缺点**：在 Neo4j 中，所有数据物理上在同一张图中，大规模场景下查询性能依赖索引质量；FalkorDB 虽然物理隔离但目前有并发安全问题

#### 原则 3：双时态溯源（Bitemporal Provenance）

这是 Graphiti 最核心的设计决策，体现在 EntityEdge 的**四个时间戳**上：


| 属性           | 时态维度                   | 语义           | 规则                                           |
| ------------ | ---------------------- | ------------ | -------------------------------------------- |
| `created_at` | 系统时间（Transaction Time） | 事实何时被系统录入    | 所有 Node/Edge 自动设置，不可修改                       |
| `expired_at` | 系统时间                   | 事实何时被系统标记为过时 | 当新事实与旧事实矛盾时由矛盾检测自动设置                         |
| `valid_at`   | 事件时间（Valid Time）       | 事实在现实中何时生效   | **由 LLM 从文本中推断**，锚定于 `reference_time` 解析相对时间 |
| `invalid_at` | 事件时间                   | 事实在现实中何时失效   | **由 LLM 从文本中推断**，如未明确终止则为 null               |


> **为什么需要两个维度？** 系统时间回答"我们什么时候知道的"，事件时间回答"现实中什么时候的事"。例如：系统在 3 月录入了一条"张伟 1 月加入美团"的事实——`created_at=3月`，`valid_at=1月`。

> **为什么 valid_at / invalid_at 在 EpisodicNode 上也有？** EpisodicNode 的 `valid_at` 标记的是**事件本身发生的时间**（对话发生时间），不是事实的有效期。这是"情节时间戳"，与边上的"事实有效期"语义不同。

#### 原则 4：语义可搜索（Semantic Searchability）


| 属性               | 所在类                       | 规则                                                                     |
| ---------------- | ------------------------- | ---------------------------------------------------------------------- |
| `name_embedding` | EntityNode, CommunityNode | 对 `name` 文本生成向量嵌入（如 OpenAI text-embedding-3-large, 1536 维）。支持按实体名的语义搜索 |
| `fact_embedding` | EntityEdge                | 对 `fact` 文本生成向量嵌入。支持按事实内容的语义搜索                                         |
| `summary`        | EntityNode, CommunityNode | LLM 生成的文本摘要，聚合所有关联边的 fact 信息。用于给 Agent 提供上下文                           |


> **为什么不只用 name 做精确搜索？** 用户可能用近义词或描述性短语检索，比如搜"社交支付"应该能找到"微信支付"。向量嵌入解决的就是这个问题。

> **为什么 summary 不存在 Edge 上？** Edge 的 `fact` 本身就是自然语言描述，已经是可读的；Node 需要 summary 是因为一个实体可能关联几十条边，需要聚合。

#### 原则 5：类型可扩展（Extensible Typing）


| 属性           | 所在类                    | 规则                                                                           |
| ------------ | ---------------------- | ---------------------------------------------------------------------------- |
| `labels`     | EntityNode             | **多标签体系**：一个实体可以同时是 `["Person", "Engineer", "Manager"]`。在 Neo4j 中存为多个 Label  |
| `attributes` | EntityNode, EntityEdge | **开放属性**：通过 Pydantic Schema 定义结构，由 LLM 自动填充。Schema 由调用方在 `add_episode()` 时传入 |
| `source`     | EpisodicNode           | 枚举 `message/json/text`，决定用哪个 Prompt 抽取                                       |


自定义类型示例：

```python
class Employee(BaseModel):
    department: str = Field(description="部门")
    level: str = Field(description="职级")

# 调用时传入
await graphiti.add_episode(
    ...,
    entity_types={"Employee": Employee}
)

# LLM 抽取后 EntityNode.attributes 可能为:
# {"department": "后端", "level": "P7"}
```

> **为什么 labels 是 list 而不是单个 string？** 现实中实体常有多重身份。"张伟"既是 Person 又是 Employee，用列表表示比单标签更灵活。

> **为什么 attributes 用 dict 而不是固定字段？** 不同业务场景需要的属性完全不同（电商要 SKU，医疗要诊断码），固定字段无法覆盖。开放 dict + Pydantic Schema 验证是最灵活的方案。

#### 原则 6：溯源可追踪（Traceability）


| 属性                   | 所在类          | 规则                                                  |
| -------------------- | ------------ | --------------------------------------------------- |
| `content`            | EpisodicNode | **保留完整原文**，是所有抽取的最终真相来源。任何时候都可以从 EntityEdge 追溯到原始对话 |
| `episodes`           | EntityEdge   | 提到该事实的所有 Episode UUID 列表。一条事实可能被多个对话提及，都记录在此        |
| `entity_edges`       | EpisodicNode | 从该情节中抽取出的 EntityEdge UUID。反向索引，方便从情节查找到所有事实         |
| `source_description` | EpisodicNode | 来源元数据（如 ticket ID、文件名等），补充 content 的上下文             |


> **溯源链路**：EntityEdge.episodes → EpisodicNode.content → 原始对话。任何一条事实都可以追溯到"谁在什么时候说的什么话"。

---

### 四、总结：属性分类速查表


| 设计原则      | 涉及属性                                                | 核心问题                 |
| --------- | --------------------------------------------------- | -------------------- |
| **身份唯一性** | uuid, name                                          | "这是谁/这是哪个？"          |
| **多租户隔离** | group_id                                            | "属于哪个用户/组织？"         |
| **双时态溯源** | created_at, expired_at, valid_at, invalid_at        | "什么时候知道的？现实中什么时候的事？" |
| **语义可搜索** | name_embedding, fact_embedding, summary             | "怎么用自然语言找到它？"        |
| **类型可扩展** | labels, attributes, source                          | "它是什么类型？有什么自定义属性？"   |
| **溯源可追踪** | content, episodes, entity_edges, source_description | "这个结论从哪来的？原文是什么？"    |


