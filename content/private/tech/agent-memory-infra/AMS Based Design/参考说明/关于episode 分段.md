现在全貌清楚了。文档中关于 episode 的结论：

---

## 文档中怎么说的

文档第 626-628 行明确写了：

> **episode 子段（可选增强）**
> 在 session 内部，可进一步切分为更细粒度的 episode 子段，对应一次完整的"问题提出→过程→解决"闭环。`episode_id` 挂在 EventNode 字段上，不作为独立节点。**原型阶段可暂不实现**，优先保证 session 级别的稳定切分。

所以当前设计的结论是：
- **session 级切分** → 必须做（4.2 节有完整的切分算法）
- **episode 级切分** → 先不做，字段预留为 null
- **RawBlock 粒度** → 每个 turn/step 一个 block（Stage 1）

---

## 如果要做 episode 切分，怎么做？

本质上和 session 切分同类问题，但粒度更细：

```
Session（一次完整对话）
│
│  session 切分信号：时间间隔大、显式换话题
│
└── Episode（一个子任务闭环）
    │
    │  episode 切分信号：子任务完成、话题小转向
    │
    └── Turn（一轮对话）
```

常见方法：

| 方法 | 做法 | 优缺点 |
|------|------|--------|
| **滑动窗口 + embedding 相似度** | 每 N 轮计算前后窗口的 embedding 余弦距离，低于阈值则切分 | 简单有效，但阈值难调 |
| **LLM 判断** | 每轮问 LLM "当前话题是否发生了变化？" | 准确但成本高 |
| **意图标签变化** | 先给每轮打意图标签（问题/方案/确认/新问题），标签模式匹配切分 | 结构化好，依赖标签质量 |
| **回溯聚类** | 不实时切，事后对整个 session 的 turns 做聚类 | 最准确，但非实时 |

---

## 你提的关键问题：话题交叉怎么办？

```
Turn 1-8:   Episode 1（CSV 类型问题）
Turn 9:     "改成读 Excel 吧"          → Episode 2 开始
Turn 10-12: Episode 2（Excel 读写）
Turn 13:    "对了刚才那个 CSV 的 dtype，float64 还是 int？"  → 回到 Episode 1 的话题！
Turn 14:    Agent 回答 dtype 问题
Turn 15:    "好，继续 Excel 的事"       → 回到 Episode 2
```

这种**话题交织**是 episode 切分最难的地方。有三种处理策略：

### 策略 A：允许多标签（推荐）

一个 turn 可以属于多个 episode：

```json
// Turn 13 同时关联两个 episode
{
  "turn_index": 13,
  "episode_ids": ["ep_01_csv_dtype", "ep_02_excel"],  // 数组
  "primary_episode": "ep_01_csv_dtype"                 // 主归属
}
```

但这需要把 `episode_id` 从单值改成数组，增加复杂度。

### 策略 B：严格切段 + 跨段引用边

每个 turn 只属于一个 episode，但用图的边来表达关联：

```cypher
// Turn 13 归属 Episode 2（按时间顺序）
// 但加一条边表示它回溯引用了 Episode 1
(:Event {turn: 13, episode_id: "ep_02"})
  -[:REFERENCES_BACK {reason: "回溯 dtype 讨论"}]->
(:Event {turn: 3, episode_id: "ep_01"})
```

### 策略 C：不切 episode，靠 SemanticCluster 后聚合

这其实就是当前文档的设计思路：

```
Turn 级 RawBlock（不做 episode 切分）
       ↓
   事件抽取（EventNode）
       ↓
   SemanticCluster 异步聚类（自然按主题聚合）
```

SemanticCluster 天然解决了话题交织 —— Turn 3 和 Turn 13 会因为语义相似被聚到同一个 cluster，不需要靠 episode 硬切。

---

## 小结

| 方案 | 实时性 | 交织处理 | 复杂度 | 建议 |
|------|-------|---------|-------|------|
| Episode 切分 | 实时/准实时 | 难 | 高 | 暂不做 |
| SemanticCluster | 异步后处理 | 天然解决 | 中 | **当前方案，够用** |

文档的判断是合理的：**episode 字段预留，阶段一不实现，让 SemanticCluster 承担话题聚合的职责**。如果未来发现 SemanticCluster 的聚类粒度太粗（比如把不相关的 turn 聚到一起），再回头补 episode 切分。