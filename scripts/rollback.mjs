import { options, fail } from "./lib.mjs";
import { rollback } from "./local-install.mjs";
try {
  const args = options();
  if (!args.backup) throw Error("必须提供 --backup");
  console.log(JSON.stringify(await rollback(args.backup), null, 2));
} catch (error) {
  fail(error);
}
