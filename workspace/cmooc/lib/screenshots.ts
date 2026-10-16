import path from "node:path";

export const screenshotRoot =
  process.env.SCREENSHOT_DIR || path.join(process.cwd(), "screenshots");

export function screenshotPath(fileName: string): string {
  return path.join(screenshotRoot, fileName);
}
