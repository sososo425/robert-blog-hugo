---
title: "07-Deployment 详细设计"
date: 2026-03-26T00:00:00+08:00
draft: true
tags: ["agent-memory", "kubernetes", "deployment", "infra", "详细设计", "版本C"]
---

# Deployment 详细设计

> **文档类型**: 详细设计（Detailed Design）
> **版本**: v1.0（版本C）
> **日期**: 2026-03-26
> **状态**: Draft
> **定位**: AMS 全栈 Kubernetes 部署方案——从 Namespace 划分到 StatefulSet 配置、从 HPA 弹性扩缩到备份恢复、从网络策略到全链路可观测性的完整生产运维指南。

---

## 1. 部署架构总览

### 1.1 整体拓扑

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Namespace: agent-memory-app（应用层）                          │    │
│  │                                                                 │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐  │    │
│  │  │  AMS API     │ │ MPP Workers  │ │ TES Agg  │ │Skill-MDS │  │    │
│  │  │ Deployment   │ │ Deployment   │ │Deployment│ │Deployment│  │    │
│  │  │ HPA: 2-10    │ │ HPA: 2-20   │ │  rep: 2  │ │  rep: 2  │  │    │
│  │  └──────┬───────┘ └──────┬───────┘ └────┬─────┘ └────┬─────┘  │    │
│  └─────────┼────────────────┼──────────────┼─────────────┼────────┘    │
│            │                │              │             │              │
│  ┌─────────┼────────────────┼──────────────┼─────────────┼────────┐    │
│  │  Namespace: agent-memory-data（数据层）  │             │        │    │
│  │          │                │              │             │        │    │
│  │  ┌───────▼──────┐  ┌──────▼─────┐  ┌────▼────────┐   │        │    │
│  │  │    Kafka     │  │   Redis    │  │ ClickHouse  │   │        │    │
│  │  │ StatefulSet  │  │  Cluster   │  │ StatefulSet │   │        │    │
│  │  │  3 brokers   │  │  6 nodes   │  │  3 nodes    │   │        │    │
│  │  └──────────────┘  └────────────┘  └─────────────┘   │        │    │
│  │                                                       │        │    │
│  │  ┌──────────────┐  ┌────────────┐  ┌─────────────┐   │        │    │
│  │  │    Neo4j     │  │   Milvus   │  │    ES       │   │        │    │
│  │  │ StatefulSet  │  │StatefulSet │  │ StatefulSet │   │        │    │
│  │  │ 1主 2从      │  │  3 nodes   │  │  3 nodes    │   │        │    │
│  │  └──────────────┘  └────────────┘  └─────────────┘   │        │    │
│  │                                                       │        │    │
│  │  ┌──────────────┐                                     │        │    │
│  │  │  PostgreSQL  │◄────────────────────────────────────┘        │    │
│  │  │ StatefulSet  │                                              │    │
│  │  │  1主 1从     │                                              │    │
│  │  └──────────────┘                                              │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Namespace: agent-memory-obs（可观测性层）                       │    │
│  │  Prometheus │ Grafana │ Alertmanager │ Jaeger │ OpenSearch       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Namespace: agent-memory-agent（Agent 侧，TES Sidecar 注入层）   │    │
│  │  Agent Framework Pods（每个 Pod 自动注入 OTel Collector Sidecar） │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Namespace 划分说明

| Namespace | 用途 | 网络访问 |
|---|---|---|
| `agent-memory-app` | 所有 AMS 应用服务（无状态）| 可访问 data 层；对外暴露 API |
| `agent-memory-data` | 所有有状态数据存储 | 仅允许来自 app 层的入站流量 |
| `agent-memory-obs` | 可观测性组件 | 可访问 app+data 层的 metrics 端点 |
| `agent-memory-agent` | Agent Framework 运行环境 | 仅允许访问 app 层 API；TES Sidecar 输出到 data 层 Kafka |

### 1.3 版本矩阵

| 组件 | 版本 | 部署方式 |
|---|---|---|
| Kubernetes | 1.29+ | 托管集群（EKS/GKE/AKS）|
| AMS API | 应用自定义 | Deployment + HPA |
| MPP Workers | 应用自定义 | Deployment + HPA |
| TES Aggregator | 应用自定义 | Deployment |
| Skill-MDS | 应用自定义 | Deployment + CronJob |
| Redis | 7.2 | StatefulSet（6节点 Cluster）|
| Neo4j | 5.20 | StatefulSet（3节点 Cluster）|
| Milvus | 2.4 | Helm Chart（独立模式）|
| Kafka | 3.7（Kraft 模式）| StatefulSet（3节点）|
| Elasticsearch | 8.14 | StatefulSet（3节点）|
| PostgreSQL | 16 | StatefulSet（1主1从）|
| ClickHouse | 24.3 LTS | StatefulSet（3节点）|

---

## 2. ConfigMap 与 Secret 管理

### 2.1 全局 ConfigMap

```yaml
# ams-config.yaml — 所有应用服务共享的非敏感配置
apiVersion: v1
kind: ConfigMap
metadata:
  name: ams-config
  namespace: agent-memory-app
data:
  # Kafka
  kafka.brokers: "kafka-0.kafka.agent-memory-data.svc:9092,kafka-1.kafka.agent-memory-data.svc:9092,kafka-2.kafka.agent-memory-data.svc:9092"
  kafka.replication.factor: "3"
  kafka.min.insync.replicas: "2"

  # Redis
  redis.cluster.nodes: "redis-0.redis.agent-memory-data.svc:6379,redis-1.redis.agent-memory-data.svc:6379,redis-2.redis.agent-memory-data.svc:6379"
  redis.max.connections: "100"

  # Milvus
  milvus.host: "milvus.agent-memory-data.svc"
  milvus.port: "19530"

  # Elasticsearch
  elasticsearch.hosts: "http://elasticsearch.agent-memory-data.svc:9200"

  # Neo4j
  neo4j.bolt.uri: "neo4j://neo4j.agent-memory-data.svc:7687"

  # LLM
  llm.endpoint: "https://api.openai.com/v1"
  llm.model.default: "gpt-4o"
  llm.model.embedding: "text-embedding-3-small"
  llm.embedding.dimensions: "1536"

  # AMS 行为配置
  ams.working_memory.ttl_seconds: "7200"
  ams.working_memory.max_conv_turns: "50"
  ams.pipeline.trace.min_turns_for_ams: "5"
  ams.retrieval.lightweight.top_k: "50"
  ams.retrieval.agentic.max_rounds: "3"
```

### 2.2 Secret 管理

```yaml
# ams-secrets.yaml — 敏感凭据（生产环境推荐使用 Vault 或 AWS Secrets Manager 注入）
apiVersion: v1
kind: Secret
metadata:
  name: ams-secrets
  namespace: agent-memory-app
type: Opaque
stringData:
  postgres.dsn: "postgresql://ams_user:${PG_PASSWORD}@postgresql.agent-memory-data.svc:5432/ams"
  redis.password: "${REDIS_PASSWORD}"
  neo4j.password: "${NEO4J_PASSWORD}"
  clickhouse.url: "tcp://clickhouse.agent-memory-data.svc:9000"
  llm.api.key: "${OPENAI_API_KEY}"
  jwt.secret: "${JWT_SECRET}"
  milvus.token: "${MILVUS_TOKEN}"
```

> ⚠️ **生产环境最佳实践**：上述 Secret 应通过 **External Secrets Operator** 从 AWS Secrets Manager / HashiCorp Vault 同步，而非直接在 YAML 中明文存储。

---

## 3. 应用层部署（agent-memory-app）

### 3.1 AMS API

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ams-api
  namespace: agent-memory-app
  labels:
    app: ams-api
    version: "1.0.0"
spec:
  replicas: 3   # 初始副本数（HPA 会动态调整）
  selector:
    matchLabels:
      app: ams-api
  template:
    metadata:
      labels:
        app: ams-api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      affinity:
        # Pod 反亲和：同一 Node 上最多一个 AMS API Pod（高可用）
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: ["ams-api"]
                topologyKey: kubernetes.io/hostname
      containers:
        - name: ams-api
          image: registry.internal/ams-api:1.0.0
          ports:
            - name: http
              containerPort: 8080
            - name: grpc
              containerPort: 50051
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          envFrom:
            - configMapRef:
                name: ams-config
            - secretRef:
                name: ams-secrets
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                # 优雅关闭：等待正在处理的请求完成（最长 30s）
                command: ["/bin/sh", "-c", "sleep 5"]
      terminationGracePeriodSeconds: 35

---
# HPA：基于 CPU + 自定义指标（QPS）双维度扩缩
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ams-api-hpa
  namespace: agent-memory-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ams-api
  minReplicas: 2
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
          name: ams_api_requests_per_second   # 自定义指标（Prometheus Adapter 暴露）
        target:
          type: AverageValue
          averageValue: "500"   # 每 Pod 最大 500 QPS
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60    # 扩容决策稳定窗口 60s
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60             # 每 60s 最多扩容 2 个 Pod
    scaleDown:
      stabilizationWindowSeconds: 300   # 缩容决策稳定窗口 5min（避免抖动）
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120            # 每 2min 最多缩容 1 个 Pod

---
apiVersion: v1
kind: Service
metadata:
  name: ams-api
  namespace: agent-memory-app
spec:
  selector:
    app: ams-api
  ports:
    - name: http
      port: 80
      targetPort: 8080
    - name: grpc
      port: 50051
      targetPort: 50051
  type: ClusterIP
```

### 3.2 MPP Workers

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mpp-workers
  namespace: agent-memory-app
  labels:
    app: mpp-workers
spec:
  replicas: 4
  selector:
    matchLabels:
      app: mpp-workers
  template:
    metadata:
      labels:
        app: mpp-workers
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: ["mpp-workers"]
                topologyKey: kubernetes.io/hostname
      containers:
        - name: mpp-worker
          image: registry.internal/mpp-worker:1.0.0
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "4"
              memory: "4Gi"     # Pipeline 需要足够内存做 Embedding 批处理
          envFrom:
            - configMapRef:
                name: ams-config
            - secretRef:
                name: ams-secrets
          env:
            - name: WORKER_CONCURRENCY
              value: "4"          # 每个 Pod 内的并发 Worker 数
            - name: KAFKA_CONSUMER_GROUP
              value: "mpp-workers"
            - name: EMBEDDING_BATCH_SIZE
              value: "32"         # Embedding 模型批处理大小
          readinessProbe:
            exec:
              command: ["python", "-m", "mpp.health_check"]
            initialDelaySeconds: 15
            periodSeconds: 10

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mpp-workers-hpa
  namespace: agent-memory-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mpp-workers
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          # 基于 Kafka 消息积压量扩缩（比 CPU 更精准）
          name: kafka_consumer_lag
          selector:
            matchLabels:
              consumer_group: "mpp-workers"
        target:
          type: AverageValue
          averageValue: "1000"   # 每 Pod 承受最多 1000 条积压消息
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30    # 积压时快速扩容
      policies:
        - type: Pods
          value: 4
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600   # 积压消化后慢慢缩容（防止 rebalance 频繁）
```

### 3.3 TES Aggregator

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tes-aggregator
  namespace: agent-memory-app
  labels:
    app: tes-aggregator
spec:
  replicas: 2   # 固定 2 副本（Kafka Consumer Group 自动分配分区）
  selector:
    matchLabels:
      app: tes-aggregator
  template:
    metadata:
      labels:
        app: tes-aggregator
    spec:
      containers:
        - name: tes-aggregator
          image: registry.internal/tes-aggregator:1.0.0
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
          envFrom:
            - configMapRef:
                name: ams-config
            - secretRef:
                name: ams-secrets
          env:
            - name: KAFKA_CONSUMER_GROUP
              value: "tes-aggregator"
            - name: KAFKA_INPUT_TOPIC
              value: "ams.spans.raw"
            - name: KAFKA_OUTPUT_TOPIC
              value: "ams.trace.ingested"
            - name: SPAN_CACHE_TTL_SECONDS
              value: "3600"
```

### 3.4 Skill-MDS

```yaml
# 常驻服务（技能检索 + 降级检测）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: skill-mds
  namespace: agent-memory-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: skill-mds
  template:
    metadata:
      labels:
        app: skill-mds
    spec:
      containers:
        - name: skill-mds
          image: registry.internal/skill-mds:1.0.0
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          envFrom:
            - configMapRef:
                name: ams-config
            - secretRef:
                name: ams-secrets

---
# 定时挖掘任务（每日 02:00 UTC）
apiVersion: batch/v1
kind: CronJob
metadata:
  name: skill-mining-daily
  namespace: agent-memory-app
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid        # 禁止并发执行（上一次未完成时跳过）
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2              # 失败最多重试 2 次
      activeDeadlineSeconds: 7200  # 最长运行 2 小时
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: skill-mining
              image: registry.internal/skill-mds:1.0.0
              command: ["python", "-m", "skill_mds.mining.run_daily"]
              resources:
                requests:
                  cpu: "2"
                  memory: "4Gi"
                limits:
                  cpu: "4"
                  memory: "8Gi"
              envFrom:
                - configMapRef:
                    name: ams-config
                - secretRef:
                    name: ams-secrets
```

---

## 4. 数据层部署（agent-memory-data）

### 4.1 Kafka（Kraft 模式，无 ZooKeeper）

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: agent-memory-data
spec:
  serviceName: kafka
  replicas: 3
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["kafka"]
              topologyKey: kubernetes.io/hostname   # 强制不同 Node（必须）
      containers:
        - name: kafka
          image: apache/kafka:3.7.0
          ports:
            - containerPort: 9092   # Broker 端口
            - containerPort: 9093   # Controller 端口（Kraft）
          env:
            - name: KAFKA_NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['kafka.node.id']
            - name: KAFKA_PROCESS_ROLES
              value: "broker,controller"
            - name: KAFKA_CONTROLLER_QUORUM_VOTERS
              value: "0@kafka-0.kafka:9093,1@kafka-1.kafka:9093,2@kafka-2.kafka:9093"
            - name: KAFKA_LISTENERS
              value: "PLAINTEXT://:9092,CONTROLLER://:9093"
            - name: KAFKA_LOG_RETENTION_HOURS
              value: "168"        # 7 天日志保留
            - name: KAFKA_LOG_SEGMENT_BYTES
              value: "1073741824" # 1GB 分段
            - name: KAFKA_NUM_PARTITIONS
              value: "12"         # 默认分区数（可按 topic 覆盖）
            - name: KAFKA_DEFAULT_REPLICATION_FACTOR
              value: "3"
            - name: KAFKA_MIN_INSYNC_REPLICAS
              value: "2"
          resources:
            requests:
              cpu: "1"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
          volumeMounts:
            - name: kafka-data
              mountPath: /var/lib/kafka/data
  volumeClaimTemplates:
    - metadata:
        name: kafka-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-ssd      # AWS gp3，高 IOPS
        resources:
          requests:
            storage: 500Gi

---
# Kafka Topic 初始化 Job
apiVersion: batch/v1
kind: Job
metadata:
  name: kafka-topic-init
  namespace: agent-memory-data
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: kafka-topics
          image: apache/kafka:3.7.0
          command:
            - /bin/sh
            - -c
            - |
              # 等待 Kafka 就绪
              sleep 30

              KAFKA_BIN=/opt/kafka/bin
              BROKERS="kafka-0.kafka:9092,kafka-1.kafka:9092,kafka-2.kafka:9092"

              create_topic() {
                $KAFKA_BIN/kafka-topics.sh --bootstrap-server $BROKERS \
                  --create --if-not-exists \
                  --topic "$1" \
                  --partitions "$2" \
                  --replication-factor 3 \
                  --config retention.ms="$3" \
                  --config min.insync.replicas=2
              }

              # AMS 核心 Topics
              create_topic ams.spans.raw         12  604800000   # 7天，高吞吐 Span 流
              create_topic ams.trace.ingested    12  259200000   # 3天，聚合 Trace
              create_topic ams.session.archive    6  259200000   # 3天，会话归档
              create_topic ams.pipeline.structure 12  86400000   # 1天，Pipeline 任务
              create_topic ams.pipeline.indexing  6   86400000   # 1天
              create_topic ams.skill.generate     3   86400000   # 1天，技能生成通知
              create_topic ams.skill.deprecated   3  604800000   # 7天，技能废弃通知
              create_topic ams.memory.decay       3  604800000   # 7天，衰减批次

              echo "All topics created successfully"
```

### 4.2 Redis Cluster（6 节点，3主3从）

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: agent-memory-data
spec:
  serviceName: redis
  replicas: 6     # 3主 + 3从
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["redis"]
              topologyKey: kubernetes.io/hostname
      initContainers:
        # 初始化容器：生成 redis.conf（节点 ID 从 hostname 提取）
        - name: config-init
          image: redis:7.2
          command:
            - /bin/sh
            - -c
            - |
              NODE_ID=$(echo $HOSTNAME | grep -o '[0-9]*$')
              cat > /etc/redis/redis.conf <<EOF
              cluster-enabled yes
              cluster-config-file /data/nodes.conf
              cluster-node-timeout 5000
              appendonly yes
              appendfsync everysec
              auto-aof-rewrite-percentage 100
              auto-aof-rewrite-min-size 64mb
              save 900 1
              save 300 10
              save 60 10000
              maxmemory 48gb
              maxmemory-policy volatile-ttl
              requirepass ${REDIS_PASSWORD}
              masterauth ${REDIS_PASSWORD}
              bind 0.0.0.0
              protected-mode no
              EOF
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: redis.password
          volumeMounts:
            - name: redis-config
              mountPath: /etc/redis
      containers:
        - name: redis
          image: redis:7.2
          command: ["redis-server", "/etc/redis/redis.conf"]
          ports:
            - containerPort: 6379   # Redis 主端口
            - containerPort: 16379  # Redis Cluster 总线端口
          resources:
            requests:
              cpu: "1"
              memory: "8Gi"
            limits:
              cpu: "4"
              memory: "64Gi"    # r6g.2xlarge: 64GB RAM
          volumeMounts:
            - name: redis-data
              mountPath: /data
            - name: redis-config
              mountPath: /etc/redis
      volumes:
        - name: redis-config
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-ssd
        resources:
          requests:
            storage: 100Gi

---
# Redis Cluster 初始化 Job（仅首次部署时运行）
apiVersion: batch/v1
kind: Job
metadata:
  name: redis-cluster-init
  namespace: agent-memory-data
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: redis-cluster-init
          image: redis:7.2
          command:
            - /bin/sh
            - -c
            - |
              # 等待所有 Redis 节点就绪
              for i in 0 1 2 3 4 5; do
                until redis-cli -h redis-$i.redis -p 6379 -a $REDIS_PASSWORD ping; do
                  echo "Waiting for redis-$i..."
                  sleep 2
                done
              done

              # 创建 Cluster（--cluster-replicas 1 = 每个主节点 1 个从节点）
              redis-cli --cluster create \
                redis-0.redis:6379 redis-1.redis:6379 redis-2.redis:6379 \
                redis-3.redis:6379 redis-4.redis:6379 redis-5.redis:6379 \
                --cluster-replicas 1 \
                -a $REDIS_PASSWORD \
                --cluster-yes
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: redis.password
```

### 4.3 Neo4j Cluster

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: neo4j
  namespace: agent-memory-data
spec:
  serviceName: neo4j
  replicas: 3   # 1 Primary + 2 Secondary（读扩展）
  selector:
    matchLabels:
      app: neo4j
  template:
    metadata:
      labels:
        app: neo4j
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["neo4j"]
              topologyKey: kubernetes.io/hostname
      containers:
        - name: neo4j
          image: neo4j:5.20-enterprise
          ports:
            - containerPort: 7687   # Bolt（应用连接）
            - containerPort: 7474   # HTTP（浏览器）
            - containerPort: 6000   # Cluster 通信
            - containerPort: 7000   # Cluster 发现
          env:
            - name: NEO4J_AUTH
              valueFrom:
                secretKeyRef:
                  name: ams-secrets
                  key: neo4j.password
            - name: NEO4J_ACCEPT_LICENSE_AGREEMENT
              value: "yes"
            - name: NEO4J_dbms_mode
              value: "CORE"
            - name: NEO4J_causal__clustering_initial__discovery__members
              value: "neo4j-0.neo4j:5000,neo4j-1.neo4j:5000,neo4j-2.neo4j:5000"
            - name: NEO4J_dbms_memory_heap_initial__size
              value: "16g"
            - name: NEO4J_dbms_memory_heap_max__size
              value: "32g"
            - name: NEO4J_dbms_memory_pagecache_size
              value: "24g"
            # GDS 插件（Leiden 社区检测 + PPR）
            - name: NEO4J_dbms_security_procedures_unrestricted
              value: "gds.*"
            - name: NEO4J_dbms_security_procedures_allowlist
              value: "gds.*"
          resources:
            requests:
              cpu: "4"
              memory: "16Gi"
            limits:
              cpu: "8"
              memory: "64Gi"
          volumeMounts:
            - name: neo4j-data
              mountPath: /data
            - name: neo4j-logs
              mountPath: /logs
            - name: neo4j-plugins
              mountPath: /plugins
          readinessProbe:
            httpGet:
              path: /db/system/cluster/available
              port: 7474
            initialDelaySeconds: 60
            periodSeconds: 10
      initContainers:
        # 下载 GDS 插件
        - name: gds-plugin-download
          image: curlimages/curl:latest
          command:
            - /bin/sh
            - -c
            - |
              curl -L "https://graphdatascience.ninja/neo4j-graph-data-science-2.6.6.jar" \
                -o /plugins/neo4j-graph-data-science.jar
          volumeMounts:
            - name: neo4j-plugins
              mountPath: /plugins
      volumes:
        - name: neo4j-logs
          emptyDir: {}
        - name: neo4j-plugins
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: neo4j-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-ssd
        resources:
          requests:
            storage: 500Gi
```

### 4.4 PostgreSQL（Patroni 高可用）

```yaml
# PostgreSQL 使用 Patroni 实现自动主从切换
# 推荐使用 CloudNativePG Operator 简化部署
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgresql
  namespace: agent-memory-data
spec:
  instances: 2    # 1主 1从
  imageName: ghcr.io/cloudnative-pg/postgresql:16

  storage:
    size: 200Gi
    storageClass: gp3-ssd

  resources:
    requests:
      cpu: "1"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "16Gi"

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "4GB"
      effective_cache_size: "8GB"
      maintenance_work_mem: "512MB"
      checkpoint_completion_target: "0.9"
      wal_buffers: "64MB"
      work_mem: "64MB"
      random_page_cost: "1.1"       # SSD 优化
      effective_io_concurrency: "200"

  bootstrap:
    initdb:
      database: ams
      owner: ams_user
      secret:
        name: ams-secrets

  backup:
    # 启用 WAL 归档到 S3（见 §6 备份方案）
    barmanObjectStore:
      destinationPath: "s3://ams-backup/postgresql"
      s3Credentials:
        accessKeyId:
          name: ams-backup-credentials
          key: access_key_id
        secretAccessKey:
          name: ams-backup-credentials
          key: secret_access_key
      wal:
        compression: gzip
    retentionPolicy: "30d"

  # 启用 RLS 需要以超级用户身份执行初始化
  superuserSecret:
    name: ams-secrets
```

### 4.5 Milvus（Helm 部署）

```yaml
# Milvus values.yaml（Helm Chart 配置）
cluster:
  enabled: true

image:
  all:
    tag: v2.4.0

# 独立组件拆分部署
proxy:
  replicas: 2
  resources:
    requests: {cpu: "500m", memory: "1Gi"}
    limits: {cpu: "2", memory: "2Gi"}

queryNode:
  replicas: 3
  resources:
    requests: {cpu: "2", memory: "8Gi"}
    limits: {cpu: "4", memory: "16Gi"}

indexNode:
  replicas: 2
  resources:
    requests: {cpu: "2", memory: "4Gi"}
    limits: {cpu: "4", memory: "8Gi"}

dataNode:
  replicas: 2
  resources:
    requests: {cpu: "1", memory: "2Gi"}
    limits: {cpu: "2", memory: "4Gi"}

# 外部依赖（使用已有的 Kafka + MinIO/S3）
kafka:
  enabled: false
  external:
    enabled: true
    brokerList: "kafka-0.kafka.agent-memory-data.svc:9092,kafka-1.kafka.agent-memory-data.svc:9092,kafka-2.kafka.agent-memory-data.svc:9092"

minio:
  enabled: false
  external:
    enabled: true
    address: "s3.amazonaws.com"
    bucketName: "ams-milvus"

# etcd（Milvus 内部元数据）
etcd:
  replicaCount: 3
  persistence:
    storageClass: gp3-ssd
    size: 50Gi
```

### 4.6 Elasticsearch

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: agent-memory-data
spec:
  serviceName: elasticsearch
  replicas: 3
  selector:
    matchLabels:
      app: elasticsearch
  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["elasticsearch"]
              topologyKey: kubernetes.io/hostname
      initContainers:
        # 设置 vm.max_map_count（ES 必需）
        - name: sysctl
          image: busybox:1.36
          command: ["sysctl", "-w", "vm.max_map_count=262144"]
          securityContext:
            privileged: true
      containers:
        - name: elasticsearch
          image: docker.elastic.co/elasticsearch/elasticsearch:8.14.0
          ports:
            - containerPort: 9200   # HTTP
            - containerPort: 9300   # Transport（节点间）
          env:
            - name: cluster.name
              value: "ams-es-cluster"
            - name: node.name
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: discovery.seed_hosts
              value: "elasticsearch-0.elasticsearch,elasticsearch-1.elasticsearch,elasticsearch-2.elasticsearch"
            - name: cluster.initial_master_nodes
              value: "elasticsearch-0,elasticsearch-1,elasticsearch-2"
            - name: ES_JAVA_OPTS
              value: "-Xms16g -Xmx16g"
            - name: xpack.security.enabled
              value: "false"      # 内网环境，网络策略保障安全
            - name: indices.memory.index_buffer_size
              value: "20%"
            - name: thread_pool.write.queue_size
              value: "1000"
          resources:
            requests:
              cpu: "2"
              memory: "16Gi"
            limits:
              cpu: "4"
              memory: "32Gi"
          volumeMounts:
            - name: es-data
              mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
    - metadata:
        name: es-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-ssd
        resources:
          requests:
            storage: 1Ti
```

---

## 5. 网络策略（Network Policy）

严格的网络隔离：数据层只允许来自应用层的访问，禁止直接跨 Namespace 访问。

```yaml
# 数据层入站规则：只允许 agent-memory-app Namespace 访问
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: data-layer-ingress
  namespace: agent-memory-data
spec:
  podSelector: {}    # 适用于 data namespace 的所有 Pod
  policyTypes: ["Ingress"]
  ingress:
    # 允许来自应用层的访问
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: agent-memory-app
    # 允许来自可观测性层的 metrics 抓取
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: agent-memory-obs
      ports:
        - port: 9187   # postgres_exporter
        - port: 9114   # elasticsearch_exporter
        - port: 9308   # kafka_exporter
        - port: 9121   # redis_exporter

---
# 应用层出站规则：只允许访问数据层和外部 LLM API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: app-layer-egress
  namespace: agent-memory-app
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    # 允许访问数据层
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: agent-memory-data
    # 允许 DNS 解析
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
    # 允许访问外部 LLM API（HTTPS）
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8      # 禁止访问内网其他段（安全加固）
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
```

---

## 6. 资源规划

### 6.1 节点规格（中等规模：100 Agent，日活）

| 节点池 | 实例类型 | vCPU | RAM | 用途 |
|---|---|---|---|---|
| **app-pool** | m6g.2xlarge | 8 | 32 GB | AMS API / MPP / TES / Skill-MDS |
| **redis-pool** | r6g.2xlarge | 8 | 64 GB | Redis Cluster（6节点）|
| **neo4j-pool** | r6g.2xlarge | 8 | 64 GB | Neo4j（3节点）|
| **es-pool** | r6g.xlarge | 4 | 32 GB | Elasticsearch（3节点）|
| **milvus-pool** | r6g.xlarge | 4 | 32 GB | Milvus QueryNode（3节点）|
| **kafka-pool** | m6g.xlarge | 4 | 16 GB | Kafka（3节点）|
| **pg-pool** | r6g.large | 2 | 16 GB | PostgreSQL + ClickHouse |
| **obs-pool** | m6g.large | 2 | 8 GB | Prometheus / Grafana / Jaeger |

### 6.2 存储规划

| 组件 | 存储类型 | 容量/节点 | IOPS 需求 | 说明 |
|---|---|---|---|---|
| Redis | gp3 SSD | 100 GB | 3000+ | 主要用于 AOF + RDB |
| Neo4j | gp3 SSD | 500 GB | 6000+ | 图数据 + 事务日志 |
| Milvus | gp3 SSD | 500 GB | 3000+ | 向量索引文件（HNSW 大） |
| Kafka | gp3 SSD | 500 GB | 3000+ | 消息日志（7天保留）|
| Elasticsearch | gp3 SSD | 1 TB | 6000+ | 倒排索引 + _source |
| PostgreSQL | gp3 SSD | 200 GB | 3000+ | 数据 + WAL |
| ClickHouse | gp3 SSD | 1 TB | 3000+ | 原始 Span（90天）|

### 6.3 月度成本估算（AWS us-east-1，按需定价参考）

| 资源项 | 数量 | 单价（$/月）| 小计 |
|---|---|---|---|
| app-pool (m6g.2xlarge) | 6 节点 | ~$185 | ~$1,110 |
| redis-pool (r6g.2xlarge) | 6 节点 | ~$370 | ~$2,220 |
| neo4j-pool (r6g.2xlarge) | 3 节点 | ~$370 | ~$1,110 |
| es-pool (r6g.xlarge) | 3 节点 | ~$185 | ~$555 |
| milvus-pool (r6g.xlarge) | 3 节点 | ~$185 | ~$555 |
| kafka-pool (m6g.xlarge) | 3 节点 | ~$93 | ~$279 |
| pg-pool (r6g.large) | 2 节点 | ~$93 | ~$186 |
| obs-pool (m6g.large) | 2 节点 | ~$46 | ~$92 |
| gp3 SSD 存储 (总计约 12TB) | 12 TB | ~$0.08/GB | ~$983 |
| 数据传输、LLM API 等 | — | 估算 | ~$500 |
| **合计（按需）** | — | — | **~$7,590/月** |

> 💡 **成本优化建议**：使用 Savings Plans（承诺 1-3 年）可节省 30-50%，即降至 **~$4,000-5,300/月**。数据层节点适合使用 Reserved Instances。

---

## 7. 备份与恢复方案

### 7.1 备份策略矩阵

| 组件 | RPO | RTO | 备份方法 | 存储位置 | 保留期 |
|---|---|---|---|---|---|
| **PostgreSQL** | < 5 min | < 15 min | WAL 连续归档 + 每日基础备份（CloudNativePG BARMAN）| S3 | 30 天 |
| **Redis** | ~1 s | < 5 min | AOF（everysec）+ RDB 快照（15min）| 本地 PVC + 每日快照到 S3 | 7 天 |
| **Neo4j** | < 1 h | < 30 min | 在线热备份（每小时增量 + 每日全量）| S3 | 14 天 |
| **Milvus** | < 24 h | < 1 h | 快照备份（每日）| S3 | 7 天 |
| **Kafka** | 0（RF=3）| < 10 min | 多副本（无需额外备份）；关键 Topic 启用 MirrorMaker 到备用集群 | — | 7 天日志 |
| **Elasticsearch** | < 24 h | < 1 h | Snapshot to S3 Repository（每日）| S3 | 14 天 |
| **ClickHouse** | < 24 h | < 2 h | clickhouse-backup 工具（每日全量）| S3 | 30 天 |

### 7.2 PostgreSQL 备份（CloudNativePG + BARMAN）

```yaml
# 每日全量备份 Schedule（CloudNativePG 内置）
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgresql-daily
  namespace: agent-memory-data
spec:
  schedule: "0 1 * * *"          # 每日 01:00 UTC
  backupOwnerReference: self
  cluster:
    name: postgresql
  target: prefer-standby          # 优先从从库备份，不影响主库
  method: barmanObjectStore
```

### 7.3 Neo4j 备份 CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: neo4j-backup
  namespace: agent-memory-data
spec:
  schedule: "0 1 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: neo4j-backup
              image: neo4j:5.20-enterprise
              command:
                - /bin/bash
                - -c
                - |
                  DATE=$(date +%Y%m%d_%H%M%S)
                  BACKUP_DIR="/backup/neo4j_$DATE"

                  # 在线热备份（不停机）
                  neo4j-admin database backup \
                    --to-path=$BACKUP_DIR \
                    --database=neo4j \
                    --include-metadata=all \
                    --verbose

                  # 压缩并上传到 S3
                  tar -czf "/tmp/neo4j_$DATE.tar.gz" -C /backup "neo4j_$DATE"
                  aws s3 cp "/tmp/neo4j_$DATE.tar.gz" \
                    "s3://ams-backup/neo4j/neo4j_$DATE.tar.gz"

                  # 清理本地备份（保留最近 2 次）
                  ls -t /backup | tail -n +3 | xargs -I {} rm -rf "/backup/{}"

                  echo "Backup completed: neo4j_$DATE"
              env:
                - name: NEO4J_AUTH
                  valueFrom:
                    secretKeyRef:
                      name: ams-secrets
                      key: neo4j.password
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: ams-backup-credentials
                      key: access_key_id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: ams-backup-credentials
                      key: secret_access_key
              volumeMounts:
                - name: backup-storage
                  mountPath: /backup
          volumes:
            - name: backup-storage
              emptyDir:
                sizeLimit: 50Gi
```

### 7.4 灾难恢复流程（DR Runbook）

```
完整恢复顺序（依赖关系决定顺序）：

1. PostgreSQL（元数据注册表，其他组件依赖）
   → 恢复时间：15 min（从 BARMAN 恢复最近的 Base Backup + WAL 回放）

2. Redis（Working Memory，无持久数据，直接启动即可）
   → 恢复时间：5 min（重建 Cluster，Working Memory 为 TTL 数据，允许丢失）

3. Elasticsearch（全文索引，可从 PG 重建）
   → 恢复时间：30 min（从 S3 Snapshot 恢复；若快照不可用，从 PG 重建索引需 ~2h）

4. Neo4j（知识图谱）
   → 恢复时间：30 min（从 S3 归档恢复 + 回放增量备份）

5. Milvus（向量存储）
   → 恢复时间：1 h（从 S3 快照恢复，大文件传输耗时）

6. 应用层服务（AMS API / MPP / TES / Skill-MDS）
   → 恢复时间：5 min（Deployment 重新调度）

总 RTO 估算：< 2 h（并行恢复可进一步缩短）
```

---

## 8. 可观测性（Observability）

### 8.1 监控指标体系（Prometheus + Grafana）

```yaml
# Prometheus 采集配置（ServiceMonitor for all AMS components）
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ams-service-monitor
  namespace: agent-memory-obs
spec:
  selector:
    matchLabels:
      monitoring: ams
  namespaceSelector:
    matchNames:
      - agent-memory-app
      - agent-memory-data
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
```

**核心告警规则**：

```yaml
groups:
  - name: ams_sla_alerts
    rules:
      # ① 工作记忆延迟超 SLA
      - alert: WorkingMemoryLatencyHigh
        expr: histogram_quantile(0.99, rate(ams_working_memory_duration_seconds_bucket[5m])) > 0.05
        for: 5m
        labels: {severity: critical}
        annotations:
          summary: "Working Memory p99 > 50ms (SLA breach)"

      # ② 长期记忆检索延迟超 SLA
      - alert: LTMRetrievalLatencyHigh
        expr: histogram_quantile(0.95, rate(ams_retrieval_duration_seconds_bucket{mode="lightweight"}[5m])) > 0.2
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "LTM Retrieval p95 > 200ms (SLA breach)"

      # ③ Pipeline 消息积压
      - alert: PipelineConsumerLagHigh
        expr: kafka_consumer_lag{consumer_group="mpp-workers"} > 50000
        for: 10m
        labels: {severity: warning}
        annotations:
          summary: "MPP Worker consumer lag > 50K (pipeline backlog)"

      # ④ Redis 内存压力
      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
        for: 10m
        labels: {severity: warning}
        annotations:
          summary: "Redis memory usage > 85%"

      # ⑤ Neo4j 磁盘压力
      - alert: Neo4jDiskHigh
        expr: (node_filesystem_size_bytes{mountpoint="/data"} - node_filesystem_free_bytes{mountpoint="/data"}) / node_filesystem_size_bytes{mountpoint="/data"} > 0.8
        for: 5m
        labels: {severity: critical}
        annotations:
          summary: "Neo4j disk usage > 80%"

      # ⑥ PostgreSQL 连接池耗尽
      - alert: PostgreSQLConnectionsHigh
        expr: pg_stat_activity_count > 180    # max_connections=200，预留 20 个系统连接
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "PostgreSQL connections near limit ({{ $value }}/200)"

      # ⑦ AMS API 错误率突增
      - alert: AMSAPIErrorRateHigh
        expr: rate(http_requests_total{job="ams-api", status=~"5.."}[5m]) / rate(http_requests_total{job="ams-api"}[5m]) > 0.05
        for: 5m
        labels: {severity: critical}
        annotations:
          summary: "AMS API 5xx error rate > 5%"
```

### 8.2 分布式追踪（Jaeger）

```yaml
# Jaeger Operator 部署
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: ams-jaeger
  namespace: agent-memory-obs
spec:
  strategy: production
  collector:
    replicas: 2
    resources:
      requests: {cpu: "500m", memory: "512Mi"}
      limits: {cpu: "1", memory: "1Gi"}
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: http://elasticsearch.agent-memory-data.svc:9200
        index-prefix: jaeger
  query:
    replicas: 1
    ingress:
      enabled: true
      hosts:
        - jaeger.ams.internal
```

所有 AMS 应用服务通过 OTel SDK 自动上报 Trace：

```python
# AMS 应用侧 OTel 初始化（统一入口）
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

def init_tracing(service_name: str):
    provider = TracerProvider()
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint="http://ams-jaeger-collector.agent-memory-obs.svc:4317"
            )
        )
    )
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)
```

### 8.3 Grafana Dashboard 结构

| Dashboard | 核心面板 | 受众 |
|---|---|---|
| **AMS Overview** | QPS、延迟 p50/p95/p99、错误率、在线 Agent 数 | 值班工程师 |
| **Working Memory** | Redis 命中率、内存使用率、TTL 过期速率、会话活跃数 | 存储工程师 |
| **Pipeline Health** | Kafka 积压（各 Topic）、Worker 处理速率、Embedding 延迟、失败率 | Pipeline 工程师 |
| **Storage Engines** | Neo4j 节点/边总量、Milvus 向量数、ES 索引大小、PG 慢查询 | 存储工程师 |
| **Skill-MDS** | 技能总数（按状态）、挖掘成功率、技能成功率分布、降级告警数 | 业务工程师 |
| **Multi-Agent** | ACL 拒绝率、并发冲突率、共享池活跃数 | 业务工程师 |
| **Cost & Capacity** | 各节点池 CPU/内存使用率、存储增长趋势、资源利用率热力图 | 架构师 |

---

## 9. 滚动升级策略

### 9.1 应用层滚动升级

```yaml
# Deployment 滚动升级配置
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0     # 升级期间不减少可用 Pod 数（保证无损）
      maxSurge: 1           # 最多多启动 1 个新 Pod（控制资源峰值）
```

**升级顺序**（依赖关系约束）：

```
1. TES Aggregator（无状态，可先升级）
2. MPP Workers（无状态，Kafka 保证消息不丢失）
3. Skill-MDS（无状态，暂停 CronJob 避免挖掘任务与升级冲突）
4. AMS API（最后升级，用户流量层；确保上游数据层先就绪）
```

### 9.2 数据层滚动升级

数据层升级需要更谨慎，遵循以下原则：

| 组件 | 升级方式 | 注意事项 |
|---|---|---|
| **Redis** | 节点逐个滚动（先从库后主库）| 升级前确保 AOF 完成 fsync |
| **Neo4j** | 先滚动 Secondary，最后升级 Primary | Cluster 模式支持在线升级 |
| **PostgreSQL** | CloudNativePG 自动管理（先从库后 Switchover）| 确认应用支持短暂的写入延迟 |
| **Kafka** | 逐 Broker 滚动（确保 Leader 不在被升级节点上）| 升级前执行 Preferred Leader Election |
| **Elasticsearch** | 逐节点滚动 | 升级前禁用 shard rebalancing |
| **Milvus** | 先升级 DataNode/IndexNode，最后 Proxy | 确认所有 segment 已 sealed |

### 9.3 Schema 迁移策略

数据库 Schema 变更遵循**向前兼容（Forward Compatible）**原则，确保新代码和旧代码能同时运行：

```python
# 使用 Alembic 管理 PostgreSQL Schema 迁移
# 迁移策略：添加新列时设置默认值，删除旧列分两步走

# Step 1（当前版本）：添加新列，保留旧列
op.add_column('memory_records',
    sa.Column('scope', sa.String(20), nullable=False,
              server_default='private'))   # 默认值确保旧数据兼容

# Step 2（下一个版本，旧代码已全量退出）：删除旧列
# op.drop_column('memory_records', 'old_column')
```

---

## 10. 初始化部署顺序

首次在新集群部署 AMS 的完整步骤：

```bash
#!/bin/bash
# deploy.sh — AMS 完整部署脚本

set -euo pipefail

NAMESPACE_APP="agent-memory-app"
NAMESPACE_DATA="agent-memory-data"
NAMESPACE_OBS="agent-memory-obs"

echo "=== Step 1: 创建 Namespace ==="
kubectl create namespace $NAMESPACE_APP  --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace $NAMESPACE_DATA --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace $NAMESPACE_OBS  --dry-run=client -o yaml | kubectl apply -f -

# 为 Namespace 打标签（Network Policy 依赖）
kubectl label namespace $NAMESPACE_APP  kubernetes.io/metadata.name=$NAMESPACE_APP  --overwrite
kubectl label namespace $NAMESPACE_DATA kubernetes.io/metadata.name=$NAMESPACE_DATA --overwrite
kubectl label namespace $NAMESPACE_OBS  kubernetes.io/metadata.name=$NAMESPACE_OBS  --overwrite

echo "=== Step 2: 应用 ConfigMap & Secret ==="
kubectl apply -f k8s/config/ams-config.yaml    -n $NAMESPACE_APP
kubectl apply -f k8s/config/ams-secrets.yaml   -n $NAMESPACE_APP

echo "=== Step 3: 部署数据层 ==="
kubectl apply -f k8s/data/kafka-statefulset.yaml       -n $NAMESPACE_DATA
kubectl apply -f k8s/data/redis-statefulset.yaml       -n $NAMESPACE_DATA
kubectl apply -f k8s/data/neo4j-statefulset.yaml       -n $NAMESPACE_DATA
kubectl apply -f k8s/data/postgresql-cluster.yaml      -n $NAMESPACE_DATA
kubectl apply -f k8s/data/clickhouse-statefulset.yaml  -n $NAMESPACE_DATA
kubectl apply -f k8s/data/elasticsearch-statefulset.yaml -n $NAMESPACE_DATA

echo "=== 等待数据层就绪（约 3 分钟）==="
kubectl rollout status statefulset/kafka          -n $NAMESPACE_DATA --timeout=300s
kubectl rollout status statefulset/redis          -n $NAMESPACE_DATA --timeout=300s
kubectl rollout status statefulset/neo4j          -n $NAMESPACE_DATA --timeout=300s
kubectl rollout status statefulset/elasticsearch  -n $NAMESPACE_DATA --timeout=300s

echo "=== Step 4: Milvus（Helm）==="
helm repo add milvus https://zilliztech.github.io/milvus-helm/
helm repo update
helm upgrade --install milvus milvus/milvus \
  -n $NAMESPACE_DATA \
  -f k8s/data/milvus-values.yaml \
  --wait --timeout 300s

echo "=== Step 5: 数据层初始化 ==="
kubectl apply -f k8s/data/kafka-topic-init-job.yaml -n $NAMESPACE_DATA
kubectl wait --for=condition=complete job/kafka-topic-init -n $NAMESPACE_DATA --timeout=120s

kubectl apply -f k8s/data/redis-cluster-init-job.yaml -n $NAMESPACE_DATA
kubectl wait --for=condition=complete job/redis-cluster-init -n $NAMESPACE_DATA --timeout=120s

# PostgreSQL Schema 迁移
kubectl apply -f k8s/data/pg-migration-job.yaml -n $NAMESPACE_DATA
kubectl wait --for=condition=complete job/pg-migration -n $NAMESPACE_DATA --timeout=120s

echo "=== Step 6: 应用 Network Policy ==="
kubectl apply -f k8s/network/data-layer-ingress.yaml -n $NAMESPACE_DATA
kubectl apply -f k8s/network/app-layer-egress.yaml   -n $NAMESPACE_APP

echo "=== Step 7: 部署应用层 ==="
kubectl apply -f k8s/app/tes-aggregator-deployment.yaml -n $NAMESPACE_APP
kubectl apply -f k8s/app/mpp-workers-deployment.yaml    -n $NAMESPACE_APP
kubectl apply -f k8s/app/skill-mds-deployment.yaml      -n $NAMESPACE_APP
kubectl apply -f k8s/app/ams-api-deployment.yaml        -n $NAMESPACE_APP
kubectl apply -f k8s/app/hpa.yaml                       -n $NAMESPACE_APP

echo "=== Step 8: 部署可观测性层 ==="
kubectl apply -f k8s/obs/prometheus-operator.yaml -n $NAMESPACE_OBS
kubectl apply -f k8s/obs/grafana-deployment.yaml  -n $NAMESPACE_OBS
kubectl apply -f k8s/obs/jaeger-operator.yaml     -n $NAMESPACE_OBS
kubectl apply -f k8s/obs/service-monitors.yaml    -n $NAMESPACE_OBS
kubectl apply -f k8s/obs/alert-rules.yaml         -n $NAMESPACE_OBS

echo "=== 等待应用层就绪 ==="
kubectl rollout status deployment/ams-api       -n $NAMESPACE_APP --timeout=180s
kubectl rollout status deployment/mpp-workers   -n $NAMESPACE_APP --timeout=180s
kubectl rollout status deployment/tes-aggregator -n $NAMESPACE_APP --timeout=180s
kubectl rollout status deployment/skill-mds     -n $NAMESPACE_APP --timeout=180s

echo "=== 部署完成！ ==="
kubectl get pods -n $NAMESPACE_APP
kubectl get pods -n $NAMESPACE_DATA
```

---

## 附录：健康检查端点

| 服务 | 端点 | 含义 |
|---|---|---|
| AMS API | `GET /healthz/live` | 进程存活（Liveness）|
| AMS API | `GET /healthz/ready` | 服务就绪，所有依赖连接正常（Readiness）|
| AMS API | `GET /healthz/startup` | 启动完成（Startup，慢启动场景）|
| MPP Worker | `python -m mpp.health_check` | 消费者组正常，Kafka 连接存活 |
| TES Aggregator | `GET /health` | Redis + Kafka 连接正常 |
| Skill-MDS | `GET /health` | PG + Milvus + Neo4j 连接正常 |

**`/healthz/ready` 检查逻辑**：

```python
@app.get("/healthz/ready")
async def readiness_check():
    checks = {}
    # 检查所有依赖
    checks["redis"]         = await check_redis_ping()
    checks["postgres"]      = await check_pg_connection()
    checks["kafka_produce"] = await check_kafka_producer()
    checks["milvus"]        = await check_milvus_health()
    checks["neo4j"]         = await check_neo4j_connection()

    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise HTTPException(
            status_code=503,
            detail={"status": "not_ready", "failed": failed}
        )
    return {"status": "ready", "checks": checks}
```

---

*至此，版本C全部7个详细设计模块已完成：*
*01-AMS · 02-Pipeline · 03-Storage · 04-TES · 05-Skill-MDS · 06-Multi-Agent · 07-Deployment*
