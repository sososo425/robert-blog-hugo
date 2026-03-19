---
title: "首个大规模记忆平台MemoryLake发布"
source: "https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhkuccm2951362.shtml"
author:
published: 2026-02-05
created: 2026-03-20
description: "2026年02月05日 15:38:082026年2月——在AI技术从感知智能迈向认知智能的关键转折点上，质变科技正式发布了具备超大规模实践能力的多模态记忆平台——MemoryLake。该平台首次将“多模态内容深度理解、多模态记忆存储、记忆..."
tags:
  - "clippings"
---
2026年02月05日 15:38:08

2026年2月——在AI技术从感知智能迈向认知智能的关键转折点上， 质变科技正式发布了具备超大规模实践能力的多模态记忆平台——MemoryLake。 该平台首次将“多模态内容深度理解、多模态记忆存储、记忆计算与管理”全栈能力融于一体，由 MemoryLake-D1 大模型、MemoryLake 记忆引擎和多模态存储与计算平台（Relyt Multi-modal Data Cloud）构成。MemoryLake 旨在解决当前企业AI落地面临的诸多根本挑战，包括“多模态信息难以理解与融合”“数据碎片化导致记忆断层”“模型决策不准确不可靠”“大模型调用成本高”“企业数据规模庞大却响应迟缓” 等痛点。这一产品的发布标志着AI基础设施正式从“以数据为中心”迈入“以记忆为中心”的新阶段。

认知计算范式演进：从处理数据到处理记忆

当前企业级AI应用普遍面临一个根本矛盾：大型语言模型具备强大的生成能力，却难以在复杂业务场景中给出准确、持续、可解释的行动级决策。根源在于，现有系统仍是围绕“数据”而构建，而非围绕“记忆”构建。正如质变科技CEO占超群所说：“传统计算系统处理的是行为记录，而记忆计算系统处理的是决策轨迹——这是智能体网络（Agent Network）的基础”。

从传统计算到认知计算，这一理念体现在三个根本性的范式转变上：

1.架构设计转向认知状态记忆为中心

认知状态记忆是一等公民（First-Class State），认知状态记忆是系统在某一时刻，对“我在做什么、我知道什么、我假设什么、我不确定什么”的结构化内部表征。

2.系统核心从“管理数据记录”转向“构建多模态认知状态记忆”

以多模态存储与计算平台为基石、大模型为数据深度理解引擎、支持高准确度和自演进的记忆管理与计算引擎为系统核心，未来技术竞争的关键在于记忆的多模态、准确性、可追溯、反思以及自演进能力。

3.基础设施转向记忆管理

从“数据的存储、计算与管理”转向“记忆的存储、计算与管理”。正如云时代催生了 Snowflake 与 Databricks，AI 时代也将诞生以“记忆”为核心的新一代基础设施平台。质变科技此次通过 MemoryLake 初步定义了这一新兴赛道，在行业中率先践行记忆驱动的技术路线。

MemoryLake架构：三大核心技术组件

为了构建完整的“记忆计算”能力栈，MemoryLake 包含三大核心技术组件，打通了记忆的提取、存储、管理与计算全流程：

MemoryLake-D1 大模型：专注多模态记忆理解与提取

传统通用大模型在处理复杂表格、多层级文档以及多模态数据如音视频等企业数据时往往力不从心。而 MemoryLake-D1 是业内首个专注于多模态“记忆”理解与结构化提取转换的领域大模型。它能够深度解析包含多子表、多布局、多层级的复杂 Excel、PDF 以及图文混排文档，从中抽取规范化的知识，转化为可被系统理解和计算的“记忆单元”。

在实际测试中，D1 模型可以执行诸如“从多日票务数据中提取指定日期的出票量，按客户分组汇总，并跨日对比分析”的复杂指令，直接输出可执行代码和结构化结果，将原本需要人工耗时数日的报表整理与数据洞察工作缩短至分钟级。该模型在权威的表格理解评测（TableBench/EOB）中表现出全球领先的准确率，充分证明了其在复杂企业数据处理方面的能力。

MemoryLake 记忆引擎：实现类人方式的记忆组织与演进

记忆引擎是平台的核心“大脑”，承担着智能化组织记忆、动态更新知识以及高效检索调用的任务。其创新之处在于类人记忆管理机制的实现：

● 记忆组织： 通过概念关联网络、多层次动态知识图谱和语义聚类、多层次向量等手段，像人脑一样在不同知识之间建立联系，支撑复杂的多跳推理；

● 记忆管理和计算： 内置记忆演化追踪、时间线回溯、冲突智能合并以及基于遗忘曲线的优化机制，确保记忆库随着时间推移能够自动淘汰噪音、保留高价值内容；

● 记忆取用： 在检索时，支持亚秒级的多跳推理查询和跨概念关联查找，并依据权限矩阵保障安全访问。引擎返回的是上下文友好、精炼且完整的记忆片段，而非杂乱冗长、逻辑冲突的原始全文，平均降低90%以上的 Token 消耗和计算成本。

![](https://n.sinaimg.cn/spider20260205/254/w650h404/20260205/4657-64d4205fe9678d780d04c5c23d86dea7.jpg)

在极具挑战性的长程对话记忆基准测试 LoCoMo 上（需在平均300轮、跨数月、多模态内容的超长对话中进行精准信息整合与推理），MemoryLake记忆引擎以94.0%的综合得分位列全球第一，显著超越其他记忆方案及人类标注基线。

多模态数据平台（Relyt Multi-modal Data Cloud）：超大规模记忆的持久化基石

这一组件提供对“记忆”的持久化存储与分布式管理支持。MemoryLake 记忆库能够无缝接入各种数据类型，包括结构化数据、非结构化文档（如 PDF、Word、Markdown）、图片、音频、视频，以及来自第三方系统或数据库的在线数据。

该平台具备超大规模承载能力——在生产环境中已成功管理由 10万亿+ 条记录和 1亿+ 份文档组成的海量记忆库，同时仍保持毫秒级检索延迟。此外，它提供完善的企业级治理能力，包括记忆溯源、版本控制、权限管控与合规审计，确保每一条记忆的来源可追溯、推理路径可解释、操作过程可干预。这些机制使得 MemoryLake 能作为可信赖的长期记忆中枢嵌入企业业务，满足严苛的安全与合规要求。

多行业应用案例：记忆驱动业务新范式

MemoryLake 所打造的“记忆计算”能力，正在各行各业催生全新的智能应用范式：

复杂决策场景： 在企业高管决策支持中，MemoryLake 可连接企业内外部数据源，构建领域知识记忆。当用户提出“分析某项目历史风险与当前市场趋势”这样的复杂请求时，系统会自动关联相关的项目文档、沟通记录和行业报告，进行多源信息的推理整合，并生成附有证据链的决策建议，将传统长达数周的人工作业分析周期压缩至小时级。由此，企业决策的响应速度和质量实现飞跃式提升。

动态交互场景（游戏/泛娱乐）： 在沉浸式游戏中，MemoryLake 能为 AI NPC 构建持续演进的“世界观记忆”和“玩家记忆”。NPC 不仅记住玩家过去做出的每一个关键选择和成就，还能基于这些记忆进行多跳推理，动态生成符合玩家历史行为的对话与剧情，真正实现了“千人千面”的个性化互动体验。每位玩家都将面对一个有记忆、可成长的NPC角色，游戏体验因此更加真实生动。

运营与风控场景： 在制造业运营或金融风控中，MemoryLake 可整合跨系统、跨时间的“制造记忆”或“交易记忆”，实现质量问题的根因秒级定位，或金融交易风险的实时研判与预警。这意味着过去需要大量人工排查分析的任务，如生产事故调查或异常交易检测，如今能够由AI在瞬时完成，为企业赢得宝贵的响应时间和决策先机。

市场与基础设施级意义：时代的分水岭

[![广告](https://n.sinaimg.cn/news/42f7389d/20190523/JiJin300x250.jpg)](http://saxn.sina.com.cn/click?type=bottom&t=UERQUzAwMDAwMDA1NjA1NA%3D%3D&url=https%3A%2F%2Ffinance.sina.com.cn%2Fmobile%2Fcomfinanceweb.shtml%3Fsource%3DPDPS000000056054&sign=4280fc75d6aa9b13)

MemoryLake 平台能力已经在超大规模实践中得到验证，并引领着多行业的智能化升级。目前，MemoryLake 已服务全球超过 150万 专业用户和 15,000 家企业客户，行业覆盖金融、工业制造、游戏、教育、法律、电商等。与市场上其他同类方案相比，MemoryLake 在长期记忆能力、多模态支持、记忆演化管理、平台扩展性、企业级安全合规等方面均展现出显著优势，奠定了其在新兴“多模态记忆平台”赛道中的领先地位。

质变科技创始人表示：“AI 的未来是记忆驱动的未来。企业需要的不是一个更大的模型，而是一个更懂业务、更能积累、更善推理与反思的‘记忆系统’。MemoryLake 的发布，是我们将‘记忆即智能’这一理念转化为企业级认知基础设施的关键一步。我们期待与生态伙伴一起，加速认知计算时代的到来。”这一里程碑式的产品发布，被业界视为 AI 技术发展史上的重要分水岭——它标志着AI基础设施范式正从数据驱动跨越到记忆驱动，一个全新的认知计算时代已然开启。

关于质变科技：质变科技是领先的多模态 AI 记忆平台服务商，致力于通过“记忆计算 + 记忆存储 + 记忆管理”的一体化技术栈，构建以记忆为中心的新一代 AI 基础设施。其核心产品 MemoryLake 已在超大规模场景下完成实践验证，助力各行业客户实现从数据驱动到记忆驱动的智能化跃迁。

 [![新浪众测](https://n.sinaimg.cn/tech/zcapp2018/doc_qrcode1.png "新浪众测") ![新浪众测](https://n.sinaimg.cn/tech/zcapp2018/doc_qrcode2.png "新浪众测")](http://zhongce.sina.com.cn/about/app?frompage=doc)

![新浪科技公众号](https://n.sinaimg.cn/tech/content/tech_qr2x.png "新浪科技公众号") 新浪科技公众号

“掌”握科技鲜闻 （微信搜索techsina或扫描左侧二维码关注）

![](https://n.sinaimg.cn/tech/content/tech_weixin2.png)

### 创事记

- [![](https://n.sinaimg.cn/front20260205ac/481/w898h383/20260205/2793-a9800e312975c87914f534c27a745132.jpg)](https://finance.sina.com.cn/tech/csj/2026-02-05/doc-inhktfxv3179505.shtml)
	[微信封禁自家“兄弟”红包，打的什么牌？](https://finance.sina.com.cn/tech/csj/2026-02-05/doc-inhktfxv3179505.shtml)
- [![](https://n.sinaimg.cn/finance/crawl/60/w550h310/20260118/278d-c92ff5625eab6eca68d91878d59a6e2d.png)](https://finance.sina.com.cn/tech/csj/2026-01-18/doc-inhhthyv8769042.shtml)
	[华住，比携程还会捞金？](https://finance.sina.com.cn/tech/csj/2026-01-18/doc-inhhthyv8769042.shtml)
- [![](https://n.sinaimg.cn/finance/crawl/459/w550h709/20260113/3b1a-1ede65d0ad92f7721a7e73dac58715eb.jpg)](https://finance.sina.com.cn/tech/csj/2026-01-13/doc-inhhcxir5996812.shtml)
	[2026，大家都是木头姐](https://finance.sina.com.cn/tech/csj/2026-01-13/doc-inhhcxir5996812.shtml)

- [微信封禁自家“兄弟”红包，打的什么牌？](https://finance.sina.com.cn/tech/csj/2026-02-05/doc-inhktfxv3179505.shtml "微信封禁自家“兄弟”红包，打的什么牌？")
- [华住，比携程还会捞金？](https://finance.sina.com.cn/tech/csj/2026-01-18/doc-inhhthyv8769042.shtml "华住，比携程还会捞金？")
- [2026，大家都是木头姐](https://finance.sina.com.cn/tech/csj/2026-01-13/doc-inhhcxir5996812.shtml "2026，大家都是木头姐")

- 01 [马化腾谈腾讯免费安装 OpenClaw 引排队：没想到会这么火](https://finance.sina.com.cn/tech/digi/2026-03-08/doc-inhqhyqf0485392.shtml "马化腾谈腾讯免费安装")
- 02 [中国最强地级市机场梦又碎了：GDP超2万亿 不建原因揭秘](https://finance.sina.com.cn/tech/roll/2026-03-09/doc-inhqivtv0024921.shtml "中国最强地级市机场梦又碎了：GDP超2万亿")
- 03 [AI冲击大学教育太震撼！中国传媒大学砍掉16个本科专业 直言教育要面向人机分工时代](https://finance.sina.com.cn/tech/roll/2026-03-09/doc-inhqizzu7093721.shtml "AI冲击大学教育太震撼！中国传媒大学砍掉16个本科专业")
- 04 [隆基绿能董事长：建议将8小时工作制缩短为7小时 大幅提高加班工资](https://finance.sina.com.cn/tech/roll/2026-03-09/doc-inhqizzu7147951.shtml "隆基绿能董事长：建议将8小时工作制缩短为7小时")
- 05 [马化腾回应腾讯免费安装OpenClaw排队盛况：没想到会这么火](https://finance.sina.com.cn/tech/roll/2026-03-09/doc-inhqirmx0149513.shtml "马化腾回应腾讯免费安装OpenClaw排队盛况：没想到会这么火")

- [微信封禁自家“兄弟”红包，打的什么牌？](https://finance.sina.com.cn/tech/csj/2026-02-05/doc-inhktfxv3179505.shtml "微信封禁自家“兄弟”红包，打的什么牌？")
- [SpaceX与xAI合并后 马斯克身家突破8000亿美元](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktfxv3164288.shtml "SpaceX与xAI合并后 马斯克身家突破8000亿美元")
- [女子花200元独享一架客机 川航回应：就她一个人 可随到随走](https://finance.sina.com.cn/tech/discovery/2026-02-05/doc-inhksrac3460966.shtml "女子花200元独享一架客机 川航回应：就她一个人 可随到随走")
- [苹果iPad出货量无敌：超第2-4名之和](https://finance.sina.com.cn/tech/discovery/2026-02-04/doc-inhksena2862038.shtml "苹果iPad出货量无敌：超第2-4名之和")
- [百度文心红包被微信屏蔽：已改为口令红包](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktfxq2407795.shtml "百度文心红包被微信屏蔽：已改为口令红包")
- [伊朗将铀库存转至俄罗斯？克宫首次回应：长期以来的可能选项 伊方：无转移国外计划](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhksktz9540090.shtml "伊朗将铀库存转至俄罗斯？克宫首次回应：长期以来的可能选项 伊方：无转移国外计划")
- [领先特斯拉 华为前首席科学家陈亦伦：2020年时我们就做了端到端](https://finance.sina.com.cn/tech/roll/2026-02-04/doc-inhkryei6541523.shtml "领先特斯拉 华为前首席科学家陈亦伦：2020年时我们就做了端到端")
- [iQOO 15 Ultra上手体验：Ultra不止因为风扇](https://finance.sina.com.cn/tech/mobile/n/n/2026-02-04/doc-inhkrihr6734925.shtml "iQOO 15 Ultra上手体验：Ultra不止因为风扇")
- [iQOO 15 Ultra正式发布：性能手机也有Ultra款 到手价4999元起](https://finance.sina.com.cn/tech/mobile/n/n/2026-02-04/doc-inhkskty2764533.shtml "iQOO 15 Ultra正式发布：性能手机也有Ultra款 到手价4999元起")
- [OPPO新春影片《偷时间的人》上映：神仙主创打造 全片由OPPO Find X9 Pro拍摄](https://finance.sina.com.cn/tech/mobile/n/n/2026-02-05/doc-inhktspp5953004.shtml "OPPO新春影片《偷时间的人》上映：神仙主创打造 全片由OPPO Find X9 Pro拍摄")

- [马斯克盛赞4680电池起死回生！攻克瓶颈打脸宁德时代，已上车Model Y](https://finance.sina.com.cn/tech/csj/2026-02-03/doc-inhkpqwx6645871.shtml "马斯克盛赞4680电池起死回生！攻克瓶颈打脸宁德时代，已上车Model Y")
- [电动车第一次春运就趴窝！车主：表显400km续航 才跑100公里就没了](https://finance.sina.com.cn/tech/discovery/2026-02-05/doc-inhktnfp9068279.shtml "电动车第一次春运就趴窝！车主：表显400km续航 才跑100公里就没了")
- [公安部公布黑飞典型案例：男子在客机跑道飞无人机 被判3年](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktfxt6071875.shtml "公安部公布黑飞典型案例：男子在客机跑道飞无人机 被判3年")
- [女子花200元独享一架客机 川航回应：就她一个人 可随到随走](https://finance.sina.com.cn/tech/discovery/2026-02-05/doc-inhksrac3460966.shtml "女子花200元独享一架客机 川航回应：就她一个人 可随到随走")
- [宝马停杭州一商场8101小时：停车费16900元 车身一周被铁栅栏锁死](https://finance.sina.com.cn/tech/roll/2026-02-04/doc-inhkrpqk3004826.shtml "宝马停杭州一商场8101小时：停车费16900元 车身一周被铁栅栏锁死")
- [全球首款量产钠电池乘用车登场！-30℃放电功率比磷酸铁锂提升近三倍](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktspr3071260.shtml "全球首款量产钠电池乘用车登场！-30℃放电功率比磷酸铁锂提升近三倍")
- [特斯拉Model Y车祸起火后车门打不开 20岁男子报警后身亡](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktspr3031027.shtml "特斯拉Model Y车祸起火后车门打不开 20岁男子报警后身亡")
- [别人家的公司！SK海力士发放工资2964%奖金给员工：刷新历史上限](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhktnfp9132596.shtml "别人家的公司！SK海力士发放工资2964%奖金给员工：刷新历史上限")
- [奔驰GLE高速错过路口停车 致2死3重伤！车主质疑气囊不弹](https://finance.sina.com.cn/tech/roll/2026-02-03/doc-inhkpkrf0210768.shtml "奔驰GLE高速错过路口停车 致2死3重伤！车主质疑气囊不弹")
- [姜海荣回应马斯克妈妈把深蓝认成特斯拉：下次再来中国会看到更多](https://finance.sina.com.cn/tech/roll/2026-02-05/doc-inhksrac3464974.shtml "姜海荣回应马斯克妈妈把深蓝认成特斯拉：下次再来中国会看到更多")

### 科学探索

 [![](https://n.sinaimg.cn/tech/transform/534/w320h214/20220601/7fd7-8766e4f8f1e2e345cd74b65acbbe3f5b.png) 威马递表港交所 累计售车不足10万去年亏...](https://finance.sina.com.cn/tech/2022-06-01/doc-imizmscu4512038.shtml "威马递表港交所")

- [威马递表港交所 累计售车不足10万去年亏...](https://finance.sina.com.cn/tech/2022-06-01/doc-imizmscu4512038.shtml "威马递表港交所 累计售车不足10万去年亏...")

### 科学大家

 [![](https://n.sinaimg.cn/tech/transform/667/w400h267/20210529/0681-kquziii2264069.jpg) 《科学大家》| 新冠疫苗接种已不是选择题...](https://finance.sina.com.cn/tech/2021-05-29/doc-ikmxzfmm5316237.shtml "《科学大家》|")

- [《科学大家》| 新冠疫苗接种已不是选择题...](https://finance.sina.com.cn/tech/2021-05-29/doc-ikmxzfmm5316237.shtml "《科学大家》| 新冠疫苗接种已不是选择题...")

### 苹果汇

 [![](https://n.sinaimg.cn/tech/transform/534/w320h214/20221229/509d-2dfe0714f23251e1d4825bc991fd0c4a.jpg) 因iPhone包装不含充电器，苹果在美国...](https://finance.sina.com.cn/tech/2022-12-29/doc-imxyhwer5110881.shtml "因iPhone包装不含充电器，苹果在美国...")

- [因iPhone包装不含充电器，苹果在美国...](https://finance.sina.com.cn/tech/2022-12-29/doc-imxyhwer5110881.shtml "因iPhone包装不含充电器，苹果在美国...")

### 众测

 [![](https://n.sinaimg.cn/finance/transform/335/w200h135/20260122/b1d6-ced4bbeb1b5e35202db7df84226ce3ec.jpg) 华为路由X3 Pro体验评测](https://zhongce.sina.com.cn/article/view/194217/ "华为路由X3")

- [华为路由X3 Pro体验评测](https://zhongce.sina.com.cn/article/view/194217/ "华为路由X3 Pro体验评测")

### 专题

 [![](https://n.sinaimg.cn/tech/transform/335/w200h135/20221206/b129-8c5d02349e1aec9fbfab12ce9127bca3.jpg) 海外周选——每周一个有趣故事](https://tech.sina.com.cn/zt_d/weeklystory/ "海外周选——每周一个有趣故事")

- [海外周选——每周一个有趣故事](https://tech.sina.com.cn/zt_d/weeklystory/ "海外周选——每周一个有趣故事")