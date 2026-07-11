import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

test("generated applicability predicates support the approved DSL and reject code", async () => {
  let source = await readFile(
    new URL("../framework/onboarding/lib/runtime-helpers.template.ts", import.meta.url),
    "utf8"
  );
  source = source
    .replace('import { AXES } from "./matrix.js";', "const AXES = [];")
    .replace(
      'import { ALL_SCENARIOS } from "./scenarios.js";',
      `const ALL_SCENARIOS = [
        { id: "any", applicability: "any" },
        { id: "enum", applicability: "validationMode === HARD_ONLY" },
        { id: "compound", applicability: "(validationMode === HARD_ONLY || validationMode === SOFT_ONLY) && allowResubmission === true" },
        { id: "numeric", applicability: "threshold >= 3 && threshold < 10" },
        { id: "malicious", applicability: "globalThis.process.exit()" }
      ];`
    );

  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const encoded = Buffer.from(compiled).toString("base64");
  const runtime = await import(`data:text/javascript;base64,${encoded}`);

  assert.equal(runtime.isCellApplicable({}, "any"), true);
  assert.equal(runtime.isCellApplicable({ validationMode: 0 }, "enum"), true);
  assert.equal(runtime.isCellApplicable({ validationMode: 2 }, "enum"), false);
  assert.equal(runtime.isCellApplicable({ validationMode: 1, allowResubmission: true }, "compound"), true);
  assert.equal(runtime.isCellApplicable({ validationMode: 1, allowResubmission: false }, "compound"), false);
  assert.equal(runtime.isCellApplicable({ threshold: 5 }, "numeric"), true);
  assert.equal(runtime.isCellApplicable({ threshold: 12 }, "numeric"), false);
  assert.equal(runtime.isCellApplicable({}, "malicious"), false);
});
