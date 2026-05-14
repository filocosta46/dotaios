import { addLicense, licenseFile, listLicenses, removeLicense } from "../../../core/src/licenses.mjs";
import { hasHelpFlag } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios license <subcommand>

Subcommands:
  add <product-id> <key>   Verify and store a license key for a paid skill or plugin.
  list                     Show every license stored on this machine.
  remove <product-id>      Remove a previously added license.

License keys come from the vendor's checkout (Gumroad, Lemonsqueezy, etc).
Verification happens once when you add the key. After that, every install
runs offline against ~/.dotaios/licenses.json.

The license file holds credentials. Keep it private. Do not paste it into chat.
`;

export async function licenseCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.log(HELP_TEXT);
    return;
  }

  if (subcommand === "add") {
    const [productId, key, ...extra] = rest;
    if (!productId || !key || extra.length > 0) {
      throw new Error("Usage: dotaios license add <product-id> <key>");
    }
    console.log(`Verifying license for ${productId}...`);
    const entry = await addLicense({ productId, key });
    console.log(`[ok] License saved to ${licenseFile()}.`);
    console.log(`     product_id: ${entry.product_id}`);
    if (entry.uses != null) console.log(`     uses: ${entry.uses}`);
    return;
  }

  if (subcommand === "list") {
    const entries = await listLicenses();
    if (entries.length === 0) {
      console.log("No licenses stored. Add one with `dotaios license add <product> <key>`.");
      return;
    }
    console.log("Stored licenses:");
    for (const entry of entries) {
      const vendor = entry.vendor ? `${entry.vendor}/` : "";
      const uses = entry.uses != null ? ` uses=${entry.uses}` : "";
      console.log(`  - ${vendor}${entry.product_id}  verified=${entry.verified_at}${uses}`);
    }
    return;
  }

  if (subcommand === "remove" || subcommand === "rm") {
    const [productId, ...extra] = rest;
    if (!productId || extra.length > 0) {
      throw new Error("Usage: dotaios license remove <product-id>");
    }
    const removed = await removeLicense(productId);
    if (!removed) {
      throw new Error(`No license stored for ${productId}.`);
    }
    console.log(`Removed license for ${productId}.`);
    return;
  }

  throw new Error(`Unknown license subcommand: ${subcommand}. Try \`dotaios license --help\`.`);
}
