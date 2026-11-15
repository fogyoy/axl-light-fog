import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../scripts/lib.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "fog-cli-target-"));
try {
  let vault = path.join(temporary, "dedicated-vault");
  const bin = path.join(temporary, "bin");
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.mkdir(bin);
  vault = await fs.realpath(vault);
  const cli = path.join(bin, "obsidian");
  await fs.writeFile(
    cli,
    `#!/usr/bin/env python3
import os,sys,json
expected=os.environ['FOG_TEST_VAULT']
selected=expected if len(sys.argv)>2 and sys.argv[1]=='vault='+os.path.basename(expected) else os.path.dirname(expected)
print('=> '+json.dumps(selected))
`,
  );
  await fs.chmod(cli, 0o755);
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {vaultAt} from './scripts/lib.mjs';console.log(JSON.stringify(await vaultAt(${JSON.stringify(vault)})));`,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        FOG_TEST_VAULT: vault,
      },
    },
  );
  assert.equal(
    JSON.parse(output).directory,
    vault,
    "vault 参数必须位于命令前，不能退回活动库",
  );
  console.log("通过：CLI 显式选库参数顺序及实际路径核对");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
