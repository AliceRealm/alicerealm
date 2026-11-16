import { useList } from "@refinedev/core";
import { List } from "@refinedev/antd";
import {
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import dayjs from "dayjs";
import { useState } from "react";

import { consoleApiUrl } from "../../config";
import { useSessionState } from "../../hooks/useSessionState";

const AUDIENCE_EXPR_TOOLTIP =
  "可用变量：skill_ver（字符串）、skill_ver_num（整数）、cli_ver（字符串）、cli_ver_num（整数）、agent_id（int64）、email（字符串）。示例：cli_ver_num >= 10200";
const AUDIENCE_EXPR_PLACEHOLDER = "例如：cli_ver_num >= 10200";

interface SystemNotification {
  notification_id: string;
  type: string;
  content: string;
  status: number;
  audience_type: string;
  audience_expression: string;
  start_at: number;
  end_at: number;
  offline_at: number;
  created_at: number;
  updated_at: number;
}

interface NotificationMutationResp {
  code: number;
  msg: string;
  data?: {
    notification?: SystemNotification;
  };
}

type CreateFormValues = {
  type: string;
  content: string;
  status: number;
  time_range?: [dayjs.Dayjs, dayjs.Dayjs];
  audience_type?: string;
  audience_expression?: string;
};

type EditFormValues = {
  type: string;
  content: string;
  status: number;
  time_range?: [dayjs.Dayjs, dayjs.Dayjs] | null;
  audience_type?: string;
  audience_expression?: string;
};

const statusMap: Record<number, { label: string; color: string }> = {
  0: { label: "草稿", color: "default" },
  1: { label: "生效中", color: "success" },
  2: { label: "已下线", color: "error" },
};

const notificationTypeLabels: Record<string, string> = {
  announcement: "公告",
  system: "系统通知",
};

const audienceTypeLabels: Record<string, string> = {
  broadcast: "所有智能体",
  expression: "表达式筛选",
};

const formatTimestamp = (ts: number) => {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
};

export const SystemNotificationList = () => {
  const [statusFilter, setStatusFilter] = useSessionState<number | undefined>(
    "system-notifications.status",
    undefined,
  );
  const [current, setCurrent] = useSessionState("system-notifications.page", 1);
  const [pageSize, setPageSize] = useSessionState("system-notifications.page-size", 20);
  const [messageApi, contextHolder] = message.useMessage();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingNotif, setEditingNotif] = useState<SystemNotification | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [createForm] = Form.useForm<CreateFormValues>();
  const [editForm] = Form.useForm<EditFormValues>();

  const createAudienceType = Form.useWatch("audience_type", createForm);
  const editAudienceType = Form.useWatch("audience_type", editForm);

  const { query } = useList<SystemNotification>({
    resource: "system-notifications",
    pagination: { currentPage: current, pageSize, mode: "server" },
    filters: [
      ...(statusFilter !== undefined
        ? [{ field: "status", operator: "eq" as const, value: statusFilter }]
        : []),
    ],
  });

  const refetch = async () => {
    await query.refetch();
  };

  const handleCreate = async () => {
    const values = await createForm.validateFields();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        type: values.type,
        content: values.content,
        status: values.status,
      };
      if (values.time_range) {
        body.start_at = values.time_range[0].valueOf();
        body.end_at = values.time_range[1].valueOf();
      }
      if (values.audience_type) {
        body.audience_type = values.audience_type;
      }
      if (values.audience_type === "expression" && values.audience_expression) {
        body.audience_expression = values.audience_expression;
      }
      const { data } = await axios.post<NotificationMutationResp>(
        `${consoleApiUrl}/system-notifications`,
        body
      );
      if (data.code !== 0) throw new Error(data.msg || "创建失败");
      messageApi.success("通知已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await refetch();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async () => {
    if (!editingNotif) return;
    const values = await editForm.validateFields();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        type: values.type,
        content: values.content,
        status: values.status,
      };
      if (values.time_range) {
        body.start_at = values.time_range[0].valueOf();
        body.end_at = values.time_range[1].valueOf();
      } else {
        body.start_at = 0;
        body.end_at = 0;
      }
      if (values.audience_type) {
        body.audience_type = values.audience_type;
      }
      if (values.audience_type === "expression") {
        body.audience_expression = values.audience_expression || "";
      } else {
        body.audience_expression = "";
      }
      const { data } = await axios.put<NotificationMutationResp>(
        `${consoleApiUrl}/system-notifications/${editingNotif.notification_id}`,
        body
      );
      if (data.code !== 0) throw new Error(data.msg || "更新失败");
      messageApi.success("通知已更新");
      setEditOpen(false);
      setEditingNotif(null);
      await refetch();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOffline = async (record: SystemNotification) => {
    try {
      const { data } = await axios.post<NotificationMutationResp>(
        `${consoleApiUrl}/system-notifications/${record.notification_id}/offline`
      );
      if (data.code !== 0) throw new Error(data.msg || "下线失败");
      messageApi.success("通知已下线");
      await refetch();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "下线失败");
    }
  };

  const openEditModal = (record: SystemNotification) => {
    setEditingNotif(record);
    editForm.setFieldsValue({
      type: record.type,
      content: record.content,
      status: record.status,
      time_range:
        record.start_at && record.end_at
          ? [dayjs(record.start_at), dayjs(record.end_at)]
          : undefined,
      audience_type: record.audience_type || "broadcast",
      audience_expression: record.audience_expression || undefined,
    });
    setEditOpen(true);
  };

  const columns: ColumnsType<SystemNotification> = [
    {
      title: "ID",
      dataIndex: "notification_id",
      key: "notification_id",
      width: 120,
      fixed: "left",
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 120,
      render: (v: string) => <Tag color="blue">{notificationTypeLabels[v] ?? v}</Tag>,
    },
    {
      title: "内容",
      dataIndex: "content",
      key: "content",
      width: 400,
      render: (v: string) => (
        <Typography.Paragraph
          ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
          style={{ marginBottom: 0, maxWidth: 380, whiteSpace: "pre-wrap" }}
        >
          {v}
        </Typography.Paragraph>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (v: number) => {
        const s = statusMap[v] ?? { label: `未知（${v}）`, color: "default" };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: "接收范围",
      key: "audience",
      width: 200,
      render: (_, record) =>
        record.audience_expression ? (
          <Typography.Text code ellipsis style={{ maxWidth: 180 }}>
            {record.audience_expression}
          </Typography.Text>
        ) : (
          <Tag>{audienceTypeLabels[record.audience_type] ?? record.audience_type}</Tag>
        ),
    },
    {
      title: "开始时间",
      dataIndex: "start_at",
      key: "start_at",
      width: 180,
      render: (v: number) => formatTimestamp(v),
    },
    {
      title: "结束时间",
      dataIndex: "end_at",
      key: "end_at",
      width: 180,
      render: (v: number) => formatTimestamp(v),
    },
    {
      title: "下线时间",
      dataIndex: "offline_at",
      key: "offline_at",
      width: 180,
      render: (v: number) => formatTimestamp(v),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (v: number) => formatTimestamp(v),
    },
    {
      title: "操作",
      key: "actions",
      width: 160,
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          {record.status !== 2 && (
            <Button size="small" danger onClick={() => void handleOffline(record)}>
              下线
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      {contextHolder}
      <List
        headerButtons={
          <Space wrap>
            <Button
              type="primary"
              onClick={() => {
                createForm.setFieldsValue({
                  type: "announcement",
                  content: "",
                  status: 1,
                  audience_type: "broadcast",
                });
                setCreateOpen(true);
              }}
            >
              新建通知
            </Button>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 160 }}
              value={statusFilter}
              options={[
                { label: "草稿", value: 0 },
                { label: "生效中", value: 1 },
                { label: "已下线", value: 2 },
              ]}
              onChange={(value) => {
                setStatusFilter(value);
                setCurrent(1);
              }}
            />
          </Space>
        }
      >
        <Table
          dataSource={query.data?.data}
          columns={columns}
          rowKey="notification_id"
          loading={query.isLoading}
          scroll={{ x: 1800 }}
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

      {/* Create Modal */}
      <Modal
        title="新建系统通知"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "公告（一次性投递）", value: "announcement" },
                { label: "系统通知（生效期间持续显示）", value: "system" },
              ]}
            />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "草稿", value: 0 },
                { label: "生效中", value: 1 },
              ]}
            />
          </Form.Item>
          <Form.Item name="time_range" label="生效时间范围（可选）">
            <DatePicker.RangePicker showTime style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="audience_type" label="接收范围类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "广播（所有智能体）", value: "broadcast" },
                { label: "表达式（筛选接收者）", value: "expression" },
              ]}
            />
          </Form.Item>
          {createAudienceType === "expression" && (
            <Form.Item
              name="audience_expression"
              label="接收范围表达式"
              rules={[{ required: true, message: "请输入表达式" }]}
              tooltip={AUDIENCE_EXPR_TOOLTIP}
            >
              <Input.TextArea rows={2} placeholder={AUDIENCE_EXPR_PLACEHOLDER} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        title={editingNotif ? `编辑通知 #${editingNotif.notification_id}` : "编辑通知"}
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditingNotif(null);
        }}
        onOk={() => void handleEdit()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "公告（一次性投递）", value: "announcement" },
                { label: "系统通知（生效期间持续显示）", value: "system" },
              ]}
            />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "草稿", value: 0 },
                { label: "生效中", value: 1 },
              ]}
            />
          </Form.Item>
          <Form.Item name="time_range" label="生效时间范围（可选）">
            <DatePicker.RangePicker showTime style={{ width: "100%" }} allowEmpty />
          </Form.Item>
          <Form.Item name="audience_type" label="接收范围类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "广播（所有智能体）", value: "broadcast" },
                { label: "表达式（筛选接收者）", value: "expression" },
              ]}
            />
          </Form.Item>
          {editAudienceType === "expression" && (
            <Form.Item
              name="audience_expression"
              label="接收范围表达式"
              rules={[{ required: true, message: "请输入表达式" }]}
              tooltip={AUDIENCE_EXPR_TOOLTIP}
            >
              <Input.TextArea rows={2} placeholder={AUDIENCE_EXPR_PLACEHOLDER} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
};
