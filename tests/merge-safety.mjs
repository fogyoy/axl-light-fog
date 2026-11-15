import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, REPOSITORY } from "../scripts/lib.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "fog-merge-"));
try {
  const cli = path.join(temporary, "gh"), log = path.join(temporary, "calls.jsonl");
  await fs.writeFile(cli, String.raw`#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(os.environ['FOG_CALLS'],'a') as f:f.write(json.dumps(args)+'\n')
if args[:2]==['api','user']:
 print(json.dumps({'login':'fogyoy','id':229448016}))
elif args[:2]==['pr','view']:
 print(json.dumps({'baseRefName':os.environ.get('FOG_BASE','main'),'headRefOid':'a'*40,'state':'OPEN'}))
elif args[:2]==['pr','checks']:
 print('verify pass')
elif args[:2]==['pr','merge']:
 if os.environ.get('FOG_REJECT_EMAIL'):
  print('GraphQL: Invalid email address (mergePullRequest)',file=sys.stderr);sys.exit(1)
 print('merged')
else:sys.exit(2)
`);
  await fs.chmod(cli, 0o755);
  async function attempt(extra = {}) {
    await fs.writeFile(log, "");
    const result = spawnSync(process.execPath, ["scripts/merge.mjs", "--pr", "2"], {
      cwd: ROOT, encoding: "utf8", env: {
        ...process.env, PATH: temporary + path.delimiter + process.env.PATH,
        FOG_CALLS: log, ...extra,
      },
    });
    const calls = (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls };
  }
  let result = await attempt();
  assert.equal(result.status, 0, result.stderr);
  const merge = result.calls.find(args => args[1] === "merge");
  for (const [option, value] of [
    ["--repo", REPOSITORY],
    ["--author-email", "229448016+fogyoy@users.noreply.github.com"],
    ["--match-head-commit", "a".repeat(40)],
  ]) assert.equal(merge[merge.indexOf(option) + 1], value);

  result = await attempt({ FOG_REJECT_EMAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /settings\/emails/);
  assert.equal(result.calls.filter(args => args[1] === "merge").length, 1,
    "匿名邮箱被拒绝后不能尝试默认邮箱");

  result = await attempt({ FOG_BASE: "other" });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.some(args => args[1] === "merge"), false);
  console.log("通过：维护 PR 锁定提交、显式匿名邮箱及拒绝时停止");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
