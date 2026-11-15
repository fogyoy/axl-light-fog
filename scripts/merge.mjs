import { REPOSITORY, options, run, fail } from "./lib.mjs";

try {
  const args = options();
  if (!/^\d+$/.test(args.pr ?? "")) throw Error("必须提供 --pr <编号>");
  const user = JSON.parse(run("gh", ["api", "user", "--jq", "{login,id}"]));
  if (user.login !== REPOSITORY.split("/")[0])
    throw Error("当前登录账号不是此维护仓库的所有者");
  const email = `${user.id}+${user.login}@users.noreply.github.com`;
  run("gh", ["pr", "checks", args.pr, "--repo", REPOSITORY, "--required"]);
  console.log(
    run("gh", [
      "pr",
      "merge",
      args.pr,
      "--repo",
      REPOSITORY,
      "--squash",
      "--delete-branch",
      "--author-email",
      email,
    ]),
  );
} catch (error) {
  fail(error);
}
