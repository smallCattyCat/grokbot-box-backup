import { resolve } from "node:path";
import {
  auditP3aDecisionArtifacts,
  P3aBridgeError
} from "../lib/facilitation-protocol";

interface Options {
  inputDirectory: string;
  json: boolean;
}

function usage(): string {
  return [
    "用法：npm run p4:protocol:audit -- [--input-dir <path>] [--json]",
    "",
    "只读核验 P3A decision snapshot，并生成不含行级数据的 P4A 桥接摘要。",
    "默认输入：%LOCALAPPDATA%\\cmooc-research\\p3a\\decision-snapshot-v1"
  ].join("\n");
}

function parseOptions(arguments_: string[]): Options {
  let inputDirectory: string | undefined;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--input-dir") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new P3aBridgeError(
          "INPUT_DIRECTORY_REQUIRED",
          "--input-dir 缺少路径。"
        );
      }
      inputDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new P3aBridgeError(
      "UNKNOWN_ARGUMENT",
      `不支持参数 ${argument}。`
    );
  }
  if (inputDirectory === undefined) {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new P3aBridgeError(
        "LOCALAPPDATA_REQUIRED",
        "未设置 LOCALAPPDATA，必须显式提供 --input-dir。"
      );
    }
    inputDirectory = resolve(
      localAppData,
      "cmooc-research",
      "p3a",
      "decision-snapshot-v1"
    );
  }
  return { inputDirectory, json };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await auditP3aDecisionArtifacts(
    options.inputDirectory
  );
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    [
      "P4A 协议桥接审计通过",
      `快照行数：${summary.rowCount}`,
      `2024 开发集：${summary.developmentCount}`,
      `2025 时间留出：${summary.timeHoldoutCount}`,
      `冻结时钟：主帖后 ${summary.fixedDecisionLagHours} 小时决策，主帖后 ${summary.fixedOutcomeEndHours} 小时观察终止`,
      `证据引用集合哈希：${summary.evidenceRefSetHash}`,
      "论坛正文：未包含；网络：未使用；文件写入：未执行"
    ].join("\n")
  );
}

main().catch((error: unknown) => {
  if (error instanceof P3aBridgeError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(`P4_PROTOCOL_AUDIT_FAILED: ${error.message}`);
  } else {
    console.error("P4_PROTOCOL_AUDIT_FAILED: 未知错误。");
  }
  process.exitCode = 1;
});
