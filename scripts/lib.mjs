import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const FILES = ["main.js", "manifest.json", "styles.css", "LICENSE"];
export const LEGACY_IDS = ["axl-light-zh"];
export const REPOSITORY = "fogyoy/axl-light-fog";
export const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};
export const readJSON = async (file) =>
  JSON.parse(await fs.readFile(file, "utf8"));
export const writeJSON = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
};
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function run(command, args = [], options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}
export function options() {
  const result = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (
      !key.startsWith("--") ||
      !process.argv[i + 1] ||
      process.argv[i + 1].startsWith("--")
    )
      throw Error("参数需要值：" + key);
    result[key.slice(2)] = process.argv[++i];
  }
  return result;
}
export const manifest = () => readJSON(path.join(ROOT, "manifest.json"));
export const head = () => run("git", ["rev-parse", "HEAD"]);
export async function artifacts(directory = ROOT) {
  return Object.fromEntries(
    await Promise.all(
      FILES.map(async (name) => [
        name,
        hash(await fs.readFile(path.join(directory, name))),
      ]),
    ),
  );
}
export function evalVault(vault, code) {
  const result = run("obsidian", [
    "eval",
    "vault=" + vault.name,
    "code=" + code,
  ]);
  const at = result.indexOf("=> ");
  if (at < 0) throw Error("Obsidian 执行失败：" + result);
  return JSON.parse(result.slice(at + 3).trim());
}
export async function vaultAt(input) {
  if (!input) throw Error("必须提供 --vault-path，禁止默认使用活动笔记库");
  const directory = await fs.realpath(path.resolve(input));
  if (!(await exists(path.join(directory, ".obsidian"))))
    throw Error("指定目录不是已初始化的 Obsidian 笔记库");
  const vault = { directory, name: path.basename(directory) };
  const actual = evalVault(
    vault,
    "JSON.stringify(app.vault.adapter.getBasePath())",
  );
  if ((await fs.realpath(actual)) !== directory)
    throw Error("CLI 实际笔记库与 --vault-path 不一致");
  return vault;
}
export async function annotations(vault) {
  const directory = path.join(vault.directory, ".obsidian-annotations");
  const files = {},
    ids = [];
  if (await exists(directory))
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      const bytes = await fs.readFile(path.join(directory, entry));
      files[entry] = hash(bytes);
      if (entry === "index.json") continue;
      const document = JSON.parse(bytes);
      for (const field of [
        "highlights",
        "comments",
        "pdfHighlights",
        "pdfComments",
      ])
        for (const mark of document[field] ?? []) ids.push(mark.id);
    }
  return { files, ids: ids.sort() };
}
export async function enabled(vault) {
  return evalVault(vault, "JSON.stringify([...app.plugins.enabledPlugins])");
}
export function pluginCommand(vault, command, id) {
  const enabling = command === "plugin:enable";
  if (!enabling && command !== "plugin:disable") throw Error("未知插件操作");
  return evalVault(
    vault,
    `(async()=>{const id=${JSON.stringify(id)},on=${JSON.stringify(enabling)};await app.plugins[on?'enablePluginAndSave':'disablePluginAndSave'](id);for(let i=0;i<120;i++){if(app.plugins.enabledPlugins.has(id)===on && Boolean(app.plugins.plugins[id])===on)return JSON.stringify(true);await new Promise(r=>setTimeout(r,25));}throw Error('插件切换未完成');})()`,
  );
}
export function refreshManifests(vault) {
  return evalVault(
    vault,
    "(async()=>{await app.plugins.loadManifests();return JSON.stringify(true)})()",
  );
}
export async function noDrafts(vault, ids) {
  const state = evalVault(
    vault,
    `(()=>{const ids=${JSON.stringify(ids)};return JSON.stringify(ids.some(id=>{const p=app.plugins.plugins[id];if(!p)return false;if(p.commentModals?.size)return true;return [...(p.surfaces?.keys()??[document])].some(d=>d.querySelector('.axl-ov-edit:not(.hidden)'));}));})()`,
  );
  if (state)
    throw Error(
      "发现尚未完成的便签编辑。请先保存或取消，然后重试；未切换插件。",
    );
}
export async function backup(vault, ids) {
  const name =
    new Date().toISOString().replaceAll(/[:.]/g, "-") +
    "-" +
    path.basename(vault.directory);
  const directory = path.join(ROOT, ".local/backups", name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const before = {
    vault,
    ids,
    enabled: await enabled(vault),
    plugins: {},
    annotations: await annotations(vault),
    createdAt: new Date().toISOString(),
  };
  for (const id of ids) {
    const source = path.join(vault.directory, ".obsidian/plugins", id);
    const target = path.join(directory, "plugins", id);
    before.plugins[id] = { present: await exists(source), files: {} };
    if (before.plugins[id].present) {
      await fs.cp(source, target, { recursive: true });
      for (const name of [...FILES, "data.json"])
        if (await exists(path.join(source, name)))
          before.plugins[id].files[name] = hash(
            await fs.readFile(path.join(source, name)),
          );
    }
  }
  for (const name of ["hotkeys.json"]) {
    const source = path.join(vault.directory, ".obsidian", name);
    if (await exists(source))
      await fs.copyFile(source, path.join(directory, name));
    before[name] = (await exists(source))
      ? await fs.readFile(source, "utf8")
      : null;
  }
  const sidecars = path.join(vault.directory, ".obsidian-annotations");
  if (await exists(sidecars))
    await fs.cp(sidecars, path.join(directory, "annotations"), {
      recursive: true,
    });
  await writeJSON(path.join(directory, "backup.json"), before);
  return { directory, before };
}
export async function validatePackage(directory) {
  const packaged = await readJSON(path.join(directory, "manifest.json")),
    current = await manifest();
  if (packaged.id !== current.id || packaged.version !== current.version)
    throw Error("安装包身份或版本与当前项目不一致");
  if (
    (await fs.readFile(path.join(directory, "LICENSE"), "utf8")).indexOf(
      "Copyright (c) 2026 Axl Light contributors",
    ) < 0
  )
    throw Error("安装包缺少上游版权声明");
  return { manifest: packaged, artifacts: await artifacts(directory) };
}
export function fail(error) {
  process.stderr.write(
    (error.stderr?.toString().trim() || error.message) + "\n",
  );
  process.exitCode = 1;
}
