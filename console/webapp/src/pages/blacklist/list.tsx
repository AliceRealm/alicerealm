import { useList } from "@refinedev/core";
import { List } from "@refinedev/antd";
import {
  Table,
  Space,
  Button,
  Switch,
  Modal,
  Form,
  Input,
  Select,
  Popconfirm,
  message,
} from "antd";
import { useState } from "react";
import axios from "axios";
import { consoleApiUrl } from "../../config";
import { useSessionState } from "../../hooks/useSessionState";

interface BlacklistKeyword {
  keyword_id: string;
  keyword: string;
  enabled: boolean;
  created_at: number;
}

interface KeywordMutationResp {
  code: number;
  msg: string;
}

export const BlacklistKeywordList = () => {
  const [messageApi, contextHolder] = message.useMessage();
  const [current, setCurrent] = useSessionState("blacklist.page", 1);
  const [pageSize, setPageSize] = useSessionState("blacklist.page-size", 20);
  const [enabledFilter, setEnabledFilter] = useSessionState<boolean | undefined>(
    "blacklist.enabled",
    undefined,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createForm] = Form.useForm<{ keyword: string }>();

  const { query } = useList<BlacklistKeyword>({
    resource: "blacklist-keywords",
    pagination: { currentPage: current, pageSize, mode: "server" },
    filters: enabledFilter !== undefined
      ? [{ field: "enabled", operator: "eq" as const, value: enabledFilter }]
      : [],
  });

  const handleToggle = async (record: BlacklistKeyword, checked: boolean) => {
    try {
      const { data } = await axios.put<KeywordMutationResp>(
        `${consoleApiUrl}/blacklist-keywords/${record.keyword_id}`,
        { enabled: checked }
      );
      if (data.code !== 0) {
        messageApi.error(data.msg || "更新失败");
        return;
      }
      messageApi.success("已更新");
      await query.refetch();
    } catch {
      messageApi.error("更新失败");
    }
  };

  const handleCreate = async () => {
    const values = await createForm.validateFields();
    setSubmitting(true);
    try {
      const { data } = await axios.post<KeywordMutationResp>(
        `${consoleApiUrl}/blacklist-keywords`,
        { keyword: values.keyword.trim() }
      );
      if (data.code !== 0) {
        messageApi.error(data.msg || "创建失败");
        return;
      }
      messageApi.success("已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await query.refetch();
    } catch {
      messageApi.error("创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (keywordId: string) => {
    try {
      const { data } = await axios.delete<KeywordMutationResp>(
        `${consoleApiUrl}/blacklist-keywords/${keywordId}`
      );
      if (data.code !== 0) {
        messageApi.error(data.msg || "删除失败");
        return;
      }
      messageApi.success("已删除");
      await query.refetch();
    } catch {
      messageApi.error("删除失败");
    }
  };

  return (
    <>
      {contextHolder}
      <List
        headerButtons={
          <Space wrap>
            <Button
              type="primary"
              onClick={() => setCreateOpen(true)}
            >
              添加关键词
            </Button>
            <Select
              placeholder="按状态筛选"
              allowClear
              style={{ width: 160 }}
              value={enabledFilter}
              options={[
                { label: "已启用", value: true },
                { label: "已停用", value: false },
              ]}
              onChange={(val) => {
                setEnabledFilter(val);
                setCurrent(1);
              }}
            />
          </Space>
        }
      >
        <Table
          dataSource={query.data?.data}
          loading={query.isLoading}
          rowKey="keyword_id"
          pagination={{
            current,
            pageSize,
            total: query.data?.total ?? 0,
            onChange: (p, ps) => {
              setCurrent(p);
              setPageSize(ps);
            },
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total) => `共 ${total} 条`,
          }}
        >
          <Table.Column title="关键词 ID" dataIndex="keyword_id" width={120} />
          <Table.Column title="关键词" dataIndex="keyword" />
          <Table.Column
            title="启用状态"
            dataIndex="enabled"
            width={100}
            render={(val: boolean, record: BlacklistKeyword) => (
              <Switch
                checked={val}
                onChange={(checked) => void handleToggle(record, checked)}
              />
            )}
          />
          <Table.Column
            title="创建时间"
            dataIndex="created_at"
            width={180}
            render={(val: number) => (val ? new Date(val).toLocaleString() : "-")}
          />
          <Table.Column
            title="操作"
            width={100}
            render={(_: unknown, record: BlacklistKeyword) => (
              <Popconfirm
                title="确定删除这个关键词吗？"
                onConfirm={() => void handleDelete(record.keyword_id)}
              >
                <Button type="link" danger>删除</Button>
              </Popconfirm>
            )}
          />
        </Table>
      </List>

      <Modal
        title="添加黑名单关键词"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => void handleCreate()}
        okButtonProps={{ loading: submitting }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="keyword"
            label="关键词"
            rules={[{ required: true, message: "请输入关键词" }]}
          >
            <Input placeholder="输入要加入黑名单的关键词" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
