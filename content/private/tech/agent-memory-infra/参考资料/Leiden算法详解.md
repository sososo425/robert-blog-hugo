---
title: "Leiden 算法详解"
date: 2026-03-24T16:30:00+08:00
draft: true
tags: ["algorithm", "community-detection", "graph-clustering", "leiden", "知识图谱"]
---

# Leiden 算法详解

## 一、基本原理

**Leiden 算法**是 Louvain 算法的改进版，由 [Traag, Waltman & van Eck (2019)](https://doi.org/10.1038/s41598-019-41695-z) 提出。它通过增加一个关键的**细化阶段（Refinement Phase）**来解决 Louvain 的核心缺陷。

### 三个核心阶段

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  1. Local Move  │ → │ 2. Refinement   │ → │ 3. Aggregation  │
│  (局部移动)      │    │  (细化优化)      │    │  (社区聚合)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
     顶点移动到能              在社区内部进行              将社区压缩为
     提升模块度的              二次优化，发现             超级节点，
     相邻社区                  子社区结构                递归迭代
```

### 与 Louvain 的关键差异

| 特性 | Louvain | Leiden |
|------|---------|--------|
| **社区连通性** | ❌ 可能产生不连通社区（高达16%） | ✅ **保证所有社区内部连通** |
| **局部最优** | 仅保证模块度提升 | 保证社区内部节点最优分配 |
| **速度** | 基准 | 比 Louvain 快 **20-150%** |
| **细化阶段** | 无 | 有关键的 refinement 阶段 |

---

## 二、用途与应用场景

### 1. 知识图谱聚类（最相关）

- Microsoft **GraphRAG** 使用 Leiden 对知识图谱进行社区感知聚类，生成社区摘要用于 RAG 问答
- 适合 **Semantic Memory** 中 **Community Node** 的自动生成

### 2. 单细胞基因组学

- Scanpy/Seurat 的默认聚类算法，处理数十万细胞的 RNA 测序数据

### 3. 社交网络分析

- 识别信息生态系统、极化群体、跨平台内容桥接节点

### 4. 其他领域

- 天文文献知识图谱实体消歧
- 动态图社区跟踪（实时演化分析）

---

## 三、在 Agent Memory 系统中的生态位

在 **Agent Memory Infrastructure** 中，Leiden 算法处于以下位置：

```
┌─────────────────────────────────────────────────────────────┐
│                    Semantic Memory Layer                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────────────────────────────┐ │
│  │  Phrase     │───→│         Leiden Algorithm            │ │
│  │  Nodes      │    │  - 输入：实体-实体关系图              │ │
│  │  (实体节点)  │    │  - 输出：Community 聚类结果          │ │
│  └─────────────┘    │  - 生成：Community Node Summary     │ │
│         ↑           └─────────────────────────────────────┘ │
│         │                          ↓                        │
│  ┌─────────────┐         ┌──────────────────┐               │
│  │   Block     │────────→│  Community Node  │               │
│  │  (内容块)    │         │   Summary        │               │
│  └─────────────┘         └──────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### 具体作用

- 将 `Phrase Node`（实体）根据边关系聚类成语义社区
- 每个社区生成一个 `Community Node Summary`（预计算的融合摘要）
- 支持层次化问答：简单问题走 Block，宏观问题走 Community

---

## 四、开源实现与引入方式

### 推荐方案：leidenalg (Python)

```bash
pip install leidenalg igraph
```

### 基础用法

```python
import leidenalg as la
import igraph as ig

# 1. 构建图（示例：从 Phrase Node 和 Edge 构建）
G = ig.Graph()
# 添加实体作为节点
G.add_vertices(["pandas", "read_csv", "encoding", "utf-8", "sep", "header"])
# 添加关系作为边
G.add_edges([
    ("pandas", "read_csv"),      # USED_WITH
    ("read_csv", "sep"),         # HAS_PARAM
    ("read_csv", "header"),      # HAS_PARAM
    ("encoding", "utf-8"),       # COMPATIBLE_WITH
])

# 2. 运行 Leiden 算法
partition = la.find_partition(
    G,
    la.ModularityVertexPartition,  # 或 la.CPMVertexPartition
    resolution_parameter=1.0        # 分辨率参数：越大社区越多
)

# 3. 获取社区划分
for i, community in enumerate(partition):
    print(f"Community {i}: {[G.vs[node]['name'] for node in community]}")
# 输出: Community 0: ['pandas', 'read_csv', 'sep', 'header']
#       Community 1: ['encoding', 'utf-8']
```

### 关键参数说明

| 参数 | 说明 | 建议值 |
|------|------|--------|
| `resolution_parameter` | 分辨率，控制社区粒度 | **1.0**（默认），增大则社区更细 |
| `quality_function` | 质量函数 | `ModularityVertexPartition` 或 `CPM` |
| `n_iterations` | 迭代次数 | 默认 -1（直到收敛），可设为正整数限制 |
| `weights` | 边权重 | 如果有关系强度，传入权重列表 |

### 其他可选实现

| 库 | 语言 | 特点 |
|----|------|------|
| [**igraph**](https://r.igraph.org/reference/cluster_leiden.html) | C/Python/R | 原生集成，更快但功能较少 |
| [**scanpy**](https://scanpy.readthedocs.io/) | Python | 单细胞分析专用，封装了 leidenalg |
| [**Networkit**](https://networkit.github.io/) | C++ | 十亿级边图的并行实现 |
| [**leidenAlg**](https://github.com/kharchenkolab/leidenAlg) | R | R 语言接口 |

---

## 五、引入系统的操作建议

### 步骤1：数据预处理

```python
# 从 Neo4j 读取 Phrase Node 和 Edge
query = """
MATCH (p1:Phrase)-[r:RELATION]->(p2:Phrase)
RETURN p1.name as source, p2.name as target, r.type as rel_type
"""
edges = neo4j.run(query)
```

### 步骤2：构建图并运行聚类

```python
import leidenalg as la
import igraph as ig

G = ig.Graph.TupleList(edges, directed=False)
partition = la.find_partition(G, la.ModularityVertexPartition)
```

### 步骤3：生成 Community Summary

```python
# 对每个社区，用 LLM 生成摘要
for comm_id, nodes in enumerate(partition):
    members = [G.vs[n]['name'] for n in nodes]
    # 查询这些节点关联的所有 Block 内容
    blocks = get_blocks_for_phrases(members)
    # 用 LLM 生成社区摘要
    summary = llm.generate_summary(blocks)
    # 存回 Neo4j 作为 Community Node Summary
    save_community_summary(comm_id, members, summary)
```

### 步骤4：定期重新聚类

- 社区发现是**批处理任务**，不需要实时运行
- 建议：每天/每周定时运行，或当新增 Block 超过阈值时触发

---

## 六、注意事项

1. **分辨率参数调优**：从 1.0 开始，根据社区大小调整（文档场景建议 0.5-2.0）
2. **权重设置**：如果 `Relation Edge` 有置信度分数，作为边权重传入
3. **增量更新**：对于动态图，关注 2024 年新出的 **Dynamic Leiden** 变体（[arXiv:2410.15451](https://arxiv.org/abs/2410.15451)），支持 3-6 倍加速的增量更新

---

## 七、相关资源

- [leidenalg 官方文档](https://leidenalg.readthedocs.io)
- [GitHub: vtraag/leidenalg](https://github.com/vtraag/leidenalg)
- [原始论文: From Louvain to Leiden](https://doi.org/10.1038/s41598-019-41695-z)
- [GraphRAG 使用 Leiden](https://www.microsoft.com/en-us/research/blog/graphrag-unlocking-llm-discovery/) - Microsoft Research

---

**整理来源**：Claude Code 问答会话
**整理时间**：2026-03-24
