import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, run, fail } from "./lib.mjs";

try {
  const names = run("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  const denied =
    /(^|\/)(?:\.local|node_modules|\.obsidian|\.obsidian-annotations|outputs|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|(^|\/)data\.json$/;
  const secret =
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{40,})/;
  for (const name of names) {
    if (denied.test(name)) throw Error("公开目录包含私有或生成文件：" + name);
    let bytes;
    try {
      bytes = await fs.readFile(path.join(ROOT, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (
      /\/(?:Users|home)\/[^/\s]+\/|\/(?:private\/)?var\/folders\/|\/Volumes\/[^/\s]+\//.test(
        text,
      ) ||
      /file:\/\//.test(text)
    )
      throw Error("公开文件包含个人绝对路径：" + name);
    if (secret.test(text)) throw Error("公开文件可能包含凭据：" + name);
  }
  console.log("公开文件检查通过");
} catch (error) {
  fail(error);
}
