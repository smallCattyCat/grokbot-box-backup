import { prisma } from "@/lib/db";
import { REAL_FORUM_WRITE_LOCKED } from "@/lib/forum/real-write-lock";

export type ForumSettingsInput = {
  forumBaseUrl: string;
  loginUrl: string;
  postUrlPattern: string;
  replyEditorSelector: string;
  replySubmitSelector: string;
  replySuccessSelector: string;
  realPublishEnabled: boolean;
};

export const defaultForumSettings: ForumSettingsInput = {
  forumBaseUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
  loginUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
  postUrlPattern: "",
  replyEditorSelector: ".comment_container #edit .ql-editor",
  replySubmitSelector: ".comment_container .buttons .right",
  replySuccessSelector: "",
  realPublishEnabled: false
};

export async function getForumSettings() {
  const settings = await prisma.forumSetting.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      ...defaultForumSettings
    }
  });
  return REAL_FORUM_WRITE_LOCKED && settings.realPublishEnabled
    ? { ...settings, realPublishEnabled: false }
    : settings;
}

export async function updateForumSettings(input: ForumSettingsInput) {
  const effectiveInput = {
    ...input,
    realPublishEnabled: REAL_FORUM_WRITE_LOCKED
      ? false
      : input.realPublishEnabled
  };
  return prisma.forumSetting.upsert({
    where: { id: "default" },
    update: effectiveInput,
    create: {
      id: "default",
      ...effectiveInput
    }
  });
}

export function validateRealForumSettings(settings: ForumSettingsInput): string[] {
  const missing: string[] = [];
  if (!settings.forumBaseUrl.trim()) missing.push("forumBaseUrl");
  if (!settings.loginUrl.trim()) missing.push("loginUrl");
  return missing;
}
