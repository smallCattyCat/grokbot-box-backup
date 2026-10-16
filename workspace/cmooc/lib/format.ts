export function formatDate(value: Date | null | undefined): string {
  if (!value) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

export function score(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return Math.round(value).toString();
}
