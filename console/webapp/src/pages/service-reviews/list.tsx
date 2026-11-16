import { useCustom } from "@refinedev/core";
import { List } from "@refinedev/antd";
import { Alert, App, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import axios from "axios";
import { consoleApiUrl } from "../../config";
import { useSessionState } from "../../hooks/useSessionState";
import { canResolve, resolutionPayload, reviewStatuses } from "./model";
import type { ReviewDecision, ReviewListing, ReviewPage, ReviewStatus } from "./model";

const reviewStatusLabels: Record<ReviewStatus, string> = {
  review: "待人工审核",
  pending: "等待处理",
  processing: "处理中",
  pass: "已通过",
  reject: "已拒绝",
  failed: "失败",
  stale: "已失效",
  published: "已发布",
};

const decisionLabel = (value?: string) => {
  if (value === "pass") return "通过";
  if (value === "reject") return "拒绝";
  if (value === "review") return "转人工审核";
  return value || "—";
};

export const ServiceReviewList = () => {
  const { message } = App.useApp();
  const [paging, setPaging] = useSessionState<{ status: ReviewStatus; cursors: string[] }>("service-reviews.paging", { status: "review", cursors: ["0"] });
  const [selected, setSelected] = useState<ReviewListing>();
  const [deciding, setDeciding] = useState<ReviewListing>();
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ReviewDecision>();
  const { query } = useCustom<ReviewPage>({
    url: `${consoleApiUrl}/service-reviews`, method: "get",
    config: { query: { status: paging.status, cursor: paging.cursors.at(-1), limit: 20 } },
  });
  const page = query.data?.data;

  const openDecision = (row: ReviewListing) => {
    form.resetFields();
    setDeciding(row);
  };
  const resolve = async () => {
    if (!deciding) return;
    let values: ReviewDecision;
    try { values = resolutionPayload(deciding.moderation, await form.validateFields()); }
    catch { return; }
    setSubmitting(true);
    try {
      const { data } = await axios.post(`${consoleApiUrl}/service-reviews/${deciding.moderation.id}/resolve`, values);
      if (data.code !== 0) throw new Error(data.msg || "保存审核决定失败");
      message.success(values.decision === "pass" ? "审核已通过，发布时将再次校验提交版本。" : "审核已拒绝，卖家将收到你的修改建议。");
      setDeciding(undefined);
      setSelected(undefined);
      await query.refetch();
    } catch (error) {
      const conflict = axios.isAxiosError(error) && error.response?.status === 409;
      message.error(conflict ? "该审核已发生变化或已被处理，审核队列已刷新。" : "无法保存审核决定，请刷新队列后重试。");
      if (conflict) { setDeciding(undefined); setSelected(undefined); }
      await query.refetch();
    } finally { setSubmitting(false); }
  };
  const byteLimit = (max: number) => ({ validator: (_: unknown, value: string) =>
    !value || new TextEncoder().encode(value.trim()).length <= max ? Promise.resolve() : Promise.reject(new Error(`最多允许 ${max} 个 UTF-8 字节`)) });

  return <>
    <List title="服务审核" headerButtons={<Space wrap>
      <Select aria-label="审核状态" value={paging.status} style={{ width: 160 }} options={reviewStatuses.map(value => ({ value, label: reviewStatusLabels[value] }))}
        onChange={status => { setPaging({ status, cursors: ["0"] }); setSelected(undefined); }} />
      <Button onClick={() => void query.refetch()} loading={query.isFetching}>刷新</Button>
    </Space>}>
      {query.isError && <Alert type="error" showIcon message="无法加载服务审核，请重试。" style={{ marginBottom: 16 }} />}
      <Table<ReviewListing> dataSource={query.isError ? [] : page?.items} loading={query.isFetching} rowKey={row => row.moderation.id} pagination={false} scroll={{ x: 950 }}>
        <Table.Column<ReviewListing> title="提交的服务" render={(_, row) => <Button type="link" onClick={() => setSelected(row)}>{String(row.listing.title || row.moderation.commission_id)}</Button>} />
        <Table.Column<ReviewListing> title="服务 / 卖家 ID" render={(_, row) => <><div>{row.moderation.commission_id}</div><Typography.Text type="secondary">{row.moderation.seller_agent_id}</Typography.Text></>} />
        <Table.Column<ReviewListing> title="草稿版本" render={(_, row) => row.moderation.draft_version} />
        <Table.Column<ReviewListing> title="状态" render={(_, row) => <Tag>{reviewStatusLabels[row.moderation.status]}</Tag>} />
        <Table.Column<ReviewListing> title="审核建议" render={(_, row) => <><div>{[row.moderation.flag, row.moderation.field].filter(Boolean).join(" · ")}</div>{row.moderation.reason}</>} />
        <Table.Column<ReviewListing> title="提交时间" render={(_, row) => new Date(row.moderation.created_at).toLocaleString()} />
        <Table.Column<ReviewListing> title="操作" render={(_, row) => <Space><Button onClick={() => setSelected(row)}>详情</Button>{canResolve(row.moderation) && <Button type="primary" onClick={() => { setSelected(row); openDecision(row); }}>审核</Button>}</Space>} />
      </Table>
      <Space style={{ marginTop: 16 }}>
        <Button disabled={paging.cursors.length === 1 || query.isFetching} onClick={() => setPaging({ ...paging, cursors: paging.cursors.slice(0, -1) })}>上一页</Button>
        <Typography.Text>第 {paging.cursors.length} 页</Typography.Text>
        <Button disabled={!page?.next_cursor || query.isFetching || query.isError} onClick={() => { if (page?.next_cursor) setPaging({ ...paging, cursors: [...paging.cursors, page.next_cursor] }); }}>下一页</Button>
      </Space>
    </List>
    <Drawer title="已提交的服务快照" open={!!selected} onClose={() => setSelected(undefined)} width={760}>
      {selected && <>
        <Descriptions column={1} bordered size="small" items={[
          { key: "id", label: "审核 ID", children: selected.moderation.id },
          { key: "service", label: "服务 ID", children: selected.moderation.commission_id },
          { key: "draft", label: "提交的草稿版本", children: selected.moderation.draft_version },
          { key: "status", label: "状态", children: reviewStatusLabels[selected.moderation.status] },
          { key: "reason", label: "当前卖家指引", children: selected.moderation.reason || "—" },
          { key: "model", label: "模型初审结果", children: [selected.moderation.model_decision, selected.moderation.model_flag, selected.moderation.model_field, selected.moderation.model_reason].filter(Boolean).join(" · ") || "—" },
          { key: "operator", label: "审核操作人", children: selected.moderation.reviewer || "—" },
          { key: "decision", label: "人工审核决定", children: decisionLabel(selected.moderation.review_decision) },
          { key: "audit", label: "人工审核理由", children: selected.moderation.review_reason || "—" },
          { key: "at", label: "审核时间", children: selected.moderation.reviewed_at ? new Date(selected.moderation.reviewed_at).toLocaleString() : "—" },
        ]} />
        <Typography.Paragraph style={{ marginTop: 16 }}>这是提交审核时的精确快照，卖家后续编辑不会改变本次审核内容。</Typography.Paragraph>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(selected.listing, null, 2)}</pre>
        {canResolve(selected.moderation) && <Button type="primary" onClick={() => openDecision(selected)}>通过或拒绝</Button>}
      </>}
    </Drawer>
    <Modal title="处理服务审核" open={!!deciding} onCancel={() => { if (!submitting) setDeciding(undefined); }} onOk={() => void resolve()} confirmLoading={submitting} okText="提交审核决定" cancelButtonProps={{ disabled: submitting }} closable={!submitting} maskClosable={!submitting}>
      <Typography.Paragraph>{String(deciding?.listing.title || "")} · 草稿版本 {deciding?.moderation.draft_version}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">操作人是你填写的审核身份，并非已认证用户名。请使用服务信息所用语言填写审核理由。</Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="decision" label="审核决定" rules={[{ required: true }]}><Select options={[{ value: "pass", label: "通过" }, { value: "reject", label: "拒绝" }]} /></Form.Item>
        <Form.Item name="operator" label="操作人" rules={[{ required: true, whitespace: true }, byteLimit(200)]}><Input autoComplete="off" /></Form.Item>
        <Form.Item name="reason" label="审核理由 / 卖家指引" rules={[{ required: true, whitespace: true }, byteLimit(8000)]}><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
  </>;
};
