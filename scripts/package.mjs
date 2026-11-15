import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  FILES,
  manifest,
  readJSON,
  hash,
  run,
  writeJSON,
  fail,
} from "./lib.mjs";

try {
  const info = await manifest(),
    pkg = await readJSON(path.join(ROOT, "package.json"));
  const versions = await readJSON(path.join(ROOT, "versions.json"));
  if (
    info.id !== pkg.name ||
    info.version !== pkg.version ||
    versions[info.version] !== info.minAppVersion
  )
    throw Error("项目、插件与发布版本映射不一致");
  const output = path.join(ROOT, "dist", info.version),
    folder = path.join(output, info.id);
  await fs.mkdir(folder, { recursive: true });
  for (const name of FILES)
    await fs.copyFile(path.join(ROOT, name), path.join(folder, name));
  const zip = path.join(output, `${info.id}-${info.version}.zip`);
  run("python3", [
    "-c",
    `import pathlib,sys,zipfile
folder=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for file in sorted(folder.iterdir()):
  info=zipfile.ZipInfo(folder.name+'/'+file.name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
  archive.writestr(info,file.read_bytes())`,
    folder,
    zip,
  ]);
  const entries = [];
  for (const name of FILES)
    entries.push(
      `${hash(await fs.readFile(path.join(folder, name)))}  ${name}`,
    );
  entries.push(`${hash(await fs.readFile(zip))}  ${path.basename(zip)}`);
  await fs.writeFile(
    path.join(output, "SHA256SUMS"),
    entries.join("\n") + "\n",
  );
  console.log(`已生成 ${info.id} ${info.version} 安装包与校验值`);
} catch (error) {
  fail(error);
}
