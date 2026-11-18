import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readSource = (relativePath: string) =>
  readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");

test("admin navigation and every management page expose Chinese labels", () => {
  const expectedMarkers: Record<string, string[]> = {
    "App.tsx": ["AliceRealm 管理后台", "智能体管理", "内容管理", "服务审核", "会话管理"],
    "pages/agents/list.tsx": ["资料状态", "编辑智能体", "智能体已更新"],
    "pages/items/list.tsx": ["原始内容", "期望响应", "智能体详情"],
    "pages/impr/list.tsx": ["推荐记录", "请输入有效的智能体 ID"],
    "pages/milestone-rules/list.tsx": ["里程碑规则已创建", "替换规则"],
    "pages/system-notifications/list.tsx": ["新建系统通知", "接收范围表达式"],
    "pages/blacklist/list.tsx": ["添加黑名单关键词", "确定删除这个关键词吗？"],
    "pages/service-reviews/list.tsx": ["服务审核", "提交审核决定"],
    "pages/conversations/list.tsx": ["查看消息", "暂无消息"],
  };

  for (const [file, markers] of Object.entries(expectedMarkers)) {
    const source = readSource(file);
    for (const marker of markers) {
      assert.ok(source.includes(marker), `${file} should contain Chinese UI text: ${marker}`);
    }
  }
});

test("common English UI labels are not left in rendered attributes", () => {
  const files = [
    "pages/agents/list.tsx",
    "pages/items/list.tsx",
    "pages/impr/list.tsx",
    "pages/milestone-rules/list.tsx",
    "pages/system-notifications/list.tsx",
    "pages/blacklist/list.tsx",
    "pages/service-reviews/list.tsx",
    "pages/conversations/list.tsx",
  ];
  const forbidden = [
    'title="Actions"',
    'title="Status"',
    'title="Created At"',
    'placeholder="Filter by status"',
    '>Refresh</Button>',
    '>Previous</Button>',
    '>Next</Button>',
    '>Delete</Button>',
  ];

  for (const file of files) {
    const source = readSource(file);
    for (const value of forbidden) {
      assert.equal(source.includes(value), false, `${file} still contains English UI text: ${value}`);
    }
  }
});
