import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_STATE_PATH,
  runInteractiveAuthSave,
  type AuthSaveBrowser,
  type AuthSaveContext,
  type AuthSavePage,
  type AuthSaveLogger
} from "../../scripts/save-auth";

const LOGIN_URL_MARKER = "https://cmooc.bnu.edu.cn/cMOOC/login?token=URL_MARKER";
const TOKEN_MARKER = "token-marker-not-a-secret";

type FakeState = {
  gotoError?: Error;
  pageClosed?: boolean;
  browserConnected?: boolean;
  storageError?: Error;
  launches: string[];
  storagePaths: string[];
  browserCloseCount: number;
  enterWaitCount: number;
  logs: string[];
};

function fakeContext(state: FakeState): AuthSaveContext {
  return {
    storageState: async ({ path }: { path: string }) => {
      if (state.storageError) throw state.storageError;
      state.storagePaths.push(path);
    }
  };
}

function fakePage(state: FakeState): AuthSavePage {
  return {
    goto: async () => {
      if (state.gotoError) throw state.gotoError;
    },
    isClosed: () => state.pageClosed === true,
    context: () => fakeContext(state)
  };
}

function fakeBrowser(state: FakeState): AuthSaveBrowser {
  return {
    newPage: async () => fakePage(state),
    isConnected: () => state.browserConnected !== false,
    close: async () => {
      state.browserCloseCount += 1;
    }
  };
}

function logger(state: FakeState): AuthSaveLogger {
  return {
    info: (message) => state.logs.push(message),
    error: (message) => state.logs.push(message)
  };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    launches: [],
    storagePaths: [],
    browserCloseCount: 0,
    enterWaitCount: 0,
    logs: [],
    ...overrides
  };
}

test("导航异常仍等待 Enter 并保存登录态", async () => {
  const state = makeState({ gotoError: new Error(TOKEN_MARKER) });
  const browser = fakeBrowser(state);
  await runInteractiveAuthSave({
    loginUrl: LOGIN_URL_MARKER,
    launchSystemChrome: async () => {
      state.launches.push("system");
      return browser;
    },
    launchBundledChromium: async () => {
      state.launches.push("bundled");
      return browser;
    },
    waitForEnter: async () => {
      state.enterWaitCount += 1;
    },
    logger: logger(state),
    outputPath: "playwright/auth-state.json"
  });

  assert.equal(state.enterWaitCount, 1);
  assert.deepEqual(state.storagePaths, ["playwright/auth-state.json"]);
  assert.equal(state.browserCloseCount, 1);
  assert.equal(state.launches.join(","), "system");
  assert.ok(state.logs.some((message) => message.includes("AUTH_NAVIGATION_FAILED_CONTINUE")));
});

test("系统 Chrome 启动失败时安全回退 bundled Chromium", async () => {
  const state = makeState();
  const browser = fakeBrowser(state);
  await runInteractiveAuthSave({
    loginUrl: LOGIN_URL_MARKER,
    launchSystemChrome: async () => {
      state.launches.push("system");
      throw new Error(TOKEN_MARKER);
    },
    launchBundledChromium: async () => {
      state.launches.push("bundled");
      return browser;
    },
    waitForEnter: async () => undefined,
    logger: logger(state)
  });

  assert.deepEqual(state.launches, ["system", "bundled"]);
  assert.equal(state.browserCloseCount, 1);
  assert.ok(state.logs.includes("AUTH_SYSTEM_CHROME_FALLBACK"));
});

test("页面关闭或存储失败返回稳定码且 finally 关闭浏览器", async () => {
  const closedState = makeState({ pageClosed: true });
  await assert.rejects(
    runInteractiveAuthSave({
      loginUrl: LOGIN_URL_MARKER,
      launchSystemChrome: async () => fakeBrowser(closedState),
      launchBundledChromium: async () => fakeBrowser(closedState),
      waitForEnter: async () => undefined,
      logger: logger(closedState)
    }),
    (error: unknown) => error instanceof Error && error.message === "AUTH_PAGE_DISCONNECTED"
  );
  assert.equal(closedState.browserCloseCount, 1);

  const storageState = makeState({ storageError: new Error(TOKEN_MARKER) });
  await assert.rejects(
    runInteractiveAuthSave({
      loginUrl: LOGIN_URL_MARKER,
      launchSystemChrome: async () => fakeBrowser(storageState),
      launchBundledChromium: async () => fakeBrowser(storageState),
      waitForEnter: async () => undefined,
      logger: logger(storageState)
    }),
    (error: unknown) => error instanceof Error && error.message === "AUTH_STORAGE_SAVE_FAILED"
  );
  assert.equal(storageState.browserCloseCount, 1);
});

test("稳定日志不包含 URL 或 token marker", async () => {
  const state = makeState({ gotoError: new Error(TOKEN_MARKER) });
  await runInteractiveAuthSave({
    loginUrl: LOGIN_URL_MARKER,
    launchSystemChrome: async () => fakeBrowser(state),
    launchBundledChromium: async () => fakeBrowser(state),
    waitForEnter: async () => undefined,
    logger: logger(state)
  });

  const output = state.logs.join("\n");
  assert.equal(output.includes(LOGIN_URL_MARKER), false);
  assert.equal(output.includes(TOKEN_MARKER), false);
});

test("读取 Enter 后暂停 stdin，使交互登录进程可以自然退出", async () => {
  const state = makeState();
  let dataListener: ((...args: unknown[]) => void) | undefined;
  let pauseCount = 0;
  const stdin = {
    once(event: "data" | "error", listener: (...args: unknown[]) => void) {
      if (event === "data") dataListener = listener;
      if (event === "error") queueMicrotask(() => dataListener?.());
      return stdin;
    },
    removeListener() {
      return stdin;
    },
    pause() {
      pauseCount += 1;
      return stdin;
    }
  };

  await runInteractiveAuthSave({
    loginUrl: LOGIN_URL_MARKER,
    launchSystemChrome: async () => fakeBrowser(state),
    launchBundledChromium: async () => fakeBrowser(state),
    stdin,
    logger: logger(state)
  });

  assert.equal(pauseCount, 1);
  assert.deepEqual(state.storagePaths, [AUTH_STATE_PATH]);
});
