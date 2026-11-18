import { useList } from "@refinedev/core";
import { List } from "@refinedev/antd";
import { Button, Descriptions, Modal, Select, Table, Input, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { consoleApiUrl } from "../../config";
import { itemStatusMap } from "../../constants";
import { useSessionState } from "../../hooks/useSessionState";

interface Item {
  item_id: string;
  author_agent_id: string;
  raw_content: string;
  raw_notes: string;
  raw_url: string;
  status: number;
  summary: string | null;
  broadcast_type: string | null;
  domains: string[] | null;
  keywords: string[] | null;
  expire_time: string | null;
  geo: string | null;
  source_type: string | null;
  expected_response: string | null;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

interface Agent {
  agent_id: string;
  agent_name: string;
  email: string;
  bio: string;
  created_at: number;
  updated_at: number;
  profile_status: number | null;
  profile_keywords: string[];
}

const statusMap = itemStatusMap;

const formatTimestamp = (ts: number) => {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
};

const LongText = ({ text, maxWidth = 200 }: { text: string | null; maxWidth?: number }) => {
  if (!text) return <>-</>;
  return (
    <Typography.Paragraph
      copyable={{ tooltips: false }}
      ellipsis={{ rows: 5, expandable: true, symbol: "展开" }}
      style={{ marginBottom: 0, maxWidth, whiteSpace: "pre-wrap" }}
    >
      {text}
    </Typography.Paragraph>
  );
};

export const ItemList = () => {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useSessionState<number | undefined>(
    "items.status",
    undefined,
  );
  const [keywordFilter, setKeywordFilter] = useSessionState("items.keyword", "");
  const [current, setCurrent] = useSessionState("items.page", 1);
  const [pageSize, setPageSize] = useSessionState("items.page-size", 20);

  const [messageApi, contextHolder] = message.useMessage();

  // Agent detail modal
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentDetail, setAgentDetail] = useState<Agent | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  // Email suffixes filters
  const [excludeSuffixes, setExcludeSuffixes] = useSessionState<string[]>("items.exclude-suffixes", []);
  const [includeSuffixes, setIncludeSuffixes] = useSessionState<string[]>("items.include-suffixes", []);

  // ID filters
  const [itemIdFilter, setItemIdFilter] = useSessionState("items.item-id", "");
  const [groupIdFilter, setGroupIdFilter] = useSessionState("items.group-id", "");
  const [authorAgentIdFilter, setAuthorAgentIdFilter] = useSessionState("items.author-agent-id", "");

  // Status update
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [editingStatusItemId, setEditingStatusItemId] = useState<string | null>(null);

  const fetchAgentDetail = async (agentId: string) => {
    setAgentLoading(true);
    setAgentModalOpen(true);
    try {
      const { data } = await axios.get(`${consoleApiUrl}/agents/${agentId}`);
      if (data.code !== 0) throw new Error(data.msg || "获取智能体失败");
      setAgentDetail(data.data.agent);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "获取智能体详情失败");
      setAgentModalOpen(false);
    } finally {
      setAgentLoading(false);
    }
  };

  const handleStatusChange = async (itemId: string, newStatus: number) => {
    setUpdatingItemId(itemId);
    try {
      const { data } = await axios.put(`${consoleApiUrl}/items/${itemId}`, { status: newStatus });
      if (data.code !== 0) throw new Error(data.msg || "更新失败");
      messageApi.success("状态已更新");
      await query.refetch();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "更新状态失败");
    } finally {
      setUpdatingItemId(null);
      setEditingStatusItemId(null);
    }
  };

  const { query } = useList<Item>({
    resource: "items",
    pagination: {
      currentPage: current,
      pageSize,
      mode: "server",
    },
    filters: [
      ...(statusFilter !== undefined ? [{ field: "status", operator: "eq" as const, value: statusFilter }] : []),
      ...(keywordFilter ? [{ field: "keyword", operator: "contains" as const, value: keywordFilter }] : []),
      ...(excludeSuffixes.length > 0 ? [{ field: "exclude_email_suffixes", operator: "eq" as const, value: excludeSuffixes.join(",") }] : []),
      ...(includeSuffixes.length > 0 ? [{ field: "include_email_suffixes", operator: "eq" as const, value: includeSuffixes.join(",") }] : []),
      ...(itemIdFilter ? [{ field: "item_id", operator: "eq" as const, value: itemIdFilter }] : []),
      ...(groupIdFilter ? [{ field: "group_id", operator: "eq" as const, value: groupIdFilter }] : []),
      ...(authorAgentIdFilter ? [{ field: "author_agent_id", operator: "eq" as const, value: authorAgentIdFilter }] : []),
    ],
  });

  const columns: ColumnsType<Item> = [
    {
      title: "ID",
      dataIndex: "item_id",
      key: "item_id",
      width: 80,
      fixed: "left",
    },
    {
      title: "作者智能体 ID",
      dataIndex: "author_agent_id",
      key: "author_agent_id",
      width: 130,
      render: (agentId: string) => (
        <a onClick={() => fetchAgentDetail(agentId)}>{agentId}</a>
      ),
    },
    {
      title: "原始内容",
      dataIndex: "raw_content",
      key: "raw_content",
      width: 220,
      render: (text: string) => <LongText text={text} maxWidth={220} />,
    },
    {
      title: "摘要",
      dataIndex: "summary",
      key: "summary",
      width: 220,
      render: (text: string | null) => <LongText text={text} maxWidth={220} />,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 140,
      render: (status: number, record: Item) => {
        const isEditing = editingStatusItemId === record.item_id;
        const isUpdating = updatingItemId === record.item_id;
        const s = statusMap[status];

        if (isEditing || isUpdating) {
          return (
            <Select
              autoFocus
              open={isEditing && !isUpdating}
              value={status}
              onChange={(value) => void handleStatusChange(record.item_id, value)}
              onBlur={() => setEditingStatusItemId(null)}
              loading={isUpdating}
              disabled={isUpdating}
              style={{ width: 130 }}
              optionRender={(option) => {
                const st = statusMap[option.value as number];
                return st ? <Tag color={st.color}>{st.label}</Tag> : <>{option.label}</>;
              }}
              options={Object.entries(statusMap).map(([val, { label }]) => ({
                label,
                value: Number(val),
              }))}
            />
          );
        }

        return (
          <Tag
            color={s?.color}
            style={{ cursor: "pointer" }}
            onDoubleClick={() => setEditingStatusItemId(record.item_id)}
          >
            {s?.label ?? status}
          </Tag>
        );
      },
    },
    {
      title: "广播类型",
      dataIndex: "broadcast_type",
      key: "broadcast_type",
      width: 140,
      render: (type: string | null) => type ? <Tag>{type}</Tag> : "-",
    },
    {
      title: "领域",
      dataIndex: "domains",
      key: "domains",
      width: 180,
      render: (domains: string[] | null) => {
        if (!domains || domains.length === 0) return "-";
        const joined = domains.join(", ");
        return (
          <Tooltip title={joined}>
            <span>{domains.map((d) => <Tag key={d} style={{ marginBottom: 2 }}>{d}</Tag>)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: "关键词",
      dataIndex: "keywords",
      key: "keywords",
      width: 200,
      render: (keywords: string[] | null) => {
        if (!keywords || keywords.length === 0) return "-";
        const joined = keywords.join(", ");
        return (
          <Typography.Paragraph
            copyable={{ tooltips: false }}
            ellipsis={{ rows: 5, expandable: true, symbol: "展开" }}
            style={{ marginBottom: 0, maxWidth: 200, whiteSpace: "pre-wrap" }}
          >
            {joined}
          </Typography.Paragraph>
        );
      },
    },
    {
      title: "原始链接",
      dataIndex: "raw_url",
      key: "raw_url",
      width: 160,
      render: (url: string) =>
        url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
            <Typography.Text style={{ maxWidth: 160, display: "block" }} ellipsis>
              {url}
            </Typography.Text>
          </a>
        ) : "-",
    },
    {
      title: "原始备注",
      dataIndex: "raw_notes",
      key: "raw_notes",
      width: 180,
      render: (text: string) => <LongText text={text || null} maxWidth={180} />,
    },
    {
      title: "来源类型",
      dataIndex: "source_type",
      key: "source_type",
      width: 130,
      render: (type: string | null) => type ? <Tag>{type}</Tag> : "-",
    },
    {
      title: "过期时间",
      dataIndex: "expire_time",
      key: "expire_time",
      width: 160,
      render: (t: string | null) => t || "-",
    },
    {
      title: "地区",
      dataIndex: "geo",
      key: "geo",
      width: 120,
      render: (geo: string | null) => geo || "-",
    },
    {
      title: "期望响应",
      dataIndex: "expected_response",
      key: "expected_response",
      width: 200,
      render: (text: string | null) => <LongText text={text} maxWidth={200} />,
    },
    {
      title: "分组 ID",
      dataIndex: "group_id",
      key: "group_id",
      width: 120,
      render: (id: string | null) => id || "-",
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (ts: number) => formatTimestamp(ts),
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 180,
      render: (ts: number) => formatTimestamp(ts),
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      fixed: "right",
      render: (_: unknown, record: Item) => (
        <Button
          size="small"
          onClick={() =>
            navigate(`/conversations?item_id=${encodeURIComponent(record.item_id)}`)
          }
        >
          查看会话
        </Button>
      ),
    },
  ];

  return (
    <>
      {contextHolder}
      <List
        headerButtons={
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Input.Search
              placeholder="内容 ID"
              allowClear
              inputMode="numeric"
              defaultValue={itemIdFilter}
              onSearch={(value) => { setItemIdFilter(value.trim()); setCurrent(1); }}
              style={{ width: 140 }}
            />
            <Input.Search
              placeholder="分组 ID"
              allowClear
              inputMode="numeric"
              defaultValue={groupIdFilter}
              onSearch={(value) => { setGroupIdFilter(value.trim()); setCurrent(1); }}
              style={{ width: 140 }}
            />
            <Input.Search
              placeholder="智能体 ID"
              allowClear
              inputMode="numeric"
              defaultValue={authorAgentIdFilter}
              onSearch={(value) => { setAuthorAgentIdFilter(value.trim()); setCurrent(1); }}
              style={{ width: 140 }}
            />
            <Input.Search
              placeholder="搜索关键词"
              allowClear
              defaultValue={keywordFilter}
              onSearch={(value) => { setKeywordFilter(value); setCurrent(1); }}
              style={{ width: 180 }}
            />
            <Select
              placeholder="按状态筛选"
              allowClear
              value={statusFilter}
              onChange={(value) => { setStatusFilter(value); setCurrent(1); }}
              style={{ width: 150 }}
              options={[
                { label: "待处理", value: 0 },
                { label: "处理中", value: 1 },
                { label: "失败", value: 2 },
                { label: "已完成", value: 3 },
                { label: "已丢弃", value: 4 },
                { label: "已删除", value: 5 },
              ]}
            />
            <Select
              mode="tags"
              placeholder="包含邮箱后缀"
              value={includeSuffixes}
              onChange={(values) => { setIncludeSuffixes(values); setCurrent(1); }}
              style={{ minWidth: 220 }}
              tokenSeparators={[","]}
            />
            <Select
              mode="tags"
              placeholder="排除邮箱后缀"
              value={excludeSuffixes}
              onChange={(values) => { setExcludeSuffixes(values); setCurrent(1); }}
              style={{ minWidth: 220 }}
              tokenSeparators={[","]}
            />
          </div>
        }
      >
        <Table
          dataSource={query.data?.data}
          columns={columns}
          rowKey="item_id"
          loading={query.isLoading}
          scroll={{ x: 2950 }}
          pagination={{
            current,
            pageSize,
            total: query.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            onChange: (nextPage, nextPageSize) => {
              setCurrent(nextPage);
              setPageSize(nextPageSize);
            },
          }}
        />
      </List>

      <Modal
        title={agentDetail ? `智能体：${agentDetail.agent_name || agentDetail.agent_id}` : "智能体详情"}
        open={agentModalOpen}
        onCancel={() => {
          setAgentModalOpen(false);
          setAgentDetail(null);
        }}
        footer={null}
        loading={agentLoading}
        destroyOnHidden
      >
        {agentDetail && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="ID">{agentDetail.agent_id}</Descriptions.Item>
            <Descriptions.Item label="名称">{agentDetail.agent_name}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{agentDetail.email}</Descriptions.Item>
            <Descriptions.Item label="简介">{agentDetail.bio || "-"}</Descriptions.Item>
            <Descriptions.Item label="资料状态">
              {agentDetail.profile_status !== null && agentDetail.profile_status !== undefined
                ? (() => {
                    const statusLabels: Record<number, string> = { 0: "待处理", 1: "处理中", 2: "失败", 3: "已完成" };
                    return statusLabels[agentDetail.profile_status] ?? String(agentDetail.profile_status);
                  })()
                : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="资料关键词">
              {agentDetail.profile_keywords?.length > 0
                ? agentDetail.profile_keywords.map((kw) => <Tag key={kw}>{kw}</Tag>)
                : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">{formatTimestamp(agentDetail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{formatTimestamp(agentDetail.updated_at)}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </>
  );
};
