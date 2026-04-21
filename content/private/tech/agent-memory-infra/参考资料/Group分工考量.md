
先做难度评级，再给配置建议。

---

## 各 Group 难度评级

### Group 1：ETL Pipeline — ⭐⭐⭐ 中等

**为什么不是最难：**
- Kafka + Ray + 文档解析都是成熟技术，有大量开源方案
- 任务边界清晰：进来原始数据，出去标准 Raw Block
- 工作量大，但"未知数"少

**但有一个隐性风险：**
> Raw Block 的质量决定了所有下游的天花板。Group 1 出的是地基，地基歪了，Group 2/3 再努力也白费。

所以 Group 1 的 lead 必须有工程质量意识，不能只求跑通。

---

### Group 2：Tree 构建 — ⭐⭐⭐⭐ 中等偏上

**难点在哪：**
- 自动分层算法（语义聚类 vs 标题层级）需要实验迭代，没有标准答案
- 代码的 Tree（AST-based）和文档的 Tree（标题层级）逻辑完全不同，需要 parser 插件化设计
- **Triple 抽取是 Group 2 对 Group 3 的关键输出**，质量差会直接拖累 Graph 构建
- 增量更新机制设计是个系统问题，改一个 Block 要局部重建子树

**但边界相对清晰**，有较多学术先例（HiRAG、RAPTOR 等）。

---

### Group 3：Graph + 存储 — ⭐⭐⭐⭐⭐ 最难

**为什么最难：**

| 难点 | 说明 |
|------|------|
| 实体链接 & 消歧 | "Python" 在文档里和代码里是同一节点吗？跨来源的实体对齐是 open problem |
| Temporal KG 设计 | 时间戳、有效期、事实衰减，工程上没有成熟方案 |
| 遗忘机制 | temporal decay 参数、失效策略，需要大量实验 |
| 多存储一致性 | Neo4j + Milvus + LanceDB 三库 ID 映射，写入原子性，容易出幺蛾子 |
| 社区发现调参 | Louvain/Leiden 的分辨率参数直接影响 Graph 检索质量 |

**未知数最多、返工风险最高**，风险表里 Neo4j 性能瓶颈也明确点出了这里。

---

### Group 4：检索服务 — ⭐⭐⭐⭐ 较难

**难点在哪：**
- 需要深度理解所有上游模块（Tree 结构、Graph PPR、向量空间），是集成难度最高的组
- Agentic 多轮检索的策略设计没有标准答案
- 评估体系（Eval Dataset 构建 + 指标体系）需要 research 思维
- **这是对外的脸面**，Agent Framework 看到的就是这层 API 的表现

---

## 难度回顾（已建立）

```
Group 3 > Group 4 > Group 2 > Group 1
```

---

## 9人配置方案（4P7 + 4P6 + 1P5）

```
Tech Lead（P7，兼 Group 3）
├── Group 1: ETL Pipeline        P6 + P5
├── Group 2: Tree 构建            P7 + P6
├── Group 3: Graph + 存储         P7 + P6  ← TL 也在此
└── Group 4: 检索服务              P7 + P6
```

验算：TL(P7) + Group内 3×P7 = **4 P7** ✅ | 4×P6 = **4 P6** ✅ | 1×P5 = **1 P5** ✅

---

## 各组配置理由

### Group 1：P6 + P5
ETL 是执行工程为主，技术栈成熟（Kafka/Ray/PyMuPDF），P6 能 hold 住方向，P5 做 parser 实现和数据清洗。

唯一要注意：**P6 的质量意识要强**，Raw Block 质量是全链路天花板。

### Group 2：P7 + P6
算法有边界、有先例，但 Triple 抽取的接口设计直接影响 Group 3 的上游质量。P7 负责把控 Tree Schema 设计和跨组接口，P6 做分层算法和摘要流水线。

### Group 3：P7 + P6（+ TL 兼任）
最难、风险最高，**TL 兼任这里是核心理由**：
- 实体消歧、Temporal KG、遗忘机制——未知数最多，需要快速拍板
- 存储 SDK 是全组依赖，TL 在此确保接口设计质量
- 出问题时 TL 第一时间介入，不需要跨层汇报

Group 3 的 P7 应该是团队里**最能扛模糊性**的人。

### Group 4：P7 + P6
检索服务是对外的脸面，P7 负责整体检索架构（PPR、RRF、Agentic 策略）和 Agent Framework 联调，P6 做具体检索路径实现和评估体系。

---

## TL 为什么兼 Group 3 而不是 Group 4？

| | TL 兼 Group 3 | TL 兼 Group 4 |
|--|--|--|
| 风险覆盖 | ✅ 覆盖最高风险区 | ❌ 高风险区无人兜底 |
| 接口把控 | ✅ 存储 SDK 是全组依赖 | ⚠️ 存储接口设计分散 |
| 对外协调 | ⚠️ Group 4 的 P7 需要独立承担联调 | ✅ TL 直接对接 Agent Framework |
| 适合场景 | 技术风险优先 | 交付进度优先 |

**技术风险是当前主要矛盾，选兼 Group 3。**

如果到 Phase 3（联调阶段）外部协调压力变大，TL 可以适当把精力向 Group 4 倾斜，此时 Group 3 的 P7 已经能 hold 住局面了。

---

## 一个额外建议

**早期让 Group 2 的 P7 和 Group 3 的 TL 定期对齐 Triple 格式**——这个接口现在文档里只写了 `(subject, relation, object, metadata)`，但细节（实体粒度、关系类型集合、置信度阈值）不对齐的话，Group 3 在 Phase 2 做实体链接时会大面积返工。


---

## 一个需要特别注意的点

**Group 2 的 Triple 抽取质量，是 Group 3 的上游瓶颈。**

这个接口目前在分工上是 Group 2 生产、Group 3 消费，但两组对"什么是好的 Triple"的标准可能不一致。

建议早期（Phase 1 结束前）让 Group 2 的 P7 和 Group 3 的 TL **专门坐下来对齐 Triple 格式和质量标准**，否则 Group 3 在 Phase 2 做实体链接时会发现输入一塌糊涂，被动返工。