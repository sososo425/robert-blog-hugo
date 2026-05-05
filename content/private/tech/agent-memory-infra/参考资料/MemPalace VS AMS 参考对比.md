好的，核心源码都拿到了。现在我有了完整的理解。下面回答你的问题。

---

## MemPalace 具体干了什么？

一句话：

> **MemPalace 是一个"存一切、不抽取、靠结构组织 + 语义搜索找回"的对话记忆系统。**

它的核心哲学和你们的方案**截然不同**。

---

## 1. MemPalace 的核心设计理念

### 理念 1：Store Everything, Extract Nothing（存原文，不做抽取）

> "Other memory systems let AI decide what's worth remembering. MemPalace stores everything, then makes it findable."

它**不做** LLM-driven 实体/事件/关系抽取。对话原文直接存进 ChromaDB，靠向量搜索找回来。

这和你们方案的最大区别就在这里：
- **你们**：Session/Trace → Raw Block → LLM 抽取 → EntityNode + EventNode + 关系边 → Neo4j
- **MemPalace**：对话原文 → 直接存 ChromaDB → 语义搜索

### 理念 2：Structure as Retrieval（结构即检索）

它用了一套"记忆宫殿"隐喻来组织 metadata：

| 概念 | 含义 | 实际实现 |
|------|------|---------|
| **Wing（翼）** | 一个人 / 一个项目 | ChromaDB metadata `wing` 字段 |
| **Hall（走廊）** | 记忆类型 | `hall_facts`, `hall_events`, `hall_discoveries`, `hall_preferences`, `hall_advice` |
| **Room（房间）** | 具体主题 | `auth-migration`, `graphql-switch` 等 |
| **Closet（衣橱）** | 摘要索引 | 指向原文的 summary |
| **Drawer（抽屉）** | 原始内容 | ChromaDB 里存的原文 |
| **Tunnel（隧道）** | 跨 Wing 的同名 Room | 自动连接不同人/项目中的相同话题 |

本质上就是：**在 ChromaDB 的 metadata 上建了一套分面过滤体系**。

### 理念 3：4 层记忆栈（Memory Stack）

| 层 | 作用 | 大小 | 加载时机 |
|----|------|------|---------|
| L0 | 身份信息 | ~50 tokens | 永远加载 |
| L1 | 关键事实摘要 | ~120 tokens | 永远加载 |
| L2 | 按 Wing/Room 过滤 | 按需 | 话题出现时 |
| L3 | 全库语义搜索 | 按需 | 明确查询时 |

这**确实是一个更高层次的记忆组件抽象**——不是从图节点出发，而是从"AI 唤醒后需要什么上下文"出发。

---

## 2. 它的 Knowledge Graph 是什么水平？

看完源码后，老实说：**非常简单**。

```python
# 就是 SQLite 里存 (subject, predicate, object, valid_from, valid_to)
kg.add_triple("Kai", "works_on", "Orion", valid_from="2025-06-01")
kg.invalidate("Kai", "works_on", "Orion", ended="2026-03-01")
```

它自己也说了：
> "Like Zep's Graphiti, but SQLite instead of Neo4j."

实际看代码：
- 没有实体去重 / 归一化
- 没有 LLM 抽取（依赖外部手动添加或 seed）
- 没有事件节点
- 没有 provenance / source_block_id
- 没有 confidence
- 没有时序链（PRECEDES）
- 没有多跳推理 / PPR / Graph RAG
- 没有 Session/Trace 融合

就是一个**带时间窗的三元组表**。比你们的图模型简单很多个量级。

---

## 3. 它抽象的目标和原则是什么？

| 原则 | 说明 |
|------|------|
| **不做抽取** | 不信任 LLM 决定什么值得记忆，存原文 |
| **结构导航** | 用 Wing/Hall/Room 元数据组织，而非知识图谱 |
| **分层加载** | L0-L3 按需加载，控制 token 开销 |
| **本地免费** | ChromaDB + SQLite，不依赖云服务 |
| **让 AI 自己用** | 通过 MCP 19 个 tool 暴露给 AI agent |

它追求的是：**快速、简单、够用**。

---

## 4. 对你们方案的借鉴价值

### ✅ 值得借鉴的

#### 4.1 分层记忆栈（L0-L3）的思想

这是 MemPalace 最有价值的抽象。

你们现在的方案里，检索层是一个统一的混合检索：

```
向量通道 + 图谱通道 + 上下文过滤 → 综合打分
```

但从"给 Agent 提供上下文"的角度，分层策略确实更合理：

- **L0（身份/租户上下文）**：每次都加载，极小
- **L1（关键实体画像 + 高频 fact）**：你们已有 `EntityNode.summary` 和 `usage_freq`，可以生成
- **L2（当前会话/主题相关记忆）**：按 `session_id` 或 `SemanticCluster` 过滤
- **L3（全图深度搜索）**：PPR 多跳 + 向量 + Cypher

你们目前的设计文档里没有明确提出"检索分层"这个概念。**这可以作为检索层的设计增强。**

#### 4.2 Hall（记忆类型分类）的思想

MemPalace 把记忆分成 5 类走廊：

- `hall_facts` — 决策、确定的事
- `hall_events` — 会话、里程碑、调试
- `hall_discoveries` — 突破、新洞察
- `hall_preferences` — 习惯、偏好
- `hall_advice` — 建议、解法

你们虽然有 `event_type`（7 类）和 `entity_type`（6 类），但**没有在更高层次对"记忆本身的类型"做分类**。

这个分类可以对应到你们的 `SemanticCluster` 或者检索侧的 facet：
- 不需要改底层图模型
- 但可以在检索/输出层做一层记忆类型标注

#### 4.3 MCP Tool 接口设计

MemPalace 把 19 个 tool 暴露给 AI agent，agent 自己决定什么时候 search、什么时候 traverse。

你们的方案目前更偏"后端 pipeline"设计，**缺少对"检索层怎么暴露给 Agent 使用"的 API/Tool 定义**。可以参考这个思路，提前设计 Agent 调用记忆的 tool interface。

---

### ❌ 不建议借鉴的

#### 4.4 "不做抽取"的理念

MemPalace 的核心卖点是"存原文，不抽取"。但你们做的是 **Temporal KG**，核心价值恰恰在于：

- 从原始对话/trace 中**提炼出结构化知识**
- 实体归一
- 时序链
- 因果链
- 跨会话关系

如果不做抽取，你们的 EntityNode / EventNode / SemanticCluster 全没意义了。

#### 4.5 SQLite 三元组表代替图数据库

MemPalace 的 knowledge_graph.py 就是一个带时间窗的 SQLite 表，没有：
- 多跳路径查询
- 图算法
- PRECEDES 时序链
- 实体去重
- confidence

这对你们来说是倒退，不是简化。

#### 4.6 纯 ChromaDB 向量搜索作为主检索

MemPalace 靠向量搜索做 96.6% 的 recall，但那是在 LongMemEval 这种**单人对话回忆**场景。

你们的场景是：
- 多租户
- Session + Trace 交叉
- 需要路径查询（"pandas 和 read_excel 之间什么关系？"）
- 需要时间线重建
- 需要因果追溯

纯向量搜索做不到这些。

---

## 5. 总结对比

| 维度 | MemPalace | 你们的方案（AMS） |
|------|-----------|----------------|
| **核心哲学** | 存原文，不抽取 | LLM-driven 抽取，构建结构化知识 |
| **底层存储** | ChromaDB + SQLite | Neo4j + Milvus + 归档层 |
| **图模型** | SQLite 三元组表（极简） | EntityNode + EventNode + RawBlockRef + SemanticCluster + 时序边 |
| **记忆组织** | Wing/Hall/Room 元数据分面 | 图谱拓扑 + 向量索引 |
| **检索方式** | 向量搜索 + metadata 过滤 | 混合检索（向量 + 图遍历 + PPR） |
| **记忆分层** | L0-L3 四层栈 ✅ | 未明确分层 |
| **LLM 依赖** | 存储零 LLM；检索可选 rerank | 抽取强依赖 LLM |
| **抽象层次** | 更高（面向 Agent 使用体验） | 更深（面向知识建模和推理） |
| **适合场景** | 单人对话记忆回忆 | 多租户 Agent 运行时记忆 + 因果推理 |

---

## 6. 一句话结论

> **MemPalace 做的是"更高层的记忆使用体验"（分层加载、结构导航、MCP 暴露），你们做的是"更深层的记忆构建能力"（抽取、归一、时序、因果）。两者不冲突，甚至互补。**

最值得借鉴的 3 件事：

1. **检索分层（L0-L3）**：给你们的检索层加一层"按紧急度/粒度分层输出"的设计
2. **记忆类型分面（Hall）**：在 SemanticCluster 或检索输出上补充记忆类型标签
3. **Agent Tool Interface**：提前设计 Agent 调用记忆的 MCP/API 接口规范

不需要借鉴的：不做抽取、SQLite 替代 Neo4j、纯向量搜索。

如果你愿意，我下一步可以把这 3 个借鉴点整理成你们设计文档里的一个正式小节。