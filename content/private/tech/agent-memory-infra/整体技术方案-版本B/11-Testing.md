---
title: "11-Testing 测试与质量保证"
date: 2026-03-24T00:30:00+08:00
draft: true
tags: ["agent-memory", "testing", "quality", "详细设计", "版本B"]
---

# 测试与质量保证

> **文档类型**: 详细设计
> **版本**: v1.0（版本B）
> **核心职责**: 单元/集成/性能测试策略，以及 CI/CD 质量门禁

---

## 1. 测试策略概览

```
┌──────────────────────────────────────────────────────────────┐
│ 单元测试（Unit Tests）                                        │
│  - 各 Store、Retriever、ConsolidationEngine 的核心逻辑        │
│  - Mock 所有外部依赖（Redis/Milvus/PG/Neo4j）                 │
│  - 目标覆盖率：核心逻辑 > 80%                                 │
├──────────────────────────────────────────────────────────────┤
│ 集成测试（Integration Tests）                                  │
│  - 使用 testcontainers 启动真实 Redis/PostgreSQL              │
│  - 验证 AMS API 端到端（写入→检索→结果正确）                   │
│  - 覆盖主要 Happy Path 和关键 Error Path                      │
├──────────────────────────────────────────────────────────────┤
│ 性能测试（Performance Tests）                                  │
│  - 使用 Locust 模拟并发 Agent 请求                            │
│  - 验证 P99 延迟目标（search < 200ms，working memory < 10ms） │
│  - 确认扩容后线性增长                                          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 单元测试

### 2.1 WorkingMemoryManager

```python
import pytest
from unittest.mock import AsyncMock, patch
from ams.stores.working_memory import WorkingMemoryManager

@pytest.fixture
def mock_redis():
    redis = AsyncMock()
    redis.hgetall.return_value = {
        "task_summary":   "修复CSV乱码",
        "known_facts":    '{"encoding": "gbk"}',
        "context_tokens": "8420"
    }
    return redis

@pytest.mark.asyncio
async def test_get_working_memory_returns_parsed_dict(mock_redis):
    mgr = WorkingMemoryManager(redis=mock_redis)
    result = await mgr.get("agent_001")

    assert result["task_summary"] == "修复CSV乱码"
    assert result["known_facts"] == {"encoding": "gbk"}  # JSON 自动解析
    assert result["context_tokens"] == 8420              # int 类型

@pytest.mark.asyncio
async def test_get_working_memory_returns_none_when_not_exist():
    redis = AsyncMock()
    redis.hgetall.return_value = {}   # Redis HGETALL 返回空 dict 表示 key 不存在
    mgr = WorkingMemoryManager(redis=redis)
    result = await mgr.get("agent_999")
    assert result is None

@pytest.mark.asyncio
async def test_update_working_memory_sets_ttl(mock_redis):
    mgr = WorkingMemoryManager(redis=mock_redis)
    await mgr.update("agent_001", {"known_facts": {"file": "test.csv"}})

    # 验证同时调用了 HSET 和 EXPIRE
    mock_redis.hset.assert_called_once()
    mock_redis.expire.assert_called_once_with("working_memory:agent_001", 3600)
```

### 2.2 混合评分函数

```python
import math
from datetime import datetime, timedelta, timezone
from ams.retrieval.scorer import mixed_score

def test_higher_similarity_wins():
    base_time = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    score_high = mixed_score(0.9, base_time, 5.0, {})
    score_low  = mixed_score(0.5, base_time, 5.0, {})
    assert score_high > score_low

def test_recency_decay():
    recent  = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    old     = datetime.now(tz=timezone.utc) - timedelta(hours=48)
    score_recent = mixed_score(0.8, recent, 5.0, {})
    score_old    = mixed_score(0.8, old,    5.0, {})
    assert score_recent > score_old

def test_importance_boost():
    base_time = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    high_imp  = mixed_score(0.7, base_time, 9.0, {})
    low_imp   = mixed_score(0.7, base_time, 2.0, {})
    assert high_imp > low_imp

def test_score_range_is_0_to_1():
    base_time = datetime.now(tz=timezone.utc)
    score = mixed_score(1.0, base_time, 10.0, {})
    assert 0.0 <= score <= 1.0
```

### 2.3 技能质量门禁

```python
from ams.consolidation.quality_gate import passes_quality_gate

def test_passes_quality_gate_all_good():
    ok, reason = passes_quality_gate(cluster_size=5, success_count=4, avg_turns=3.0)
    assert ok is True

def test_fails_quality_gate_low_success_rate():
    ok, reason = passes_quality_gate(cluster_size=10, success_count=6, avg_turns=3.0)
    assert ok is False
    assert "成功率" in reason

def test_fails_quality_gate_too_few_samples():
    ok, reason = passes_quality_gate(cluster_size=2, success_count=2, avg_turns=3.0)
    assert ok is False
    assert "样本数" in reason

def test_fails_quality_gate_too_complex():
    ok, reason = passes_quality_gate(cluster_size=5, success_count=5, avg_turns=20.0)
    assert ok is False
    assert "步骤数" in reason
```

---

## 3. 集成测试

### 3.1 测试环境搭建（testcontainers）

```python
import pytest
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("pgvector/pgvector:pg15") as pg:
        # 执行 DDL 初始化
        import subprocess
        subprocess.run([
            "psql", pg.get_connection_url(),
            "-f", "db/migrations/V1__init_schema.sql"
        ], check=True)
        yield pg

@pytest.fixture(scope="session")
def redis_container():
    with RedisContainer("redis:7-alpine") as redis:
        yield redis
```

### 3.2 AMS API 端到端测试

```python
import httpx
import pytest

@pytest.mark.asyncio
async def test_write_and_search_episode(ams_client: httpx.AsyncClient):
    """
    写入 Episode → 检索 → 验证返回的 Episode 匹配
    """
    # 1. 写入
    write_resp = await ams_client.post("/api/v1/memory/episodes", json={
        "agent_id":   "test_agent",
        "session_id": "test_sess_001",
        "event_time": "2026-03-23T10:00:00Z",
        "title":      "CSV乱码测试案例",
        "content":    "用 chardet 检测到 gbk 编码，pd.read_csv(encoding='gbk') 解决",
        "importance": 8.0,
        "outcome":    "success",
        "tags":       ["csv", "encoding", "gbk"]
    })
    assert write_resp.status_code == 201
    episode_id = write_resp.json()["data"]["episode_id"]

    # 2. 检索（等 embedding 写入 Milvus，最多等5秒）
    import asyncio
    await asyncio.sleep(2)

    search_resp = await ams_client.post("/api/v1/memory/search", json={
        "query":    "CSV文件乱码怎么处理",
        "agent_id": "test_agent",
        "layers":   ["episode"],
        "top_k":    5
    })
    assert search_resp.status_code == 200
    results = search_resp.json()["data"]["results"]

    # 3. 验证写入的 Episode 在结果中
    found_ids = [r["memory_id"] for r in results]
    assert episode_id in found_ids

    # 4. 验证最高分结果相关性合理（score > 0.5）
    top_result = results[0]
    assert top_result["score"] > 0.5

@pytest.mark.asyncio
async def test_working_memory_lifecycle(ams_client: httpx.AsyncClient):
    """
    Working Memory 的完整生命周期：PUT → GET → PATCH → DELETE → GET(404)
    """
    agent_id = "lifecycle_test_agent"

    # PUT
    r = await ams_client.put(
        f"/api/v1/memory/working/{agent_id}",
        json={"session_id": "s1", "task_summary": "test", "context_tokens": 100}
    )
    assert r.status_code == 200

    # GET
    r = await ams_client.get(f"/api/v1/memory/working/{agent_id}")
    assert r.json()["data"]["task_summary"] == "test"

    # PATCH
    r = await ams_client.patch(
        f"/api/v1/memory/working/{agent_id}",
        json={"known_facts": {"key": "value"}}
    )
    assert r.status_code == 200

    # GET after PATCH
    r = await ams_client.get(f"/api/v1/memory/working/{agent_id}")
    assert r.json()["data"]["known_facts"] == {"key": "value"}
    assert r.json()["data"]["task_summary"] == "test"   # 未被覆盖

    # DELETE
    r = await ams_client.delete(f"/api/v1/memory/working/{agent_id}")
    assert r.status_code == 200

    # GET → 404
    r = await ams_client.get(f"/api/v1/memory/working/{agent_id}")
    assert r.status_code == 404
```

---

## 4. 性能测试

### 4.1 Locust 压测脚本

```python
from locust import HttpUser, task, between
import random

AGENT_IDS = [f"perf_agent_{i:03d}" for i in range(100)]

class AMSSearchUser(HttpUser):
    """
    模拟 Agent 并发检索记忆
    """
    wait_time = between(0.1, 0.5)   # 每个请求间隔 100~500ms

    QUERIES = [
        "CSV文件乱码怎么处理",
        "如何检测文件编码格式",
        "pandas读取中文数据最佳实践",
        "数据清洗中的空值处理",
        "怎么验证DataFrame的完整性",
    ]

    @task(5)   # 权重5：最高频操作
    def search_memory(self):
        self.client.post("/api/v1/memory/search", json={
            "query":    random.choice(self.QUERIES),
            "agent_id": random.choice(AGENT_IDS),
            "layers":   ["episode", "procedural"],
            "top_k":    8
        })

    @task(3)
    def get_working_memory(self):
        agent_id = random.choice(AGENT_IDS)
        self.client.get(f"/api/v1/memory/working/{agent_id}")

    @task(2)
    def update_working_memory(self):
        agent_id = random.choice(AGENT_IDS)
        self.client.patch(f"/api/v1/memory/working/{agent_id}", json={
            "known_facts": {"key": f"value_{random.randint(1,1000)}"}
        })
```

**运行命令**：

```bash
# 100并发用户，10分钟压测
locust -f tests/perf/locustfile.py \
    --host http://agent-memory-system.agent-apps.svc:8080 \
    --users 100 \
    --spawn-rate 10 \
    --run-time 10m \
    --headless \
    --csv results/perf_baseline
```

### 4.2 性能目标与验收标准

| 接口 | 并发 | P50 目标 | P99 目标 | 错误率目标 |
|------|:----:|:-------:|:-------:|:---------:|
| GET working memory | 500 | < 3ms | < 10ms | < 0.1% |
| PATCH working memory | 300 | < 5ms | < 20ms | < 0.1% |
| POST search (5路并行) | 100 | < 80ms | < 200ms | < 1% |
| POST episodes (写入) | 50 | < 50ms | < 150ms | < 0.5% |
| POST knowledge (写入) | 50 | < 100ms | < 300ms | < 1% |

---

## 5. CI/CD 质量门禁

### 5.1 GitHub Actions Workflow

```yaml
# .github/workflows/ams-ci.yml
name: AMS CI

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: {python-version: "3.11"}
      - run: pip install -r requirements-dev.txt
      - run: pytest tests/unit/ -v --cov=ams --cov-report=xml
      - name: Coverage gate
        run: |
          COVERAGE=$(python -c "import xml.etree.ElementTree as ET; \
            tree = ET.parse('coverage.xml'); \
            print(float(tree.getroot().attrib['line-rate']) * 100)")
          echo "Coverage: $COVERAGE%"
          python -c "assert float('$COVERAGE') >= 80, 'Coverage below 80%'"

  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg15
        env:
          POSTGRES_PASSWORD: test
        options: --health-cmd pg_isready --health-interval 5s
      redis:
        image: redis:7-alpine
        options: --health-cmd "redis-cli ping" --health-interval 5s
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements-dev.txt
      - run: pytest tests/integration/ -v --timeout=60
        env:
          DATABASE_URL: postgresql://postgres:test@localhost/postgres
          REDIS_URL: redis://localhost:6379

  quality-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install ruff mypy
      - run: ruff check ams/          # 代码风格
      - run: mypy ams/ --ignore-missing-imports   # 类型检查
```

### 5.2 质量门禁汇总

| 检查项 | 工具 | 通过标准 |
|--------|------|---------|
| 单元测试通过 | pytest | 0 failures |
| 代码覆盖率 | pytest-cov | 核心逻辑 ≥ 80% |
| 集成测试通过 | pytest + testcontainers | 0 failures |
| 代码风格 | ruff | 0 errors |
| 类型检查 | mypy | 0 type errors |
| 安全扫描 | bandit | 无高危漏洞 |

---

*版本B详细设计文档系列完结。*

*导航：[返回概要设计](./00-概要设计.md)*
