
---

## AMS 设计方案深度评审报告

---

## 执行摘要

AMS 方案在战略方向上是正确的，且与 2024-2026 年 Agent Memory 方向的最前沿研究（Zep/Graphiti arXiv:2501.13956、EverMemOS arXiv:2601.02163、MemMachine arXiv:2604.04853）高度吻合。核心判断：

**EventNode 抽取对 AMS 的 P0 目标是必要的，不是可选的。** 但 RawBlock 存储与 EventNode 抽取不是替代关系，而是互补的双层，必须同时存在。

---

## 一、EventNode 抽取是否必然？完整答案

### 三种方案的本质差异

**方案 A（纯原文存储）** 是 MemMachine（2025 年 SOTA）的路线。优点是零提取误差，召回内容忠实原文；缺点是完全无法支持 AMS 的类型 2（路径查询）、类型 3（时间线重建）、类型 4（因果追溯）。MemMachine 在 LoCoMo 上得分 0.9169，但它根本没有图结构。

**方案 B（边 KV 属性）** 是 LightRAG 和 Mem0 的路线。把多次交互压缩进边的 description。丢失时序、细节、状态、溯源。Mem0 捕获的是用户说了什么、偏好什么——**但不捕获 agent 决策的时序因果、过程模式，也不捕获哪些行动序列产生了最佳结果**。

**方案 C（EventNode + RawBlockRef）** 是 AMS 的路线，也是 Zep/Graphiti 和 EverMemOS 的路线。事件的三个关键属性——时序关系、独立可检索性、跨来源桥接锚点——只有方案 C 能满足。

**结论：对于 AMS 既定的六类查询目标，EventNode 不是可选的，是必要条件。** 但对于只需要类型 1/6 的场景，可以考虑 lazy extraction——先存 RawBlock，第一次实体查询时才触发。

---

## 二、业界系统深度对比

### Zep/Graphiti 对比

Zep 通过其核心组件 Graphiti——一个时序感知的知识图谱引擎——动态合成非结构化对话数据和结构化业务数据，同时维护历史关系。在 DMR benchmark 上，Zep 以 94.8% vs 93.4% 超越 MemGPT。

AMS 相对 Zep 的核心差异：**AMS 是目前唯一同时建模 Session 和 Trace 两条输入链路的系统。** Graphiti 只处理对话 Session，完全没有 Trace 执行链路的建模。

### EverMemOS 对比

EverMemOS 实现了一个 engram 启发的记忆生命周期：情景痕迹形成（Episodic Trace Formation）将对话流转换为 MemCell，捕获情景痕迹、原子事实和时效预测信号；语义巩固（Semantic Consolidation）将 MemCell 组织成主题 MemScene；重构性回忆（Reconstructive Recollection）执行 MemScene 引导的 agentic 检索，组合必要且充分的上下文用于下游推理。

EverMemOS 的 MemCell ≈ AMS 的 EventNode + RawBlockRef；MemScene ≈ AMS 的 SemanticCluster；Foresight ≈ AMS 的 validity_reasoning/invalid_at。两个系统在理论框架上高度一致，EverMemOS 多了 Reconstructive Recollection（sufficiency loop），AMS 把这列为 P3。

### MemMachine 的重要启示

MemMachine 的核心设计权衡：STM summary 加上按需检索的原始 episode 提供了不同的取舍——summary 提供高层上下文，而检索到的 episodes 提供未压缩的事实依据。这对于需要可审计性、合规性或需要对精确对话记录进行多跳推理的场景尤其重要。

**对 AMS 的核心启示：RawBlockRef 层要设计得足够健壮，支持在 EventNode 质量不佳时的回退。考虑在 sentence 级别也建立 embedding 索引作为补充。**

---

## 三、理论基础评估

AMS 的设计框架有三个坚实的理论支柱：

**互补学习系统（CLS）理论**：McClelland et al.（1995）的 CLS 理论——海马体（快速、事件特定）和新皮层（慢速、统计性）——直接对应 AMS 的 EventNode（快速编码）和 SemanticCluster（慢速固化）。Stage 6 聚类模拟了海马体向新皮层的记忆巩固过程。

**HippoRAG 海马体索引理论**：GraphRAG 系统用结构化图谱显式编码关系，但仍然缺乏丰富的关系类型，在直接从文本构建图谱时也如此。 AMS 通过 EventNode 的独立节点化突破了这一限制——事件不再是边属性，而是图中的一等公民，支持 PPR 在事件层的传播。

**EverMemOS 的 engram 生命周期**：EverMemOS 将记忆重新定义为一个生命周期，而不是孤立的记录集合。它将碎片化的经历固化为稳定的抽象表征，并按照必要性和充分性原则组合上下文。 AMS 的设计在概念上与此完全对应。

---

## 四、超出首轮 Review 的额外发现

**1. Session-Trace 桥接边是最有价值但最脆弱的设计**

时间相差 <30 秒 + 实体 overlap 的启发式规则在异步 tool call、流水线式多步 Trace、间接实体引用场景下会静默失效。**根本解决方案是在 Agent 框架层注入 correlation_id**，而不是在 AMS 层做事后推断。

**2. Trace block 应该走规则化抽取，不走 GLiNER**

`tool=python_executor; action=read_excel; input={...}; status=success` 这类半结构化日志，tool_name/input_args/status 字段直接有规则可映射，不需要 NER 模型。只有规则化之后，Layer3 LLM 才介入做事件摘要和 Foresight 推理。

**3. SemanticCluster embedding 会漂移**

Cluster 加入新成员后，cluster.embedding 不会自动更新，会导致检索入口和实际内容越来越偏离。需要定义 embedding refresh 策略（均值更新 vs 重新用新 summary 生成），文档目前缺失。

**4. PPR 多租户隔离问题**

Neo4j GDS 的 PPR 是内存计算，不支持在 graph projection 内部按 tenant_id 隔离。多租户场景下，PPR 应改为：向量检索召回候选子图后，在候选节点上做 2-3 跳有限 BFS，而不是全图 PPR。

**5. PARTICIPATES_IN role 推断规则缺失**

EventNode.participants 是 list[str]，但 PARTICIPATES_IN 边需要 role 字段（tool/subject/object）。Layer3 的输出 schema 没有 role 信息，写入层也没有说明如何推断。这个映射规则必须在编码前明确。

**6. Schema migration 完全缺失**

实体/事件类型 schema 演进（比如新增 EXECUTOR 类型，从 TOOL 中分拆）需要对历史数据做批量 relabeling。这是图数据库工程的经典难题，文档没有任何方案。建议确立 append-only 原则：新类型追加，旧类型标记 deprecated 而非删除。

---

## 五、综合结论

记忆架构经常只得到一个下午的设计时间。将记忆视为值得专门设计、测试和优化的核心系统组件——可能是 agent 构建者能做的最高杠杆的单一干预。

AMS 恰恰做到了这一点：**把记忆基础设施视为一等公民来认真设计。**

**AMS 的最大差异化价值**：同时建模 Session（用户说了什么）和 Trace（Agent 做了什么），并通过跨来源语义桥接边将两者联系到统一时序知识图谱——**这在所有已知的开源项目和论文系统中几乎没有先例**。

**必须在编码前补全的短板**：写入幂等性（EventNode MERGE）、PRECEDES 边前向指针、merge_results 冲突策略、Trace 规则化抽取、Session-Trace 桥接的 correlation_id 机制。

综合判断：**方向正确，理论扎实，工程细节需要补强。在完成上述修复后，AMS 有能力达到 Agent Memory 领域的 state-of-the-art 水平。**