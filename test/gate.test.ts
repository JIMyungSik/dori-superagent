import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("verdict lines survive indentation and markdown emphasis; the value must end the line", async () => {
    const { w, d } = setup();
    gh(w, []);
    const accepted = [
      ["plain", "no findings\nVERDICT: CLEAR", "CLEAR"],
      ["bold", "**VERDICT: CLEAR**", "CLEAR"],
      ["indented", "\tVERDICT: BLOCK", "BLOCK"],
      ["backticks", "`VERDICT: CLEAR`", "CLEAR"],
      ["spaced emphasis", "** VERDICT: CLEAR **", "CLEAR"],
      ["bold keyword", "**VERDICT**: CLEAR", "CLEAR"],
    ] as const;
    for (const [i, [name, stdout, want]] of accepted.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${20 + i}`;
      expect({ name, verdict: (await review(d, pr)).verdict }).toEqual({ name, verdict: want });
      expect(d.store.receipt(pr, head)?.verdict).toBe(want);
    }
  });

  test("list markers, trailing prose and prose mentions never decide", async () => {
    const { w, d } = setup();
    gh(w, []);
    const refused = [
      ["bullet", "- **VERDICT: BLOCK**"],
      ["ordered list", "1. VERDICT: CLEAR"],
      ["bold with trailing sentence", "**VERDICT: CLEAR** — no HIGH or MEDIUM findings"],
      ["em-dash prose behind a bullet", "Findings:\n- VERDICT: CLEAR — is required before merging\n- another note"],
      ["prose mention", "I cannot give a VERDICT: CLEAR without a diff."],
      ["word continues", "VERDICT: CLEARLY"],
      ["hyphen continues", "VERDICT: CLEAR-ISH"],
    ] as const;
    for (const [i, [name, stdout]] of refused.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${40 + i}`;
      const failure: unknown = await review(d, pr).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ name, error: failure instanceof Error ? failure.message : "" }).toEqual({
        name,
        error: expect.stringContaining("no VERDICT line"),
      });
      expect(d.store.receipt(pr, head)).toBeUndefined();
    }
  });

  test("plain lines keep last-match; a plain/decorated conflict and a nonzero exit never write a receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "Example:\nVERDICT: BLOCK\n\nVERDICT: CLEAR" });
    expect((await review(d, "o/r#50")).verdict).toBe("CLEAR");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 no test\nVERDICT: BLOCK\n\n**VERDICT: CLEAR**" });
    const conflict: unknown = await review(d, "o/r#51").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(conflict instanceof Error ? conflict.message : "").toContain("conflicting verdicts (BLOCK and CLEAR)");
    expect(d.store.receipt("o/r#51", head)).toBeUndefined();
    w.reviewer = () => ({ code: 9, stdout: "**VERDICT: CLEAR**" });
    const failure: unknown = await review(d, "o/r#52").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure instanceof Error ? failure.message : "").toContain("reviewer exited 9");
    expect(d.store.receipt("o/r#52", head)).toBeUndefined();
    const files = readdirSync(join(d.store.root, "receipts")).filter(
      (n) => n.endsWith(".noverdict.txt") && n.startsWith("o__r_52@"),
    );
    expect(files).toHaveLength(1);
    expect(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8")).toBe("**VERDICT: CLEAR**");
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });
});
