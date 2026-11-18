import { useList } from "@refinedev/core";
import { List } from "@refinedev/antd";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import { useState } from "react";

import { consoleApiUrl } from "../../config";
import { useSessionState } from "../../hooks/useSessionState";

interface MilestoneRule {
  rule_id: string;
  metric_key: string;
  threshold: number;
  rule_enabled: boolean;
  content_template: string;
  created_at: number;
  updated_at: number;
}

interface RuleMutationResp {
  code: number;
  msg: string;
  data?: {
    rule?: MilestoneRule;
    old_rule?: MilestoneRule;
    new_rule?: MilestoneRule;
  };
}

type CreateFormValues = {
  metric_key: string;
  threshold: number;
  rule_enabled: boolean;
  content_template: string;
};

type EditFormValues = {
  rule_enabled: boolean;
  content_template: string;
};

type ReplaceFormValues = {
  metric_key: string;
  threshold: number;
  rule_enabled: boolean;
  content_template: string;
};

const metricOptions = [
  { label: "consumed", value: "consumed" },
  { label: "score_1", value: "score_1" },
  { label: "score_2", value: "score_2" },
];

const formatTimestamp = (ts: number) => {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
};

const TemplatePreview = ({ value }: { value: string }) => (
  <Typography.Paragraph
    copyable={{ tooltips: false }}
    ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
    style={{ marginBottom: 0, maxWidth: 520, whiteSpace: "pre-wrap" }}
  >
    {value}
  </Typography.Paragraph>
);

export const MilestoneRuleList = () => {
  const [metricFilter, setMetricFilter] = useSessionState<string | undefined>(
    "milestone-rules.metric",
    undefined,
  );
  const [enabledFilter, setEnabledFilter] = useSessionState<boolean | undefined>(
    "milestone-rules.enabled",
    undefined,
  );
  const [current, setCurrent] = useSessionState("milestone-rules.page", 1);
  const [pageSize, setPageSize] = useSessionState("milestone-rules.page-size", 20);
  const [messageApi, contextHolder] = message.useMessage();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<MilestoneRule | null>(null);
  const [replacingRule, setReplacingRule] = useState<MilestoneRule | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [createForm] = Form.useForm<CreateFormValues>();
  const [editForm] = Form.useForm<EditFormValues>();
  const [replaceForm] = Form.useForm<ReplaceFormValues>();

  const { query } = useList<MilestoneRule>({
    resource: "milestone-rules",
    pagination: {
      currentPage: current,
      pageSize,
      mode: "server",
    },
    filters: [
      ...(metricFilter ? [{ field: "metric_key", operator: "eq" as const, value: metricFilter }] : []),
      ...(enabledFilter !== undefined
        ? [{ field: "rule_enabled", operator: "eq" as const, value: enabledFilter }]
        : []),
    ],
  });

  const refetchRules = async () => {
    await query.refetch();
  };

  const handleCreate = async () => {
    const values = await createForm.validateFields();
    setSubmitting(true);
    try {
      const { data } = await axios.post<RuleMutationResp>(`${consoleApiUrl}/milestone-rules`, values);
      if (data.code !== 0) {
        throw new Error(data.msg || "创建里程碑规则失败");
      }
      messageApi.success("里程碑规则已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await refetchRules();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "创建里程碑规则失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async () => {
    if (!editingRule) return;
    const values = await editForm.validateFields();
    setSubmitting(true);
    try {
      const { data } = await axios.put<RuleMutationResp>(
        `${consoleApiUrl}/milestone-rules/${editingRule.rule_id}`,
        values
      );
      if (data.code !== 0) {
        throw new Error(data.msg || "更新里程碑规则失败");
      }
      messageApi.success("里程碑规则已更新");
      setEditOpen(false);
      setEditingRule(null);
      await refetchRules();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "更新里程碑规则失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReplace = async () => {
    if (!replacingRule) return;
    const values = await replaceForm.validateFields();
    setSubmitting(true);
    try {
      const { data } = await axios.post<RuleMutationResp>(
        `${consoleApiUrl}/milestone-rules/${replacingRule.rule_id}/replace`,
        values
      );
      if (data.code !== 0) {
        throw new Error(data.msg || "替换里程碑规则失败");
      }
      messageApi.success("里程碑规则已替换");
      setReplaceOpen(false);
      setReplacingRule(null);
      await refetchRules();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "替换里程碑规则失败");
    } finally {
      setSubmitting(false);
    }
  };

  const openEditModal = (rule: MilestoneRule) => {
    setEditingRule(rule);
    editForm.setFieldsValue({
      rule_enabled: rule.rule_enabled,
      content_template: rule.content_template,
    });
    setEditOpen(true);
  };

  const openReplaceModal = (rule: MilestoneRule) => {
    setReplacingRule(rule);
    replaceForm.setFieldsValue({
      metric_key: rule.metric_key,
      threshold: rule.threshold,
      rule_enabled: true,
      content_template: rule.content_template,
    });
    setReplaceOpen(true);
  };

  const columns: ColumnsType<MilestoneRule> = [
    {
      title: "规则 ID",
      dataIndex: "rule_id",
      key: "rule_id",
      width: 120,
      fixed: "left",
    },
    {
      title: "指标",
      dataIndex: "metric_key",
      key: "metric_key",
      width: 120,
      render: (value: string) => <Tag color="blue">{value}</Tag>,
    },
    {
      title: "阈值",
      dataIndex: "threshold",
      key: "threshold",
      width: 120,
    },
    {
      title: "启用状态",
      dataIndex: "rule_enabled",
      key: "rule_enabled",
      width: 110,
      render: (enabled: boolean) => (
        <Tag color={enabled ? "success" : "default"}>{enabled ? "已启用" : "已停用"}</Tag>
      ),
    },
    {
      title: "内容模板",
      dataIndex: "content_template",
      key: "content_template",
      width: 560,
      render: (value: string) => <TemplatePreview value={value} />,
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 180,
      render: (value: number) => formatTimestamp(value),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (value: number) => formatTimestamp(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 180,
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button size="small" onClick={() => openReplaceModal(record)}>
            替换
          </Button>
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
                  metric_key: "consumed",
                  threshold: 50,
                  rule_enabled: true,
                  content_template: 'Your Content "{{.ItemSummary}}" reached {{.CounterValue}} consumptions. Item Id {{.ItemID}}',
                });
                setCreateOpen(true);
              }}
            >
              新建规则
            </Button>
            <Select
              allowClear
              placeholder="按指标筛选"
              style={{ width: 160 }}
              value={metricFilter}
              options={metricOptions}
              onChange={(value) => {
                setMetricFilter(value);
                setCurrent(1);
              }}
            />
            <Select
              allowClear
              placeholder="按启用状态筛选"
              style={{ width: 160 }}
              value={enabledFilter}
              options={[
                { label: "已启用", value: true },
                { label: "已停用", value: false },
              ]}
              onChange={(value) => {
                setEnabledFilter(value);
                setCurrent(1);
              }}
            />
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="如需修改指标或阈值，请使用“替换”。系统会停用旧规则，并为新规则分配新的规则 ID。"
        />
        <Table
          dataSource={query.data?.data}
          columns={columns}
          rowKey="rule_id"
          loading={query.isLoading}
          scroll={{ x: 1700 }}
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
        title="新建里程碑规则"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="metric_key" label="指标" rules={[{ required: true }]}>
            <Select options={metricOptions} />
          </Form.Item>
          <Form.Item
            name="threshold"
            label="阈值"
            rules={[{ required: true, type: "number", min: 1 }]}
          >
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="rule_enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="content_template" label="内容模板" rules={[{ required: true }]}>
            <Input.TextArea rows={5} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingRule ? `编辑规则 #${editingRule.rule_id}` : "编辑规则"}
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditingRule(null);
        }}
        onOk={() => void handleEdit()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="rule_enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="content_template" label="内容模板" rules={[{ required: true }]}>
            <Input.TextArea rows={5} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={replacingRule ? `替换规则 #${replacingRule.rule_id}` : "替换规则"}
        open={replaceOpen}
        onCancel={() => {
          setReplaceOpen(false);
          setReplacingRule(null);
        }}
        onOk={() => void handleReplace()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="替换操作会停用当前规则，并创建一条新规则。"
        />
        <Form form={replaceForm} layout="vertical">
          <Form.Item name="metric_key" label="指标" rules={[{ required: true }]}>
            <Select options={metricOptions} />
          </Form.Item>
          <Form.Item
            name="threshold"
            label="阈值"
            rules={[{ required: true, type: "number", min: 1 }]}
          >
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="rule_enabled" label="启用新规则" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="content_template" label="内容模板" rules={[{ required: true }]}>
            <Input.TextArea rows={5} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
