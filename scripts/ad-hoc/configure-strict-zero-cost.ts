#!/usr/bin/env node

import { updateSettings } from "../../src/lib/db/settings.ts";

const action = process.argv[2]?.trim().toLowerCase();

if (action !== "enable" && action !== "disable" && action !== "status") {
  console.error(
    "Usage: npx tsx scripts/ad-hoc/configure-strict-zero-cost.ts <enable|disable|status>"
  );
  process.exit(2);
}

async function main(): Promise<void> {
  if (action === "status") {
    const { getSettings } = await import("../../src/lib/db/settings.ts");
    const settings = await getSettings();
    console.log(settings.freeAccessPolicy === "strict" ? "strict" : "off");
    return;
  }

  const freeAccessPolicy = action === "enable" ? "strict" : "off";
  await updateSettings({ freeAccessPolicy });
  console.log(`freeAccessPolicy=${freeAccessPolicy}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
