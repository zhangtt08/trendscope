import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useResource } from "./lib/useResource";
import { LayoutDashboard, DownloadCloud, Table2, GitMerge, TrendingUp, Target, Satellite, Network, Boxes, Compass, Sliders, Sparkles, Settings2, FileText } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import ImportCenter from "./pages/ImportCenter";
import Explorer from "./pages/Explorer";
import ContentDetail from "./pages/ContentDetail";
import Duplicates from "./pages/Duplicates";
import ImportBatchDetail from "./pages/ImportBatchDetail";
import Trends from "./pages/Trends";
import Workbench from "./pages/Workbench";
import CollectionCenter from "./pages/CollectionCenter";
import SemanticCenter from "./pages/SemanticCenter";
import TopicsExplorer from "./pages/TopicsExplorer";
import OpportunityWorkbench from "./pages/OpportunityWorkbench";
import OpportunityProfile from "./pages/OpportunityProfile";
import TopicStudio from "./pages/TopicStudio";
import SettingsCenter from "./pages/SettingsCenter";
import { ReportCenter } from "./pages/ReportCenter";

/**
 * 导航顺序按用户实际流程排(§115/§116):拿数据 → 看数据 → 采集/语义 → 话题 → 趋势 →
 * 机会 → 候选 → 工作室 → 模型与设置。不再显示内部阶段编号。
 */
const NAV_ITEMS: { to: string; label: string; Icon: typeof LayoutDashboard }[] = [
  { to: "/dashboard", label: "数据总览", Icon: LayoutDashboard },
  { to: "/import", label: "导入中心", Icon: DownloadCloud },
  { to: "/explorer", label: "内容浏览器", Icon: Table2 },
  { to: "/duplicates", label: "重复治理", Icon: GitMerge },
  { to: "/collection", label: "采集中心", Icon: Satellite },
  { to: "/semantic", label: "语义中心", Icon: Network },
  { to: "/topics", label: "话题", Icon: Boxes },
  { to: "/trends", label: "趋势", Icon: TrendingUp },
  { to: "/opportunity", label: "选题机会", Icon: Compass },
  { to: "/workbench", label: "内容候选工作台", Icon: Target },
  { to: "/studio", label: "选题工作室", Icon: Sparkles },
  { to: "/report", label: "分析报告", Icon: FileText },
  { to: "/profile", label: "机会模型", Icon: Sliders },
  { to: "/settings", label: "设置", Icon: Settings2 },
];

interface DemoStatus {
  demoMode: boolean;
  contentTotal: number;
  dbDisplay: string;
}

/** 演示模式必须一直看得见:示例数字不能被当成真实热门内容(§34)。 */
function DemoModeStrip({ status }: { status: DemoStatus | null }) {
  if (!status?.demoMode) return null;
  return (
    <div className="demo-strip" role="status">
      演示模式 —— 当前使用独立演示库 <span className="mono">{status.dbDisplay}</span>
      ({status.contentTotal} 条示例内容)。你的正式库不会被读写;重置请用
      <span className="mono"> npm run demo:reset</span>。
    </div>
  );
}

export default function App() {
  const location = useLocation();
  // 侧栏底部即"关于":版本号来自 package.json,数据文件来自服务端
  const demoStatus = useResource<DemoStatus>("/demo/status");
  const dbDisplay = demoStatus.data?.dbDisplay ?? "";
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">
            TREND<em>SCOPE</em>
          </div>
          <div className="brand-sub">v{__APP_VERSION__} · 本地趋势工作台</div>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot" title={dbDisplay ? `本机数据库文件:${dbDisplay}` : "数据库将在首次启动时自动创建"}>
          <span className="sidebar-foot-meta">v{__APP_VERSION__} · 数据不出本机</span>
          <span className="sidebar-foot-db">{dbDisplay || "首次启动时自动建库"}</span>
        </div>
      </aside>
      <main className="content">
        <DemoModeStrip status={demoStatus.data ?? null} />
        {/* key=pathname:某一页渲染崩溃只影响这一页,切到别的路由即自动恢复,
            不会像根级边界那样把整个应用钉死在错误面板上。 */}
        <ErrorBoundary key={location.pathname}>
          <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/import" element={<ImportCenter />} />
          <Route path="/import/:id" element={<ImportBatchDetail />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/collection" element={<CollectionCenter />} />
          <Route path="/semantic" element={<SemanticCenter />} />
          {/* 单条路由带可选参数:避免 /topics 与 /topics/:id 两个 Route
              互相重挂载导致筛选状态丢失(v6.5+ 支持 `:id?`) */}
          <Route path="/topics/:id?" element={<TopicsExplorer />} />
          <Route path="/opportunity" element={<OpportunityWorkbench />} />
          <Route path="/profile" element={<OpportunityProfile />} />
          <Route path="/studio/:topicId?" element={<TopicStudio />} />
          <Route path="/content/:id" element={<ContentDetail />} />
          <Route path="/settings" element={<SettingsCenter />} />
          <Route path="/report" element={<ReportCenter />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
