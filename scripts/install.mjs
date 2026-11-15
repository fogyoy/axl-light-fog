import { options, fail } from "./lib.mjs";
import { install } from "./local-install.mjs";
try {
  const args = options();
  console.log(
    JSON.stringify(
      await install({ vaultPath: args["vault-path"], from: args.from }),
      null,
      2,
    ),
  );
} catch (error) {
  fail(error);
}
