import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { getForumSettings } from "@/lib/settings";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";

export const AUTH_STATE_PATH = path.join("playwright", "auth-state.json");
export const AUTH_CLOSE_TIMEOUT_MS = 5_000;

export type AuthSaveLogger = {
  info?: (message: string) => void;
  error?: (message: string) => void;
  log?: (message: string) => void;
};

export type AuthSaveContext = {
  storageState(options: { path: string }): Promise<unknown>;
};

export type AuthSavePage = {
  goto(url: string): Promise<unknown>;
  context(): AuthSaveContext;
  isClosed?: () => boolean;
};

export type AuthSaveBrowser = {
  newPage(): Promise<AuthSavePage>;
  close(): Promise<void>;
  isConnected?: () => boolean;
};

export type AuthSaveInput = {
  once(event: "data" | "error", listener: (...args: unknown[]) => void): unknown;
  removeListener?: (
    event: "data" | "error",
    listener: (...args: unknown[]) => void
  ) => unknown;
  pause?: () => unknown;
};

export type InteractiveAuthSaveOptions = {
  loginUrl: string;
  outputPath?: string;
  launchSystemChrome?: () => Promise<AuthSaveBrowser>;
  launchBundledChromium?: () => Promise<AuthSaveBrowser>;
  waitForEnter?: () => Promise<void>;
  stdin?: AuthSaveInput;
  logger?: AuthSaveLogger;
  mkdir?: (directory: string, options: { recursive: true }) => Promise<unknown>;
  closeTimeoutMs?: number;
};

export type AuthSaveErrorCode =
  | "AUTH_LOGIN_URL_MISSING"
  | "AUTH_LOGIN_URL_INVALID"
  | "AUTH_STORAGE_DIRECTORY_FAILED"
  | "AUTH_SYSTEM_CHROME_FALLBACK"
  | "AUTH_BROWSER_LAUNCH_FAILED"
  | "AUTH_BROWSER_DISCONNECTED"
  | "AUTH_PAGE_CREATE_FAILED"
  | "AUTH_PAGE_DISCONNECTED"
  | "AUTH_CONTEXT_DISCONNECTED"
  | "AUTH_INPUT_FAILED"
  | "AUTH_STORAGE_SAVE_FAILED"
  | "AUTH_CLEANUP_FAILED";

export class AuthSaveError extends Error {
  readonly code: AuthSaveErrorCode;

  constructor(code: AuthSaveErrorCode) {
    super(code);
    this.name = "AuthSaveError";
    this.code = code;
  }
}

function emitInfo(logger: AuthSaveLogger | undefined, message: string): void {
  try {
    if (logger?.info) {
      logger.info(message);
    } else if (logger?.log) {
      logger.log(message);
    }
  } catch {
    // Logging is deliberately best effort and must never expose an underlying error.
  }
}

function emitError(logger: AuthSaveLogger | undefined, code: AuthSaveErrorCode): void {
  try {
    if (logger?.error) {
      logger.error(code);
    } else if (logger?.log) {
      logger.log(code);
    }
  } catch {
    // Logging is deliberately best effort and must never expose an underlying error.
  }
}

function browserIsConnected(browser: AuthSaveBrowser): boolean {
  if (!browser.isConnected) return true;
  try {
    return browser.isConnected();
  } catch {
    return false;
  }
}

function pageIsConnected(page: AuthSavePage): boolean {
  if (!page.isClosed) return true;
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

function safeError(
  error: unknown,
  fallback: AuthSaveErrorCode
): AuthSaveError {
  if (error instanceof AuthSaveError) return error;
  return new AuthSaveError(fallback);
}

async function waitForEnterFromInput(input: AuthSaveInput): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const detach = () => {
      input.removeListener?.("data", onData);
      input.removeListener?.("error", onError);
      try {
        input.pause?.();
      } catch {
        // Stdin cleanup is best effort; the login result remains authoritative.
      }
    };
    const onData = () => {
      detach();
      resolve();
    };
    const onError = () => {
      detach();
      reject(new AuthSaveError("AUTH_INPUT_FAILED"));
    };
    input.once("data", onData);
    input.once("error", onError);
  });
}

async function closeBrowserBounded(
  browser: AuthSaveBrowser,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("close_timeout")), timeoutMs);
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultLogger(): AuthSaveLogger {
  return {
    info: (message) => console.log(message),
    error: (message) => console.error(message)
  };
}

/**
 * Opens a visible browser for a user-managed login and persists its storage state.
 *
 * Browser launchers, input, filesystem, and logging are injectable so this safety
 * boundary can be tested without opening a browser or touching auth-state files.
 */
export async function runInteractiveAuthSave(
  options: InteractiveAuthSaveOptions
): Promise<void> {
  const logger = options.logger;
  const outputPath = options.outputPath ?? AUTH_STATE_PATH;
  const mkdir = options.mkdir ?? ((directory, mkdirOptions) => fs.mkdir(directory, mkdirOptions));
  const launchSystemChrome =
    options.launchSystemChrome ??
    (() => chromium.launch({ channel: "chrome", headless: false }));
  const launchBundledChromium =
    options.launchBundledChromium ?? (() => chromium.launch({ headless: false }));
  const waitForEnter =
    options.waitForEnter ??
    (() => waitForEnterFromInput(options.stdin ?? (process.stdin as unknown as AuthSaveInput)));

  let browser: AuthSaveBrowser | undefined;
  let failure: AuthSaveError | undefined;

  try {
    try {
      await mkdir(path.dirname(outputPath), { recursive: true });
    } catch {
      throw new AuthSaveError("AUTH_STORAGE_DIRECTORY_FAILED");
    }

    try {
      browser = await launchSystemChrome();
    } catch {
      emitInfo(logger, "AUTH_SYSTEM_CHROME_FALLBACK");
      try {
        browser = await launchBundledChromium();
      } catch {
        throw new AuthSaveError("AUTH_BROWSER_LAUNCH_FAILED");
      }
    }

    if (!browser || !browserIsConnected(browser)) {
      throw new AuthSaveError("AUTH_BROWSER_DISCONNECTED");
    }

    let page: AuthSavePage;
    try {
      page = await browser.newPage();
    } catch {
      throw new AuthSaveError("AUTH_PAGE_CREATE_FAILED");
    }
    if (!pageIsConnected(page)) {
      throw new AuthSaveError("AUTH_PAGE_DISCONNECTED");
    }

    try {
      await page.goto(options.loginUrl);
    } catch {
      // A transient navigation error must not close the visible browser. The user
      // can repair the page or navigate manually before confirming in the terminal.
      emitInfo(logger, "AUTH_NAVIGATION_FAILED_CONTINUE");
    }

    if (!browserIsConnected(browser)) {
      throw new AuthSaveError("AUTH_BROWSER_DISCONNECTED");
    }
    if (!pageIsConnected(page)) {
      throw new AuthSaveError("AUTH_PAGE_DISCONNECTED");
    }

    emitInfo(logger, "AUTH_MANUAL_LOGIN_REQUIRED");
    try {
      await waitForEnter();
    } catch {
      throw new AuthSaveError("AUTH_INPUT_FAILED");
    }

    if (!browserIsConnected(browser)) {
      throw new AuthSaveError("AUTH_BROWSER_DISCONNECTED");
    }
    if (!pageIsConnected(page)) {
      throw new AuthSaveError("AUTH_PAGE_DISCONNECTED");
    }

    let context: AuthSaveContext;
    try {
      context = page.context();
    } catch {
      throw new AuthSaveError("AUTH_CONTEXT_DISCONNECTED");
    }
    try {
      await context.storageState({ path: outputPath });
    } catch {
      throw new AuthSaveError("AUTH_STORAGE_SAVE_FAILED");
    }
    emitInfo(logger, "AUTH_STATE_SAVED");
  } catch (error) {
    failure = safeError(error, "AUTH_BROWSER_LAUNCH_FAILED");
  } finally {
    if (browser) {
      const closed = await closeBrowserBounded(
        browser,
        options.closeTimeoutMs ?? AUTH_CLOSE_TIMEOUT_MS
      );
      if (!closed && !failure) {
        failure = new AuthSaveError("AUTH_CLEANUP_FAILED");
      }
      if (!closed) emitError(logger, "AUTH_CLEANUP_FAILED");
    }
  }

  if (failure) {
    emitError(logger, failure.code);
    throw failure;
  }
}

async function main(): Promise<void> {
  const logger = defaultLogger();
  try {
    const settings = await getForumSettings();
    const configuredLoginUrl = process.env.REAL_FORUM_LOGIN_URL || settings.loginUrl;
    if (!configuredLoginUrl) {
      throw new AuthSaveError("AUTH_LOGIN_URL_MISSING");
    }
    let loginUrl: string;
    try {
      loginUrl = assertAllowedForumUrl(configuredLoginUrl, "论坛登录地址");
    } catch {
      throw new AuthSaveError("AUTH_LOGIN_URL_INVALID");
    }
    await runInteractiveAuthSave({ loginUrl, logger });
  } catch (error) {
    const failure = safeError(error, "AUTH_BROWSER_LAUNCH_FAILED");
    emitError(logger, failure.code);
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      emitError(logger, "AUTH_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  void main();
}
