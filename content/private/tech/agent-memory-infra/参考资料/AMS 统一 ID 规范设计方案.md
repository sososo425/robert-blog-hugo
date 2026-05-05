# AMS 统一 ID 规范设计方案

> **文档版本**: v2.0（基于版本2存储选型）
> **日期**: 2026-03-30
> **状态**: 草案
> **核心目标**: 解决跨存储（Milvus/Neo4j/LanceDB/OSS）的 ID 映射与一致性问题

---

## 1. 背景与问题定义

### 1.1 为什么需要统一 ID 规范？

AMS 采用**多存储引擎架构**，同一个逻辑对象会同时存在于多个存储中：

| 存储引擎 | 存储内容 | 内部 ID 体系 |
|---------|---------|-------------|
| **Milvus** | Block/Section/Node 的 embedding 向量 | Milvus auto-id |
| **Neo4j** | 知识图谱（PhraseNode, CommunityNode, Edge）| Neo4j element-id |
| **LanceDB** | 多模态元数据 + 轻量内容（<4KB）| LanceDB 行号 |
| **OSS** | 大内容对象（≥4KB）| OSS Object Key |

**核心问题**：当检索服务做多路融合时——
1. **Graph 检索**在 Neo4j 找到实体 "Kafka"（PPR 高分）
2. **向量检索**在 Milvus 找到 Block `blk_001`（余弦相似度高）
3. 系统需要知道：**Neo4j 中的实体和 Milvus 中的 Block 是有关联的**

如果没有统一 ID 映射，这两个检索结果就是"孤岛"，无法融合。

### 1.2 "跨存储 ID 映射与一致性"的两层含义

| 层面 | 含义 | 挑战 |
|------|------|------|
| **ID 映射** | 设计全局统一 ID 体系，让同一对象在不同存储中可互相找到 | 各存储 ID 格式差异大，需映射层转换 |
| **一致性** | 增删改操作在多个存储中要么全成功，要么有补偿机制 | 分布式事务、部分失败、脏数据清理 |

---

## 2. ID 格式规范

### 2.1 标准格式

```
{prefix}_{tenant_short}_{ulid}
```

| 组件 | 说明 | 约束 |
|------|------|------|
| `prefix` | 2-3 字母实体类型前缀 | 小写，见下表 |
| `tenant_short` | 租户短标识 | 去除特殊字符，最多 8 字符 |
| `ulid` | 26 字符 ULID | 时间有序，可排序 |

### 2.2 实体类型前缀定义

| 实体类型 | 前缀 | 存储位置 | 说明 |
|---------|------|---------|------|
| **Block**（段落） | `blk` | Milvus + LanceDB + Neo4j | 最小内容单元 |
| **Section**（章节） | `sec` | Milvus + LanceDB | L1/L2 层级摘要 |
| **Memory**（记忆单元） | `mem` | 逻辑概念 | 跨存储聚合单元 |
| **Entity/PhraseNode**（实体） | `ent` | Milvus + Neo4j | 图谱节点 |
| **Community**（社区） | `com` | Milvus + Neo4j | 实体聚类 |
| **Episode**（事件） | `epi` | Milvus + LanceDB | 情景记忆 |
| **Skill**（技能） | `skl` | Milvus + LanceDB | 过程记忆 |
| **Edge**（关系） | `edg` | Neo4j | 图谱边（可选）|

### 2.3 ID 示例

```
blk_acmecorp_01hq4j5m9p2k3fnq8rxyz    # Block
sec_acmecorp_01hq4j5m9p2k3fnq8rabc    # Section
ent_acmecorp_01hq4j5m9p2k3fnq8rdef    # PhraseNode
com_acmecorp_01hq4j5m9p2k3fnq8rghi    # Community
mem_acmecorp_01hq4j5m9p2k3fnq8rjkl    # Memory（逻辑单元）
```

---

## 3. 跨存储 ID 映射设计

### 3.1 核心映射关系图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           逻辑对象：一个文档段落                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐          │
│  │   Milvus     │      │    Neo4j     │      │  LanceDB     │          │
│  │              │      │              │      │              │          │
│  │ block_       │◄────►│    Block     │◄────►│  blocks      │          │
│  │ embeddings   │ blk_id│    Node      │ blk_id│  table       │          │
│  │              │      │              │      │              │          │
│  ├──────────────┤      ├──────────────┤      ├──────────────┤          │
│  │ block_id (PK)│      │ block_id     │      │ block_id     │          │
│  │ section_id   │──┐   │ section_id   │──┐   │ section_id   │──┐       │
│  │ memory_id    │──┼──►│ memory_id    │──┼──►│ memory_id    │──┼──►    │
│  │ tenant_id    │──┘   │ tenant_id    │──┘   │ tenant_id    │──┘       │
│  └──────────────┘      └──────────────┘      └──────────────┘          │
│         │                     │                      │                  │
│         │                     ▼                      │                  │
│         │              ┌──────────────┐             │                  │
│         │              │   PhraseNode │◄────────────┘                  │
│         │              │   (实体)      │      HAS_CONTEXT               │
│         │              ├──────────────┤      (source_block_id)         │
│         └─────────────►│ entity_id    │                                │
│                        │ source_blk   │                                │
│                        └──────────────┘                                │
│                                                                         │
│  ┌──────────────┐                                                      │
│  │     OSS      │                                                      │
│  │              │◄──────────────────────────────────────────────┐      │
│  │ 大内容存储    │         content_oss_key (≥4KB)                │      │
│  └──────────────┘                                               │      │
│                                                                 │      │
└─────────────────────────────────────────────────────────────────┼──────┘
                                                                  │
                                                                  ▼
                                              ┌──────────────────────┐
                                              │   Memory Lake View   │
                                              │   (逻辑聚合视图)       │
                                              └──────────────────────┘
```

### 3.2 各存储层 Schema 中的 ID 字段

#### Milvus Collections

```python
# block_embeddings collection
FieldSchema("block_id",   DataType.VARCHAR, max_length=64, is_primary=True)
FieldSchema("section_id", DataType.VARCHAR, max_length=64)  # 所属章节
FieldSchema("memory_id",  DataType.VARCHAR, max_length=64)  # 所属记忆单元
FieldSchema("tenant_id",  DataType.VARCHAR, max_length=64)  # 租户隔离
FieldSchema("agent_id",   DataType.VARCHAR, max_length=64)  # Agent 隔离
FieldSchema("embedding",  DataType.FLOAT_VECTOR, dim=1536)
```

#### LanceDB Table Schema

```python
# blocks table (LanceDB)
{
    "block_id": "blk_acmecorp_01hq4j5m9p2k3fnq8rxyz",  # PK
    "tenant_id": "acmecorp",
    "agent_id": "agent_001",
    "memory_id": "mem_acmecorp_01hq4j5m9p2k3fnq8rjkl",
    "section_id": "sec_acmecorp_01hq4j5m9p2k3fnq8rabc",
    "block_type": "text",  # text/code/img/table
    "position": 3,
    "content_preview": "前500字...",
    "content": "完整内容（<4KB时）",
    "content_oss_key": None,  # ≥4KB时的OSS路径
    "tags": ["pandas", "csv"],
    "created_at": 1711536000,
    "_embedding": [...]  # LanceDB 可存向量，用于混合过滤
}
```

#### Neo4j Node Properties

```cypher
// Block Node（Tree 层桥接节点）
(:Block {
  block_id: "blk_acmecorp_01hq4j5m9p2k3fnq8rxyz",
  tenant_id: "acmecorp",
  agent_id: "agent_001",
  memory_id: "mem_acmecorp_01hq4j5m9p2k3fnq8rjkl",
  section_id: "sec_acmecorp_01hq4j5m9p2k3fnq8rabc"
})

// PhraseNode（Graph 层实体节点）
(:PhraseNode {
  entity_id: "ent_acmecorp_01hq4j5m9p2k3fnq8rdef",
  tenant_id: "acmecorp",
  name: "pandas",
  source_block_id: "blk_acmecorp_01hq4j5m9p2k3fnq8rxyz",  # 溯源
  source_memory_id: "mem_acmecorp_01hq4j5m9p2k3fnq8rjkl"
})
```

---

## 4. ID 生成与管理

### 4.1 统一 ID 生成器

```python
import ulid
from dataclasses import dataclass
from enum import Enum, auto

class EntityType(Enum):
    BLOCK = "blk"
    SECTION = "sec"
    MEMORY = "mem"
    ENTITY = "ent"
    COMMUNITY = "com"
    EPISODE = "epi"
    SKILL = "skl"
    EDGE = "edg"

@dataclass(frozen=True)
class AMSID:
    """AMS 统一 ID 类型"""
    prefix: str
    tenant: str
    ulid_str: str

    def __str__(self) -> str:
        return f"{self.prefix}_{self.tenant}_{self.ulid_str}"

    @classmethod
    def generate(cls, entity_type: EntityType, tenant_id: str) -> "AMSID":
        """生成新的 AMS ID"""
        tenant_short = tenant_id.replace("_", "").replace("-", "")[:8]
        return cls(
            prefix=entity_type.value,
            tenant=tenant_short,
            ulid_str=str(ulid.new()).lower()
        )

    @classmethod
    def parse(cls, id_str: str) -> "AMSID":
        """解析 ID 字符串"""
        parts = id_str.split("_", 2)
        if len(parts) != 3:
            raise ValueError(f"Invalid AMS ID format: {id_str}")
        return cls(prefix=parts[0], tenant=parts[1], ulid_str=parts[2])

    @property
    def entity_type(self) -> EntityType:
        """从 prefix 反推实体类型"""
        return EntityType(self.prefix)
```

### 4.2 ID 生成服务接口

```python
class IDGenerator:
    """分布式 ID 生成服务（单例模式）"""

    def __init__(self, tenant_id: str):
        self.tenant = tenant_id

    def new_block_id(self) -> str:
        return str(AMSID.generate(EntityType.BLOCK, self.tenant))

    def new_section_id(self) -> str:
        return str(AMSID.generate(EntityType.SECTION, self.tenant))

    def new_entity_id(self) -> str:
        return str(AMSID.generate(EntityType.ENTITY, self.tenant))

    def new_memory_id(self) -> str:
        return str(AMSID.generate(EntityType.MEMORY, self.tenant))
```

---

## 5. 跨存储一致性保证

### 5.1 写入一致性（Saga 模式）

```python
from typing import List, Callable, Optional
import asyncio

class CrossStorageWriter:
    """
    跨存储写入协调器
    写入顺序：LanceDB → Milvus → OSS → Neo4j（异步）
    """

    def __init__(self):
        self.compensations: List[Callable] = []

    async def write_block(self, block_data: dict) -> str:
        """
        写入 Block 到所有存储，保证最终一致性
        """
        block_id = block_data["block_id"]

        try:
            # Step 1: LanceDB（主存储，先执行）
            await self._write_lancedb("blocks", block_data)
            self.compensations.append(
                lambda: self._delete_lancedb("blocks", block_id)
            )

            # Step 2: Milvus（向量）
            await self._write_milvus("block_embeddings", {
                "block_id": block_id,
                "embedding": block_data["embedding"],
                "section_id": block_data["section_id"],
                "memory_id": block_data["memory_id"]
            })
            self.compensations.append(
                lambda: self._delete_milvus("block_embeddings", block_id)
            )

            # Step 3: OSS（大内容，如需要）
            if block_data.get("content_oss_key"):
                await self._write_oss(
                    block_data["content_oss_key"],
                    block_data["large_content"]
                )

            # Step 4: Neo4j（Graph，异步，非关键路径）
            if block_data.get("triples"):
                asyncio.create_task(
                    self._write_neo4j_async(block_data)
                )

            return block_id

        except Exception as e:
            # 执行补偿（逆序）
            await self._run_compensations()
            raise StorageWriteError(f"Failed to write block {block_id}: {e}")

    async def _run_compensations(self):
        """执行补偿操作"""
        for comp in reversed(self.compensations):
            try:
                await comp()
            except Exception as e:
                logger.error(f"Compensation failed: {e}")
                # 记录到 Dead Letter Queue，需人工介入
```

### 5.2 删除一致性（级联删除）

```python
async def delete_memory_cascade(memory_id: str, tenant_id: str):
    """
    级联删除 Memory 及其所有关联数据
    """
    # 1. 从 LanceDB 查询关联数据
    blocks = await lancedb_table("blocks") \
        .where(f"memory_id = '{memory_id}'") \
        .to_pandas()

    block_ids = blocks["block_id"].tolist()
    section_ids = blocks["section_id"].unique().tolist()
    oss_keys = blocks[blocks["content_oss_key"].notna()]["content_oss_key"].tolist()

    # 2. 并行删除（最大化利用各存储的并行能力）
    await asyncio.gather(
        # LanceDB（主存储）
        lancedb_delete("blocks", f"memory_id = '{memory_id}'"),

        # Milvus
        milvus_delete("block_embeddings", block_ids),
        milvus_delete("section_embeddings", section_ids),

        # OSS
        oss_batch_delete(oss_keys),

        # Neo4j（级联删除节点和边）
        neo4j.run("""
            MATCH (b:Block {memory_id: $memory_id})
                  -[:HAS_CONTEXT]->(n:PhraseNode)
            OPTIONAL MATCH (n)-[r]-()
            DELETE r, n, b
        """, memory_id=memory_id)
    )
```

### 5.3 更新一致性（版本控制）

```python
@dataclass
class VersionedBlock:
    """带版本信息的 Block"""
    block_id: str
    version: int
    content_hash: str
    updated_at: datetime

async def update_block_with_version(block_id: str, new_content: str) -> bool:
    """
    乐观锁更新，防止并发冲突
    """
    # 1. 从 LanceDB 读取当前版本
    current = await lancedb_get("blocks", block_id)
    if not current:
        raise BlockNotFoundError(block_id)

    # 2. 计算新内容哈希
    new_hash = hashlib.sha256(new_content.encode()).hexdigest()[:16]

    # 3. 乐观锁更新 LanceDB
    updated = await lancedb_update(
        "blocks",
        where=f"block_id = '{block_id}' AND version = {current['version']}",
        values={
            "content": new_content,
            "content_hash": new_hash,
            "version": current["version"] + 1,
            "updated_at": datetime.now().timestamp()
        }
    )

    if updated == 0:
        raise ConcurrentUpdateError(f"Block {block_id} was modified concurrently")

    # 4. 同步更新 Milvus（重新计算 embedding）
    new_embedding = await embed(new_content)
    await milvus_upsert("block_embeddings", {
        "block_id": block_id,
        "embedding": new_embedding,
        "content_preview": new_content[:500]
    })

    # 5. 标记 Neo4j 实体需更新（异步）
    await neo4j_mark_for_update(block_id)

    return True
```

---

## 6. Storage SDK 统一接口

```python
class StorageSDK:
    """
    统一存储抽象层 SDK
    封装 ID 管理、跨存储一致性、存储路由
    """

    def __init__(self, tenant_id: str):
        self.tenant = tenant_id
        self.id_gen = IDGenerator(tenant_id)
        self.writer = CrossStorageWriter()

    # ── ID 生成 ─────────────────────────────

    def new_block_id(self) -> str:
        return self.id_gen.new_block_id()

    # ── 跨存储写入 ──────────────────────────

    async def write_block(self, content: str, **metadata) -> str:
        """
        一键写入 Block 到所有存储
        """
        block_id = self.new_block_id()
        section_id = self.id_gen.new_section_id()
        memory_id = self.id_gen.new_memory_id()

        # 内容大小判断
        content_bytes = content.encode("utf-8")
        if len(content_bytes) >= 4096:
            oss_key = f"{self.tenant}/blocks/{block_id}.txt"
            await oss_put(oss_key, content)
            stored_content = None
        else:
            oss_key = None
            stored_content = content

        block_data = {
            "block_id": block_id,
            "tenant_id": self.tenant,
            "memory_id": memory_id,
            "section_id": section_id,
            "content": stored_content,
            "content_oss_key": oss_key,
            "content_preview": content[:500],
            "embedding": await embed(content),
            **metadata
        }

        return await self.writer.write_block(block_data)

    # ── 跨存储读取 ──────────────────────────

    async def get_block_full(self, block_id: str) -> Optional[dict]:
        """
        获取 Block 完整信息（跨存储聚合）
        """
        # 并行查询
        lance_task = lancedb_get("blocks", block_id)
        milvus_task = milvus_get("block_embeddings", block_id)
        neo4j_task = neo4j_get_entities(block_id)

        lance_result, milvus_result, neo4j_result = await asyncio.gather(
            lance_task, milvus_task, neo4j_task
        )

        if not lance_result:
            return None

        # 组装完整内容
        content = lance_result.get("content")
        if not content and lance_result.get("content_oss_key"):
            content = await oss_get(lance_result["content_oss_key"])

        return {
            "block_id": block_id,
            "content": content,
            "metadata": lance_result,
            "embedding": milvus_result.get("embedding") if milvus_result else None,
            "entities": neo4j_result if neo4j_result else []
        }
```

---

## 7. 检索时的 ID 融合策略

### 7.1 多路检索结果融合

```python
async def retrieve_with_id_fusion(
    query: str,
    tenant_id: str,
    agent_id: str
) -> List[dict]:
    """
    多路检索 + ID 融合
    """
    query_embedding = await embed(query)

    # 并行多路检索
    vector_results = milvus_search("block_embeddings", query_embedding, top_k=20)
    graph_results = neo4j_ppr_search(query, top_k=20)
    bm25_results = lancedb_fulltext_search("blocks", query, top_k=20)

    # 按 memory_id 聚合（去重粒度）
    fused = {}

    for result in await vector_results:
        mid = result["memory_id"]
        fused[mid] = {"memory_id": mid, "sources": ["vector"], **result}

    for result in await graph_results:
        mid = result.get("source_memory_id")
        if mid in fused:
            fused[mid]["sources"].append("graph")
            fused[mid]["graph_score"] = result["ppr_score"]
        else:
            fused[mid] = {"memory_id": mid, "sources": ["graph"], **result}

    # RRF 融合排序
    return rrf_fusion(list(fused.values()))
```

---

## 8. 总结：ID 规范速查表

| 场景 | 规范 |
|------|------|
| **ID 格式** | `{prefix}_{tenant_short}_{ulid}` |
| **Block ID** | `blk_acmecorp_01hq4j5m9p2k3fnq8rxyz` |
| **核心关联字段** | `block_id`, `memory_id`, `section_id`, `tenant_id` |
| **写入顺序** | LanceDB → Milvus → OSS → Neo4j(异步) |
| **读取聚合** | LanceDB(主) + Milvus(向量) + Neo4j(实体) + OSS(大内容) |
| **删除策略** | 级联删除，先查关联 ID，再并行执行 |
| **更新策略** | 乐观锁 + 版本号，LanceDB 为主存储 |
| **Neo4j 溯源** | `PhraseNode.source_block_id` → `Block.block_id` |

---

## 9. 待确认事项

1. **LanceDB 的 Schema 约束能力**是否满足 ID 关联的外键约束需求？
2. **是否需要 PostgreSQL**作为后备的强一致性存储？
3. **Neo4j 的异步写入**是否需要确认机制？
4. **跨存储事务补偿**的 Dead Letter Queue 实现方案
