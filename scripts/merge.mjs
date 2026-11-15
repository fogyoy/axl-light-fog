import { REPOSITORY, options, run, fail } from "./lib.mjs";

try {
  const args = options();
  if (!/^\d+$/.test(args.pr ?? "")) throw Error("必须提供 --pr <编号>");
  const user = JSON.parse(run("gh", ["api", "user", "--jq", "{login,id}"]));
  if (user.login !== REPOSITORY.split("/")[0])
    throw Error("当前登录账号不是此维护仓库的所有者");
  const email = `${user.id}+${user.login}@users.noreply.github.com`;
  const pr = JSON.parse(run("gh", ["pr", "view", args.pr, "--repo", REPOSITORY,
    "--json", "baseRefName,headRefOid,state"]));
  if (pr.baseRefName !== "main" || pr.state !== "OPEN")
    throw Error("只能合并以 main 为目标的开放维护 PR");
  run("gh", ["pr", "checks", args.pr, "--repo", REPOSITORY, "--required"]);
  console.log(
    run("gh", [
      "pr",
      "merge",
      args.pr,
      "--repo",
      REPOSITORY,
      "--squash",
      "--match-head-commit",
      pr.headRefOid,
      "--delete-branch",
      "--author-email",
      email,
    ]),
  );
} catch (error) {
  if (String(error.stderr).includes("Invalid email address"))
    fail(Error("GitHub 拒绝匿名邮箱，未合并。请在 https://github.com/settings/emails 开启 Keep my email addresses private，再重试；不会改用账号默认邮箱。"));
  else fail(error);
}
