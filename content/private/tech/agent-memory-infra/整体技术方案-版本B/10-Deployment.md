---
title: "10-Deployment 部署与运维"
date: 2026-03-24T00:00:00+08:00
draft: true
tags: ["agent-memory", "deployment", "kubernetes", "运维", "详细设计", "版本B"]
---

# 部署与运维

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: Kubernetes 配置、监控告警、扩容策略与故障恢复

---

## 1. 整体部署架构

### 1.1 Kubernetes Namespace 规划

```
k8s-cluster
├── namespace: agent-apps          # 应用层
│   ├── Deployment: agent-framework        (3副本)
│   ├── Deployment: agent-memory-system    (AMS, 3副本)
│   ├── Deployment: skill-mds              (2副本)
│   └── Deployment: memory-pipeline        (MPP, 3副本)
│
├── namespace: middleware          # 中间件层
│   ├── StatefulSet: kafka                 (3 broker)
│   ├── StatefulSet: redis-sentinel        (1主+2从)
│   └── StatefulSet: milvus                (standalone或cluster)
│
├── namespace: data                # 数据层
│   ├── StatefulSet: postgresql            (主从 + pgvector)
│   ├── StatefulSet: neo4j                 (单机或集群)
│   └── StatefulSet: clickhouse            (单机)
│
└── namespace: monitoring          # 监控层
    ├── Deployment: prometheus
    ├── Deployment: grafana
    ├── Deployment: otel-collector         (DaemonSet 模式)
    └── Deployment: alertmanager
```

### 1.2 服务发现（内部 DNS）

| 服务 | 内部 DNS |
|------|---------|
| AMS | `agent-memory-system.agent-apps.svc:8080` |
| Redis | `redis-sentinel.middleware.svc:26379` |
| Milvus | `milvus.middleware.svc:19530` |
| PostgreSQL | `postgresql.data.svc:5432` |
| Neo4j | `neo4j.data.svc:7474` / `:7687` |
| ClickHouse | `clickhouse.data.svc:9000` |
| Kafka | `kafka.middleware.svc:9092` |
| OTel Collector | `otel-collector.monitoring.svc:4317` |

---

## 2. AMS 部署配置

### 2.1 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-memory-system
  namespace: agent-apps
spec:
  replicas: 3
  selector:
    matchLabels:
      app: agent-memory-system
  template:
    metadata:
      labels:
        app: agent-memory-system
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port:   "9090"
    spec:
      containers:
        - name: ams
          image: agent-memory-system:latest
          ports:
            - containerPort: 8080   # HTTP API
            - containerPort: 9090   # Prometheus metrics
          resources:
            requests:
              cpu:    500m
              memory: 1Gi
            limits:
              cpu:    2
              memory: 4Gi
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef: {name: storage-secrets, key: redis-url}
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: {name: storage-secrets, key: pg-url}
            - name: MILVUS_HOST
              value: milvus.middleware.svc
            - name: NEO4J_URI
              value: bolt://neo4j.data.svc:7687
            - name: OSS_ENDPOINT
              valueFrom:
                configMapKeyRef: {name: ams-config, key: oss-endpoint}
          readinessProbe:
            httpGet: {path: /health/ready, port: 8080}
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet: {path: /health/live, port: 8080}
            initialDelaySeconds: 30
            periodSeconds: 10
```

### 2.2 HorizontalPodAutoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ams-hpa
  namespace: agent-apps
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: agent-memory-system
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "200"   # 每 Pod 超过 200 QPS 时扩容
```

---

## 3. MPP 部署配置

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-pipeline
  namespace: agent-apps
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: mpp
          image: memory-pipeline:latest
          resources:
            requests: {cpu: 1, memory: 2Gi}
            limits:   {cpu: 4, memory: 8Gi}    # NER + LLM 内存较大
          env:
            - name: KAFKA_BROKERS
              value: kafka.middleware.svc:9092
            - name: KAFKA_CONSUMER_GROUP
              value: memory-pipeline-workers
            - name: KAFKA_TOPICS
              value: agent.episodes.raw,agent.docs.ingest,agent.evidence.raw
            - name: AMS_URL
              value: http://agent-memory-system.agent-apps.svc:8080
            - name: EMBEDDING_MODEL
              value: text-embedding-3-small
            - name: NER_FAST_MODEL
              value: zh_core_web_sm
            - name: IMPORTANCE_SCORE_LLM
              value: gpt-4o-mini
            - name: CHUNK_SIZE_TOKENS
              value: "512"
```

---

## 4. 健康检查端点

AMS 暴露标准健康检查接口：

```python
# FastAPI 健康检查路由（AMS 内置）

@app.get("/health/live")
async def liveness():
    """
    存活检查：AMS 进程是否正常。
    只检查进程级别，不检查外部依赖。
    """
    return {"status": "alive"}

@app.get("/health/ready")
async def readiness():
    """
    就绪检查：AMS 是否可以处理请求。
    检查所有关键依赖是否可达。
    """
    checks = {}
    all_ok = True

    # Redis
    try:
        await redis.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"
        all_ok = False

    # PostgreSQL
    try:
        await pg.fetchval("SELECT 1")
        checks["postgresql"] = "ok"
    except Exception as e:
        checks["postgresql"] = f"error: {e}"
        all_ok = False

    # Milvus（仅检查连接，不检查数据）
    try:
        connections.get_connection_addr("default")
        checks["milvus"] = "ok"
    except Exception as e:
        checks["milvus"] = f"error: {e}"
        all_ok = False

    status_code = 200 if all_ok else 503
    return JSONResponse(
        {"status": "ready" if all_ok else "degraded", "checks": checks},
        status_code=status_code
    )
```

---

## 5. 扩容策略

### 5.1 各组件扩容方向

| 组件 | 扩容维度 | 触发条件 | 扩容方式 |
|------|---------|---------|---------|
| AMS | 水平（副本数）| CPU > 70% 或 QPS > 200/Pod | HPA 自动 |
| MPP | 水平（副本数）| Kafka consumer lag > 10000 | 手动调整 replicas |
| Redis | 垂直（内存）| 内存使用 > 80% | 升配 + Redis Cluster |
| Milvus | 水平（QueryNode）| 查询延迟 P99 > 200ms | 增加 QueryNode |
| PostgreSQL | 读副本 | 读 QPS 过高 | 增加 Read Replica |
| Neo4j | 垂直（内存/堆）| 图遍历超时 > 10% | 调大 heap |

### 5.2 Milvus 扩容注意事项

Milvus 2.4+ 支持分布式部署（QueryNode 水平扩展）：

```yaml
# milvus-cluster values.yaml（Helm 安装）
queryNode:
  replicas: 3           # 扩容这里提升查询并发
  resources:
    limits: {cpu: 4, memory: 16Gi}

dataNode:
  replicas: 2

indexNode:
  replicas: 2
```

---

## 6. 备份与恢复

### 6.1 各存储备份策略

| 存储 | 备份方式 | 频率 | 保留时间 |
|------|---------|------|---------|
| PostgreSQL | pg_dump + WAL archiving | 全量每日，WAL 连续 | 30天 |
| Neo4j | neo4j-admin dump | 每日 | 14天 |
| Redis | RDB 快照 | 每小时 | 7天（仅会话恢复用）|
| Milvus | Milvus Backup Tool | 每日 | 7天 |
| OSS | OSS 跨区域复制 | 实时 | 按重要性生命周期 |
| ClickHouse | 原生备份 | 每日 | 30天 |

### 6.2 故障恢复流程

**场景1：Redis 故障（Working Memory 丢失）**

```
影响：所有正在执行的 Agent Working Memory 丢失
恢复：Redis Sentinel 自动故障转移（< 30s）
Agent 行为：重新调用 AMS 初始化 Working Memory，任务可能需要部分重做
可接受性：✅ Working Memory 设计为允许丢失（Agent 可重新初始化）
```

**场景2：Milvus 故障**

```
影响：向量检索返回 503，AMS /search 接口降级
降级策略：
  - 返回 PostgreSQL 中的最近 Episode（时间排序，非语义排序）
  - 返回 PostgreSQL 中 success_rate 最高的 active Skill
  - 在响应中标注 "degraded_mode: true"
恢复后：无需补录（数据在 PostgreSQL 中完整）
```

**场景3：PostgreSQL 故障**

```
影响：严重，AMS 核心功能不可用
恢复：从 WAL 或日备份恢复，预计 RTO < 1小时
注意：Milvus 中的向量 ID 和 PostgreSQL 中的记录需要一致
      故障期间写入 Milvus 但未写入 PG 的数据需要清理（MPP 可重放 Kafka）
```

---

## 7. 监控告警汇总

### 7.1 关键监控面板（Grafana）

**AMS 业务指标面板**：
- `/search` API P50/P95/P99 延迟
- 各记忆层检索成功率（episode / procedural / semantic）
- Working Memory 读写 QPS
- Episode 写入 QPS

**技能质量面板**：
- 活跃技能数量
- 各技能成功率趋势（TOP 10 技能）
- 技能降级告警次数

**基础设施面板**：
- Redis 内存使用率、命中率
- Milvus 查询延迟、索引大小
- PostgreSQL 连接数、慢查询数
- Kafka consumer lag（MPP）

### 7.2 核心告警规则

（详细 Prometheus 规则见 06-Agent-TES.md，此处补充存储层告警）

```yaml
groups:
  - name: storage_alerts
    rules:
      # PostgreSQL 连接池耗尽
      - alert: PGConnectionPoolExhausted
        expr: pg_stat_activity_count > 18   # pool max = 20
        for: 5m
        annotations:
          summary: "PostgreSQL 连接池接近耗尽"

      # Redis 内存使用高
      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
        for: 10m
        annotations:
          summary: "Redis 内存使用超过 85%"

      # Milvus 查询延迟高
      - alert: MilvusQueryLatencyHigh
        expr: milvus_query_latency_p99 > 0.5  # > 500ms
        for: 5m
        annotations:
          summary: "Milvus P99 查询延迟超过 500ms"

      # Kafka consumer lag 积压
      - alert: KafkaConsumerLagHigh
        expr: kafka_consumer_lag_sum{group="memory-pipeline-workers"} > 50000
        for: 15m
        annotations:
          summary: "MPP Kafka 消费积压超过 5万条"
```

---

## 8. 环境配置

### 8.1 配置分层

```
configs/
├── base/                    # 所有环境共用的基础配置
│   ├── ams-config.yaml
│   └── mpp-config.yaml
├── dev/                     # 开发环境覆盖
│   └── kustomization.yaml
├── staging/                 # 预发布环境
│   └── kustomization.yaml
└── prod/                    # 生产环境
    └── kustomization.yaml
```

### 8.2 关键配置项对照

| 配置项 | Dev | Prod |
|--------|-----|------|
| AMS replicas | 1 | 3 |
| MPP replicas | 1 | 3 |
| Redis | 单机 | Sentinel（3节点）|
| Milvus | standalone | cluster（3 QueryNode）|
| PostgreSQL | 单机 | 主从（1主2从）|
| Embedding model | text-embedding-3-small | text-embedding-3-small |
| LLM（重要性打分）| gpt-4o-mini | gpt-4o-mini |
| LLM（NER精准）| gpt-4o-mini | gpt-4o-mini |
| CHUNK_SIZE_TOKENS | 512 | 512 |
| Context compress threshold | 80% | 80% |

---

*下一步：[11-Testing 测试与质量保证](./11-Testing.md)*
