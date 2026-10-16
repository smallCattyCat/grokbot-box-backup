import fs from "node:fs/promises";
import path from "node:path";
import { checkCmoocToken, getCmoocPartnerApiToken, hasCmoocPartnerAccountConfig } from "@/lib/forum/cmooc-api";

const AUTH_STATE_PATH = path.join(process.cwd(), "playwright", "auth-state.json");

type StorageCookie = {
  name?: string;
  value?: string;
  domain?: string;
  expires?: number;
};

type StorageState = {
  cookies?: StorageCookie[];
};

async function tokenValid(token: string | null | undefined) {
  if (!token) return null;
  try {
    return await checkCmoocToken(token);
  } catch {
    return false;
  }
}

function expiresAt(expires: number | undefined) {
  if (!expires || expires < 0) return null;
  return new Date(expires * 1000).toISOString();
}

async function readPlaywrightSatoken() {
  try {
    const raw = await fs.readFile(AUTH_STATE_PATH, "utf8");
    const state = JSON.parse(raw) as StorageState;
    const cookie = state.cookies?.find((item) => item.name === "Satoken" && item.domain === "cmooc.bnu.edu.cn");
    return {
      exists: true,
      hasSatoken: Boolean(cookie?.value),
      expiresAt: expiresAt(cookie?.expires),
      token: cookie?.value ?? null
    };
  } catch (error) {
    return {
      exists: false,
      hasSatoken: false,
      expiresAt: null,
      token: null,
      error: error instanceof Error ? error.message : "无法读取 playwright/auth-state.json"
    };
  }
}

async function readPartnerAccountToken() {
  if (!hasCmoocPartnerAccountConfig()) {
    return {
      configured: false,
      token: null
    };
  }
  try {
    return {
      configured: true,
      token: await getCmoocPartnerApiToken()
    };
  } catch (error) {
    return {
      configured: true,
      token: null,
      error: error instanceof Error ? error.message : "学伴账号 API 登录失败"
    };
  }
}

export async function getCmoocAuthStatus() {
  const envToken = process.env.CMOOC_SATOKEN || null;
  const partnerAccount = await readPartnerAccountToken();
  const playwrightState = await readPlaywrightSatoken();
  const envTokenValid = await tokenValid(envToken);
  const partnerTokenValid = await tokenValid(partnerAccount.token);
  const playwrightTokenValid = await tokenValid(playwrightState.token);
  const readyForRealForumWrite = envTokenValid === true || partnerTokenValid === true || playwrightTokenValid === true;

  return {
    generatedAt: new Date().toISOString(),
    readyForRealForumWrite,
    sources: {
      envSatoken: {
        configured: Boolean(envToken),
        valid: envTokenValid
      },
      partnerAccount: {
        configured: partnerAccount.configured,
        valid: partnerTokenValid,
        error: "error" in partnerAccount ? partnerAccount.error : undefined
      },
      playwrightStorageState: {
        path: AUTH_STATE_PATH,
        exists: playwrightState.exists,
        hasSatoken: playwrightState.hasSatoken,
        expiresAt: playwrightState.expiresAt,
        valid: playwrightTokenValid,
        error: "error" in playwrightState ? playwrightState.error : undefined
      }
    },
    guidance: readyForRealForumWrite
      ? "登录态可用于真实论坛写入；真实发布前仍需当前对话明确确认目标帖子、内容和发布上限。"
      : "当前没有可用写入登录态。请配置 CMOOC_SATOKEN/CMOOC_PARTNER_ACCOUNT，或运行 npm run auth:save，在打开的浏览器中登录 cMOOC 后回到终端按 Enter，再运行 npm run auth:check。"
  };
}
