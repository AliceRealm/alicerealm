// Item processing status codes.
export const ITEM_STATUS_PENDING = 0;
export const ITEM_STATUS_PROCESSING = 1;
export const ITEM_STATUS_FAILED = 2;
export const ITEM_STATUS_COMPLETED = 3;
export const ITEM_STATUS_DISCARDED = 4;
export const ITEM_STATUS_DELETED = 5;

export const itemStatusMap: Record<number, { label: string; color: string }> = {
  [ITEM_STATUS_PENDING]: { label: "待处理", color: "default" },
  [ITEM_STATUS_PROCESSING]: { label: "处理中", color: "processing" },
  [ITEM_STATUS_FAILED]: { label: "失败", color: "error" },
  [ITEM_STATUS_COMPLETED]: { label: "已完成", color: "success" },
  [ITEM_STATUS_DISCARDED]: { label: "已丢弃", color: "warning" },
  [ITEM_STATUS_DELETED]: { label: "已删除", color: "default" },
};
