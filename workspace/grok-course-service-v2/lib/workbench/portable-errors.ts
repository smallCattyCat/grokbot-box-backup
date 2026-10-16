import { ZodError } from "zod";

export type PortableFailureStage = "request" | "authentication" | "claim" | "observation" | "proposals" | "middle_layer" | "finish" | "management" | "startup";
export function portableFailure(error: unknown, stage: PortableFailureStage, context: { operationId?: string; savedProgress?: string } = {}) {
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown } | null;
  const structured = typeof candidate?.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(candidate.code) ? candidate.code : "";
  const known = typeof candidate?.message === "string" && /^(?:BROWSER_|EXPERIENCE_|PROJECTION_|SERVICE_|PUBLIC_LIBRARY_)[A-Z0-9_]{1,100}$/.test(candidate.message) ? candidate.message : "";
  let code = structured || known || (error instanceof ZodError || error instanceof SyntaxError ? "INPUT_INVALID" : stage === "middle_layer" ? "MIDDLE_LAYER_UNAVAILABLE" : "INTERNAL_UNAVAILABLE");
  if (/^P\d{4}$/.test(code)) code = code === "P2002" ? "PROJECTION_CONFLICT" : "DATABASE_UNAVAILABLE";
  const auth = /^(?:BRIDGE_|RELOGIN_|AUTH_)/.test(code);
  const lease = /LEASE|CLAIMED|EXECUTION_STALE/.test(code);
  const transient = ["DATABASE_UNAVAILABLE", "MIDDLE_LAYER_UNAVAILABLE", "INTERNAL_UNAVAILABLE"].includes(code);
  const retryable = transient;
  const recoveryAction = auth ? "restore_authorized_connection" : lease ? "read_status_and_resume_session" :
    code === "GUIDANCE_PENDING" ? "read_guidance_then_retry" : transient ? "check_service_doctor_then_retry_same_operation" :
    /CONFLICT|IMMUTABLE/.test(code) ? "read_status_do_not_change_saved_operation" : "correct_input_then_retry";
  const messages: Record<string, string> = {
    INPUT_INVALID: "输入结构无效；按字段路径核对契约。",
    DATABASE_UNAVAILABLE: "数据库尚未就绪；已保存的浏览器观察不会被清除。",
    MIDDLE_LAYER_UNAVAILABLE: "中层投影未完成；先检查服务，再用相同操作编号重试。",
    PROJECTION_CONFLICT: "中层记录发生身份或版本冲突；请读取当前回合，勿更换重试载荷。",
    LEASE_STALE: "执行租约已失效；读取回合状态并恢复原会话。",
    RUN_CLAIMED: "该回合由另一有效会话持有；不要抢占或重复创建。"
  };
  const message = messages[code] ?? (auth ? "连接或课程登录需要恢复。" : `${stage} 阶段未完成，请按 recoveryAction 处理。`);
  const status = typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status <= 599 ? candidate.status :
    auth ? 403 : /CONFLICT|STALE|CLAIMED|IMMUTABLE/.test(code) ? 409 : transient ? 503 : 400;
  return { status, body: {
    error: message, message, code, stage, retryable, recoveryAction, ...context,
    ...(error instanceof ZodError ? { issues: error.issues.map(issue => ({ path: issue.path.map(String).join("."), code: issue.code })) } : {})
  } };
}
