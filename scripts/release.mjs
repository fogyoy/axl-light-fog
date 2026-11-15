import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  FILES,
  REPOSITORY,
  options,
  run,
  manifest,
  readJSON,
  artifacts,
  head,
  hash,
  exists,
  fail,
} from "./lib.mjs";

try {
  const args = options(),
    info = await manifest(),
    sha = head();
  if (!args.version || args.version !== info.version)
    throw Error("--version 必须与插件清单版本一致");
  if (run("git", ["status", "--porcelain"]))
    throw Error("工作区不干净，禁止发布");
  const evidence = await readJSON(
    path.join(ROOT, ".local/evidence/obsidian.json"),
  );
  if (
    evidence.status !== "passed" ||
    evidence.commit !== sha ||
    evidence.pluginId !== info.id ||
    evidence.version !== info.version
  )
    throw Error("缺少当前提交的实机验收凭证");
  if (JSON.stringify(evidence.artifacts) !== JSON.stringify(await artifacts()))
    throw Error("安装文件与实机验收时不同");
  const installation = await readJSON(
    path.join(ROOT, ".local/evidence/installation.json"),
  );
  if (
    installation.status !== "passed" ||
    installation.commit !== sha ||
    installation.pluginId !== info.id ||
    installation.version !== info.version ||
    JSON.stringify(installation.artifacts) !==
      JSON.stringify(evidence.artifacts)
  )
    throw Error("缺少当前提交的安装与回退演练凭证");
  run("git", ["fetch", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== sha)
    throw Error("只允许发布当前稳定 main 提交");
  const runs = JSON.parse(
    run("gh", [
      "run",
      "list",
      "--repo",
      REPOSITORY,
      "--workflow",
      "ci.yml",
      "--commit",
      sha,
      "--json",
      "status,conclusion,headSha,event",
      "--limit",
      "20",
    ]),
  );
  if (
    !runs.some(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        r.headSha === sha &&
        r.event === "push",
    )
  )
    throw Error("当前 main 提交尚未通过 GitHub CI");
  run(process.execPath, ["scripts/package.mjs"]);
  const folder = path.join(ROOT, "dist", info.version),
    payload = path.join(folder, info.id),
    tag = "v" + info.version;
  const names = [
    ...FILES,
    `${info.id}-${info.version}.zip`,
    "SHA256SUMS",
    "verification.json",
  ];
  await fs.copyFile(
    path.join(ROOT, ".local/evidence/obsidian.json"),
    path.join(folder, "verification.json"),
  );
  const files = Object.fromEntries(
    names.map((name) => [
      name,
      path.join(FILES.includes(name) ? payload : folder, name),
    ]),
  );
  let remote;
  try {
    remote = JSON.parse(
      run("gh", [
        "release",
        "view",
        tag,
        "--repo",
        REPOSITORY,
        "--json",
        "url,assets,isDraft",
      ]),
    );
  } catch (error) {
    if (
      !String(error.stderr).includes("release not found") &&
      !String(error.stderr).includes("Not Found")
    )
      throw error;
  }
  if (remote) {
    const target = run("gh", [
      "api",
      `repos/${REPOSITORY}/commits/${tag}`,
      "--jq",
      ".sha",
    ]);
    if (target !== sha) throw Error("同名版本指向不同提交，禁止覆盖");
    const download = path.join(ROOT, ".local/release-check", tag);
    await fs.mkdir(download, { recursive: true });
    for (const name of names) {
      if (remote.assets.some((asset) => asset.name === name)) {
        run("gh", [
          "release",
          "download",
          tag,
          "--repo",
          REPOSITORY,
          "--pattern",
          name,
          "--dir",
          download,
          "--clobber",
        ]);
        if (name === "verification.json") {
          const prior = await readJSON(path.join(download, name));
          if (
            prior.commit !== sha ||
            JSON.stringify(prior.artifacts) !==
              JSON.stringify(evidence.artifacts)
          )
            throw Error("已发布验收凭证不同，禁止覆盖");
        } else if (
          hash(await fs.readFile(path.join(download, name))) !==
          hash(await fs.readFile(files[name]))
        )
          throw Error("同名发布文件内容不同，禁止覆盖：" + name);
      } else
        run("gh", [
          "release",
          "upload",
          tag,
          files[name],
          "--repo",
          REPOSITORY,
        ]);
    }
    if (remote.isDraft)
      run("gh", [
        "release",
        "edit",
        tag,
        "--repo",
        REPOSITORY,
        "--draft=false",
      ]);
  } else {
    const notes = path.join(ROOT, ".local/release-notes.md");
    await fs.writeFile(
      notes,
      `Axl Light Fog ${info.version}\n\n基于 Axl Light 的中文维护版，保留 MIT 许可证与原作者署名。\n\n提交：${sha}\n\n此提交已通过自动回归和 macOS Obsidian 1.15.1 实机验收。提供 Markdown、PDF、表格、独立窗口与存储故障回归。其他平台尚未验证。\n\n下载 ZIP 解压后，将 ${info.id} 文件夹放入笔记库的插件目录。升级保留 data.json 与独立旁注目录。SHA256SUMS 提供校验值，verification.json 记录对应提交及安装文件。\n`,
    );
    run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      REPOSITORY,
      "--target",
      sha,
      "--title",
      `Axl Light Fog ${tag}`,
      "--notes-file",
      notes,
      ...Object.values(files),
    ]);
  }
  console.log(
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      REPOSITORY,
      "--json",
      "url",
      "--jq",
      ".url",
    ]),
  );
} catch (error) {
  fail(error);
}
