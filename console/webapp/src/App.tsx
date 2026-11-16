import { Refine } from "@refinedev/core";
import { RefineThemes, ThemedLayout, useNotificationProvider } from "@refinedev/antd";
import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import "@refinedev/antd/dist/reset.css";

import { consoleApiUrl } from "./config";
import { consoleDataProvider } from "./dataProvider";
import { AgentList } from "./pages/agents/list";
import { ImprRecordList } from "./pages/impr/list";
import { ItemList } from "./pages/items/list";
import { MilestoneRuleList } from "./pages/milestone-rules/list";
import { SystemNotificationList } from "./pages/system-notifications/list";
import { BlacklistKeywordList } from "./pages/blacklist/list";
import { ServiceReviewList } from "./pages/service-reviews/list";
import { ConversationList } from "./pages/conversations/list";

function App() {
  return (
    <BrowserRouter>
      <ConfigProvider locale={zhCN} theme={RefineThemes.Blue}>
        <AntdApp>
          <Refine
            dataProvider={consoleDataProvider(consoleApiUrl)}
            notificationProvider={useNotificationProvider}
            options={{
              title: {
                icon: <span style={{ color: "#1677ff", fontWeight: 800 }}>A</span>,
                text: "AliceRealm 管理后台",
              },
            }}
            resources={[
              {
                name: "agents",
                list: "/agents",
                meta: { label: "智能体管理" },
              },
              {
                name: "items",
                list: "/items",
                meta: { label: "内容管理" },
              },
              {
                name: "impr",
                list: "/impr",
                meta: {
                  label: "推荐记录",
                },
              },
              {
                name: "milestone-rules",
                list: "/milestone-rules",
                meta: {
                  label: "里程碑规则",
                },
              },
              {
                name: "system-notifications",
                list: "/system-notifications",
                meta: {
                  label: "系统通知",
                },
              },
              { name: "blacklist-keywords", list: "/blacklist-keywords", meta: { label: "关键词黑名单" } },
              { name: "service-reviews", list: "/service-reviews", meta: { label: "服务审核" } },
              { name: "conversations", list: "/conversations", meta: { label: "会话管理" } },
            ]}
          >
            <Routes>
              <Route
                element={
                  <ThemedLayout>
                    <Outlet />
                  </ThemedLayout>
                }
              >
                <Route index element={<Navigate to="/agents" replace />} />
                <Route path="/agents" element={<AgentList />} />
                <Route path="/items" element={<ItemList />} />
                <Route path="/impr" element={<ImprRecordList />} />
                <Route path="/milestone-rules" element={<MilestoneRuleList />} />
                <Route path="/system-notifications" element={<SystemNotificationList />} />
                <Route path="/blacklist-keywords" element={<BlacklistKeywordList />} />
                <Route path="/service-reviews" element={<ServiceReviewList />} />
                <Route path="/conversations" element={<ConversationList />} />
              </Route>
            </Routes>
          </Refine>
        </AntdApp>
      </ConfigProvider>
    </BrowserRouter>
  );
}

export default App;
