/**
 * bench/inspectClean2.ts — the live grounded judge rejected legal_clean_2 as defective. Print the
 * actual text so the claim can be adjudicated rather than assumed.
 */
import { allFixtures } from "./fixtures.js";

const f = allFixtures().find((x) => x.id === "legal_clean_2")!;
const text: string = f.raw.result.full_text;
console.log("INTAKE:", JSON.stringify(f.raw.intake, null, 2));
console.log("\n--------------- FULL TEXT ---------------\n");
console.log(text);
console.log("\n--------------- NUMBERS IN HEADINGS vs BODY ---------------");
for (const h of text.match(/^## .*/gm) ?? []) {
  const nums = h.match(/\d+/g);
  if (nums) console.log(`  heading "${h.replace(/^## /, "")}" -> numbers ${nums.join(", ")}`);
}
console.log(`  body "vest over N years" -> ${/vest over\s+(\d+)\s+years?/i.exec(text)?.[1] ?? "none"}`);
console.log(`  body "cliff of N months" -> ${/cliff of\s+(\d+)\s+months?/i.exec(text)?.[1] ?? "none"}`);
console.log(`  intake vesting_years=${f.raw.intake.equity?.vesting_years} cliff_months=${f.raw.intake.equity?.cliff_months}`);
console.log("\n--------------- PARTY NAMES ---------------");
for (const p of f.raw.intake.parties) {
  console.log(`  intake party "${p.name}" (${p.role}) present in text: ${text.includes(p.name)}`);
}
