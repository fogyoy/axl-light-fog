import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  FILES,
  manifest,
  exists,
  readJSON,
  writeJSON,
  validatePackage,
  fail,
} from "./lib.mjs";

try {
  const info = await manifest(),
    source = path.join(ROOT, "dist", info.version, info.id);
  await validatePackage(source);
  const directory = path.join(ROOT, ".local/axl-light-fog-test-vault"),
    marker = path.join(directory, ".axl-test-vault.json");
  if (await exists(directory)) {
    if (
      !(await exists(marker)) ||
      (await readJSON(marker)).purpose !== "axl-light-fog-e2e"
    )
      throw Error("已有目录不是受管理的测试库，未写入");
    console.log(
      "测试库已存在。程序升级请使用 install:local；测试库路径：" + directory,
    );
  } else {
    const plugins = path.join(directory, ".obsidian/plugins", info.id);
    await fs.mkdir(plugins, { recursive: true });
    for (const name of FILES)
      await fs.copyFile(path.join(source, name), path.join(plugins, name));
    await writeJSON(marker, { purpose: "axl-light-fog-e2e", schemaVersion: 1 });
    await writeJSON(path.join(directory, ".obsidian/app.json"), {
      safeMode: false,
    });
    await writeJSON(path.join(directory, ".obsidian/community-plugins.json"), [
      info.id,
    ]);
    await fs.writeFile(
      path.join(directory, "验收库说明.md"),
      "# Axl Light Fog 专用验收库\n\n这里只存放合成测试数据，请勿放入日常笔记。\n",
    );
    console.log(
      "已准备测试库，请在 Obsidian 中将此文件夹打开为笔记库：" + directory,
    );
  }
} catch (error) {
  fail(error);
}
