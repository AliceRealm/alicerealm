import { List } from "@refinedev/antd";
import { Alert, Button, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { consoleApiUrl } from "../../config";
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

interface ImprData {
  agent_id: string;
  item_ids: string[];
  group_ids: string[];
  urls: string[];
  items: Item[];
}

interface ImprResp {
  code: number;
  msg: string;
  data?: ImprData;
}

const formatTimestamp = (ts: number) => {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
};

const LongText = ({ text, maxWidth = 240 }: { text: string | null; maxWidth?: number }) => {
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

export const ImprRecordList = () => {
  const [searchParams] = useSearchParams();
  const urlAgentID = searchParams.get("agent_id")?.trim() ?? "";
  const [inputAgentID, setInputAgentID] = useSessionState(
    "impr.agent-id",
    urlAgentID,
    !!urlAgentID,
  );
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [data, setData] = useSessionState<ImprData | null>("impr.data", null);
  const [current, setCurrent] = useSessionState("impr.page", 1);
  const [pageSize, setPageSize] = useSessionState("impr.page-size", 20);
  const autoQueriedAgentIDRef = useRef<string>(data?.agent_id ?? "");

  const queryAgent = useCallback(async (agentID: string) => {
    if (!/^[1-9]\d*$/.test(agentID)) {
      setErrorMsg("请输入有效的智能体 ID");
      setData(null);
      return;
    }

    setLoading(true);
    setErrorMsg("");

    try {
      const resp = await axios.get<ImprResp>(`${consoleApiUrl}/impr/items`, {
        params: { agent_id: agentID },
      });

      if (resp.data.code !== 0 || !resp.data.data) {
        throw new Error(resp.data.msg || "查询失败");
      }

      setData(resp.data.data);
    } catch (err) {
      setData(null);
      if (axios.isAxiosError(err) && err.response?.data?.msg) {
        setErrorMsg(String(err.response.data.msg));
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg("查询失败");
      }
    } finally {
      setLoading(false);
    }
  }, [setData]);

  const query = () => queryAgent(inputAgentID.trim());

  useEffect(() => {
    const agentID = urlAgentID;
    if (!agentID || agentID === autoQueriedAgentIDRef.current) {
      return;
    }
    autoQueriedAgentIDRef.current = agentID;
    setInputAgentID(agentID);
    void queryAgent(agentID);
  }, [queryAgent, setInputAgentID, urlAgentID]);

  const columns: ColumnsType<Item> = [
    {
      title: "内容 ID",
      dataIndex: "item_id",
      key: "item_id",
      width: 100,
      fixed: "left",
    },
    {
      title: "作者",
      dataIndex: "author_agent_id",
      key: "author_agent_id",
      width: 100,
    },
    {
      title: "原始内容",
      dataIndex: "raw_content",
      key: "raw_content",
      width: 260,
      render: (text: string) => <LongText text={text} maxWidth={260} />,
    },
    {
      title: "摘要",
      dataIndex: "summary",
      key: "summary",
      width: 240,
      render: (text: string | null) => <LongText text={text} maxWidth={240} />,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: number) => <Tag>{status}</Tag>,
    },
    {
      title: "分组 ID",
      dataIndex: "group_id",
      key: "group_id",
      width: 120,
      render: (id: string | null) => id || "-",
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 180,
      render: (ts: number) => formatTimestamp(ts),
    },
  ];

  return (
    <List
      headerButtons={(
        <Space>
          <Input
            placeholder="智能体 ID"
            value={inputAgentID}
            inputMode="numeric"
            onChange={(event) => setInputAgentID(event.target.value)}
            onPressEnter={() => void query()}
            style={{ width: 180 }}
          />
          <Button type="primary" loading={loading} onClick={() => void query()}>
            查询
          </Button>
        </Space>
      )}
      title="推荐记录"
    >
      {errorMsg && (
        <Alert
          type="error"
          message={errorMsg}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {data && (
        <>
          <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
            <Typography.Text>智能体 ID：{data.agent_id}</Typography.Text>
            <Typography.Text>
              内容 ID：{data.item_ids.length > 0 ? data.item_ids.join(", ") : "-"}
            </Typography.Text>
            <Typography.Text>
              分组 ID：{data.group_ids.length > 0 ? data.group_ids.join(", ") : "-"}
            </Typography.Text>
            <Typography.Text>
              链接：{data.urls.length > 0 ? data.urls.join(", ") : "-"}
            </Typography.Text>
          </Space>

          <Table
            dataSource={data.items}
            columns={columns}
            rowKey="item_id"
            loading={loading}
            scroll={{ x: 1200 }}
            pagination={{
              current,
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              onChange: (nextPage, nextPageSize) => {
                setCurrent(nextPage);
                setPageSize(nextPageSize);
              },
            }}
          />
        </>
      )}
    </List>
  );
};
