import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  FILES,
  LEGACY_IDS,
  manifest,
  options,
  readJSON,
  writeJSON,
  exists,
  artifacts,
  head,
  vaultAt,
  evalVault,
  enabled,
  backup,
  annotations,
  pluginCommand,
  refreshManifests,
  fail,
} from "../scripts/lib.mjs";
import { install, rollback } from "../scripts/local-install.mjs";

const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
let vault, initial, fixture, receipt;
const receiptFile = path.join(ROOT, ".local/evidence/installation.json");
await fs.rm(receiptFile, { force: true });
try {
  const args = options(),
    info = await manifest();
  if (!args["legacy-package"])
    throw Error("必须提供 --legacy-package 指向旧中文维护版的程序文件");
  const legacyDirectory = path.resolve(args["legacy-package"]),
    legacy = await readJSON(path.join(legacyDirectory, "manifest.json"));
  assert(LEGACY_IDS.includes(legacy.id), "只支持明确登记的旧插件身份");
  vault = await vaultAt(args["vault-path"]);
  assert(
    (await readJSON(path.join(vault.directory, ".axl-test-vault.json")))
      .purpose === "axl-light-fog-e2e",
    "安装演练只允许独立测试库",
  );
  const start = head();
  initial = await backup(vault, [...LEGACY_IDS, info.id]);
  const plugins = path.join(vault.directory, ".obsidian/plugins");
  for (const id of [...LEGACY_IDS, info.id])
    if ((await enabled(vault)).includes(id))
      pluginCommand(vault, "plugin:disable", id);
  for (const name of [...FILES, "data.json"])
    await fs.rm(path.join(plugins, info.id, name), { force: true });
  await fs.mkdir(path.join(plugins, legacy.id), { recursive: true });
  for (const name of FILES)
    if (await exists(path.join(legacyDirectory, name)))
      await fs.copyFile(
        path.join(legacyDirectory, name),
        path.join(plugins, legacy.id, name),
      );
  const settings = {
    defaultAuthor: "合成作者",
    defaultHighlightColor: "blue",
    stickyWidth: 300,
  };
  await writeJSON(path.join(plugins, legacy.id, "data.json"), settings);
  refreshManifests(vault);
  pluginCommand(vault, "plugin:enable", legacy.id);
  fixture = "_Fog_Installation_" + randomUUID().slice(0, 8) + ".md";
  const id1 = randomUUID(),
    id2 = randomUUID();
  evalVault(
    vault,
    `(async()=>{const file=await app.vault.create(${JSON.stringify(fixture)},${JSON.stringify("标注样本\n")});await app.plugins.plugins[${JSON.stringify(legacy.id)}].store.addHighlight(file,{id:${JSON.stringify(id1)},color:'yellow',createdAt:new Date().toISOString(),anchor:{startOffset:0,endOffset:4,selectedText:'标注样本',sourceText:'标注样本',prefix:'',suffix:${JSON.stringify("\n")}}});return JSON.stringify(true)})()`,
  );
  const before = await annotations(vault);
  const migrated = await install({ vaultPath: vault.directory });
  assert(
    JSON.stringify(before) === JSON.stringify(await annotations(vault)),
    "身份迁移改变了旁注",
  );
  assert(
    (await readJSON(path.join(plugins, info.id, "data.json"))).defaultAuthor ===
      settings.defaultAuthor,
    "旧设置未迁移",
  );
  evalVault(
    vault,
    `(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(fixture)});await app.plugins.plugins[${JSON.stringify(info.id)}].store.addHighlight(file,{id:${JSON.stringify(id2)},color:'green',createdAt:new Date().toISOString(),anchor:{startOffset:0,endOffset:4,selectedText:'标注样本',sourceText:'标注样本',prefix:'',suffix:${JSON.stringify("\n")}}});return JSON.stringify(true)})()`,
  );
  const after = await annotations(vault);
  await rollback(migrated.backup);
  assert(
    JSON.stringify(after) === JSON.stringify(await annotations(vault)),
    "回退丢弃了迁移后新增的标注",
  );
  assert((await enabled(vault)).includes(legacy.id), "回退未重新启用旧插件");
  settings.defaultAuthor = "回退后修改的合成作者";
  await writeJSON(path.join(plugins, legacy.id, "data.json"), settings);
  await install({ vaultPath: vault.directory });
  assert(
    (await readJSON(path.join(plugins, info.id, "data.json"))).defaultAuthor ===
      settings.defaultAuthor,
    "再次迁移沿用了过期设置",
  );
  assert(
    JSON.stringify(after) === JSON.stringify(await annotations(vault)),
    "再次迁移改变了标注",
  );
  assert(head() === start, "演练期间提交发生变化");
  receipt = {
    status: "passed",
    commit: start,
    pluginId: info.id,
    version: info.version,
    artifacts: await artifacts(),
    checks: {
      migration: true,
      settings: true,
      rollbackPreservesNewAnnotations: true,
      reinstallUsesLatestSettings: true,
    },
    timestampUTC: new Date().toISOString(),
  };
  console.log(
    "通过：旧 ID 迁移、设置保留、回退保留新增标注、重新迁移使用最新设置",
  );
} catch (error) {
  fail(error);
} finally {
  if (vault && fixture) {
    const info = await manifest();
    evalVault(
      vault,
      `(async()=>{const p=app.plugins.plugins[${JSON.stringify(info.id)}]??app.plugins.plugins[${JSON.stringify(LEGACY_IDS[0])}];if(!p)return JSON.stringify(false);await p.store.enqueueWrite(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(fixture)}),sidecar=p.store.toSidecarPath(${JSON.stringify(fixture)});const recovery='.trash/installation-rehearsal';if(!(await app.vault.adapter.exists(recovery)))await app.vault.adapter.mkdir(recovery);if(await app.vault.adapter.exists(sidecar))await app.vault.adapter.rename(sidecar,recovery+'/'+sidecar.split('/').pop());delete p.store.index.files[${JSON.stringify(fixture)}];await p.store.writeIndex();if(file)await app.fileManager.trashFile(file);});return JSON.stringify(true)})()`,
    );
  }
  if (initial) {
    await rollback(initial.directory);
    for (const id of initial.before.ids) {
      const saved = path.join(initial.directory, "plugins", id, "data.json"),
        target = path.join(
          vault.directory,
          ".obsidian/plugins",
          id,
          "data.json",
        );
      if (initial.before.plugins[id].files["data.json"])
        await fs.copyFile(saved, target);
    }
  }
}
if (receipt && !process.exitCode) await writeJSON(receiptFile, receipt);
