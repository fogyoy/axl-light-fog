import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  FILES,
  LEGACY_IDS,
  exists,
  readJSON,
  writeJSON,
  manifest,
  artifacts,
  hash,
  vaultAt,
  evalVault,
  enabled,
  pluginCommand,
  refreshManifests,
  noDrafts,
  backup,
  annotations,
  validatePackage,
} from "./lib.mjs";

async function hotkeys(vault) {
  const file = path.join(vault.directory, ".obsidian/hotkeys.json");
  return { file, value: (await exists(file)) ? await readJSON(file) : {} };
}
async function saveHotkeys(vault, value) {
  await writeJSON(path.join(vault.directory, ".obsidian/hotkeys.json"), value);
  evalVault(
    vault,
    "(async()=>{await app.hotkeyManager.load();return JSON.stringify(true)})()",
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function rollback(directory) {
  const allowed = path.join(ROOT, ".local/backups") + path.sep;
  directory = await fs.realpath(path.resolve(directory));
  if (!directory.startsWith(allowed))
    throw Error("只接受本项目 .local/backups 中的回退记录");
  const state = await readJSON(path.join(directory, "backup.json"));
  const info = await manifest(),
    managed = [...LEGACY_IDS, info.id];
  if (
    !Array.isArray(state.ids) ||
    state.ids.some((id) => !managed.includes(id))
  )
    throw Error("回退记录的插件身份无效");
  const vault = await vaultAt(state.vault.directory);
  await noDrafts(vault, managed);
  const currentAnnotations = await annotations(vault);
  for (const id of state.ids)
    for (const name of FILES) {
      const saved = path.join(directory, "plugins", id, name),
        expected = state.plugins[id].files[name];
      if (expected && hash(await fs.readFile(saved)) !== expected)
        throw Error("回退备份校验失败：" + id + "/" + name);
    }
  for (const id of managed)
    if ((await enabled(vault)).includes(id))
      pluginCommand(vault, "plugin:disable", id);
  for (const id of state.ids) {
    const target = path.join(vault.directory, ".obsidian/plugins", id);
    const data = path.join(target, "data.json");
    if (!state.plugins[id].files["data.json"] && (await exists(data))) {
      const retained = path.join(directory, "retained-settings", id);
      await fs.mkdir(retained, { recursive: true });
      await fs.copyFile(data, path.join(retained, "data.json"));
      await fs.unlink(data);
    }
    for (const name of FILES) {
      const saved = path.join(directory, "plugins", id, name),
        file = path.join(target, name);
      if (state.plugins[id].files[name]) {
        await fs.mkdir(target, { recursive: true });
        await fs.copyFile(saved, file);
      } else if (await exists(file)) await fs.unlink(file);
    }
  }
  const keys = await hotkeys(vault),
    prior = state["hotkeys.json"] ? JSON.parse(state["hotkeys.json"]) : {};
  for (const key of Object.keys(keys.value))
    if (managed.some((id) => key.startsWith(id + ":"))) delete keys.value[key];
  for (const [key, value] of Object.entries(prior))
    if (managed.some((id) => key.startsWith(id + ":"))) keys.value[key] = value;
  if (state["hotkeys.json"] !== null || Object.keys(keys.value).length)
    await saveHotkeys(vault, keys.value);
  refreshManifests(vault);
  for (const id of state.enabled.filter((id) => managed.includes(id)))
    pluginCommand(vault, "plugin:enable", id);
  const expected = state.enabled.filter((id) => managed.includes(id)).sort();
  if (
    !same(
      (await enabled(vault)).filter((id) => managed.includes(id)).sort(),
      expected,
    )
  )
    throw Error("回退后的启用状态与记录不同");
  if (
    !evalVault(
      vault,
      `JSON.stringify(${JSON.stringify(expected)}.every(id=>Boolean(app.plugins.plugins[id])))`,
    )
  )
    throw Error("回退插件未成功加载");
  if (!same(currentAnnotations, await annotations(vault)))
    throw Error("回退后旁注发生变化，请保留现场并检查");
  await writeJSON(path.join(directory, "rollback-result.json"), {
    status: "passed",
    timestamp: new Date().toISOString(),
    annotationIdsPreserved: currentAnnotations.ids.length,
  });
  return {
    status: "rolled-back",
    backup: directory,
    annotationIdsPreserved: currentAnnotations.ids.length,
  };
}

export async function install({ vaultPath, from }) {
  const info = await manifest(),
    source = path.resolve(
      from ?? path.join(ROOT, "dist", info.version, info.id),
    );
  const packaged = await validatePackage(source),
    vault = await vaultAt(vaultPath);
  const managed = [...LEGACY_IDS, info.id],
    initial = await enabled(vault);
  if (initial.includes("axl-light"))
    throw Error("请先停用原版 axl-light，避免多个插件同时写入同一旁注库");
  await noDrafts(vault, managed);
  const plugins = path.join(vault.directory, ".obsidian/plugins"),
    target = path.join(plugins, info.id);
  let oldId = LEGACY_IDS.find((id) => initial.includes(id));
  if (!oldId)
    for (const id of LEGACY_IDS)
      if (await exists(path.join(plugins, id, "manifest.json"))) {
        oldId = id;
        break;
      }
  const sourceId = (await exists(path.join(target, "manifest.json")))
    ? info.id
    : oldId;
  const keys = await hotkeys(vault),
    nextKeys = structuredClone(keys.value);
  for (const old of LEGACY_IDS)
    for (const [key, value] of Object.entries(keys.value))
      if (key.startsWith(old + ":")) {
        const next = info.id + key.slice(old.length);
        if (next in nextKeys && !same(nextKeys[next], value))
          throw Error("新旧插件存在不同的快捷键配置，未执行切换");
        nextKeys[next] = value;
        delete nextKeys[key];
      }
  const sourceData = sourceId
    ? path.join(plugins, sourceId, "data.json")
    : null;
  const targetData = path.join(target, "data.json");
  const expectedSettings = (await exists(targetData))
    ? hash(await fs.readFile(targetData))
    : sourceData && (await exists(sourceData))
      ? hash(await fs.readFile(sourceData))
      : null;
  const { directory, before } = await backup(vault, managed);
  const sidebarWasOpen = evalVault(
    vault,
    `JSON.stringify(app.workspace.getLeavesOfType('axl-light-sidebar').length+app.workspace.getLeavesOfType(${JSON.stringify(info.id + "-sidebar")}).length>0)`,
  );
  try {
    for (const id of managed)
      if ((await enabled(vault)).includes(id))
        pluginCommand(vault, "plugin:disable", id);
    await fs.mkdir(target, { recursive: true });
    for (const name of FILES)
      await fs.copyFile(path.join(source, name), path.join(target, name));
    if (!(await exists(targetData)) && sourceData && (await exists(sourceData)))
      await fs.copyFile(sourceData, targetData);
    if (!same(keys.value, nextKeys)) await saveHotkeys(vault, nextKeys);
    refreshManifests(vault);
    pluginCommand(vault, "plugin:enable", info.id);
    const runtime = evalVault(
      vault,
      `(()=>{const p=app.plugins.plugins[${JSON.stringify(info.id)}];return JSON.stringify(p?{id:p.manifest.id,version:p.manifest.version,name:p.manifest.name}:null)})()`,
    );
    if (!runtime || runtime.id !== info.id || runtime.version !== info.version)
      throw Error("新插件未成功加载");
    if (!same(await artifacts(target), packaged.artifacts))
      throw Error("本机文件与安装包校验值不同");
    if (
      expectedSettings &&
      hash(await fs.readFile(targetData)) !== expectedSettings
    )
      throw Error("迁移后的设置与原设置不同");
    if (!same(before.annotations, await annotations(vault)))
      throw Error("迁移过程中旁注发生变化");
    const active = await enabled(vault);
    if (
      !active.includes(info.id) ||
      LEGACY_IDS.some((id) => active.includes(id))
    )
      throw Error("插件启用状态不符合预期");
    if (sidebarWasOpen)
      evalVault(
        vault,
        `(async()=>{await app.plugins.plugins[${JSON.stringify(info.id)}].activateSidebar();return JSON.stringify(true)})()`,
      );
    const result = {
      status: "installed",
      backup: directory,
      pluginId: info.id,
      version: info.version,
      artifacts: packaged.artifacts,
      annotationIdsPreserved: before.annotations.ids.length,
      settingsPreserved: true,
    };
    await writeJSON(path.join(directory, "install-result.json"), result);
    await writeJSON(path.join(ROOT, ".local/last-install.json"), result);
    return result;
  } catch (error) {
    try {
      await rollback(directory);
    } catch (recovery) {
      throw new AggregateError(
        [error, recovery],
        "安装未完成，自动回退也遇到错误。备份位于 " + directory,
      );
    }
    throw new Error("安装未完成，已自动回退。原因：" + error.message);
  }
}
