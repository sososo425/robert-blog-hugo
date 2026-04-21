
>事件节点EventNode 的唯一性和归一化怎么考虑的？我理解，它不像实体节点。事件节点看起来是不用归一化的？因为一次事件发生是独一无二的，只需要事件要素：时间、参与者？类比现实世界中，事件包括：时间、地点、人物三要素。事件节点的目的也是为了情景记忆场景的回顾和检索。我的简单理解 “情景即事件”。

你的理解完全正确。让我把这个逻辑理清楚：
## EventNode vs EntityNode：本质区别

| 维度 | EntityNode | EventNode |
|---|---|---|
| **本质** | 概念/事物（what） | 一次发生（what happened） |
| **唯一性** | 同一个实体可能被多次提及，需要归一 | 每次发生都是独一无二的，天然唯一 |
| **归一化** | ✅ 必须（"pandas" = "Pandas" = "pd"） | ❌ 不需要 |
| **去重** | ✅ 必须（多个 Raw Block 提到同一实体） | ❌ 不需要（即使描述相似，也是不同次发生） |
| **类比** | 名词 — "张三"、"北京"、"pandas" | 动词/事件 — "张三去了北京"、"用户用pandas读csv报错" |

## "情景即事件" — 你的类比很准确

现实世界的事件三要素和 EventNode 的对应：

| 现实世界 | Agent 世界 | EventNode 中的体现 |
|---|---|---|
| **时间** | 什么时候发生的 | `timestamp`、`valid_at` |
| **地点** | 在哪个会话/哪个执行步骤 | `session_id`、`source_type` |
| **人物** | 谁参与了 | 通过 `PARTICIPATES_IN` 边连接到 EntityNode |

所以 EventNode 的设计逻辑是：

- **自身不归一** — 每个事件实例就是一个独立节点，靠 `block_id` + `timestamp` 天然唯一
- **通过参与者连接到语义网络** — EntityNode 是粘合剂，同一个 `pandas` 参与了多个事件，把这些事件串起来
- **通过因果边连接到其他事件** — `REQUEST_LEADS_TO`、`EVIDENCES` 等边构建事件链

## 这正好对应两种记忆的分工

```
EventNode（不归一，保留每次发生的独特性）
    → 情景记忆的基础：回顾"那次发生了什么"
    → 支持时间线重建、因果追溯

EntityNode（必须归一，聚合跨会话的同一概念）
    → 语义记忆的基础：知道"用户用过什么"
    → 支持实体查询、路径查询、语义联想
```

所以 Stage 3 的"实体去重与链接"严格来说只作用于 **EntityNode**。EventNode 在 Stage 2 抽取后直接进入 Stage 4 写入图谱，不需要经过去重流程。当前流程图里 Stage 3 的描述没有把这个区分体现出来，可以明确标注：**Stage 3 只处理 EntityNode，EventNode 直通 Stage 4**。

如果要在方案文档中补充的话，可以加一段：

> **EventNode 唯一性说明**：EventNode 表示一次具体发生的事件，天然唯一，不需要归一化或去重。其唯一性由 `block_id + timestamp + session_id` 组合保证。EventNode 的价值不在于自身的语义归并，而在于通过参与者边（`PARTICIPATES_IN`）连接到归一化后的 EntityNode，以及通过因果边（`REQUEST_LEADS_TO`、`EVIDENCES`）连接到其他 EventNode，从而构建可回溯的情景记忆网络。