# CONTENT INTELLIGENCE — 爆发共性 / 话题饱和度 / 新颖度(Stage 8)

> 面向产品与工程的完整解释。一句话定位:**回答"爆发内容有什么共同特征、话题是否
> 同质化、有没有新角度"——全部是观察到的模式与数据差异,不是选题建议,更不是爆款预测。**

## 1. 三个引擎(版本全部集中 `server/src/intelligence/profiles.ts`)

```
Content Burst Score(Stage 7)
   ↓ Viral Pattern Engine   爆发组 vs 匹配控制组 → 特征 Lift(VIRAL_PATTERN_V1)
Topic / AngleText(ANGLE_TEXT_V1)
   ↓ Saturation Engine      话题同质化程度(SATURATION_V1)
   ↓ Novelty Engine         新兴角度识别(NOVELTY_V1)
```

## 2. Viral Pattern Engine

- **爆发组定义**:内容爆发指数 ≥ 80(集中配置;不用 views/likes 阈值,§3)。
- **匹配控制组**(§4):同话题内按 平台+类型+年龄桶 逐级放宽(exact →
  topic_platform_age → topic_platform → topic_only),仍不足才放宽到
  platform_global 并显式标注 controlMatchLevel;控制组 <15 或爆发组 <8 →
  **insufficient_data,不输出任何结论**(§6)。
- **特征层**(§7-§10):17 个确定性中文特征(问句结构/金额/地区/身份/清单/
  强标点/人称/对比……)+ 语义特征(结构化 Zod Schema:0-1 分值 + 枚举)。
  RuleBased 词库抽取恒可用;AI 抽取器凭证缺失 → 标 unavailable,不阻塞(§12)。
  特征按 (内容, textHash, featureVersion) 缓存于 content_feature_records。
- **Lift**(§16-§19):差异倍数 = 爆发组占比 ÷ 控制组占比;控制组 0 命中 →
  add-1(Jeffreys)平滑并记录 smoothingApplied,**绝不输出 Infinity**。
  连续特征(标题长度等)比 median + IQR,不硬转 bool(§20);枚举特征比分布(§21)。
- **证据质量**(§26/§57):由两侧较小样本量决定(≥30 high / ≥10 medium / 其余 low),
  排序先证据质量再效应量——N=2 的夸张倍数永远排不到前面。负向模式(爆发组
  更少出现的特征)同样展示(§27)。
- **红线(§17/§59)**:UI 只说"爆发内容中更常见 / 观察到的关联";
  禁止"使用问句能提升爆款率"类因果表述。

## 3. Saturation Engine

0-100,五组件(权重版本化):20% 内容规模(按话题年龄标准化的速率,非绝对数)
+ 20% 近期发布频率(近 7 天密度)+ 25% 角度相似度(话题内近邻平均 cosine)
+ 20% 重复率(近邻 ≥0.7 的占比)+ 15% 创作者集中度(修正 HHI:均匀=0,单作者=1)。

- **角度表示**(§34):AngleTextBuilder V1 —— 标题/首句主导,弱化大段正文;
  角度向量恒用词法回退(D18),UI 标注"词法饱和度基线";绝不与内容 Embedding
  混用同一空间。
- **防爆炸**(§32):话题内角度分析取最近 300 条;5000×500 实测全流程 732ms。
- 样本不足 → unscorable;**UI 只显示 低/中/高 + 证据,绝不输出"不要做这个话题"(§41)**。
- 快照 append-only(topic_saturation_snapshots),可回看话题从低饱和变高饱和。

## 4. Novelty Engine / Emerging Angles

- **新话题 vs 新角度**(§42-§44):新话题由 Stage 6B 聚类天然产生;新角度 =
  已有话题内最近出现的表达簇 —— 角度向量连通分量(阈值 0.6),不建第二套 Topic Engine。
- **噪声护栏**(§49):簇成员 <3(minAngleMembers)不入库不成角度——1 条离群
  内容永远不可能变成"新角度 95 分"。
- **Emerging 判定**(§47):firstObserved 在近 7 天窗口内 + 成员 ≥3 + 与历史角度
  最大相似度 <0.5。
- **新颖度分数**(§48):40% 与历史角度的距离 + 25% 近期增长 + 20% 成员充分性
  + 15% 创作者多样性;话题级新颖度 = 最强新兴角度的分数。
- **稳定 ID**(§50):跨 Run 按质心相似度(≥0.6)调和 —— 继承 id/firstObservedAt/
  人工命名;"曾识别为新兴"永久保留。命名 = 关键词回退(标题 bigram)→ 可选 AI → 手动。
- **饱和与新颖必须同看**(§53):高饱和话题仍可能冒出高新颖度的新角度——
  这正是未来 Opportunity Engine 的基础,但本阶段不计算任何 Opportunity Score。

## 5. 版本与可追溯(§60-§65)

- intelligence_runs 记录全部四个版本 + configSnapshot + topics/contents 计数。
- pattern_results / topic_saturation_snapshots / topic_novelty_snapshots 均 append-only;
  topic_intelligence_current 只是 SQL 排序分页缓存(§73,列表不全量 JS sort)。
- 触发:POST /api/intelligence/run(手动;不自动定时跑)。

## 6. UI(§51/§54-§56/§75-§78)

- **话题洞察面板**(话题详情):饱和度(分数+档位+置信度+证据)、新颖度
  (新兴角度计数)、爆发内容共性表(特征/爆发组/普通组/差异倍数/方向/证据质量/
  样本量 N)、新兴角度表(角度/成员/首次出现/新颖度/代表内容)。
- 样本不足 → "当前爆发内容样本不足,暂无法形成稳定共性",不是空表(§78)。
- 趋势中心话题趋势表增加 饱和度/新颖度 列与筛选(如"上升+低饱和"只是筛选
  条件,绝不叫"最佳机会",§56);工作台所属话题附 饱和/新颖;内容详情有
  特征记录调试卡(§75)。

## 7. 什么时候不可靠(诚实清单)

1. 爆发组或控制组样本不足 → 直接 insufficient_data(不做伪统计)。
2. 证据 low = 样本少(不是结论错,但别太信)。
3. 词法角度基线:角度相似度基于词法向量,同义不同词的角度可能被低估;
   EMBEDDING 凭证到位后可升级真语义角度。
4. 观察到的关联 ≠ 因果:爆发内容共同点可能是平台分发的果而非因。
5. 单平台数据下 controlMatchLevel 常落到 topic_only / platform_global,
   泛化力有限。
