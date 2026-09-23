const main = async (): Promise<void> => {
  const next = Bun.spawn(["bun", "run", "dev"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const helper = Bun.spawn(["bun", "scripts/modeler-helper/server.ts"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let stopped = false;
  const stopChildren = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    next.kill();
    helper.kill();
  };

  process.on("SIGINT", stopChildren);
  process.on("SIGTERM", stopChildren);

  const exitCode = await Promise.race([next.exited, helper.exited]);
  stopChildren();
  process.exit(exitCode ?? 1);
};

void main();

export {};
