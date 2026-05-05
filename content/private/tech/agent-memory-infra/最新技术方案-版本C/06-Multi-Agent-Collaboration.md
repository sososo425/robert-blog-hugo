---
title: "06-Multi-Agent-Collaboration 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "multi-agent", "acl", "consistency", "详细设计", "版本C"]
---

# Multi-Agent Collaboration 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: 当多个 Agent 协作完成同一任务时，AMS 的记忆应如何被安全共享、协调写入、保持一致——本模块是这些问题的完整答案。

---

## 1. 模块定位与问题陈述

### 1.1 为什么需要专门的多 Agent 协作设计？

单 Agent 场景下，记忆的所有权是清晰的：一个 Agent 拥有自己的记忆空间，读写不存在冲突。但在多 Agent 系统中，出现了以下新问题：

| 问题 | 场景示例 |
|---|---|
| **数据隔离 vs 知识共享的张力** | 研究 Agent A 发现了有价值的信息，如何安全地让分析 Agent B 也能访问？ |
| **并发写入冲突** | Orchestrator 和多个 Sub-Agent 同时尝试更新同一条记忆时，谁的写入有效？ |
| **权限边界模糊** | Sub-Agent B 能否修改 Agent A 的私有记忆？谁来仲裁？ |
| **一致性 vs 性能的权衡** | 写入 Shared Memory 后，其他 Agent 多久能看到最新数据？ |
| **跨 Agent 记忆溯源** | 某条共享记忆是哪个 Agent 在何时写入的？出错时如何追责？ |

### 1.2 设计范围

本模块覆盖：

1. **三种记忆共享模型** — Private / Shared / Hierarchical 的数据结构和访问规则
2. **ACL 访问控制** — 细粒度的权限模型（资源 × 主体 × 操作 × 条件）
3. **并发写入协调** — 乐观锁、悲观锁、CRDT 三种场景下的选择策略
4. **一致性保证** — Working Memory（强一致）vs Long-term Memory（最终一致）的具体实现
5. **跨 Agent 检索** — 多 Agent 联合检索时的数据合并与权限过滤
6. **多 Agent 记忆溯源** — Trace Context 在 Agent 间的传播与归因

本模块**不覆盖**：
- Agent 间的任务编排（属于 Agent Framework 层）
- 跨租户（cross-tenant）数据共享（安全边界，不支持）

---

## 2. 三种记忆共享模型

### 2.1 模型总览

```
┌──────────────────────────────────────────────────────────────┐
│               三种记忆共享模型                               │
│                                                              │
│  Private Memory          Shared Memory       Hierarchical    │
│                                                              │
│  Agent A │ Agent B    Agent A ↔ Agent B    Orchestrator      │
│  ────────│────────    ──────────────────    ────┬────────    │
│  [Mem A] │ [Mem B]    [Shared Mem Pool]        │ Global     │
│  (隔离)  │ (隔离)     (可读写共享)              ↓ Memory    │
│                                           Sub-A  Sub-B       │
│                                           [Local] [Local]    │
│                                           + 只读 Global      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Private Memory（私有记忆）

**定义**：每个 Agent 的记忆空间完全独立，其他 Agent 无任何访问权限。

**适用场景**：
- 处理含 PII（个人身份信息）的对话
- Agent 持有商业机密或客户隐私数据
- 独立完成任务、无需协作的单 Agent 部署

**实现机制**：

数据层面，Private Memory 通过 PostgreSQL 的行级安全策略（Row-Level Security，RLS）强制隔离：

```sql
-- 启用 RLS（所有表默认 deny all）
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;

-- Private Memory 策略：只允许 owner agent 访问
CREATE POLICY memory_private_owner
    ON memory_records
    FOR ALL
    USING (
        -- 执行查询的应用角色必须携带 agent_id，通过 current_setting 注入
        agent_id = current_setting('ams.current_agent_id')::uuid
        AND tenant_id = current_setting('ams.current_tenant_id')::uuid
        AND scope = 'private'
    );
```

```python
# AMS 执行 DB 查询前，注入当前请求的 agent_id 到 PG session
async def execute_with_context(
    self,
    sql: str,
    params: dict,
    agent_id: str,
    tenant_id: str
) -> list[dict]:
    async with self.pg.acquire() as conn:
        # 设置 RLS 上下文（每次连接独立设置，连接池复用时必须重置）
        await conn.execute(
            "SELECT set_config('ams.current_agent_id', $1, true), "
            "       set_config('ams.current_tenant_id', $2, true)",
            agent_id, tenant_id
        )
        return await conn.fetch(sql, *params.values())
```

### 2.3 Shared Memory（共享记忆）

**定义**：显式声明的记忆空间，允许多个指定 Agent 读写。适用于协作任务。

**适用场景**：
- 多 Agent 研究任务（Research Agent + Synthesis Agent 共享发现）
- 流水线式任务（Agent A 的输出作为 Agent B 的输入记忆）
- 团队知识库（整个 Agent 集群共享同一领域知识）

**数据模型扩展**：

在 `memory_records` 的基础上，引入 `memory_scope` 和 `memory_acl` 两个扩展字段：

```sql
-- 在 memory_records 表上补充协作相关字段
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    scope           VARCHAR(20) NOT NULL DEFAULT 'private',  -- 'private' | 'shared' | 'global'
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    owner_agent_id  UUID REFERENCES agents(agent_id),        -- 记忆的创建者（共享后依然保留）
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    shared_pool_id  UUID REFERENCES shared_memory_pools(pool_id); -- 归属的共享池

-- 共享内存池
CREATE TABLE shared_memory_pools (
    pool_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_name       VARCHAR(255) NOT NULL,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    description     TEXT,

    -- 访问控制配置
    default_read    BOOLEAN NOT NULL DEFAULT true,    -- pool 内所有成员默认可读
    default_write   BOOLEAN NOT NULL DEFAULT false,   -- 默认不可写（需显式授权）

    -- 元数据
    created_by      UUID NOT NULL REFERENCES agents(agent_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
);

-- 共享池成员表（Many-to-Many: Agent ↔ Pool）
CREATE TABLE pool_memberships (
    pool_id         UUID NOT NULL REFERENCES shared_memory_pools(pool_id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),

    -- 权限（见 §3 ACL 详细说明）
    can_read        BOOLEAN NOT NULL DEFAULT true,
    can_write       BOOLEAN NOT NULL DEFAULT false,
    can_delete      BOOLEAN NOT NULL DEFAULT false,
    can_admin       BOOLEAN NOT NULL DEFAULT false,   -- 管理员：可修改成员列表和权限

    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by      UUID REFERENCES agents(agent_id),  -- 谁授予了这个权限

    PRIMARY KEY (pool_id, agent_id)
);

CREATE INDEX idx_pool_membership_agent ON pool_memberships(agent_id, tenant_id);
```

**RLS 策略（Shared Memory）**：

```sql
-- Shared Memory 策略：pool 成员可读；有写权限的成员可写
CREATE POLICY memory_shared_read
    ON memory_records
    FOR SELECT
    USING (
        scope = 'shared'
        AND tenant_id = current_setting('ams.current_tenant_id')::uuid
        AND EXISTS (
            SELECT 1 FROM pool_memberships pm
            WHERE pm.pool_id = memory_records.shared_pool_id
              AND pm.agent_id = current_setting('ams.current_agent_id')::uuid
              AND pm.can_read = true
        )
    );

CREATE POLICY memory_shared_write
    ON memory_records
    FOR INSERT
    WITH CHECK (
        scope = 'shared'
        AND tenant_id = current_setting('ams.current_tenant_id')::uuid
        AND EXISTS (
            SELECT 1 FROM pool_memberships pm
            WHERE pm.pool_id = NEW.shared_pool_id
              AND pm.agent_id = current_setting('ams.current_agent_id')::uuid
              AND pm.can_write = true
        )
    );
```

### 2.4 Hierarchical Memory（层级记忆）

**定义**：主 Agent（Orchestrator）拥有全局记忆，子 Agent 拥有独立的局部私有记忆，同时对 Orchestrator 的全局记忆有只读访问权。

**适用场景**：
- 编排型多 Agent 系统（Orchestrator → [Sub-Agent1, Sub-Agent2, Sub-Agent3]）
- 主从式任务分发（主 Agent 保存任务全局状态，子 Agent 各自执行分片任务）

**层级关系数据模型**：

```sql
-- Agent 层级关系表
CREATE TABLE agent_hierarchy (
    hierarchy_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    parent_agent_id UUID NOT NULL REFERENCES agents(agent_id),
    child_agent_id  UUID NOT NULL REFERENCES agents(agent_id),

    -- 子 Agent 对父 Agent 记忆的访问权
    inherit_read    BOOLEAN NOT NULL DEFAULT true,   -- 默认可读父的 global 记忆
    inherit_write   BOOLEAN NOT NULL DEFAULT false,  -- 默认不可写父的 global 记忆

    -- 层级关系的生命周期（任务结束后可解除）
    session_id      VARCHAR(64),        -- 若绑定到特定会话，会话结束后自动解除
    valid_until     TIMESTAMPTZ,        -- 硬过期时间（可选）

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, parent_agent_id, child_agent_id)
);

CREATE INDEX idx_agent_hierarchy_child ON agent_hierarchy(child_agent_id, tenant_id);
CREATE INDEX idx_agent_hierarchy_parent ON agent_hierarchy(parent_agent_id, tenant_id);
```

**层级记忆访问逻辑**：

```python
class HierarchicalMemoryAccessor:
    """
    子 Agent 查询记忆时，自动合并：
    1. 自己的 Private Memory
    2. 父 Agent 的 Global Memory（只读）
    3. 有权访问的 Shared Pool（若有）
    """

    async def retrieve(
        self,
        query: str,
        agent_id: str,
        tenant_id: str,
        include_parent_memory: bool = True
    ) -> list[MemoryRecord]:
        # 获取该 agent 的父级链（支持多层层级）
        parent_ids: list[str] = []
        if include_parent_memory:
            parent_ids = await self._get_parent_chain(agent_id, tenant_id)

        # 并行检索：自身 + 父级链
        tasks = [
            self.ams_client.retrieve(
                query=query,
                agent_id=agent_id,
                tenant_id=tenant_id,
                scope="private"
            )
        ]
        for parent_id in parent_ids:
            tasks.append(
                self.ams_client.retrieve(
                    query=query,
                    agent_id=parent_id,
                    tenant_id=tenant_id,
                    scope="global",
                    requester_agent_id=agent_id   # 权限校验：子 Agent 读父 Agent 的 global 记忆
                )
            )

        results = await asyncio.gather(*tasks)
        merged = self._merge_and_deduplicate(results)
        return merged

    async def _get_parent_chain(
        self, agent_id: str, tenant_id: str, max_depth: int = 3
    ) -> list[str]:
        """
        获取 Agent 的父级链（递归向上，最多 max_depth 层）
        大多数编排系统只有 1-2 层，max_depth=3 已足够。
        """
        rows = await self.pg.fetch("""
            WITH RECURSIVE hierarchy AS (
                SELECT parent_agent_id, child_agent_id, 1 AS depth
                FROM agent_hierarchy
                WHERE child_agent_id = $1
                  AND tenant_id = $2
                  AND inherit_read = true
                  AND (valid_until IS NULL OR valid_until > now())

                UNION ALL

                SELECT ah.parent_agent_id, ah.child_agent_id, h.depth + 1
                FROM agent_hierarchy ah
                JOIN hierarchy h ON ah.child_agent_id = h.parent_agent_id
                WHERE h.depth < $3
                  AND ah.tenant_id = $2
                  AND ah.inherit_read = true
                  AND (ah.valid_until IS NULL OR ah.valid_until > now())
            )
            SELECT DISTINCT parent_agent_id FROM hierarchy
        """, agent_id, tenant_id, max_depth)
        return [str(row["parent_agent_id"]) for row in rows]
```

---

## 3. ACL 访问控制

### 3.1 权限模型设计

AMS 采用 **RBAC + ABAC 混合模型**：
- **RBAC（基于角色）**：为常见场景预定义角色（Reader / Writer / Admin），简化配置
- **ABAC（基于属性）**：支持条件性访问（如"仅在特定会话中可写"、"仅对特定 memory_type 可读"）

```
权限评估流程：
Request(agent_id, resource_id, action)
    ↓
1. 检查 Deny 规则（优先于 Allow）
    ↓ 无 Deny
2. 检查 Pool Membership（共享池成员权限）
    ↓ 无匹配
3. 检查 Agent Hierarchy（层级继承权限）
    ↓ 无匹配
4. 检查 Explicit ACL Rules（显式规则表）
    ↓ 无匹配
5. 检查 Global Memory Scope（租户级全局记忆）
    ↓ 无匹配
6. Deny（默认拒绝）
```

### 3.2 ACL 规则表

```sql
-- 细粒度访问控制规则表
CREATE TABLE memory_acl_rules (
    rule_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),

    -- 主体（Subject）：谁
    subject_type    VARCHAR(20) NOT NULL,   -- 'agent' | 'agent_group' | 'role'
    subject_id      VARCHAR(64) NOT NULL,   -- agent_id / group_id / role_name

    -- 资源（Resource）：什么
    resource_type   VARCHAR(20) NOT NULL,   -- 'memory' | 'pool' | 'agent_memory'
    resource_id     VARCHAR(64),            -- NULL = 匹配所有该类型资源
    -- 资源属性过滤（ABAC 条件）
    resource_filter JSONB,
    -- 示例: {"memory_type": "semantic", "source_type": "work_document"}
    -- 含义: 只对 semantic 类型且来源是工作文档的记忆生效

    -- 操作（Action）
    action          VARCHAR(20) NOT NULL,   -- 'read' | 'write' | 'delete' | 'admin' | '*'

    -- 效果
    effect          VARCHAR(10) NOT NULL DEFAULT 'allow',  -- 'allow' | 'deny'

    -- 条件约束（ABAC）
    conditions      JSONB,
    -- 示例: {"valid_sessions": ["sess_abc"], "time_window": {"start": "09:00", "end": "18:00"}}

    -- 优先级（数字越小优先级越高；deny 默认比 allow 优先）
    priority        INT NOT NULL DEFAULT 100,

    -- 生命周期
    valid_from      TIMESTAMPTZ,
    valid_until     TIMESTAMPTZ,
    created_by      UUID REFERENCES agents(agent_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_acl_subject ON memory_acl_rules(tenant_id, subject_type, subject_id);
CREATE INDEX idx_acl_resource ON memory_acl_rules(tenant_id, resource_type, resource_id);
```

### 3.3 预定义角色

```python
class MemoryRole:
    """
    预定义记忆访问角色，简化常见场景配置。
    可以通过 ACL 规则表中 subject_type='role' 来引用。
    """

    READER = "memory:reader"
    # 权限：read（所有 scope 内的记忆）
    # 不能：write, delete, admin

    WRITER = "memory:writer"
    # 权限：read + write（但不能 delete 他人写入的记忆）
    # 不能：delete others, admin

    COLLABORATOR = "memory:collaborator"
    # 权限：read + write + delete（仅自己写入的记忆）
    # 适合：对等协作 Agent

    ADMIN = "memory:admin"
    # 权限：read + write + delete（所有记忆）+ 管理 Pool 成员
    # 通常只赋予 Orchestrator Agent

    # 对应 ACL 规则（在初始化时写入 memory_acl_rules 表）
    ROLE_PERMISSIONS = {
        READER: [
            {"action": "read", "effect": "allow", "resource_filter": None}
        ],
        WRITER: [
            {"action": "read", "effect": "allow", "resource_filter": None},
            {"action": "write", "effect": "allow", "resource_filter": None}
        ],
        COLLABORATOR: [
            {"action": "read", "effect": "allow", "resource_filter": None},
            {"action": "write", "effect": "allow", "resource_filter": None},
            {"action": "delete", "effect": "allow",
             "resource_filter": {"owner_is_self": True}}  # 只能删自己的
        ],
        ADMIN: [
            {"action": "*", "effect": "allow", "resource_filter": None}
        ]
    }
```

### 3.4 ACL 评估引擎

```python
class ACLEvaluator:
    """
    权限评估引擎：给定 (agent_id, resource, action)，返回 allow/deny。

    评估顺序（优先级从高到低）：
    1. Explicit Deny 规则
    2. Pool Membership 权限
    3. Hierarchy 继承权限
    4. Explicit Allow 规则
    5. Default Deny
    """

    async def evaluate(
        self,
        agent_id: str,
        tenant_id: str,
        resource_type: str,
        resource_id: str | None,
        resource_attrs: dict,   # 资源的属性（用于 ABAC 过滤匹配）
        action: str,
        context: dict | None = None   # 当前上下文（session_id, timestamp 等）
    ) -> tuple[bool, str]:
        """
        Returns: (allowed: bool, reason: str)
        reason 用于审计日志和调试
        """
        # ─── Step 1: 检查显式 Deny 规则（优先级最高）───────────────
        deny_rules = await self._fetch_rules(
            agent_id, tenant_id, resource_type, resource_id,
            action, effect="deny"
        )
        for rule in deny_rules:
            if self._match_rule(rule, resource_attrs, context):
                return False, f"Explicit DENY rule {rule['rule_id']}"

        # ─── Step 2: 检查 Pool Membership 权限 ─────────────────────
        if resource_attrs.get("shared_pool_id"):
            pool_perm = await self._check_pool_permission(
                agent_id, resource_attrs["shared_pool_id"], action
            )
            if pool_perm is not None:   # None = 不是 pool 成员
                if pool_perm:
                    return True, f"Pool membership allows {action}"
                else:
                    return False, f"Pool membership denies {action}"

        # ─── Step 3: 检查 Hierarchy 继承权限 ────────────────────────
        if resource_attrs.get("owner_agent_id") and \
           resource_attrs["owner_agent_id"] != agent_id:
            hierarchy_perm = await self._check_hierarchy_permission(
                agent_id, resource_attrs["owner_agent_id"], tenant_id, action
            )
            if hierarchy_perm is not None:
                if hierarchy_perm:
                    return True, f"Hierarchy inheritance allows {action}"
                else:
                    return False, f"No hierarchy permission for {action}"

        # ─── Step 4: 检查显式 Allow 规则 ────────────────────────────
        allow_rules = await self._fetch_rules(
            agent_id, tenant_id, resource_type, resource_id,
            action, effect="allow"
        )
        for rule in allow_rules:
            if self._match_rule(rule, resource_attrs, context):
                return True, f"Explicit ALLOW rule {rule['rule_id']}"

        # ─── Step 5: 私有记忆的 owner 永远有所有权限 ─────────────────
        if resource_attrs.get("owner_agent_id") == agent_id:
            return True, "Owner always has full access"

        # ─── Step 6: Default Deny ────────────────────────────────────
        return False, "Default deny: no matching allow rule"

    def _match_rule(
        self, rule: dict, resource_attrs: dict, context: dict | None
    ) -> bool:
        """
        检查资源属性和上下文是否满足 ACL 规则的过滤条件。
        """
        # 资源属性过滤（ABAC）
        if rule.get("resource_filter"):
            for key, value in rule["resource_filter"].items():
                if key == "owner_is_self":
                    continue   # 特殊键，在调用前已处理
                if resource_attrs.get(key) != value:
                    return False

        # 条件约束（时间窗口、会话限制等）
        if rule.get("conditions") and context:
            conditions = rule["conditions"]
            # 会话限制
            if "valid_sessions" in conditions:
                if context.get("session_id") not in conditions["valid_sessions"]:
                    return False
            # 时间窗口
            if "time_window" in conditions:
                tw = conditions["time_window"]
                now_time = datetime.utcnow().strftime("%H:%M")
                if not (tw["start"] <= now_time <= tw["end"]):
                    return False

        # 有效期检查
        if rule.get("valid_until"):
            if datetime.utcnow() > datetime.fromisoformat(rule["valid_until"]):
                return False

        return True
```

---

## 4. 并发写入协调

### 4.1 三种并发场景与对应策略

多 Agent 写入同一记忆时，根据冲突频率和业务容忍度，选用不同的协调策略：

| 场景 | 特征 | 推荐策略 |
|---|---|---|
| **低冲突写入**（不同 Agent 写不同记忆）| 冲突概率 < 5% | 乐观锁（OCC）|
| **高冲突写入**（多 Agent 频繁更新同一记忆，如共享任务状态）| 冲突概率 ≥ 30% | 悲观锁（PCC）|
| **仅追加写入**（多 Agent 向共享记忆追加新信息，不更新已有内容）| 无读-改-写循环 | CRDT（无冲突）|

### 4.2 乐观锁（OCC）

适用于 `memory_records` 的元数据更新（如 `importance` / `access_count` / `decay_weight`）：

```sql
-- memory_records 表添加版本号字段
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    version     BIGINT NOT NULL DEFAULT 0;
```

```python
class OptimisticMemoryWriter:
    """
    乐观锁写入：读取时记录 version，更新时校验 version 未变更。
    冲突时重试（最多 3 次，指数退避）。
    """

    MAX_RETRIES = 3
    BASE_BACKOFF_MS = 50

    async def update_with_retry(
        self,
        memory_id: str,
        updates: dict,
        agent_id: str,
        tenant_id: str
    ) -> bool:
        for attempt in range(self.MAX_RETRIES):
            # 读取当前记录（含 version）
            record = await self.pg.fetchrow(
                "SELECT * FROM memory_records WHERE memory_id = $1 AND tenant_id = $2",
                memory_id, tenant_id
            )
            if not record:
                raise MemoryNotFoundError(memory_id)

            current_version = record["version"]

            # 构建更新语句（CAS: Compare-And-Swap）
            set_clauses = ", ".join(f"{k} = ${i+3}" for i, k in enumerate(updates))
            values = list(updates.values())

            rows_affected = await self.pg.execute(
                f"""UPDATE memory_records
                    SET {set_clauses},
                        version = version + 1,
                        updated_at = now()
                    WHERE memory_id = $1
                      AND tenant_id = $2
                      AND version = {current_version}""",
                memory_id, tenant_id, *values
            )

            if rows_affected > 0:
                return True   # 更新成功

            # version 不匹配，说明有其他 Agent 抢先写入了
            if attempt < self.MAX_RETRIES - 1:
                backoff = self.BASE_BACKOFF_MS * (2 ** attempt)
                await asyncio.sleep(backoff / 1000.0)

        raise ConcurrentWriteConflict(
            f"Failed to update memory {memory_id} after {self.MAX_RETRIES} attempts"
        )
```

### 4.3 悲观锁（PCC）

适用于高冲突的共享状态更新，如多 Agent 协作时的任务进度记录：

```python
class PessimisticMemoryWriter:
    """
    悲观锁写入：写入前先在 Redis 加分布式锁，防止并发冲突。
    锁粒度为 memory_id，TTL = 10s（防止锁泄漏）。
    """

    LOCK_TTL_MS = 10_000   # 10 秒锁超时
    LOCK_WAIT_MS = 5_000   # 最长等待 5 秒

    async def update_with_lock(
        self,
        memory_id: str,
        updates: dict,
        agent_id: str,
        tenant_id: str
    ) -> bool:
        lock_key = f"ams:lock:memory:{memory_id}"
        lock_value = f"{agent_id}:{uuid4()}"   # 唯一值，确保只有加锁者能解锁

        # 尝试获取锁（SET NX PX）
        acquired = await self.redis.set(
            lock_key, lock_value,
            nx=True, px=self.LOCK_TTL_MS
        )

        if not acquired:
            # 等待锁释放（轮询，间隔 50ms）
            deadline = asyncio.get_event_loop().time() + self.LOCK_WAIT_MS / 1000
            while asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(0.05)
                acquired = await self.redis.set(
                    lock_key, lock_value,
                    nx=True, px=self.LOCK_TTL_MS
                )
                if acquired:
                    break

        if not acquired:
            raise LockAcquisitionTimeout(
                f"Could not acquire lock for memory {memory_id} "
                f"within {self.LOCK_WAIT_MS}ms"
            )

        try:
            # 持锁期间执行写入（无需 version 校验）
            set_clauses = ", ".join(
                f"{k} = ${i+3}" for i, k in enumerate(updates)
            )
            await self.pg.execute(
                f"UPDATE memory_records SET {set_clauses}, updated_at = now() "
                f"WHERE memory_id = $1 AND tenant_id = $2",
                memory_id, tenant_id, *updates.values()
            )
            return True
        finally:
            # 用 Lua 脚本原子性地"验证 + 释放"锁（防止误释放他人的锁）
            await self.redis.eval(
                """
                if redis.call('get', KEYS[1]) == ARGV[1] then
                    return redis.call('del', KEYS[1])
                else
                    return 0
                end
                """,
                1, lock_key, lock_value
            )
```

### 4.4 CRDT（无冲突复制数据类型）

对于**仅追加**的共享记忆写入（多 Agent 各自追加发现，不修改他人的内容），使用 CRDT 的 G-Set（增长集合）语义，无需协调即可合并：

```python
class AppendOnlySharedMemory:
    """
    仅追加语义的共享记忆：每个 Agent 只能添加新 Block，不能修改他人的 Block。
    合并时直接取并集（G-Set CRDT）。

    适用场景：
    - 多 Agent 调研同一主题，各自追加发现到共享池
    - 流水线任务的中间结果汇总
    """

    async def append_block(
        self,
        pool_id: str,
        block_content: str,
        agent_id: str,
        tenant_id: str,
        block_type: str = "text"
    ) -> str:
        """
        追加一个 Block 到共享记忆池。
        每个 block 的 block_id 全局唯一（UUID），不与任何现有 block 冲突。
        并发追加天然无冲突：两个 Agent 同时写入只会得到两个独立的新 Block。
        """
        block_id = str(uuid4())

        # 写入 block_content 表（INSERT，不 UPDATE，无并发冲突）
        await self.pg.execute("""
            INSERT INTO block_content
            (block_id, tenant_id, memory_id, block_type, raw_text,
             position, created_by)
            VALUES ($1, $2, $3, $4, $5,
                    (SELECT COALESCE(MAX(position), 0) + 1
                     FROM block_content
                     WHERE memory_id = $3),
                    $6)
        """, block_id, tenant_id, pool_id, block_type, block_content,
            f"agent:{agent_id}")

        # 发布到 Kafka，触发 Tree/Graph Construction
        await self.kafka.send("ams.pipeline.structure", {
            "memory_id": pool_id,
            "block_id": block_id,
            "agent_id": agent_id,
            "tenant_id": tenant_id,
            "pipeline_type": "tree",
            "source_type": "user_interaction"
        })

        return block_id
```

---

## 5. 一致性保证

### 5.1 Working Memory：强一致性

Working Memory（Redis）在同一会话内保证强一致性：

| 保证维度 | 实现机制 | 说明 |
|---|---|---|
| **原子性** | Lua 脚本 | 多个 Redis 命令组合为不可分割的原子操作 |
| **隔离性** | 单分片序列化执行 | 同一 session 的所有 Key 路由到同一 Redis 分片（通过 Hash Tag `{sid}`）|
| **顺序性** | 单连接串行写入 | AMS 对同一 session 使用单连接，保证命令执行顺序 |

**Hash Tag 设计**（确保同一 session 的所有 Key 落在同一分片）：

```python
# 所有 Working Memory Key 使用 {session_id} 作为 Hash Tag
# Redis Cluster 根据 {} 内的内容决定分片，{} 外的部分不影响分片
SESSION_KEYS = {
    "state":   "session:{sid}:state",   # Hash
    "conv":    "session:{sid}:conv",    # List（对话轮次）
    "task":    "session:{sid}:task",    # Hash（任务状态）
    "tools":   "session:{sid}:tools",   # Stream（工具调用日志）
    "ctx":     "session:{sid}:ctx",     # String（上下文元数据）
}

# 原子性更新示例：同时更新 state + conv（Lua 脚本保证原子）
UPDATE_SESSION_SCRIPT = """
local state_key = KEYS[1]
local conv_key  = KEYS[2]
local state_update = ARGV[1]    -- JSON 字符串
local message      = ARGV[2]    -- JSON 字符串
local max_conv_len = tonumber(ARGV[3])

-- 原子更新 state
redis.call('HSET', state_key, 'last_active_at', tostring(redis.call('TIME')[1]))
redis.call('EXPIRE', state_key, 7200)

-- 追加消息并维持上限
redis.call('RPUSH', conv_key, message)
redis.call('LTRIM', conv_key, -max_conv_len, -1)
redis.call('EXPIRE', conv_key, 7200)

return 1
"""
```

**多 Agent 同一会话的一致性边界**：

> ⚠️ **设计约束**：在同一 session 内，**同一时刻只应有一个 Agent 是活跃的写入者**。如果需要多 Agent 并行写同一 session，应为每个 Agent 创建独立的子会话（sub-session），通过 Hierarchical Memory 模型在主会话中聚合。

### 5.2 Long-term Memory：最终一致性

Long-term Memory（PostgreSQL / Neo4j / Milvus）采用**最终一致性**，通过以下机制保证正确性：

#### 5.2.1 Kafka 保序写入

同一 `agent_id` 的所有写入消息路由到同一 Kafka 分区，保证该 Agent 的记忆按时序处理：

```python
# AMS 发布 Pipeline 任务时，用 agent_id 作为分区键
await self.kafka.send(
    topic="ams.pipeline.structure",
    key=agent_id,          # 同一 Agent 的消息有序（同分区）
    value=pipeline_message
)

# 共享记忆池用 pool_id 作为分区键
await self.kafka.send(
    topic="ams.pipeline.structure",
    key=pool_id,           # 同一 Pool 的消息有序（同分区）
    value=pipeline_message
)
```

#### 5.2.2 版本向量（Version Vector）

当多个 Agent 并发更新同一共享记忆时，使用版本向量检测冲突：

```sql
-- memory_records 表添加版本向量字段
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    version_vector  JSONB NOT NULL DEFAULT '{}';
-- 格式示例: {"agent_a_id": 3, "agent_b_id": 1}
-- 含义: agent_a 对这条记忆做了 3 次更新，agent_b 做了 1 次
```

```python
class VersionVector:
    """
    版本向量操作工具。
    用于检测多 Agent 并发写入是否产生了因果冲突。
    """

    @staticmethod
    def increment(vv: dict, agent_id: str) -> dict:
        """Agent 写入后，更新自己的版本计数"""
        new_vv = dict(vv)
        new_vv[agent_id] = new_vv.get(agent_id, 0) + 1
        return new_vv

    @staticmethod
    def dominates(vv_a: dict, vv_b: dict) -> bool:
        """
        vv_a 是否"支配"vv_b（即 vv_a 因果上在 vv_b 之后）
        条件：vv_a 的每个分量 ≥ vv_b 的对应分量，且至少一个严格 >
        """
        all_keys = set(vv_a) | set(vv_b)
        strictly_greater = False
        for key in all_keys:
            a_val = vv_a.get(key, 0)
            b_val = vv_b.get(key, 0)
            if a_val < b_val:
                return False
            if a_val > b_val:
                strictly_greater = True
        return strictly_greater

    @staticmethod
    def concurrent(vv_a: dict, vv_b: dict) -> bool:
        """
        vv_a 和 vv_b 是否并发（互不支配 → 存在冲突）
        """
        return (not VersionVector.dominates(vv_a, vv_b) and
                not VersionVector.dominates(vv_b, vv_a) and
                vv_a != vv_b)

    @staticmethod
    def merge(vv_a: dict, vv_b: dict) -> dict:
        """合并两个版本向量（取每个分量的最大值）"""
        all_keys = set(vv_a) | set(vv_b)
        return {k: max(vv_a.get(k, 0), vv_b.get(k, 0)) for k in all_keys}
```

#### 5.2.3 读取一致性保障（Read-Your-Writes）

Agent 写入 Long-term Memory 后，立即读取时可能读到旧数据（Kafka 异步处理尚未完成）。AMS 通过"写后缓存"解决 Read-Your-Writes 问题：

```python
class ReadYourWritesCache:
    """
    写入 Long-term Memory 后，将写入内容临时缓存到 Redis（30s TTL）。
    同一 Agent 在 30s 内的读取请求优先命中缓存，避免读到旧数据。
    """

    RYW_TTL = 30   # 30 秒，足够 Kafka Pipeline 完成处理

    async def cache_pending_write(
        self,
        agent_id: str,
        memory_id: str,
        memory_summary: str,
        tenant_id: str
    ) -> None:
        key = f"ams:ryw:{tenant_id}:{agent_id}:{memory_id}"
        await self.redis.setex(
            key, self.RYW_TTL,
            json.dumps({"memory_id": memory_id, "summary": memory_summary})
        )

    async def get_pending_writes(
        self, agent_id: str, tenant_id: str
    ) -> list[dict]:
        pattern = f"ams:ryw:{tenant_id}:{agent_id}:*"
        keys = await self.redis.keys(pattern)
        if not keys:
            return []
        values = await self.redis.mget(*keys)
        return [json.loads(v) for v in values if v]
```

---

## 6. 跨 Agent 联合检索

### 6.1 检索范围声明

Agent 发起检索时，可以通过 `scope` 参数声明检索范围：

```python
class RetrievalScope:
    PRIVATE_ONLY  = "private"           # 只检索自己的记忆
    POOL_INCLUDED = "pool"              # 检索自己的记忆 + 有权访问的所有 Pool
    HIERARCHY     = "hierarchy"         # 检索自己 + 父级 Agent 的 global 记忆
    ALL_ACCESSIBLE = "all"              # 所有有权访问的记忆（private + pool + hierarchy）
```

### 6.2 联合检索实现

```python
class MultiAgentRetriever:
    """
    多 Agent 联合检索：并行从多个记忆空间检索，合并后按权限过滤，最终 RRF 融合排名。
    """

    async def retrieve(
        self,
        query: str,
        agent_id: str,
        tenant_id: str,
        scope: str = "all",
        top_k: int = 20
    ) -> list[RetrievalResult]:
        # 确定检索目标空间
        search_spaces = await self._resolve_search_spaces(
            agent_id, tenant_id, scope
        )

        # 并行检索所有空间
        tasks = []
        for space in search_spaces:
            tasks.append(
                self._retrieve_from_space(query, space, top_k * 2)
            )
        space_results = await asyncio.gather(*tasks, return_exceptions=True)

        # 过滤异常（某个空间检索失败不影响其他空间）
        valid_results = []
        for i, result in enumerate(space_results):
            if isinstance(result, Exception):
                logger.warning(
                    f"Retrieval from space {search_spaces[i]} failed: {result}"
                )
            else:
                valid_results.extend(result)

        # ACL 过滤（二次验证，确保权限边界）
        filtered = await self._acl_filter(valid_results, agent_id, tenant_id)

        # Read-Your-Writes 补充（注入待处理的写入）
        pending = await self.ryw_cache.get_pending_writes(agent_id, tenant_id)
        if pending:
            filtered = self._inject_pending_writes(filtered, pending, query)

        # RRF 融合排名（多空间结果合并）
        merged = self._rrf_fusion(filtered, top_k)

        return merged

    async def _resolve_search_spaces(
        self,
        agent_id: str,
        tenant_id: str,
        scope: str
    ) -> list[SearchSpace]:
        spaces = []

        # 自身私有空间（始终包含）
        spaces.append(SearchSpace(
            agent_id=agent_id,
            scope_type="private",
            filter_expr=f'agent_id == "{agent_id}" && scope == "private"'
        ))

        if scope in ("pool", "all"):
            # 有读权限的所有 Pool
            pools = await self.pg.fetch("""
                SELECT pm.pool_id
                FROM pool_memberships pm
                WHERE pm.agent_id = $1 AND pm.tenant_id = $2
                  AND pm.can_read = true
            """, agent_id, tenant_id)
            for pool in pools:
                spaces.append(SearchSpace(
                    agent_id=None,
                    pool_id=str(pool["pool_id"]),
                    scope_type="shared",
                    filter_expr=f'shared_pool_id == "{pool["pool_id"]}"'
                ))

        if scope in ("hierarchy", "all"):
            # 父级 Agent 的 global 记忆
            parent_ids = await self.hierarchy_accessor._get_parent_chain(
                agent_id, tenant_id
            )
            for parent_id in parent_ids:
                spaces.append(SearchSpace(
                    agent_id=parent_id,
                    scope_type="global",
                    filter_expr=(
                        f'agent_id == "{parent_id}" && scope == "global"'
                    )
                ))

        return spaces

    def _rrf_fusion(
        self,
        results: list[RetrievalResult],
        top_k: int,
        k: int = 60
    ) -> list[RetrievalResult]:
        """
        倒数排名融合（RRF）：融合来自多个空间的检索结果。

        RRF Score(d) = Σ 1 / (k + rank_i(d))
        其中 rank_i(d) 是文档 d 在第 i 个空间结果中的排名。
        k=60 是经验最优值（参考 Cormack et al. 2009）。
        """
        # 按 memory_id 分组，汇总每个记忆在不同空间的排名
        rank_map: dict[str, list[int]] = {}
        result_map: dict[str, RetrievalResult] = {}

        for i, result in enumerate(results):
            mid = result.memory_id
            if mid not in rank_map:
                rank_map[mid] = []
                result_map[mid] = result
            rank_map[mid].append(i + 1)   # rank 从 1 开始

        # 计算 RRF 分
        rrf_scores = {
            mid: sum(1.0 / (k + r) for r in ranks)
            for mid, ranks in rank_map.items()
        }

        # 排序取 top_k
        sorted_ids = sorted(rrf_scores, key=lambda x: rrf_scores[x], reverse=True)
        top_results = []
        for mid in sorted_ids[:top_k]:
            result = result_map[mid]
            result.rrf_score = rrf_scores[mid]
            top_results.append(result)

        return top_results
```

---

## 7. 跨 Agent 记忆溯源

### 7.1 Trace Context 传播

在多 Agent 系统中，一个用户任务可能经过 Orchestrator → Sub-Agent A → Sub-Agent B 的完整链路。AMS 通过 **W3C Trace Context** 标准在 Agent 间传播链路上下文，实现完整的记忆溯源：

```python
class MemoryProvenanceTracer:
    """
    在 Agent 间记忆写入时传播 Trace Context，
    确保每条记忆都能追溯到原始用户请求。
    """

    def propagate_context(
        self,
        parent_span_context: dict,
        memory_write_request: dict
    ) -> dict:
        """
        将父 Agent 的 Span Context 注入到记忆写入请求。
        格式遵循 W3C TraceContext（traceparent + tracestate）。
        """
        memory_write_request["_trace_context"] = {
            "traceparent": (
                f"00-{parent_span_context['trace_id']}-"
                f"{parent_span_context['span_id']}-01"
            ),
            "tracestate": parent_span_context.get("tracestate", "")
        }
        return memory_write_request
```

### 7.2 记忆溯源元数据

每条写入的记忆都附带完整的溯源信息：

```sql
-- memory_records 添加溯源字段（补充到现有表结构）
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS
    provenance  JSONB NOT NULL DEFAULT '{}';

-- provenance 字段示例值：
-- {
--     "origin_agent_id": "orchestrator_001",  -- 触发写入的根 Agent
--     "writing_agent_id": "sub_agent_a_001",  -- 实际执行写入的 Agent
--     "trace_id": "abc123...",                -- OTel Trace ID（关联 TES 数据）
--     "parent_span_id": "def456...",          -- 写入时的父 Span ID
--     "session_id": "sess_xyz",
--     "task_id": "task_123",
--     "derived_from": ["memory_id_1", "memory_id_2"],  -- 从哪些记忆推断而来
--     "confidence": 0.85                      -- 如果是推断生成的，附置信度
-- }
```

### 7.3 溯源查询 API

```
GET /memory/{memory_id}/provenance
Authorization: Bearer <token>

Response:
{
  "memory_id": "mem-uuid",
  "title": "SQL 性能分析发现",
  "provenance": {
    "origin_agent_id": "orchestrator_001",
    "writing_agent_id": "sub_agent_a_001",
    "trace_id": "abc123def456...",
    "session_id": "sess_xyz",
    "task_id": "task_123",
    "derived_from": ["mem-uuid-2", "mem-uuid-3"],
    "confidence": 0.85
  },
  "access_history": [
    {"agent_id": "sub_agent_b_001", "accessed_at": "2026-03-26T10:15:00Z", "action": "read"},
    {"agent_id": "orchestrator_001", "accessed_at": "2026-03-26T10:20:00Z", "action": "read"}
  ],
  "write_history": [
    {"agent_id": "sub_agent_a_001", "version": 1, "written_at": "2026-03-26T10:00:00Z"},
    {"agent_id": "sub_agent_a_001", "version": 2, "written_at": "2026-03-26T10:05:00Z"}
  ]
}
```

---

## 8. 典型多 Agent 协作场景

### 8.1 场景 A：研究型多 Agent（Shared Pool）

**系统结构**：
```
User Request
    ↓
Orchestrator（编排 Agent）
    ├── Research Agent A（负责技术文档检索）
    ├── Research Agent B（负责代码仓库分析）
    └── Synthesis Agent（整合所有发现，生成报告）
```

**记忆共享流程**：

```python
# 1. Orchestrator 创建共享研究池
pool_id = await ams.create_shared_pool(
    pool_name="research_task_20260326",
    tenant_id=tenant_id,
    members=[
        {"agent_id": "research_agent_a", "can_read": True, "can_write": True},
        {"agent_id": "research_agent_b", "can_read": True, "can_write": True},
        {"agent_id": "synthesis_agent",  "can_read": True, "can_write": False},
    ],
    created_by="orchestrator_001"
)

# 2. Research Agent A 追加技术文档发现到共享池（CRDT 仅追加）
await ams.append_to_pool(
    pool_id=pool_id,
    content="发现关键性能瓶颈：当索引覆盖率低于 60% 时，查询延迟呈指数上升。",
    agent_id="research_agent_a",
    tenant_id=tenant_id
)

# 3. Research Agent B 同时追加代码分析发现（无冲突）
await ams.append_to_pool(
    pool_id=pool_id,
    content="代码库中 3 处热点函数未使用连接池，每次创建新连接耗时 ~200ms。",
    agent_id="research_agent_b",
    tenant_id=tenant_id
)

# 4. Synthesis Agent 从共享池检索所有发现（只读）
findings = await ams.retrieve(
    query="性能问题根因分析",
    agent_id="synthesis_agent",
    tenant_id=tenant_id,
    scope="pool"  # 检索自身 + 有权访问的 Pool
)
```

### 8.2 场景 B：编排型多 Agent（Hierarchical）

**系统结构**：
```
Orchestrator（主 Agent，持有任务全局状态）
    ├── Sub-Agent 1（执行 SQL 分析子任务）
    └── Sub-Agent 2（执行日志分析子任务）
```

**记忆继承流程**：

```python
# 1. 创建任务时，建立层级关系
await ams.create_agent_hierarchy(
    parent_agent_id="orchestrator_001",
    child_agents=["sub_agent_1", "sub_agent_2"],
    tenant_id=tenant_id,
    session_id=current_session_id,    # 会话结束后自动解除
    inherit_read=True,
    inherit_write=False               # 子 Agent 只读 Orchestrator 记忆
)

# 2. Orchestrator 写入全局任务上下文（scope=global，子 Agent 可读）
await ams.store_memory(
    agent_id="orchestrator_001",
    content="任务目标：诊断生产环境 API P99 延迟 > 5s 的根本原因，涉及数据库和日志两个维度。",
    scope="global",
    tenant_id=tenant_id
)

# 3. Sub-Agent 1 检索时，自动拿到 Orchestrator 的全局上下文
context = await ams.retrieve(
    query="当前任务目标",
    agent_id="sub_agent_1",
    tenant_id=tenant_id,
    scope="hierarchy"   # 包含父级 global 记忆
)
# context 中包含 Orchestrator 写入的全局任务目标
```

### 8.3 场景 C：并发竞争写入（乐观锁）

```python
# 两个 Agent 同时尝试更新同一条共享记忆的 importance 分数

# Agent A 读取（version=5），尝试将 importance 从 0.7 更新到 0.9
await ams.update_memory(
    memory_id="shared_mem_123",
    updates={"importance": 0.9},
    agent_id="agent_a",
    tenant_id=tenant_id
)
# → 成功（version 更新为 6）

# Agent B 同时读取（也看到 version=5），尝试将 importance 更新到 0.8
await ams.update_memory(
    memory_id="shared_mem_123",
    updates={"importance": 0.8},
    agent_id="agent_b",
    tenant_id=tenant_id
)
# → version=5 校验失败，重试
# → 重新读取（version=6），重新计算，更新为 0.85（基于最新值）
# → 成功（version 更新为 7）
```

---

## 9. 审计日志

### 9.1 审计日志表

```sql
-- 记忆访问审计日志（不可变，只追加）
CREATE TABLE memory_access_audit (
    audit_id        BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    agent_id        UUID NOT NULL,
    memory_id       UUID,               -- NULL 表示批量/搜索操作
    pool_id         UUID,               -- 涉及的共享池（若有）

    action          VARCHAR(20) NOT NULL,  -- 'read' | 'write' | 'delete' | 'search'
    outcome         VARCHAR(10) NOT NULL,  -- 'allowed' | 'denied'
    denial_reason   TEXT,                  -- denied 时的原因

    -- 请求上下文
    session_id      VARCHAR(64),
    task_id         VARCHAR(64),
    trace_id        VARCHAR(32),
    request_ip      INET,

    -- 审计时间（精确到毫秒）
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)
PARTITION BY RANGE (occurred_at);

-- 按月分区（审计日志量大，分区是必须的）
CREATE TABLE memory_access_audit_2026_03
    PARTITION OF memory_access_audit
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- 仅写入索引（审计查询按 tenant + agent + 时间范围）
CREATE INDEX idx_audit_tenant_agent_time
    ON memory_access_audit(tenant_id, agent_id, occurred_at DESC);
CREATE INDEX idx_audit_memory_id
    ON memory_access_audit(memory_id) WHERE memory_id IS NOT NULL;
```

### 9.2 审计写入

AMS 在每次权限评估后，异步写入审计日志（不阻塞主路径）：

```python
class AuditLogger:
    """异步写入审计日志，不阻塞 AMS 主请求路径"""

    async def log(
        self,
        tenant_id: str,
        agent_id: str,
        action: str,
        outcome: str,
        memory_id: str | None = None,
        pool_id: str | None = None,
        denial_reason: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        trace_id: str | None = None
    ) -> None:
        # 使用 fire-and-forget 模式，不 await
        asyncio.create_task(
            self._write_audit(
                tenant_id=tenant_id,
                agent_id=agent_id,
                action=action,
                outcome=outcome,
                memory_id=memory_id,
                pool_id=pool_id,
                denial_reason=denial_reason,
                session_id=session_id,
                task_id=task_id,
                trace_id=trace_id
            )
        )

    async def _write_audit(self, **kwargs) -> None:
        try:
            await self.pg.execute("""
                INSERT INTO memory_access_audit
                (tenant_id, agent_id, memory_id, pool_id, action, outcome,
                 denial_reason, session_id, task_id, trace_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """, kwargs["tenant_id"], kwargs["agent_id"],
                kwargs.get("memory_id"), kwargs.get("pool_id"),
                kwargs["action"], kwargs["outcome"],
                kwargs.get("denial_reason"), kwargs.get("session_id"),
                kwargs.get("task_id"), kwargs.get("trace_id"))
        except Exception as e:
            # 审计写入失败不影响主业务，但需告警
            logger.error(f"Audit log write failed: {e}")
            metrics.increment("ams.audit.write_failure")
```

---

## 10. Prometheus 指标

| 指标名 | 类型 | 标签 | 说明 |
|---|---|---|---|
| `ams_multi_agent_pool_count` | Gauge | tenant_id | 活跃的共享内存池数量 |
| `ams_multi_agent_pool_members` | Gauge | tenant_id, pool_id | 各池的成员数量 |
| `ams_acl_evaluations_total` | Counter | tenant_id, action, outcome | ACL 评估次数（允许/拒绝）|
| `ams_acl_evaluation_duration_seconds` | Histogram | — | ACL 评估耗时 |
| `ams_concurrent_write_conflicts_total` | Counter | agent_id | 乐观锁冲突次数 |
| `ams_concurrent_write_retries_total` | Counter | agent_id | 乐观锁重试次数 |
| `ams_lock_acquisition_failures_total` | Counter | agent_id | 悲观锁获取超时次数 |
| `ams_cross_agent_retrieval_total` | Counter | tenant_id, scope | 跨 Agent 检索请求数 |
| `ams_cross_agent_retrieval_spaces` | Histogram | — | 每次检索涉及的空间数 |
| `ams_audit_write_failure_total` | Counter | — | 审计日志写入失败次数 |

---

## 11. 上下游数据契约

### 11.1 输入

| 来源 | 接口 | 数据内容 |
|---|---|---|
| **AMS API (01)** | 内部调用 | 所有记忆读写请求，携带 `agent_id` + `scope` 参数 |
| **Agent Framework** | REST API | 创建/查询共享池、层级关系管理、权限授予 |
| **Kafka** `ams.skill.deprecated` | 消费 | 技能废弃通知，触发相关 Pool 的缓存失效 |

### 11.2 输出

| 目标 | 协议/方式 | 数据内容 |
|---|---|---|
| **PostgreSQL** | SQL 写入 | `shared_memory_pools`、`pool_memberships`、`agent_hierarchy`、`memory_acl_rules`、`memory_access_audit` |
| **Redis** | 读写 | Working Memory（Hash Tag 保证同分片）、RYW 缓存、分布式锁 |
| **Prometheus** | HTTP Pull | 多 Agent 协作指标 |

---

*下一步：[07-Deployment 详细设计](./07-Deployment.md) — K8s 完整部署编排、Namespace 划分、资源规划、HPA/VPA 扩缩容策略、备份恢复方案*
