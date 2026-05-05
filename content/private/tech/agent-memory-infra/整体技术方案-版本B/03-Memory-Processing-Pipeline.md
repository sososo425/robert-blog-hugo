---
title: "03-Memory-Processing-Pipeline 详细设计"
date: 2026-03-23T18:00:00+08:00
draft: true
tags: ["agent-memory", "pipeline", "kafka", "详细设计", "版本B"]
---

# Memory Processing Pipeline 详细设计

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **定位**: 连接原始执行数据与结构化记忆的**异步处理管道**

---

## 1. 模块定位与职责

### 1.1 在系统中的位置

Memory Processing Pipeline（简称 MPP）是一个**独立的异步处理服务**，负责将 Agent-TES 采集到的原始执行证据（Evidence）加工成可供 AMS 检索的结构化记忆。

```
Agent Framework ──→ Kafka: agent.episodes.raw ──→ MPP ──→ AMS
                                                         (写入 Episode/Block/实体)
Agent-TES       ──→ Kafka: agent.evidence.raw  ──→ MPP
```

**MPP 的核心价值**：将"原始、非结构化的执行流"转化为"有语义、可检索的记忆"。这个转化包括：
- 对内容做切片（Chunking）
- 提取实体和关系（NER）
- 生成向量表示（Embedding）
- 评估重要性（LLM 打分）
- 检测知识社区（Leiden 聚类）
- 生成摘要（Section/Community Summary）

**上游来源**（从 Kafka 消费）：
- `agent.episodes.raw`：来自 Agent Framework，任务完成后的完整执行轨迹
- `agent.evidence.raw`：来自 Agent-TES，细粒度的实时证据流
- `agent.docs.ingest`：来自业务系统，需要入库的业务文档

**下游写入**（调用 AMS）：
- `POST /api/v1/memory/episodes`：写入处理后的 Episode
- `POST /api/v1/memory/knowledge`：写入 Block、实体、摘要

### 1.2 为什么独立部署？

- **解耦**：处理速度不影响 Agent 执行
- **弹性**：处理负载高时独立扩容，不影响 AMS 的 API 响应
- **可重放**：Kafka offset 支持重跑历史数据（如模型升级后重新嵌入）

---

## 2. 整体处理流程

### 2.1 流程概览

```
Kafka Consumer
      │
      ├─ topic: agent.episodes.raw
      │         ↓
      │   ClassificationRouter
      │         ↓
      │   EpisodePipeline ─────────────────────────────┐
      │         │                                       │
      │         ├─ 重要性评分（LLM）                    │
      │         ├─ 关键词/Tag提取                       │
      │         ├─ 触发整合条件检查                     ├──→ POST /memory/episodes
      │         └─ 写入 AMS                             │
      │                                                 │
      ├─ topic: agent.docs.ingest                       │
      │         ↓                                       │
      │   KnowledgeIngestionPipeline ──────────────────┤
      │         │                                       │
      │         ├─ 文档切片（Chunking）                 │
      │         ├─ Embedding 生成                       │
      │         ├─ NER 实体提取                         ├──→ POST /memory/knowledge
      │         ├─ 关系抽取                             │
      │         ├─ 写入 Block + 实体                    │
      │         └─ 触发社区检测（批量）                  │
      │                                                 │
      └─ topic: agent.evidence.raw                      │
                ↓                                       │
          FeedbackAggregator ────────────────────────── ┘
                │
                ├─ 更新技能成功率（调用 AMS skill metrics API）
                └─ 积累RL训练数据
```

### 2.2 Kafka Topic 规范

| Topic | 生产方 | 消费方 | 消息格式 | 保留时间 |
|-------|--------|--------|---------|---------|
| `agent.episodes.raw` | Agent Framework | MPP | JSON | 7天 |
| `agent.evidence.raw` | Agent-TES | MPP | JSON | 3天 |
| `agent.docs.ingest` | 业务系统 | MPP | JSON | 7天 |
| `agent.consolidation.trigger` | AMS ConsolidationEngine | MPP | JSON | 1天 |

---

## 3. EpisodePipeline — Episode 处理

### 3.1 输入消息格式

```json
// topic: agent.episodes.raw
{
  "agent_id":    "agent_001",
  "session_id":  "sess_abc123",
  "event_time":  "2026-03-23T10:05:00Z",
  "task_summary": "帮用户修复 sales.csv 的乱码问题",
  "messages":    [...],          // 完整消息历史
  "tool_history": [
    {"tool": "read_file", "input": {"path": "sales.csv"}, "output": {...}, "success": true},
    {"tool": "chardet.detect", "input": {...}, "output": {"encoding": "gbk"}, "success": true}
  ],
  "outcome":      "success",
  "final_answer": "已用 encoding='gbk' 修复，数据行数验证通过"
}
```

### 3.2 处理步骤

```python
class EpisodePipeline:
    async def process(self, raw_message: dict) -> None:
        """
        处理一条原始 Episode 消息，转化为结构化 Episode 写入 AMS
        """

        # Step 1: 生成 Episode 内容摘要
        content = self._build_episode_content(raw_message)
        # content 包含：任务摘要 + 关键工具调用 + 最终结果
        # 过长时做LLM压缩，保留关键步骤

        # Step 2: 重要性评分（LLM 评估）
        importance = await self._score_importance(content, raw_message["outcome"])
        # 评分标准：
        #   - 成功且创新（首次遇到这类问题）：8-10
        #   - 成功且常见：5-7
        #   - 失败但有明确原因：6-8（失败经验价值高）
        #   - 失败且原因不明：3-5

        # Step 3: 标签提取
        tags = await self._extract_tags(content)
        # 使用轻量 LLM 提取 3-8 个关键词

        # Step 4: Embedding 生成
        title = self._generate_title(raw_message)
        embedding = await self.embedding_svc.embed(f"{title}\n{content[:500]}")

        # Step 5: 写入 AMS
        episode = {
            "agent_id":    raw_message["agent_id"],
            "session_id":  raw_message["session_id"],
            "event_time":  raw_message["event_time"],
            "title":       title,
            "content":     content,
            "importance":  importance,
            "tags":        tags,
            "outcome":     raw_message["outcome"],
            "embedding":   embedding,  # AMS 内部也会存到 Milvus
            "visibility":  "private"
        }
        await self.ams_client.post("/api/v1/memory/episodes", json=episode)

        # Step 6: 触发整合条件检查（由 AMS 内部处理，MPP 无需关心）
        # AMS 写入 Episode 后会自动检查 importance >= 8 的触发条件

    def _build_episode_content(self, raw: dict) -> str:
        """从原始消息构建 Episode 正文（结构化文本）"""
        parts = [
            f"任务：{raw['task_summary']}",
            f"结果：{raw['outcome']}（{raw.get('final_answer', '')}）",
            "工具调用过程："
        ]
        for tool in raw.get("tool_history", [])[:10]:  # 最多记录10步
            status = "✓" if tool["success"] else "✗"
            parts.append(f"  {status} {tool['tool']}({json.dumps(tool['input'], ensure_ascii=False)[:100]})")
            if not tool["success"]:
                parts.append(f"    错误：{tool.get('error', '未知')}")
        return "\n".join(parts)

    async def _score_importance(self, content: str, outcome: str) -> float:
        """调用 LLM 为 Episode 打重要性分数（1-10）"""
        prompt = f"""
请为以下 Agent 任务执行记录打一个重要性分数（1-10分）。

评分标准：
- 10分：极其重要，包含全新的解决方案或深刻教训
- 7-9分：重要，成功解决了有一定难度的问题，或失败案例有明确原因
- 4-6分：一般，解决了常见问题，无新意
- 1-3分：价值低，简单操作，无值得学习之处

任务结果：{outcome}
执行记录：
{content[:800]}

请只返回一个数字（1.0-10.0）。
"""
        response = await self.llm.ainvoke(prompt)
        try:
            return float(response.content.strip())
        except ValueError:
            return 5.0  # 解析失败时默认中等重要性
```

---

## 4. KnowledgeIngestionPipeline — 知识文档入库

### 4.1 适用场景

当业务系统需要将结构化文档（产品手册、技术文档、FAQ 等）写入 Semantic Memory 时，通过此管道处理。

```json
// topic: agent.docs.ingest
{
  "doc_id":    "doc_pandas_guide",
  "title":     "Pandas 用户指南",
  "content":   "完整的文档正文...",
  "source_url":"https://pandas.pydata.org/docs/",
  "agent_id":  null,             // null 表示公共知识库
  "metadata":  {"lang": "zh", "domain": "data_analysis"}
}
```

### 4.2 处理步骤

```python
class KnowledgeIngestionPipeline:
    async def process(self, doc: dict) -> None:
        """
        将一篇文档处理成 Block + Phrase Node + 触发社区检测
        """

        # Step 1: 文档切片（Chunking）
        # 策略：优先按段落/标题切分，不足时按 512 token 滑动窗口
        chunks = self.chunker.chunk(
            text=doc["content"],
            strategy="paragraph_aware",
            max_tokens=512,
            overlap=64
        )
        # 示例：一篇 5000 字文档 → 约 12 个 chunks

        # Step 2: 并行处理每个 chunk
        async def process_chunk(chunk: str, idx: int) -> str:
            """处理单个 chunk，返回 block_id"""
            embedding = await self.embedding_svc.embed(chunk)
            block = {
                "type":       "block",
                "agent_id":   doc.get("agent_id"),
                "content":    chunk,
                "source_url": doc.get("source_url"),
                "metadata": {
                    "doc_id":      doc["doc_id"],
                    "chunk_index": idx,
                    "doc_title":   doc["title"]
                }
            }
            resp = await self.ams_client.post("/api/v1/memory/knowledge", json=block)
            return resp["data"]["block_id"]

        block_ids = await asyncio.gather(*[
            process_chunk(c, i) for i, c in enumerate(chunks)
        ])

        # Step 3: NER 实体提取（两遍策略）
        all_entities = []
        for chunk in chunks:
            # 第一遍：spaCy 快速提取（<10ms/chunk）
            entities_fast = self.spacy_ner.extract(chunk)
            # 第二遍：LLM 精准提取（仅对高价值 chunk 做，如含关键概念的段落）
            if self._is_high_value_chunk(chunk):
                entities_precise = await self.llm_ner.extract(chunk)
                entities_fast = self._merge_entities(entities_fast, entities_precise)
            all_entities.extend(entities_fast)

        # Step 4: 关系抽取（Entity-Entity 关系）
        relations = await self.relation_extractor.extract(all_entities, chunks)
        # 示例关系：pandas --USED_WITH--> read_csv
        #           read_csv --HAS_PARAM--> encoding

        # Step 5: 写入实体和关系到 AMS（AMS 内部写 Neo4j）
        entities_payload = {
            "type":      "entities",
            "entities":  [e.to_dict() for e in all_entities],
            "relations": [r.to_dict() for r in relations],
            "source_block_ids": block_ids
        }
        await self.ams_client.post("/api/v1/memory/knowledge", json=entities_payload)

        # Step 6: 生成 Section Summary（每 3-5 个相邻 chunk 合并一个摘要）
        section_chunks = self._group_chunks(chunks, group_size=4)
        for section in section_chunks:
            summary = await self._generate_section_summary(section)
            summary_payload = {
                "type":        "section_summary",
                "content":     summary,
                "source_ids":  [block_ids[i] for i in section["block_indices"]],
                "metadata":    {"doc_id": doc["doc_id"]}
            }
            await self.ams_client.post("/api/v1/memory/knowledge", json=summary_payload)

        # Step 7: 触发社区检测（不立即执行，发到触发器）
        # 每积累 500 个新实体时，或每日定时触发
        await self._maybe_trigger_community_detection(doc["agent_id"])
```

### 4.3 社区检测与 Community Summary 生成

**触发条件**：
- 每新增 500 个 Phrase Node（周期计数）
- 每日 03:00 定时全量检测

```python
async def run_community_detection(self, agent_id: str | None = None):
    """
    对知识图谱中的 Phrase Node 运行 Leiden 算法，
    检测出语义社区，然后为每个新社区生成摘要。
    """
    # Step 1: 从 Neo4j 获取实体图（节点 + 边）
    graph_data = await self.neo4j.get_entity_graph(agent_id=agent_id)
    # 返回：nodes（list of PhraseNode）, edges（list of RELATED_TO）

    # Step 2: 构建 networkx 图，运行 Leiden 算法
    import networkx as nx
    from cdlib import algorithms
    G = nx.Graph()
    for node in graph_data["nodes"]:
        G.add_node(node["node_id"], phrase=node["phrase"])
    for edge in graph_data["edges"]:
        G.add_edge(edge["source"], edge["target"], weight=edge["weight"])

    # 运行 Leiden 算法（相比 Louvain 更稳定）
    communities = algorithms.leiden(G)

    # Step 3: 对每个新检测到的社区，生成 Community Summary
    for community in communities.communities:
        community_id = f"cn_{hash(frozenset(community))}"

        # 查找该社区是否已存在（避免重复生成）
        if await self.ams_client.get(f"/api/v1/memory/communities/{community_id}"):
            continue

        # 获取社区内所有实体关联的 Block 内容
        member_phrases = [G.nodes[n]["phrase"] for n in community]
        related_blocks = await self.ams_client.get_blocks_by_entities(member_phrases)

        # LLM 生成社区摘要
        prompt = f"""
以下是一组语义相关的概念/实体，以及它们出现过的文本片段。
请生成一段综合摘要（200字以内），描述这组概念的整体含义和相互关系。

概念列表：{', '.join(member_phrases)}

相关文本片段：
{chr(10).join([b['content'][:300] for b in related_blocks[:5]])}
"""
        summary = await self.llm.ainvoke(prompt)

        # 写入 Community Summary 到 AMS
        community_payload = {
            "type":        "community_summary",
            "community_id": community_id,
            "content":     summary.content,
            "member_phrases": member_phrases,
            "agent_id":    agent_id,
            "metadata":    {"member_count": len(community)}
        }
        await self.ams_client.post("/api/v1/memory/knowledge", json=community_payload)

        # 同步更新 Neo4j 中的 CommunityNode
        await self.neo4j.create_community_node(community_id, community, summary.content)
```

---

## 5. FeedbackAggregator — 反馈聚合

### 5.1 作用

将 Agent-TES 采集的执行结果（成功/失败）反馈到技能库，持续优化技能成功率。

```python
class FeedbackAggregator:
    async def process(self, evidence: dict) -> None:
        """
        处理来自 Agent-TES 的执行反馈。
        当一个 Skill 被 Agent 使用后，更新该 Skill 的统计指标。
        """
        if evidence.get("type") != "skill_execution":
            return

        skill_name  = evidence["skill_name"]
        success     = evidence["outcome"] == "success"
        turns       = evidence.get("turns_used", 0)
        latency_ms  = evidence.get("latency_ms", 0)

        # 调用 AMS 更新技能指标
        await self.ams_client.patch(
            f"/api/v1/memory/skills/{skill_name}/metrics",
            json={
                "success":    success,
                "turns":      turns,
                "latency_ms": latency_ms
            }
        )

        # 降级检测：若近20次成功率 < 0.5，触发技能降级告警
        metrics = await self.ams_client.get(f"/api/v1/memory/skills/{skill_name}/metrics")
        if metrics["recent_success_rate"] < 0.5:
            await self._trigger_skill_degradation_alert(skill_name, metrics)
```

---

## 6. 部署与运维

### 6.1 服务部署

MPP 是无状态的 Kafka Consumer，可多副本并行消费：

```yaml
# Kubernetes Deployment
replicas: 3                           # 3个副本并行消费
resources:
  requests:
    cpu: 1
    memory: 2Gi
  limits:
    cpu: 4
    memory: 8Gi                       # NER + LLM 调用内存消耗较大
```

**Kafka Consumer Group**：`memory-pipeline-workers`

每个副本独立消费，通过 Kafka consumer group 自动分区：
- 3个副本 + 6个 partition → 每个副本处理2个 partition

### 6.2 处理延迟目标

| 阶段 | 目标延迟 | 说明 |
|------|---------|------|
| Episode 处理（完整流程）| < 10s | 含 LLM 打分 + Embedding |
| Block 处理（单 chunk）| < 2s | Embedding 为主 |
| NER 提取（每 chunk）| < 100ms（fast）/ < 3s（LLM）| spaCy 快速 / LLM 精准 |
| 社区检测（全量）| < 5min | 取决于图规模，可离线运行 |
| Community Summary 生成 | < 30s/社区 | LLM 生成 |

### 6.3 关键配置

```yaml
KAFKA_BROKERS: "kafka.middleware.svc:9092"
KAFKA_CONSUMER_GROUP: "memory-pipeline-workers"
KAFKA_TOPICS: "agent.episodes.raw,agent.docs.ingest,agent.evidence.raw"

AMS_URL: "http://agent-memory-system.agent-apps.svc:8080"

EMBEDDING_MODEL: "text-embedding-3-small"
NER_FAST_MODEL:  "zh_core_web_sm"     # spaCy 中文模型
NER_LLM_MODEL:   "gpt-4o-mini"       # 精准 NER 用轻量 LLM

CHUNK_SIZE_TOKENS: "512"
CHUNK_OVERLAP_TOKENS: "64"
COMMUNITY_DETECTION_THRESHOLD: "500"  # 新增多少实体后触发社区检测
IMPORTANCE_SCORE_LLM: "gpt-4o-mini"  # 重要性评分用轻量 LLM
```

---

## 7. 上下游关系汇总

### 7.1 MPP 消费哪些消息？

| Topic | 来源服务 | MPP 处理类 |
|-------|---------|-----------|
| `agent.episodes.raw` | Agent Framework | EpisodePipeline |
| `agent.docs.ingest` | 业务系统 | KnowledgeIngestionPipeline |
| `agent.evidence.raw` | Agent-TES | FeedbackAggregator |

### 7.2 MPP 调用哪些服务？

| 服务 | 接口 | 用途 |
|------|------|------|
| **AMS** | POST `/memory/episodes` | 写入处理后的 Episode |
| **AMS** | POST `/memory/knowledge` | 写入 Block/实体/摘要 |
| **AMS** | PATCH `/memory/skills/*/metrics` | 更新技能统计 |
| **LLM API** | Chat Completion | 重要性打分、NER精准提取、摘要生成 |
| **Embedding API** | Embedding | 文本向量化 |
| **Neo4j**（通过AMS）| 间接调用 | 实体关系写入 |

> **注意**：MPP 通过 AMS API 写入数据，不直接访问 Milvus/Neo4j/PostgreSQL。存储层的访问收口在 AMS。

---

*下一步：[04-Storage-and-Retrieval 详细设计](./04-Storage-and-Retrieval.md) — 了解各存储层的 Schema 设计和检索策略*
