#### EntityNode — 语义记忆的持久对象

跨会话可归一的稳定实体，如工具、库、概念、用户、组织。是语义记忆的基本单元。

```cypher
(:EntityNode {
  entity_id:        "ent_acmecorp_01JQXXXXXX",   // 统一 ID：{prefix}_{tenant}_{ulid}
  tenant_id:        "acmecorp",
  name:             "pandas",                      // 标准名称（归一化后）
  entity_type:      "TOOL",                        // TOOL / CONCEPT / RESOURCE / PERSON / ORG / ACTION
  aliases:          ["pd", "Pandas"],              // 已识别的别名列表
  summary:          "Python 数据处理库，用户频繁用于 CSV/Excel 读写",  // 自动更新的摘要
  usage_freq:       12,                            // 被引用次数（画像积累）
  profile_hints:    ["data_processing", "file_io"],// 用于检索个性化排序的标签
  first_seen_at:    datetime("2026-03-28T14:32:00Z"),
  last_seen_at:     datetime("2026-03-31T09:15:00Z"),
  source_block_ids: ["blk_acmecorp_01...", "blk_acmecorp_02..."],
  created_at:       datetime(),
  updated_at:       datetime()
})
```


==first_seen_at, last_seen_at== 这两个时间戳表示该**实体在系统观测历史中的时间边界**，具体含义：

| 字段              | 含义                | 计算方式                           | 用途                 |
| --------------- | ----------------- | ------------------------------ | ------------------ |
| `first_seen_at` | 该实体**首次被系统识别**的时间 | 从最早的关联 `RawBlock.timestamp` 提取 | 判断实体"历史长度"、用户接触史   |
| `last_seen_at`  | 该实体**最近一次出现**的时间  | 从最新的关联 `RawBlock.timestamp` 提取 | 判断"新鲜度"、活跃度、时间衰减计算 |

---

## 以 pandas 为例

```
first_seen_at: 2026-03-28T14:32:00Z  → 用户第一次聊到/用到 pandas
last_seen_at:  2026-03-31T09:15:00Z  → 最近一次会话中还提到了 pandas
```

**推断**：
- 用户「认识」pandas 至少 3 天
- 是一个**活跃使用**的工具（近期出现）
- 如果是 `last_seen_at` 是 3 个月前 → 可能是**历史技能**，需要更多引导

---

## 在记忆检索中的作用

### 1. **兴趣衰减计算**（Episodic → Semantic 固化时）

```python
def calculate_entity_relevance(entity, current_time):
    days_since_last = (current_time - entity.last_seen_at).days
    
    # 时间衰减因子：越久没出现，相关性越低
    time_decay = math.exp(-0.1 * days_since_last)
    
    # 结合使用频率
    score = entity.usage_freq * time_decay
    return score
```

### 2. **区分「历史知识」vs「当前关注」**

| 场景 | first_seen_at | last_seen_at | 记忆策略 |
|------|--------------|--------------|---------|
| 新手探索 | 最近 | 最近 | 提供基础教程 |
| 熟练工具 | 较久 | 最近 | 直接给高级用法 |
| 遗忘技能 | 较久 | 很久前 | 主动提示"您曾用过..." |

### 3. **与 `created_at/updated_at` 的区别**

```cypher
first_seen_at:  2026-03-28T14:32:00Z  ← 业务时间（用户什么时候提到）
last_seen_at:   2026-03-31T09:15:00Z  ← 业务时间
created_at:     2026-04-01T10:00:00Z  ← 系统时间（数据库写入）
updated_at:     2026-04-01T10:05:00Z  ← 系统时间（记录更新）
```

- `*_seen_at`：**业务语义时间**，从原始数据提取
- `*_at`：**系统运维时间**，数据库元数据

---

## Langflow 场景下的实际意义

当 Agent 检索记忆时：

```
用户问："帮我处理这个数据文件"

系统发现：
- pandas: last_seen_at = 2小时前, usage_freq = 15 → 高置信推荐
- polars: last_seen_at = 3个月前, usage_freq = 2  → 备选提及
```

这使得 Agent 能说出：
> "您常用 pandas 处理这类问题，要继续使用还是试试您之前了解过的 polars？"

